"use strict";

// Bind strict OCR source truth, independent semantic judgment, and the text
// actually extractable from the final PDF.  This wrapper intentionally keeps
// raw passages in memory only; persisted/verifier-facing summaries contain
// hashes and stable segment/page identifiers.

const {
  canonicalJson,
  sha256Canonical,
  sha256Hex,
} = require("./invariants");
const {
  bindTargetSegment,
  hashArtifact,
  prepareSourceSegment,
  providerFamily,
  sealRetypesetEvidence,
  validateRetypesetEvidence,
} = require("./provenance");
const {
  buildSemanticJudgeRequest,
  judgeSemanticSegments,
} = require("./semantic-judge");
const { validateCanonicalOcrEvidence } = require("./mistral-ocr");
const { extractPageTexts } = require("./pdf-tool");
const {
  inspectPdfSourcePages,
  renderOcrAdjudicationPages,
  validateRenderedAdjudicationPages,
  validateOcrRenderManifest,
} = require("./ocr-routing");
const fs = require("node:fs");
const fsp = fs.promises;
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const {
  getProcessWidePdfTranslateResourceLimits,
} = require("./resource-gate");

const OCR_SEMANTIC_REVIEW_SCHEMA_VERSION = 1;
const OCR_SEMANTIC_REVIEW_TASK = "ocr-retypeset-semantic-review";
const REVIEW_KEYS = Object.freeze([
  "schema_version",
  "task",
  "ocr_evidence_sha256",
  "retypeset_evidence",
  "layout_template",
  "segments",
  "figures",
  "translation_provider",
  "semantic_batches",
  "semantic_judge_attestation",
  "visual_review",
  "review_binding_sha256",
]);
const SEGMENT_INPUT_KEYS = Object.freeze(["prepared", "bound", "source_text"]);
const DEFAULT_LAYOUT_TEMPLATE = Buffer.from("quilo-ocr-retypeset-page-layout-v1", "utf8");
const OCR_VISUAL_REVIEW_TASK = "ocr-retypeset-nontext-visual-review";
const OCR_VISUAL_JUDGE_ATTESTATION_SCHEMA_VERSION = 1;
const OCR_VISUAL_JUDGE_ATTESTATION_KEY = crypto.randomBytes(32);
const OCR_SEMANTIC_JUDGE_ATTESTATION_SCHEMA_VERSION = 1;
const OCR_SEMANTIC_JUDGE_ATTESTATION_KEY = crypto.randomBytes(32);
const VISUAL_RESPONSE_ITEM_KEYS = Object.freeze([
  "page",
  "source_tiles_digest",
  "output_tiles_digest",
  "verdict",
  "nontext_preserved",
  "no_missing_figures",
  "no_added_figures",
  "all_source_text_covered",
  "text_meaning_preserved",
  "target_language_korean",
  "no_added_text",
]);

class OcrSemanticReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OcrSemanticReviewError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new OcrSemanticReviewError(code, message, details);
}

function secureSha256Equal(left, right) {
  if (
    !/^[a-f0-9]{64}$/.test(String(left || "")) ||
    !/^[a-f0-9]{64}$/.test(String(right || ""))
  ) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function visualJudgeAttestationPayload(review, intent) {
  return {
    schema_version: OCR_VISUAL_JUDGE_ATTESTATION_SCHEMA_VERSION,
    proof_type: "ocr-visual-judge-review-attestation",
    task: OCR_VISUAL_REVIEW_TASK,
    intent,
    provider: review.provider,
    model: review.model,
    request_id: review.request_id,
    source_pdf_sha256: review.source_pdf_sha256,
    output_pdf_sha256: review.output_pdf_sha256,
    ocr_evidence_sha256: review.ocr_evidence_sha256,
    ocr_render_manifest_sha256: review.ocr_render_manifest_sha256,
    input_digest: review.input_digest,
    batches_sha256: sha256Canonical(review.batches),
    pages_sha256: sha256Canonical(review.pages),
  };
}

function issueVisualJudgeAttestation(review, intent) {
  const payload = visualJudgeAttestationPayload(review, intent);
  return {
    ...payload,
    binding_hmac_sha256: crypto
      .createHmac("sha256", OCR_VISUAL_JUDGE_ATTESTATION_KEY)
      .update(Buffer.from(canonicalJson(payload), "utf8"))
      .digest("hex"),
  };
}

function validateVisualJudgeAttestation(review, intent) {
  const proof = review && review.judge_attestation;
  const payload = visualJudgeAttestationPayload(review, intent);
  assertExactKeys(
    proof,
    [...Object.keys(payload), "binding_hmac_sha256"],
    "ocr_semantic_review.visual_review.judge_attestation",
  );
  const expected = crypto
    .createHmac("sha256", OCR_VISUAL_JUDGE_ATTESTATION_KEY)
    .update(Buffer.from(canonicalJson(payload), "utf8"))
    .digest("hex");
  const suppliedPayload = { ...proof };
  delete suppliedPayload.binding_hmac_sha256;
  if (
    canonicalJson(suppliedPayload) !== canonicalJson(payload) ||
    !secureSha256Equal(proof.binding_hmac_sha256, expected)
  ) {
    fail(
      "OCR_VISUAL_REVIEW_ATTESTATION_INVALID",
      "Visual review was not attested at the trusted independent-judge boundary",
    );
  }
  return proof;
}

function semanticJudgeAttestationPayload({
  retypesetEvidence,
  ocrEvidenceSha256,
  ocrRenderManifestSha256,
  semanticBatches,
}) {
  return {
    schema_version: OCR_SEMANTIC_JUDGE_ATTESTATION_SCHEMA_VERSION,
    proof_type: "ocr-semantic-judge-review-attestation",
    task: OCR_SEMANTIC_REVIEW_TASK,
    intent: "translate",
    source_pdf_sha256: retypesetEvidence.source_pdf_sha256,
    output_pdf_sha256: retypesetEvidence.output_pdf_sha256,
    ocr_evidence_sha256: ocrEvidenceSha256,
    ocr_render_manifest_sha256: ocrRenderManifestSha256,
    translation_provider: retypesetEvidence.translation.provider,
    judge_provider: retypesetEvidence.judge.provider,
    judge_model: retypesetEvidence.judge.model,
    judge_request_id: retypesetEvidence.judge.request_id,
    judge_input_digest: retypesetEvidence.judge.input_digest,
    judge_items_sha256: sha256Canonical(retypesetEvidence.judge.items),
    semantic_batches_sha256: sha256Canonical(semanticBatches),
  };
}

function issueSemanticJudgeAttestation(context) {
  const payload = semanticJudgeAttestationPayload(context);
  return {
    ...payload,
    binding_hmac_sha256: crypto
      .createHmac("sha256", OCR_SEMANTIC_JUDGE_ATTESTATION_KEY)
      .update(Buffer.from(canonicalJson(payload), "utf8"))
      .digest("hex"),
  };
}

function validateSemanticJudgeAttestation(proof, context) {
  const payload = semanticJudgeAttestationPayload(context);
  assertExactKeys(
    proof,
    [...Object.keys(payload), "binding_hmac_sha256"],
    "ocr_semantic_review.semantic_judge_attestation",
  );
  const suppliedPayload = { ...proof };
  delete suppliedPayload.binding_hmac_sha256;
  const expected = crypto
    .createHmac("sha256", OCR_SEMANTIC_JUDGE_ATTESTATION_KEY)
    .update(Buffer.from(canonicalJson(payload), "utf8"))
    .digest("hex");
  if (
    canonicalJson(suppliedPayload) !== canonicalJson(payload) ||
    !secureSha256Equal(proof.binding_hmac_sha256, expected)
  ) {
    fail(
      "OCR_SEMANTIC_REVIEW_ATTESTATION_INVALID",
      "Semantic review was not attested at the trusted independent-judge boundary",
    );
  }
  return proof;
}

function assertExactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("OCR_SEMANTIC_REVIEW_SCHEMA_INVALID", `${path} must be an object`, { path });
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail("OCR_SEMANTIC_REVIEW_SCHEMA_INVALID", `${path} has missing or unexpected fields`, {
      path,
      expected_field_count: wanted.length,
      actual_field_count: actual.length,
    });
  }
}

