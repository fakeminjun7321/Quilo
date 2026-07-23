"use strict";

// Independent, fail-closed semantic review for retypeset PDF segments.
//
// The model call needs raw source/target text, but every value that leaves the
// call boundary (judge evidence, retry telemetry, and errors) is restricted to
// stable IDs, hashes, booleans, bounded reason codes, and token counts.  Callers
// must likewise avoid logging `request` / `user` or the raw retry descriptors.

const {
  assertSha256,
  canonicalInvariantManifest,
  canonicalJson,
  normalizeText,
  sha256Canonical,
  sha256Hex,
} = require("./invariants");
const {
  createJudgeItem,
  digestJudgeInput,
  providerFamily,
  sourceSegmentDigest,
} = require("./provenance");
const {
  getProcessWidePdfTranslateResourceLimits,
  makeAbortError,
} = require("./resource-gate");

const SEMANTIC_JUDGE_SCHEMA_VERSION = 1;
const SEMANTIC_JUDGE_TASK = "independent-semantic-correspondence";
const MAX_REASON_CODES = 4;
const MAX_SEMANTIC_RETRANSLATIONS = 2;

const RESPONSE_TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "task",
  "items",
]);
const RESPONSE_ITEM_KEYS = Object.freeze([
  "segment_id",
  "source_sha256",
  "target_sha256",
  "verdict",
  "meaning_equivalent",
  "complete",
  "no_additions",
  "invariant_associations_correct",
  "reason_codes",
]);
const SOURCE_KEYS = Object.freeze([
  "segment_id",
  "kind",
  "page",
  "order",
  "source_sha256",
  "invariant_manifest_sha256",
  "invariant_count",
]);
const SEGMENT_KEYS = Object.freeze([
  ...SOURCE_KEYS,
  "target_sha256",
  "binding_sha256",
]);
const BOOLEAN_FIELDS = Object.freeze([
  "meaning_equivalent",
  "complete",
  "no_additions",
  "invariant_associations_correct",
]);
const USAGE_KEYS = Object.freeze([
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

// Deliberately closed vocabulary: arbitrary prose cannot escape through
// evidence, logs, retry telemetry, or error details.
const REASON_CODES = Object.freeze([
  "MEANING_MISMATCH",
  "TARGET_LANGUAGE_MISMATCH",
  "OMISSION",
  "ADDITION",
  "INVARIANT_ASSOCIATION_MISMATCH",
  "AMBIGUOUS_SOURCE",
  "AMBIGUOUS_TARGET",
  "TERMINOLOGY_ERROR",
  "REFERENCE_MISMATCH",
  "OTHER_SEMANTIC_RISK",
]);
const REASON_CODE_SET = new Set(REASON_CODES);

const SYSTEM_PROMPT = [
  "You are an independent semantic correspondence judge for PDF translation.",
  "The translation was produced by a different provider. Evaluate every item independently and conservatively.",
  "The required target language is Korean (ko). Never pass an item if translatable prose remains in the source language, Korean translation is absent, or a few Korean words were merely appended to untranslated prose.",
  "Do not rewrite or quote either passage. Return one strict JSON object and no prose or markdown.",
  "For every item, copy segment_id, source_sha256, and target_sha256 exactly from the request.",
  "Set verdict to pass, fail, or uncertain. A pass requires all four booleans to be true.",
  "meaning_equivalent: the target preserves the source meaning in context.",
  "complete: no meaningful source content was omitted.",
  "no_additions: no unsupported meaning was introduced.",
  "invariant_associations_correct: protected numbers, units, URLs, formulae, citations, and code remain associated with the same claims/entities.",
  `reason_codes must contain 1-${MAX_REASON_CODES} codes for a non-pass item and be empty for a pass item.`,
  `Allowed reason_codes only: ${REASON_CODES.join(", ")}.`,
  "Never add all_pass, confidence, explanation, reason, notes, excerpts, or any other field.",
  `Exact response shape: {"schema_version":${SEMANTIC_JUDGE_SCHEMA_VERSION},"task":"${SEMANTIC_JUDGE_TASK}","items":[{"segment_id":"...","source_sha256":"...","target_sha256":"...","verdict":"pass|fail|uncertain","meaning_equivalent":true,"complete":true,"no_additions":true,"invariant_associations_correct":true,"reason_codes":[]}]}`,
].join("\n");

class SemanticJudgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SemanticJudgeError";
    this.code = code;
    // `details` is constructed only from trusted IDs/hashes/counts/codes in this
    // module.  Never attach a provider error, response body, or raw passage.
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new SemanticJudgeError(code, message, details);
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertExactKeys(value, expectedKeys, code, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${path} must be an object`, { path });
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    // Do not include untrusted field names: a model could put source prose in a
    // key and thereby smuggle it into an error/log.
    fail(code, `${path} has missing or unexpected fields`, {
      path,
      expected_field_count: expected.length,
      actual_field_count: actual.length,
    });
  }
}

function assertOpaqueIdentifier(value, name) {
  const result = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,255}$/.test(result)) {
    fail("JUDGE_ACTOR_INVALID", `${name} must be an opaque ASCII identifier`, { field: name });
  }
  return result;
}

function assertCanonicalSha(value, name, code = "JUDGE_INPUT_INVALID") {
  let normalized;
  try {
    normalized = assertSha256(value, name);
  } catch {
    fail(code, `${name} must be a canonical SHA-256 digest`, { field: name });
  }
  if (value !== normalized) {
    fail(code, `${name} must use lowercase SHA-256 hex`, { field: name });
  }
  return normalized;
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function normalizeUsage(value) {
  const usage = emptyUsage();
  if (value == null) return usage;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("JUDGE_USAGE_INVALID", "Judge usage must be an object", {});
  }
  for (const key of USAGE_KEYS) {
    const amount = value[key] == null ? 0 : value[key];
    if (!Number.isSafeInteger(amount) || amount < 0) {
      fail("JUDGE_USAGE_INVALID", "Judge usage contains an invalid token count", { field: key });
    }
    usage[key] = amount;
  }
  return usage;
}

function addUsage(target, value) {
  const normalized = normalizeUsage(value);
  for (const key of USAGE_KEYS) {
    const sum = target[key] + normalized[key];
    if (!Number.isSafeInteger(sum) || sum < 0) {
      fail("JUDGE_USAGE_INVALID", "Aggregated token usage exceeds the safe integer range", { field: key });
    }
    target[key] = sum;
  }
  return target;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw makeAbortError();
}

function normalizeSegmentInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1) {
    fail("JUDGE_INPUT_INVALID", "At least one semantic-judge segment is required", {});
  }

  const normalized = inputs.map((entry, index) => {
    const path = `segments[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("JUDGE_INPUT_INVALID", `${path} must be an object`, { index });
    }
    const prepared = entry.prepared;
    const bound = entry.bound;
    if (!prepared?.source || !prepared?.mask || !bound?.segment) {
      fail("JUDGE_INPUT_INVALID", `${path} must contain prepared and bound provenance values`, { index });
    }
    assertExactKeys(prepared.source, SOURCE_KEYS, "JUDGE_INPUT_INVALID", `${path}.prepared.source`);
    assertExactKeys(bound.segment, SEGMENT_KEYS, "JUDGE_INPUT_INVALID", `${path}.bound.segment`);

    let sourceText;
    let targetText;
    try {
      sourceText = normalizeText(entry.source_text, `${path}.source_text`);
      targetText = normalizeText(bound.restored_text, `${path}.bound.restored_text`);
    } catch {
      fail("JUDGE_INPUT_INVALID", `${path} raw text fields must be strings`, { index });
    }
    if (!sourceText.trim() || !targetText.trim()) {
      fail("JUDGE_INPUT_INVALID", `${path} source and target text must not be empty`, { index });
    }

    const source = prepared.source;
    const segment = bound.segment;
    for (const key of SOURCE_KEYS) {
      if (segment[key] !== source[key]) {
        fail("JUDGE_INPUT_HASH_MISMATCH", "Prepared source and bound segment differ", {
          index,
          field: key,
        });
      }
    }

    assertCanonicalSha(source.source_sha256, `${path}.source_sha256`);
    assertCanonicalSha(source.invariant_manifest_sha256, `${path}.invariant_manifest_sha256`);
    assertCanonicalSha(segment.target_sha256, `${path}.target_sha256`);
    assertCanonicalSha(segment.binding_sha256, `${path}.binding_sha256`);

    let manifest;
    try {
      manifest = canonicalInvariantManifest(prepared.mask.manifest);
    } catch {
      fail("JUDGE_INPUT_INVALID", `${path} invariant manifest is invalid`, { index });
    }
    if (sha256Canonical(manifest) !== source.invariant_manifest_sha256) {
      fail("JUDGE_INPUT_HASH_MISMATCH", "Invariant manifest hash does not match the prepared source", {
        index,
      });
    }
    if (manifest.length !== source.invariant_count) {
      fail("JUDGE_INPUT_HASH_MISMATCH", "Invariant count does not match the prepared source", { index });
    }
    let expectedSourceSha;
    try {
      expectedSourceSha = sourceSegmentDigest({
        sourceText,
        kind: source.kind,
        page: source.page,
        order: source.order,
        invariantManifest: manifest,
      });
    } catch {
      fail("JUDGE_INPUT_INVALID", `${path} source provenance is invalid`, { index });
    }
    if (expectedSourceSha !== source.source_sha256) {
      fail("JUDGE_INPUT_HASH_MISMATCH", "Raw source text does not match its provenance hash", { index });
    }
    if (sha256Hex(targetText) !== segment.target_sha256) {
      fail("JUDGE_INPUT_HASH_MISMATCH", "Raw target text does not match its provenance hash", { index });
    }
    const expectedBinding = sha256Canonical({
      invariant_manifest_sha256: segment.invariant_manifest_sha256,
      segment_id: segment.segment_id,
      source_sha256: segment.source_sha256,
      target_sha256: segment.target_sha256,
    });
    if (expectedBinding !== segment.binding_sha256) {
      fail("JUDGE_INPUT_HASH_MISMATCH", "Segment binding hash is invalid", { index });
    }

    return {
      input: entry,
      segment,
      source_text: sourceText,
      target_text: targetText,
    };
  }).sort((left, right) => compareIds(left.segment.segment_id, right.segment.segment_id));

  const ids = normalized.map((item) => item.segment.segment_id);
  if (new Set(ids).size !== ids.length) {
    fail("JUDGE_INPUT_DUPLICATE", "Semantic-judge segment IDs must be unique", {});
  }
  return normalized;
}

