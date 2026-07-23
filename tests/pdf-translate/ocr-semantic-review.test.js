"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCanonicalOcrEvidence,
} = require("../../lib/pipelines/pdf-translate/mistral-ocr");
const {
  bindTargetSegment,
  prepareSourceSegment,
  sealRetypesetEvidence,
} = require("../../lib/pipelines/pdf-translate/provenance");
const {
  judgeSemanticSegments,
} = require("../../lib/pipelines/pdf-translate/semantic-judge");
const {
  assertKoreanTargetPolicy,
  buildVisualReview,
  normalizeOcrReviewText,
  ocrPageRequiresKorean,
  createOcrSemanticReviewForOutput,
  reviewBindingDigest,
  sealOcrSemanticReview,
  validateOcrSemanticReview,
  validateVisualReview,
} = require("../../lib/pipelines/pdf-translate/ocr-semantic-review");
const { sha256Canonical, sha256Hex } = require("../../lib/pipelines/pdf-translate/invariants");
const {
  buildOcrRenderManifest,
  prepareOcrModelInputs,
} = require("../../lib/pipelines/pdf-translate/ocr-routing");
const { verifyPdfTranslationPostflight } = require("../../lib/pipelines/pdf-translate/postflight");

const SOURCE_PDF = Buffer.from("%PDF-1.7\nstrict OCR semantic source", "utf8");
const OUTPUT_PDF = Buffer.from("%PDF-1.7\nstrict OCR semantic output", "utf8");
const LAYOUT = Buffer.from("ocr-retypeset-page-layout-v1", "utf8");
const SOURCE_TEXT = "Calibration measurement is 12.5 kg at https://example.test/run/7.";
const TARGET_TEXT = "교정 측정값은 12.5 kg이며 https://example.test/run/7에서 확인됩니다.";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const MANIFEST_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABEAAAAWCAIAAACpCuAVAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAG0lEQVR4nGP4TzpgGNXzf1TP/1E9/0f1kBsGAMPPXdv1LV/gAAAAAElFTkSuQmCC",
  "base64",
);

function rasterPagesFixture() {
  return [{
    index: 0,
    width: 612,
    height: 792,
    rotation: 0,
    tiles: [{
      index: 0,
      bbox: [0, 0, 612, 792],
      width: 17,
      height: 22,
      file: "/tmp/p-000-00.png",
    }],
  }];
}

function words(text) {
  let cursor = 0;
  return text.split(/\s+/).map((value) => {
    const start_index = text.indexOf(value, cursor);
    cursor = start_index + value.length;
    return { text: value, confidence: 0.99, start_index };
  });
}

function ocrEvidence() {
  return buildCanonicalOcrEvidence({
    request_id: "ocr-request-semantic-1",
    model: "mistral-ocr-test",
    usage_info: { pages_processed: 1, doc_size_bytes: SOURCE_PDF.length },
    pages: [{
      index: 0,
      markdown: SOURCE_TEXT,
      images: [],
      dimensions: { width: 612, height: 792, dpi: 72 },
      confidence_scores: {
        average_page_confidence_score: 0.99,
        minimum_page_confidence_score: 0.98,
        word_confidence_scores: words(SOURCE_TEXT),
      },
      blocks: [{
        type: "text",
        top_left_x: 50,
        top_left_y: 50,
        bottom_right_x: 560,
        bottom_right_y: 120,
        content: SOURCE_TEXT,
      }],
    }],
  }, {
    sourcePdf: SOURCE_PDF,
    sourcePages: [{ index: 0, width: 612, height: 792, rotation: 0 }],
  });
}

function segmentInput() {
  const prepared = prepareSourceSegment({
    documentSha256: sha256Hex(SOURCE_PDF),
    page: 1,
    order: 1,
    kind: "ocr_page",
    sourceText: SOURCE_TEXT,
  });
  let maskedTarget = normalizeOcrReviewText(TARGET_TEXT);
  for (const entry of prepared.mask.entries) {
    maskedTarget = maskedTarget.replace(entry.literal, entry.placeholder);
  }
  return {
    prepared,
    bound: bindTargetSegment(prepared, maskedTarget),
    source_text: SOURCE_TEXT,
  };
}

