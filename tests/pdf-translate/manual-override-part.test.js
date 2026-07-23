"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  assertPostflightNonRegression,
  generateChunkPart,
  makeOverrideCaller,
  mixedSpanPdfTool,
  normalizeManifest,
  parseArgs,
  sha256,
  taggedScientificToUnicode,
  validCurrentPartFingerprints,
  validateOverrideBindings,
  writePartPairAtomic,
} = require("../../scripts/eval_pdf_translation_manual_overrides");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function manifest(overrides = {}) {
  return {
    schema_version: 1,
    source_pdf_sha256: HASH_A,
    translation_fingerprint: HASH_B,
    chunks: [{
      chunk_index: 2,
      chunk_pdf_sha256: "c".repeat(64),
      overrides: [{
        id: "7",
        source_text_sha256: "d".repeat(64),
        target: "검증된 번역이다.",
      }],
    }],
    ...overrides,
  };
}

test("manual override CLI parses only bounded explicit inputs", () => {
  const parsed = parseArgs([
    "--run-dir", "run",
    "--manifest", "manual.json",
    "--chunk-index", "3",
    "--model", "gpt-5.4",
    "--timeout-ms", "120000",
  ], "/workspace");
  assert.equal(parsed.runDir, "/workspace/run");
  assert.equal(parsed.manifest, "/workspace/manual.json");
  assert.equal(parsed.chunkIndex, 3);
  assert.equal(parsed.timeoutMs, 120000);
  assert.throws(
    () => parseArgs(["--run-dir", "run", "--manifest", "x", "--chunk-index", "-1"]),
    /non-negative/,
  );
});

test("manifest normalization binds source, fingerprint, chunk, ID, source text and target", () => {
  const raw = manifest();
  const bytes = Buffer.from(JSON.stringify(raw));
  const normalized = normalizeManifest(raw, bytes);
  assert.equal(normalized.manifest_sha256, sha256(bytes));
  assert.equal(normalized.chunks[0].chunk_index, 2);
  assert.equal(normalized.chunks[0].overrides[0].id, "7");

  assert.throws(
    () => normalizeManifest({ ...raw, source_pdf_sha256: "bad" }, bytes),
    /source_pdf_sha256/,
  );
  assert.throws(
    () => normalizeManifest({
      ...raw,
      chunks: [{
        ...raw.chunks[0],
        overrides: [raw.chunks[0].overrides[0], raw.chunks[0].overrides[0]],
      }],
    }, bytes),
    /duplicate ID/,
  );
});

test("override bindings reject source drift and require a whole continuation group", () => {
  const blocks = [
    {
      id: 1,
      page: 0,
      text: "This deliberately long source sentence continues without a final stop",
      continuation_group: "edge-1",
      continuation_role: "head",
      continuation_index: 0,
      continuation_count: 2,
      joined_source: "This deliberately long source sentence continues without a final stop on the next page with additional details.",
    },
    {
      id: 2,
      page: 1,
      text: "on the next page with additional details.",
      continuation_group: "edge-1",
      continuation_role: "tail",
      continuation_index: 1,
      continuation_count: 2,
      joined_source: "This deliberately long source sentence continues without a final stop on the next page with additional details.",
    },
  ];
  const one = {
    chunk_index: 0,
    overrides: [{
      id: "1",
      source_text_sha256: sha256(blocks[0].text),
      target: "이 의도적으로 긴 원문 문장은 끝맺음표 없이 다음 쪽으로 계속 이어져",
      mixed_span: null,
    }],
  };
  assert.throws(
    () => validateOverrideBindings(one, blocks),
    /must override every member/,
  );
  assert.throws(
    () => validateOverrideBindings({
      ...one,
      overrides: [{ ...one.overrides[0], source_text_sha256: HASH_A }],
    }, blocks),
    /source text hash mismatch/,
  );
});

