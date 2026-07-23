"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sizeOf = require("image-size");

const {
  ocrPdfToEvidenceStrict,
  validateCanonicalOcrEvidence,
} = require("./mistral-ocr");
const { canonicalJson } = require("./invariants");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("../../anthropic-media");
const {
  getProcessWidePdfTranslateResourceLimits,
} = require("./resource-gate");

const PAGE_TOOL = path.join(__dirname, "ocr-page-tool.py");
const OCR_RENDER_MANIFEST_SCHEMA_VERSION = 3;
const OCR_VISUAL_INPUT_SCHEMA_VERSION = 1;
const OCR_MODEL_INPUT_PROOF_SCHEMA_VERSION = 1;
const OCR_MODEL_INPUT_TRANSFORM_ID = "anthropic-media.prepare-image.v1";
const OCR_VISUAL_RENDER_ATTESTATION_SCHEMA_VERSION = 2;
const DEFAULT_RISK_VISUAL_BATCH_PAGES = 4;
const DEFAULT_RISK_VISUAL_BATCH_TILES = 12;
const DEFAULT_RISK_VISUAL_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_RISK_VISUAL_BATCH_TOKENS = 20;
const HARD_RISK_VISUAL_BATCH_PAGES = 8;
const HARD_RISK_VISUAL_BATCH_TILES = 24;
const HARD_RISK_VISUAL_BATCH_BYTES = 24 * 1024 * 1024;
const HARD_RISK_VISUAL_BATCH_TOKENS = 40;
const SHA256_RE = /^[a-f0-9]{64}$/;
// A manifest SHA is an integrity checksum, not an attestation: anyone who can
// swap model-input metadata can recompute it.  This process-local key lets the
// trusted raw->prepared-image boundary attest the exact byte pair it produced.
// The same Node process validates the proof again at LaTeX, merge and postflight
// boundaries.  Manifests from another process intentionally fail closed.
const OCR_MODEL_INPUT_PROOF_KEY = crypto.randomBytes(32);
// Separate domain/key from model-input preparation proofs.  This attests that
// a visual-adjudication commitment came from tiles whose bytes were inspected
// at the trusted source-render boundary in this process.
const OCR_VISUAL_RENDER_ATTESTATION_KEY = crypto.randomBytes(32);

class OcrRoutingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OcrRoutingError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new OcrRoutingError(code, message, details);
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function digest(value) {
  return sha256Hex(Buffer.from(canonicalJson(value), "utf8"));
}

function hmacDigest(value) {
  return crypto
    .createHmac("sha256", OCR_MODEL_INPUT_PROOF_KEY)
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
}

function visualRenderHmacDigest(value) {
  return crypto
    .createHmac("sha256", OCR_VISUAL_RENDER_ATTESTATION_KEY)
    .update(Buffer.from(canonicalJson(value), "utf8"))
    .digest("hex");
}

function secureDigestEqual(left, right) {
  if (!SHA256_RE.test(String(left || "")) || !SHA256_RE.test(String(right || ""))) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalOcrModelInputOptions(options = {}) {
  if (
    !options || typeof options !== "object" || Array.isArray(options) ||
    canonicalJson(Object.keys(options).sort()) !== canonicalJson(["forceCompress"])
  ) {
    fail(
      "OCR_RENDER_TRANSFORM_OPTIONS",
      "OCR model-input preparation requires the exact production transform options.",
    );
  }
  if (options.forceCompress !== true) {
    fail(
      "OCR_RENDER_TRANSFORM_OPTIONS",
      "OCR model-input preparation must use forceCompress=true.",
    );
  }
  return { force_compress: true };
}

function preparationProofPayload({ position, options, raw, modelInput }) {
  return {
    schema_version: OCR_MODEL_INPUT_PROOF_SCHEMA_VERSION,
    proof_type: "ocr-model-input-preparation",
    transform_id: OCR_MODEL_INPUT_TRANSFORM_ID,
    position,
    options,
    raw,
    model_input: modelInput,
  };
}

function manifestTransformPayload({ pageIndex, tileIndex, bbox, options, raw, modelInput }) {
  return {
    schema_version: OCR_MODEL_INPUT_PROOF_SCHEMA_VERSION,
    proof_type: "ocr-model-input-manifest-binding",
    transform_id: OCR_MODEL_INPUT_TRANSFORM_ID,
    page_index: pageIndex,
    tile_index: tileIndex,
    bbox,
    options,
    raw,
    model_input: modelInput,
  };
}

function canonicalPageIndices(values, field = "page indices") {
  if (!Array.isArray(values) || !values.length) {
    fail("OCR_RENDER_PAGE_COVERAGE", `${field} must be a non-empty array.`);
  }
  const out = values.map((value) => {
    if (!Number.isInteger(value) || value < 0) {
      fail("OCR_RENDER_PAGE_COVERAGE", `${field} must contain zero-based integers.`);
    }
    return value;
  });
  if (new Set(out).size !== out.length) {
    fail("OCR_RENDER_PAGE_COVERAGE", `${field} contains duplicate pages.`);
  }
  const sorted = [...out].sort((a, b) => a - b);
  if (sorted.some((value, index) => index > 0 && value !== sorted[index - 1] + 1)) {
    fail("OCR_RENDER_PAGE_COVERAGE", `${field} must be one contiguous page range.`);
  }
  return sorted;
}

function mimeForImageType(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (["png", "gif", "webp"].includes(normalized)) return `image/${normalized}`;
  return "";
}

function inspectImageBytes(buffer, { mediaType = null, context = "image" } = {}) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    fail("OCR_RENDER_MANIFEST_INVALID", `${context} bytes are missing.`);
  }
  let dimensions;
  try {
    dimensions = sizeOf(buffer);
  } catch {
    fail("OCR_RENDER_MANIFEST_INVALID", `${context} bytes are not a supported image.`);
  }
  const width = Number(dimensions && dimensions.width);
  const height = Number(dimensions && dimensions.height);
  const detectedMediaType = mimeForImageType(dimensions && dimensions.type);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0 || !detectedMediaType) {
    fail("OCR_RENDER_MANIFEST_INVALID", `${context} dimensions or media type are invalid.`);
  }
  if (mediaType != null && String(mediaType) !== detectedMediaType) {
    fail("OCR_RENDER_MODEL_INPUT_MISMATCH", `${context} declared media type does not match its bytes.`, {
      declared_media_type: String(mediaType),
      detected_media_type: detectedMediaType,
    });
  }
  return {
    media_type: detectedMediaType,
    width,
    height,
    image_sha256: sha256Hex(buffer),
  };
}

function decodeModelInputBlock(block, position) {
  const source = block && block.type === "image" ? block.source : null;
  const data = source && source.type === "base64" ? source.data : null;
  const mediaType = source && source.media_type;
  if (typeof data !== "string" || !data || /\s/u.test(data) || typeof mediaType !== "string") {
    fail("OCR_RENDER_MODEL_INPUT_MISMATCH", "Model input image block is malformed.", { position });
  }
  let buffer;
  try {
    buffer = Buffer.from(data, "base64");
  } catch {
    fail("OCR_RENDER_MODEL_INPUT_MISMATCH", "Model input image base64 is invalid.", { position });
  }
  if (!buffer.length || buffer.toString("base64") !== data) {
    fail("OCR_RENDER_MODEL_INPUT_MISMATCH", "Model input image base64 is not canonical.", { position });
  }
  return {
    buffer,
    descriptor: inspectImageBytes(buffer, {
      mediaType,
      context: `model input tile ${position}`,
    }),
  };
}

