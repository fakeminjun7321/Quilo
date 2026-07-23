"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const {
  buildCanonicalOcrEvidence,
  ocrPdfToEvidenceStrict,
} = require("../../lib/pipelines/pdf-translate/mistral-ocr");
const {
  buildOcrRenderManifest,
  mergeOcrRenderManifests,
  mistralRiskVisualAdjudicator,
  prepareOcrModelInputs,
  prepareStrictScanOcr,
  validateOcrRenderManifest,
  validateRenderedAdjudicationPages,
} = require("../../lib/pipelines/pdf-translate/ocr-routing");
const {
  validateRetypesetOcrEvidence,
} = require("../../lib/pipelines/pdf-translate/provenance");
const {
  bindRetypesetOcrEvidence,
} = require("../../lib/pipelines/pdf-translate/latex-gen");
const {
  assertCanonicalOcrChunkSubset,
  finalizePdfTranslationOutput,
} = require("../../lib/pipelines/pdf-translate/orchestration-contract");
const {
  sha256Canonical,
} = require("../../lib/pipelines/pdf-translate/invariants");
const {
  verifyPdfTranslationPostflight,
} = require("../../lib/pipelines/pdf-translate/postflight");
const {
  buildVisualReview,
} = require("../../lib/pipelines/pdf-translate/ocr-semantic-review");

const SOURCE_PDF = Buffer.from("%PDF-1.7\nstrict-ocr-integration-source", "utf8");
const OUTPUT_PDF = Buffer.from("%PDF-1.7\nstrict-ocr-integration-output", "utf8");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAADICAIAAACRXtOWAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABqUlEQVR4nO3QoQEAAAiAMP9/Wl+QvmUSs7zNP8WswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArMCswKzArP07y9WDSH0xeOUAAAAASUVORK5CYII=",
  "base64",
);
const SOURCE_PAGES = [{ index: 0, width: 100, height: 200, rotation: 0 }];

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function imageBlock(buffer, mediaType = "image/png") {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: buffer.toString("base64"),
    },
  };
}

function rasterPages({
  width = 100,
  height = 200,
  rotation = 0,
  files = ["/tmp/p-000-00.png"],
  bboxes = [[0, 0, width, height]],
  pixelSizes = [[100, 200]],
} = {}) {
  return [{
    index: 0,
    width,
    height,
    rotation,
    tiles: files.map((file, index) => ({
      index,
      bbox: bboxes[index],
      width: pixelSizes[index][0],
      height: pixelSizes[index][1],
      file,
    })),
  }];
}

function providerResponse({ low = false } = {}) {
  const markdown = "Measurement 12 kg";
  return {
    id: "ocr-integration-request-1",
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1, doc_size_bytes: SOURCE_PDF.length },
    pages: [{
      index: 0,
      markdown,
      images: [],
      dimensions: { dpi: 200, width: 1000, height: 2000 },
      confidence_scores: {
        average_page_confidence_score: 0.99,
        minimum_page_confidence_score: low ? 0.5 : 0.99,
        word_confidence_scores: [
          { text: "Measurement", confidence: 0.99, start_index: 0 },
          { text: "12", confidence: low ? 0.5 : 0.99, start_index: 12 },
          { text: "kg", confidence: low ? 0.5 : 0.99, start_index: 15 },
        ],
      },
      blocks: [{
        type: "text",
        top_left_x: 50,
        top_left_y: 100,
        bottom_right_x: 950,
        bottom_right_y: 300,
        content: markdown,
      }],
    }],
  };
}

function multiPageProviderResponse(pageCount, { low = false } = {}) {
  return {
    id: "ocr-integration-multi-request-1",
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: pageCount, doc_size_bytes: SOURCE_PDF.length },
    pages: Array.from({ length: pageCount }, (_, index) => {
      const value = String(10 + index);
      const markdown = `Measurement ${value} kg`;
      return {
        index,
        markdown,
        images: [],
        dimensions: { dpi: 200, width: 1000, height: 2000 },
        confidence_scores: {
          average_page_confidence_score: 0.99,
          minimum_page_confidence_score: low ? 0.5 : 0.99,
          word_confidence_scores: [
            { text: "Measurement", confidence: 0.99, start_index: 0 },
            { text: value, confidence: low ? 0.5 : 0.99, start_index: 12 },
            { text: "kg", confidence: low ? 0.5 : 0.99, start_index: 12 + value.length + 1 },
          ],
        },
        blocks: [{
          type: "text",
          top_left_x: 50,
          top_left_y: 100,
          bottom_right_x: 950,
          bottom_right_y: 300,
          content: markdown,
        }],
      };
    }),
  };
}

async function buildPreparedManifest({
  sourcePdf = SOURCE_PDF,
  pageCount = 1,
  rasterFiles = ["/tmp/p-000-00.png"],
  rasterPages: pageGeometry = rasterPages(),
  tileBuffers = [PNG],
  pageOffset = 0,
  expectedLocalPages = 1,
  visualAdjudicationInputSha256 = null,
  transformOptions = { forceCompress: true },
} = {}) {
  const prepared = await prepareOcrModelInputs({
    rasterFiles,
    tileBuffers,
    transformOptions,
  });
  return {
    manifest: buildOcrRenderManifest({
      sourcePdf,
      pageCount,
      rasterFiles,
      rasterPages: pageGeometry,
      tileBuffers,
      modelInputBlocks: prepared.imageBlocks,
      modelInputProofs: prepared.modelInputProofs,
      pageOffset,
      expectedLocalPages,
      visualAdjudicationInputSha256,
    }),
    ...prepared,
  };
}

async function renderManifest({ visualAdjudicationInputSha256 = null } = {}) {
  return (await buildPreparedManifest({ visualAdjudicationInputSha256 })).manifest;
}