test("injected caller overlays only an exact source-bound item and never edits cache", async () => {
  let baseCalls = 0;
  const base = async () => {
    baseCalls += 1;
    return {
      text: JSON.stringify({ t: { 1: "기존 1", 2: "기존 2" } }),
      usage: { input_tokens: 3 },
    };
  };
  const overrides = new Map([["1", {
    id: "1",
    target: "수동 1",
    mixed_span: null,
    block: { id: 1, text: "Source one." },
  }]]);
  const applied = new Set();
  const caller = makeOverrideCaller(base, overrides, applied);
  const response = await caller({
    user: `Translate.\n\n${JSON.stringify([
      { id: 1, text: "Source one." },
      { id: 2, text: "Source two." },
    ])}`,
  });
  assert.equal(baseCalls, 1);
  assert.deepEqual(JSON.parse(response.text).t, { 1: "수동 1", 2: "기존 2" });
  assert.deepEqual([...applied], ["1"]);

  await assert.rejects(
    caller({ user: `Translate.\n\n${JSON.stringify([{ id: 1, text: "Drifted." }])}` }),
    /source binding mismatch/,
  );
});

test("mixed-span extract adapter narrows only the reviewed ID for ordinary validation/render", async () => {
  const base = {
    async extractBlocks() {
      return { blocks: [{ id: 10, text: "<sub>z</sub>⟩, and thus" }, { id: 11, text: "Other" }] };
    },
  };
  const wrapped = mixedSpanPdfTool(base, new Map([["10", {
    mixed_span: { prose_source: "and thus" },
  }]]));
  const result = await wrapped.extractBlocks("unused.pdf");
  assert.deepEqual(result.blocks, [
    { id: 10, text: "and thus" },
    { id: 11, text: "Other" },
  ]);
});

test("render-only layout target must be an exact deterministic Unicode sub/sup conversion", async () => {
  assert.equal(
    taggedScientificToUnicode("P<sup>sid</sup> and V<sub>0</sub>"),
    "Pˢⁱᵈ and V₀",
  );
  const raw = manifest({
    chunks: [{
      chunk_index: 2,
      chunk_pdf_sha256: "c".repeat(64),
      overrides: [{
        id: "7",
        source_text_sha256: "d".repeat(64),
        target: "항성주기 P<sup>sid</sup>",
        render_target: "항성주기 Pˢⁱᵈ",
      }],
    }],
  });
  assert.equal(
    normalizeManifest(raw, Buffer.from(JSON.stringify(raw))).chunks[0].overrides[0].render_target,
    "항성주기 Pˢⁱᵈ",
  );
  assert.throws(
    () => normalizeManifest({
      ...raw,
      chunks: [{
        ...raw.chunks[0],
        overrides: [{ ...raw.chunks[0].overrides[0], render_target: "다른 문자열" }],
      }],
    }, Buffer.from("bad")),
    /exact Unicode/,
  );

  let seen;
  const wrapped = mixedSpanPdfTool({
    async extractBlocks() { return { blocks: [] }; },
    async renderTranslated(_pdf, _out, _font, translations) {
      seen = translations;
      return { ok: true };
    },
  }, new Map([["7", {
    id: "7",
    target: "항성주기 P<sup>sid</sup>",
    render_target: "항성주기 Pˢⁱᵈ",
    mixed_span: null,
  }]]));
  await wrapped.renderTranslated("source", "out", "font", {
    7: "항성주기 P<sup>sid</sup>",
  });
  assert.equal(seen[7], "항성주기 Pˢⁱᵈ");
});

test("atomic writer refuses an existing checkpoint and cleans a half pair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-part-write-"));
  try {
    const part = path.join(root, "part-002.ko.pdf");
    const meta = path.join(root, "part-002.json");
    const buffer = Buffer.from("%PDF-test", "ascii");
    writePartPairAtomic(part, meta, buffer, { output_sha256: sha256(buffer) });
    assert.deepEqual(fs.readFileSync(part), buffer);
    assert.equal(JSON.parse(fs.readFileSync(meta, "utf8")).output_sha256, sha256(buffer));
    assert.throws(
      () => writePartPairAtomic(part, meta, buffer, {}),
      /refusing to overwrite/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mixed postflight may retain only baseline failures and may not add issue pages", () => {
  const base = {
    passed: false,
    report: {
      hard_failures: ["page_order", "untranslated_text"],
      summary: { pages_with_issues: 3 },
    },
  };
  const improved = {
    passed: false,
    report: {
      hard_failures: ["page_order"],
      summary: { pages_with_issues: 2 },
    },
  };
  assert.equal(
    assertPostflightNonRegression(base, improved).mode,
    "differential_non_regression",
  );
  assert.throws(
    () => assertPostflightNonRegression(base, {
      passed: false,
      report: {
        hard_failures: ["page_order", "number_preservation"],
        summary: { pages_with_issues: 2 },
      },
    }),
    /introduced postflight failures/,
  );
  assert.throws(
    () => assertPostflightNonRegression(base, {
      passed: false,
      report: {
        hard_failures: ["page_order"],
        summary: { pages_with_issues: 4 },
      },
    }),
    /increased verifier issue pages/,
  );
});

