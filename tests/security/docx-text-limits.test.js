"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");

const MODULE_PATH = require.resolve("../../lib/docx-text");
const LIMIT_ENV_NAMES = [
  "DOCX_TEXT_MAX_COMPRESSED_BYTES",
  "DOCX_TEXT_MAX_ENTRIES",
  "DOCX_TEXT_MAX_DOCUMENT_XML_BYTES",
  "DOCX_TEXT_MAX_COMPRESSION_RATIO",
  "DOCX_TEXT_RATIO_MIN_OUTPUT_BYTES",
];

function loadExtractor(overrides = {}) {
  const previous = Object.fromEntries(
    LIMIT_ENV_NAMES.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of LIMIT_ENV_NAMES) delete process.env[name];
    for (const [name, value] of Object.entries(overrides)) {
      process.env[name] = String(value);
    }
    delete require.cache[MODULE_PATH];
    return require(MODULE_PATH).extractDocxText;
  } finally {
    for (const name of LIMIT_ENV_NAMES) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

async function makeDocx(documentXml, extraEntries = 0) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", documentXml);
  for (let i = 0; i < extraEntries; i += 1) {
    zip.file(`word/media/empty-${i}.txt`, "x");
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

// ZIP 선언 크기를 실제보다 작게 바꿔 헤더 기반 사전검사를 통과시킨다. 회귀 테스트는
// 이 상태에서도 스트리밍 중 실제 출력 바이트/압축률 제한이 동작하는지 확인한다.
function forgeDeclaredSize(buffer, entryName, declaredSize = 1) {
  const patched = Buffer.from(buffer);
  for (let off = 0; off + 46 <= patched.length; off += 1) {
    if (patched.readUInt32LE(off) !== 0x02014b50) continue;
    const nameLen = patched.readUInt16LE(off + 28);
    const extraLen = patched.readUInt16LE(off + 30);
    const commentLen = patched.readUInt16LE(off + 32);
    const name = patched.toString("utf8", off + 46, off + 46 + nameLen);
    if (name === entryName) {
      patched.writeUInt32LE(declaredSize, off + 24);
      const localOffset = patched.readUInt32LE(off + 42);
      if (patched.readUInt32LE(localOffset) === 0x04034b50) {
        patched.writeUInt32LE(declaredSize, localOffset + 22);
      }
      return patched;
    }
    off += 45 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ZIP entry not found: ${entryName}`);
}

test("extractDocxText preserves a normal bounded DOCX", async () => {
  const extractDocxText = loadExtractor();
  const buffer = await makeDocx(
    '<w:document><w:body><w:p><w:r><w:t>Hello &amp; 안전</w:t></w:r></w:p></w:body></w:document>',
  );
  assert.equal(await extractDocxText(buffer), "Hello & 안전");
});

test("extractDocxText rejects actual document.xml bytes before string conversion", async () => {
  const extractDocxText = loadExtractor({
    DOCX_TEXT_MAX_DOCUMENT_XML_BYTES: 1024,
    DOCX_TEXT_MAX_COMPRESSION_RATIO: 1_000_000,
    DOCX_TEXT_RATIO_MIN_OUTPUT_BYTES: 1,
  });
  const repeated = "<w:p><w:r><w:t>bounded</w:t></w:r></w:p>".repeat(200);
  const original = await makeDocx(`<w:document><w:body>${repeated}</w:body></w:document>`);
  const buffer = forgeDeclaredSize(original, "word/document.xml");

  await assert.rejects(
    extractDocxText(buffer),
    (error) =>
      error?.code === "DOCX_LIMIT_EXCEEDED" && /본문 XML 크기/.test(error.message),
  );
  assert.ok(buffer.length < 4096, "synthetic compressed fixture should stay small");
});

test("extractDocxText rejects excessive archive entry counts", async () => {
  const extractDocxText = loadExtractor({ DOCX_TEXT_MAX_ENTRIES: 3 });
  const buffer = await makeDocx(
    "<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>",
    5,
  );
  await assert.rejects(
    extractDocxText(buffer),
    (error) =>
      error?.code === "DOCX_LIMIT_EXCEEDED" && /ZIP 항목 수/.test(error.message),
  );
});

test("extractDocxText rejects an excessive actual compression ratio", async () => {
  const extractDocxText = loadExtractor({
    DOCX_TEXT_MAX_DOCUMENT_XML_BYTES: 1024 * 1024,
    DOCX_TEXT_MAX_COMPRESSION_RATIO: 2,
    DOCX_TEXT_RATIO_MIN_OUTPUT_BYTES: 1,
  });
  const repeated = "<w:p><w:r><w:t>same</w:t></w:r></w:p>".repeat(400);
  const original = await makeDocx(`<w:document><w:body>${repeated}</w:body></w:document>`);
  const buffer = forgeDeclaredSize(original, "word/document.xml");

  await assert.rejects(
    extractDocxText(buffer),
    (error) =>
      error?.code === "DOCX_LIMIT_EXCEEDED" && /비정상 압축률/.test(error.message),
  );
  assert.ok(buffer.length < 4096, "synthetic compressed fixture should stay small");
});