async function restoreVisualReview(evidence, manifest) {
  return buildVisualReview({
    sourcePdf: SOURCE_PDF,
    outputPdf: OUTPUT_PDF,
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    generationProvider: "anthropic",
    intent: "restore",
    visualPageInspector: async () => SOURCE_PAGES,
    visualPageRenderer: async (_pdf, indices) => indices.map((index) => ({
      index,
      source_width: 100,
      source_height: 200,
      tiles: [{
        index: 0,
        bbox: [0, 0, 100, 200],
        width: 100,
        height: 200,
        media_type: "image/png",
        image_sha256: sha(PNG),
        buffer: PNG,
      }],
    })),
    visualJudgeCaller: async ({ request }) => ({
      provider: "mistral",
      model: "mock-restore-visual-judge",
      request_id: "restore-visual-request-1",
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
    }),
    resourceLimits: { runApi: (task) => task() },
  });
}

function fetchResponse(payload) {
  return async () => ({
    status: 200,
    headers: {
      get: (name) => String(name).toLowerCase() === "x-request-id"
        ? "ocr-integration-http-request-1"
        : null,
    },
    text: async () => JSON.stringify(payload),
  });
}

function passingReport(intent = "translate") {
  const names = [
    "pdf_open", "source_pdf_open", "page_correspondence", "page_render",
    "blank_pages", "black_pages", "content_coverage", "page_order",
    "semantic_correspondence", "text_preservation", "raw_markers", "garbling",
    "untranslated_text", "number_preservation", "unit_preservation",
    "chemical_formula_preservation", "url_preservation", "image_duplicates",
    "image_preservation", "nontext_visual_preservation", "vector_provenance",
    "link_preservation",
  ];
  const gates = Object.fromEntries(names.map((name) => [name, {
    status: "pass",
    passed: true,
    hard: true,
    summary: "ok",
    details: {},
  }]));
  const skipped = intent === "restore"
    ? ["semantic_correspondence", "untranslated_text", "nontext_visual_preservation"]
    : ["text_preservation", "nontext_visual_preservation"];
  for (const name of skipped) {
    gates[name] = {
      status: "skip",
      passed: null,
      hard: true,
      summary: "not applicable",
      details: {},
    };
  }
  return {
    schema_version: 2,
    mode: "retypeset",
    intent,
    passed: true,
    hard_failures: [],
    exit_code: 0,
    gates,
  };
}

test("mock strict routing converts only canonical pages to ocrHint inputs and retains raw evidence", async () => {
  let received = null;
  const result = await prepareStrictScanOcr({
    pdfBuffer: SOURCE_PDF,
    hiddenOcrPageTexts: [{ page: 1, text: "untrusted hidden OCR" }],
    sourcePageInspector: async () => SOURCE_PAGES,
    ocrClient: async (buffer, options) => {
      received = { buffer, options };
      return buildCanonicalOcrEvidence(providerResponse(), {
        sourcePdf: buffer,
        sourcePages: options.sourcePages,
        hiddenOcrPageTexts: options.hiddenOcrPageTexts,
      });
    },
  });

  assert.equal(received.buffer, SOURCE_PDF);
  assert.deepEqual(received.options.sourcePages, SOURCE_PAGES);
  assert.deepEqual(result.pageTexts, [{ page: 1, text: "Measurement 12 kg" }]);
  assert.equal(result.evidence.pages[0].blocks[0].content, "Measurement 12 kg");
  assert.equal(JSON.stringify(result.evidence).includes("untrusted hidden OCR"), false);
});