function validatePreparationProof(proof, { position, raw, modelInput }) {
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) {
    fail("OCR_RENDER_TRANSFORM_PROOF", "OCR model-input preparation proof is missing.", {
      position,
    });
  }
  const { binding_hmac_sha256: seal, ...payload } = proof;
  const expected = preparationProofPayload({
    position,
    options: { force_compress: true },
    raw,
    modelInput,
  });
  if (
    canonicalJson(Object.keys(proof).sort()) !==
      canonicalJson([...Object.keys(expected), "binding_hmac_sha256"].sort()) ||
    canonicalJson(payload) !== canonicalJson(expected) ||
    !secureDigestEqual(seal, hmacDigest(expected))
  ) {
    fail(
      "OCR_RENDER_TRANSFORM_PROOF",
      "OCR model input is not the exact output attested for its raw tile.",
      { position },
    );
  }
  return proof;
}

function createManifestTransformProof({ pageIndex, tileIndex, bbox, options, raw, modelInput }) {
  const payload = manifestTransformPayload({
    pageIndex,
    tileIndex,
    bbox,
    options,
    raw,
    modelInput,
  });
  return {
    schema_version: payload.schema_version,
    proof_type: payload.proof_type,
    transform_id: payload.transform_id,
    options: payload.options,
    binding_hmac_sha256: hmacDigest(payload),
  };
}

function validateManifestTransformProof(transform, {
  pageIndex,
  tileIndex,
  bbox,
  raw,
  modelInput,
}) {
  if (
    !transform || typeof transform !== "object" || Array.isArray(transform) ||
    canonicalJson(Object.keys(transform).sort()) !== canonicalJson([
      "binding_hmac_sha256",
      "options",
      "proof_type",
      "schema_version",
      "transform_id",
    ].sort()) ||
    transform.schema_version !== OCR_MODEL_INPUT_PROOF_SCHEMA_VERSION ||
    transform.proof_type !== "ocr-model-input-manifest-binding" ||
    transform.transform_id !== OCR_MODEL_INPUT_TRANSFORM_ID ||
    canonicalJson(transform.options) !== canonicalJson({ force_compress: true })
  ) {
    fail("OCR_RENDER_TRANSFORM_PROOF", "OCR manifest transform proof schema is invalid.", {
      page_index: pageIndex,
      tile_index: tileIndex,
    });
  }
  const payload = manifestTransformPayload({
    pageIndex,
    tileIndex,
    bbox,
    options: transform.options,
    raw,
    modelInput,
  });
  if (!secureDigestEqual(transform.binding_hmac_sha256, hmacDigest(payload))) {
    fail(
      "OCR_RENDER_TRANSFORM_PROOF",
      "OCR manifest raw/model-input binding proof does not match.",
      { page_index: pageIndex, tile_index: tileIndex },
    );
  }
  return transform;
}

async function prepareOcrModelInputs({
  rasterFiles,
  tileBuffers,
  transformOptions = { forceCompress: true },
} = {}) {
  if (
    !Array.isArray(rasterFiles) || !Array.isArray(tileBuffers) ||
    !rasterFiles.length || rasterFiles.length !== tileBuffers.length
  ) {
    fail(
      "OCR_RENDER_TRANSFORM_INPUT",
      "OCR model-input preparation needs aligned raster files and raw tile bytes.",
    );
  }
  const canonicalOptions = canonicalOcrModelInputOptions(transformOptions);
  const prepared = await Promise.all(tileBuffers.map(async (rawBuffer, position) => {
    if (!Buffer.isBuffer(rawBuffer) || !rawBuffer.length) {
      fail("OCR_RENDER_TRANSFORM_INPUT", "OCR raw tile bytes are missing.", { position });
    }
    const file = String(rasterFiles[position] || "");
    if (!file) {
      fail("OCR_RENDER_TRANSFORM_INPUT", "OCR raster file identity is missing.", { position });
    }
    const raw = inspectImageBytes(rawBuffer, {
      mediaType: "image/png",
      context: `raw raster tile ${position}`,
    });
    const output = await prepareImageForAnthropic(
      { buffer: rawBuffer, name: path.basename(file), mimetype: "image/png" },
      transformOptions,
    );
    if (!output || output.ok !== true || !Buffer.isBuffer(output.buffer) || !output.buffer.length) {
      fail(
        "OCR_RENDER_TRANSFORM_FAILED",
        "OCR raw tile could not be converted to the production model input.",
        { position },
      );
    }
    const imageBlock = toAnthropicImageBlock(output);
    const modelInput = decodeModelInputBlock(imageBlock, position).descriptor;
    const payload = preparationProofPayload({
      position,
      options: canonicalOptions,
      raw,
      modelInput,
    });
    return {
      imageBlock,
      proof: {
        ...payload,
        binding_hmac_sha256: hmacDigest(payload),
      },
    };
  }));
  return {
    imageBlocks: prepared.map((entry) => entry.imageBlock),
    modelInputProofs: prepared.map((entry) => entry.proof),
  };
}

function descriptorMatches(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function normalizePageRotation(value, details = {}) {
  if (!Number.isInteger(value) || value < 0 || value >= 360 || value % 90 !== 0) {
    fail("OCR_RENDER_PAGE_GEOMETRY", "Raster page rotation must be 0, 90, 180, or 270 degrees.", details);
  }
  return value;
}

function validatePageTileGeometry(page) {
  const width = page && page.width;
  const height = page && page.height;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    fail("OCR_RENDER_PAGE_GEOMETRY", "Raster page dimensions are invalid.", {
      page_index: page && page.index,
    });
  }
  normalizePageRotation(page.rotation, { page_index: page.index });
  const tolerance = Math.max(1e-6, Math.max(width, height) * 1e-9);
  const seenBboxes = new Set();
  let coveredTo = 0;
  page.tiles.forEach((tile, position) => {
    if (!Array.isArray(tile.bbox) || tile.bbox.length !== 4) {
      fail("OCR_RENDER_TILE_GEOMETRY", "Raster tile PDF bbox is missing.", {
        page_index: page.index,
        tile_index: position,
      });
    }
    const bbox = tile.bbox;
    const [x0, y0, x1, y1] = bbox;
    const bboxKey = canonicalJson(bbox);
    if (seenBboxes.has(bboxKey)) {
      fail("OCR_RENDER_TILE_GEOMETRY", "Raster page contains a duplicate tile bbox.", {
        page_index: page.index,
        tile_index: position,
      });
    }
    seenBboxes.add(bboxKey);
    if (
      bbox.some((value) => !Number.isFinite(value)) ||
      x1 <= x0 || y1 <= y0 ||
      x0 < -tolerance || y0 < -tolerance ||
      x1 > width + tolerance || y1 > height + tolerance ||
      Math.abs(x0) > tolerance || Math.abs(x1 - width) > tolerance
    ) {
      fail("OCR_RENDER_TILE_GEOMETRY", "Raster tile bbox is outside the source page or lacks full-width coverage.", {
        page_index: page.index,
        tile_index: position,
      });
    }
    if (Math.abs(y0 - coveredTo) > tolerance) {
      fail("OCR_RENDER_TILE_COVERAGE", "Raster tile bboxes have a gap or overlap.", {
        page_index: page.index,
        tile_index: position,
        expected_y0: coveredTo,
        actual_y0: y0,
      });
    }
    for (const [name, descriptor] of [["raw", tile.raw], ["model_input", tile.model_input]]) {
      const bboxAspect = (x1 - x0) / (y1 - y0);
      const pixelAspect = descriptor.width / descriptor.height;
      const aspectError = Math.abs(pixelAspect - bboxAspect) / bboxAspect;
      if (!Number.isFinite(aspectError) || aspectError > 0.02) {
        fail("OCR_RENDER_TILE_ASPECT_MISMATCH", `Raster ${name} pixels do not match the sealed PDF bbox.`, {
          page_index: page.index,
          tile_index: position,
          descriptor: name,
        });
      }
    }
    coveredTo = y1;
  });
  if (Math.abs(coveredTo - height) > tolerance) {
    fail("OCR_RENDER_TILE_COVERAGE", "Raster tiles do not end at the source page bottom.", {
      page_index: page.index,
      covered_to: coveredTo,
      page_height: height,
    });
  }
}

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(__dirname, "../../../.venv/bin/python3"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "python3";
}