async function renderManifestFixture() {
  const prepared = await prepareOcrModelInputs({
    rasterFiles: ["/tmp/p-000-00.png"],
    tileBuffers: [MANIFEST_PNG],
    transformOptions: { forceCompress: true },
  });
  return buildOcrRenderManifest({
    sourcePdf: SOURCE_PDF,
    pageCount: 1,
    rasterFiles: ["/tmp/p-000-00.png"],
    rasterPages: rasterPagesFixture(),
    tileBuffers: [MANIFEST_PNG],
    modelInputBlocks: prepared.imageBlocks,
    modelInputProofs: prepared.modelInputProofs,
    expectedLocalPages: 1,
  });
}

function fakeVisualReview(evidence, manifest) {
  const tile = {
    index: 0,
    bbox: [0, 0, 1, 1],
    width: 1,
    height: 1,
    media_type: "image/png",
    image_sha256: sha256Hex(PNG),
  };
  const review = {
    schema_version: 1,
    task: "ocr-retypeset-nontext-visual-review",
    provider: "mistral",
    model: "mock-visual-judge",
    request_id: "visual-review-request-1",
    source_pdf_sha256: sha256Hex(SOURCE_PDF),
    output_pdf_sha256: sha256Hex(OUTPUT_PDF),
    ocr_evidence_sha256: evidence.evidence_sha256,
    ocr_render_manifest_sha256: manifest.manifest_sha256,
    input_digest: "0".repeat(64),
    batches: [],
    pages: [{
      page: 1,
      source_tiles: [tile],
      output_tiles: [tile],
      verdict: "pass",
      nontext_preserved: true,
      no_missing_figures: true,
      no_added_figures: true,
      all_source_text_covered: true,
      text_meaning_preserved: true,
      target_language_korean: true,
      no_added_text: true,
    }],
  };
  review.input_digest = sha256Canonical({
    schema_version: 1,
    task: review.task,
    intent: "translate",
    source_pdf_sha256: review.source_pdf_sha256,
    output_pdf_sha256: review.output_pdf_sha256,
    ocr_evidence_sha256: review.ocr_evidence_sha256,
    ocr_render_manifest_sha256: review.ocr_render_manifest_sha256,
    pages: review.pages.map((page) => ({
      page: page.page,
      source_tiles: page.source_tiles,
      output_tiles: page.output_tiles,
    })),
  });
  review.batches = [{
    request_id: review.request_id,
    input_digest: review.input_digest,
    pages: [1],
  }];
  review.review_sha256 = sha256Canonical(review);
  return review;
}

async function mockVisualPageRenderer(_pdf, indices) {
  return indices.map((index) => ({
    index,
    source_width: 1,
    source_height: 1,
    tiles: [{
      index: 0,
      bbox: [0, 0, 1, 1],
      width: 1,
      height: 1,
      media_type: "image/png",
      image_sha256: sha256Hex(PNG),
      buffer: PNG,
    }],
  }));
}

async function mockVisualPageInspector(_pdf, { role } = {}) {
  void role;
  return [{ index: 0, width: 1, height: 1, rotation: 0 }];
}

async function passingVisualJudge({ request }) {
  return {
    provider: "mistral",
    model: "mock-visual-judge",
    request_id: "visual-builder-request-1",
    input_digest: sha256Canonical(request),
    text: JSON.stringify({
      schema_version: 1,
      task: "ocr-retypeset-nontext-visual-review",
      input_digest: sha256Canonical(request),
      pages: request.pages.map((page) => ({
        page: page.page,
        source_tiles_digest: sha256Canonical(page.source_tiles),
        output_tiles_digest: sha256Canonical(page.output_tiles),
        verdict: "pass",
        nontext_preserved: true,
        no_missing_figures: true,
        no_added_figures: true,
        all_source_text_covered: true,
        text_meaning_preserved: true,
        target_language_korean: true,
        no_added_text: true,
      })),
    }),
  };
}

async function judged(entry, verdict = "pass") {
  return judgeSemanticSegments({
    segments: [entry],
    generationProvider: "anthropic",
    judgeProvider: "openai",
    judgeModel: "mock-independent-judge",
    resourceLimits: { runApi: (task) => task() },
    caller: async ({ request }) => ({
      request_id: `judge-${verdict}-request-1`,
      text: JSON.stringify({
        schema_version: 1,
        task: "independent-semantic-correspondence",
        items: request.items.map((item) => ({
          segment_id: item.segment_id,
          source_sha256: item.source_sha256,
          target_sha256: item.target_sha256,
          verdict,
          meaning_equivalent: verdict === "pass",
          complete: verdict === "pass",
          no_additions: verdict === "pass",
          invariant_associations_correct: verdict === "pass",
          reason_codes: verdict === "pass" ? [] : ["MEANING_MISMATCH"],
        })),
      }),
      usage: {},
    }),
  });
}