test("visual adjudicator injection receives source PDF and exact rendered risk pages; absence fails closed", async () => {
  const ocrClient = (buffer, options) => ocrPdfToEvidenceStrict(buffer, {
    ...options,
    apiKey: "mock-key",
    fetchImpl: fetchResponse(providerResponse({ low: true })),
    sleepImpl: async () => {},
  });
  const visualPng = await sharp({
    create: { width: 100, height: 200, channels: 3, background: "white" },
  }).png().toBuffer();
  const renderCalls = [];
  const renderPageProvider = async (buffer, indices) => {
    renderCalls.push({ buffer, indices });
    return [{
      index: 0,
      source_width: 100,
      source_height: 200,
      tiles: [{
        index: 0,
        bbox: [0, 0, 100, 200],
        width: 100,
        height: 200,
        media_type: "image/png",
        image_sha256: sha(visualPng),
        buffer: visualPng,
      }],
    }];
  };
  const routed = await prepareStrictScanOcr({
    pdfBuffer: SOURCE_PDF,
    sourcePageInspector: async () => SOURCE_PAGES,
    renderPageProvider,
    ocrClient,
    visualAdjudicator: async (context) => {
      assert.equal(context.sourcePdf, SOURCE_PDF);
      assert.deepEqual(context.renderedPages.map((page) => page.index), [0]);
      assert.equal(context.renderedPages[0].tiles[0].buffer, visualPng);
      return {
        verdict: "pass",
        provider: "mock-vision",
        model: "mock-vision-v1",
        request_id: "mock-visual-request-1",
        input_digest: context.inputDigest,
        token_hashes: context.summary.risk_tokens
          .filter((token) => token.needs_visual_adjudication)
          .map((token) => token.token_sha256),
      };
    },
  });
  assert.equal(routed.evidence.visual_adjudication.verdict, "pass");
  assert.match(routed.visualAdjudicationInputSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    routed.evidence.visual_adjudication.input_digest,
    routed.visualAdjudicationInputSha256,
  );
  assert.deepEqual(renderCalls[0].indices, [0]);
  const visualManifest = await renderManifest({
    visualAdjudicationInputSha256: routed.visualAdjudicationInputSha256,
  });
  assert.equal(validateRetypesetOcrEvidence({
    ocrEvidence: routed.evidence,
    ocrRenderManifest: visualManifest,
    sourcePdf: SOURCE_PDF,
  }).renderManifest, visualManifest);
  const noVisualManifest = await renderManifest();
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: routed.evidence,
      ocrRenderManifest: noVisualManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_BINDING_MISMATCH",
  );
  const unrelatedDigestManifest = await renderManifest({
    visualAdjudicationInputSha256: sha(Buffer.from("unrelated visual input", "utf8")),
  });
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: routed.evidence,
      ocrRenderManifest: unrelatedDigestManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_BINDING_MISMATCH",
  );
  const tamperedEvidence = structuredClone(routed.evidence);
  tamperedEvidence.visual_adjudication.input_digest = sha(
    Buffer.from("tampered sealed visual input", "utf8"),
  );
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: tamperedEvidence,
      ocrRenderManifest: visualManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH",
  );
  const tamperedAdjudicator = structuredClone(routed.evidence);
  tamperedAdjudicator.visual_adjudication.model = "tampered-judge-model";
  const { evidence_sha256: oldAdjudicatorSeal, ...tamperedAdjudicatorUnsigned } =
    tamperedAdjudicator;
  void oldAdjudicatorSeal;
  tamperedAdjudicator.evidence_sha256 = sha256Canonical(tamperedAdjudicatorUnsigned);
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: tamperedAdjudicator,
      ocrRenderManifest: visualManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
  );
  const bothResealedEvidence = structuredClone(routed.evidence);
  bothResealedEvidence.visual_adjudication.input_digest = "f".repeat(64);
  const { evidence_sha256: previousSeal, ...unsignedEvidence } = bothResealedEvidence;
  void previousSeal;
  bothResealedEvidence.evidence_sha256 = sha256Canonical(unsignedEvidence);
  const bothResealedManifest = await renderManifest({
    visualAdjudicationInputSha256: "f".repeat(64),
  });
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: bothResealedEvidence,
      ocrRenderManifest: bothResealedManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH",
  );
  await assert.rejects(
    () => verifyPdfTranslationPostflight({
      originalBuffer: SOURCE_PDF,
      resultBuffer: OUTPUT_PDF,
      mode: "retypeset",
      intent: "restore",
      ocrEvidence: bothResealedEvidence,
      ocrRenderManifest: bothResealedManifest,
      requireOcrEvidence: true,
    }),
    (error) => (
      error.details.kind === "ocr_evidence_invalid" &&
      error.details.validation_code === "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH"
    ),
  );
  for (const mutateCommitment of [
    (commitment) => {
      commitment.rendered_pages[0].tiles[0].image_sha256 = "d".repeat(64);
    },
    (commitment) => {
      commitment.rendered_pages[0].tiles[0].width += 1;
    },
  ]) {
    const forgedEvidence = structuredClone(routed.evidence);
    mutateCommitment(forgedEvidence.visual_adjudication.input_commitment);
    const forgedInputDigest = sha256Canonical(
      forgedEvidence.visual_adjudication.input_commitment,
    );
    forgedEvidence.visual_adjudication.input_digest = forgedInputDigest;
    forgedEvidence.visual_adjudication.render_attestation.input_digest = forgedInputDigest;
    forgedEvidence.visual_adjudication.render_attestation.binding_hmac_sha256 = "e".repeat(64);
    const { evidence_sha256: oldSeal, ...forgedUnsigned } = forgedEvidence;
    void oldSeal;
    forgedEvidence.evidence_sha256 = sha256Canonical(forgedUnsigned);
    const forgedManifest = await renderManifest({
      visualAdjudicationInputSha256: forgedInputDigest,
    });
    assert.throws(
      () => validateRetypesetOcrEvidence({
        ocrEvidence: forgedEvidence,
        ocrRenderManifest: forgedManifest,
        sourcePdf: SOURCE_PDF,
      }),
      (error) => error.code === "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
    );
  }
  const deletedAttestationEvidence = structuredClone(routed.evidence);
  delete deletedAttestationEvidence.visual_adjudication.render_attestation;
  const { evidence_sha256: deletedProofSeal, ...deletedProofUnsigned } =
    deletedAttestationEvidence;
  void deletedProofSeal;
  deletedAttestationEvidence.evidence_sha256 = sha256Canonical(deletedProofUnsigned);
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: deletedAttestationEvidence,
      ocrRenderManifest: visualManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_RENDER_ATTESTATION_MISSING",
  );
  const missingEvidenceDigest = structuredClone(routed.evidence);
  delete missingEvidenceDigest.visual_adjudication.input_digest;
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: missingEvidenceDigest,
      ocrRenderManifest: visualManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_EVIDENCE_SCHEMA_INVALID",
  );
  await assert.rejects(
    () => verifyPdfTranslationPostflight({
      originalBuffer: SOURCE_PDF,
      resultBuffer: OUTPUT_PDF,
      mode: "retypeset",
      intent: "restore",
      ocrEvidence: routed.evidence,
      ocrRenderManifest: unrelatedDigestManifest,
      requireOcrEvidence: true,
    }),
    (error) => (
      error.details.kind === "ocr_evidence_invalid" &&
      error.details.validation_code === "OCR_VISUAL_ADJUDICATION_BINDING_MISMATCH"
    ),
  );

  await assert.rejects(
    () => prepareStrictScanOcr({
      pdfBuffer: SOURCE_PDF,
      sourcePageInspector: async () => SOURCE_PAGES,
      ocrClient,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_REQUIRED",
  );

  await assert.rejects(
    () => prepareStrictScanOcr({
      pdfBuffer: SOURCE_PDF,
      sourcePageInspector: async () => SOURCE_PAGES,
      renderPageProvider,
      ocrClient,
      visualAdjudicator: async (context) => ({
        verdict: "pass",
        provider: "mock-vision",
        model: "mock-vision-v1",
        request_id: "mock-visual-request-wrong-digest",
        input_digest: "0".repeat(64),
        token_hashes: context.summary.risk_tokens
          .filter((token) => token.needs_visual_adjudication)
          .map((token) => token.token_sha256),
      }),
    }),
    (error) => (
      error.code === "OCR_VISUAL_ADJUDICATION_ERROR" &&
      error.details.cause_code === "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH"
    ),
  );

  await assert.rejects(
    () => prepareStrictScanOcr({
      pdfBuffer: SOURCE_PDF,
      sourcePageInspector: async () => SOURCE_PAGES,
      renderPageProvider,
      ocrClient,
      visualAdjudicator: async (context) => {
        const tile = context.renderedPages[0].tiles[0];
        tile.buffer[tile.buffer.length - 1] ^= 1;
        return {
          verdict: "pass",
          provider: "mock-vision",
          model: "mock-vision-v1",
          request_id: "mock-visual-request-mutated-render",
          input_digest: context.inputDigest,
          token_hashes: context.summary.risk_tokens.map((token) => token.token_sha256),
        };
      },
    }),
    (error) => (
      error.code === "OCR_VISUAL_ADJUDICATION_ERROR" &&
      error.details.cause_code === "OCR_VISUAL_RENDER_INVALID"
    ),
  );
});