function normalizeOcrReviewText(value) {
  if (typeof value !== "string") {
    throw new TypeError("OCR review text must be a string");
  }
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

const OCR_PROSE_BLOCK_TYPES = new Set([
  "aside_text", "caption", "footer", "header", "list", "references",
  "table", "text", "title",
]);

function stripOcrNonProseLiterals(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/`[^`\r\n]{1,500}`/gu, " ");
}

function foreignLanguageStats(value) {
  const normalized = stripOcrNonProseLiterals(value).normalize("NFC");
  const letters = normalized.match(/\p{L}/gu) || [];
  const hangulCount = (normalized.match(/[가-힣]/gu) || []).length;
  const foreignLetterCount = letters.filter((character) => !/[가-힣]/u.test(character)).length;
  const foreignWords = (normalized.match(/[\p{L}\p{M}]+/gu) || [])
    .filter((word) => !/[가-힣]/u.test(word) && (word.match(/\p{L}/gu) || []).length >= 2)
    .map((word) => word.toLocaleLowerCase("und"));
  return { normalized, hangulCount, foreignLetterCount, foreignWords };
}

function looksLikeTranslatableForeignProse(block) {
  const type = String(block?.type || "");
  if (!OCR_PROSE_BLOCK_TYPES.has(type)) return false;
  const text = stripOcrNonProseLiterals(block?.content);
  const stats = foreignLanguageStats(text);
  if (stats.foreignLetterCount < 6) return false;
  // A Korean sentence may legitimately mention foreign product names or
  // acronyms.  Decide at block granularity: only foreign-dominant blocks need
  // translation, while a separate English/Japanese/Russian block on the same
  // page still triggers the policy.
  if (
    stats.hangulCount >= 4 &&
    stats.foreignLetterCount <= stats.hangulCount * 1.25
  ) return false;

  // Titles frequently consist of one ordinary word (for example,
  // "Introduction").  Mixed-case product names such as OpenAI are not by
  // themselves enough to make an otherwise Korean page require translation.
  if (["title", "header", "footer"].includes(type)) {
    const oneWord = stats.foreignWords.length === 1 ? stats.foreignWords[0] : "";
    const rawWord = (text.match(/[\p{L}\p{M}]+/u) || [""])[0];
    const internalUppercase = /\p{Ll}.*\p{Lu}/u.test(rawWord);
    return stats.foreignWords.length >= 2 || (oneWord.length >= 8 && !internalUppercase);
  }

  // Two words are enough for short labels/sentences.  Scripts that normally
  // do not use spaces (Japanese/Chinese) are caught by letter count plus
  // sentence punctuation or a longer contiguous run.
  return stats.foreignWords.length >= 2 ||
    /[.!?。！？]/u.test(text) ||
    stats.foreignLetterCount >= 12;
}

function ocrPageRequiresKorean(page) {
  return (Array.isArray(page?.blocks) ? page.blocks : [])
    .some((block) => looksLikeTranslatableForeignProse(block));
}

function ocrPageTranslatableText(page) {
  return (Array.isArray(page?.blocks) ? page.blocks : [])
    .filter((block) => looksLikeTranslatableForeignProse(block))
    .map((block) => normalizeOcrReviewText(String(block.content || "")))
    .filter(Boolean)
    .join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function maskOnePreservedLiteral(value, literal) {
  const normalized = normalizeOcrReviewText(String(literal || ""));
  if (normalized.length < 2) return value;
  const pattern = new RegExp(
    escapeRegExp(normalized).replace(/\s+/gu, "\\s+"),
    "u",
  );
  return value.replace(pattern, (match) => " ".repeat(match.length));
}

function maskOcrPreservedLiterals(page, targetText) {
  let masked = targetText;
  const preserved = (Array.isArray(page?.blocks) ? page.blocks : [])
    .filter((block) => ["code", "equation"].includes(String(block?.type || "")))
    .map((block) => String(block?.content || ""))
    .sort((left, right) => right.length - left.length);
  // Mask once per canonical non-prose occurrence.  If the same sentence also
  // remains as untranslated prose, one unmasked copy remains and is rejected.
  for (const literal of preserved) masked = maskOnePreservedLiteral(masked, literal);
  return masked;
}

function retainedForeignWordRatio(sourceWords, targetWords) {
  if (!sourceWords.length) return 0;
  const targetCounts = new Map();
  for (const word of targetWords) {
    targetCounts.set(word, (targetCounts.get(word) || 0) + 1);
  }
  let retained = 0;
  for (const word of sourceWords) {
    const remaining = targetCounts.get(word) || 0;
    if (remaining > 0) {
      retained += 1;
      targetCounts.set(word, remaining - 1);
    }
  }
  return retained / sourceWords.length;
}

function assertKoreanTargetPolicy(page, targetText, pageNumber) {
  if (!ocrPageRequiresKorean(page)) return;
  const sourceText = ocrPageTranslatableText(page);
  const target = normalizeOcrReviewText(targetText);
  // A short original-language term in parentheses after a Korean term is an
  // allowed first-occurrence glossary, not untranslated prose.  Keep this
  // deliberately narrow so wrapping a whole source sentence in parentheses
  // cannot bypass the target-language gate.
  const targetWithoutGlosses = maskOcrPreservedLiterals(page, target).replace(
    /([가-힣]{2,})[ \t]*\(([^()\r\n]{1,80})\)/gu,
    (match, korean, gloss) => {
      const stats = foreignLanguageStats(gloss);
      return stats.foreignWords.length >= 1 &&
        stats.foreignWords.length <= 4 &&
        !/[.!?。！？]/u.test(gloss)
        ? korean
        : match;
    },
  );
  const sourceStats = foreignLanguageStats(sourceText);
  const targetStats = foreignLanguageStats(targetWithoutGlosses);
  const sourceCompact = sourceText.replace(/\s+/gu, "").toLocaleLowerCase("und");
  const targetCompact = targetWithoutGlosses.replace(/\s+/gu, "").toLocaleLowerCase("und");
  const minimumHangul = Math.max(
    4,
    Math.min(32, Math.ceil(sourceStats.foreignLetterCount * 0.2)),
  );
  const retainedRatio = retainedForeignWordRatio(
    sourceStats.foreignWords,
    targetStats.foreignWords,
  );
  const foreignLetterRatio = sourceStats.foreignLetterCount > 0
    ? targetStats.foreignLetterCount / sourceStats.foreignLetterCount
    : 0;
  const sourceStillEmbedded = sourceCompact.length >= 6 && targetCompact.includes(sourceCompact);
  const mostlyRetainedWords = sourceStats.foreignWords.length >= 2 && retainedRatio >= 0.65;
  if (
    targetStats.hangulCount < minimumHangul ||
    sourceStillEmbedded ||
    mostlyRetainedWords
  ) {
    fail(
      "OCR_SEMANTIC_REVIEW_TARGET_LANGUAGE_INVALID",
      "Final OCR page did not satisfy the Korean target-language policy",
      {
        page: pageNumber,
        minimum_hangul: minimumHangul,
        actual_hangul: targetStats.hangulCount,
        retained_foreign_word_ratio_milli: Math.round(retainedRatio * 1000),
        foreign_letter_ratio_milli: Math.round(foreignLetterRatio * 1000),
      },
    );
  }
}

function targetWithInvariantPlaceholders(prepared, targetText) {
  const target = normalizeOcrReviewText(targetText);
  let cursor = 0;
  let masked = "";
  for (const entry of prepared.mask.entries) {
    const index = target.indexOf(entry.literal, cursor);
    if (index < 0) {
      fail("OCR_SEMANTIC_REVIEW_INVARIANT_MISSING", "Output page omitted a canonical OCR invariant", {
        page: prepared.source.page,
        invariant_kind: entry.type,
        invariant_sequence: entry.sequence,
      });
    }
    masked += target.slice(cursor, index) + entry.placeholder;
    cursor = index + entry.literal.length;
  }
  return masked + target.slice(cursor);
}

async function extractOutputPageTexts(outputPdf, { signal, pageTextExtractor } = {}) {
  if (typeof pageTextExtractor === "function") {
    const value = await pageTextExtractor(outputPdf, { signal });
    if (!Array.isArray(value)) {
      fail("OCR_SEMANTIC_REVIEW_OUTPUT_INVALID", "Injected page text extractor must return an array");
    }
    return value.map((text) => normalizeOcrReviewText(text));
  }
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "ocr-semantic-output-"));
  const pdfPath = path.join(directory, "output.pdf");
  try {
    await fsp.writeFile(pdfPath, outputPdf, { mode: 0o600 });
    const extracted = await extractPageTexts(pdfPath, { signal });
    if (
      !extracted ||
      !Array.isArray(extracted.pages) ||
      extracted.page_count !== extracted.pages.length
    ) {
      fail("OCR_SEMANTIC_REVIEW_OUTPUT_INVALID", "Final PDF page text extraction is incomplete");
    }
    return extracted.pages.map((page, index) => {
      if (Number(page.page) !== index + 1 || typeof page.text !== "string") {
        fail("OCR_SEMANTIC_REVIEW_OUTPUT_INVALID", "Final PDF page text coverage is invalid", {
          position: index,
        });
      }
      return normalizeOcrReviewText(page.text);
    });
  } finally {
    await fsp.rm(directory, { recursive: true, force: true });
  }
}

async function fetchMistralReviewWithRetry(url, options, signal) {
  const retryable = new Set([429, 500, 502, 503, 504, 529]);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response;
    try {
      response = await fetch(url, { ...options, signal });
    } catch (error) {
      if (signal?.aborted || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** (attempt - 1)));
      continue;
    }
    if (!retryable.has(response.status) || attempt === 3) return response;
    try { await response.arrayBuffer(); } catch {}
    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(30000, retryAfter * 1000)
      : Math.min(10000, 800 * 2 ** (attempt - 1));
    await new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        reject(signal.reason || new Error("Mistral review aborted"));
      };
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error("Mistral review retry state is invalid");
}

async function mistralSemanticJudgeCaller({
  model,
  system,
  user,
  maxTokens,
  signal,
}) {
  const key = process.env.MISTRAL_API_KEY || "";
  if (!key) {
    fail("OCR_SEMANTIC_REVIEW_JUDGE_UNAVAILABLE", "MISTRAL_API_KEY is required for independent OCR semantic review");
  }
  const base = String(process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1").replace(/\/$/, "");
  const response = await fetchMistralReviewWithRetry(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  }, signal);
  const raw = await response.text();
  if (!response.ok) {
    const error = new Error(`Mistral semantic judge HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("Mistral semantic judge returned invalid JSON");
  }
  const requestId =
    (typeof response.headers?.get === "function" &&
      (response.headers.get("x-request-id") || response.headers.get("request-id"))) ||
    payload.id;
  const usage = payload.usage || {};
  return {
    request_id: requestId,
    text: payload.choices?.[0]?.message?.content,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function visualInputDigestPayload({
  sourcePdf,
  outputPdf,
  ocrEvidence,
  ocrRenderManifest,
  sourcePages,
  outputPages,
  intent = "translate",
}) {
  const outputByIndex = new Map(outputPages.map((page) => [page.index, page]));
  return {
    schema_version: 1,
    task: OCR_VISUAL_REVIEW_TASK,
    intent,
    source_pdf_sha256: hashArtifact(sourcePdf, "sourcePdf"),
    output_pdf_sha256: hashArtifact(outputPdf, "outputPdf"),
    ocr_evidence_sha256: ocrEvidence.evidence_sha256,
    ocr_render_manifest_sha256: ocrRenderManifest.manifest_sha256,
    pages: sourcePages.map((source) => {
      const output = outputByIndex.get(source.index);
      if (!output) {
        fail("OCR_VISUAL_REVIEW_RENDER_INVALID", "Output visual page is missing", {
          page: source.index + 1,
        });
      }
      return {
      page: source.index + 1,
      source_tiles: source.tiles.map((tile) => ({
        index: tile.index,
        bbox: tile.bbox,
        width: tile.width,
        height: tile.height,
        media_type: tile.media_type,
        image_sha256: tile.image_sha256,
      })),
      output_tiles: output.tiles.map((tile) => ({
        index: tile.index,
        bbox: tile.bbox,
        width: tile.width,
        height: tile.height,
        media_type: tile.media_type,
        image_sha256: tile.image_sha256,
      })),
    };
    }),
  };
}

async function mistralVisualJudgeCaller({ request, sourcePages, outputPages, signal }) {
  const key = process.env.MISTRAL_API_KEY || "";
  if (!key) {
    fail("OCR_VISUAL_REVIEW_JUDGE_UNAVAILABLE", "MISTRAL_API_KEY is required for independent visual review");
  }
  const model = process.env.PDF_OCR_VISUAL_JUDGE_MODEL || "mistral-medium-3-5";
  const restoreIntent = request.intent === "restore";
  const content = [{
    type: "text",
    text: [
      "Compare each SOURCE scan page with the corresponding OUTPUT translated page.",
      "Read the SOURCE image directly; do not assume any OCR transcript is complete or correct. Compare it with the OUTPUT image page by page.",
      "Judge both (1) text and (2) non-text visual content: photos, diagrams, plots, charts, geometric drawings, signatures, and meaningful table structure.",
      restoreIntent
        ? "This is an original-language restore, not a translation. A pass requires every readable source text region to be reproduced in the original language without paraphrase or translation, every meaningful non-text item to be preserved, and no invented text or figure."
        : "This is a Korean translation. A pass requires every readable source text region to be represented in the output with equivalent meaning, all translatable prose to be Korean, every meaningful non-text item to be preserved, and no invented text or figure.",
      restoreIntent
        ? "The legacy response field target_language_korean means target-language policy satisfied for this request: set it true only when the original source language was preserved exactly; do not require Korean."
        : "Set target_language_korean true only when all translatable prose is Korean.",
      "Copy input_digest and each page's source_tiles_digest/output_tiles_digest exactly from the binding JSON below.",
      "Return one strict JSON object, no markdown or prose.",
      `Exact shape: {\"schema_version\":1,\"task\":\"${OCR_VISUAL_REVIEW_TASK}\",\"input_digest\":\"...\",\"pages\":[{\"page\":1,\"source_tiles_digest\":\"...\",\"output_tiles_digest\":\"...\",\"verdict\":\"pass|fail|uncertain\",\"nontext_preserved\":true,\"no_missing_figures\":true,\"no_added_figures\":true,\"all_source_text_covered\":true,\"text_meaning_preserved\":true,\"target_language_korean\":true,\"no_added_text\":true}]}`,
      `Binding JSON: ${canonicalJson({
        input_digest: sha256Canonical(request),
        pages: request.pages.map((page) => ({
          page: page.page,
          source_tiles_digest: sha256Canonical(page.source_tiles),
          output_tiles_digest: sha256Canonical(page.output_tiles),
        })),
      })}`,
    ].join("\n"),
  }];
  for (let index = 0; index < sourcePages.length; index += 1) {
    const pageNumber = sourcePages[index].index + 1;
    content.push({ type: "text", text: `SOURCE page ${pageNumber}` });
    for (const tile of sourcePages[index].tiles) {
      content.push({
        type: "image_url",
        image_url: `data:image/png;base64,${tile.buffer.toString("base64")}`,
      });
    }
    content.push({ type: "text", text: `OUTPUT page ${pageNumber}` });
    for (const tile of outputPages[index].tiles) {
      content.push({
        type: "image_url",
        image_url: `data:image/png;base64,${tile.buffer.toString("base64")}`,
      });
    }
  }
  const base = String(process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1").replace(/\/$/, "");
  const response = await fetchMistralReviewWithRetry(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: Math.max(2000, sourcePages.length * 120),
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  }, signal);
  const raw = await response.text();
  if (!response.ok) throw new Error(`Mistral visual judge HTTP ${response.status}`);
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("Mistral visual judge returned invalid JSON"); }
  return {
    provider: "mistral",
    model,
    request_id:
      (typeof response.headers?.get === "function" &&
        (response.headers.get("x-request-id") || response.headers.get("request-id"))) ||
      payload.id,
    text: payload.choices?.[0]?.message?.content,
  };
}

