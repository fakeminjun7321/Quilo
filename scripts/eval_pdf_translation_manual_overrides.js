#!/usr/bin/env node
"use strict";

// One-run, source-bound correction adapter for the resumable Codex PDF runner.
//
// This file deliberately does not change the shared translation or rendering
// engine.  It injects reviewed replacements through the existing `caller`
// boundary, runs the ordinary deterministic translation / render gates, and
// writes exactly one normal part checkpoint per requested chunk.  The adapter
// never edits model-cache files.

process.env.PDF_TRANSLATE_BATCH_CHARS =
  process.env.PDF_TRANSLATE_BATCH_CHARS || "45000";
process.env.PDF_TRANSLATE_BATCH_IDS =
  process.env.PDF_TRANSLATE_BATCH_IDS || "350";
process.env.PDF_TRANSLATE_ALLOW_TABLE_OVERLAY =
  process.env.PDF_TRANSLATE_ALLOW_TABLE_OVERLAY || "1";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const pdfTool = require("../lib/pipelines/pdf-translate/pdf-tool");
const {
  annotatePageContinuations,
  buildTranslationReusePlan,
  createPdfTranslateResourceLimits,
  makeGate,
  pageContinuationIssue,
  translateSinglePdf,
  validateTranslationMap,
} = require("../lib/pipelines/pdf-translate/translate");
const {
  verifyPdfTranslationPostflight,
} = require("../lib/pipelines/pdf-translate/postflight");
const {
  makeCodexCaller,
  requestedItems,
} = require("./eval_pdf_translation_codex_subscription");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_MODEL = "gpt-5.4";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const OCR_LAYER_MAX_BATCH_PAGES = 6;
const FONT_PATH = fs.existsSync(path.join(ROOT, "lib/fonts/Pretendard-Regular.ttf"))
  ? path.join(ROOT, "lib/fonts/Pretendard-Regular.ttf")
  : path.join(ROOT, "lib/fonts/NanumGothic-Regular.ttf");
const MIXED_SPAN_PATCH_SCRIPT = path.join(
  ROOT,
  "scripts/patch_pdf_translation_mixed_spans.py",
);

function usage() {
  return [
    "Usage: node scripts/eval_pdf_translation_manual_overrides.js --run-dir DIR --manifest FILE.json [options]",
    "",
    "Options:",
    `  --model MODEL          Codex subscription model (default: ${DEFAULT_MODEL})`,
    "  --chunk-index N       Generate only one zero-based manifest chunk",
    "  --timeout-ms N        Per model/postflight deadline (default: 1200000)",
    "  --help                Show this help",
  ].join("\n");
}

function parseArgs(argv, cwd = process.cwd()) {
  const out = {
    runDir: null,
    manifest: null,
    model: DEFAULT_MODEL,
    chunkIndex: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const next = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--run-dir") {
      out.runDir = path.resolve(cwd, next(index, arg));
      index += 1;
    } else if (arg === "--manifest") {
      out.manifest = path.resolve(cwd, next(index, arg));
      index += 1;
    } else if (arg === "--model") {
      out.model = next(index, arg);
      index += 1;
    } else if (arg === "--chunk-index") {
      out.chunkIndex = Number(next(index, arg));
      index += 1;
    } else if (arg === "--timeout-ms") {
      out.timeoutMs = Number(next(index, arg));
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.runDir || !out.manifest) {
    throw new Error("--run-dir and --manifest are required");
  }
  if (
    out.chunkIndex != null &&
    (!Number.isSafeInteger(out.chunkIndex) || out.chunkIndex < 0)
  ) {
    throw new Error("--chunk-index must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(out.timeoutMs) ||
    out.timeoutMs < 10_000 ||
    out.timeoutMs > 60 * 60 * 1000
  ) {
    throw new Error("--timeout-ms must be an integer from 10000 to 3600000");
  }
  return out;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ""));
}

function readRegularFile(filePath, { maximum = null, label = "file" } = {}) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`${label} must be a regular, non-symlink file`);
  }
  if (maximum != null && info.size > maximum) {
    throw new Error(`${label} exceeds ${maximum} bytes`);
  }
  return fs.readFileSync(filePath);
}

