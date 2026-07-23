"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const JSZip = require("jszip");
const XLSX = require("xlsx");
const { createFilePreview } = require("../lib/file-preview");

test("DOCX preview renders headings, text, and tables as escaped HTML", async () => {
  const zip = new JSZip();
  zip.file("word/document.xml", `<?xml version="1.0"?>
    <w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>물리 결과보고서</w:t></w:r></w:p>
      <w:p><w:r><w:t>&lt;검증된 본문&gt;</w:t></w:r></w:p>
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>시간</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>속도</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    </w:body></w:document>`);
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await createFilePreview(buffer, { filename: "결과.docx" });
  const html = preview.body.toString("utf8");
  assert.equal(preview.kind, "html");
  assert.match(html, /물리 결과보고서/);
  assert.match(html, /&lt;검증된 본문&gt;/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(html, /<검증된 본문>/);
});

test("HWPX preview uses the package preview text", async () => {
  const zip = new JSZip();
  zip.file("Preview/PrvText.txt", "1. 실험 결과\n측정값과 분석\n2. 결론");
  zip.file("Contents/section0.xml", "<hp:section xmlns:hp=\"urn:test\"/>");
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const preview = await createFilePreview(buffer, { filename: "결과.hwpx" });
  const html = preview.body.toString("utf8");
  assert.match(html, /1\. 실험 결과/);
  assert.match(html, /측정값과 분석/);
});

test("ZIP, spreadsheet, and native PDF previews cover generated formats", async () => {
  const zip = new JSZip();
  zip.file("보고서/첫번째.hwpx", Buffer.from("x"));
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const zipPreview = await createFilePreview(archive, { filename: "독서록.zip" });
  assert.match(zipPreview.body.toString("utf8"), /첫번째\.hwpx/);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["x", "y"], [1, 2]]), "데이터");
  const xlsx = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const sheetPreview = await createFilePreview(xlsx, { filename: "data.xlsx" });
  assert.match(sheetPreview.body.toString("utf8"), /데이터/);
  assert.match(sheetPreview.body.toString("utf8"), /<td>2<\/td>/);

  const pdf = Buffer.from("%PDF-1.7\n%%EOF");
  const pdfPreview = await createFilePreview(pdf, { filename: "번역.pdf", mimeType: "application/pdf" });
  assert.equal(pdfPreview.kind, "inline");
  assert.equal(pdfPreview.contentType, "application/pdf");
  assert.equal(pdfPreview.body, pdf);
});

test("unknown extensions still receive a safe metadata preview", async () => {
  const preview = await createFilePreview(Buffer.from([0, 1, 2, 60, 115, 99, 114, 105, 112, 116, 62]), {
    filename: "측정원본.custom-binary",
    mimeType: "application/octet-stream",
  });
  const html = preview.body.toString("utf8");
  assert.equal(preview.kind, "html");
  assert.match(html, /측정원본\.custom-binary/);
  assert.match(html, /파일 식별 바이트/);
  assert.doesNotMatch(html, /<script>/);
});
