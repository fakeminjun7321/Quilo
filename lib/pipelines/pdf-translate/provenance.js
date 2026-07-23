// Fail-closed provenance primitives for retypeset PDF translation.
//
// The sealed evidence contains hashes and structural identifiers only.  Raw
// source/target text is used transiently to create segment hashes and the
// independent-judge input digest, but is deliberately excluded from the
// evidence schema.

const {
  assertSha256,
  canonicalInvariantManifest,
  canonicalJson,
  maskInvariants,
  normalizeText,
  restoreInvariantLiterals,
  sha256Canonical,
  sha256Hex,
} = require("./invariants");
const {
  summarizeOcrEvidence,
  validateCanonicalOcrEvidence,
} = require("./mistral-ocr");
const {
  validateOcrRenderManifest,
  validateVisualRenderAttestation,
} = require("./ocr-routing");

const EVIDENCE_SCHEMA_VERSION = 1;
const EVIDENCE_TYPE = "pdf-retypeset-provenance";
const MAX_INDEX = 9999;

const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "evidence_type",
  "source_pdf_sha256",
  "output_pdf_sha256",
  "layout_template_sha256",
  "segments",
  "figures",
  "translation",
  "judge",
  "evidence_sha256",
]);
const SEGMENT_KEYS = Object.freeze([
  "segment_id",
  "kind",
  "page",
  "order",
  "source_sha256",
  "invariant_manifest_sha256",
  "invariant_count",
  "target_sha256",
  "binding_sha256",
]);
const FIGURE_KEYS = Object.freeze([
  "occurrence_id",
  "page",
  "order",
  "source_sha256",
  "output_sha256",
  "binding_sha256",
]);
const TRANSLATION_KEYS = Object.freeze(["provider", "model", "request_id"]);
const JUDGE_KEYS = Object.freeze(["provider", "model", "request_id", "input_digest", "items"]);
const JUDGE_ITEM_KEYS = Object.freeze([
  "segment_id",
  "source_sha256",
  "target_sha256",
  "verdict",
]);

class ProvenanceValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProvenanceValidationError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ProvenanceValidationError(code, message, details);
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertExactKeys(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PROVENANCE_SCHEMA_INVALID", `${path} must be an object`, { path });
  }
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("PROVENANCE_SCHEMA_INVALID", `${path} has missing or unexpected fields`, {
      path,
      missing: expected.filter((key) => !actual.includes(key)),
      unexpected: actual.filter((key) => !expected.includes(key)),
    });
  }
}

