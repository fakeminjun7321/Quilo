"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const JSZip = require("jszip");
const sharp = require("sharp");
const {
  createOcrExport,
  markdownToBlocks,
  markdownToPlain,
  parseHtmlTableToForm,
  verifyOcrExport,
} = require("../lib/document-tools/ocr-export");

async function scanImage() {
  return sharp({ create: { width: 900, height: 1200, channels: 3, background: "white" } })
    .composite([{
      input: Buffer.from('<svg width="900" height="1200"><text x="65" y="150" font-size="58">Quilo 스캔 123</text><rect x="100" y="700" width="320" height="220" fill="#d7e7ff" stroke="#2563eb" stroke-width="8"/><text x="145" y="820" font-size="42">원본 그림</text></svg>'),
    }])
    .png()
    .toBuffer();
}

function ocrResult() {
  return {
    text: "# 스캔 제목\n\n본문 **강조**와 수식 $x^2$입니다.\n\n| 항목 | 값 |\n| --- | --- |\n| 질량 | 12 g |\n\n- 첫째\n- 둘째\n\n<script>alert('unsafe')</script>",
    confidence: { average: 0.98, minimum: 0.91 },
    quality: { agreement: 0.96 },
    pages: [{
      page: 1,
      dimensions: { width: 900, height: 1200 },
      images: [{ id: "figure-1", topLeftX: 100, topLeftY: 700, bottomRightX: 420, bottomRightY: 920, annotation: "파란 원본 그림" }],
    }],
  };
}

function csatResult() {
  const text = "# 8. 다음 함수의 연속인 점을 고르시오.\n\n<보기>\nㄱ. x=0에서 연속이다.\nㄴ. 모든 유리수에서 연속이다.\nㄷ. 모든 실수에서 연속이다.\n\n자료 표: 구분, A, B";
  return {
    text,
    sourceText: text,
    confidence: { average: 0.99, minimum: 0.95 },
    quality: { agreement: 0.98, verifiedConfidence: 0.985 },
    pages: [{
      page: 1,
      markdown: text,
      dimensions: { width: 900, height: 1200 },
      images: [{ id: "figure-1", topLeftX: 100, topLeftY: 700, bottomRightX: 420, bottomRightY: 920, annotation: "함수 그래프" }],
      tables: [{
        id: "table-1",
        format: "html",
        content: '<table><tr><th colspan="3">자료</th></tr><tr><td rowspan="2">구분</td><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>',
      }],
      blocks: [
        { type: "title", content: "8. 다음 함수의 연속인 점을 고르시오.", topLeftX: 50, topLeftY: 80, bottomRightX: 430, bottomRightY: 145, order: 0 },
        { type: "aside_text", content: "<보기>\nㄱ. x=0에서 연속이다.\nㄴ. 모든 유리수에서 연속이다.\nㄷ. 모든 실수에서 연속이다.", topLeftX: 50, topLeftY: 165, bottomRightX: 430, bottomRightY: 395, order: 1 },
        { type: "equation", content: "\\frac{x^2}{2}", topLeftX: 50, topLeftY: 420, bottomRightX: 430, bottomRightY: 480, order: 2 },
        { type: "table", tableId: "table-1", content: "", topLeftX: 500, topLeftY: 80, bottomRightX: 850, bottomRightY: 350, order: 3 },
        { type: "image", imageId: "figure-1", content: "함수 그래프", topLeftX: 500, topLeftY: 380, bottomRightX: 850, bottomRightY: 650, order: 4 },
      ],
    }],
  };
}