/**
 * Build the exact raw-text request and its canonical digest.
 *
 * This return value contains private document text and is intended only for the
 * injected judge caller.  Persist or log `digest`, never `request`.
 */
function buildSemanticJudgeRequest({ segments }) {
  const normalized = normalizeSegmentInputs(segments);
  const request = {
    schema_version: SEMANTIC_JUDGE_SCHEMA_VERSION,
    task: SEMANTIC_JUDGE_TASK,
    target_language: "ko",
    items: normalized.map(({ segment, source_text: source, target_text: target }) => ({
      segment_id: segment.segment_id,
      source_sha256: segment.source_sha256,
      target_sha256: segment.target_sha256,
      source,
      target,
    })),
  };
  return {
    request,
    input_digest: digestJudgeInput(request),
    normalized,
  };
}

function parseStrictResponse(text) {
  if (typeof text !== "string" || !text.trim()) {
    fail("JUDGE_RESPONSE_INVALID_JSON", "Independent judge returned no strict JSON object", {});
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Never include a response excerpt: it can contain raw passages or arbitrary
    // model prose.
    fail("JUDGE_RESPONSE_INVALID_JSON", "Independent judge response is not strict JSON", {});
  }
  return parsed;
}

function validateSemanticJudgeResponse(response, normalizedSegments) {
  assertExactKeys(response, RESPONSE_TOP_LEVEL_KEYS, "JUDGE_RESPONSE_SCHEMA_INVALID", "response");
  if (
    response.schema_version !== SEMANTIC_JUDGE_SCHEMA_VERSION ||
    response.task !== SEMANTIC_JUDGE_TASK ||
    !Array.isArray(response.items)
  ) {
    fail("JUDGE_RESPONSE_SCHEMA_INVALID", "Independent judge response envelope is invalid", {});
  }

  const expectedById = new Map(normalizedSegments.map((item) => [item.segment.segment_id, item]));
  const seen = new Set();
  const received = new Map();

  for (let index = 0; index < response.items.length; index += 1) {
    const item = response.items[index];
    assertExactKeys(item, RESPONSE_ITEM_KEYS, "JUDGE_RESPONSE_SCHEMA_INVALID", `response.items[${index}]`);
    if (typeof item.segment_id !== "string" || !expectedById.has(item.segment_id)) {
      fail("JUDGE_ITEM_EXTRA", "Judge returned an unexpected segment item", { index });
    }
    if (seen.has(item.segment_id)) {
      fail("JUDGE_ITEM_DUPLICATE", "Judge returned a duplicate segment item", {
        segment_id: item.segment_id,
      });
    }
    seen.add(item.segment_id);
    const expected = expectedById.get(item.segment_id).segment;
    if (
      item.source_sha256 !== expected.source_sha256 ||
      item.target_sha256 !== expected.target_sha256
    ) {
      fail("JUDGE_ITEM_HASH_MISMATCH", "Judge item hashes do not match the requested segment", {
        segment_id: expected.segment_id,
      });
    }
    if (!new Set(["pass", "fail", "uncertain"]).has(item.verdict)) {
      fail("JUDGE_RESPONSE_SCHEMA_INVALID", "Judge item verdict is invalid", {
        segment_id: expected.segment_id,
      });
    }
    for (const field of BOOLEAN_FIELDS) {
      if (typeof item[field] !== "boolean") {
        fail("JUDGE_RESPONSE_SCHEMA_INVALID", "Judge item contains a non-boolean decision", {
          segment_id: expected.segment_id,
          field,
        });
      }
    }
    if (
      !Array.isArray(item.reason_codes) ||
      item.reason_codes.length > MAX_REASON_CODES ||
      new Set(item.reason_codes).size !== item.reason_codes.length ||
      item.reason_codes.some((code) => typeof code !== "string" || !REASON_CODE_SET.has(code))
    ) {
      // Unknown reason text is deliberately not echoed.
      fail("JUDGE_REASON_CODE_INVALID", "Judge item reason_codes are not in the bounded vocabulary", {
        segment_id: expected.segment_id,
        reason_count: Array.isArray(item.reason_codes) ? item.reason_codes.length : -1,
      });
    }

    const booleansPass = BOOLEAN_FIELDS.every((field) => item[field] === true);
    const accepted = item.verdict === "pass" && booleansPass;
    if (accepted && item.reason_codes.length !== 0) {
      fail("JUDGE_RESPONSE_SCHEMA_INVALID", "Passing judge items must not contain reason codes", {
        segment_id: expected.segment_id,
      });
    }
    if (!accepted && item.reason_codes.length === 0) {
      fail("JUDGE_RESPONSE_SCHEMA_INVALID", "Non-passing judge items require a bounded reason code", {
        segment_id: expected.segment_id,
      });
    }

    // A self-contradictory `verdict: pass` never overrides a false criterion.
    // It is normalized to fail and becomes a targeted retranslation candidate.
    const effectiveVerdict = accepted
      ? "pass"
      : item.verdict === "uncertain"
        ? "uncertain"
        : "fail";
    received.set(item.segment_id, {
      segment_id: expected.segment_id,
      source_sha256: expected.source_sha256,
      target_sha256: expected.target_sha256,
      verdict: effectiveVerdict,
      meaning_equivalent: item.meaning_equivalent,
      complete: item.complete,
      no_additions: item.no_additions,
      invariant_associations_correct: item.invariant_associations_correct,
      reason_codes: [...item.reason_codes],
      accepted,
    });
  }

  if (seen.size !== expectedById.size) {
    fail("JUDGE_ITEM_MISSING", "Judge response omitted one or more requested segments", {
      expected_count: expectedById.size,
      actual_count: seen.size,
    });
  }

  const evaluations = normalizedSegments.map((entry) => received.get(entry.segment.segment_id));
  const retranslationTargets = evaluations
    .filter((item) => !item.accepted)
    .map((item) => ({
      segment_id: item.segment_id,
      source_sha256: item.source_sha256,
      target_sha256: item.target_sha256,
      verdict: item.verdict,
      meaning_equivalent: item.meaning_equivalent,
      complete: item.complete,
      no_additions: item.no_additions,
      invariant_associations_correct: item.invariant_associations_correct,
      reason_codes: [...item.reason_codes],
    }));
  return { evaluations, retranslationTargets };
}

