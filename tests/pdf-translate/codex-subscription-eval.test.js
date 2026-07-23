"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  DEFAULT_FINAL_NAME,
  hasValidSentenceSafeSplitLayout,
  makeCodexCaller,
  parseArgs,
  readNavigationManifest,
  resolveSafeOutputFile,
  SPLIT_POLICY_NAME,
  validateFinalName,
} = require("../../scripts/eval_pdf_translation_codex_subscription");
const {
  buildBatches,
} = require("../../lib/pipelines/pdf-translate/translate");

function splitFixture(ranges, pageCount = ranges.at(-1)?.[1] || 0) {
  return {
    page_count: pageCount,
    split_policy: {
      name: SPLIT_POLICY_NAME,
      max_pages_per_chunk: 3,
    },
    chunks: ranges.map(([start, end]) => ({
      start,
      end,
      page_tokens: Array.from(
        { length: end - start + 1 },
        (_, index) => `${start + index}`.padStart(32, "0"),
      ),
    })),
  };
}

test("Codex runner accepts only contiguous sentence-safe chunks within the configured ceiling", () => {
  assert.equal(
    hasValidSentenceSafeSplitLayout(
      splitFixture([[1, 2], [3, 5], [6, 7]], 7),
      3,
    ),
    true,
  );

  const oversized = splitFixture([[1, 4], [5, 7]], 7);
  oversized.split_policy.max_pages_per_chunk = 3;
  assert.equal(hasValidSentenceSafeSplitLayout(oversized, 3), false);

  const oldPolicy = splitFixture([[1, 3], [4, 6]], 6);
  delete oldPolicy.split_policy;
  assert.equal(hasValidSentenceSafeSplitLayout(oldPolicy, 3), false);

  const gap = splitFixture([[1, 2], [4, 6]], 6);
  assert.equal(hasValidSentenceSafeSplitLayout(gap, 3), false);
});

test("OCR-layer translation batches cover at most six distinct source pages", () => {
  const blocks = Array.from({ length: 14 }, (_, index) => ({
    id: String(index),
    page: index,
    text: `Source paragraph ${index}`,
  }));
  const batches = buildBatches(blocks, 999999, 350, 6);
  assert.deepEqual(batches.map((batch) => batch.map((block) => block.page)), [
    [0, 1, 2, 3, 4, 5],
    [6, 7, 8, 9, 10, 11],
    [12, 13],
  ]);
});

test("OCR-layer Codex caller fails before upload on oversized or missing page-image evidence", async () => {
  const sevenPageCaller = makeCodexCaller({
    model: "gpt-test",
    timeoutMs: 10000,
    idToPage: new Map(Array.from({ length: 7 }, (_, index) => [String(index), index])),
    audit: { pages: [], risk_pages: [] },
    diagnostics: [],
    requireCompletePageImages: true,
  });
  await assert.rejects(
    sevenPageCaller({
      system: "system",
      user: JSON.stringify(Array.from({ length: 7 }, (_, id) => ({ id, text: "x" }))),
    }),
    /maximum is 6/,
  );

  const missingRasterCaller = makeCodexCaller({
    model: "gpt-test",
    timeoutMs: 10000,
    idToPage: new Map([["a", 0]]),
    audit: { pages: [{ index: 0, images: [] }], risk_pages: [] },
    diagnostics: [],
    requireCompletePageImages: true,
  });
  await assert.rejects(
    missingRasterCaller({
      system: "system",
      user: JSON.stringify([{ id: "a", text: "source" }]),
    }),
    /has no complete raster evidence/,
  );
});

test("Codex runner keeps the astronomy filename default and accepts an explicit safe PDF basename", () => {
  const base = parseArgs(["--input", "source.pdf", "--output-dir", "out"], "/tmp");
  assert.equal(base.finalName, DEFAULT_FINAL_NAME);
  assert.equal(base.navigationManifest, null);

  const numerical = parseArgs([
    "--input", "source.pdf",
    "--output-dir", "out",
    "--final-name", "numerical-analysis-10e-ko.pdf",
    "--navigation-manifest", "navigation.json",
  ], "/tmp");
  assert.equal(numerical.finalName, "numerical-analysis-10e-ko.pdf");
  assert.equal(numerical.navigationManifest, "/tmp/navigation.json");
});

test("final PDF basenames reject traversal, absolute paths, hidden files, controls and non-PDF names", () => {
  for (const value of [
    "../escaped.pdf",
    "/tmp/escaped.pdf",
    "folder/escaped.pdf",
    "folder\\escaped.pdf",
    ".hidden.pdf",
    "not-a-pdf.txt",
    "line\nbreak.pdf",
    `${"a".repeat(241)}.pdf`,
  ]) {
    assert.throws(() => validateFinalName(value), /safe PDF basename|non-empty/);
  }
  assert.equal(validateFinalName("수치해석학-10판-한국어.pdf"), "수치해석학-10판-한국어.pdf");
});

test("safe final path resolution refuses a pre-existing symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-final-name-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.pdf");
  fs.writeFileSync(outside, "not a PDF");
  const linked = path.join(root, "translated.pdf");
  fs.symlinkSync(outside, linked);
  assert.throws(
    () => resolveSafeOutputFile(root, "translated.pdf"),
    /must not be a symlink/,
  );
  fs.unlinkSync(linked);
  assert.equal(resolveSafeOutputFile(root, "translated.pdf"), linked);
});

test("navigation manifests are regular bounded UTF-8 JSON files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-navigation-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "navigation.json");
  const bytes = Buffer.from('{"schema_version":1}', "utf8");
  fs.writeFileSync(manifest, bytes);
  assert.deepEqual(readNavigationManifest(manifest), bytes);

  const linked = path.join(root, "linked.json");
  fs.symlinkSync(manifest, linked);
  assert.throws(() => readNavigationManifest(linked), /non-symlink/);
  const invalid = path.join(root, "invalid.json");
  fs.writeFileSync(invalid, "{");
  assert.throws(() => readNavigationManifest(invalid), /valid UTF-8 JSON/);
});