function partitionVisualPageIndices(pageCount) {
  const batchPages = Math.max(
    1,
    Math.min(8, Number.parseInt(process.env.PDF_OCR_VISUAL_BATCH_PAGES || "8", 10) || 8),
  );
  const indices = Array.from({ length: pageCount }, (_, index) => index);
  const batches = [];
  for (let index = 0; index < indices.length; index += batchPages) {
    batches.push(indices.slice(index, index + batchPages));
  }
  return batches;
}

function assertVisualGeometryResourceBudget(pages, role) {
  const targetWidth = 1400;
  const minimumZoom = 0.25;
  const maximumTiles = 30;
  const maximumDimension = 4096;
  const maximumArea = 12_000_000;
  const maximumPagePixels = 32_000_000;
  for (const page of pages) {
    const width = Number(page?.width);
    const height = Number(page?.height);
    const zoom = Math.min(targetWidth / width, 4);
    const tileHeight = 1800 / zoom;
    const overlap = 130 / zoom;
    const tileCount = Math.max(1, Math.ceil(height / (tileHeight * 1.15)));
    const pixelWidth = Math.max(1, Math.ceil(width * zoom));
    const maximumTileHeight = Math.max(
      1,
      Math.ceil((height / tileCount + overlap) * zoom),
    );
    const predictedPagePixels = pixelWidth * (
      Math.ceil(height * zoom) + Math.max(0, tileCount - 1) * 130
    );
    if (
      !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(height) || height <= 0 ||
      !Number.isFinite(zoom) || zoom < minimumZoom ||
      tileCount > maximumTiles ||
      pixelWidth > maximumDimension ||
      maximumTileHeight > maximumDimension ||
      pixelWidth * maximumTileHeight > maximumArea ||
      predictedPagePixels > maximumPagePixels
    ) {
      fail(
        "OCR_VISUAL_REVIEW_RENDER_INVALID",
        "Page geometry exceeds the safe visual-render budget",
        {
          role,
          page: Number.isInteger(page?.index) ? page.index + 1 : null,
          tile_count: Number.isFinite(tileCount) ? tileCount : null,
          predicted_width: Number.isFinite(pixelWidth) ? pixelWidth : null,
          predicted_maximum_tile_height:
            Number.isFinite(maximumTileHeight) ? maximumTileHeight : null,
          predicted_page_pixels:
            Number.isFinite(predictedPagePixels) ? predictedPagePixels : null,
        },
      );
    }
  }
}