function apiRunner(apiSemaphore, resourceLimits) {
  if (apiSemaphore != null) {
    if (typeof apiSemaphore.run !== "function") {
      fail("JUDGE_API_GATE_INVALID", "apiSemaphore must expose an abort-aware run method", {});
    }
    return (task, options) => apiSemaphore.run(task, options);
  }
  const limits = resourceLimits || getProcessWidePdfTranslateResourceLimits();
  if (!limits || typeof limits.runApi !== "function") {
    fail("JUDGE_API_GATE_INVALID", "resourceLimits must expose runApi", {});
  }
  return (task, options) => limits.runApi(task, options);
}

async function judgeSemanticSegments({
  segments,
  generationProvider,
  judgeProvider,
  judgeModel,
  caller,
  signal,
  apiSemaphore,
  resourceLimits,
}) {
  const generation = assertOpaqueIdentifier(generationProvider, "generationProvider");
  const provider = assertOpaqueIdentifier(judgeProvider, "judgeProvider");
  const model = assertOpaqueIdentifier(judgeModel, "judgeModel");
  if (providerFamily(generation) === providerFamily(provider)) {
    fail("SELF_JUDGE_FORBIDDEN", "Generation and semantic judgment must use independent providers", {
      generation_provider_family: providerFamily(generation),
      judge_provider_family: providerFamily(provider),
    });
  }
  if (typeof caller !== "function") {
    fail("JUDGE_CALLER_INVALID", "An injected semantic judge caller is required", {});
  }
  throwIfAborted(signal);

  const built = buildSemanticJudgeRequest({ segments });
  const run = apiRunner(apiSemaphore, resourceLimits);
  let envelope;
  try {
    envelope = await run(
      () => caller({
        provider,
        model,
        system: SYSTEM_PROMPT,
        user: canonicalJson(built.request),
        // This object contains the same raw text as `user`; it is provided for
        // typed/structured-output adapters and must not be logged.
        request: built.request,
        maxTokens: Math.min(32000, Math.max(2000, built.request.items.length * 240)),
        signal,
      }),
      { signal },
    );
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw makeAbortError();
    // Provider messages/bodies can quote source or target passages.
    fail("JUDGE_CALL_FAILED", "Independent semantic judge call failed", {});
  }
  throwIfAborted(signal);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    fail("JUDGE_CALL_FAILED", "Independent semantic judge returned an invalid envelope", {});
  }
  const requestId = assertOpaqueIdentifier(
    envelope.request_id ?? envelope.requestId ?? envelope.id,
    "judge.request_id",
  );
  const usage = normalizeUsage(envelope.usage);
  const response = parseStrictResponse(envelope.text);
  const validated = validateSemanticJudgeResponse(response, built.normalized);
  const judgeItems = validated.evaluations.map((evaluation, index) =>
    createJudgeItem(built.normalized[index].segment, evaluation.verdict));
  const judge = {
    provider,
    model,
    request_id: requestId,
    input_digest: built.input_digest,
    items: judgeItems,
  };

  return {
    judge,
    evaluations: validated.evaluations,
    retranslation_targets: validated.retranslationTargets,
    usage,
  };
}