function readJsonRegular(filePath, options = {}) {
  const bytes = readRegularFile(filePath, options);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${options.label || "JSON file"} is invalid UTF-8 JSON: ${error.message}`);
  }
  return { bytes, value };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeRect(value, label) {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    value.some((item) => !Number.isFinite(Number(item)))
  ) {
    throw new Error(`${label} must contain four finite numbers`);
  }
  const rect = value.map(Number);
  if (!(rect[2] > rect[0] && rect[3] > rect[1])) {
    throw new Error(`${label} must have positive width and height`);
  }
  return rect;
}

function normalizeMixedSpan(value, entryLabel) {
  if (value == null) return null;
  const mixed = assertPlainObject(value, `${entryLabel}.mixed_span`);
  if (!Number.isSafeInteger(Number(mixed.page)) || Number(mixed.page) < 0) {
    throw new Error(`${entryLabel}.mixed_span.page must be a zero-based page integer`);
  }
  const formulaSpans = Array.isArray(mixed.formula_spans)
    ? mixed.formula_spans.map((span, index) => {
        const item = assertPlainObject(
          span,
          `${entryLabel}.mixed_span.formula_spans[${index}]`,
        );
        if (!String(item.text || "") || !String(item.font || "")) {
          throw new Error(`${entryLabel} formula spans need non-empty text and font`);
        }
        return {
          text: String(item.text),
          font: String(item.font),
          bbox: normalizeRect(item.bbox, `${entryLabel}.formula_spans[${index}].bbox`),
          text_sha256: isSha256(item.text_sha256)
            ? String(item.text_sha256)
            : sha256(String(item.text)),
        };
      })
    : [];
  if (!formulaSpans.length) {
    throw new Error(`${entryLabel}.mixed_span.formula_spans must not be empty`);
  }
  if (!String(mixed.prose_source || "").trim() || !String(mixed.render_target || "").trim()) {
    throw new Error(`${entryLabel}.mixed_span needs prose_source and render_target`);
  }
  return {
    page: Number(mixed.page),
    full_bbox: normalizeRect(mixed.full_bbox, `${entryLabel}.mixed_span.full_bbox`),
    prose_bbox: normalizeRect(mixed.prose_bbox, `${entryLabel}.mixed_span.prose_bbox`),
    prose_source: String(mixed.prose_source),
    render_target: String(mixed.render_target),
    final_prose: String(mixed.final_prose || mixed.render_target),
    minimum_font_pt: Number.isFinite(Number(mixed.minimum_font_pt))
      ? Math.max(8, Number(mixed.minimum_font_pt))
      : 8,
    formula_spans: formulaSpans,
  };
}

const SUPERSCRIPT_CHARACTERS = Object.freeze({
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴",
  "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ",
  h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ", n: "ⁿ",
  o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ",
  w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
});
const SUBSCRIPT_CHARACTERS = Object.freeze({
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄",
  "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ", r: "ᵣ", s: "ₛ", t: "ₜ",
  u: "ᵤ", v: "ᵥ", x: "ₓ",
});

function taggedScientificToUnicode(value) {
  const convert = (body, table, tag) => {
    const chars = [...body];
    if (!chars.length || chars.some((char) => !table[char])) {
      throw new Error(`render_target has an unsupported <${tag}> literal: ${body}`);
    }
    return chars.map((char) => table[char]).join("");
  };
  let result = String(value || "");
  result = result.replace(/<sup>([^<>]+)<\/sup>/g, (_match, body) =>
    convert(body, SUPERSCRIPT_CHARACTERS, "sup"));
  result = result.replace(/<sub>([^<>]+)<\/sub>/g, (_match, body) =>
    convert(body, SUBSCRIPT_CHARACTERS, "sub"));
  if (/<\/?(?:sub|sup)>/i.test(result)) {
    throw new Error("render_target conversion left unmatched scientific markup");
  }
  return result;
}

function normalizeManifest(raw, rawBytes) {
  const manifest = assertPlainObject(raw, "manifest");
  if (Number(manifest.schema_version) !== 1) {
    throw new Error("manifest.schema_version must be 1");
  }
  if (!isSha256(manifest.source_pdf_sha256)) {
    throw new Error("manifest.source_pdf_sha256 must be a lowercase SHA-256");
  }
  if (!isSha256(manifest.translation_fingerprint)) {
    throw new Error("manifest.translation_fingerprint must be a lowercase SHA-256");
  }
  if (!Array.isArray(manifest.chunks) || !manifest.chunks.length) {
    throw new Error("manifest.chunks must be a non-empty array");
  }
  const chunkIndexes = new Set();
  const chunks = manifest.chunks.map((chunkValue, chunkPosition) => {
    const chunk = assertPlainObject(chunkValue, `manifest.chunks[${chunkPosition}]`);
    const chunkIndex = Number(chunk.chunk_index);
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      throw new Error(`manifest.chunks[${chunkPosition}].chunk_index must be non-negative`);
    }
    if (chunkIndexes.has(chunkIndex)) throw new Error(`duplicate chunk_index ${chunkIndex}`);
    chunkIndexes.add(chunkIndex);
    if (!isSha256(chunk.chunk_pdf_sha256)) {
      throw new Error(`chunk ${chunkIndex} needs chunk_pdf_sha256`);
    }
    if (!Array.isArray(chunk.overrides) || !chunk.overrides.length) {
      throw new Error(`chunk ${chunkIndex} overrides must be non-empty`);
    }
    const ids = new Set();
    const overrides = chunk.overrides.map((entryValue, entryPosition) => {
      const label = `chunk ${chunkIndex} override[${entryPosition}]`;
      const entry = assertPlainObject(entryValue, label);
      const id = String(entry.id == null ? "" : entry.id);
      if (!id || id === "undefined") throw new Error(`${label}.id is invalid`);
      if (ids.has(id)) throw new Error(`chunk ${chunkIndex} has duplicate ID ${id}`);
      ids.add(id);
      if (!isSha256(entry.source_text_sha256)) {
        throw new Error(`${label}.source_text_sha256 is invalid`);
      }
      if (typeof entry.target !== "string" || !entry.target.trim()) {
        throw new Error(`${label}.target must be a non-empty string`);
      }
      const renderTarget = entry.render_target == null
        ? null
        : String(entry.render_target);
      if (renderTarget != null) {
        if (!renderTarget.trim()) throw new Error(`${label}.render_target is empty`);
        if (renderTarget !== taggedScientificToUnicode(entry.target)) {
          throw new Error(
            `${label}.render_target must be the exact Unicode sub/sup rendering of target`,
          );
        }
      }
      return {
        id,
        source_text_sha256: String(entry.source_text_sha256),
        target: entry.target,
        render_target: renderTarget,
        mixed_span: normalizeMixedSpan(entry.mixed_span, label),
      };
    });
    return {
      chunk_index: chunkIndex,
      chunk_pdf_sha256: String(chunk.chunk_pdf_sha256),
      overrides,
    };
  });
  return {
    schema_version: 1,
    source_pdf_sha256: String(manifest.source_pdf_sha256),
    translation_fingerprint: String(manifest.translation_fingerprint),
    manifest_sha256: sha256(rawBytes),
    chunks,
  };
}

function validCurrentPartFingerprints(runDir, split) {
  const partsDir = path.join(runDir, "parts");
  if (!fs.existsSync(partsDir)) return new Set();
  const fingerprints = new Set();
  for (let index = 0; index < (split.chunks || []).length; index += 1) {
    const stem = `part-${String(index).padStart(3, "0")}`;
    const pdfPath = path.join(partsDir, `${stem}.ko.pdf`);
    const metaPath = path.join(partsDir, `${stem}.json`);
    if (!fs.existsSync(pdfPath) || !fs.existsSync(metaPath)) continue;
    try {
      const metadata = readJsonRegular(metaPath, { label: `${stem} metadata` }).value;
      const chunkBytes = readRegularFile(split.chunks[index].path, { label: `${stem} chunk` });
      const outputBytes = readRegularFile(pdfPath, { label: `${stem} output` });
      if (
        metadata.chunk_index === index &&
        metadata.source_sha256 === sha256(chunkBytes) &&
        metadata.output_sha256 === sha256(outputBytes) &&
        isSha256(metadata.translation_fingerprint)
      ) {
        fingerprints.add(metadata.translation_fingerprint);
      }
    } catch {
      // A malformed/stale sibling is not evidence for the current run.
    }
  }
  return fingerprints;
}

function validateOverrideBindings(chunkManifest, extractedBlocks) {
  const annotated = annotatePageContinuations(extractedBlocks || []);
  const blocksById = new Map(annotated.map((block) => [String(block.id), block]));
  const overrides = new Map();
  for (const entry of chunkManifest.overrides) {
    const block = blocksById.get(entry.id);
    if (!block) throw new Error(`chunk ${chunkManifest.chunk_index} has no source ID ${entry.id}`);
    const actualSourceHash = sha256(String(block.text || ""));
    if (actualSourceHash !== entry.source_text_sha256) {
      throw new Error(`chunk ${chunkManifest.chunk_index} ID ${entry.id} source text hash mismatch`);
    }
    const validated = validateTranslationMap([block], { [entry.id]: entry.target });
    if (!validated.accepted[entry.id]) {
      const codes = (validated.rejected[entry.id]?.reasons || [])
        .map((reason) => reason.code)
        .join(", ");
      throw new Error(`chunk ${chunkManifest.chunk_index} ID ${entry.id} target failed validation: ${codes || "unknown"}`);
    }
    if (entry.mixed_span) {
      if (Number(block.page) !== entry.mixed_span.page) {
        throw new Error(`chunk ${chunkManifest.chunk_index} ID ${entry.id} mixed-span page mismatch`);
      }
      const renderBlock = { ...block, text: entry.mixed_span.prose_source };
      const renderValidation = validateTranslationMap(
        [renderBlock],
        { [entry.id]: entry.mixed_span.render_target },
      );
      if (!renderValidation.accepted[entry.id]) {
        throw new Error(`chunk ${chunkManifest.chunk_index} ID ${entry.id} mixed-span render target failed validation`);
      }
    }
    overrides.set(entry.id, { ...entry, block });
  }

  const groups = new Map();
  for (const block of annotated) {
    if (!block.continuation_group) continue;
    const key = String(block.continuation_group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(block);
  }
  for (const entry of overrides.values()) {
    const groupKey = entry.block.continuation_group;
    if (!groupKey) continue;
    const members = groups.get(String(groupKey)) || [];
    const missing = members
      .map((block) => String(block.id))
      .filter((id) => !overrides.has(id));
    if (missing.length) {
      throw new Error(
        `chunk ${chunkManifest.chunk_index} continuation group ${groupKey} must override every member (missing ${missing.join(", ")})`,
      );
    }
    const groupTranslations = Object.fromEntries(
      members.map((block) => [String(block.id), overrides.get(String(block.id)).target]),
    );
    const issue = pageContinuationIssue(members, groupTranslations);
    if (issue) {
      throw new Error(
        `chunk ${chunkManifest.chunk_index} continuation group ${groupKey} failed validation: ${issue.code}`,
      );
    }
  }
  return { annotated, overrides };
}

function makeOverrideCaller(baseCaller, overrideMap, appliedIds) {
  if (typeof baseCaller !== "function") throw new TypeError("baseCaller must be a function");
  return async (request) => {
    const items = requestedItems(request.user);
    const manual = new Map();
    for (const item of items) {
      const id = String(item.id);
      const entry = overrideMap.get(id);
      if (!entry) continue;
      const expectedSource = entry.mixed_span
        ? entry.mixed_span.prose_source
        : String(entry.block.text || "");
      if (String(item.text || "") !== expectedSource) {
        throw new Error(`manual override ID ${id} caller source binding mismatch`);
      }
      manual.set(
        id,
        entry.mixed_span ? entry.mixed_span.render_target : entry.target,
      );
    }

    let response;
    if (manual.size === items.length) {
      response = {
        text: JSON.stringify({ t: Object.fromEntries(manual) }),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    } else {
      response = await baseCaller(request);
      let structured;
      try {
        structured = JSON.parse(String(response.text || ""));
      } catch (error) {
        throw new Error(`base caller returned invalid JSON: ${error.message}`);
      }
      if (!structured || typeof structured !== "object" || Array.isArray(structured)) {
        throw new Error("base caller returned a non-object response");
      }
      if (!structured.t || typeof structured.t !== "object" || Array.isArray(structured.t)) {
        throw new Error("base caller response is missing its t map");
      }
      for (const [id, target] of manual) structured.t[id] = target;
      response = { ...response, text: JSON.stringify(structured) };
    }
    for (const id of manual.keys()) appliedIds.add(id);
    return response;
  };
}

function mixedSpanPdfTool(baseTool, overrideMap) {
  const mixed = [...overrideMap.values()].filter((entry) => entry.mixed_span);
  const renderOnly = [...overrideMap.values()].filter((entry) => entry.render_target);
  if (!mixed.length && !renderOnly.length) return baseTool;
  return {
    ...baseTool,
    async extractBlocks(pdfPath, options) {
      const extracted = await baseTool.extractBlocks(pdfPath, options);
      return {
        ...extracted,
        blocks: (extracted.blocks || []).map((block) => {
          const entry = overrideMap.get(String(block.id));
          return entry?.mixed_span
            ? { ...block, text: entry.mixed_span.prose_source }
            : block;
        }),
      };
    },
    async renderTranslated(pdfPath, outputPath, fontPath, translations, options) {
      const renderedTranslations = { ...translations };
      for (const entry of renderOnly) {
        if (renderedTranslations[entry.id] !== entry.target) {
          throw new Error(`render-only override ID ${entry.id} lost its validated target binding`);
        }
        renderedTranslations[entry.id] = entry.render_target;
      }
      return baseTool.renderTranslated(
        pdfPath,
        outputPath,
        fontPath,
        renderedTranslations,
        options,
      );
    },
  };
}

function runProcess(command, args, { input = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${err.slice(-1600)}`));
      else resolve({ stdout: out, stderr: err });
    });
    child.stdin.end(input);
  });
}