function assertVisualBatchResourceBudget(sourcePages, outputPages) {
  const configuredImages = Number.parseInt(
    process.env.PDF_OCR_VISUAL_MAX_IMAGES || "60",
    10,
  );
  const maxImages = Math.max(2, Math.min(60, configuredImages || 60));
  const configuredBytes = Number.parseInt(
    process.env.PDF_OCR_VISUAL_MAX_RAW_IMAGE_BYTES || String(32 * 1024 * 1024),
    10,
  );
  // Keep enough headroom for base64 expansion and JSON framing under common
  // multimodal request-body limits.  Environment overrides may lower, but not
  // raise, the hard ceiling.
  const maxRawBytes = Math.max(
    1024,
    Math.min(32 * 1024 * 1024, configuredBytes || 32 * 1024 * 1024),
  );
  const allTiles = [...sourcePages, ...outputPages].flatMap((page) => page.tiles);
  const rawBytes = allTiles.reduce((total, tile) => total + tile.buffer.length, 0);
  if (allTiles.length > maxImages || rawBytes > maxRawBytes) {
    fail(
      "OCR_VISUAL_REVIEW_BATCH_LIMIT",
      "One visual review batch exceeds the safe image request budget",
      {
        image_count: allTiles.length,
        maximum_images: maxImages,
        raw_image_bytes: rawBytes,
        maximum_raw_image_bytes: maxRawBytes,
      },
    );
  }
}

function parseVisualBatchResponse({ envelope, request, generationProvider }) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review envelope is invalid");
  }
  if (providerFamily(envelope.provider) === providerFamily(generationProvider)) {
    fail("OCR_VISUAL_REVIEW_SELF_JUDGE", "Translation and visual review providers must be independent");
  }
  let response;
  try { response = JSON.parse(envelope.text); } catch {
    fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review response is not strict JSON");
  }
  assertExactKeys(response, ["schema_version", "task", "input_digest", "pages"], "visual_response");
  const expectedInputDigest = sha256Canonical(request);
  if (
    response.schema_version !== 1 ||
    response.task !== OCR_VISUAL_REVIEW_TASK ||
    response.input_digest !== expectedInputDigest ||
    !Array.isArray(response.pages) ||
    response.pages.length !== request.pages.length
  ) {
    fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review response coverage is invalid");
  }
  const pages = response.pages.map((item, index) => {
    assertExactKeys(item, VISUAL_RESPONSE_ITEM_KEYS, `visual_response.pages[${index}]`);
    const requestedPage = request.pages[index];
    const sourceTilesDigest = sha256Canonical(requestedPage.source_tiles);
    const outputTilesDigest = sha256Canonical(requestedPage.output_tiles);
    const accepted =
      item.page === requestedPage.page &&
      item.source_tiles_digest === sourceTilesDigest &&
      item.output_tiles_digest === outputTilesDigest &&
      item.verdict === "pass" &&
      item.nontext_preserved === true &&
      item.no_missing_figures === true &&
      item.no_added_figures === true &&
      item.all_source_text_covered === true &&
      item.text_meaning_preserved === true &&
      item.target_language_korean === true &&
      item.no_added_text === true;
    if (!accepted) {
      fail("OCR_VISUAL_REVIEW_REJECTED", "Independent visual review rejected a page", {
        page: requestedPage.page,
      });
    }
    return {
      page: requestedPage.page,
      source_tiles: requestedPage.source_tiles,
      output_tiles: requestedPage.output_tiles,
      verdict: "pass",
      nontext_preserved: true,
      no_missing_figures: true,
      no_added_figures: true,
      all_source_text_covered: true,
      text_meaning_preserved: true,
      target_language_korean: true,
      no_added_text: true,
    };
  });
  return { pages, expectedInputDigest };
}