function runPageTool(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(detectPython(), [PAGE_TOOL, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) {
        const error = new Error("OCR page inspection was aborted");
        error.name = "AbortError";
        error.code = "ABORT_ERR";
        reject(error);
        return;
      }
      if (code !== 0) {
        reject(new Error(`OCR page tool failed (${code}): ${Buffer.concat(stderr).toString("utf8").slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
      } catch {
        reject(new Error("OCR page tool returned invalid JSON"));
      }
    });
  });
}

async function withPdfTemp(pdfBuffer, callback) {
  if (!Buffer.isBuffer(pdfBuffer) || !pdfBuffer.length) {
    fail("OCR_SOURCE_PDF_REQUIRED", "OCR routing requires source PDF bytes.");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-pages-"));
  const pdfPath = path.join(directory, "source.pdf");
  fs.writeFileSync(pdfPath, pdfBuffer, { mode: 0o600 });
  try {
    return await callback(pdfPath, directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function inspectPdfSourcePages(pdfBuffer, { signal } = {}) {
  return withPdfTemp(pdfBuffer, async (pdfPath) => {
    const result = await runPageTool(["inspect", pdfPath], { signal });
    if (!result || !Array.isArray(result.pages) || result.page_count !== result.pages.length) {
      fail("OCR_SOURCE_PAGE_INSPECTION_INVALID", "Source page inspection is incomplete.");
    }
    const expected = Array.from({ length: result.page_count }, (_, index) => index);
    if (result.pages.some((page, position) => (
      page.index !== expected[position] || !Number.isFinite(page.width) || page.width <= 0 ||
      !Number.isFinite(page.height) || page.height <= 0
    ))) {
      fail("OCR_SOURCE_PAGE_INSPECTION_INVALID", "Source page geometry is invalid.");
    }
    return result.pages.map(({ index, width, height, rotation }) => ({
      index,
      width,
      height,
      rotation,
    }));
  });
}

async function renderOcrAdjudicationPages(pdfBuffer, pageIndices, { signal } = {}) {
  return withPdfTemp(pdfBuffer, async (pdfPath, directory) => {
    const outDir = path.join(directory, "rendered");
    const result = await runPageTool(
      ["render", pdfPath, outDir, JSON.stringify(pageIndices), "1400"],
      { signal },
    );
    return result.pages.map((page) => ({
      index: page.index,
      source_width: page.source_width,
      source_height: page.source_height,
      tiles: page.tiles.map((tile) => {
        const buffer = fs.readFileSync(tile.file);
        const descriptor = inspectImageBytes(buffer, {
          mediaType: "image/png",
          context: `visual adjudication page ${page.index} tile ${tile.index}`,
        });
        return {
          index: tile.index,
          bbox: tile.bbox,
          width: tile.width,
          height: tile.height,
          media_type: descriptor.media_type,
          image_sha256: descriptor.image_sha256,
          buffer,
        };
      }),
    }));
  });
}

function canonicalOcrPageTexts(evidence) {
  if (!evidence || !Array.isArray(evidence.pages)) return null;
  const pages = evidence.pages.map((page) => ({
    page: page.index + 1,
    text: String(page.text || ""),
  }));
  return pages.length ? pages : null;
}

function visualAdjudicationInput(summary, sourcePdf, sourcePages, renderedPages) {
  const input = {
    schema_version: OCR_VISUAL_INPUT_SCHEMA_VERSION,
    source_pdf_sha256: sha256Hex(sourcePdf),
    ocr_evidence_sha256: String((summary && summary.evidence_sha256) || ""),
    risk_tokens: (summary && Array.isArray(summary.risk_tokens) ? summary.risk_tokens : [])
      .filter((token) => token.needs_visual_adjudication)
      .map((token) => ({
        page_index: token.page_index,
        block_order: token.block_order,
        type: token.type,
        token_sha256: token.token_sha256,
      }))
      .sort((left, right) => (
        left.page_index - right.page_index ||
        left.block_order - right.block_order ||
        (String(left.type) < String(right.type) ? -1 : String(left.type) > String(right.type) ? 1 : 0) ||
        (String(left.token_sha256) < String(right.token_sha256)
          ? -1
          : String(left.token_sha256) > String(right.token_sha256)
            ? 1
            : 0)
      )),
    source_pages: sourcePages.map((page) => ({
      index: page.index,
      width: page.width,
      height: page.height,
      rotation: Number(page.rotation) || 0,
    })),
    rendered_pages: renderedPages.map((page) => ({
      index: page.index,
      source_width: page.source_width,
      source_height: page.source_height,
      tiles: page.tiles.map((tile) => ({
        index: tile.index,
        bbox: tile.bbox,
        width: tile.width,
        height: tile.height,
        media_type: tile.media_type,
        image_sha256: tile.image_sha256,
      })),
    })),
  };
  if (!SHA256_RE.test(input.ocr_evidence_sha256)) {
    fail("OCR_VISUAL_INPUT_INVALID", "Visual adjudication is not bound to canonical OCR evidence.");
  }
  return { input, inputDigest: digest(input) };
}

function boundedPositiveInteger(value, fallback, maximum) {
  if (value == null || String(value).trim() === "") return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function riskVisualBatchLimits(overrides = {}) {
  const pages = boundedPositiveInteger(
    overrides.pages ?? process.env.PDF_OCR_RISK_VISUAL_BATCH_PAGES,
    DEFAULT_RISK_VISUAL_BATCH_PAGES,
    HARD_RISK_VISUAL_BATCH_PAGES,
  );
  const tiles = boundedPositiveInteger(
    overrides.tiles ?? process.env.PDF_OCR_RISK_VISUAL_BATCH_TILES,
    DEFAULT_RISK_VISUAL_BATCH_TILES,
    HARD_RISK_VISUAL_BATCH_TILES,
  );
  const bytes = boundedPositiveInteger(
    overrides.bytes ?? process.env.PDF_OCR_RISK_VISUAL_BATCH_BYTES,
    DEFAULT_RISK_VISUAL_BATCH_BYTES,
    HARD_RISK_VISUAL_BATCH_BYTES,
  );
  const tokens = boundedPositiveInteger(
    overrides.tokens ?? process.env.PDF_OCR_RISK_VISUAL_BATCH_TOKENS,
    DEFAULT_RISK_VISUAL_BATCH_TOKENS,
    HARD_RISK_VISUAL_BATCH_TOKENS,
  );
  return { pages, tiles, bytes, tokens };
}

function renderedBatchUsage(renderedPages) {
  return (renderedPages || []).reduce((usage, page) => {
    usage.pages += 1;
    for (const tile of page.tiles || []) {
      usage.tiles += 1;
      usage.bytes += Buffer.isBuffer(tile.buffer) ? tile.buffer.length : 0;
    }
    return usage;
  }, { pages: 0, tiles: 0, bytes: 0 });
}

function assertRiskVisualBatchBudget(renderedPages, limits) {
  const usage = renderedBatchUsage(renderedPages);
  if (
    usage.pages > limits.pages ||
    usage.tiles > limits.tiles ||
    usage.bytes > limits.bytes
  ) {
    fail(
      "OCR_VISUAL_ADJUDICATION_BATCH_LIMIT",
      "OCR visual adjudication batch exceeds its bounded image budget.",
      {
        page_count: usage.pages,
        tile_count: usage.tiles,
        image_bytes: usage.bytes,
        max_pages: limits.pages,
        max_tiles: limits.tiles,
        max_image_bytes: limits.bytes,
      },
    );
  }
  return usage;
}

function renderedPageCommitments(renderedPages) {
  return renderedPages.map((page) => ({
    index: page.index,
    source_width: page.source_width,
    source_height: page.source_height,
    tiles: page.tiles.map((tile) => ({
      index: tile.index,
      bbox: [...tile.bbox],
      width: tile.width,
      height: tile.height,
      media_type: tile.media_type,
      image_sha256: tile.image_sha256,
    })),
  }));
}

function visualAdjudicatorIdentity({ provider, model, request_id: requestId } = {}) {
  const identity = {
    provider: String(provider || "").trim(),
    model: String(model || "").trim(),
    request_id: String(requestId || "").trim(),
  };
  if (!identity.provider || !identity.model || !identity.request_id) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual render attestation requires exact adjudicator identity.",
    );
  }
  return identity;
}

function visualRenderAttestationPayload(inputCommitment, inputDigest, adjudicator) {
  const renderedPages = Array.isArray(inputCommitment && inputCommitment.rendered_pages)
    ? inputCommitment.rendered_pages
    : [];
  const identity = visualAdjudicatorIdentity(adjudicator);
  return {
    schema_version: OCR_VISUAL_RENDER_ATTESTATION_SCHEMA_VERSION,
    proof_type: "ocr-visual-source-render-attestation",
    source_pdf_sha256: String((inputCommitment && inputCommitment.source_pdf_sha256) || ""),
    input_digest: String(inputDigest || ""),
    adjudicator_identity_sha256: digest(identity),
    rendered_page_count: renderedPages.length,
    rendered_tile_count: renderedPages.reduce(
      (count, page) => count + (Array.isArray(page && page.tiles) ? page.tiles.length : 0),
      0,
    ),
  };
}

function sealValidatedVisualRenderCommitment({
  sourcePdf,
  inputCommitment,
  inputDigest,
  adjudicator,
} = {}) {
  if (
    !Buffer.isBuffer(sourcePdf) || !sourcePdf.length ||
    digest(inputCommitment) !== inputDigest ||
    inputCommitment.source_pdf_sha256 !== sha256Hex(sourcePdf)
  ) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual render attestation requires the exact validated source commitment.",
    );
  }
  const payload = visualRenderAttestationPayload(inputCommitment, inputDigest, adjudicator);
  return {
    ...payload,
    binding_hmac_sha256: visualRenderHmacDigest(payload),
  };
}

function createVisualRenderAttestation({
  sourcePdf,
  sourcePages,
  renderedPages,
  inputCommitment,
  inputDigest,
  adjudicator,
} = {}) {
  if (!Buffer.isBuffer(sourcePdf) || !sourcePdf.length || digest(inputCommitment) !== inputDigest) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual render attestation requires the exact canonical adjudication input.",
    );
  }
  const requested = [...new Set(
    inputCommitment.risk_tokens.map((token) => token.page_index),
  )].sort((left, right) => left - right);
  const validatedPages = validateRenderedAdjudicationPages(
    renderedPages,
    requested,
    sourcePages,
  );
  const rebuilt = visualAdjudicationInput(
    {
      evidence_sha256: inputCommitment.ocr_evidence_sha256,
      risk_tokens: inputCommitment.risk_tokens.map((token) => ({
        ...token,
        needs_visual_adjudication: true,
      })),
    },
    sourcePdf,
    sourcePages,
    validatedPages,
  );
  if (
    rebuilt.inputDigest !== inputDigest ||
    canonicalJson(rebuilt.input) !== canonicalJson(inputCommitment)
  ) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual render attestation does not match actual source-render tile bytes.",
    );
  }
  return sealValidatedVisualRenderCommitment({
    sourcePdf,
    inputCommitment,
    inputDigest,
    adjudicator,
  });
}

function validateVisualRenderAttestation(visualAdjudication, { sourcePdf = null } = {}) {
  const commitment = visualAdjudication && visualAdjudication.input_commitment;
  const inputDigest = visualAdjudication && visualAdjudication.input_digest;
  const proof = visualAdjudication && visualAdjudication.render_attestation;
  if (!commitment || !proof || typeof proof !== "object" || Array.isArray(proof)) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_MISSING",
      "Visual adjudication has no trusted source-render attestation.",
    );
  }
  const payload = visualRenderAttestationPayload(
    commitment,
    inputDigest,
    visualAdjudication,
  );
  const expectedKeys = [...Object.keys(payload), "binding_hmac_sha256"].sort();
  if (
    canonicalJson(Object.keys(proof).sort()) !== canonicalJson(expectedKeys) ||
    canonicalJson(Object.fromEntries(
      Object.keys(payload).map((key) => [key, proof[key]]),
    )) !== canonicalJson(payload) ||
    !secureDigestEqual(proof.binding_hmac_sha256, visualRenderHmacDigest(payload)) ||
    digest(commitment) !== inputDigest ||
    (sourcePdf != null && (
      !Buffer.isBuffer(sourcePdf) || sha256Hex(sourcePdf) !== payload.source_pdf_sha256
    ))
  ) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual adjudication source-render attestation is invalid or does not match its commitment.",
    );
  }
  return proof;
}

function validateRenderedAdjudicationPages(rendered, requested, sourcePages) {
  if (!Array.isArray(rendered)) fail("OCR_VISUAL_RENDER_INVALID", "Visual page renderer returned no pages.");
  const actual = rendered.map((page) => page.index).sort((a, b) => a - b);
  const expected = [...requested].sort((a, b) => a - b);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("OCR_VISUAL_RENDER_COVERAGE", "Visual adjudication render coverage is incomplete.", {
      expected_indices: expected,
      actual_indices: actual,
    });
  }
  for (const page of rendered) {
    const source = sourcePages[page.index];
    if (!source || !Array.isArray(page.tiles) || !page.tiles.length) {
      fail("OCR_VISUAL_RENDER_INVALID", "Visual adjudication page has no tiles.", {
        page_index: page.index,
      });
    }
    const widthError = Math.abs(Number(page.source_width) - source.width) / source.width;
    const heightError = Math.abs(Number(page.source_height) - source.height) / source.height;
    if (!Number.isFinite(widthError) || !Number.isFinite(heightError) || widthError > 0.001 || heightError > 0.001) {
      fail("OCR_VISUAL_RENDER_GEOMETRY", "Visual adjudication render has wrong page geometry.", {
        page_index: page.index,
      });
    }
    const width = Number(page.source_width);
    const height = Number(page.source_height);
    const tolerance = Math.max(0.01, height * 1e-6);
    let coveredTo = 0;
    for (const [position, tile] of page.tiles.entries()) {
      if (tile.index !== position || !Array.isArray(tile.bbox) || tile.bbox.length !== 4) {
        fail("OCR_VISUAL_RENDER_INVALID", "Visual adjudication tile bytes/hash are missing.", {
          page_index: page.index,
        });
      }
      const bbox = tile.bbox.map(Number);
      const [x0, y0, x1, y1] = bbox;
      if (
        bbox.some((value) => !Number.isFinite(value)) ||
        x0 < -tolerance || y0 < -tolerance || x1 > width + tolerance || y1 > height + tolerance ||
        x1 <= x0 || y1 <= y0 || Math.abs(x0) > tolerance || Math.abs(x1 - width) > tolerance ||
        y0 > coveredTo + tolerance || y1 <= coveredTo + tolerance / 10
      ) {
        fail("OCR_VISUAL_RENDER_COVERAGE", "Visual adjudication tile bboxes do not continuously cover the page.", {
          page_index: page.index,
          tile_index: position,
        });
      }
      const descriptor = inspectImageBytes(tile.buffer, {
        context: `visual adjudication page ${page.index} tile ${position}`,
      });
      if (
        !SHA256_RE.test(String(tile.image_sha256 || "")) ||
        tile.image_sha256 !== descriptor.image_sha256 ||
        tile.media_type !== descriptor.media_type ||
        tile.width !== descriptor.width || tile.height !== descriptor.height
      ) {
        fail("OCR_VISUAL_RENDER_INVALID", "Visual adjudication tile bytes, dimensions, or hash do not match.", {
          page_index: page.index,
          tile_index: position,
        });
      }
      const bboxAspect = (x1 - x0) / (y1 - y0);
      const pixelAspect = descriptor.width / descriptor.height;
      const aspectError = Math.abs(pixelAspect - bboxAspect) / bboxAspect;
      if (!Number.isFinite(aspectError) || aspectError > 0.05) {
        fail("OCR_VISUAL_RENDER_GEOMETRY", "Visual adjudication tile pixels do not match their bbox geometry.", {
          page_index: page.index,
          tile_index: position,
        });
      }
      coveredTo = Math.max(coveredTo, y1);
    }
    if (coveredTo < height - tolerance) {
      fail("OCR_VISUAL_RENDER_COVERAGE", "Visual adjudication tiles do not reach the bottom of the page.", {
        page_index: page.index,
        covered_to: coveredTo,
        page_height: height,
      });
    }
  }
  return rendered;
}

async function mistralRiskVisualAdjudicator({
  summary,
  evidence,
  renderedPages,
  inputDigest,
  signal,
  fetchImpl = globalThis.fetch,
  apiKey = String(process.env.MISTRAL_API_KEY || ""),
  apiSemaphore,
  resourceLimits,
  sleepImpl = (milliseconds, { signal: waitSignal } = {}) => new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(waitSignal.reason || new Error("OCR visual adjudication aborted."));
    };
    timer = setTimeout(() => {
      waitSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (waitSignal?.aborted) onAbort();
    else waitSignal?.addEventListener("abort", onAbort, { once: true });
  }),
} = {}) {
  if (!apiKey) {
    fail("OCR_VISUAL_ADJUDICATOR_UNAVAILABLE", "MISTRAL_API_KEY is required for OCR visual adjudication.");
  }
  const model = process.env.PDF_OCR_RISK_VISUAL_MODEL || "mistral-medium-3-5";
  const lowTokens = (summary?.risk_tokens || [])
    .filter((token) => token.needs_visual_adjudication)
    .map((token) => ({
      page_index: token.page_index,
      block_order: token.block_order,
      type: token.type,
      token_sha256: token.token_sha256,
    }));
  const blockMap = new Map();
  const claims = lowTokens.map((token) => {
    const page = evidence?.pages?.[token.page_index];
    const block = page?.blocks?.find((item) => item.order === token.block_order);
    if (!block || typeof block.content !== "string") {
      fail("OCR_VISUAL_ADJUDICATOR_INPUT_INVALID", "Low-confidence OCR token has no source block.");
    }
    const blockKey = `${token.page_index}:${token.block_order}`;
    if (!blockMap.has(blockKey)) {
      blockMap.set(blockKey, {
        page_index: token.page_index,
        block_order: token.block_order,
        ocr_block_text: block.content,
        ocr_block_bbox: block.bbox,
      });
    }
    return { ...token, block_key: blockKey };
  });
  const blocks = [...blockMap.values()].sort((left, right) => (
    left.page_index - right.page_index || left.block_order - right.block_order
  ));
  const expectedHashes = [...new Set(lowTokens.map((token) => token.token_sha256))].sort();
  const content = [{
    type: "text",
    text: [
      "Independently inspect the attached SOURCE scan pages and verify the low-confidence OCR claims.",
      "For each claim, follow block_key to its OCR block and compare every number, unit, identifier, URL, formula, and chemical formula with the pixels inside/near ocr_block_bbox.",
      "Pass only if every claimed risky literal is visually exact. Any ambiguity, mismatch, missing region, or unreadable value is fail.",
      "Return one JSON object only, with no markdown or explanation.",
      'Shape: {"verdict":"pass|fail","input_digest":"...","token_hashes":["..."]}',
      "On pass, copy every expected token hash exactly. On fail, token_hashes must be an empty array.",
      `Binding: ${canonicalJson({ input_digest: inputDigest, claims, blocks, expected_token_hashes: expectedHashes })}`,
    ].join("\n"),
  }];
  for (const page of renderedPages || []) {
    content.push({ type: "text", text: `SOURCE page ${page.index + 1}` });
    for (const tile of page.tiles || []) {
      content.push({
        type: "image_url",
        image_url: `data:${tile.media_type};base64,${tile.buffer.toString("base64")}`,
      });
    }
  }
  const baseUrl = String(process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1").replace(/\/$/, "");
  const limits = resourceLimits || getProcessWidePdfTranslateResourceLimits();
  const runApi = apiSemaphore?.run
    ? (task) => apiSemaphore.run(task, { signal })
    : (task) => limits.runApi(task, { signal });
  let response = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await runApi(() => fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      }),
      signal,
    }));
    if (![429, 500, 502, 503, 504, 529].includes(response.status) || attempt === 3) break;
    try { await response.arrayBuffer(); } catch {}
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(30000, retryAfter * 1000)
      : Math.min(10000, 800 * 2 ** (attempt - 1));
    await sleepImpl(delay, { signal });
  }
  const raw = await response.text();
  if (!response.ok) {
    fail("OCR_VISUAL_ADJUDICATOR_HTTP_ERROR", `OCR visual adjudicator returned HTTP ${response.status}.`, {
      status: response.status,
      response_sha256: sha256Hex(raw),
    });
  }
  let payload;
  let verdict;
  try {
    payload = JSON.parse(raw);
    verdict = JSON.parse(String(payload.choices?.[0]?.message?.content || ""));
  } catch {
    fail("OCR_VISUAL_ADJUDICATOR_RESPONSE_INVALID", "OCR visual adjudicator returned invalid JSON.", {
      response_sha256: sha256Hex(raw),
    });
  }
  const requestId = response.headers?.get?.("x-request-id") ||
    response.headers?.get?.("request-id") || payload.id;
  if (
    !requestId ||
    verdict?.input_digest !== inputDigest ||
    !["pass", "fail"].includes(verdict?.verdict)
  ) {
    fail("OCR_VISUAL_ADJUDICATOR_RESPONSE_INVALID", "OCR visual adjudicator response is not bound to its input.");
  }
  return {
    verdict: verdict.verdict,
    provider: "mistral",
    model,
    request_id: String(requestId),
    input_digest: inputDigest,
    token_hashes: verdict.verdict === "pass" ? verdict.token_hashes : [],
  };
}

async function prepareStrictScanOcr({
  pdfBuffer,
  hiddenOcrPageTexts = null,
  signal,
  visualAdjudicator = null,
  visualBatchLimits = null,
  ocrClient = ocrPdfToEvidenceStrict,
  sourcePageInspector = inspectPdfSourcePages,
  renderPageProvider = renderOcrAdjudicationPages,
} = {}) {
  const sourcePages = await sourcePageInspector(pdfBuffer, { signal });
  if (!Array.isArray(sourcePages) || !sourcePages.length) {
    fail("OCR_SOURCE_PAGE_INSPECTION_INVALID", "Strict OCR has no source page geometry.");
  }
  let visualAdjudicationInputSha256 = null;
  const wrappedVisual = typeof visualAdjudicator === "function"
    ? async (summary, evidence) => {
        const requested = [...new Set(
          summary.risk_tokens
            .filter((token) => token.needs_visual_adjudication)
            .map((token) => token.page_index),
        )].sort((a, b) => a - b);
        if (!requested.length) {
          fail("OCR_VISUAL_ADJUDICATION_INPUT_MISSING", "Visual adjudication has no risky pages.");
        }
        const batchLimits = riskVisualBatchLimits(visualBatchLimits || {});
        const renderQueue = [];
        for (let offset = 0; offset < requested.length; offset += batchLimits.pages) {
          renderQueue.push(requested.slice(offset, offset + batchLimits.pages));
        }
        const renderedCommitments = [];
        const batches = [];
        let provider = null;
        let model = null;
        for (let queueIndex = 0; queueIndex < renderQueue.length; queueIndex += 1) {
          const indices = renderQueue[queueIndex];
          const renderedPages = validateRenderedAdjudicationPages(
            await renderPageProvider(pdfBuffer, indices, { signal }),
            indices,
            sourcePages,
          );
          try {
            assertRiskVisualBatchBudget(renderedPages, batchLimits);
          } catch (error) {
            if (error?.code === "OCR_VISUAL_ADJUDICATION_BATCH_LIMIT" && indices.length > 1) {
              const middle = Math.ceil(indices.length / 2);
              renderQueue.splice(
                queueIndex,
                1,
                indices.slice(0, middle),
                indices.slice(middle),
              );
              queueIndex -= 1;
              continue;
            }
            throw error;
          }
          // Capture the trusted byte-derived descriptors before an injected/model
          // callback can mutate the renderer-owned objects. Final attestation is
          // built only from this immutable-by-ownership snapshot.
          const renderedCommitmentSnapshot = renderedPageCommitments(renderedPages);
          const pageSet = new Set(indices);
          const pageRiskTokens = summary.risk_tokens.filter(
            (token) => token.needs_visual_adjudication && pageSet.has(token.page_index),
          );
          for (let tokenOffset = 0; tokenOffset < pageRiskTokens.length; tokenOffset += batchLimits.tokens) {
            const riskTokens = pageRiskTokens.slice(tokenOffset, tokenOffset + batchLimits.tokens);
            const tokenPageSet = new Set(riskTokens.map((token) => token.page_index));
            const tokenRenderedPages = renderedPages.filter((page) => tokenPageSet.has(page.index));
            const tokenRenderedCommitments = renderedCommitmentSnapshot.filter(
              (page) => tokenPageSet.has(page.index),
            );
            const batchSummary = { ...summary, risk_tokens: riskTokens };
            const binding = visualAdjudicationInput(
              batchSummary,
              pdfBuffer,
              sourcePages,
              tokenRenderedCommitments,
            );
            const result = await visualAdjudicator({
              summary: batchSummary,
              evidence,
              sourcePdf: pdfBuffer,
              sourcePages,
              renderedPages: tokenRenderedPages,
              adjudicationInput: structuredClone(binding.input),
              inputDigest: binding.inputDigest,
              signal,
            });
            const revalidatedRenderedPages = validateRenderedAdjudicationPages(
              tokenRenderedPages,
              [...tokenPageSet].sort((left, right) => left - right),
              sourcePages,
            );
            if (
              canonicalJson(renderedPageCommitments(revalidatedRenderedPages)) !==
              canonicalJson(tokenRenderedCommitments)
            ) {
              fail(
                "OCR_VISUAL_ADJUDICATION_RENDER_MUTATED",
                "Visual adjudication callback changed trusted source-render bytes or geometry.",
              );
            }
            const expectedHashes = [...new Set(
              batchSummary.risk_tokens.map((token) => token.token_sha256),
            )].sort();
            const coveredHashes = Array.isArray(result?.token_hashes)
              ? [...new Set(result.token_hashes.map(String))].sort()
              : [];
            const resultProvider = String(result?.provider || "").trim();
            const resultModel = String(result?.model || "").trim();
            const requestId = String(result?.request_id || "").trim();
            if (
              result?.verdict !== "pass" ||
              result?.input_digest !== binding.inputDigest ||
              !resultProvider || !resultModel || !requestId ||
              canonicalJson(coveredHashes) !== canonicalJson(expectedHashes)
            ) {
              fail(
                "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH",
                "Visual adjudication batch is not exactly bound to its risky pages and tokens.",
                { expected_input_digest: binding.inputDigest, page_indices: [...tokenPageSet] },
              );
            }
            if (provider == null) {
              provider = resultProvider;
              model = resultModel;
            } else if (provider !== resultProvider || model !== resultModel) {
              fail(
                "OCR_VISUAL_ADJUDICATION_PROVIDER_MISMATCH",
                "Visual adjudication provider or model changed between batches.",
              );
            }
            batches.push({
              request_id: requestId,
              input_digest: binding.inputDigest,
              page_indices: [...tokenPageSet].sort((left, right) => left - right),
              token_hashes: coveredHashes,
            });
          }
          renderedCommitments.push(...renderedCommitmentSnapshot);
        }
        const binding = visualAdjudicationInput(
          summary,
          pdfBuffer,
          sourcePages,
          renderedCommitments,
        );
        const requestId = batches.length === 1
          ? batches[0].request_id
          : `batch-${digest(batches)}`;
        const renderAttestation = sealValidatedVisualRenderCommitment({
          sourcePdf: pdfBuffer,
          inputCommitment: binding.input,
          inputDigest: binding.inputDigest,
          adjudicator: { provider, model, request_id: requestId },
        });
        const tokenHashes = [...new Set(
          batches.flatMap((batch) => batch.token_hashes),
        )].sort();
        visualAdjudicationInputSha256 = binding.inputDigest;
        return {
          verdict: "pass",
          provider,
          model,
          request_id: requestId,
          input_digest: binding.inputDigest,
          token_hashes: tokenHashes,
          input_commitment: binding.input,
          render_attestation: renderAttestation,
        };
      }
    : undefined;
  const evidence = await ocrClient(pdfBuffer, {
    signal,
    sourcePages,
    hiddenOcrPageTexts,
    visualAdjudicator: wrappedVisual,
  });
  validateCanonicalOcrEvidence(evidence, { sourcePdf: pdfBuffer });
  const evidenceVisualInputSha256 = evidence.needs_visual_adjudication
    ? evidence.visual_adjudication && evidence.visual_adjudication.input_digest
    : null;
  if (evidence.needs_visual_adjudication) {
    if (!SHA256_RE.test(String(visualAdjudicationInputSha256 || ""))) {
      fail(
        "OCR_VISUAL_ADJUDICATION_INPUT_MISSING",
        "Low-confidence OCR evidence has no rendered-input adjudication binding.",
      );
    }
    if (evidenceVisualInputSha256 !== visualAdjudicationInputSha256) {
      fail(
        "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH",
        "Canonical OCR evidence is not bound to the rendered visual adjudication input.",
        {
          expected_input_digest: visualAdjudicationInputSha256,
          evidence_input_digest: evidenceVisualInputSha256 || null,
        },
      );
    }
    validateVisualRenderAttestation(evidence.visual_adjudication, {
      sourcePdf: pdfBuffer,
    });
  } else if (visualAdjudicationInputSha256 !== null) {
    fail(
      "OCR_VISUAL_ADJUDICATION_INPUT_UNEXPECTED",
      "OCR evidence without low-confidence risk has a stale visual adjudication binding.",
    );
  }
  return {
    evidence,
    pageTexts: canonicalOcrPageTexts(evidence),
    sourcePages,
    visualAdjudicationInputSha256,
  };
}

function buildOcrRenderManifest({
  sourcePdf,
  pageCount,
  rasterFiles,
  rasterPages,
  tileBuffers,
  modelInputBlocks,
  modelInputProofs,
  pageOffset = 0,
  expectedLocalPages = null,
  visualAdjudicationInputSha256 = null,
} = {}) {
  if (!Buffer.isBuffer(sourcePdf) || !sourcePdf.length || !Number.isInteger(pageCount) || pageCount < 1) {
    fail("OCR_RENDER_MANIFEST_INVALID", "Render manifest needs source PDF bytes and page count.");
  }
  if (
    !Array.isArray(rasterFiles) || !Array.isArray(tileBuffers) ||
    !Array.isArray(rasterPages) || !rasterPages.length ||
    !Array.isArray(modelInputBlocks) || rasterFiles.length !== tileBuffers.length ||
    !Array.isArray(modelInputProofs) ||
    rasterFiles.length !== modelInputBlocks.length ||
    rasterFiles.length !== modelInputProofs.length || !rasterFiles.length
  ) {
    fail("OCR_RENDER_MANIFEST_INVALID", "Raster geometry, raw files, and exact model input blocks are incomplete.");
  }
  if (!Number.isInteger(pageOffset) || pageOffset < 0) {
    fail("OCR_RENDER_PAGE_COVERAGE", "Raster page offset must be a zero-based integer.");
  }
  const localCount = expectedLocalPages == null ? rasterPages.length : expectedLocalPages;
  if (!Number.isInteger(localCount) || localCount < 1) {
    fail("OCR_RENDER_PAGE_COVERAGE", "Raster local page count is invalid.");
  }
  const expected = Array.from({ length: localCount }, (_, index) => pageOffset + index);
  const actualLocal = rasterPages.map((page) => page && page.index);
  const expectedLocal = Array.from({ length: localCount }, (_, index) => index);
  if (canonicalJson(actualLocal) !== canonicalJson(expectedLocal)) {
    fail("OCR_RENDER_PAGE_COVERAGE", "Raster output does not cover every expected page.", {
      expected_indices: expectedLocal,
      actual_indices: actualLocal,
    });
  }
  let flatPosition = 0;
  const pages = rasterPages.map((rasterPage) => {
    if (
      !rasterPage || typeof rasterPage !== "object" || Array.isArray(rasterPage) ||
      canonicalJson(Object.keys(rasterPage).sort()) !==
        canonicalJson(["height", "index", "rotation", "tiles", "width"].sort()) ||
      !Number.isFinite(rasterPage.width) || !Number.isFinite(rasterPage.height) ||
      !Array.isArray(rasterPage.tiles) || !rasterPage.tiles.length
    ) {
      fail("OCR_RENDER_PAGE_GEOMETRY", "Raster page metadata is incomplete.", {
        page_index: rasterPage && rasterPage.index,
      });
    }
    const pageIndex = pageOffset + rasterPage.index;
    if (pageIndex < 0 || pageIndex >= pageCount) {
      fail("OCR_RENDER_PAGE_COVERAGE", "Raster page index is outside the source PDF.", {
        page_index: pageIndex,
      });
    }
    const tiles = rasterPage.tiles.map((rasterTile, tilePosition) => {
      if (
        !rasterTile || typeof rasterTile !== "object" || Array.isArray(rasterTile) ||
        canonicalJson(Object.keys(rasterTile).sort()) !==
          canonicalJson(["bbox", "file", "height", "index", "width"].sort()) ||
        rasterTile.index !== tilePosition ||
        !Array.isArray(rasterTile.bbox) || rasterTile.bbox.length !== 4 ||
        rasterTile.bbox.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(rasterTile.width) || !Number.isFinite(rasterTile.height) ||
        typeof rasterTile.file !== "string" ||
        path.resolve(rasterTile.file) !== path.resolve(String(rasterFiles[flatPosition] || "")) ||
        !Buffer.isBuffer(tileBuffers[flatPosition]) || !tileBuffers[flatPosition].length
      ) {
        fail("OCR_RENDER_TILE_COVERAGE", "Raster tile order, file identity, or bytes are invalid.", {
          page_index: pageIndex,
          tile_index: tilePosition,
        });
      }
      const match = /^p-(\d+)-(\d+)\.png$/i.exec(path.basename(rasterTile.file));
      if (!match || Number(match[1]) !== rasterPage.index || Number(match[2]) !== tilePosition) {
        fail("OCR_RENDER_TILE_COVERAGE", "Raster filename does not match its page/tile position.", {
          page_index: pageIndex,
          tile_index: tilePosition,
        });
      }
      const raw = inspectImageBytes(tileBuffers[flatPosition], {
        mediaType: "image/png",
        context: `raw raster tile ${flatPosition}`,
      });
      if (raw.width !== rasterTile.width || raw.height !== rasterTile.height) {
        fail("OCR_RENDER_TILE_GEOMETRY", "Raster metadata dimensions differ from the raw PNG bytes.", {
          page_index: pageIndex,
          tile_index: tilePosition,
        });
      }
      const modelInput = decodeModelInputBlock(
        modelInputBlocks[flatPosition],
        flatPosition,
      ).descriptor;
      const preparationProof = validatePreparationProof(
        modelInputProofs[flatPosition],
        { position: flatPosition, raw, modelInput },
      );
      flatPosition += 1;
      return {
        index: tilePosition,
        bbox: rasterTile.bbox,
        raw,
        model_input: modelInput,
        transform: createManifestTransformProof({
          pageIndex,
          tileIndex: tilePosition,
          bbox: rasterTile.bbox,
          options: preparationProof.options,
          raw,
          modelInput,
        }),
      };
    });
    const page = {
      index: pageIndex,
      width: Number(rasterPage.width),
      height: Number(rasterPage.height),
      rotation: normalizePageRotation(rasterPage.rotation, { page_index: pageIndex }),
      tile_count: tiles.length,
      tiles,
    };
    validatePageTileGeometry(page);
    return page;
  });
  if (flatPosition !== rasterFiles.length) {
    fail("OCR_RENDER_TILE_COVERAGE", "Raster geometry does not account for every raw/model-input tile.", {
      expected_tiles: rasterFiles.length,
      actual_tiles: flatPosition,
    });
  }
  const manifest = {
    schema_version: OCR_RENDER_MANIFEST_SCHEMA_VERSION,
    source_pdf_sha256: sha256Hex(sourcePdf),
    page_count: pageCount,
    page_range: { start: expected[0], end: expected[expected.length - 1] },
    visual_adjudication_input_sha256: visualAdjudicationInputSha256,
    pages,
  };
  manifest.manifest_sha256 = digest(manifest);
  return validateOcrRenderManifest(manifest, {
    sourcePdf,
    pageCount,
    expectedPageIndices: expected,
    rawTileBuffers: tileBuffers,
    modelInputBlocks,
    allowPartial: true,
  });
}

function mergeOcrRenderManifests({ sourcePdf, pageCount, manifests } = {}) {
  if (!Array.isArray(manifests) || !manifests.length) {
    fail("OCR_RENDER_MANIFEST_INVALID", "No OCR render manifests were supplied.");
  }
  const validated = manifests.map((manifest) => validateOcrRenderManifest(manifest, {
    sourcePdf,
    pageCount,
    allowPartial: true,
  }));
  const adjudicationDigests = new Set(
    validated.map((manifest) => manifest.visual_adjudication_input_sha256),
  );
  if (adjudicationDigests.size !== 1) {
    fail(
      "OCR_RENDER_ADJUDICATION_MISMATCH",
      "OCR chunk manifests are not bound to the same visual adjudication input.",
    );
  }
  for (let index = 0; index < validated.length; index += 1) {
    const manifest = validated[index];
    const expectedStart = index === 0
      ? 0
      : validated[index - 1].page_range.end + 1;
    if (manifest.page_range.start !== expectedStart) {
      fail(
        "OCR_RENDER_PAGE_COVERAGE",
        "OCR chunk manifests must arrive in exact contiguous source-page order.",
        { manifest_index: index, expected_start: expectedStart, actual_start: manifest.page_range.start },
      );
    }
  }
  const pages = validated.flatMap((manifest) => manifest.pages);
  const merged = {
    schema_version: OCR_RENDER_MANIFEST_SCHEMA_VERSION,
    source_pdf_sha256: sha256Hex(sourcePdf),
    page_count: pageCount,
    page_range: { start: 0, end: pageCount - 1 },
    visual_adjudication_input_sha256: validated[0].visual_adjudication_input_sha256,
    pages,
  };
  merged.manifest_sha256 = digest(merged);
  return validateOcrRenderManifest(merged, { sourcePdf, pageCount });
}

function validateOcrRenderManifest(manifest, {
  sourcePdf,
  pageCount,
  expectedPageIndices = null,
  rawTileBuffers = null,
  modelInputBlocks = null,
  allowPartial = false,
} = {}) {
  if (!Buffer.isBuffer(sourcePdf) || !sourcePdf.length || !Number.isInteger(pageCount) || pageCount < 1) {
    fail("OCR_RENDER_MANIFEST_INVALID", "OCR render validation needs source PDF bytes and page count.");
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("OCR_RENDER_MANIFEST_INVALID", "OCR render manifest is missing.");
  }
  const keys = Object.keys(manifest).sort();
  const wanted = [
    "schema_version",
    "source_pdf_sha256",
    "page_count",
    "page_range",
    "visual_adjudication_input_sha256",
    "pages",
    "manifest_sha256",
  ].sort();
  if (canonicalJson(keys) !== canonicalJson(wanted) || manifest.schema_version !== OCR_RENDER_MANIFEST_SCHEMA_VERSION) {
    fail("OCR_RENDER_MANIFEST_INVALID", "OCR render manifest schema is invalid.");
  }
  const expectedDigest = sha256Hex(sourcePdf);
  if (manifest.source_pdf_sha256 !== expectedDigest || manifest.page_count !== pageCount) {
    fail("OCR_RENDER_SOURCE_MISMATCH", "OCR render manifest is bound to another source/page count.");
  }
  if (
    !manifest.page_range || typeof manifest.page_range !== "object" || Array.isArray(manifest.page_range) ||
    canonicalJson(Object.keys(manifest.page_range).sort()) !== canonicalJson(["end", "start"]) ||
    !Number.isInteger(manifest.page_range.start) || !Number.isInteger(manifest.page_range.end) ||
    manifest.page_range.start < 0 || manifest.page_range.end < manifest.page_range.start ||
    manifest.page_range.end >= pageCount
  ) {
    fail("OCR_RENDER_PAGE_COVERAGE", "OCR render manifest page_range is invalid.");
  }
  if (
    manifest.visual_adjudication_input_sha256 !== null &&
    !SHA256_RE.test(String(manifest.visual_adjudication_input_sha256 || ""))
  ) {
    fail("OCR_RENDER_ADJUDICATION_MISMATCH", "Visual adjudication input digest is invalid.");
  }
  const declared = Array.from(
    { length: manifest.page_range.end - manifest.page_range.start + 1 },
    (_, index) => manifest.page_range.start + index,
  );
  const expected = expectedPageIndices == null
    ? allowPartial
      ? declared
      : Array.from({ length: pageCount }, (_, index) => index)
    : canonicalPageIndices(expectedPageIndices, "expectedPageIndices");
  if (canonicalJson(declared) !== canonicalJson(expected)) {
    fail("OCR_RENDER_PAGE_COVERAGE", "OCR render manifest page_range differs from expected pages.", {
      declared_indices: declared,
      expected_indices: expected,
    });
  }
  const actual = Array.isArray(manifest.pages) ? manifest.pages.map((page) => page.index) : [];
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail("OCR_RENDER_PAGE_COVERAGE", "OCR render manifest does not cover every source page exactly once.", {
      expected_indices: expected,
      actual_indices: actual,
    });
  }
  for (const page of manifest.pages) {
    if (
      canonicalJson(Object.keys(page).sort()) !==
      canonicalJson(["height", "index", "rotation", "tile_count", "tiles", "width"].sort())
    ) {
      fail("OCR_RENDER_MANIFEST_INVALID", "OCR render page schema is invalid.", {
        page_index: page.index,
      });
    }
    if (!Number.isInteger(page.tile_count) || page.tile_count < 1 || !Array.isArray(page.tiles) || page.tiles.length !== page.tile_count) {
      fail("OCR_RENDER_TILE_COVERAGE", "OCR render page has incomplete tiles.", { page_index: page.index });
    }
    page.tiles.forEach((tile, position) => {
      if (
        !tile || typeof tile !== "object" || Array.isArray(tile) ||
        canonicalJson(Object.keys(tile).sort()) !==
          canonicalJson(["bbox", "index", "model_input", "raw", "transform"].sort()) ||
        tile.index !== position
      ) {
        fail("OCR_RENDER_TILE_COVERAGE", "OCR render tile metadata is invalid.", { page_index: page.index });
      }
      for (const [name, descriptor] of [["raw", tile.raw], ["model_input", tile.model_input]]) {
        if (
          !descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
          canonicalJson(Object.keys(descriptor).sort()) !==
            canonicalJson(["height", "image_sha256", "media_type", "width"].sort()) ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(descriptor.media_type) ||
          !Number.isFinite(descriptor.width) || descriptor.width <= 0 ||
          !Number.isFinite(descriptor.height) || descriptor.height <= 0 ||
          !SHA256_RE.test(String(descriptor.image_sha256 || ""))
        ) {
          fail("OCR_RENDER_TILE_COVERAGE", `OCR render ${name} tile descriptor is invalid.`, {
            page_index: page.index,
            tile_index: position,
          });
        }
      }
      if (tile.raw.media_type !== "image/png") {
        fail("OCR_RENDER_TILE_COVERAGE", "Raw OCR raster tile must remain PNG.", {
          page_index: page.index,
          tile_index: position,
        });
      }
      validateManifestTransformProof(tile.transform, {
        pageIndex: page.index,
        tileIndex: position,
        bbox: tile.bbox,
        raw: tile.raw,
        modelInput: tile.model_input,
      });
    });
    validatePageTileGeometry(page);
  }
  const { manifest_sha256: seal, ...unsigned } = manifest;
  if (seal !== digest(unsigned)) {
    fail("OCR_RENDER_MANIFEST_SEAL", "OCR render manifest seal does not match its payload.");
  }
  const flattened = manifest.pages.flatMap((page) => page.tiles);
  if (rawTileBuffers != null) {
    if (!Array.isArray(rawTileBuffers) || rawTileBuffers.length !== flattened.length) {
      fail("OCR_RENDER_RAW_INPUT_MISMATCH", "Raw crop tile count differs from the sealed manifest.");
    }
    rawTileBuffers.forEach((buffer, position) => {
      const descriptor = inspectImageBytes(buffer, {
        mediaType: "image/png",
        context: `raw crop tile ${position}`,
      });
      if (!descriptorMatches(descriptor, flattened[position].raw)) {
        fail("OCR_RENDER_RAW_INPUT_MISMATCH", "Raw crop tile bytes differ from the sealed manifest.", {
          position,
        });
      }
    });
  }
  if (modelInputBlocks != null) {
    if (!Array.isArray(modelInputBlocks) || modelInputBlocks.length !== flattened.length) {
      fail("OCR_RENDER_MODEL_INPUT_MISMATCH", "Model input image count differs from the sealed manifest.");
    }
    modelInputBlocks.forEach((block, position) => {
      const { descriptor } = decodeModelInputBlock(block, position);
      if (!descriptorMatches(descriptor, flattened[position].model_input)) {
        fail("OCR_RENDER_MODEL_INPUT_MISMATCH", "Model input image bytes differ from the sealed manifest.", {
          position,
        });
      }
    });
  }
  return manifest;
}

module.exports = {
  OCR_RENDER_MANIFEST_SCHEMA_VERSION,
  OcrRoutingError,
  buildOcrRenderManifest,
  canonicalOcrPageTexts,
  inspectPdfSourcePages,
  mergeOcrRenderManifests,
  mistralRiskVisualAdjudicator,
  prepareOcrModelInputs,
  prepareStrictScanOcr,
  renderOcrAdjudicationPages,
  validateRenderedAdjudicationPages,
  validateOcrRenderManifest,
  validateVisualRenderAttestation,
  visualAdjudicationInput,
};
