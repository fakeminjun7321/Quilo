const zlib = require("zlib");

class ZipSafetyError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = "ZipSafetyError";
    this.code = "ZIP_SAFETY_ERROR";
    this.reason = reason;
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function fail(reason, message) {
  throw new ZipSafetyError(reason, message);
}

// ZIP 중앙 디렉터리를 직접 읽어 JSZip/SheetJS가 항목 객체를 만들기 전에
// 항목 수, 선언 해제 크기, 압축률과 local-header 경계를 검증한다. ZIP64와
// 암호화 ZIP은 이 업로드 경로에서 필요하지 않으므로 명시적으로 거부한다.
function inspectZipArchive(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    fail("invalid_structure", "ZIP 파일 구조가 올바르지 않습니다.");
  }

  const maxEntries = Math.floor(positiveNumber(options.maxEntries, 1000));
  const maxEntryBytes = positiveNumber(
    options.maxEntryUncompressedBytes,
    64 * 1024 * 1024,
  );
  const maxTotalBytes = positiveNumber(
    options.maxTotalUncompressedBytes,
    256 * 1024 * 1024,
  );
  const maxRatio = positiveNumber(options.maxCompressionRatio, 200);
  const ratioMinBytes = positiveNumber(options.ratioMinOutputBytes, 1024 * 1024);

  const searchStart = Math.max(0, buffer.length - 0xffff - 22);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset--) {
    if (
      buffer.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("missing_directory", "ZIP 중앙 디렉터리를 찾지 못했습니다.");

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const directoryDisk = buffer.readUInt16LE(eocd + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const commentLength = buffer.readUInt16LE(eocd + 20);

  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  ) {
    fail("unsupported_zip", "분할 ZIP/ZIP64 파일은 지원하지 않습니다.");
  }
  if (entryCount > maxEntries) {
    fail("too_many_entries", "ZIP 내부 항목 수가 안전 한도를 초과했습니다.");
  }
  if (
    directoryOffset + directorySize > eocd ||
    eocd + 22 + commentLength > buffer.length
  ) {
    fail("invalid_structure", "ZIP 중앙 디렉터리 범위가 손상되었습니다.");
  }

  const entries = [];
  const names = new Set();
  let totalDeclaredBytes = 0;
  let offset = directoryOffset;
  const directoryEnd = directoryOffset + directorySize;

  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > directoryEnd || buffer.readUInt32LE(offset) !== 0x02014b50) {
      fail("invalid_structure", "ZIP 항목 구조가 손상되었습니다.");
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const entryCommentLength = buffer.readUInt16LE(offset + 32);
    const startDisk = buffer.readUInt16LE(offset + 34);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    const nextOffset = nameEnd + extraLength + entryCommentLength;

    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      fail("unsupported_zip", "ZIP64 항목은 지원하지 않습니다.");
    }
    if (startDisk !== 0 || nextOffset > directoryEnd) {
      fail("invalid_structure", "ZIP 항목 범위가 손상되었습니다.");
    }
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0) {
      fail("unsupported_zip", "암호화된 ZIP 항목은 지원하지 않습니다.");
    }
    if (method !== 0 && method !== 8) {
      fail("unsupported_zip", `지원하지 않는 ZIP 압축 방식입니다(${method}).`);
    }

    const name = buffer.toString("utf8", nameStart, nameEnd);
    if (!name || name.includes("\0") || names.has(name)) {
      fail("invalid_structure", "ZIP 항목명이 비어 있거나 중복되었습니다.");
    }
    names.add(name);

    if (localHeaderOffset + 30 > directoryOffset) {
      fail("invalid_structure", "ZIP 로컬 항목 위치가 손상되었습니다.");
    }
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      fail("invalid_structure", "ZIP 로컬 항목 헤더가 손상되었습니다.");
    }
    const localFlags = buffer.readUInt16LE(localHeaderOffset + 6);
    const localMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameLength;
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (
      localNameEnd > directoryOffset ||
      buffer.toString("utf8", localNameStart, localNameEnd) !== name ||
      localMethod !== method ||
      (localFlags & 0x0001) !== (flags & 0x0001) ||
      dataOffset + compressedSize > directoryOffset
    ) {
      fail("invalid_structure", "ZIP 압축 데이터 범위가 손상되었습니다.");
    }

    totalDeclaredBytes += uncompressedSize;
    if (
      uncompressedSize > maxEntryBytes ||
      totalDeclaredBytes > maxTotalBytes
    ) {
      fail("size_limit", "ZIP 압축 해제 크기가 안전 한도를 초과했습니다.");
    }
    if (
      uncompressedSize >= ratioMinBytes &&
      (compressedSize === 0 || uncompressedSize / compressedSize > maxRatio)
    ) {
      fail("compression_ratio", "ZIP 압축률이 비정상적으로 높습니다.");
    }

    entries.push({
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      dataOffset,
    });
    offset = nextOffset;
  }

  if (offset > directoryEnd) {
    fail("invalid_structure", "ZIP 중앙 디렉터리가 손상되었습니다.");
  }

  return { entries, totalDeclaredBytes };
}

// 중앙 디렉터리의 선언값과 별개로 실제 deflate 출력을 제한된 버퍼로 풀어
// 바이트 수와 압축률을 검증한다. 반환값은 길이뿐이라 검사한 데이터를 보관하지 않는다.
function inspectActualEntryBytes(buffer, entry, options = {}) {
  const maxEntryBytes = positiveNumber(
    options.maxEntryUncompressedBytes,
    64 * 1024 * 1024,
  );
  const maxRatio = positiveNumber(options.maxCompressionRatio, 200);
  const ratioMinBytes = positiveNumber(options.ratioMinOutputBytes, 1024 * 1024);
  const compressed = buffer.subarray(
    entry.dataOffset,
    entry.dataOffset + entry.compressedSize,
  );

  let actual;
  try {
    actual = entry.method === 0
      ? compressed
      : zlib.inflateRawSync(compressed, { maxOutputLength: maxEntryBytes + 1 });
  } catch (error) {
    if (
      error &&
      (error.code === "ERR_BUFFER_TOO_LARGE" || /larger than|maxOutputLength/i.test(error.message || ""))
    ) {
      fail("size_limit", "ZIP 항목의 실제 압축 해제 크기가 안전 한도를 초과했습니다.");
    }
    fail("invalid_structure", `ZIP 항목 압축 해제에 실패했습니다: ${error.message}`);
  }

  const actualBytes = actual.length;
  if (actualBytes > maxEntryBytes) {
    fail("size_limit", "ZIP 항목의 실제 압축 해제 크기가 안전 한도를 초과했습니다.");
  }
  if (
    actualBytes >= ratioMinBytes &&
    (entry.compressedSize === 0 || actualBytes / entry.compressedSize > maxRatio)
  ) {
    fail("compression_ratio", "ZIP 항목의 실제 압축률이 비정상적으로 높습니다.");
  }
  if (actualBytes !== entry.uncompressedSize) {
    fail("size_mismatch", "ZIP 항목의 선언 크기와 실제 압축 해제 크기가 다릅니다.");
  }
  return actualBytes;
}

module.exports = {
  ZipSafetyError,
  inspectZipArchive,
  inspectActualEntryBytes,
};