async function buildVisualReview({
  sourcePdf,
  outputPdf,
  ocrEvidence,
  ocrRenderManifest,
  generationProvider,
  visualJudgeCaller = mistralVisualJudgeCaller,
  visualPageRenderer = renderOcrAdjudicationPages,
  visualPageInspector = inspectPdfSourcePages,
  signal,
  apiSemaphore,
  resourceLimits,
  intent = "translate",
}) {
  if (intent !== "translate" && intent !== "restore") {
    fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review intent is invalid");
  }
  const pageCount = ocrEvidence.page_count;
  const [sourceGeometry, outputGeometry] = await Promise.all([
    visualPageInspector(sourcePdf, { signal, role: "source" }),
    visualPageInspector(outputPdf, { signal, role: "output" }),
  ]);
  const expectedIndices = Array.from({ length: pageCount }, (_, index) => index);
  if (
    !Array.isArray(sourceGeometry) || sourceGeometry.length !== pageCount ||
    !Array.isArray(outputGeometry) || outputGeometry.length !== pageCount ||
    canonicalJson(sourceGeometry.map((page) => page.index)) !== canonicalJson(expectedIndices) ||
    canonicalJson(outputGeometry.map((page) => page.index)) !== canonicalJson(expectedIndices)
  ) {
    fail("OCR_VISUAL_REVIEW_RENDER_INVALID", "Source/output page geometry coverage is incomplete");
  }
  assertVisualGeometryResourceBudget(sourceGeometry, "source");
  assertVisualGeometryResourceBudget(outputGeometry, "output");
  const limits = resourceLimits || getProcessWidePdfTranslateResourceLimits();
  const runApi = apiSemaphore?.run
    ? (task) => apiSemaphore.run(task, { signal })
    : (task) => limits.runApi(task, { signal });
  const pages = [];
  const batches = [];
  let provider = null;
  let model = null;
  // 보통 A4는 최대 8쪽씩 검토해 장문서의 호출 수를 줄인다. 긴 페이지/다중 타일 때문에
  // 실제 60이미지·32MiB 안전 예산을 넘으면 해당 묶음만 반으로 나눠 재시도한다.
  // hard cap 자체는 유지하므로 한 페이지조차 예산을 넘는 입력은 기존처럼 fail-closed다.
  const visualQueue = partitionVisualPageIndices(pageCount);
  for (let queueIndex = 0; queueIndex < visualQueue.length; queueIndex += 1) {
    const indices = visualQueue[queueIndex];
    const [rawSourcePages, rawOutputPages] = await Promise.all([
      visualPageRenderer(sourcePdf, indices, { signal, role: "source" }),
      visualPageRenderer(outputPdf, indices, { signal, role: "output" }),
    ]);
    let sourcePages;
    let outputPages;
    try {
      sourcePages = validateRenderedAdjudicationPages(rawSourcePages, indices, sourceGeometry);
      outputPages = validateRenderedAdjudicationPages(rawOutputPages, indices, outputGeometry);
    } catch (error) {
      fail("OCR_VISUAL_REVIEW_RENDER_INVALID", "Source/output visual render coverage is invalid", {
        validation_code: typeof error?.code === "string" ? error.code : null,
      });
    }
    try {
      assertVisualBatchResourceBudget(sourcePages, outputPages);
    } catch (error) {
      if (error?.code === "OCR_VISUAL_REVIEW_BATCH_LIMIT" && indices.length > 1) {
        const middle = Math.ceil(indices.length / 2);
        visualQueue.splice(
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
    const request = visualInputDigestPayload({
      sourcePdf,
      outputPdf,
      ocrEvidence,
      ocrRenderManifest,
      sourcePages,
      outputPages,
      intent,
    });
    let envelope;
    try {
      envelope = await runApi(
        () => visualJudgeCaller({ request, sourcePages, outputPages, signal }),
      );
    } catch (error) {
      if (error instanceof OcrSemanticReviewError) throw error;
      fail("OCR_VISUAL_REVIEW_CALL_FAILED", "Independent visual review could not be completed");
    }
    const parsed = parseVisualBatchResponse({ envelope, request, generationProvider });
    const envelopeProvider = String(envelope.provider || "");
    const envelopeModel = String(envelope.model || "");
    if (!provider) {
      provider = envelopeProvider;
      model = envelopeModel;
    } else if (provider !== envelopeProvider || model !== envelopeModel) {
      fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review provider/model changed between batches");
    }
    if (!String(envelope.request_id || "").trim() || !envelopeModel.trim()) {
      fail("OCR_VISUAL_REVIEW_RESPONSE_INVALID", "Visual review trace metadata is missing");
    }
    pages.push(...parsed.pages);
    batches.push({
      request_id: String(envelope.request_id),
      input_digest: parsed.expectedInputDigest,
      pages: request.pages.map((page) => page.page),
    });
  }
  pages.sort((left, right) => left.page - right.page);
  const fullRequest = {
    schema_version: 1,
    task: OCR_VISUAL_REVIEW_TASK,
    intent,
    source_pdf_sha256: hashArtifact(sourcePdf, "sourcePdf"),
    output_pdf_sha256: hashArtifact(outputPdf, "outputPdf"),
    ocr_evidence_sha256: ocrEvidence.evidence_sha256,
    ocr_render_manifest_sha256: ocrRenderManifest.manifest_sha256,
    pages: pages.map((page) => ({
      page: page.page,
      source_tiles: page.source_tiles,
      output_tiles: page.output_tiles,
    })),
  };
  const review = {
    schema_version: 1,
    task: OCR_VISUAL_REVIEW_TASK,
    provider,
    model,
    request_id: batches.length === 1
      ? batches[0].request_id
      : `batch-${sha256Canonical(batches.map((batch) => batch.request_id))}`,
    source_pdf_sha256: fullRequest.source_pdf_sha256,
    output_pdf_sha256: fullRequest.output_pdf_sha256,
    ocr_evidence_sha256: fullRequest.ocr_evidence_sha256,
    ocr_render_manifest_sha256: fullRequest.ocr_render_manifest_sha256,
    input_digest: sha256Canonical(fullRequest),
    batches,
    pages,
  };
  review.judge_attestation = issueVisualJudgeAttestation(review, intent);
  review.review_sha256 = sha256Canonical(review);
  return review;
}

function validateVisualReview(review, {
  sourcePdf,
  outputPdf,
  ocrEvidence,
  ocrRenderManifest,
  generationProvider,
  intent = "translate",
}) {
  if (intent !== "translate" && intent !== "restore") {
    fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual review intent is invalid");
  }
  assertExactKeys(review, [
    "schema_version", "task", "provider", "model", "request_id",
    "source_pdf_sha256", "output_pdf_sha256", "ocr_evidence_sha256",
    "ocr_render_manifest_sha256", "input_digest", "batches", "pages",
    "judge_attestation", "review_sha256",
  ], "ocr_semantic_review.visual_review");
  const unsigned = { ...review };
  delete unsigned.review_sha256;
  if (
    review.schema_version !== 1 ||
    review.task !== OCR_VISUAL_REVIEW_TASK ||
    review.review_sha256 !== sha256Canonical(unsigned) ||
    review.source_pdf_sha256 !== hashArtifact(sourcePdf, "sourcePdf") ||
    review.output_pdf_sha256 !== hashArtifact(outputPdf, "outputPdf") ||
    review.ocr_evidence_sha256 !== ocrEvidence.evidence_sha256 ||
    review.ocr_render_manifest_sha256 !== ocrRenderManifest.manifest_sha256 ||
    providerFamily(review.provider) === providerFamily(generationProvider) ||
    !String(review.model || "").trim() ||
    !String(review.request_id || "").trim() ||
    !Array.isArray(review.batches) || !review.batches.length ||
    !Array.isArray(review.pages) || review.pages.length !== ocrEvidence.page_count
  ) {
    fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual review evidence binding is invalid");
  }
  review.pages.forEach((item, index) => {
    assertExactKeys(item, [
      "page", "source_tiles", "output_tiles", "verdict",
      "nontext_preserved", "no_missing_figures", "no_added_figures",
      "all_source_text_covered", "text_meaning_preserved", "target_language_korean",
      "no_added_text",
    ], `ocr_semantic_review.visual_review.pages[${index}]`);
    if (
      item.page !== index + 1 || item.verdict !== "pass" ||
      item.nontext_preserved !== true || item.no_missing_figures !== true ||
      item.no_added_figures !== true || item.all_source_text_covered !== true ||
      item.text_meaning_preserved !== true || item.target_language_korean !== true ||
      item.no_added_text !== true ||
      !Array.isArray(item.source_tiles) || !item.source_tiles.length ||
      !Array.isArray(item.output_tiles) || !item.output_tiles.length
    ) {
      fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual review page evidence is invalid", {
        page: index + 1,
      });
    }
    for (const [role, tiles] of [["source", item.source_tiles], ["output", item.output_tiles]]) {
      tiles.forEach((tile, tileIndex) => {
        assertExactKeys(tile, [
          "index", "bbox", "width", "height", "media_type", "image_sha256",
        ], `ocr_semantic_review.visual_review.pages[${index}].${role}_tiles[${tileIndex}]`);
        if (
          tile.index !== tileIndex ||
          !Array.isArray(tile.bbox) || tile.bbox.length !== 4 ||
          tile.bbox.some((value) => !Number.isFinite(value)) ||
          !Number.isInteger(tile.width) || tile.width < 1 ||
          !Number.isInteger(tile.height) || tile.height < 1 ||
          tile.media_type !== "image/png" ||
          !/^[a-f0-9]{64}$/.test(String(tile.image_sha256 || ""))
        ) {
          fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Stored visual tile descriptor is invalid", {
            page: index + 1,
            role,
            tile: tileIndex,
          });
        }
      });
    }
  });
  const expectedInput = {
    schema_version: 1,
    task: OCR_VISUAL_REVIEW_TASK,
    intent,
    source_pdf_sha256: review.source_pdf_sha256,
    output_pdf_sha256: review.output_pdf_sha256,
    ocr_evidence_sha256: review.ocr_evidence_sha256,
    ocr_render_manifest_sha256: review.ocr_render_manifest_sha256,
    pages: review.pages.map((item) => ({
      page: item.page,
      source_tiles: item.source_tiles,
      output_tiles: item.output_tiles,
    })),
  };
  if (review.input_digest !== sha256Canonical(expectedInput)) {
    fail("OCR_VISUAL_REVIEW_INPUT_MISMATCH", "Stored visual input digest is invalid");
  }
  const pageByNumber = new Map(review.pages.map((page) => [page.page, page]));
  const coveredPages = [];
  review.batches.forEach((batch, index) => {
    assertExactKeys(batch, ["request_id", "input_digest", "pages"], `visual_review.batches[${index}]`);
    if (
      !String(batch.request_id || "").trim() ||
      !/^[a-f0-9]{64}$/.test(String(batch.input_digest || "")) ||
      !Array.isArray(batch.pages) || !batch.pages.length ||
      batch.pages.some((page) => !Number.isInteger(page) || !pageByNumber.has(page))
    ) {
      fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual review batch metadata is invalid", {
        batch: index,
      });
    }
    const request = {
      ...expectedInput,
      pages: batch.pages.map((pageNumber) => {
        const page = pageByNumber.get(pageNumber);
        return {
          page: page.page,
          source_tiles: page.source_tiles,
          output_tiles: page.output_tiles,
        };
      }),
    };
    if (batch.input_digest !== sha256Canonical(request)) {
      fail("OCR_VISUAL_REVIEW_INPUT_MISMATCH", "Stored visual batch input digest is invalid", {
        batch: index,
      });
    }
    coveredPages.push(...batch.pages);
  });
  const expectedPages = review.pages.map((page) => page.page);
  if (canonicalJson(coveredPages) !== canonicalJson(expectedPages)) {
    fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual batches do not cover every page exactly once");
  }
  const expectedRequestId = review.batches.length === 1
    ? review.batches[0].request_id
    : `batch-${sha256Canonical(review.batches.map((batch) => batch.request_id))}`;
  if (review.request_id !== expectedRequestId) {
    fail("OCR_VISUAL_REVIEW_EVIDENCE_INVALID", "Visual review aggregate request ID is invalid");
  }
  validateVisualJudgeAttestation(review, intent);
  return review;
}