test("production OCR risk visual adjudicator binds exact low-confidence hashes", async () => {
  const tokenHash = sha(Buffer.from("84.20 mL"));
  const inputDigest = "a".repeat(64);
  const result = await mistralRiskVisualAdjudicator({
    summary: {
      risk_tokens: [{
        page_index: 0,
        block_order: 0,
        type: "number_unit",
        token_sha256: tokenHash,
        needs_visual_adjudication: true,
      }],
    },
    evidence: {
      pages: [{
        blocks: [{ order: 0, content: "Measurement 84.20 mL", bbox: [0, 0, 100, 40] }],
      }],
    },
    renderedPages: [{
      index: 0,
      tiles: [{ media_type: "image/png", buffer: PNG }],
    }],
    inputDigest,
    apiKey: "test-key",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.model, "mistral-medium-3-5");
      assert.match(request.messages[0].content[0].text, /84\.20 mL/);
      return {
        status: 200,
        ok: true,
        headers: { get: (name) => name === "x-request-id" ? "risk-judge-1" : null },
        async text() {
          return JSON.stringify({
            choices: [{
              message: {
                content: JSON.stringify({
                  verdict: "pass",
                  input_digest: inputDigest,
                  token_hashes: [tokenHash],
                }),
              },
            }],
          });
        },
      };
    },
    sleepImpl: async () => {},
  });
  assert.deepEqual(result, {
    verdict: "pass",
    provider: "mistral",
    model: "mistral-medium-3-5",
    request_id: "risk-judge-1",
    input_digest: inputDigest,
    token_hashes: [tokenHash],
  });
});

test("risk visual adjudication renders and judges long risky inputs in sealed byte-bounded batches", async () => {
  const pageCount = 5;
  const sourcePages = Array.from({ length: pageCount }, (_, index) => ({
    index,
    width: 100,
    height: 200,
    rotation: 0,
  }));
  const renderCalls = [];
  const judgeCalls = [];
  const routed = await prepareStrictScanOcr({
    pdfBuffer: SOURCE_PDF,
    sourcePageInspector: async () => sourcePages,
    visualBatchLimits: { pages: 2, tiles: 2, bytes: PNG.length, tokens: 1 },
    renderPageProvider: async (_buffer, indices) => {
      renderCalls.push([...indices]);
      return indices.map((index) => ({
        index,
        source_width: 100,
        source_height: 200,
        tiles: [{
          index: 0,
          bbox: [0, 0, 100, 200],
          width: 100,
          height: 200,
          media_type: "image/png",
          image_sha256: sha(PNG),
          buffer: PNG,
        }],
      }));
    },
    ocrClient: (buffer, options) => ocrPdfToEvidenceStrict(buffer, {
      ...options,
      apiKey: "mock-key",
      fetchImpl: fetchResponse(multiPageProviderResponse(pageCount, { low: true })),
      sleepImpl: async () => {},
    }),
    visualAdjudicator: async (context) => {
      const indices = context.renderedPages.map((page) => page.index);
      assert.ok(context.summary.risk_tokens.length <= 1);
      judgeCalls.push(indices);
      context.adjudicationInput.rendered_pages[0].tiles[0].image_sha256 = "e".repeat(64);
      return {
        verdict: "pass",
        provider: "mock-vision",
        model: "mock-vision-v1",
        request_id: `mock-visual-${judgeCalls.length}`,
        input_digest: context.inputDigest,
        token_hashes: [...new Set(context.summary.risk_tokens.map(
          (token) => token.token_sha256,
        ))],
      };
    },
  });

  assert.deepEqual(renderCalls, [[0, 1], [0], [1], [2, 3], [2], [3], [4]]);
  assert.ok(judgeCalls.every((indices) => indices.length === 1));
  assert.deepEqual(
    [...new Set(judgeCalls.flat())].sort((left, right) => left - right),
    [0, 1, 2, 3, 4],
  );
  assert.match(routed.evidence.visual_adjudication.request_id, /^batch-[a-f0-9]{64}$/);
  assert.deepEqual(
    routed.evidence.visual_adjudication.input_commitment.rendered_pages.map((page) => page.index),
    [0, 1, 2, 3, 4],
  );
  assert.ok(routed.evidence.visual_adjudication.input_commitment.rendered_pages.every(
    (page) => page.tiles.every((tile) => tile.image_sha256 === sha(PNG)),
  ));
  assert.equal(
    routed.evidence.visual_adjudication.input_digest,
    routed.visualAdjudicationInputSha256,
  );
});

test("visual adjudication digest is absent on both canonical evidence and manifest when no risk exists", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  assert.equal(evidence.needs_visual_adjudication, false);
  assert.equal(Object.prototype.hasOwnProperty.call(evidence, "visual_adjudication"), false);
  assert.equal(validateRetypesetOcrEvidence({
    ocrEvidence: evidence,
    ocrRenderManifest: await renderManifest(),
    sourcePdf: SOURCE_PDF,
  }).renderManifest.visual_adjudication_input_sha256, null);

  const staleManifest = await renderManifest({
    visualAdjudicationInputSha256: sha(Buffer.from("stale visual input", "utf8")),
  });
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: evidence,
      ocrRenderManifest: staleManifest,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_VISUAL_ADJUDICATION_BINDING_MISMATCH",
  );
});

