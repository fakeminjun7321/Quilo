const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PDF_TRANSLATION_QUALITY_ERROR,
  assertCompleteTranslations,
  assertCompleteRender,
} = require("../../lib/pipelines/pdf-translate/quality-gate");

test("outline/metadata virtual block translation is required", () => {
  const blocks = [
    { id: 1, text: "Page text" },
    { id: "__pdf_outline__:000000", kind: "outline", text: "Fixture start" },
    { id: "__pdf_metadata__:title", kind: "metadata", text: "Fixture title" },
  ];
  assert.throws(
    () => assertCompleteTranslations(blocks, {
      1: "페이지 본문",
      "__pdf_outline__:000000": "픽스처 시작",
      "__pdf_metadata__:title": "   ",
    }),
    (error) => {
      assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
      assert.equal(error.details.kind, "missing_translations");
      assert.deepEqual(error.details.missingIds, ["__pdf_metadata__:title"]);
      return true;
    },
  );
});

test("render diagnostics separate page font blocks from virtual reader UI blocks", () => {
  const stats = {
    ok: true,
    expected: 5,
    replaced: 5,
    drawn: 5,
    page_expected: 2,
    page_drawn: 2,
    font_expected: 2,
    virtual_replaced: 3,
    outline_expected: 1,
    outline_replaced: 1,
    metadata_expected: 2,
    metadata_replaced: 2,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 9,
    min_glyph_font: 9,
    font_sizes: [
      { id: 1, source: 10, rendered: 10, min_glyph: 10 },
      { id: 2, source: 9, rendered: 9, min_glyph: 9 },
    ],
  };
  assert.equal(assertCompleteRender(stats, 5).replaced, 5);

  assert.throws(
    () => assertCompleteRender({ ...stats, virtual_replaced: 2 }, 5),
    (error) => {
      assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
      assert.equal(error.details.kind, "incomplete_render");
      assert.equal(error.details.diagnosticsPresent, false);
      return true;
    },
  );
});
