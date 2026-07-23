// DOCX(Word) 본문 텍스트 추출기.
//
// 사전보고서를 PDF 대신 .docx로 올린 경우 Claude에 본문을 text 블록으로 전달하기
// 위해 사용한다. mammoth 같은 신규 의존성 없이, 저장소가 이미 쓰는 jszip으로
// ZIP을 열어 word/document.xml의 <w:t> 텍스트 노드를 순서대로 이어 붙인다.
//
// 규칙:
// - 문단(<w:p>) 경계는 개행으로 구분한다. 표 셀 안의 문단도 한 줄씩 나온다.
// - <w:tab/>은 탭으로, <w:br/>·<w:cr/>은 문단 내 개행으로 바꾼다.
// - <w:pPr>/<w:rPr> 속성 블록 안의 탭 스타일 정의(<w:tab w:val=.../>)는 무시한다.
// - 변경 추적으로 삭제된 텍스트(<w:delText>)는 포함하지 않는다.

const JSZip = require("jszip");

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const DOCX_LIMITS = Object.freeze({
  maxCompressedBytes: positiveLimit(
    process.env.DOCX_TEXT_MAX_COMPRESSED_BYTES,
    64 * 1024 * 1024,
  ),
  maxEntries: Math.floor(
    positiveLimit(process.env.DOCX_TEXT_MAX_ENTRIES, 2000),
  ),
  maxDocumentXmlBytes: positiveLimit(
    process.env.DOCX_TEXT_MAX_DOCUMENT_XML_BYTES,
    32 * 1024 * 1024,
  ),
  maxCompressionRatio: positiveLimit(
    process.env.DOCX_TEXT_MAX_COMPRESSION_RATIO,
    200,
  ),
  ratioMinOutputBytes: positiveLimit(
    process.env.DOCX_TEXT_RATIO_MIN_OUTPUT_BYTES,
    1024 * 1024,
  ),
});

class DocxLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocxLimitError";
    this.code = "DOCX_LIMIT_EXCEEDED";
  }
}

function positiveLimit(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function docxLimitError(detail) {
  return new DocxLimitError(
    `docx 파일이 안전 처리 한도를 초과했습니다(${detail}). 파일을 줄여 다시 업로드하세요.`,
  );
}

// JSZip의 uncompressedSize는 ZIP 헤더 선언값이므로 거절용 사전검사에만 쓰고,
// 실제 방어선은 nodeStream에서 나온 바이트를 직접 세어 문자열 생성 전에 강제한다.
function readEntryGuarded(file, limits) {
  const compressedSize = Number(file?._data?.compressedSize);
  const declaredSize = Number(file?._data?.uncompressedSize);
  if (
    Number.isFinite(declaredSize) &&
    declaredSize > limits.maxDocumentXmlBytes
  ) {
    return Promise.reject(docxLimitError("본문 XML 크기"));
  }
  if (
    Number.isFinite(declaredSize) &&
    Number.isFinite(compressedSize) &&
    compressedSize > 0 &&
    declaredSize >= limits.ratioMinOutputBytes &&
    declaredSize / compressedSize > limits.maxCompressionRatio
  ) {
    return Promise.reject(docxLimitError("비정상 압축률"));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let stream;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      try {
        stream?.destroy();
      } catch {
        /* ignore */
      }
      reject(error);
    };

    try {
      stream = file.nodeStream("nodebuffer");
    } catch (error) {
      reject(error);
      return;
    }
    stream.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limits.maxDocumentXmlBytes) {
        fail(docxLimitError("본문 XML 크기"));
        return;
      }
      if (
        Number.isFinite(compressedSize) &&
        compressedSize > 0 &&
        total >= limits.ratioMinOutputBytes &&
        total / compressedSize > limits.maxCompressionRatio
      ) {
        fail(docxLimitError("비정상 압축률"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, total));
    });
    stream.resume();
  });
}

function decodeXmlEntities(s) {
  return String(s).replace(
    /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g,
    (match, hex, dec, named) => {
      if (named) return NAMED_ENTITIES[named];
      const code = parseInt(hex != null ? hex : dec, hex != null ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    },
  );
}

// 문단 XML 하나에서 텍스트·탭·줄바꿈 토큰을 순서대로 이어 붙인다.
function extractParagraphText(paraXml) {
  // 스타일 정의(<w:pPr>, <w:rPr>) 안의 <w:tab .../>을 본문 탭으로 오인하지 않게 먼저 제거.
  const body = String(paraXml)
    .replace(/<w:pPr\b[^>]*\/>/g, "")
    .replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/g, "")
    .replace(/<w:rPr\b[^>]*\/>/g, "")
    .replace(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/g, "");
  let text = "";
  // <w:t ...>내용</w:t> | <w:tab/> | <w:br/>·<w:cr/> 순서 보존 스캔.
  // <w:t 뒤에 공백/'>'만 허용하므로 <w:delText>(삭제된 변경 추적 텍스트)는 매칭되지 않는다.
  const tokenRe =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;
  let m;
  while ((m = tokenRe.exec(body)) !== null) {
    if (m[1] !== undefined) text += decodeXmlEntities(m[1]);
    else if (m[0].startsWith("<w:tab")) text += "\t";
    else text += "\n";
  }
  return text;
}

/**
 * docx Buffer에서 본문 텍스트를 추출한다.
 * 열기 실패·document.xml 부재 시 throw. 호출부가 catch해서 graceful fallback 한다.
 *
 * @param {Buffer} buffer  .docx 파일 버퍼
 * @returns {Promise<string>}  문단 경계가 개행으로 구분된 본문 텍스트 (양끝 trim)
 */
async function extractDocxText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > DOCX_LIMITS.maxCompressedBytes) {
    throw docxLimitError("압축 파일 크기");
  }
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (e) {
    throw new Error(`docx 파일을 열 수 없습니다: ${e.message}`);
  }
  const entryNames = Object.keys(zip.files);
  if (entryNames.length > DOCX_LIMITS.maxEntries) {
    throw docxLimitError("ZIP 항목 수");
  }
  // 본문 파트는 표준적으로 word/document.xml. 변형된 이름이면 word/ 아래 document*.xml을 찾는다.
  const docFile =
    zip.file("word/document.xml") || zip.file(/^word\/document[^/]*\.xml$/i)[0];
  if (!docFile) {
    throw new Error("word/document.xml이 없습니다. 올바른 .docx 파일인지 확인하세요.");
  }
  const xmlBuffer = await readEntryGuarded(docFile, DOCX_LIMITS);
  const xml = xmlBuffer.toString("utf8");

  const paragraphs = [];
  // 자기닫힘 <w:p/>(빈 문단)를 먼저 매칭해야 뒤따르는 문단 내용을 삼키지 않는다.
  const paraRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    paragraphs.push(m[1] !== undefined ? extractParagraphText(m[1]) : "");
  }
  // 문단 구조를 못 찾는 비정형 XML이면 <w:t>만이라도 이어 붙인다.
  if (paragraphs.length === 0) {
    const flat = extractParagraphText(xml);
    if (flat.trim()) paragraphs.push(flat);
  }

  return paragraphs
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // 빈 문단 연속은 한 줄 공백으로 정리
    .trim();
}

module.exports = { extractDocxText };