async function applyMixedSpanRepairs({ sourcePath, inputPath, outputPath, entries, timeoutMs }) {
  if (!entries.length) {
    fs.copyFileSync(inputPath, outputPath, fs.constants.COPYFILE_EXCL);
    return null;
  }
  if (!fs.existsSync(MIXED_SPAN_PATCH_SCRIPT)) {
    throw new Error(`mixed-span patch helper is missing: ${MIXED_SPAN_PATCH_SCRIPT}`);
  }
  const python = process.env.PYTHON_BIN || path.join(ROOT, ".venv/bin/python3");
  const payload = {
    schema_version: 1,
    source_pdf_sha256: sha256(readRegularFile(sourcePath, { label: "chunk PDF" })),
    translated_pdf_sha256: sha256(readRegularFile(inputPath, { label: "translated part" })),
    repairs: entries.map((entry) => ({ id: entry.id, ...entry.mixed_span })),
  };
  const result = await runProcess(
    python,
    [MIXED_SPAN_PATCH_SCRIPT, sourcePath, inputPath, outputPath, FONT_PATH],
    { input: JSON.stringify(payload), timeoutMs },
  );
  let stats;
  try {
    stats = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(`mixed-span patch returned invalid JSON: ${error.message}`);
  }
  if (!stats.ok || stats.repairs !== entries.length || stats.pixel_exact !== true) {
    throw new Error("mixed-span patch did not prove every formula span pixel-exact");
  }
  return stats;
}

