"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const test = require("node:test");

const {
  translateSinglePdf,
} = require("../../lib/pipelines/pdf-translate/translate");

function completeOneBlockStats() {
  return {
    ok: true,
    expected: 1,
    replaced: 1,
    drawn: 1,
    completed: 1,
    page_expected: 1,
    page_drawn: 1,
    font_expected: 1,
    preserved_original: 0,
    preserved_original_ids: [],
    virtual_replaced: 0,
    outline_expected: 0,
    outline_replaced: 0,
    metadata_expected: 0,
    metadata_replaced: 0,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 9,
    font_sizes: [{ id: 7, source: 10, rendered: 9 }],
  };
}

test("renderer-neutral document model capture is opt-in and hash-bound", async () => {
  const input = Buffer.from("%PDF-synthetic-document-model");
  const pdfTool = {
    async extractBlocks() {
      return {
        page_count: 1,
        scanned: false,
        truly_blank: false,
        page_block_count: 1,
        blocks: [{ id: 7, page: 0, text: "Earth rotates." }],
        fig_regions: 0,
        fitz: "test",
      };
    },
    async renderTranslated(_inputPath, outputPath, _fontPath, translations) {
      assert.deepEqual(translations, { 7: "지구는 자전한다." });
      fs.writeFileSync(outputPath, "%PDF-rendered");
      return completeOneBlockStats();
    },
  };
  const caller = async () => ({
    text: JSON.stringify({ t: { 7: "지구는 자전한다." } }),
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const progress = { addTotal() {}, tick() {} };

  const captured = await translateSinglePdf({
    pdfBuffer: input,
    caller,
    gate: (fn) => Promise.resolve().then(fn),
    progress,
    pdfTool,
    captureDocumentModel: true,
  });
  assert.deepEqual(captured.documentModel, {
    schema_version: 1,
    source_sha256: crypto.createHash("sha256").update(input).digest("hex"),
    page_count: 1,
    blocks: [{ id: 7, page: 0, text: "Earth rotates." }],
    translations: { 7: "지구는 자전한다." },
  });

  const ordinary = await translateSinglePdf({
    pdfBuffer: input,
    caller,
    gate: (fn) => Promise.resolve().then(fn),
    progress,
    pdfTool,
  });
  assert.equal(Object.hasOwn(ordinary, "documentModel"), false);
});
