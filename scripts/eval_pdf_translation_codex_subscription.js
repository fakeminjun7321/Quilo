#!/usr/bin/env node
"use strict";

// Resumable, OCR-audited PDF translation through the authenticated Codex
// subscription. Production HTTP requests continue to use translate-server.js;
// this adapter exists for local evaluation and user-approved desktop runs.

process.env.PDF_TRANSLATE_BATCH_CHARS =
  process.env.PDF_TRANSLATE_BATCH_CHARS || "45000";
process.env.PDF_TRANSLATE_BATCH_IDS =
  process.env.PDF_TRANSLATE_BATCH_IDS || "350";
// The production server remains fail-closed for unprovable table stream ordering.
// This local, OCR-audited book runner permits the already-rendered cell overlay and
// verifies table geometry/non-text pixels after generation instead.
process.env.PDF_TRANSLATE_ALLOW_TABLE_OVERLAY =
  process.env.PDF_TRANSLATE_ALLOW_TABLE_OVERLAY || "1";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const pdfTool = require("../lib/pipelines/pdf-translate/pdf-tool");
const {
  resolveMinFontThreshold,
} = require("../lib/pipelines/pdf-translate/quality-gate");
const {
  createPdfTranslateResourceLimits,
  makeGate,
  translateBlocksWithRetries,
  translateSinglePdf,
} = require("../lib/pipelines/pdf-translate/translate");

const ROOT = path.resolve(__dirname, "..");
const CODEX = process.env.CODEX_BIN || "codex";
const PYTHON = process.env.PYTHON_BIN || path.join(ROOT, ".venv/bin/python3");
const FONT_PATH = fs.existsSync(path.join(ROOT, "lib/fonts/Pretendard-Regular.ttf"))
  ? path.join(ROOT, "lib/fonts/Pretendard-Regular.ttf")
  : path.join(ROOT, "lib/fonts/NanumGothic-Regular.ttf");
const MATH_FONT_PATH = path.join(ROOT, "lib/fonts/STIXTwoMath.otf");
const DEFAULT_MODEL = "gpt-5.4";
const RUNNER_VERSION = "codex-ocr-layout-v5";
const OCR_LAYER_MAX_BATCH_PAGES = 6;
const SPLIT_POLICY_NAME = "sentence-safe-backtrack-v1";
const SPLITTER_PATH = path.join(
  ROOT,
  "lib/pipelines/pdf-translate/translate_pdf.py",
);
const QUALITY_GATE_PATH = path.join(
  ROOT,
  "lib/pipelines/pdf-translate/quality-gate.js",
);
const NAVIGATION_SYNTHESIS_PATH = path.join(
  ROOT,
  "lib/pipelines/pdf-translate/synthesize_navigation.py",
);
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_FINAL_NAME = "fundamental-astronomy-ko.pdf";
const MAX_NAVIGATION_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CODEX_STDOUT_BYTES = 8 * 1024 * 1024;
const MAX_PROCESS_STDERR_BYTES = 8 * 1024 * 1024;

const PROJECT_PROMPT = [
  "Project-specific translation and OCR rules:",
  "- Use natural, readable Korean academic-textbook prose in a consistent 한다/이다 style.",
  "- Preserve the original layout by returning exactly one translation per input ID. Never merge, split, omit, or duplicate IDs.",
  "- Translate faithfully without summarizing. Keep headings and captions concise enough for their original boxes.",
  "- Add the original English term in parentheses only for genuinely specialized terms at their first visible occurrence. Do not parenthesize ordinary words or repeat glosses unnecessarily.",
  "- The page images and OCR audit are layout evidence. On two-column pages, read the left column top-to-bottom before the right column top-to-bottom.",
  "- Repair line-end hyphenation and OCR spacing only inside the same ID. If a sentence continues in another ID, translate only the supplied fragment and do not pull text across IDs.",
  "- PDF extraction can splice adjacent caption lines or expose a wrong Unicode character for a visually correct math glyph. When the page image clearly disagrees with garbled extracted wording or a math symbol, the visible page is authoritative. Reconstruct the true caption wording and discard extraction garbage; never copy strings such as 'framey ... are'.",
  "- The source segment remains authoritative for exact numbers, units, URLs, and <sub>/<sup> tags unless the attached page visibly proves a damaged PDF character map. Never invent a literal that appears in neither the source nor the visible page.",
  "- Consecutive IDs may be fragments of one sentence. Keep each ID separate, but choose endings and connective wording so the visible fragments read as one natural Korean sentence across the boundary.",
  "- Translate every modifier and semantic detail even in a short continuation fragment. Never collapse a phrase such as 'path on the surface of the sphere between these points' to a generic '경로이다'.",
  "- Preserve numeric formatting exactly. If the source spells a number as an English word (for example 'one year'), use a Korean number word ('한 해'), never introduce a digit ('1년').",
  "- Translate ordinary unit/time words and source labels completely, including inside equations: '18.6 years' must be '18.6년', '1 nautical mile = 1852 m' must be '1 해리 = 1852 m', 'electron volts' must be '전자볼트', 'Sect. 2.10' must be '2.10절', and 'Fig./Table/Box' must be '그림/표/박스'. Preserve compact unit symbols such as m, kg, s, and eV.",
].join("\n");