function sanitizedRound(result, retranslationAttempt) {
  return {
    retranslation_attempt: retranslationAttempt,
    request_id: result.judge.request_id,
    input_digest: result.judge.input_digest,
    items: result.evaluations.map((item) => ({
      segment_id: item.segment_id,
      source_sha256: item.source_sha256,
      target_sha256: item.target_sha256,
      verdict: item.verdict,
      meaning_equivalent: item.meaning_equivalent,
      complete: item.complete,
      no_additions: item.no_additions,
      invariant_associations_correct: item.invariant_associations_correct,
      reason_codes: [...item.reason_codes],
    })),
  };
}

function parseRetranslationEnvelope(value) {
  if (Array.isArray(value)) return { segments: value, usage: emptyUsage() };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("RETRANSLATION_RESULT_INVALID", "Retranslation must return targeted segment descriptors", {});
  }
  if (!Array.isArray(value.segments)) {
    fail("RETRANSLATION_RESULT_INVALID", "Retranslation result is missing its targeted segments", {});
  }
  return { segments: value.segments, usage: normalizeUsage(value.usage) };
}

function mergeTargetedRetranslations(current, replacements, targetIds) {
  const normalized = normalizeSegmentInputs(replacements);
  const replacementIds = normalized.map((item) => item.segment.segment_id);
  const expectedIds = [...targetIds].sort(compareIds);
  if (canonicalJson(replacementIds) !== canonicalJson(expectedIds)) {
    fail("RETRANSLATION_SET_MISMATCH", "Retranslation must replace exactly the rejected segment IDs", {
      expected_count: expectedIds.length,
      actual_count: replacementIds.length,
    });
  }

  const currentById = new Map(current.map((entry) => [entry.bound.segment.segment_id, entry]));
  const replacementById = new Map();
  for (const item of normalized) {
    const prior = currentById.get(item.segment.segment_id);
    if (!prior || prior.prepared.source.source_sha256 !== item.segment.source_sha256) {
      fail("RETRANSLATION_SOURCE_MISMATCH", "Retranslation changed a source segment binding", {
        segment_id: item.segment.segment_id,
      });
    }
    replacementById.set(item.segment.segment_id, item.input);
  }
  return current.map((entry) =>
    replacementById.get(entry.bound.segment.segment_id) || entry);
}