function partitionSemanticSegments(segments) {
  const maxPages = Math.max(
    1,
    Math.min(20, Number.parseInt(process.env.PDF_OCR_SEMANTIC_BATCH_PAGES || "20", 10) || 20),
  );
  const maxCharacters = Math.max(
    8000,
    Number.parseInt(process.env.PDF_OCR_SEMANTIC_BATCH_CHARS || "60000", 10) || 60000,
  );
  const batches = [];
  let current = [];
  let characters = 0;
  for (const segment of segments) {
    const size = segment.source_text.length + segment.bound.restored_text.length;
    if (current.length && (current.length >= maxPages || characters + size > maxCharacters)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    if (size > maxCharacters) {
      fail("OCR_SEMANTIC_REVIEW_SEGMENT_TOO_LARGE", "One OCR page exceeds the semantic review batch budget", {
        page: segment.prepared.source.page,
        characters: size,
        maximum_characters: maxCharacters,
      });
    }
    current.push(segment);
    characters += size;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function judgeSemanticBatches({
  segments,
  generationProvider,
  judgeProvider,
  judgeModel,
  judgeCaller,
  signal,
  apiSemaphore,
  resourceLimits,
}) {
  const batches = [];
  const items = [];
  const segmentBatches = partitionSemanticSegments(segments);
  const results = new Array(segmentBatches.length);
  let next = 0;
  const concurrency = Math.max(
    1,
    Math.min(4, Number.parseInt(process.env.PDF_OCR_SEMANTIC_CONCURRENCY || "2", 10) || 2),
  );
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= segmentBatches.length) return;
      results[index] = await judgeSemanticSegments({
        segments: segmentBatches[index],
        generationProvider,
        judgeProvider,
        judgeModel,
        caller: judgeCaller,
        signal,
        apiSemaphore,
        resourceLimits,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, segmentBatches.length) }, () => worker()),
  );
  for (let index = 0; index < segmentBatches.length; index += 1) {
    const batchSegments = segmentBatches[index];
    const result = results[index];
    if (result.evaluations.some((item) => !item.accepted)) {
      fail("OCR_SEMANTIC_REVIEW_REJECTED", "Independent semantic review rejected a page batch", {
        segment_ids: result.evaluations.filter((item) => !item.accepted).map((item) => item.segment_id),
      });
    }
    const request = buildSemanticJudgeRequest({ segments: batchSegments }).request;
    batches.push({
      request_id: result.judge.request_id,
      input_digest: result.judge.input_digest,
      segment_ids: batchSegments.map((entry) => entry.bound.segment.segment_id),
    });
    if (result.judge.input_digest !== sha256Canonical(request)) {
      fail("OCR_SEMANTIC_REVIEW_INPUT_MISMATCH", "Semantic batch input digest is invalid");
    }
    items.push(...result.judge.items);
  }
  const fullRequest = buildSemanticJudgeRequest({ segments }).request;
  return {
    judge: {
      provider: judgeProvider,
      model: judgeModel,
      request_id: batches.length === 1
        ? batches[0].request_id
        : `batch-${sha256Canonical(batches.map((batch) => batch.request_id))}`,
      input_digest: sha256Canonical(fullRequest),
      items,
    },
    batches,
    fullRequest,
  };
}