function usage() {
  return [
    "Usage: node scripts/eval_pdf_translation_codex_subscription.js --input FILE.pdf --output-dir DIR [options]",
    "",
    "Options:",
    `  --model MODEL           Codex subscription model (default: ${DEFAULT_MODEL})`,
    "  --chunk-pages N        Persistent split size (default: 30)",
    "  --concurrency N        Codex and chunk concurrency (default: 2)",
    "  --ocr-workers N        Parallel local Tesseract workers (default: 4)",
    "  --timeout-ms N         Per Codex call timeout (default: 1200000)",
    `  --final-name FILE.pdf  Final PDF basename (default: ${DEFAULT_FINAL_NAME})`,
    "  --navigation-manifest FILE.json",
    "                         Opt-in, source-bound bookmarks and visible URL allowlist",
    "  --help                 Show this help",
  ].join("\n");
}

function validateFinalName(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("--final-name must be a non-empty, trimmed PDF basename");
  }
  if (
    value === "." ||
    value === ".." ||
    value.startsWith(".") ||
    path.isAbsolute(value) ||
    path.basename(value) !== value ||
    /[\\/\0\r\n]/.test(value) ||
    Buffer.byteLength(value, "utf8") > 240 ||
    !value.toLowerCase().endsWith(".pdf")
  ) {
    throw new Error("--final-name must be a safe PDF basename without path components");
  }
  return value;
}

function parseArgs(argv, cwd = process.cwd()) {
  const out = {
    input: null,
    outputDir: null,
    model: DEFAULT_MODEL,
    chunkPages: 30,
    concurrency: 2,
    ocrWorkers: 4,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    finalName: DEFAULT_FINAL_NAME,
    navigationManifest: null,
  };
  const next = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--input" || arg === "-i") {
      out.input = path.resolve(cwd, next(index, arg));
      index += 1;
    } else if (arg === "--output-dir") {
      out.outputDir = path.resolve(cwd, next(index, arg));
      index += 1;
    } else if (arg === "--model") {
      out.model = next(index, arg);
      index += 1;
    } else if (arg === "--chunk-pages") {
      out.chunkPages = Number(next(index, arg));
      index += 1;
    } else if (arg === "--concurrency") {
      out.concurrency = Number(next(index, arg));
      index += 1;
    } else if (arg === "--ocr-workers") {
      out.ocrWorkers = Number(next(index, arg));
      index += 1;
    } else if (arg === "--timeout-ms") {
      out.timeoutMs = Number(next(index, arg));
      index += 1;
    } else if (arg === "--final-name") {
      out.finalName = validateFinalName(next(index, arg));
      index += 1;
    } else if (arg === "--navigation-manifest") {
      out.navigationManifest = path.resolve(cwd, next(index, arg));
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.input || !out.outputDir) throw new Error("--input and --output-dir are required");
  out.finalName = validateFinalName(out.finalName);
  for (const [name, value, minimum, maximum] of [
    ["--chunk-pages", out.chunkPages, 1, 50],
    ["--concurrency", out.concurrency, 1, 4],
    ["--ocr-workers", out.ocrWorkers, 1, 12],
    ["--timeout-ms", out.timeoutMs, 10_000, 60 * 60 * 1000],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
  }
  return out;
}

function resolveSafeOutputFile(outputDir, finalName) {
  const normalizedName = validateFinalName(finalName);
  const resolvedDir = path.resolve(outputDir);
  const candidate = path.resolve(resolvedDir, normalizedName);
  if (path.dirname(candidate) !== resolvedDir) {
    throw new Error("final PDF must stay directly inside --output-dir");
  }
  const realDir = fs.realpathSync(resolvedDir);
  const realParent = fs.realpathSync(path.dirname(candidate));
  if (realParent !== realDir) {
    throw new Error("final PDF parent escaped --output-dir through a symlink");
  }
  try {
    const info = fs.lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error("final PDF path must not be a symlink");
    if (!info.isFile()) throw new Error("final PDF path must be a regular file");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return candidate;
}

function readNavigationManifest(filePath) {
  if (!filePath) return null;
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`navigation manifest not found: ${filePath}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error("navigation manifest must be a regular, non-symlink file");
  }
  if (info.size > MAX_NAVIGATION_MANIFEST_BYTES) {
    throw new Error("navigation manifest exceeds the 2 MiB limit");
  }
  const bytes = fs.readFileSync(filePath);
  try {
    JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`navigation manifest is not valid UTF-8 JSON: ${error.message}`);
  }
  return bytes;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.partial-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function writeBufferAtomic(filePath, value) {
  const temp = `${filePath}.partial-${process.pid}`;
  fs.writeFileSync(temp, value);
  fs.renameSync(temp, filePath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function acquireRunLock(outputDir) {
  const lockPath = path.join(outputDir, ".translation.lock");
  const attempt = () => {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    fs.closeSync(fd);
  };
  try {
    attempt();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const prior = readJson(lockPath);
      process.kill(Number(prior.pid), 0);
    } catch {
      stale = true;
    }
    if (!stale) throw new Error(`another translation process is using ${outputDir}`);
    fs.rmSync(lockPath, { force: true });
    attempt();
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.rmSync(lockPath, { force: true }); } catch {}
  };
  process.once("exit", release);
  process.once("SIGINT", () => { release(); process.exit(130); });
  process.once("SIGTERM", () => { release(); process.exit(143); });
  return release;
}

function runProcess(command, args, {
  input = "",
  cwd = ROOT,
  env = process.env,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxStdout = MAX_CODEX_STDOUT_BYTES,
  maxStderr = MAX_PROCESS_STDERR_BYTES,
  allowNonzero = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(
      () => finishError(new Error(`${command} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const onAbort = () => finishError(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) return finishError(new Error(`${command} stdout exceeded limit`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderr) return finishError(new Error(`${command} stderr exceeded limit`));
      stderr.push(chunk);
    });
    child.on("error", finishError);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0 && !allowNonzero) {
        reject(new Error(`${command} exited ${code}: ${(err || out).slice(-1200)}`));
      } else {
        resolve({ code, stdout: out, stderr: err });
      }
    });
    child.stdin.end(input);
  });
}