/**
 * Apply the bounded semantic retry policy.
 *
 * Every judgment covers the complete current segment set so its final digest can
 * be sealed directly as provenance.  Only failed/uncertain/false segments are
 * passed to `retranslate`, so already-passing translations are never regenerated.
 */
async function runSemanticJudgePolicy({
  segments,
  generationProvider,
  judgeProvider,
  judgeModel,
  caller,
  retranslate,
  maxRetranslations = MAX_SEMANTIC_RETRANSLATIONS,
  signal,
  apiSemaphore,
  resourceLimits,
}) {
  if (
    !Number.isInteger(maxRetranslations) ||
    maxRetranslations < 0 ||
    maxRetranslations > MAX_SEMANTIC_RETRANSLATIONS
  ) {
    fail(
      "SEMANTIC_RETRY_POLICY_INVALID",
      `maxRetranslations must be an integer from 0 to ${MAX_SEMANTIC_RETRANSLATIONS}`,
      {},
    );
  }
  if (typeof retranslate !== "function" && maxRetranslations > 0) {
    fail("RETRANSLATION_CALLER_INVALID", "An injected targeted retranslation function is required", {});
  }

  // Validate once before any model call. Preserve the caller-owned descriptors
  // because the retry callback needs their raw source/target context.
  normalizeSegmentInputs(segments);
  let current = [...segments];
  let retranslationAttempt = 0;
  const judgeUsage = emptyUsage();
  const retranslationUsage = emptyUsage();
  const rounds = [];

  while (true) {
    throwIfAborted(signal);
    const result = await judgeSemanticSegments({
      segments: current,
      generationProvider,
      judgeProvider,
      judgeModel,
      caller,
      signal,
      apiSemaphore,
      resourceLimits,
    });
    addUsage(judgeUsage, result.usage);
    rounds.push(sanitizedRound(result, retranslationAttempt));

    if (result.retranslation_targets.length === 0) {
      const totalUsage = emptyUsage();
      addUsage(totalUsage, judgeUsage);
      addUsage(totalUsage, retranslationUsage);
      return {
        final_segments: current,
        judge: result.judge,
        evaluations: result.evaluations,
        retranslation_attempts: retranslationAttempt,
        rounds,
        judge_usage: judgeUsage,
        retranslation_usage: retranslationUsage,
        usage: totalUsage,
      };
    }

    if (retranslationAttempt >= maxRetranslations) {
      const totalUsage = emptyUsage();
      addUsage(totalUsage, judgeUsage);
      addUsage(totalUsage, retranslationUsage);
      fail("SEMANTIC_RETRY_EXHAUSTED", "Independent semantic review did not pass; the entire document is rejected", {
        retranslation_attempts: retranslationAttempt,
        rejected_segment_ids: result.retranslation_targets.map((item) => item.segment_id),
        judge_usage: judgeUsage,
        retranslation_usage: retranslationUsage,
        usage: totalUsage,
      });
    }

    retranslationAttempt += 1;
    const targetIds = result.retranslation_targets.map((item) => item.segment_id).sort(compareIds);
    const targetIdSet = new Set(targetIds);
    const targeted = current.filter((entry) => targetIdSet.has(entry.bound.segment.segment_id));
    let retryEnvelope;
    try {
      retryEnvelope = await retranslate({
        segments: targeted,
        targets: result.retranslation_targets,
        attempt: retranslationAttempt,
        signal,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw makeAbortError();
      // Translator errors may quote raw source/target text.
      fail("RETRANSLATION_FAILED", "Targeted semantic retranslation failed", {
        attempt: retranslationAttempt,
        target_count: targetIds.length,
      });
    }
    throwIfAborted(signal);
    const parsedRetry = parseRetranslationEnvelope(retryEnvelope);
    addUsage(retranslationUsage, parsedRetry.usage);
    current = mergeTargetedRetranslations(current, parsedRetry.segments, targetIds);
  }
}

module.exports = {
  MAX_REASON_CODES,
  MAX_SEMANTIC_RETRANSLATIONS,
  REASON_CODES,
  SEMANTIC_JUDGE_SCHEMA_VERSION,
  SEMANTIC_JUDGE_TASK,
  SYSTEM_PROMPT,
  SemanticJudgeError,
  addUsage,
  buildSemanticJudgeRequest,
  emptyUsage,
  judgeSemanticSegments,
  normalizeUsage,
  runSemanticJudgePolicy,
  validateSemanticJudgeResponse,
};