test("OCR markdown is converted into editable paragraphs, lists, tables, and clean text", () => {
  const blocks = markdownToBlocks(ocrResult().text);
  assert.ok(blocks.some((block) => block?.subheading === "스캔 제목"));
  assert.ok(blocks.some((block) => block?.table?.headers?.[0] === "항목"));
  assert.ok(blocks.some((block) => block?.list?.length === 2));
  const plain = markdownToPlain(ocrResult().text);
  assert.match(plain, /스캔 제목/);
  assert.doesNotMatch(plain, /^#/m);
  assert.doesNotMatch(plain, /<script>/);
  const htmlTable = markdownToBlocks("<table><tr><th>이름</th><th>값</th></tr><tr><td>길이</td><td>12 cm</td></tr></table>");
  assert.equal(htmlTable[0].table.headers[0], "이름");
  assert.equal(htmlTable[0].table.rows[0][1], "12 cm");
  const merged = parseHtmlTableToForm(csatResult().pages[0].tables[0].content);
  assert.equal(merged.rows[0][0].colspan, 3);
  assert.equal(merged.rows[1][0].rowspan, 2);
});

test("TXT and self-contained HTML exports preserve text safely without embedding the full-page scan", async () => {
  const image = await scanImage();
  const file = { buffer: image, originalname: "수학 스캔.png", mimetype: "image/png" };
  const txt = await createOcrExport(file, ocrResult(), "txt");
  assert.equal(txt.sourceImageEmbedded, false);
  assert.match(txt.buffer.toString("utf8"), /스캔 제목/);
  assert.doesNotMatch(txt.buffer.toString("utf8"), /<script>/);

  const html = await createOcrExport(file, ocrResult(), "html");
  const source = html.buffer.toString("utf8");
  assert.equal(html.sourceImageEmbedded, false);
  assert.equal(html.detectedImagesEmbedded, 1);
  assert.match(source, /data:image\/png;base64,/);
  assert.match(source, /contenteditable="true"/);
  assert.match(source, /class="ocr-page"/);
  assert.doesNotMatch(source, /class="scan"|원본 스캔/);
  assert.match(source, /alert\(&#39;unsafe&#39;\)/);
  assert.doesNotMatch(source, /<script>alert/);
  assert.equal(html.verification.passed, true);

  const csatHtml = await createOcrExport(file, csatResult(), "html");
  const csatSource = csatHtml.buffer.toString("utf8");
  assert.match(csatSource, /exam-view/);
  assert.match(csatSource, /rowspan="2"/);
  assert.match(csatSource, /colspan="3"/);
  assert.match(csatSource, /data-columns="2"/);
  assert.match(csatSource, /<mfrac>/);
});

test("DOCX export contains editable CSAT view, merged table, and actual image media", async () => {
  const image = await scanImage();
  const exported = await createOcrExport({ buffer: image, originalname: "scan.png", mimetype: "image/png" }, csatResult(), "docx");
  const zip = await JSZip.loadAsync(exported.buffer);
  const documentXml = await zip.file("word/document.xml").async("string");
  const media = Object.keys(zip.files).filter((name) => /^word\/media\//.test(name));
  assert.match(documentXml, /다음 함수의 연속인 점/);
  assert.match(documentXml, /보기/);
  assert.match(documentXml, /w:gridSpan/);
  assert.match(documentXml, /w:vMerge/);
  assert.match(documentXml, /m:oMath/);
  assert.match(documentXml, /m:f>/);
  assert.ok(media.length >= 1, `expected the detected figure crop, got ${media.length}`);
  assert.equal(exported.sourceImageEmbedded, false);
  assert.equal(exported.detectedImagesEmbedded, 1);
  assert.equal(exported.verification.passed, true);
  assert.ok(exported.layoutBlocks >= 4);
});

test("manual text corrections keep detected figure crops without restoring the full-page scan", async () => {
  const image = await scanImage();
  const result = ocrResult();
  result.sourceText = result.text;
  result.text = "# 사용자가 교정한 제목\n\n교정한 본문 456";
  const exported = await createOcrExport({ buffer: image, originalname: "edited.png", mimetype: "image/png" }, result, "docx");
  const zip = await JSZip.loadAsync(exported.buffer);
  const documentXml = await zip.file("word/document.xml").async("string");
  const media = Object.keys(zip.files).filter((name) => /^word\/media\//.test(name));
  assert.match(documentXml, /사용자가 교정한 제목/);
  assert.ok(media.length >= 1);
  assert.equal(exported.sourceImageEmbedded, false);
  assert.equal(exported.detectedImagesEmbedded, 1);
});

test("HWPX export contains CSAT view, merged table, preview text, and embedded image binaries", { timeout: 30_000 }, async () => {
  const image = await scanImage();
  const exported = await createOcrExport({ buffer: image, originalname: "scan.png", mimetype: "image/png" }, csatResult(), "hwpx");
  const zip = await JSZip.loadAsync(exported.buffer);
  const preview = await zip.file("Preview/PrvText.txt").async("string");
  const sectionNames = Object.keys(zip.files).filter((name) => /^Contents\/section\d+\.xml$/.test(name));
  const sections = (await Promise.all(sectionNames.map((name) => zip.file(name).async("string")))).join("\n");
  const binaries = Object.keys(zip.files).filter((name) => /^BinData\//.test(name) && !zip.files[name].dir);
  assert.match(preview, /다음 함수의 연속인 점/);
  assert.match(preview, /<보기>/);
  assert.match(sections, /colSpan="3"/);
  assert.match(sections, /rowSpan="2"/);
  assert.match(sections, />구분</);
  assert.doesNotMatch(sections, /\{\{EQ/);
  assert.match(sections, /<hp:equation\b/);
  assert.equal(binaries.length, 1, `expected only the detected figure crop, got ${binaries.length}`);
  assert.equal(exported.sourceImageEmbedded, false);
  assert.equal(exported.verification.passed, true);
});

test("postflight rejects corrupted document bytes instead of returning a ghost export", async () => {
  await assert.rejects(
    verifyOcrExport(Buffer.from("not-a-zip"), "docx", csatResult(), { expectedImages: 2, hasMergedTable: true }),
    /ZIP 구조가 손상/,
  );
});