function requestedItems(user) {
  const lines = String(user || "").trimEnd().split(/\r?\n/);
  const jsonLine = [...lines].reverse().find((line) => {
    const value = line.trim();
    return value.startsWith("[") && value.endsWith("]");
  });
  if (!jsonLine) throw new Error("translation request did not end in a JSON item array");
  const items = JSON.parse(jsonLine.trim());
  if (!Array.isArray(items) || !items.length) throw new Error("translation item array is empty");
  const ids = items.map((item) => String(item && item.id));
  if (ids.some((id) => !id || id === "undefined") || new Set(ids).size !== ids.length) {
    throw new Error("translation request contains invalid or duplicate IDs");
  }
  return items;
}

function buildTranslationSchema(ids) {
  const properties = Object.fromEntries(ids.map((id) => [id, { type: "string", minLength: 1 }]));
  return {
    type: "object",
    properties: {
      t: {
        type: "object",
        properties,
        required: ids,
        additionalProperties: false,
      },
    },
    required: ["t"],
    additionalProperties: false,
  };
}

function normalizedEnglishTokens(text) {
  return String(text || "")
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .replace(/ﬁ/g, "fi")
    .replace(/ﬂ/g, "fl")
    .toLowerCase()
    .match(/[a-z]{2,}/g) || [];
}