test("large OCR chunk boundary rejects every non-canonical reported subset field", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  const manifest = await renderManifest();
  const canonicalSubset = validateRetypesetOcrEvidence({
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    sourcePdf: SOURCE_PDF,
    expectedPageIndices: [0],
  }).subset;
  assert.deepEqual(
    assertCanonicalOcrChunkSubset({
      reportedSubset: structuredClone(canonicalSubset),
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      sourcePdf: SOURCE_PDF,
      expectedPageIndices: [0],
      chunk: 1,
    }),
    canonicalSubset,
  );

  const reseal = (subset) => {
    const unsigned = structuredClone(subset);
    delete unsigned.subset_sha256;
    subset.subset_sha256 = sha256Canonical(unsigned);
    return subset;
  };
  const mutations = [
    ["subset_sha256", (subset) => { subset.subset_sha256 = "0".repeat(64); }],
    ["unexpected key", (subset) => { subset.unexpected = true; reseal(subset); }],
    ["missing key", (subset) => { delete subset.page_range; reseal(subset); }],
    ["page text hash", (subset) => { subset.pages[0].text_sha256 = "1".repeat(64); reseal(subset); }],
    ["block hash", (subset) => { subset.pages[0].block_hashes[0] = "2".repeat(64); reseal(subset); }],
    ["page range", (subset) => { subset.page_range.end += 1; reseal(subset); }],
    ["source evidence seal", (subset) => {
      subset.source_evidence_sha256 = "3".repeat(64);
      reseal(subset);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const reportedSubset = structuredClone(canonicalSubset);
    mutate(reportedSubset);
    assert.throws(
      () => assertCanonicalOcrChunkSubset({
        reportedSubset,
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        sourcePdf: SOURCE_PDF,
        expectedPageIndices: [0],
        chunk: 1,
      }),
      (error) => {
        assert.equal(error.details.kind, "ocr_chunk_evidence_mismatch", label);
        assert.equal(error.details.chunk, 1, label);
        return true;
      },
    );
  }

  assert.throws(
    () => assertCanonicalOcrChunkSubset({
      reportedSubset: canonicalSubset,
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      sourcePdf: SOURCE_PDF,
      expectedPageIndices: [1],
      chunk: 1,
    }),
    (error) => error.details.kind === "ocr_chunk_evidence_mismatch",
  );
});

test("latex binding, provenance and terminal finalizer carry the same evidence without raw summary leakage", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  const preparedManifest = await buildPreparedManifest();
  const { manifest, imageBlocks } = preparedManifest;
  const binding = bindRetypesetOcrEvidence({
    pdfBuffer: SOURCE_PDF,
    useImages: true,
    imageBlocks,
    rawTileBuffers: [PNG],
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
  });
  assert.equal(binding.evidence, evidence);
  assert.equal(
    validateRetypesetOcrEvidence({
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      sourcePdf: SOURCE_PDF,
    }).evidence,
    evidence,
  );

  let postflightArgs = null;
  const semanticReview = { schema_version: 1, task: "test-review-forwarding" };
  const terminal = await finalizePdfTranslationOutput({
    originalBuffer: SOURCE_PDF,
    resultBuffer: OUTPUT_PDF,
    effectiveMode: "retypeset",
    ocrEvidence: evidence,
    ocrRenderManifest: manifest,
    ocrSemanticReviewContext: {
      generationProvider: "anthropic",
      generationModel: "mock-translator",
      generationRequestId: "translation-request-integration-1",
    },
    ocrSemanticReviewBuilder: async () => semanticReview,
    requireOcrEvidence: true,
    postflightVerifier: async (options) => {
      postflightArgs = options;
      return { passed: true, mode: "retypeset", intent: "translate" };
    },
  });
  assert.equal(postflightArgs.ocrEvidence, evidence);
  assert.equal(postflightArgs.ocrRenderManifest, manifest);
  assert.equal(postflightArgs.ocrSemanticReview, semanticReview);
  assert.equal(postflightArgs.requireOcrEvidence, true);
  assert.equal(terminal.buffer, OUTPUT_PDF);
});

test("render manifest seals raw PNG and exact post-compression model input independently", async () => {
  const rawPng = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: "#eeeeee" },
  }).png().toBuffer();
  const prepared = await buildPreparedManifest({
    tileBuffers: [rawPng],
    rasterPages: rasterPages({
      width: 2400,
      height: 1200,
      bboxes: [[0, 0, 2400, 1200]],
      pixelSizes: [[2400, 1200]],
    }),
  });
  const { manifest, imageBlocks } = prepared;
  const modelJpeg = Buffer.from(imageBlocks[0].source.data, "base64");
  const tile = manifest.pages[0].tiles[0];
  assert.equal(tile.raw.image_sha256, sha(rawPng));
  assert.equal(tile.raw.media_type, "image/png");
  assert.equal(tile.model_input.image_sha256, sha(modelJpeg));
  assert.equal(tile.model_input.media_type, "image/jpeg");
  assert.equal(tile.model_input.width, 2200);
  assert.equal(tile.model_input.height, 1100);
  assert.notEqual(tile.raw.image_sha256, tile.model_input.image_sha256);
  assert.equal(tile.transform.transform_id, "anthropic-media.prepare-image.v1");

  assert.equal(validateOcrRenderManifest(manifest, {
    sourcePdf: SOURCE_PDF,
    pageCount: 1,
    rawTileBuffers: [rawPng],
    modelInputBlocks: imageBlocks,
  }), manifest);
  assert.throws(
    () => validateOcrRenderManifest(manifest, {
      sourcePdf: SOURCE_PDF,
      pageCount: 1,
      rawTileBuffers: [rawPng],
      modelInputBlocks: [imageBlock(PNG)],
    }),
    (error) => error.code === "OCR_RENDER_MODEL_INPUT_MISMATCH",
  );
});