function writePartPairAtomic(partPath, metadataPath, buffer, metadata) {
  if (fs.existsSync(partPath) || fs.existsSync(metadataPath)) {
    throw new Error(`refusing to overwrite an existing part checkpoint: ${partPath}`);
  }
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const tempPart = `${partPath}.partial-${nonce}`;
  const tempMetadata = `${metadataPath}.partial-${nonce}`;
  let partPublished = false;
  try {
    fs.writeFileSync(tempPart, buffer, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(
      tempMetadata,
      `${JSON.stringify(metadata, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
    fs.renameSync(tempPart, partPath);
    partPublished = true;
    fs.renameSync(tempMetadata, metadataPath);
  } catch (error) {
    if (partPublished) {
      try {
        if (sha256(fs.readFileSync(partPath)) === sha256(buffer)) fs.rmSync(partPath);
      } catch {}
    }
    throw error;
  } finally {
    fs.rmSync(tempPart, { force: true });
    fs.rmSync(tempMetadata, { force: true });
  }
}

async function capturePostflight(postflight, options) {
  try {
    const report = await postflight(options);
    return { passed: true, report };
  } catch (error) {
    const report = error?.details?.report;
    if (!report || typeof report !== "object" || !Array.isArray(report.hard_failures)) {
      throw error;
    }
    return { passed: false, report };
  }
}

function assertPostflightNonRegression(baseOutcome, patchedOutcome) {
  if (!baseOutcome || !patchedOutcome) {
    throw new Error("mixed-span differential postflight outcomes are missing");
  }
  if (patchedOutcome.passed) return { mode: "strict_pass", new_failures: [] };
  if (baseOutcome.passed) {
    throw new Error("mixed-span patch introduced strict postflight failures");
  }
  const before = new Set(baseOutcome.report.hard_failures || []);
  const after = new Set(patchedOutcome.report.hard_failures || []);
  const introduced = [...after].filter((failure) => !before.has(failure));
  if (introduced.length) {
    throw new Error(`mixed-span patch introduced postflight failures: ${introduced.join(", ")}`);
  }
  const beforeIssues = Number(baseOutcome.report.summary?.pages_with_issues || 0);
  const afterIssues = Number(patchedOutcome.report.summary?.pages_with_issues || 0);
  if (afterIssues > beforeIssues) {
    throw new Error(
      `mixed-span patch increased verifier issue pages ${beforeIssues}→${afterIssues}`,
    );
  }
  return {
    mode: "differential_non_regression",
    new_failures: [],
    baseline_failures: [...before].sort(),
    patched_failures: [...after].sort(),
    baseline_issue_pages: beforeIssues,
    patched_issue_pages: afterIssues,
  };
}

async function generateChunkPart({
  runDir,
  manifest,
  chunkManifest,
  model,
  timeoutMs,
  split,
  dependencies = {},
}) {
  const tool = dependencies.pdfTool || pdfTool;
  const translate = dependencies.translateSinglePdf || translateSinglePdf;
  const makeBaseCaller = dependencies.makeCodexCaller || makeCodexCaller;
  const postflight = dependencies.verifyPdfTranslationPostflight || verifyPdfTranslationPostflight;
  const chunk = split.chunks[chunkManifest.chunk_index];
  if (!chunk) throw new Error(`split has no chunk_index ${chunkManifest.chunk_index}`);
  const chunkBytes = readRegularFile(chunk.path, { label: `chunk ${chunkManifest.chunk_index}` });
  if (sha256(chunkBytes) !== chunkManifest.chunk_pdf_sha256) {
    throw new Error(`chunk ${chunkManifest.chunk_index} PDF hash mismatch`);
  }
  const extracted = await tool.extractBlocks(chunk.path);
  const { overrides } = validateOverrideBindings(chunkManifest, extracted.blocks || []);
  const auditPath = path.join(
    runDir,
    "ocr-audit",
    `chunk-${String(chunkManifest.chunk_index).padStart(3, "0")}`,
    "audit.json",
  );
  const audit = readJsonRegular(auditPath, { label: "OCR audit" }).value;
  if (audit.source_sha256 !== chunkManifest.chunk_pdf_sha256) {
    throw new Error(`chunk ${chunkManifest.chunk_index} OCR audit source hash mismatch`);
  }
  const idToPage = new Map(
    (extracted.blocks || []).map((block) => [String(block.id), block.page]),
  );
  const diagnostics = [];
  const baseCaller = makeBaseCaller({
    model,
    timeoutMs,
    idToPage,
    audit,
    globalPageOffset: Number(chunk.start) - 1,
    diagnostics,
    cacheDir: path.join(runDir, "codex-cache"),
    requireCompletePageImages: !!extracted.ocr_layer,
  });
  const appliedIds = new Set();
  const caller = makeOverrideCaller(baseCaller, overrides, appliedIds);
  const resourceLimits = createPdfTranslateResourceLimits({
    apiConcurrency: 1,
    documentConcurrency: 1,
  });
  const result = await translate({
    pdfBuffer: chunkBytes,
    caller,
    gate: makeGate(1),
    progress: { addTotal() {}, tick() {} },
    onProgress(message) {
      process.stderr.write(`chunk ${chunkManifest.chunk_index + 1}: ${message}\n`);
    },
    resourceLimits,
    retrySizes: [6000, 2500, 900, 1, 1],
    batchPages: extracted.ocr_layer ? OCR_LAYER_MAX_BATCH_PAGES : null,
    pdfTool: mixedSpanPdfTool(tool, overrides),
  });
  const direct = buildTranslationReusePlan(annotatePageContinuations(extracted.blocks || [])).direct;
  const unapplied = [...overrides.values()]
    .filter((entry) => !appliedIds.has(entry.id) && direct[entry.id] !== entry.target)
    .map((entry) => entry.id);
  if (unapplied.length) {
    throw new Error(`manual overrides never reached the caller: ${unapplied.join(", ")}`);
  }

  const mixedEntries = [...overrides.values()].filter((entry) => entry.mixed_span);
  const basePostflight = mixedEntries.length
    ? await capturePostflight(postflight, {
        originalBuffer: chunkBytes,
        resultBuffer: result.buffer,
        mode: "inplace",
        intent: "translate",
        timeoutMs,
      })
    : null;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-manual-part-"));
  let finalBuffer;
  let mixedStats = null;
  try {
    const renderedPath = path.join(tempDir, "rendered.pdf");
    const patchedPath = path.join(tempDir, "patched.pdf");
    fs.writeFileSync(renderedPath, result.buffer, { mode: 0o600 });
    mixedStats = await applyMixedSpanRepairs({
      sourcePath: chunk.path,
      inputPath: renderedPath,
      outputPath: patchedPath,
      entries: mixedEntries,
      timeoutMs,
    });
    finalBuffer = fs.readFileSync(patchedPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  const patchedPostflight = mixedStats
    ? await capturePostflight(postflight, {
        originalBuffer: chunkBytes,
        resultBuffer: finalBuffer,
        mode: "inplace",
        intent: "translate",
        timeoutMs,
      })
    : null;
  const postflightComparison = mixedStats
    ? assertPostflightNonRegression(basePostflight, patchedPostflight)
    : null;
  const partsDir = path.join(runDir, "parts");
  fs.mkdirSync(partsDir, { recursive: true });
  const stem = `part-${String(chunkManifest.chunk_index).padStart(3, "0")}`;
  const partPath = path.join(partsDir, `${stem}.ko.pdf`);
  const metadataPath = path.join(partsDir, `${stem}.json`);
  const provenance = [...overrides.values()].map((entry) => ({
    id: entry.id,
    source_text_sha256: entry.source_text_sha256,
    target_sha256: sha256(entry.target),
    render_target_sha256: entry.mixed_span
      ? sha256(entry.mixed_span.render_target)
      : sha256(entry.render_target || entry.target),
    mode: entry.mixed_span
      ? "mixed_span_source_restore"
      : (entry.render_target ? "validated_unicode_layout_render" : "caller_override"),
  }));
  diagnostics.push({
    at: new Date().toISOString(),
    model: "manual-reviewed-override",
    item_count: provenance.length,
    source_pages: [...new Set(
      [...overrides.values()].map((entry) => Number(chunk.start) + Number(entry.block.page)),
    )].sort((a, b) => a - b),
    cache_hit: false,
    manual_override_manifest_sha256: manifest.manifest_sha256,
    manual_quality_gate_min_font_pt: Number(
      process.env.PDF_TRANSLATE_MIN_FONT_PT || 8,
    ),
  });
  const metadata = {
    chunk_index: chunkManifest.chunk_index,
    source_start: chunk.start,
    source_end: chunk.end,
    source_sha256: chunkManifest.chunk_pdf_sha256,
    output_sha256: sha256(finalBuffer),
    translation_fingerprint: manifest.translation_fingerprint,
    page_count: result.pageCount,
    block_count: result.blockCount,
    ocr_layer: !!extracted.ocr_layer,
    ocr_layer_pages: extracted.ocr_layer_pages || [],
    render_stats: result.stats,
    ocr_risk_pages: (audit.risk_pages || []).map((value) => Number(chunk.start) + Number(value)),
    math_garbled_pages: (audit.math_garbled_pages || []).map((value) => Number(chunk.start) + Number(value)),
    two_column_pages: (audit.two_column_pages || []).map((value) => Number(chunk.start) + Number(value)),
    codex_calls: diagnostics,
    manual_override_manifest_sha256: manifest.manifest_sha256,
    manual_override_provenance: provenance,
    manual_quality_gate_min_font_pt: Number(
      process.env.PDF_TRANSLATE_MIN_FONT_PT || 8,
    ),
    mixed_span_postprocess: mixedStats,
    strict_postflight: patchedPostflight
      ? {
          passed: patchedPostflight.passed,
          exit_code: patchedPostflight.report.exit_code,
          report_sha256: sha256(JSON.stringify(patchedPostflight.report)),
          baseline_report_sha256: sha256(JSON.stringify(basePostflight.report)),
          comparison: postflightComparison,
        }
      : null,
  };
  writePartPairAtomic(partPath, metadataPath, finalBuffer, metadata);
  return { partPath, metadataPath, metadata };
}

async function run(options, dependencies = {}) {
  const runDirInfo = fs.lstatSync(options.runDir);
  if (runDirInfo.isSymbolicLink() || !runDirInfo.isDirectory()) {
    throw new Error("--run-dir must be a real directory, not a symlink");
  }
  const manifestRead = readJsonRegular(options.manifest, {
    maximum: MAX_MANIFEST_BYTES,
    label: "manual override manifest",
  });
  const manifest = normalizeManifest(manifestRead.value, manifestRead.bytes);
  const sourcePath = path.join(options.runDir, "source.pdf");
  const sourceBytes = readRegularFile(sourcePath, { label: "run source.pdf" });
  if (sha256(sourceBytes) !== manifest.source_pdf_sha256) {
    throw new Error("manifest source_pdf_sha256 does not match run source.pdf");
  }
  const split = readJsonRegular(path.join(options.runDir, "split.json"), {
    label: "split checkpoint",
  }).value;
  if (!Array.isArray(split.chunks) || !split.chunks.length) {
    throw new Error("split checkpoint has no chunks");
  }
  const fingerprints = validCurrentPartFingerprints(options.runDir, split);
  if (fingerprints.size !== 1 || !fingerprints.has(manifest.translation_fingerprint)) {
    throw new Error(
      "manifest translation_fingerprint is not proved by one consistent set of current sibling parts",
    );
  }
  const selected = options.chunkIndex == null
    ? manifest.chunks
    : manifest.chunks.filter((chunk) => chunk.chunk_index === options.chunkIndex);
  if (!selected.length) throw new Error("requested --chunk-index is absent from the manifest");
  const results = [];
  for (const chunkManifest of selected) {
    results.push(await generateChunkPart({
      runDir: options.runDir,
      manifest,
      chunkManifest,
      model: options.model,
      timeoutMs: options.timeoutMs,
      split,
      dependencies,
    }));
  }
  return results;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  const results = await run(options);
  for (const result of results) console.log(result.partPath);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  applyMixedSpanRepairs,
  assertPostflightNonRegression,
  capturePostflight,
  generateChunkPart,
  makeOverrideCaller,
  mixedSpanPdfTool,
  normalizeManifest,
  parseArgs,
  run,
  sha256,
  taggedScientificToUnicode,
  validCurrentPartFingerprints,
  validateOverrideBindings,
  writePartPairAtomic,
};