function multisetRecall(reference, candidate) {
  if (!reference.length) return 1;
  const counts = new Map();
  for (const token of candidate) counts.set(token, (counts.get(token) || 0) + 1);
  let matched = 0;
  for (const token of reference) {
    const count = counts.get(token) || 0;
    if (count > 0) {
      matched += 1;
      counts.set(token, count - 1);
    }
  }
  return matched / reference.length;
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function inspectPageLayouts(pdfPath) {
  const script = [
    "import fitz,json,sys,re",
    "d=fitz.open(sys.argv[1]); out=[]",
    "for p in d:",
    " w=float(p.rect.width or 1); left=right=wide=0; total_chars=math_chars=0",
    " for s in p.get_texttrace():",
    "  n=len(s.get('chars') or ()); total_chars+=n; fn=str(s.get('font') or '')",
    "  if re.search(r'MATHPRO|MATHEMATICALPI|MATHPI|GREEKWMATHPI|MATHTIME|ESSTIX',fn,re.I) or re.match(r'^(MTMI|MTSY|MTSYN|MTEX|MTGU|MTMS)',fn,re.I): math_chars+=n",
    " for b in p.get_text('blocks'):",
    "  if len(b)<5 or len(str(b[4]).strip())<20: continue",
    "  x0,y0,x1,y1=b[:4]",
    "  if x1 <= 0.58*w: left+=1",
    "  elif x0 >= 0.42*w: right+=1",
    "  else: wide+=1",
    " out.append({'two_column': left>=2 and right>=2, 'left_blocks':left, 'right_blocks':right, 'wide_blocks':wide, 'math_chars':math_chars, 'math_ratio':round(math_chars/max(total_chars,1),4), 'math_garbled':math_chars>=3})",
    "print(json.dumps(out,separators=(',',':'))) ",
  ].join("\n");
  const result = await runProcess(PYTHON, ["-c", script, pdfPath], {
    timeoutMs: 2 * 60 * 1000,
  });
  return JSON.parse(result.stdout.trim());
}

async function buildOcrAudit({ chunkPath, chunkIndex, imageDir, extractMeta, ocrWorkers }) {
  const auditPath = path.join(imageDir, "audit.json");
  if (fs.existsSync(auditPath)) {
    const cached = readJson(auditPath);
    const filesExist = (cached.pages || []).every((page) =>
      (page.images || []).every((file) => fs.existsSync(file)),
    );
    if (filesExist) return cached;
  }
  fs.mkdirSync(imageDir, { recursive: true });
  const raster = await pdfTool.rasterizePages(chunkPath, imageDir, {
    targetWidth: 1200,
    maxPages: extractMeta.page_count,
  });
  if (Number(raster.page_count) !== Number(extractMeta.page_count) || raster.truncated) {
    throw new Error(`OCR raster coverage failed for chunk ${chunkIndex}`);
  }
  const layouts = await inspectPageLayouts(chunkPath);
  const sourceByPage = new Map();
  for (const block of extractMeta.blocks || []) {
    if (!Number.isInteger(block.page)) continue;
    if (!sourceByPage.has(block.page)) sourceByPage.set(block.page, []);
    sourceByPage.get(block.page).push(String(block.text || ""));
  }
  const pages = (raster.pages || []).map((page) => ({
    index: Number(page.index),
    images: (page.tiles || []).map((tile) => path.resolve(tile.file)),
  }));
  await runPool(pages, ocrWorkers, async (page) => {
    const ocrParts = [];
    for (const image of page.images) {
      const result = await runProcess(
        "tesseract",
        [image, "stdout", "-l", "eng", "--psm", "1"],
        { timeoutMs: 2 * 60 * 1000, maxStdout: 4 * 1024 * 1024 },
      );
      ocrParts.push(result.stdout.trim());
    }
    const sourceText = (sourceByPage.get(page.index) || []).join("\n");
    const ocrText = ocrParts.join("\n");
    const sourceTokens = normalizedEnglishTokens(sourceText);
    const ocrTokens = normalizedEnglishTokens(ocrText);
    const ocrRecall = multisetRecall(ocrTokens, sourceTokens);
    const sourceRecall = multisetRecall(sourceTokens, ocrTokens);
    const sourceChars = sourceText.replace(/\s/g, "").length;
    const ocrChars = ocrText.replace(/\s/g, "").length;
    const lengthRatio = ocrChars ? sourceChars / ocrChars : 1;
    const layout = layouts[page.index] || {};
    page.source_chars = sourceChars;
    page.ocr_chars = ocrChars;
    page.ocr_token_recall = Number(ocrRecall.toFixed(4));
    page.source_token_recall = Number(sourceRecall.toFixed(4));
    page.length_ratio = Number(lengthRatio.toFixed(4));
    page.two_column = !!layout.two_column;
    page.math_garbled = !!layout.math_garbled;
    page.math_ratio = Number(layout.math_ratio || 0);
    page.risk = !!(
      page.math_garbled || (
        ocrTokens.length >= 40 &&
        (ocrRecall < 0.78 || sourceRecall < 0.78 || lengthRatio < 0.58 || lengthRatio > 1.75)
      )
    );
    page.ocr_text = page.risk ? ocrText.slice(0, 5000) : "";
  });
  const audit = {
    schema_version: 1,
    chunk_index: chunkIndex,
    source_sha256: sha256(fs.readFileSync(chunkPath)),
    page_count: extractMeta.page_count,
    risk_pages: pages.filter((page) => page.risk).map((page) => page.index),
    math_garbled_pages: pages.filter((page) => page.math_garbled).map((page) => page.index),
    two_column_pages: pages.filter((page) => page.two_column).map((page) => page.index),
    pages,
  };
  writeJsonAtomic(auditPath, audit);
  return audit;
}

function pickVisualPages(pageIndices, audit, maximum = 6) {
  const available = [...new Set(pageIndices.filter(Number.isInteger))].sort((a, b) => a - b);
  if (available.length <= maximum) return available;
  const selected = [];
  const add = (value) => {
    if (available.includes(value) && !selected.includes(value) && selected.length < maximum) {
      selected.push(value);
    }
  };
  for (const value of audit.risk_pages || []) add(value);
  add(available[0]);
  add(available[available.length - 1]);
  for (let slot = 1; selected.length < maximum && slot < maximum - 1; slot += 1) {
    add(available[Math.round((slot / (maximum - 1)) * (available.length - 1))]);
  }
  for (const value of available) add(value);
  return selected.sort((a, b) => a - b);
}

function makeCodexCaller({
  model,
  timeoutMs,
  idToPage,
  audit,
  globalPageOffset = 0,
  diagnostics,
  cacheDir,
  requireCompletePageImages = false,
}) {
  const auditByPage = new Map((audit.pages || []).map((page) => [page.index, page]));
  return async ({ system, user, signal }) => {
    const items = requestedItems(user);
    const ids = items.map((item) => String(item.id));
    const pageIndices = [...new Set(
      ids.map((id) => idToPage.get(id)).filter(Number.isInteger),
    )].sort((a, b) => a - b);
    if (
      requireCompletePageImages &&
      pageIndices.length > OCR_LAYER_MAX_BATCH_PAGES
    ) {
      throw new Error(
        `OCR-layer translation batch spans ${pageIndices.length} pages; ` +
          `maximum is ${OCR_LAYER_MAX_BATCH_PAGES}`,
      );
    }
    const visualPages = requireCompletePageImages
      ? pageIndices.slice()
      : pickVisualPages(pageIndices, audit, OCR_LAYER_MAX_BATCH_PAGES);
    if (requireCompletePageImages) {
      for (const pageIndex of visualPages) {
        const page = auditByPage.get(pageIndex);
        if (
          !page ||
          !Array.isArray(page.images) ||
          !page.images.length ||
          page.images.some((file) => !fs.existsSync(file))
        ) {
          throw new Error(
            `OCR-layer page ${globalPageOffset + pageIndex + 1} has no complete raster evidence`,
          );
        }
      }
    }
    const images = visualPages.flatMap((pageIndex) => auditByPage.get(pageIndex)?.images || []);
    const auditLines = pageIndices
      .sort((a, b) => a - b)
      .map((pageIndex) => {
        const page = auditByPage.get(pageIndex);
        if (!page) return null;
        const sourcePage = globalPageOffset + pageIndex + 1;
        const flags = [page.two_column ? "two-column" : "single-column"];
        if (page.risk) flags.push("OCR-risk");
        if (page.math_garbled) flags.push("math-font-risk; verify visible glyphs");
        if (visualPages.includes(pageIndex)) flags.push("image-attached");
        return `- source PDF page ${sourcePage}: ${flags.join(", ")}; OCR token recall ${page.ocr_token_recall}`;
      })
      .filter(Boolean);
    const riskContext = pageIndices
      .filter((pageIndex) => auditByPage.get(pageIndex)?.risk)
      .map((pageIndex) => {
        const page = auditByPage.get(pageIndex);
        return `\n[Advisory Tesseract OCR for source page ${globalPageOffset + pageIndex + 1}]\n${page.ocr_text}`;
      })
      .join("\n");
    const prompt = [
      String(system || ""),
      "",
      PROJECT_PROMPT,
      "",
      "OCR/layout audit for the pages represented in this batch:",
      ...(auditLines.length ? auditLines : ["- No page image applies to reader metadata blocks."]),
      riskContext,
      "",
      "Translation request:",
      String(user || ""),
    ].join("\n");

    const cacheable = !/targeted correction retry/i.test(String(user || ""));
    const imageHashes = images.map((file) => sha256(fs.readFileSync(file)));
    const cacheKey = sha256(JSON.stringify({
      runner: RUNNER_VERSION,
      model,
      prompt,
      image_hashes: imageHashes,
    }));
    const cachePath = cacheDir ? path.join(cacheDir, `${cacheKey}.json`) : null;
    if (cacheable && cachePath && fs.existsSync(cachePath)) {
      const cached = readJson(cachePath);
      diagnostics.push({
        ...cached.diagnostic,
        at: new Date().toISOString(),
        cache_hit: true,
      });
      return {
        text: JSON.stringify(cached.structured),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    }

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-codex-translate-"));
    const schemaPath = path.join(runDir, "schema.json");
    const outputPath = path.join(runDir, "output.json");
    fs.writeFileSync(schemaPath, JSON.stringify(buildTranslationSchema(ids)), "utf8");
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox", "read-only",
      "--model", model,
      "--disable", "plugins",
      "--disable", "apps",
      "--disable", "tool_suggest",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "computer_use",
      "--disable", "browser_use",
      "--disable", "in_app_browser",
      "--disable", "image_generation",
      "--cd", runDir,
      "--output-schema", schemaPath,
      "--output-last-message", outputPath,
      "--color", "never",
    ];
    for (const image of images) args.push("--image", image);
    args.push("-");
    const started = Date.now();
    try {
      let result;
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await runProcess(CODEX, args, {
            input: prompt,
            cwd: runDir,
            env: { ...process.env, RUST_LOG: "error" },
            signal,
            timeoutMs,
          });
          break;
        } catch (error) {
          lastError = error;
          const message = String(error.message || error);
          if (/unauthorized|authentication|not logged in|unsupported model|model.*not found/i.test(message)) {
            throw error;
          }
          if (attempt < 2) {
            const delayMs = [5000, 20000][attempt];
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, delayMs);
              if (signal) signal.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
              }, { once: true });
            });
          }
        }
      }
      if (!result) throw lastError || new Error("Codex call failed");
      if (!fs.existsSync(outputPath)) throw new Error("Codex did not write the structured output file");
      const structured = JSON.parse(fs.readFileSync(outputPath, "utf8"));
      const tokenMatch = `${result.stdout}\n${result.stderr}`.match(/tokens used\s*\n?\s*([\d,]+)/i);
      const diagnostic = {
        at: new Date().toISOString(),
        model,
        item_count: ids.length,
        source_pages: pageIndices.map((value) => globalPageOffset + value + 1),
        visual_pages: visualPages.map((value) => globalPageOffset + value + 1),
        ocr_risk_pages: pageIndices
          .filter((value) => auditByPage.get(value)?.risk)
          .map((value) => globalPageOffset + value + 1),
        duration_ms: Date.now() - started,
        tokens_used: tokenMatch ? Number(tokenMatch[1].replace(/,/g, "")) : null,
        cache_hit: false,
      };
      diagnostics.push(diagnostic);
      if (cacheable && cachePath) {
        fs.mkdirSync(cacheDir, { recursive: true });
        writeJsonAtomic(cachePath, { structured, diagnostic });
      }
      return {
        text: JSON.stringify(structured),
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  };
}

