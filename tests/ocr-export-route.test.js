"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const sharp = require("sharp");
const { createDocumentToolRouter } = require("../lib/document-tools/routes");

async function fixtureImage() {
  return sharp({ create: { width: 700, height: 950, channels: 3, background: "white" } })
    .composite([{ input: Buffer.from('<svg width="700" height="950"><text x="50" y="110" font-size="42">수능형 OCR 8번</text><rect x="80" y="500" width="260" height="180" fill="#dde8ff"/></svg>') }])
    .png()
    .toBuffer();
}

function fixtureResult() {
  const text = "8. 다음 자료를 보고 옳은 것을 고르시오.\n\n<보기>\nㄱ. 첫 번째 설명\nㄴ. 두 번째 설명";
  return {
    text,
    sourceText: text,
    confidence: { average: 0.99, minimum: 0.96 },
    quality: { agreement: 0.98, verifiedConfidence: 0.985 },
    pages: [{
      page: 1,
      markdown: text,
      dimensions: { width: 700, height: 950 },
      images: [{ id: "figure-1", topLeftX: 80, topLeftY: 500, bottomRightX: 340, bottomRightY: 680, annotation: "자료 그림" }],
      tables: [{ id: "table-1", format: "html", content: '<table><tr><th colspan="2">자료</th></tr><tr><td>A</td><td>B</td></tr></table>' }],
      blocks: [
        { type: "title", content: "8. 다음 자료를 보고 옳은 것을 고르시오.", order: 0 },
        { type: "aside_text", content: "<보기>\nㄱ. 첫 번째 설명\nㄴ. 두 번째 설명", order: 1 },
        { type: "table", tableId: "table-1", order: 2 },
        { type: "image", imageId: "figure-1", content: "자료 그림", order: 3 },
      ],
    }],
  };
}

test("real OCR export route returns verified DOCX, HWPX, HTML, and TXT files", { timeout: 60_000 }, async (t) => {
  const app = express();
  const pass = (_req, _res, next) => next();
  app.use("/api/tools", createDocumentToolRouter({
    requireAuth: pass,
    requirePro: pass,
    analyzePdf: async () => ({}),
    getSessionUser: () => ({ id: null, isAdmin: true }),
    rateLimit: { recordBetaUsage() {} },
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => server.close());
  const address = server.address();
  const image = await fixtureImage();

  const signatures = {
    docx: (buffer) => buffer.subarray(0, 2).toString("ascii") === "PK",
    hwpx: (buffer) => buffer.subarray(0, 2).toString("ascii") === "PK",
    html: (buffer) => buffer.toString("utf8", 0, 15).toLowerCase().startsWith("<!doctype html>"),
    txt: (buffer) => buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
  };

  for (const format of Object.keys(signatures)) {
    const form = new FormData();
    form.append("image", new Blob([image], { type: "image/png" }), "exam.png");
    form.append("format", format);
    form.append("result", JSON.stringify(fixtureResult()));
    const response = await fetch(`http://127.0.0.1:${address.port}/api/tools/images/ocr/export`, { method: "POST", body: form });
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, `${format}: ${buffer.toString("utf8", 0, 300)}`);
    assert.equal(response.headers.get("x-quilo-postflight"), "passed", format);
    assert.equal(response.headers.get("x-quilo-source-image"), "not-embedded", format);
    assert.equal(response.headers.get("x-quilo-reconstruction"), "editable-elements", format);
    assert.equal(response.headers.get("x-quilo-layout-blocks"), "4", format);
    assert.equal(response.headers.get("x-quilo-detected-images"), format === "txt" ? "0" : "1", format);
    assert.equal(signatures[format](buffer), true, `${format} signature`);
  }
});