async function fixture() {
  const evidence = ocrEvidence();
  const manifest = await renderManifestFixture();
  const entry = segmentInput();
  const review = await createOcrSemanticReviewForOutput({
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    generationProvider: "anthropic",
    generationModel: "mock-translator",
    generationRequestId: "translation-request-1",
    pageTextExtractor: async () => [TARGET_TEXT],
    judgeCaller: async ({ request }) => ({
      request_id: "judge-pass-request-1",
      text: JSON.stringify({
        schema_version: 1,
        task: "independent-semantic-correspondence",
        items: request.items.map((item) => ({
          segment_id: item.segment_id,
          source_sha256: item.source_sha256,
          target_sha256: item.target_sha256,
          verdict: "pass",
          meaning_equivalent: true,
          complete: true,
          no_additions: true,
          invariant_associations_correct: true,
          reason_codes: [],
        })),
      }),
      usage: {},
    }),
    visualPageRenderer: mockVisualPageRenderer,
    visualPageInspector: mockVisualPageInspector,
    visualJudgeCaller: passingVisualJudge,
    layoutTemplate: LAYOUT,
    resourceLimits: { runApi: (task) => task() },
  });
  return { evidence, manifest, entry, review };
}

test("OCR semantic review binds source OCR, output PDF/text, page and segment IDs", async () => {
  const { evidence, manifest, review } = await fixture();
  const validated = validateOcrSemanticReview(review, {
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
  });
  assert.equal(validated.bindings.length, 1);
  assert.equal(validated.bindings[0].page, 1);
  assert.match(validated.bindings[0].segment_id, /^seg-[a-f0-9]{12}-p0001-o0001$/);
  assert.equal(validated.verifierBundle.pages[0].text, SOURCE_TEXT);
  assert.equal(validated.verifierBundle.semantic_review.bindings[0].target_sha256,
    sha256Hex(normalizeOcrReviewText(TARGET_TEXT)));
});

test("boolean review, OCR tamper, output artifact swap and wrapper reseal mismatch are rejected", async () => {
  const { evidence, manifest, review } = await fixture();
  for (const candidate of [true, { passed: true }, { verdict: "pass" }]) {
    assert.throws(
      () => validateOcrSemanticReview(candidate, {
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        sourcePdf: SOURCE_PDF,
        outputPdf: OUTPUT_PDF,
      }),
      /must be an object|missing or unexpected fields/,
    );
  }

  const tamperedOcr = structuredClone(evidence);
  tamperedOcr.pages[0].blocks[0].content = "Different OCR source 12.5 kg";
  assert.throws(() => validateOcrSemanticReview(review, {
    ocrEvidence: tamperedOcr,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
  }));
  assert.throws(() => validateOcrSemanticReview(review, {
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: Buffer.from("different output PDF"),
  }));

  const resealedOnly = { ...review, review_binding_sha256: "f".repeat(64) };
  assert.throws(() => validateOcrSemanticReview(resealedOnly, {
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
  }), /binding seal/);

  const booleanVisual = { ...review, visual_review: { passed: true } };
  booleanVisual.review_binding_sha256 = "f".repeat(64);
  assert.throws(() => validateOcrSemanticReview(booleanVisual, {
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
  }), /missing or unexpected fields/);

  const rejectedVisual = structuredClone(review);
  rejectedVisual.layout_template = review.layout_template;
  rejectedVisual.visual_review.pages[0].no_missing_figures = false;
  const unsignedVisual = { ...rejectedVisual.visual_review };
  delete unsignedVisual.review_sha256;
  rejectedVisual.visual_review.review_sha256 = sha256Canonical(unsignedVisual);
  rejectedVisual.review_binding_sha256 = reviewBindingDigest(rejectedVisual);
  assert.throws(() => validateOcrSemanticReview(rejectedVisual, {
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
  }), /Visual review page evidence is invalid/);
});