test("render manifest rejects same-size raw/model swaps, metadata resealing, and transform option drift", async () => {
  const white = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  }).png().toBuffer();
  const black = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "black" },
  }).png().toBuffer();
  const files = ["/tmp/p-000-00.png", "/tmp/p-000-01.png"];
  const pages = rasterPages({
    width: 100,
    height: 200,
    files,
    bboxes: [[0, 0, 100, 100], [0, 100, 100, 200]],
    pixelSizes: [[100, 100], [100, 100]],
  });
  const prepared = await prepareOcrModelInputs({
    rasterFiles: files,
    tileBuffers: [white, black],
    transformOptions: { forceCompress: true },
  });
  const manifest = buildOcrRenderManifest({
    sourcePdf: SOURCE_PDF,
    pageCount: 1,
    rasterFiles: files,
    rasterPages: pages,
    tileBuffers: [white, black],
    modelInputBlocks: prepared.imageBlocks,
    modelInputProofs: prepared.modelInputProofs,
    expectedLocalPages: 1,
  });
  assert.notEqual(
    manifest.pages[0].tiles[0].model_input.image_sha256,
    manifest.pages[0].tiles[1].model_input.image_sha256,
  );

  assert.throws(
    () => buildOcrRenderManifest({
      sourcePdf: SOURCE_PDF,
      pageCount: 1,
      rasterFiles: files,
      rasterPages: pages,
      tileBuffers: [white, black],
      modelInputBlocks: [...prepared.imageBlocks].reverse(),
      modelInputProofs: prepared.modelInputProofs,
      expectedLocalPages: 1,
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_PROOF",
  );
  assert.throws(
    () => buildOcrRenderManifest({
      sourcePdf: SOURCE_PDF,
      pageCount: 1,
      rasterFiles: files,
      rasterPages: pages,
      tileBuffers: [black, white],
      modelInputBlocks: prepared.imageBlocks,
      modelInputProofs: prepared.modelInputProofs,
      expectedLocalPages: 1,
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_PROOF",
  );

  const resealedSwap = structuredClone(manifest);
  const [first, second] = resealedSwap.pages[0].tiles;
  [first.model_input, second.model_input] = [second.model_input, first.model_input];
  [first.transform, second.transform] = [second.transform, first.transform];
  const { manifest_sha256: _oldSeal, ...unsignedSwap } = resealedSwap;
  resealedSwap.manifest_sha256 = sha256Canonical(unsignedSwap);
  assert.throws(
    () => validateOcrRenderManifest(resealedSwap, {
      sourcePdf: SOURCE_PDF,
      pageCount: 1,
      rawTileBuffers: [white, black],
      modelInputBlocks: [...prepared.imageBlocks].reverse(),
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_PROOF",
  );

  await assert.rejects(
    () => prepareOcrModelInputs({
      rasterFiles: files,
      tileBuffers: [white, black],
      transformOptions: { forceCompress: false },
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_OPTIONS",
  );

  const resealedOptions = structuredClone(manifest);
  resealedOptions.pages[0].tiles[0].transform.options = { force_compress: false };
  const { manifest_sha256: _oldOptionsSeal, ...unsignedOptions } = resealedOptions;
  resealedOptions.manifest_sha256 = sha256Canonical(unsignedOptions);
  assert.throws(
    () => validateOcrRenderManifest(resealedOptions, {
      sourcePdf: SOURCE_PDF,
      pageCount: 1,
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_PROOF",
  );
});

test("render manifest proves exact page geometry and rejects tile gaps, overlaps, swaps, and aspect drift", async () => {
  const top = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  }).png().toBuffer();
  const bottom = await sharp({
    create: { width: 100, height: 200, channels: 3, background: "#dddddd" },
  }).png().toBuffer();
  const files = ["/tmp/p-000-00.png", "/tmp/p-000-01.png"];
  const validPages = rasterPages({
    width: 100,
    height: 300,
    files,
    bboxes: [[0, 0, 100, 100], [0, 100, 100, 300]],
    pixelSizes: [[100, 100], [100, 200]],
  });
  const build = ({
    pages = validPages,
    rasterFiles = files,
    raw = [top, bottom],
  } = {}) => buildPreparedManifest({
    rasterFiles,
    rasterPages: pages,
    tileBuffers: raw,
  });

  const { manifest } = await build();
  assert.deepEqual(
    manifest.pages[0],
    {
      index: 0,
      width: 100,
      height: 300,
      rotation: 0,
      tile_count: 2,
      tiles: manifest.pages[0].tiles,
    },
  );
  assert.deepEqual(manifest.pages[0].tiles.map((tile) => tile.bbox), [
    [0, 0, 100, 100],
    [0, 100, 100, 300],
  ]);

  for (const [name, bboxes] of [
    ["gap", [[0, 0, 100, 100], [0, 101, 100, 300]]],
    ["overlap", [[0, 0, 100, 100], [0, 99, 100, 300]]],
    ["duplicate", [[0, 0, 100, 100], [0, 0, 100, 100]]],
  ]) {
    const pages = rasterPages({
      width: 100,
      height: 300,
      files,
      bboxes,
      pixelSizes: [[100, 100], [100, 200]],
    });
    await assert.rejects(
      () => build({ pages }),
      (error) => ["OCR_RENDER_TILE_COVERAGE", "OCR_RENDER_TILE_GEOMETRY"].includes(error.code),
      name,
    );
  }

  const invalidRotation = structuredClone(validPages);
  invalidRotation[0].rotation = 45;
  await assert.rejects(
    () => build({ pages: invalidRotation }),
    (error) => error.code === "OCR_RENDER_PAGE_GEOMETRY",
  );
  await assert.rejects(
    () => build({ rasterFiles: [...files].reverse() }),
    (error) => error.code === "OCR_RENDER_TILE_COVERAGE",
  );

  const wrongBounds = rasterPages({
    width: 100,
    height: 300,
    files,
    bboxes: [[1, 0, 100, 100], [0, 100, 100, 300]],
    pixelSizes: [[100, 100], [100, 200]],
  });
  await assert.rejects(
    () => build({ pages: wrongBounds }),
    (error) => error.code === "OCR_RENDER_TILE_GEOMETRY",
  );

  const wrongAspect = rasterPages({
    width: 100,
    height: 300,
    files,
    bboxes: [[0, 0, 100, 150], [0, 150, 100, 300]],
    pixelSizes: [[100, 100], [100, 200]],
  });
  await assert.rejects(
    () => build({ pages: wrongAspect }),
    (error) => error.code === "OCR_RENDER_TILE_ASPECT_MISMATCH",
  );
});

test("OCR provenance rejects otherwise sealed raster page geometry or rotation from another source", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  const { manifest: wrongGeometry } = await buildPreparedManifest({
    rasterPages: rasterPages({ width: 50, height: 100, bboxes: [[0, 0, 50, 100]] }),
  });
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: evidence,
      ocrRenderManifest: wrongGeometry,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_RENDER_SOURCE_GEOMETRY_MISMATCH",
  );

  const wrongRotationPages = rasterPages();
  wrongRotationPages[0].rotation = 90;
  const { manifest: wrongRotation } = await buildPreparedManifest({
    rasterPages: wrongRotationPages,
  });
  assert.throws(
    () => validateRetypesetOcrEvidence({
      ocrEvidence: evidence,
      ocrRenderManifest: wrongRotation,
      sourcePdf: SOURCE_PDF,
    }),
    (error) => error.code === "OCR_RENDER_SOURCE_GEOMETRY_MISMATCH",
  );
});

test("chunk manifest merge validates every partial seal and exact global page coverage", async () => {
  const { manifest: first } = await buildPreparedManifest({
    pageCount: 2,
    pageOffset: 0,
  });
  const { manifest: second } = await buildPreparedManifest({
    pageCount: 2,
    pageOffset: 1,
  });
  const merged = mergeOcrRenderManifests({
    sourcePdf: SOURCE_PDF,
    pageCount: 2,
    manifests: [first, second],
  });
  assert.deepEqual(merged.pages.map((page) => page.index), [0, 1]);
  assert.deepEqual(merged.page_range, { start: 0, end: 1 });

  assert.throws(
    () => mergeOcrRenderManifests({
      sourcePdf: SOURCE_PDF,
      pageCount: 2,
      manifests: [second, first],
    }),
    (error) => error.code === "OCR_RENDER_PAGE_COVERAGE",
  );

  const tampered = structuredClone(first);
  tampered.pages[0].tiles[0].raw.image_sha256 = "0".repeat(64);
  assert.throws(
    () => mergeOcrRenderManifests({
      sourcePdf: SOURCE_PDF,
      pageCount: 2,
      manifests: [tampered, second],
    }),
    (error) => error.code === "OCR_RENDER_TRANSFORM_PROOF",
  );
});

test("visual adjudication render validation rejects gaps and claimed dimensions that differ from bytes", async () => {
  const top = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "white" },
  }).png().toBuffer();
  const bottom = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#eeeeee" },
  }).png().toBuffer();
  const page = {
    index: 0,
    source_width: 100,
    source_height: 200,
    tiles: [
      { index: 0, bbox: [0, 0, 100, 100], width: 100, height: 100, media_type: "image/png", image_sha256: sha(top), buffer: top },
      { index: 1, bbox: [0, 100, 100, 200], width: 100, height: 100, media_type: "image/png", image_sha256: sha(bottom), buffer: bottom },
    ],
  };
  assert.equal(validateRenderedAdjudicationPages([page], [0], SOURCE_PAGES).length, 1);

  const gap = {
    ...page,
    tiles: page.tiles.map((tile, index) => ({
      ...tile,
      bbox: index === 1 ? [0, 120, 100, 200] : [...tile.bbox],
    })),
  };
  assert.throws(
    () => validateRenderedAdjudicationPages([gap], [0], SOURCE_PAGES),
    (error) => error.code === "OCR_VISUAL_RENDER_COVERAGE",
  );
  const wrongDimensions = {
    ...page,
    tiles: page.tiles.map((tile, index) => ({
      ...tile,
      width: index === 0 ? 99 : tile.width,
      bbox: [...tile.bbox],
    })),
  };
  assert.throws(
    () => validateRenderedAdjudicationPages([wrongDimensions], [0], SOURCE_PAGES),
    (error) => error.code === "OCR_VISUAL_RENDER_INVALID",
  );
});