async function createOcrSemanticReviewForOutput({
  sourcePdf,
  outputPdf,
  ocrEvidence,
  ocrRenderManifest,
  generationProvider,
  generationModel,
  generationRequestId,
  judgeProvider = "mistral",
  judgeModel = process.env.PDF_OCR_SEMANTIC_JUDGE_MODEL || "mistral-large-latest",
  judgeCaller = mistralSemanticJudgeCaller,
  pageTextExtractor,
  visualJudgeCaller,
  visualPageRenderer,
  visualPageInspector,
  layoutTemplate = DEFAULT_LAYOUT_TEMPLATE,
  signal,
  apiSemaphore,
  resourceLimits,
} = {}) {
  const canonicalOcr = validateCanonicalOcrEvidence(ocrEvidence, { sourcePdf });
  const canonicalRenderManifest = validateOcrRenderManifest(ocrRenderManifest, {
    sourcePdf,
    pageCount: canonicalOcr.page_count,
  });
  const outputPages = await extractOutputPageTexts(outputPdf, {
    signal,
    pageTextExtractor,
  });
  if (outputPages.length !== canonicalOcr.page_count) {
    fail("OCR_SEMANTIC_REVIEW_PAGE_MISMATCH", "OCR and final output page counts differ", {
      ocr_pages: canonicalOcr.page_count,
      output_pages: outputPages.length,
    });
  }
  const documentSha256 = hashArtifact(sourcePdf, "sourcePdf");
  const segments = canonicalOcr.pages.map((page, index) => {
    const sourceText = page.text;
    assertKoreanTargetPolicy(page, outputPages[index], index + 1);
    const prepared = prepareSourceSegment({
      documentSha256,
      page: index + 1,
      order: 1,
      kind: "ocr_page",
      sourceText,
    });
    const maskedTarget = targetWithInvariantPlaceholders(
      prepared,
      outputPages[index],
    );
    return {
      prepared,
      bound: bindTargetSegment(prepared, maskedTarget),
      source_text: sourceText,
    };
  });
  const judged = await judgeSemanticBatches({
    segments,
    generationProvider,
    judgeProvider,
    judgeModel,
    judgeCaller,
    signal,
    apiSemaphore,
    resourceLimits,
  });
  const visualReview = await buildVisualReview({
    sourcePdf,
    outputPdf,
    ocrEvidence: canonicalOcr,
    ocrRenderManifest: canonicalRenderManifest,
    generationProvider,
    visualJudgeCaller,
    visualPageRenderer,
    visualPageInspector,
    signal,
    apiSemaphore,
    resourceLimits,
  });
  const request = judged.fullRequest;
  const retypesetEvidence = sealRetypesetEvidence({
    sourcePdf,
    outputPdf,
    layoutTemplate,
    segments: segments.map((entry) => entry.bound.segment),
    figures: [],
    translation: {
      provider: generationProvider,
      model: generationModel,
      request_id: generationRequestId,
    },
    judge: judged.judge,
    judgeInput: request,
  });
  const semanticJudgeAttestation = issueSemanticJudgeAttestation({
    retypesetEvidence,
    ocrEvidenceSha256: canonicalOcr.evidence_sha256,
    ocrRenderManifestSha256: canonicalRenderManifest.manifest_sha256,
    semanticBatches: judged.batches,
  });
  return sealOcrSemanticReview({
    ocrEvidence: canonicalOcr,
    ocrRenderManifest: canonicalRenderManifest,
    retypesetEvidence,
    layoutTemplate,
    segments,
    figures: [],
    translationProvider: generationProvider,
    semanticBatches: judged.batches,
    semanticJudgeAttestation,
    visualReview,
    sourcePdf,
    outputPdf,
  });
}

function reviewBindingPayload(review) {
  const evidence = review.retypeset_evidence;
  return {
    schema_version: review.schema_version,
    task: review.task,
    ocr_evidence_sha256: review.ocr_evidence_sha256,
    retypeset_evidence_sha256: evidence.evidence_sha256,
    source_pdf_sha256: evidence.source_pdf_sha256,
    output_pdf_sha256: evidence.output_pdf_sha256,
    judge_input_digest: evidence.judge.input_digest,
    visual_review_sha256: review.visual_review.review_sha256,
    semantic_batches_sha256: sha256Canonical(review.semantic_batches),
    semantic_judge_attestation_sha256:
      sha256Canonical(review.semantic_judge_attestation),
    segments: evidence.segments.map((segment) => ({
      segment_id: segment.segment_id,
      page: segment.page,
      order: segment.order,
      source_sha256: segment.source_sha256,
      target_sha256: segment.target_sha256,
      binding_sha256: segment.binding_sha256,
    })),
  };
}

function reviewBindingDigest(review) {
  return sha256Canonical(reviewBindingPayload(review));
}

function validateSemanticBatches(batches, segments, evidence) {
  if (!Array.isArray(batches) || !batches.length) {
    fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Semantic review batch evidence is missing");
  }
  const byId = new Map(
    segments.map((entry) => [entry.bound.segment.segment_id, entry]),
  );
  const covered = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    assertExactKeys(batch, ["request_id", "input_digest", "segment_ids"], `semantic_batches[${index}]`);
    if (
      !String(batch.request_id || "").trim() ||
      !/^[a-f0-9]{64}$/.test(String(batch.input_digest || "")) ||
      !Array.isArray(batch.segment_ids) || !batch.segment_ids.length
    ) {
      fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Semantic batch metadata is invalid", { batch: index });
    }
    const batchSegments = batch.segment_ids.map((id) => byId.get(id));
    if (batchSegments.some((entry) => !entry)) {
      fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Semantic batch contains an unknown segment", { batch: index });
    }
    const digest = buildSemanticJudgeRequest({ segments: batchSegments }).input_digest;
    if (digest !== batch.input_digest) {
      fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Semantic batch input digest mismatch", { batch: index });
    }
    covered.push(...batch.segment_ids);
  }
  const expectedIds = segments.map((entry) => entry.bound.segment.segment_id);
  if (canonicalJson(covered) !== canonicalJson(expectedIds)) {
    fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Semantic batches do not cover every segment exactly once");
  }
  const expectedBatchId = `batch-${sha256Canonical(batches.map((batch) => batch.request_id))}`;
  if (batches.length === 1) {
    // A single real request keeps its provider request ID for easier tracing.
    if (evidence.judge.request_id !== batches[0].request_id) {
      fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Single semantic request ID mismatch");
    }
  } else if (evidence.judge.request_id !== expectedBatchId) {
    fail("OCR_SEMANTIC_REVIEW_BATCH_INVALID", "Aggregate semantic request ID mismatch");
  }
  return batches;
}