test("current fingerprint evidence accepts only source/output-bound sibling part pairs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-part-fingerprint-"));
  try {
    const parts = path.join(root, "parts");
    const chunks = path.join(root, "chunks");
    fs.mkdirSync(parts);
    fs.mkdirSync(chunks);
    const chunkPath = path.join(chunks, "chunk-0.pdf");
    const partPath = path.join(parts, "part-000.ko.pdf");
    fs.writeFileSync(chunkPath, "source");
    fs.writeFileSync(partPath, "output");
    fs.writeFileSync(path.join(parts, "part-000.json"), JSON.stringify({
      chunk_index: 0,
      source_sha256: sha256(Buffer.from("source")),
      output_sha256: sha256(Buffer.from("output")),
      translation_fingerprint: HASH_A,
    }));
    assert.deepEqual(
      [...validCurrentPartFingerprints(root, { chunks: [{ path: chunkPath }] })],
      [HASH_A],
    );
    fs.writeFileSync(partPath, "tampered");
    assert.equal(validCurrentPartFingerprints(root, { chunks: [{ path: chunkPath }] }).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("one chunk generation uses the existing caller/translation gate and exact part naming", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manual-part-generate-"));
  try {
    const chunksDir = path.join(root, "chunks");
    const auditDir = path.join(root, "ocr-audit/chunk-000");
    fs.mkdirSync(chunksDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });
    const chunkPath = path.join(chunksDir, "chunk-0.pdf");
    const chunkBytes = Buffer.from("%PDF-source", "ascii");
    fs.writeFileSync(chunkPath, chunkBytes);
    fs.mkdirSync(path.join(root, "codex-cache"));
    fs.writeFileSync(path.join(auditDir, "audit.json"), JSON.stringify({
      source_sha256: sha256(chunkBytes),
      pages: [],
      risk_pages: [],
      math_garbled_pages: [],
      two_column_pages: [],
    }));
    const source = "The sample contains 42 particles.";
    const target = "이 샘플에는 입자 42개가 들어 있다.";
    const normalized = normalizeManifest({
      schema_version: 1,
      source_pdf_sha256: HASH_A,
      translation_fingerprint: HASH_B,
      chunks: [{
        chunk_index: 0,
        chunk_pdf_sha256: sha256(chunkBytes),
        overrides: [{ id: "7", source_text_sha256: sha256(source), target }],
      }],
    }, Buffer.from("bound manifest"));
    const result = await generateChunkPart({
      runDir: root,
      manifest: normalized,
      chunkManifest: normalized.chunks[0],
      model: "gpt-5.4",
      timeoutMs: 60_000,
      split: { chunks: [{ path: chunkPath, start: 1, end: 1 }] },
      dependencies: {
        pdfTool: {
          async extractBlocks() {
            return {
              page_count: 1,
              blocks: [{ id: 7, page: 0, text: source }],
              ocr_layer: false,
            };
          },
        },
        makeCodexCaller() {
          return async () => {
            throw new Error("manual-only request must not call the model");
          };
        },
        async translateSinglePdf(options) {
          const response = await options.caller({
            user: `Translate.\n\n${JSON.stringify([{ id: 7, text: source }])}`,
          });
          assert.equal(JSON.parse(response.text).t[7], target);
          return {
            buffer: Buffer.from("%PDF-result", "ascii"),
            pageCount: 1,
            blockCount: 1,
            stats: { ok: true, min_font: 10 },
          };
        },
      },
    });
    assert.equal(path.basename(result.partPath), "part-000.ko.pdf");
    assert.equal(path.basename(result.metadataPath), "part-000.json");
    assert.equal(result.metadata.translation_fingerprint, HASH_B);
    assert.equal(result.metadata.manual_override_manifest_sha256, normalized.manifest_sha256);
    assert.equal(result.metadata.manual_quality_gate_min_font_pt, 8);
    assert.equal(result.metadata.manual_override_provenance[0].source_text_sha256, sha256(source));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