test("real postflight boundary revalidates OCR provenance before its injected verifier process", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  const manifest = await renderManifest();
  const visualReview = await restoreVisualReview(evidence, manifest);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-postflight-integration-"));
  const python = path.join(root, "python3");
  const report = JSON.stringify(passingReport("restore"));
  fs.writeFileSync(
    python,
    "#!/bin/sh\n" +
      "previous=''\n" +
      "for arg in \"$@\"; do if [ \"$previous\" = '--json' ]; then report_path=\"$arg\"; fi; previous=\"$arg\"; done\n" +
      `cat > \"$report_path\" <<'REPORT'\n${report}\nREPORT\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = python;
  try {
    const result = await verifyPdfTranslationPostflight({
      originalBuffer: SOURCE_PDF,
      resultBuffer: OUTPUT_PDF,
      mode: "retypeset",
      intent: "restore",
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      ocrRestoreVisualReview: visualReview,
      ocrGenerationProvider: "anthropic",
      requireOcrEvidence: true,
      tempRoot: root,
    });
    assert.equal(result.passed, true);
    const summary = JSON.stringify(result.ocr_evidence_summary);
    assert.equal(summary.includes("Measurement 12 kg"), false);
    assert.match(summary, /[a-f0-9]{64}/);
    assert.equal(
      result.ocr_restore_visual_review_summary.output_pdf_sha256,
      sha(OUTPUT_PDF),
    );

    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: SOURCE_PDF,
        resultBuffer: OUTPUT_PDF,
        mode: "retypeset",
        intent: "restore",
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        requireOcrEvidence: true,
        tempRoot: root,
      }),
      (error) => error.details.kind === "ocr_restore_visual_review_missing",
    );

    const missingAttestation = structuredClone(visualReview);
    delete missingAttestation.judge_attestation;
    {
      const unsigned = { ...missingAttestation };
      delete unsigned.review_sha256;
      missingAttestation.review_sha256 = sha256Canonical(unsigned);
    }
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: SOURCE_PDF,
        resultBuffer: OUTPUT_PDF,
        mode: "retypeset",
        intent: "restore",
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        ocrRestoreVisualReview: missingAttestation,
        ocrGenerationProvider: "anthropic",
        requireOcrEvidence: true,
        tempRoot: root,
      }),
      (error) => error.details.kind === "ocr_restore_visual_review_invalid",
    );

    const forgedMetadata = structuredClone(visualReview);
    forgedMetadata.provider = "fake-independent-provider";
    forgedMetadata.model = "fake-visual-model";
    forgedMetadata.request_id = "fake-visual-request";
    forgedMetadata.batches[0].request_id = "fake-visual-request";
    {
      const unsigned = { ...forgedMetadata };
      delete unsigned.review_sha256;
      forgedMetadata.review_sha256 = sha256Canonical(unsigned);
    }
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: SOURCE_PDF,
        resultBuffer: OUTPUT_PDF,
        mode: "retypeset",
        intent: "restore",
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        ocrRestoreVisualReview: forgedMetadata,
        ocrGenerationProvider: "anthropic",
        requireOcrEvidence: true,
        tempRoot: root,
      }),
      (error) => error.details.kind === "ocr_restore_visual_review_invalid",
    );

    for (const field of [
      "no_missing_figures",
      "no_added_figures",
      "all_source_text_covered",
      "no_added_text",
    ]) {
      const rejectedReview = structuredClone(visualReview);
      rejectedReview.pages[0][field] = false;
      const unsigned = { ...rejectedReview };
      delete unsigned.review_sha256;
      rejectedReview.review_sha256 = sha256Canonical(unsigned);
      await assert.rejects(
        () => verifyPdfTranslationPostflight({
          originalBuffer: SOURCE_PDF,
          resultBuffer: OUTPUT_PDF,
          mode: "retypeset",
          intent: "restore",
          ocrEvidence: evidence,
          ocrRenderManifest: manifest,
          ocrRestoreVisualReview: rejectedReview,
          ocrGenerationProvider: "anthropic",
          requireOcrEvidence: true,
          tempRoot: root,
        }),
        (error) => error.details.kind === "ocr_restore_visual_review_invalid",
        field,
      );
    }

    const swappedOutputReview = structuredClone(visualReview);
    swappedOutputReview.output_pdf_sha256 = sha(Buffer.from("different output"));
    {
      const unsigned = { ...swappedOutputReview };
      delete unsigned.review_sha256;
      swappedOutputReview.review_sha256 = sha256Canonical(unsigned);
    }
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: SOURCE_PDF,
        resultBuffer: OUTPUT_PDF,
        mode: "retypeset",
        intent: "restore",
        ocrEvidence: evidence,
        ocrRenderManifest: manifest,
        ocrRestoreVisualReview: swappedOutputReview,
        ocrGenerationProvider: "anthropic",
        requireOcrEvidence: true,
        tempRoot: root,
      }),
      (error) => error.details.kind === "ocr_restore_visual_review_invalid",
    );

    const tampered = structuredClone(evidence);
    tampered.pages[0].blocks[0].content = "tampered raw OCR";
    await assert.rejects(
      () => verifyPdfTranslationPostflight({
        originalBuffer: SOURCE_PDF,
        resultBuffer: OUTPUT_PDF,
        mode: "retypeset",
        intent: "restore",
        ocrEvidence: tampered,
        ocrRenderManifest: manifest,
        ocrRestoreVisualReview: visualReview,
        ocrGenerationProvider: "anthropic",
        requireOcrEvidence: true,
        tempRoot: root,
      }),
      (error) => error.details.kind === "ocr_evidence_invalid",
    );
  } finally {
    if (previous == null) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("OCR translation postflight fails closed before verifier when independent review is absent", async () => {
  const evidence = buildCanonicalOcrEvidence(providerResponse(), {
    sourcePdf: SOURCE_PDF,
    sourcePages: SOURCE_PAGES,
  });
  const manifest = await renderManifest();
  await assert.rejects(
    () => verifyPdfTranslationPostflight({
      originalBuffer: SOURCE_PDF,
      resultBuffer: OUTPUT_PDF,
      mode: "retypeset",
      intent: "translate",
      ocrEvidence: evidence,
      ocrRenderManifest: manifest,
      requireOcrEvidence: true,
    }),
    (error) => {
      assert.equal(error.details.kind, "ocr_semantic_review_missing");
      assert.deepEqual(error.details.hard_failures, ["semantic_correspondence"]);
      return true;
    },
  );
});

test("both HTTP entrypoints route scans through strict OCR and forward evidence to terminal postflight", () => {
  const root = path.resolve(__dirname, "../..");
  for (const filename of ["server.js", "translate-server.js"]) {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    assert.match(source, /prepareStrictScanOcr\s*\(/);
    assert.match(source, /ocrEvidence:\s*result\.ocrEvidence/);
    assert.match(source, /ocrRenderManifest:\s*result\.ocrRenderManifest/);
    assert.doesNotMatch(source, /ocrSemanticReview:\s*result\.ocrSemanticReview/);
    assert.match(source, /ocrSemanticReviewContext:/);
    assert.match(source, /requireOcrEvidence:\s*!!routing\.scanned/);
  }
});

test("both HTTP entrypoints reject over-budget scans before any strict OCR provider call", () => {
  const root = path.resolve(__dirname, "../..");
  for (const filename of ["server.js", "translate-server.js"]) {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    const start = source.indexOf("async function prepareScannedRouting");
    const end = source.indexOf("\n}\n", start);
    const routingSource = source.slice(start, end > start ? end + 3 : source.length);
    const firstCoverageGate = routingSource.indexOf("assertPdfTranslationInputCoverage");
    const strictOcrCall = routingSource.indexOf("prepareStrictScanOcr");
    assert.ok(firstCoverageGate >= 0, `${filename}: missing pre-OCR page gate`);
    assert.ok(strictOcrCall >= 0, `${filename}: missing strict OCR call`);
    assert.ok(firstCoverageGate < strictOcrCall, `${filename}: page gate must run before OCR upload`);
  }
});