function assertIndex(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INDEX) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_INDEX}`);
  }
  return value;
}

function assertKind(value) {
  const kind = String(value || "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) {
    throw new TypeError("kind must be a lowercase ASCII identifier");
  }
  return kind;
}

function assertNonEmptyIdentifier(value, name) {
  const result = String(value || "").trim();
  // Actor fields are opaque identifiers, never prose.  Restricting them to a
  // compact ASCII token alphabet prevents an accidental source/target passage
  // from being persisted through provider/model/request metadata.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/.test(result)) {
    fail("PROVENANCE_SCHEMA_INVALID", `${name} must be an opaque ASCII identifier`, { field: name });
  }
  return result;
}

function assertCanonicalSha(value, name) {
  const normalized = assertSha256(value, name);
  if (value !== normalized) {
    fail("PROVENANCE_SCHEMA_INVALID", `${name} must use canonical lowercase SHA-256 hex`, {
      field: name,
    });
  }
  return normalized;
}

function hashArtifact(value, name = "artifact") {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array) || value.byteLength < 1) {
    throw new TypeError(`${name} must be a non-empty Buffer or Uint8Array`);
  }
  return sha256Hex(value);
}

function stableSegmentId(documentSha256, page, order) {
  const digest = assertSha256(documentSha256, "documentSha256");
  const pageNumber = assertIndex(page, "page");
  const orderNumber = assertIndex(order, "order");
  return `seg-${digest.slice(0, 12)}-p${String(pageNumber).padStart(4, "0")}-o${String(orderNumber).padStart(4, "0")}`;
}

function stableFigureOccurrenceId(documentSha256, page, order) {
  const digest = assertSha256(documentSha256, "documentSha256");
  const pageNumber = assertIndex(page, "page");
  const orderNumber = assertIndex(order, "order");
  return `fig-${digest.slice(0, 12)}-p${String(pageNumber).padStart(4, "0")}-o${String(orderNumber).padStart(4, "0")}`;
}

function sourceSegmentDigest({ sourceText, kind, page, order, invariantManifest }) {
  const sortedManifest = canonicalInvariantManifest(invariantManifest);
  return sha256Canonical({
    invariant_manifest: sortedManifest,
    kind,
    order,
    page,
    source_text: normalizeText(sourceText, "sourceText"),
  });
}

function prepareSourceSegment({ documentSha256, page, order, kind = "paragraph", sourceText }) {
  const documentDigest = assertSha256(documentSha256, "documentSha256");
  const pageNumber = assertIndex(page, "page");
  const orderNumber = assertIndex(order, "order");
  const segmentKind = assertKind(kind);
  const normalizedSource = normalizeText(sourceText, "sourceText");
  if (!normalizedSource.trim()) throw new TypeError("sourceText must not be empty");
  const segmentId = stableSegmentId(documentDigest, pageNumber, orderNumber);
  const mask = maskInvariants(normalizedSource, {
    documentSha256: documentDigest,
    kind: segmentKind,
    page: pageNumber,
    order: orderNumber,
  });
  const source = {
    segment_id: segmentId,
    kind: segmentKind,
    page: pageNumber,
    order: orderNumber,
    source_sha256: sourceSegmentDigest({
      sourceText: normalizedSource,
      kind: segmentKind,
      page: pageNumber,
      order: orderNumber,
      invariantManifest: mask.manifest,
    }),
    invariant_manifest_sha256: mask.manifestSha256,
    invariant_count: mask.entries.length,
  };
  return {
    source,
    masked_text: mask.maskedText,
    mask,
  };
}

function segmentBindingDigest(segment) {
  return sha256Canonical({
    invariant_manifest_sha256: segment.invariant_manifest_sha256,
    segment_id: segment.segment_id,
    source_sha256: segment.source_sha256,
    target_sha256: segment.target_sha256,
  });
}

function bindTargetSegment(prepared, targetText) {
  if (!prepared || !prepared.source || !prepared.mask) {
    throw new TypeError("prepared must be returned by prepareSourceSegment");
  }
  const restoredText = restoreInvariantLiterals(prepared.mask, targetText);
  if (!restoredText.trim()) throw new TypeError("targetText must not be empty");
  const segment = {
    ...prepared.source,
    target_sha256: sha256Hex(restoredText.normalize("NFC")),
  };
  segment.binding_sha256 = segmentBindingDigest(segment);
  return {
    segment,
    restored_text: restoredText,
  };
}

function figureBindingDigest(figure) {
  return sha256Canonical({
    occurrence_id: figure.occurrence_id,
    order: figure.order,
    output_sha256: figure.output_sha256,
    page: figure.page,
    source_sha256: figure.source_sha256,
  });
}

function createFigureOccurrence({ documentSha256, page, order, sourceBytes, outputBytes }) {
  const documentDigest = assertSha256(documentSha256, "documentSha256");
  const pageNumber = assertIndex(page, "page");
  const orderNumber = assertIndex(order, "order");
  const figure = {
    occurrence_id: stableFigureOccurrenceId(documentDigest, pageNumber, orderNumber),
    page: pageNumber,
    order: orderNumber,
    source_sha256: hashArtifact(sourceBytes, "sourceBytes"),
    output_sha256: hashArtifact(outputBytes, "outputBytes"),
  };
  figure.binding_sha256 = figureBindingDigest(figure);
  return figure;
}

function digestJudgeInput(judgeInput) {
  if (!judgeInput || typeof judgeInput !== "object" || Array.isArray(judgeInput)) {
    throw new TypeError("judgeInput must be the exact canonical request object");
  }
  return sha256Canonical(judgeInput);
}

function createJudgeItem(segment, verdict = "pass") {
  if (!segment || typeof segment !== "object") throw new TypeError("segment is required");
  return {
    segment_id: String(segment.segment_id),
    source_sha256: assertSha256(segment.source_sha256, "segment.source_sha256"),
    target_sha256: assertSha256(segment.target_sha256, "segment.target_sha256"),
    verdict: String(verdict),
  };
}

function providerFamily(value) {
  const provider = String(value || "").trim().toLowerCase();
  const aliases = new Map([
    ["claude", "anthropic"],
    ["anthropic", "anthropic"],
    ["chatgpt", "openai"],
    ["openai", "openai"],
    ["gemini", "google"],
    ["google", "google"],
  ]);
  return aliases.get(provider) || provider;
}

function validateSegmentSchema(segment, sourcePdfSha256, path) {
  assertExactKeys(segment, SEGMENT_KEYS, path);
  if (!Number.isInteger(segment.page) || segment.page < 1 || segment.page > MAX_INDEX ||
      !Number.isInteger(segment.order) || segment.order < 1 || segment.order > MAX_INDEX) {
    fail("PROVENANCE_SCHEMA_INVALID", `${path} page/order is invalid`, { path });
  }
  const expectedId = stableSegmentId(sourcePdfSha256, segment.page, segment.order);
  if (segment.segment_id !== expectedId) {
    fail("SEGMENT_ID_MISMATCH", "Segment ID does not match source document/page/order", {
      segment_id: String(segment.segment_id || ""),
    });
  }
  try {
    assertKind(segment.kind);
  } catch {
    fail("PROVENANCE_SCHEMA_INVALID", `${path}.kind is invalid`, { path });
  }
  assertCanonicalSha(segment.source_sha256, `${path}.source_sha256`);
  assertCanonicalSha(segment.invariant_manifest_sha256, `${path}.invariant_manifest_sha256`);
  assertCanonicalSha(segment.target_sha256, `${path}.target_sha256`);
  assertCanonicalSha(segment.binding_sha256, `${path}.binding_sha256`);
  if (!Number.isInteger(segment.invariant_count) || segment.invariant_count < 0) {
    fail("PROVENANCE_SCHEMA_INVALID", `${path}.invariant_count must be a non-negative integer`, { path });
  }
  const expectedBinding = segmentBindingDigest(segment);
  if (segment.binding_sha256 !== expectedBinding) {
    fail("SEGMENT_HASH_MISMATCH", "Segment target/source binding hash does not match", {
      segment_id: segment.segment_id,
    });
  }
}

function validateFigureSchema(figure, sourcePdfSha256, path) {
  assertExactKeys(figure, FIGURE_KEYS, path);
  if (!Number.isInteger(figure.page) || figure.page < 1 || figure.page > MAX_INDEX ||
      !Number.isInteger(figure.order) || figure.order < 1 || figure.order > MAX_INDEX) {
    fail("PROVENANCE_SCHEMA_INVALID", `${path} page/order is invalid`, { path });
  }
  const expectedId = stableFigureOccurrenceId(sourcePdfSha256, figure.page, figure.order);
  if (figure.occurrence_id !== expectedId) {
    fail("FIGURE_ID_MISMATCH", "Figure occurrence ID does not match source document/page/order", {
      occurrence_id: String(figure.occurrence_id || ""),
    });
  }
  assertCanonicalSha(figure.source_sha256, `${path}.source_sha256`);
  assertCanonicalSha(figure.output_sha256, `${path}.output_sha256`);
  assertCanonicalSha(figure.binding_sha256, `${path}.binding_sha256`);
  if (figure.binding_sha256 !== figureBindingDigest(figure)) {
    fail("FIGURE_HASH_MISMATCH", "Figure occurrence binding hash does not match", {
      occurrence_id: figure.occurrence_id,
    });
  }
}

function normalizedSegments(segments, sourcePdfSha256) {
  if (!Array.isArray(segments) || !segments.length) {
    fail("SEGMENT_SET_INVALID", "At least one provenance segment is required", {});
  }
  const copy = segments.map((segment) => JSON.parse(canonicalJson(segment)));
  copy.forEach((segment, index) => validateSegmentSchema(segment, sourcePdfSha256, `segments[${index}]`));
  copy.sort((left, right) => compareIds(left.segment_id, right.segment_id));
  const ids = copy.map((segment) => segment.segment_id);
  const positions = copy.map((segment) => `${segment.page}:${segment.order}`);
  if (new Set(ids).size !== ids.length || new Set(positions).size !== positions.length) {
    fail("SEGMENT_SET_INVALID", "Segment IDs and page/order positions must be unique", {});
  }
  return copy;
}

function normalizedFigures(figures, sourcePdfSha256) {
  if (!Array.isArray(figures)) fail("FIGURE_SET_INVALID", "figures must be an array", {});
  const copy = figures.map((figure) => JSON.parse(canonicalJson(figure)));
  copy.forEach((figure, index) => validateFigureSchema(figure, sourcePdfSha256, `figures[${index}]`));
  copy.sort((left, right) => compareIds(left.occurrence_id, right.occurrence_id));
  const ids = copy.map((figure) => figure.occurrence_id);
  const positions = copy.map((figure) => `${figure.page}:${figure.order}`);
  if (new Set(ids).size !== ids.length || new Set(positions).size !== positions.length) {
    fail("FIGURE_SET_INVALID", "Figure occurrence IDs and page/order positions must be unique", {});
  }
  return copy;
}

function validateActor(actor, keys, path) {
  assertExactKeys(actor, keys, path);
  assertNonEmptyIdentifier(actor.provider, `${path}.provider`);
  assertNonEmptyIdentifier(actor.model, `${path}.model`);
  assertNonEmptyIdentifier(actor.request_id, `${path}.request_id`);
}

function expectedHash(expected, bufferName, hashName) {
  if (expected[bufferName] != null) return hashArtifact(expected[bufferName], bufferName);
  if (expected[hashName] != null) return assertSha256(expected[hashName], hashName);
  fail("EXPECTED_EVIDENCE_CONTEXT_MISSING", `Expected ${bufferName} or ${hashName} is required`, {
    field: bufferName,
  });
}

function validateRetypesetEvidence(evidence, expected = {}) {
  assertExactKeys(evidence, TOP_LEVEL_KEYS, "evidence");
  if (evidence.schema_version !== EVIDENCE_SCHEMA_VERSION || evidence.evidence_type !== EVIDENCE_TYPE) {
    fail("PROVENANCE_SCHEMA_INVALID", "Unsupported provenance schema or evidence type", {});
  }
  const sourcePdfSha256 = assertCanonicalSha(evidence.source_pdf_sha256, "evidence.source_pdf_sha256");
  const outputPdfSha256 = assertCanonicalSha(evidence.output_pdf_sha256, "evidence.output_pdf_sha256");
  const layoutTemplateSha256 = assertCanonicalSha(evidence.layout_template_sha256, "evidence.layout_template_sha256");
  assertCanonicalSha(evidence.evidence_sha256, "evidence.evidence_sha256");

  const segments = normalizedSegments(evidence.segments, sourcePdfSha256);
  const figures = normalizedFigures(evidence.figures, sourcePdfSha256);
  if (canonicalJson(segments) !== canonicalJson(evidence.segments) || canonicalJson(figures) !== canonicalJson(evidence.figures)) {
    fail("PROVENANCE_ORDER_INVALID", "Segments and figure occurrences must be in canonical ID order", {});
  }

  validateActor(evidence.translation, TRANSLATION_KEYS, "evidence.translation");
  validateActor(evidence.judge, JUDGE_KEYS, "evidence.judge");
  assertCanonicalSha(evidence.judge.input_digest, "evidence.judge.input_digest");
  if (providerFamily(evidence.translation.provider) === providerFamily(evidence.judge.provider)) {
    fail("SELF_JUDGE_FORBIDDEN", "Translation and semantic judgment must use independent providers", {
      translation_provider: evidence.translation.provider,
      judge_provider: evidence.judge.provider,
    });
  }
  if (!Array.isArray(evidence.judge.items)) {
    fail("JUDGE_ITEMS_INVALID", "judge.items must be an array", {});
  }
  const expectedJudgeItems = segments.map((segment) => createJudgeItem(segment, "pass"));
  const judgeItems = evidence.judge.items.map((item, index) => {
    assertExactKeys(item, JUDGE_ITEM_KEYS, `evidence.judge.items[${index}]`);
    assertCanonicalSha(item.source_sha256, `evidence.judge.items[${index}].source_sha256`);
    assertCanonicalSha(item.target_sha256, `evidence.judge.items[${index}].target_sha256`);
    if (item.verdict !== "pass") {
      fail("JUDGE_VERDICT_REJECTED", "Every judge item must have an explicit pass verdict", {
        segment_id: String(item.segment_id || ""),
        verdict: String(item.verdict || ""),
      });
    }
    return JSON.parse(canonicalJson(item));
  }).sort((left, right) => compareIds(left.segment_id, right.segment_id));
  if (canonicalJson(judgeItems) !== canonicalJson(expectedJudgeItems)) {
    fail("JUDGE_ITEMS_MISMATCH", "Judge items must exactly bind every source/target segment hash once", {});
  }
  if (canonicalJson(evidence.judge.items) !== canonicalJson(judgeItems)) {
    fail("PROVENANCE_ORDER_INVALID", "Judge items must be in canonical segment ID order", {});
  }

  const unsigned = { ...evidence };
  delete unsigned.evidence_sha256;
  const seal = sha256Canonical(unsigned);
  if (seal !== evidence.evidence_sha256) {
    fail("EVIDENCE_SEAL_MISMATCH", "Evidence seal does not match the canonical evidence payload", {});
  }

  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    fail("EXPECTED_EVIDENCE_CONTEXT_MISSING", "Independent expected evidence context is required", {});
  }
  const expectedSource = expectedHash(expected, "sourcePdf", "sourcePdfSha256");
  const expectedOutput = expectedHash(expected, "outputPdf", "outputPdfSha256");
  const expectedLayout = expectedHash(expected, "layoutTemplate", "layoutTemplateSha256");
  if (sourcePdfSha256 !== expectedSource) fail("SOURCE_PDF_HASH_MISMATCH", "Source PDF hash mismatch", {});
  if (outputPdfSha256 !== expectedOutput) fail("OUTPUT_PDF_HASH_MISMATCH", "Output PDF hash mismatch", {});
  if (layoutTemplateSha256 !== expectedLayout) fail("LAYOUT_TEMPLATE_HASH_MISMATCH", "Layout/template hash mismatch", {});

  if (!Array.isArray(expected.segments)) {
    fail("EXPECTED_EVIDENCE_CONTEXT_MISSING", "Expected segments are required", { field: "segments" });
  }
  if (!Array.isArray(expected.figures)) {
    fail("EXPECTED_EVIDENCE_CONTEXT_MISSING", "Expected figure occurrences are required", { field: "figures" });
  }
  const expectedSegments = normalizedSegments(expected.segments, expectedSource);
  const expectedFigures = normalizedFigures(expected.figures, expectedSource);
  if (canonicalJson(segments) !== canonicalJson(expectedSegments)) {
    fail("SEGMENT_SET_MISMATCH", "Evidence segment ID/hash set differs from expected segments", {});
  }
  if (canonicalJson(figures) !== canonicalJson(expectedFigures)) {
    fail("FIGURE_SET_MISMATCH", "Evidence figure occurrence/hash set differs from expected figures", {});
  }
  const judgeInputDigest = expected.judgeInput != null
    ? digestJudgeInput(expected.judgeInput)
    : assertSha256(expected.judgeInputDigest, "expected.judgeInputDigest");
  if (evidence.judge.input_digest !== judgeInputDigest) {
    fail("JUDGE_INPUT_HASH_MISMATCH", "Judge input digest differs from the exact request payload", {});
  }
  const expectedTranslationProvider = assertNonEmptyIdentifier(
    expected.translationProvider,
    "expected.translationProvider",
  );
  if (providerFamily(evidence.translation.provider) !== providerFamily(expectedTranslationProvider)) {
    fail("TRANSLATION_PROVIDER_MISMATCH", "Translation provider differs from expected request provider", {});
  }
  return evidence;
}

function sealRetypesetEvidence({
  sourcePdf,
  outputPdf,
  layoutTemplate,
  segments,
  figures = [],
  translation,
  judge,
  judgeInput,
}) {
  const sourcePdfSha256 = hashArtifact(sourcePdf, "sourcePdf");
  const outputPdfSha256 = hashArtifact(outputPdf, "outputPdf");
  const layoutTemplateSha256 = hashArtifact(layoutTemplate, "layoutTemplate");
  const canonicalSegments = normalizedSegments(segments, sourcePdfSha256);
  const canonicalFigures = normalizedFigures(figures, sourcePdfSha256);
  validateActor(translation, TRANSLATION_KEYS, "translation");
  validateActor(judge, JUDGE_KEYS, "judge");
  const inputDigest = digestJudgeInput(judgeInput);
  if (judge.input_digest !== inputDigest) {
    fail("JUDGE_INPUT_HASH_MISMATCH", "Judge result is not bound to the exact request payload", {});
  }
  const evidence = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    evidence_type: EVIDENCE_TYPE,
    source_pdf_sha256: sourcePdfSha256,
    output_pdf_sha256: outputPdfSha256,
    layout_template_sha256: layoutTemplateSha256,
    segments: canonicalSegments,
    figures: canonicalFigures,
    translation: JSON.parse(canonicalJson(translation)),
    judge: {
      provider: judge.provider,
      model: judge.model,
      request_id: judge.request_id,
      input_digest: judge.input_digest,
      items: [...judge.items].map((item) => JSON.parse(canonicalJson(item)))
        .sort((left, right) => compareIds(left.segment_id, right.segment_id)),
    },
  };
  evidence.evidence_sha256 = sha256Canonical(evidence);
  const sealed = JSON.parse(canonicalJson(evidence));
  validateRetypesetEvidence(sealed, {
    sourcePdf,
    outputPdf,
    layoutTemplate,
    segments: canonicalSegments,
    figures: canonicalFigures,
    judgeInput,
    translationProvider: translation.provider,
  });
  return sealed;
}

// Scan/retypeset OCR is a source-evidence layer that precedes translated
// segments.  Keep it separate from the existing segment/judge seal so legacy
// callers remain schema-compatible, but validate both OCR and actual raster
// coverage at every LaTeX/postflight boundary.
function validateRetypesetOcrEvidence({
  ocrEvidence,
  ocrRenderManifest,
  sourcePdf,
  expectedPageIndices = null,
  modelInputBlocks = null,
  rawTileBuffers = null,
} = {}) {
  const evidence = validateCanonicalOcrEvidence(ocrEvidence, { sourcePdf });
  const renderManifest = validateOcrRenderManifest(ocrRenderManifest, {
    sourcePdf,
    pageCount: evidence.page_count,
    expectedPageIndices,
    modelInputBlocks,
    rawTileBuffers,
    allowPartial: expectedPageIndices != null,
  });
  const requiresVisualBinding = !!evidence.needs_visual_adjudication;
  const evidenceVisualInputSha256 = requiresVisualBinding
    ? evidence.visual_adjudication && evidence.visual_adjudication.input_digest
    : null;
  const manifestVisualInputSha256 = renderManifest.visual_adjudication_input_sha256;
  if (
    (requiresVisualBinding && (
      typeof evidenceVisualInputSha256 !== "string" ||
      manifestVisualInputSha256 !== evidenceVisualInputSha256
    )) ||
    (!requiresVisualBinding && manifestVisualInputSha256 !== null)
  ) {
    fail(
      "OCR_VISUAL_ADJUDICATION_BINDING_MISMATCH",
      "OCR evidence and raster manifest disagree about the exact visual adjudication input",
      {
        evidence_input_digest: evidenceVisualInputSha256 || null,
        manifest_input_digest: manifestVisualInputSha256,
      },
    );
  }
  if (requiresVisualBinding) {
    validateVisualRenderAttestation(evidence.visual_adjudication, { sourcePdf });
  }
  const selectedPages = renderManifest.pages.map((manifestPage) => {
    const page = evidence.pages[manifestPage.index];
    if (!page || page.index !== manifestPage.index) {
      fail("OCR_SUBSET_PAGE_MISMATCH", "OCR raster subset is not covered by canonical OCR evidence", {
        page_index: manifestPage.index,
      });
    }
    const source = page.source_dimensions;
    const dimensionTolerance = Math.max(
      1e-6,
      Math.max(Number(source && source.width) || 0, Number(source && source.height) || 0) * 1e-9,
    );
    if (
      !source ||
      Math.abs(manifestPage.width - source.width) > dimensionTolerance ||
      Math.abs(manifestPage.height - source.height) > dimensionTolerance ||
      manifestPage.rotation !== source.rotation
    ) {
      fail("OCR_RENDER_SOURCE_GEOMETRY_MISMATCH", "OCR raster geometry is not bound to the inspected source PDF page", {
        page_index: manifestPage.index,
      });
    }
    return {
      index: page.index,
      text_sha256: page.text_sha256,
      block_hashes: page.blocks.map((block) => block.content_sha256),
    };
  });
  const subset = {
    source_evidence_sha256: evidence.evidence_sha256,
    page_range: renderManifest.page_range,
    pages: selectedPages,
  };
  subset.subset_sha256 = sha256Canonical(subset);
  return {
    evidence,
    renderManifest,
    subset,
    summary: {
      ocr: summarizeOcrEvidence(evidence),
      subset,
      render: {
        schema_version: renderManifest.schema_version,
        source_pdf_sha256: renderManifest.source_pdf_sha256,
        page_count: renderManifest.page_count,
        page_range: renderManifest.page_range,
        visual_adjudication_input_sha256:
          renderManifest.visual_adjudication_input_sha256,
        manifest_sha256: renderManifest.manifest_sha256,
        pages: renderManifest.pages.map((page) => ({
          index: page.index,
          width: page.width,
          height: page.height,
          rotation: page.rotation,
          tile_count: page.tile_count,
          tile_bboxes: page.tiles.map((tile) => tile.bbox),
          raw_tile_hashes: page.tiles.map((tile) => tile.raw.image_sha256),
          model_input_tile_hashes: page.tiles.map(
            (tile) => tile.model_input.image_sha256,
          ),
        })),
      },
    },
  };
}

module.exports = {
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_TYPE,
  ProvenanceValidationError,
  bindTargetSegment,
  createFigureOccurrence,
  createJudgeItem,
  digestJudgeInput,
  hashArtifact,
  prepareSourceSegment,
  providerFamily,
  sealRetypesetEvidence,
  sourceSegmentDigest,
  stableFigureOccurrenceId,
  stableSegmentId,
  validateRetypesetOcrEvidence,
  validateRetypesetEvidence,
};