test("public resealing cannot forge visual or semantic judge attestations", async () => {
  const { evidence, manifest, review } = await fixture();

  const missingVisualAttestation = structuredClone(review);
  missingVisualAttestation.layout_template = review.layout_template;
  delete missingVisualAttestation.visual_review.judge_attestation;
  {
    const unsigned = { ...missingVisualAttestation.visual_review };
    delete unsigned.review_sha256;
    missingVisualAttestation.visual_review.review_sha256 = sha256Canonical(unsigned);
  }
  missingVisualAttestation.review_binding_sha256 = reviewBindingDigest(
    missingVisualAttestation,
  );
  assert.throws(
    () => validateOcrSemanticReview(missingVisualAttestation, {
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      sourcePdf: SOURCE_PDF,
      outputPdf: OUTPUT_PDF,
    }),
    /missing or unexpected fields/,
  );

  const forgedSemantic = structuredClone(review);
  forgedSemantic.layout_template = review.layout_template;
  forgedSemantic.retypeset_evidence.judge.request_id = "fake-semantic-request";
  forgedSemantic.semantic_batches[0].request_id = "fake-semantic-request";
  forgedSemantic.semantic_judge_attestation.judge_request_id =
    "fake-semantic-request";
  forgedSemantic.semantic_judge_attestation.binding_hmac_sha256 = "0".repeat(64);
  {
    const unsignedEvidence = { ...forgedSemantic.retypeset_evidence };
    delete unsignedEvidence.evidence_sha256;
    forgedSemantic.retypeset_evidence.evidence_sha256 =
      sha256Canonical(unsignedEvidence);
  }
  forgedSemantic.review_binding_sha256 = reviewBindingDigest(forgedSemantic);
  assert.throws(
    () => validateOcrSemanticReview(forgedSemantic, {
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      sourcePdf: SOURCE_PDF,
      outputPdf: OUTPUT_PDF,
    }),
    (error) => error.code === "OCR_SEMANTIC_REVIEW_ATTESTATION_INVALID",
  );
});

test("unrelated translation rejected by independent mocked judge cannot be sealed as passing evidence", async () => {
  const entry = segmentInput();
  const rejected = await judged(entry, "fail");
  assert.equal(rejected.evaluations[0].meaning_equivalent, false);
  assert.throws(() => sealRetypesetEvidence({
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
    layoutTemplate: LAYOUT,
    segments: [entry.bound.segment],
    figures: [],
    translation: {
      provider: "anthropic",
      model: "mock-translator",
      request_id: "translation-request-2",
    },
    judge: rejected.judge,
    judgeInput: {
      schema_version: 1,
      task: "independent-semantic-correspondence",
      target_language: "ko",
      items: [{
        segment_id: entry.bound.segment.segment_id,
        source_sha256: entry.bound.segment.source_sha256,
        target_sha256: entry.bound.segment.target_sha256,
        source: SOURCE_TEXT,
        target: normalizeOcrReviewText(TARGET_TEXT),
      }],
    },
  }), /explicit pass verdict/);
});