function makeProgress(onProgress) {
  let total = 0;
  let done = 0;
  return {
    addTotal(value) {
      total += value;
      onProgress(`OCR 대조 번역 묶음 ${done}/${total}`);
    },
    tick() {
      done += 1;
      onProgress(`OCR 대조 번역 묶음 ${done}/${total}`);
    },
  };
}

function hasValidSentenceSafeSplitLayout(split, chunkPages) {
  if (
    !split ||
    split.split_policy?.name !== SPLIT_POLICY_NAME ||
    Number(split.split_policy?.max_pages_per_chunk) !== Number(chunkPages) ||
    !Number.isSafeInteger(Number(split.page_count)) ||
    Number(split.page_count) < 0 ||
    !Array.isArray(split.chunks)
  ) {
    return false;
  }
  let expectedStart = 1;
  for (const chunk of split.chunks) {
    const start = Number(chunk?.start);
    const end = Number(chunk?.end);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start !== expectedStart ||
      end < start ||
      end - start + 1 > chunkPages ||
      !Array.isArray(chunk?.page_tokens) ||
      chunk.page_tokens.length !== end - start + 1
    ) {
      return false;
    }
    expectedStart = end + 1;
  }
  return expectedStart === Number(split.page_count) + 1;
}

async function ensureSplit(sourcePath, outputDir, chunkPages, onProgress) {
  const splitPath = path.join(outputDir, "split.json");
  const splitDir = path.join(outputDir, "chunks");
  const sourceHash = sha256(fs.readFileSync(sourcePath));
  const splitterHash = sha256(fs.readFileSync(SPLITTER_PATH));
  if (fs.existsSync(splitPath)) {
    const cached = readJson(splitPath);
    if (
      cached.source_sha256 === sourceHash &&
      cached.chunk_pages === chunkPages &&
      cached.split_strategy === SPLIT_POLICY_NAME &&
      cached.splitter_sha256 === splitterHash &&
      hasValidSentenceSafeSplitLayout(cached, chunkPages) &&
      (cached.chunks || []).every((chunk) => fs.existsSync(chunk.path))
    ) {
      return cached;
    }
    const partsDir = path.join(outputDir, "parts");
    const hasParts = fs.existsSync(partsDir) && fs.readdirSync(partsDir).some(
      (name) => /^part-\d+\.(?:ko\.pdf|json)$/.test(name),
    );
    if (hasParts) {
      throw new Error(
        "existing translated parts belong to an incompatible split checkpoint; " +
        "remove split.json, chunks/, parts/, and ocr-audit/ before resuming",
      );
    }
    fs.rmSync(splitPath, { force: true });
    fs.rmSync(splitDir, { recursive: true, force: true });
    fs.rmSync(path.join(outputDir, "ocr-audit"), { recursive: true, force: true });
    onProgress("이전 페이지 분할 checkpoint를 sentence-safe 정책으로 재생성합니다...");
  }
  fs.mkdirSync(splitDir, { recursive: true });
  onProgress(`원본을 최대 ${chunkPages}쪽, 문장 경계 우선으로 분할 중...`);
  const split = await pdfTool.splitPdf(sourcePath, splitDir, { pagesPerChunk: chunkPages });
  if (!hasValidSentenceSafeSplitLayout(split, chunkPages)) {
    throw new Error("sentence-safe PDF split returned an invalid or oversized layout");
  }
  const checkpoint = {
    ...split,
    source_sha256: sourceHash,
    chunk_pages: chunkPages,
    split_strategy: SPLIT_POLICY_NAME,
    splitter_sha256: splitterHash,
  };
  writeJsonAtomic(splitPath, checkpoint);
  return checkpoint;
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
  if (!fs.existsSync(options.input)) throw new Error(`input not found: ${options.input}`);
  fs.mkdirSync(options.outputDir, { recursive: true });
  const finalPath = resolveSafeOutputFile(options.outputDir, options.finalName);
  const navigationManifestBytes = readNavigationManifest(options.navigationManifest);
  const navigationManifestSha256 = navigationManifestBytes
    ? sha256(navigationManifestBytes)
    : null;
  acquireRunLock(options.outputDir);
  const cacheDir = path.join(options.outputDir, "codex-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const eventsPath = path.join(options.outputDir, "events.jsonl");
  const onProgress = (message) => {
    const event = { at: new Date().toISOString(), message };
    fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    console.error(message);
  };
  const inputBuffer = fs.readFileSync(options.input);
  const sourcePath = path.join(options.outputDir, "source.pdf");
  if (!fs.existsSync(sourcePath)) fs.copyFileSync(options.input, sourcePath);
  const sourceInfo = fs.lstatSync(sourcePath);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) {
    throw new Error("source.pdf checkpoint must be a regular, non-symlink file");
  }
  if (sha256(fs.readFileSync(sourcePath)) !== sha256(inputBuffer)) {
    throw new Error("output directory already contains a different source.pdf");
  }
  const translationFingerprint = sha256(JSON.stringify({
    runner: RUNNER_VERSION,
    runner_script_sha256: sha256(fs.readFileSync(__filename)),
    model: options.model,
    project_prompt: PROJECT_PROMPT,
    source_sha256: sha256(inputBuffer),
    chunk_pages: options.chunkPages,
    split_strategy: SPLIT_POLICY_NAME,
    splitter_sha256: sha256(fs.readFileSync(SPLITTER_PATH)),
    batch_chars: process.env.PDF_TRANSLATE_BATCH_CHARS,
    batch_ids: process.env.PDF_TRANSLATE_BATCH_IDS,
    allow_table_overlay: process.env.PDF_TRANSLATE_ALLOW_TABLE_OVERLAY,
    renderer_sha256: sha256(fs.readFileSync(SPLITTER_PATH)),
    orchestrator_sha256: sha256(fs.readFileSync(path.join(ROOT, "lib/pipelines/pdf-translate/translate.js"))),
    quality_gate_sha256: sha256(fs.readFileSync(QUALITY_GATE_PATH)),
    min_font_pt: resolveMinFontThreshold(),
    font_sha256: sha256(fs.readFileSync(FONT_PATH)),
    math_font_sha256: fs.existsSync(MATH_FONT_PATH)
      ? sha256(fs.readFileSync(MATH_FONT_PATH))
      : null,
  }));
  const artifactFingerprint = sha256(JSON.stringify({
    translation_fingerprint: translationFingerprint,
    final_name: options.finalName,
    navigation_manifest_sha256: navigationManifestSha256,
    navigation_synthesis_sha256: navigationManifestBytes
      ? sha256(fs.readFileSync(NAVIGATION_SYNTHESIS_PATH))
      : null,
  }));
  if (fs.existsSync(finalPath)) {
    const metadataPath = path.join(options.outputDir, "metadata.json");
    if (fs.existsSync(metadataPath)) {
      const metadata = readJson(metadataPath);
      if (
        metadata.artifact_fingerprint === artifactFingerprint &&
        metadata.output_sha256 === sha256(fs.readFileSync(finalPath))
      ) {
        console.log(finalPath);
        return;
      }
    }
    throw new Error("existing final PDF has no matching verified metadata checkpoint");
  }

  const split = await ensureSplit(sourcePath, options.outputDir, options.chunkPages, onProgress);
  const chunks = split.chunks || [];
  const partsDir = path.join(options.outputDir, "parts");
  const auditDir = path.join(options.outputDir, "ocr-audit");
  fs.mkdirSync(partsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  const diagnostics = [];
  const gate = makeGate(options.concurrency);
  const resourceLimits = createPdfTranslateResourceLimits({
    apiConcurrency: options.concurrency,
    documentConcurrency: options.concurrency,
  });
  const progress = makeProgress(onProgress);

  let nextChunk = 0;
  const chunkErrors = [];
  const workers = Array.from({ length: Math.min(options.concurrency, chunks.length) }, async () => {
    for (;;) {
      const index = nextChunk;
      nextChunk += 1;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      const partPath = path.join(partsDir, `part-${String(index).padStart(3, "0")}.ko.pdf`);
      const metadataPath = path.join(partsDir, `part-${String(index).padStart(3, "0")}.json`);
      const documentModelPath = path.join(
        partsDir,
        `part-${String(index).padStart(3, "0")}.translations.json`,
      );
      if (fs.existsSync(partPath) && fs.existsSync(metadataPath)) {
        const metadata = readJson(metadataPath);
        const documentModelMatches = !metadata.document_model_sha256 || (
          fs.existsSync(documentModelPath) &&
          metadata.document_model_sha256 === sha256(fs.readFileSync(documentModelPath))
        );
        if (
          metadata.source_sha256 === sha256(fs.readFileSync(chunk.path)) &&
          metadata.output_sha256 === sha256(fs.readFileSync(partPath)) &&
          metadata.translation_fingerprint === translationFingerprint &&
          documentModelMatches
        ) {
          onProgress(`구간 ${index + 1}/${chunks.length} 체크포인트 재사용 (${chunk.start}-${chunk.end}쪽)`);
          continue;
        }
        throw new Error(`chunk ${index + 1} checkpoint hash mismatch`);
      }
      try {
        onProgress(`구간 ${index + 1}/${chunks.length} 분석 및 OCR 대조 (${chunk.start}-${chunk.end}쪽)`);
        const extractMeta = await pdfTool.extractBlocks(chunk.path);
        const imageDir = path.join(auditDir, `chunk-${String(index).padStart(3, "0")}`);
        const audit = await buildOcrAudit({
          chunkPath: chunk.path,
          chunkIndex: index,
          imageDir,
          extractMeta,
          ocrWorkers: options.ocrWorkers,
        });
        const idToPage = new Map(
          (extractMeta.blocks || []).map((block) => [String(block.id), block.page]),
        );
        const chunkDiagnostics = [];
        const caller = makeCodexCaller({
          model: options.model,
          timeoutMs: options.timeoutMs,
          idToPage,
          audit,
          globalPageOffset: Number(chunk.start) - 1,
          diagnostics: chunkDiagnostics,
          cacheDir,
          requireCompletePageImages: !!extractMeta.ocr_layer,
        });
        const result = await translateSinglePdf({
          pdfBuffer: fs.readFileSync(chunk.path),
          caller,
          gate,
          progress,
          onProgress: (message) => onProgress(`구간 ${index + 1}: ${message}`),
          resourceLimits,
          // End with isolated-ID retries. A genuinely malformed answer (for
          // example an unexpected writing system) should not share its final
          // correction context with unrelated formula/number failures.
          retrySizes: [6000, 2500, 900, 1, 1],
          batchPages: extractMeta.ocr_layer
            ? OCR_LAYER_MAX_BATCH_PAGES
            : null,
          // Persist the validated source-ID -> target map before rendering so
          // alternate renderers (DOCX/ODT/LibreOffice) never need to recover
          // canonical translations from positioned PDF text.
          captureDocumentModel: true,
        });
        if (!result.documentModel) {
          throw new Error(`chunk ${index + 1} did not return a renderer-neutral document model`);
        }
        writeBufferAtomic(partPath, result.buffer);
        writeJsonAtomic(documentModelPath, result.documentModel);
        const documentModelBytes = fs.readFileSync(documentModelPath);
        const metadata = {
          chunk_index: index,
          source_start: chunk.start,
          source_end: chunk.end,
          source_sha256: sha256(fs.readFileSync(chunk.path)),
          output_sha256: sha256(result.buffer),
          document_model_sha256: sha256(documentModelBytes),
          document_model_file: path.basename(documentModelPath),
          translation_fingerprint: translationFingerprint,
          page_count: result.pageCount,
          block_count: result.blockCount,
          ocr_layer: !!extractMeta.ocr_layer,
          ocr_layer_pages: extractMeta.ocr_layer_pages || [],
          render_stats: result.stats,
          ocr_risk_pages: audit.risk_pages.map((value) => Number(chunk.start) + value),
          math_garbled_pages: (audit.math_garbled_pages || []).map((value) => Number(chunk.start) + value),
          two_column_pages: audit.two_column_pages.map((value) => Number(chunk.start) + value),
          codex_calls: chunkDiagnostics,
        };
        writeJsonAtomic(metadataPath, metadata);
        diagnostics.push(...chunkDiagnostics);
        onProgress(`구간 ${index + 1}/${chunks.length} 완료 (${chunk.start}-${chunk.end}쪽)`);
      } catch (error) {
        chunkErrors.push({ index, error });
        onProgress(`구간 ${index + 1} 실패: ${String(error.message || error).slice(0, 300)}`);
      }
    }
  });
  await Promise.all(workers);
  if (chunkErrors.length) {
    throw new Error(
      `failed chunks: ${chunkErrors.map(({ index, error }) => `${index + 1}(${error.message})`).join(", ")}`,
    );
  }

  const structurePath = path.join(options.outputDir, "structure-translations.json");
  let structureTranslations = {};
  if (fs.existsSync(structurePath)) {
    structureTranslations = readJson(structurePath).translations || {};
  } else if ((split.virtual_blocks || []).length) {
    onProgress("목차와 문서정보 번역 중...");
    const structureDiagnostics = [];
    const caller = makeCodexCaller({
      model: options.model,
      timeoutMs: options.timeoutMs,
      idToPage: new Map(),
      audit: { pages: [], risk_pages: [] },
      diagnostics: structureDiagnostics,
      cacheDir,
    });
    const result = await translateBlocksWithRetries({
      blocks: split.virtual_blocks,
      caller,
      gate,
      progress,
      onProgress,
      resourceLimits,
      batchChars: 45000,
      context: "PDF 목차와 문서정보",
    });
    structureTranslations = result.translations;
    diagnostics.push(...structureDiagnostics);
    writeJsonAtomic(structurePath, {
      translations: structureTranslations,
      codex_calls: structureDiagnostics,
    });
  }

  const orderedParts = chunks.map((_, index) =>
    path.join(partsDir, `part-${String(index).padStart(3, "0")}.ko.pdf`),
  );
  onProgress(`${orderedParts.length}개 번역 구간 병합 중...`);
  const stagedPath = navigationManifestBytes
    ? path.join(
      options.outputDir,
      `.${options.finalName}.pre-navigation-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
    )
    : null;
  const mergeOutputPath = stagedPath || finalPath;
  let mergeStats;
  let navigationStats = null;
  try {
    mergeStats = await pdfTool.mergePdf(mergeOutputPath, orderedParts, {
      sourcePdf: sourcePath,
      translations: structureTranslations,
      partManifest: split.part_manifest,
    });
    if (!mergeStats.ok || !mergeStats.structure_restored || mergeStats.page_count !== split.page_count) {
      throw new Error("merged PDF failed structural verification");
    }
    if (navigationManifestBytes) {
      onProgress("검증된 목차 북마크와 원문 URL 링크를 합성 중...");
      const result = await runProcess(
        PYTHON,
        [NAVIGATION_SYNTHESIS_PATH, "apply", sourcePath, mergeOutputPath],
        {
          input: navigationManifestBytes,
          timeoutMs: options.timeoutMs,
          maxStdout: 1024 * 1024,
        },
      );
      try {
        navigationStats = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(`navigation synthesis returned invalid JSON: ${error.message}`);
      }
      if (
        !navigationStats.ok ||
        navigationStats.manifest_sha256 !== navigationManifestSha256 ||
        navigationStats.source_sha256 !== sha256(inputBuffer)
      ) {
        throw new Error("navigation synthesis failed its source/manifest verification");
      }
      // A hard link publishes the staged artifact without ever overwriting an
      // attacker-created symlink or unrelated file at the requested final name.
      fs.linkSync(mergeOutputPath, finalPath);
      fs.unlinkSync(mergeOutputPath);
    }
  } finally {
    if (stagedPath) fs.rmSync(stagedPath, { force: true });
  }
  const partMetadata = chunks.map((_, index) =>
    readJson(path.join(partsDir, `part-${String(index).padStart(3, "0")}.json`)),
  );
  writeJsonAtomic(path.join(options.outputDir, "metadata.json"), {
    input: options.input,
    output: finalPath,
    final_name: options.finalName,
    model: options.model,
    page_count: split.page_count,
    chunk_pages: options.chunkPages,
    split_policy: split.split_policy,
    concurrency: options.concurrency,
    source_sha256: sha256(fs.readFileSync(sourcePath)),
    output_sha256: sha256(fs.readFileSync(finalPath)),
    translation_fingerprint: translationFingerprint,
    artifact_fingerprint: artifactFingerprint,
    navigation_manifest_sha256: navigationManifestSha256,
    navigation_stats: navigationStats,
    runner_version: RUNNER_VERSION,
    merge_stats: mergeStats,
    ocr_risk_pages: [...new Set(partMetadata.flatMap((item) => item.ocr_risk_pages || []))].sort((a, b) => a - b),
    two_column_pages: [...new Set(partMetadata.flatMap((item) => item.two_column_pages || []))].sort((a, b) => a - b),
    math_garbled_pages: [...new Set(partMetadata.flatMap((item) => item.math_garbled_pages || []))].sort((a, b) => a - b),
    codex_calls: [
      ...partMetadata.flatMap((item) => item.codex_calls || []),
      ...(fs.existsSync(structurePath) ? (readJson(structurePath).codex_calls || []) : []),
    ],
  });
  onProgress("전체 PDF 생성 완료");
  console.log(finalPath);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildTranslationSchema,
  makeCodexCaller,
  normalizedEnglishTokens,
  multisetRecall,
  parseArgs,
  pickVisualPages,
  readNavigationManifest,
  requestedItems,
  resolveSafeOutputFile,
  validateFinalName,
  hasValidSentenceSafeSplitLayout,
  DEFAULT_FINAL_NAME,
  SPLIT_POLICY_NAME,
};