function validateOcrSemanticReview(review, {
  ocrEvidence,
  ocrRenderManifest,
  sourcePdf,
  outputPdf,
} = {}) {
  assertExactKeys(review, REVIEW_KEYS, "ocr_semantic_review");
  if (
    review.schema_version !== OCR_SEMANTIC_REVIEW_SCHEMA_VERSION ||
    review.task !== OCR_SEMANTIC_REVIEW_TASK
  ) {
    fail("OCR_SEMANTIC_REVIEW_SCHEMA_INVALID", "Unsupported OCR semantic review schema or task");
  }
  const canonicalOcr = validateCanonicalOcrEvidence(ocrEvidence, { sourcePdf });
  const canonicalRenderManifest = validateOcrRenderManifest(ocrRenderManifest, {
    sourcePdf,
    pageCount: canonicalOcr.page_count,
  });
  if (review.ocr_evidence_sha256 !== canonicalOcr.evidence_sha256) {
    fail("OCR_SEMANTIC_REVIEW_OCR_MISMATCH", "Semantic review is bound to different OCR evidence");
  }
  if (!Buffer.isBuffer(review.layout_template) || review.layout_template.length < 1) {
    fail("OCR_SEMANTIC_REVIEW_SCHEMA_INVALID", "layout_template must be a non-empty Buffer");
  }
  if (!Array.isArray(review.segments) || review.segments.length !== canonicalOcr.page_count) {
    fail("OCR_SEMANTIC_REVIEW_SEGMENTS_INVALID", "Review must contain exactly one segment per OCR page", {
      expected_count: canonicalOcr.page_count,
      actual_count: Array.isArray(review.segments) ? review.segments.length : -1,
    });
  }
  if (!Array.isArray(review.figures)) {
    fail("OCR_SEMANTIC_REVIEW_SCHEMA_INVALID", "figures must be an array");
  }

  const sourcePdfSha256 = hashArtifact(sourcePdf, "sourcePdf");
  const normalized = [...review.segments].sort(
    (left, right) => left.prepared.source.page - right.prepared.source.page,
  );
  const seenPages = new Set();
  for (let index = 0; index < normalized.length; index += 1) {
    const entry = normalized[index];
    assertExactKeys(entry, SEGMENT_INPUT_KEYS, `ocr_semantic_review.segments[${index}]`);
    const page = entry?.prepared?.source?.page;
    if (!Number.isInteger(page) || page < 1 || page > canonicalOcr.page_count || seenPages.has(page)) {
      fail("OCR_SEMANTIC_REVIEW_SEGMENTS_INVALID", "Review segment page coverage is invalid", {
        page: Number.isInteger(page) ? page : null,
      });
    }
    seenPages.add(page);
    const sourceText = canonicalOcr.pages[page - 1].text;
    if (entry.source_text !== sourceText) {
      fail("OCR_SEMANTIC_REVIEW_SOURCE_MISMATCH", "Review source text differs from canonical OCR", {
        page,
      });
    }
    const expectedPrepared = prepareSourceSegment({
      documentSha256: sourcePdfSha256,
      page,
      order: 1,
      kind: "ocr_page",
      sourceText,
    });
    if (canonicalJson(entry.prepared) !== canonicalJson(expectedPrepared)) {
      fail("OCR_SEMANTIC_REVIEW_SOURCE_MISMATCH", "Review source provenance differs from canonical OCR", {
        page,
      });
    }
    if (entry.bound?.restored_text !== normalizeOcrReviewText(entry.bound?.restored_text)) {
      fail("OCR_SEMANTIC_REVIEW_TARGET_NONCANONICAL", "Review target text is not canonical", { page });
    }
  }

  let judgeRequest;
  try {
    judgeRequest = buildSemanticJudgeRequest({ segments: normalized }).request;
  } catch (error) {
    fail("OCR_SEMANTIC_REVIEW_SEGMENTS_INVALID", "Review segments fail semantic-judge validation", {
      validation_code: typeof error?.code === "string" ? error.code : null,
    });
  }
  const expectedSegments = normalized.map((entry) => entry.bound.segment);
  let evidence;
  try {
    evidence = validateRetypesetEvidence(review.retypeset_evidence, {
      sourcePdf,
      outputPdf,
      layoutTemplate: review.layout_template,
      segments: expectedSegments,
      figures: review.figures,
      judgeInput: judgeRequest,
      translationProvider: review.translation_provider,
    });
  } catch (error) {
    fail("OCR_SEMANTIC_REVIEW_EVIDENCE_INVALID", "Retypeset semantic evidence is invalid", {
      validation_code: typeof error?.code === "string" ? error.code : null,
    });
  }
  const visualReview = validateVisualReview(review.visual_review, {
    sourcePdf,
    outputPdf,
    ocrEvidence: canonicalOcr,
    ocrRenderManifest: canonicalRenderManifest,
    generationProvider: evidence.translation.provider,
    intent: "translate",
  });
  validateSemanticBatches(review.semantic_batches, normalized, evidence);
  validateSemanticJudgeAttestation(review.semantic_judge_attestation, {
    retypesetEvidence: evidence,
    ocrEvidenceSha256: canonicalOcr.evidence_sha256,
    ocrRenderManifestSha256: canonicalRenderManifest.manifest_sha256,
    semanticBatches: review.semantic_batches,
  });
  if (review.review_binding_sha256 !== reviewBindingDigest(review)) {
    fail("OCR_SEMANTIC_REVIEW_BINDING_INVALID", "OCR semantic review binding seal does not match");
  }

  const bindings = normalized.map((entry) => ({
    page: entry.prepared.source.page,
    segment_id: entry.bound.segment.segment_id,
    source_sha256: entry.bound.segment.source_sha256,
    target_sha256: entry.bound.segment.target_sha256,
    binding_sha256: entry.bound.segment.binding_sha256,
  }));
  return {
    evidence,
    segments: normalized,
    bindings,
    verifierBundle: {
      schema_version: 1,
      task: "ocr-postflight-source",
      source_pdf_sha256: sourcePdfSha256,
      ocr_evidence_sha256: canonicalOcr.evidence_sha256,
      pages: normalized.map((entry) => ({
        page: entry.prepared.source.page,
        segment_id: entry.bound.segment.segment_id,
        text: entry.source_text,
        text_sha256: sha256Hex(entry.source_text.normalize("NFC")),
        source_sha256: entry.bound.segment.source_sha256,
        requires_korean_translation: ocrPageRequiresKorean(
          canonicalOcr.pages[entry.prepared.source.page - 1],
        ),
        translatable_text: ocrPageTranslatableText(
          canonicalOcr.pages[entry.prepared.source.page - 1],
        ),
        translatable_text_sha256: sha256Hex(ocrPageTranslatableText(
          canonicalOcr.pages[entry.prepared.source.page - 1],
        ).normalize("NFC")),
      })),
      semantic_review: {
        schema_version: 1,
        task: OCR_SEMANTIC_REVIEW_TASK,
        evidence_sha256: evidence.evidence_sha256,
        review_binding_sha256: review.review_binding_sha256,
        output_pdf_sha256: evidence.output_pdf_sha256,
        judge_input_digest: evidence.judge.input_digest,
        translation_provider: evidence.translation.provider,
        judge_provider: evidence.judge.provider,
        judge_request_id: evidence.judge.request_id,
        visual_review_sha256: visualReview.review_sha256,
        bindings,
      },
    },
    summary: {
      schema_version: 1,
      task: OCR_SEMANTIC_REVIEW_TASK,
      ocr_evidence_sha256: canonicalOcr.evidence_sha256,
      evidence_sha256: evidence.evidence_sha256,
      review_binding_sha256: review.review_binding_sha256,
      output_pdf_sha256: evidence.output_pdf_sha256,
      judge_input_digest: evidence.judge.input_digest,
      visual_review_sha256: visualReview.review_sha256,
      segment_count: bindings.length,
      segment_ids: bindings.map((item) => item.segment_id),
    },
  };
}

function sealOcrSemanticReview({
  ocrEvidence,
  ocrRenderManifest,
  retypesetEvidence,
  layoutTemplate,
  segments,
  figures = [],
  translationProvider,
  visualReview,
  semanticBatches = null,
  semanticJudgeAttestation,
  sourcePdf,
  outputPdf,
} = {}) {
  const effectiveSemanticBatches = semanticBatches || [{
    request_id: retypesetEvidence.judge.request_id,
    input_digest: retypesetEvidence.judge.input_digest,
    segment_ids: segments.map((entry) => entry.bound.segment.segment_id),
  }];
  const review = {
    schema_version: OCR_SEMANTIC_REVIEW_SCHEMA_VERSION,
    task: OCR_SEMANTIC_REVIEW_TASK,
    ocr_evidence_sha256: ocrEvidence?.evidence_sha256,
    retypeset_evidence: retypesetEvidence,
    layout_template: layoutTemplate,
    segments,
    figures,
    translation_provider: translationProvider,
    semantic_batches: effectiveSemanticBatches,
    semantic_judge_attestation: semanticJudgeAttestation,
    visual_review: visualReview,
    review_binding_sha256: "0".repeat(64),
  };
  review.review_binding_sha256 = reviewBindingDigest(review);
  validateOcrSemanticReview(review, {
    ocrEvidence,
    ocrRenderManifest,
    sourcePdf,
    outputPdf,
  });
  return review;
}

module.exports = {
  DEFAULT_LAYOUT_TEMPLATE,
  OCR_SEMANTIC_REVIEW_SCHEMA_VERSION,
  OCR_SEMANTIC_REVIEW_TASK,
  OCR_VISUAL_REVIEW_TASK,
  OcrSemanticReviewError,
  assertKoreanTargetPolicy,
  normalizeOcrReviewText,
  ocrPageRequiresKorean,
  ocrPageTranslatableText,
  createOcrSemanticReviewForOutput,
  buildVisualReview,
  extractOutputPageTexts,
  mistralSemanticJudgeCaller,
  mistralVisualJudgeCaller,
  reviewBindingDigest,
  sealOcrSemanticReview,
  validateOcrSemanticReview,
  validateVisualReview,
};