test("postflight accepts only the sealed review and forwards a private OCR source bundle", async () => {
  const { evidence, review } = await fixture();
  const manifest = await renderManifestFixture();
  const gateNames = [
    "pdf_open", "source_pdf_open", "page_correspondence", "page_render",
    "blank_pages", "black_pages", "content_coverage", "page_order",
    "semantic_correspondence", "text_preservation", "raw_markers", "garbling",
    "untranslated_text", "number_preservation", "unit_preservation",
    "chemical_formula_preservation", "url_preservation", "image_duplicates",
    "image_preservation", "nontext_visual_preservation", "vector_provenance",
    "link_preservation",
  ];
  const gates = Object.fromEntries(gateNames.map((name) => [name, {
    status: "pass", passed: true, hard: true, summary: "ok", details: {},
  }]));
  for (const name of ["text_preservation", "nontext_visual_preservation"]) {
    gates[name] = {
      status: "skip", passed: null, hard: true, summary: "not applicable", details: {},
    };
  }
  const report = JSON.stringify({
    schema_version: 2,
    mode: "retypeset",
    intent: "translate",
    passed: true,
    hard_failures: [],
    exit_code: 0,
    gates,
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-semantic-postflight-"));
  const fakePython = path.join(root, "python3");
  fs.writeFileSync(fakePython, [
    "#!/bin/sh",
    "previous=''",
    "for arg in \"$@\"; do",
    "  if [ \"$previous\" = '--json' ]; then report_path=\"$arg\"; fi",
    "  if [ \"$previous\" = '--ocr-source-json' ]; then source_path=\"$arg\"; fi",
    "  previous=\"$arg\"",
    "done",
    "test -n \"$source_path\" || exit 8",
    "grep -q '\"task\":\"ocr-postflight-source\"' \"$source_path\" || exit 9",
    "grep -q '\"task\":\"ocr-retypeset-semantic-review\"' \"$source_path\" || exit 10",
    `cat > \"$report_path\" <<'REPORT'\n${report}\nREPORT`,
  ].join("\n"), { mode: 0o755 });
  const previous = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = fakePython;
  try {
    const result = await verifyPdfTranslationPostflight({
      originalBuffer: SOURCE_PDF,
      resultBuffer: OUTPUT_PDF,
      mode: "retypeset",
      intent: "translate",
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      ocrSemanticReview: review,
      requireOcrEvidence: true,
      tempRoot: root,
    });
    assert.equal(result.passed, true);
    assert.equal(result.ocr_semantic_review_summary.segment_count, 1);
    const summary = JSON.stringify(result.ocr_semantic_review_summary);
    assert.equal(summary.includes(SOURCE_TEXT), false);
    assert.equal(summary.includes(TARGET_TEXT), false);
  } finally {
    if (previous == null) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production review builder uses final PDF text and an injected independent judge", async () => {
  const evidence = ocrEvidence();
  const manifest = await renderManifestFixture();
  let calls = 0;
  const review = await createOcrSemanticReviewForOutput({
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    generationProvider: "anthropic",
    generationModel: "mock-translator",
    generationRequestId: "translation-request-builder-1",
    pageTextExtractor: async () => [TARGET_TEXT],
    visualPageRenderer: mockVisualPageRenderer,
    visualPageInspector: mockVisualPageInspector,
    visualJudgeCaller: passingVisualJudge,
    judgeCaller: async ({ request }) => {
      calls += 1;
      return {
        request_id: "mistral-judge-builder-1",
        text: JSON.stringify({
          schema_version: 1,
          task: "independent-semantic-correspondence",
          items: request.items.map((item) => ({
            segment_id: item.segment_id,
            source_sha256: item.source_sha256,
            target_sha256: item.target_sha256,
            verdict: "pass",
            meaning_equivalent: true,
            complete: true,
            no_additions: true,
            invariant_associations_correct: true,
            reason_codes: [],
          })),
        }),
        usage: {},
      };
    },
    resourceLimits: { runApi: (task) => task() },
  });
  assert.equal(calls, 1);
  assert.equal(review.task, "ocr-retypeset-semantic-review");
  assert.equal(review.retypeset_evidence.judge.provider, "mistral");

  let wrongNumberJudgeCalls = 0;
  await assert.rejects(
    () => createOcrSemanticReviewForOutput({
      sourcePdf: SOURCE_PDF,
      outputPdf: OUTPUT_PDF,
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      generationProvider: "anthropic",
      generationModel: "mock-translator",
      generationRequestId: "translation-request-builder-2",
      pageTextExtractor: async () => [TARGET_TEXT.replace("12.5", "99.9")],
      visualPageRenderer: mockVisualPageRenderer,
      visualPageInspector: mockVisualPageInspector,
      visualJudgeCaller: passingVisualJudge,
      judgeCaller: async () => { wrongNumberJudgeCalls += 1; },
      resourceLimits: { runApi: (task) => task() },
    }),
    (error) => error.code === "OCR_SEMANTIC_REVIEW_INVARIANT_MISSING",
  );
  assert.equal(wrongNumberJudgeCalls, 0);
});

test("missing source figure is rejected by bound visual review even when text semantics pass", async () => {
  const evidence = ocrEvidence();
  const manifest = await renderManifestFixture();
  const semanticPass = async ({ request }) => ({
    request_id: "semantic-pass-visual-reject-case",
    text: JSON.stringify({
      schema_version: 1,
      task: "independent-semantic-correspondence",
      items: request.items.map((item) => ({
        segment_id: item.segment_id,
        source_sha256: item.source_sha256,
        target_sha256: item.target_sha256,
        verdict: "pass",
        meaning_equivalent: true,
        complete: true,
        no_additions: true,
        invariant_associations_correct: true,
        reason_codes: [],
      })),
    }),
    usage: {},
  });
  await assert.rejects(
    () => createOcrSemanticReviewForOutput({
      sourcePdf: SOURCE_PDF,
      outputPdf: OUTPUT_PDF,
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      generationProvider: "anthropic",
      generationModel: "mock-translator",
      generationRequestId: "translation-request-visual-reject",
      pageTextExtractor: async () => [TARGET_TEXT],
      judgeCaller: semanticPass,
      visualPageRenderer: mockVisualPageRenderer,
      visualPageInspector: mockVisualPageInspector,
      visualJudgeCaller: async ({ request }) => ({
        provider: "mistral",
        model: "mock-visual-judge",
        request_id: "visual-reject-request-1",
        input_digest: sha256Canonical(request),
        text: JSON.stringify({
          schema_version: 1,
          task: "ocr-retypeset-nontext-visual-review",
          input_digest: sha256Canonical(request),
          pages: [{
            page: 1,
            source_tiles_digest: sha256Canonical(request.pages[0].source_tiles),
            output_tiles_digest: sha256Canonical(request.pages[0].output_tiles),
            verdict: "fail",
            nontext_preserved: false,
            no_missing_figures: false,
            no_added_figures: true,
            all_source_text_covered: true,
            text_meaning_preserved: true,
            target_language_korean: true,
            no_added_text: true,
          }],
        }),
      }),
      resourceLimits: { runApi: (task) => task() },
    }),
    (error) => error.code === "OCR_VISUAL_REVIEW_REJECTED",
  );
});

test("OCR target-language policy is block-local, multilingual, and permits a short Korean glossary", () => {
  const mixed = {
    text: "한국어 제목\nThis short paragraph stays English.",
    blocks: [
      { type: "title", content: "한국어 제목" },
      { type: "text", content: "This short paragraph stays English." },
    ],
  };
  const japanese = {
    text: "この文章は日本語のままです。",
    blocks: [{ type: "text", content: "この文章は日本語のままです。" }],
  };
  const russian = {
    text: "Этот текст остается на русском языке.",
    blocks: [{ type: "text", content: "Этот текст остается на русском языке." }],
  };
  assert.equal(ocrPageRequiresKorean(mixed), true);
  assert.equal(ocrPageRequiresKorean(japanese), true);
  assert.equal(ocrPageRequiresKorean(russian), true);
  assert.equal(ocrPageRequiresKorean({
    text: "이 실험은 OpenAI API 모델을 사용한다.",
    blocks: [{ type: "text", content: "이 실험은 OpenAI API 모델을 사용한다." }],
  }), false);

  const heading = {
    text: "Attention Mechanism",
    blocks: [{ type: "title", content: "Attention Mechanism" }],
  };
  assert.doesNotThrow(() => assertKoreanTargetPolicy(
    heading,
    "어텐션 메커니즘 (Attention Mechanism)",
    1,
  ));
  assert.throws(
    () => assertKoreanTargetPolicy(
      mixed,
      "한국어 제목 This short paragraph stays English. 번역완료",
      1,
    ),
    (error) => error.code === "OCR_SEMANTIC_REVIEW_TARGET_LANGUAGE_INVALID",
  );

  const repeatedInCode = {
    text: "This function initializes the runtime context safely.\n" +
      "This function initializes the runtime context safely.",
    blocks: [
      { type: "text", content: "This function initializes the runtime context safely." },
      { type: "code", content: "This function initializes the runtime context safely." },
    ],
  };
  assert.doesNotThrow(() => assertKoreanTargetPolicy(
    repeatedInCode,
    "이 함수는 런타임 컨텍스트를 안전하게 초기화한다.\n" +
      "This function initializes the runtime context safely.",
    1,
  ));
  assert.throws(
    () => assertKoreanTargetPolicy(
      repeatedInCode,
      "This function initializes the runtime context safely.\n" +
        "This function initializes the runtime context safely. 번역완료",
      1,
    ),
    (error) => error.code === "OCR_SEMANTIC_REVIEW_TARGET_LANGUAGE_INVALID",
  );
});

function visualFixture(pageCount) {
  return {
    evidence: { page_count: pageCount, evidence_sha256: "a".repeat(64) },
    manifest: { manifest_sha256: "b".repeat(64) },
    inspector: async () => Array.from({ length: pageCount }, (_, index) => ({
      index, width: 1, height: 1, rotation: 0,
    })),
    renderer: async (_pdf, indices) => indices.map((index) => ({
      index,
      source_width: 1,
      source_height: 1,
      tiles: [{
        index: 0,
        bbox: [0, 0, 1, 1],
        width: 1,
        height: 1,
        media_type: "image/png",
        image_sha256: sha256Hex(PNG),
        buffer: PNG,
      }],
    })),
  };
}

test("restore visual review binds original-language intent independently of translation semantics", async () => {
  const fixtureValue = visualFixture(1);
  let receivedIntent = null;
  const sourcePdf = Buffer.from("visual-restore-source");
  const outputPdf = Buffer.from("visual-restore-output");
  const review = await buildVisualReview({
    sourcePdf,
    outputPdf,
    ocrEvidence: fixtureValue.evidence,
    ocrRenderManifest: fixtureValue.manifest,
    generationProvider: "anthropic",
    intent: "restore",
    visualPageInspector: fixtureValue.inspector,
    visualPageRenderer: fixtureValue.renderer,
    visualJudgeCaller: async (args) => {
      receivedIntent = args.request.intent;
      return passingVisualJudge(args);
    },
    resourceLimits: { runApi: (task) => task() },
  });
  assert.equal(receivedIntent, "restore");
  assert.equal(validateVisualReview(review, {
    sourcePdf,
    outputPdf,
    ocrEvidence: fixtureValue.evidence,
    ocrRenderManifest: fixtureValue.manifest,
    generationProvider: "anthropic",
    intent: "restore",
  }), review);
  assert.throws(
    () => validateVisualReview(review, {
      sourcePdf,
      outputPdf,
      ocrEvidence: fixtureValue.evidence,
      ocrRenderManifest: fixtureValue.manifest,
      generationProvider: "anthropic",
      intent: "translate",
    }),
    (error) => error.code === "OCR_VISUAL_REVIEW_INPUT_MISMATCH",
  );
});

test("visual review batches every page with bounded requests and exact coverage", async () => {
  const fixtureValue = visualFixture(5);
  const previous = process.env.PDF_OCR_VISUAL_BATCH_PAGES;
  process.env.PDF_OCR_VISUAL_BATCH_PAGES = "2";
  const requested = [];
  try {
    const review = await buildVisualReview({
      sourcePdf: Buffer.from("visual-source-five-pages"),
      outputPdf: Buffer.from("visual-output-five-pages"),
      ocrEvidence: fixtureValue.evidence,
      ocrRenderManifest: fixtureValue.manifest,
      generationProvider: "anthropic",
      visualPageInspector: fixtureValue.inspector,
      visualPageRenderer: async (pdf, indices, options) => {
        requested.push({ role: options.role, indices: [...indices] });
        return fixtureValue.renderer(pdf, indices, options);
      },
      visualJudgeCaller: async (args) => {
        requested.push({ role: "judge", pages: args.request.pages.map((page) => page.page) });
        return passingVisualJudge(args);
      },
      resourceLimits: { runApi: (task) => task() },
    });
    assert.deepEqual(review.batches.map((batch) => batch.pages), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(review.pages.map((page) => page.page), [1, 2, 3, 4, 5]);
    assert.equal(requested.filter((entry) => entry.role === "judge").length, 3);
    assert.equal(requested.every((entry) => !entry.indices || entry.indices.length <= 2), true);
  } finally {
    if (previous == null) delete process.env.PDF_OCR_VISUAL_BATCH_PAGES;
    else process.env.PDF_OCR_VISUAL_BATCH_PAGES = previous;
  }
});

test("visual review rejects incomplete page render coverage before calling the judge", async () => {
  const fixtureValue = visualFixture(1);
  let judgeCalls = 0;
  await assert.rejects(
    () => buildVisualReview({
      sourcePdf: Buffer.from("visual-source-incomplete"),
      outputPdf: Buffer.from("visual-output-incomplete"),
      ocrEvidence: fixtureValue.evidence,
      ocrRenderManifest: fixtureValue.manifest,
      generationProvider: "anthropic",
      visualPageInspector: fixtureValue.inspector,
      visualPageRenderer: async (pdf, indices, options) => {
        const pages = await fixtureValue.renderer(pdf, indices, options);
        pages[0].tiles[0].bbox = [0, 0, 1, 0.5];
        return pages;
      },
      visualJudgeCaller: async () => { judgeCalls += 1; },
      resourceLimits: { runApi: (task) => task() },
    }),
    (error) => error.code === "OCR_VISUAL_REVIEW_RENDER_INVALID",
  );
  assert.equal(judgeCalls, 0);
});

test("a visual response cannot be replayed against a different output artifact", async () => {
  const fixtureValue = visualFixture(1);
  let captured = null;
  await buildVisualReview({
    sourcePdf: Buffer.from("visual-source-replay"),
    outputPdf: Buffer.from("visual-output-replay-a"),
    ocrEvidence: fixtureValue.evidence,
    ocrRenderManifest: fixtureValue.manifest,
    generationProvider: "anthropic",
    visualPageInspector: fixtureValue.inspector,
    visualPageRenderer: fixtureValue.renderer,
    visualJudgeCaller: async (args) => {
      captured = await passingVisualJudge(args);
      return captured;
    },
    resourceLimits: { runApi: (task) => task() },
  });
  await assert.rejects(
    () => buildVisualReview({
      sourcePdf: Buffer.from("visual-source-replay"),
      outputPdf: Buffer.from("visual-output-replay-b"),
      ocrEvidence: fixtureValue.evidence,
      ocrRenderManifest: fixtureValue.manifest,
      generationProvider: "anthropic",
      visualPageInspector: fixtureValue.inspector,
      visualPageRenderer: fixtureValue.renderer,
      visualJudgeCaller: async () => captured,
      resourceLimits: { runApi: (task) => task() },
    }),
    (error) => error.code === "OCR_VISUAL_REVIEW_RESPONSE_INVALID",
  );
});

test("visual batches split adaptively before provider upload when image budget is exceeded", async () => {
  const fixtureValue = visualFixture(2);
  const previousPages = process.env.PDF_OCR_VISUAL_BATCH_PAGES;
  const previousImages = process.env.PDF_OCR_VISUAL_MAX_IMAGES;
  process.env.PDF_OCR_VISUAL_BATCH_PAGES = "2";
  process.env.PDF_OCR_VISUAL_MAX_IMAGES = "2";
  let judgeCalls = 0;
  try {
    const result = await buildVisualReview({
      sourcePdf: Buffer.from("visual-source-over-budget"),
      outputPdf: Buffer.from("visual-output-over-budget"),
      ocrEvidence: fixtureValue.evidence,
      ocrRenderManifest: fixtureValue.manifest,
      generationProvider: "anthropic",
      visualPageInspector: fixtureValue.inspector,
      visualPageRenderer: fixtureValue.renderer,
      visualJudgeCaller: async (args) => {
        judgeCalls += 1;
        return passingVisualJudge(args);
      },
      resourceLimits: { runApi: (task) => task() },
    });
    assert.equal(judgeCalls, 2);
    assert.deepEqual(result.batches.map((batch) => batch.pages), [[1], [2]]);
  } finally {
    if (previousPages == null) delete process.env.PDF_OCR_VISUAL_BATCH_PAGES;
    else process.env.PDF_OCR_VISUAL_BATCH_PAGES = previousPages;
    if (previousImages == null) delete process.env.PDF_OCR_VISUAL_MAX_IMAGES;
    else process.env.PDF_OCR_VISUAL_MAX_IMAGES = previousImages;
  }
});

test("unsafe visual page geometry is rejected before either renderer allocates pixels", async () => {
  let rendererCalls = 0;
  const geometry = [{ index: 0, width: 100_000, height: 1000, rotation: 0 }];
  await assert.rejects(
    () => buildVisualReview({
      sourcePdf: Buffer.from("visual-source-unsafe-geometry"),
      outputPdf: Buffer.from("visual-output-unsafe-geometry"),
      ocrEvidence: { page_count: 1, evidence_sha256: "a".repeat(64) },
      ocrRenderManifest: { manifest_sha256: "b".repeat(64) },
      generationProvider: "anthropic",
      visualPageInspector: async () => geometry,
      visualPageRenderer: async () => {
        rendererCalls += 1;
        return [];
      },
      visualJudgeCaller: passingVisualJudge,
      resourceLimits: { runApi: (task) => task() },
    }),
    (error) => error.code === "OCR_VISUAL_REVIEW_RENDER_INVALID",
  );
  assert.equal(rendererCalls, 0);
});
