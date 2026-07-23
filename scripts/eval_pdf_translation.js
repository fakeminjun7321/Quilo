#!/usr/bin/env node
"use strict";

/**
 * End-to-end PDF translation evaluation harness.
 *
 * The default path starts translate-server.js on an ephemeral local port,
 * submits one source PDF, consumes the job SSE stream to a terminal event,
 * downloads the result, and runs the deterministic translation verifier.
 * A remote/open test server can be selected with --base-url.
 *
 * This file intentionally has no translation-engine imports: the HTTP path is
 * the contract under test.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_MODEL = "gpt-5.4-mini";
const DEFAULT_MODE = "auto";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_AUTH_TIMEOUT_MS = 15 * 1000;
const DEFAULT_VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_DEADLINE_MS = 40 * 60 * 1000;
const DEFAULT_MAX_SSE_EVENTS = 512;
const DEFAULT_MAX_SSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_MODES = new Set(["auto", "inplace", "retypeset"]);
const ALLOWED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

class EvaluationError extends Error {
  constructor(message, { exitCode = 1, code = "EVALUATION_FAILED" } = {}) {
    super(message);
    this.name = "EvaluationError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

function usage() {
  return `Usage:
  node scripts/eval_pdf_translation.js --input FILE.pdf [options]
  node scripts/eval_pdf_translation.js --cleanup-only --retention-days N

Options:
  --input, -i FILE       Source PDF (required)
  --model MODEL          Translation model (default: ${DEFAULT_MODEL})
  --mode MODE            auto, inplace, or retypeset (default: ${DEFAULT_MODE})
  --output-dir DIR       Exact run directory (default: output/pdf/evals/<run-id>)
  --base-url URL         Use an existing translate-server instead of spawning one
  --access-code CODE     Login code for a gated --base-url server
                         (prefer TRANSLATE_ACCESS_CODE to avoid shell history)
  --timeout-ms N         HTTP translation timeout (default: ${DEFAULT_TIMEOUT_MS})
  --auth-timeout-ms N    Authentication deadline (default: ${DEFAULT_AUTH_TIMEOUT_MS})
  --verify-timeout-ms N  Verifier deadline (default: ${DEFAULT_VERIFY_TIMEOUT_MS})
  --deadline-ms N        Whole-run deadline (default: ${DEFAULT_DEADLINE_MS})
  --max-sse-events N     Maximum accepted SSE events (default: ${DEFAULT_MAX_SSE_EVENTS})
  --max-sse-bytes N      Maximum accepted SSE bytes (default: ${DEFAULT_MAX_SSE_BYTES})
  --retention-days N     Delete expired runs under output/pdf/evals before running
  --cleanup-only         Apply --retention-days and exit without translating
  --help, -h             Show this help

Artifacts:
  source.pdf, output.pdf, events.jsonl, run.log, metadata.json,
  verification.json
`;
}

function normaliseBaseUrl(value) {
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvaluationError(`Invalid --base-url: ${value}`, {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new EvaluationError("--base-url must be an http(s) URL without embedded credentials", {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (parsed.protocol === "http:" && !loopback) {
    throw new EvaluationError("Plain HTTP is allowed only for an explicit loopback host", {
      exitCode: 2,
      code: "INSECURE_BASE_URL",
    });
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function parseArgs(argv, { cwd = process.cwd(), env = process.env } = {}) {
  const result = {
    input: null,
    model: env.PDF_EVAL_MODEL || DEFAULT_MODEL,
    mode: env.PDF_EVAL_MODE || DEFAULT_MODE,
    outputDir: null,
    baseUrl: null,
    accessCode: env.TRANSLATE_ACCESS_CODE || "",
    timeoutMs: Number(env.PDF_EVAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    authTimeoutMs: Number(env.PDF_EVAL_AUTH_TIMEOUT_MS || DEFAULT_AUTH_TIMEOUT_MS),
    verifyTimeoutMs: Number(env.PDF_EVAL_VERIFY_TIMEOUT_MS || DEFAULT_VERIFY_TIMEOUT_MS),
    deadlineMs: Number(env.PDF_EVAL_DEADLINE_MS || DEFAULT_DEADLINE_MS),
    maxSseEvents: Number(env.PDF_EVAL_MAX_SSE_EVENTS || DEFAULT_MAX_SSE_EVENTS),
    maxSseBytes: Number(env.PDF_EVAL_MAX_SSE_BYTES || DEFAULT_MAX_SSE_BYTES),
    retentionDays: env.PDF_EVAL_RETENTION_DAYS === undefined ||
        String(env.PDF_EVAL_RETENTION_DAYS).trim() === ""
      ? null
      : Number(env.PDF_EVAL_RETENTION_DAYS),
    cleanupOnly: false,
    help: false,
    repoRoot: REPO_ROOT,
  };

  const needValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new EvaluationError(`${flag} requires a value`, {
        exitCode: 2,
        code: "INVALID_ARGUMENT",
      });
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--input" || arg === "-i") {
      result.input = path.resolve(cwd, needValue(index, arg));
      index += 1;
    } else if (arg === "--model") {
      result.model = needValue(index, arg);
      index += 1;
    } else if (arg === "--mode") {
      result.mode = needValue(index, arg);
      index += 1;
    } else if (arg === "--output-dir") {
      result.outputDir = path.resolve(cwd, needValue(index, arg));
      index += 1;
    } else if (arg === "--base-url") {
      result.baseUrl = normaliseBaseUrl(needValue(index, arg));
      index += 1;
    } else if (arg === "--access-code") {
      result.accessCode = needValue(index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      result.timeoutMs = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--auth-timeout-ms") {
      result.authTimeoutMs = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--verify-timeout-ms") {
      result.verifyTimeoutMs = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--deadline-ms") {
      result.deadlineMs = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--max-sse-events") {
      result.maxSseEvents = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--max-sse-bytes") {
      result.maxSseBytes = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--retention-days") {
      result.retentionDays = Number(needValue(index, arg));
      index += 1;
    } else if (arg === "--cleanup-only") {
      result.cleanupOnly = true;
    } else if (!arg.startsWith("-") && !result.input) {
      result.input = path.resolve(cwd, arg);
    } else {
      throw new EvaluationError(`Unknown argument: ${arg}`, {
        exitCode: 2,
        code: "INVALID_ARGUMENT",
      });
    }
  }

  if (result.help) return result;
  if (!result.input && !result.cleanupOnly) {
    throw new EvaluationError("--input FILE.pdf is required", {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (!ALLOWED_MODELS.has(result.model)) {
    throw new EvaluationError(`Unsupported --model: ${result.model}`, {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (!ALLOWED_MODES.has(result.mode)) {
    throw new EvaluationError(`Unsupported --mode: ${result.mode}`, {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  for (const [flag, value, minimum] of [
    ["--timeout-ms", result.timeoutMs, 1_000],
    ["--auth-timeout-ms", result.authTimeoutMs, 1_000],
    ["--verify-timeout-ms", result.verifyTimeoutMs, 1_000],
    ["--deadline-ms", result.deadlineMs, 1_000],
    ["--max-sse-events", result.maxSseEvents, 1],
    ["--max-sse-bytes", result.maxSseBytes, 1],
  ]) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new EvaluationError(`${flag} must be an integer of at least ${minimum}`, {
        exitCode: 2,
        code: "INVALID_ARGUMENT",
      });
    }
  }
  if (result.retentionDays !== null &&
      (!Number.isSafeInteger(result.retentionDays) || result.retentionDays < 0)) {
    throw new EvaluationError("--retention-days must be a non-negative integer", {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (result.cleanupOnly && result.retentionDays === null) {
    throw new EvaluationError("--cleanup-only requires --retention-days", {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (result.cleanupOnly && result.outputDir) {
    throw new EvaluationError("--cleanup-only cannot be combined with --output-dir", {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  return result;
}

function decodeSseData(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Incremental SSE parser safe across CRLF, UTF-8, and arbitrary chunks. */
class SseParser {
  constructor(onEvent = () => {}) {
    this.onEvent = onEvent;
    this.decoder = new TextDecoder("utf-8", { fatal: false });
    this.buffer = "";
    this.eventName = "";
    this.dataLines = [];
    this.lastEventId = "";
    this.retry = null;
    this.stopped = false;
  }

  feed(chunk) {
    if (this.stopped) return false;
    if (typeof chunk === "string") {
      this.buffer += chunk;
    } else {
      this.buffer += this.decoder.decode(chunk, { stream: true });
    }
    this.#drainLines();
    return !this.stopped;
  }

  finish() {
    if (this.stopped) return;
    this.buffer += this.decoder.decode();
    this.#drainLines();
    if (this.buffer.length) {
      this.#processLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
      this.buffer = "";
    }
    this.#dispatch();
  }

  #drainLines() {
    let newline;
    while (!this.stopped && (newline = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#processLine(line);
    }
  }

  #processLine(line) {
    if (line === "") {
      this.#dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.eventName = value;
    else if (field === "data") this.dataLines.push(value);
    else if (field === "id" && !value.includes("\0")) this.lastEventId = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.retry = Number(value);
  }

  #dispatch() {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return;
    }
    const rawData = this.dataLines.join("\n");
    const event = {
      event: this.eventName || "message",
      data: decodeSseData(rawData),
      rawData,
      id: this.lastEventId || null,
      retry: this.retry,
    };
    this.eventName = "";
    this.dataLines = [];
    if (this.onEvent(event) === false) this.stopped = true;
  }
}

async function consumeSse(body, {
  onEvent = () => {},
  stopWhen = () => false,
  maxEvents = DEFAULT_MAX_SSE_EVENTS,
  maxBytes = DEFAULT_MAX_SSE_BYTES,
} = {}) {
  if (!body) throw new EvaluationError("SSE response has no body", { code: "INVALID_SSE" });
  const events = [];
  let receivedBytes = 0;
  const parser = new SseParser((event) => {
    if (events.length >= maxEvents) {
      throw new EvaluationError(`SSE event limit exceeded (${maxEvents})`, {
        code: "SSE_EVENT_LIMIT_EXCEEDED",
      });
    }
    events.push(event);
    onEvent(event);
    return !stopWhen(event);
  });
  const feed = (chunk) => {
    receivedBytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (receivedBytes > maxBytes) {
      throw new EvaluationError(`SSE byte limit exceeded (${maxBytes})`, {
        code: "SSE_BYTE_LIMIT_EXCEEDED",
      });
    }
    return parser.feed(chunk);
  };

  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    let ended = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        if (!feed(value)) break;
      }
    } finally {
      if (!ended) {
        try { await reader.cancel("terminal SSE event received or stream rejected"); } catch {}
      }
      reader.releaseLock();
    }
  } else if (body[Symbol.asyncIterator]) {
    for await (const chunk of body) {
      if (!feed(chunk)) break;
    }
  } else {
    throw new EvaluationError("Unsupported SSE response body", { code: "INVALID_SSE" });
  }
  if (!parser.stopped) parser.finish();
  return events;
}

function createRunId(now = new Date()) {
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const SECURE_FILE_MODE = 0o600;
const SECURE_DIRECTORY_MODE = 0o700;

function prepareSecureDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath);
  const parsed = path.parse(absolute);
  if (absolute === parsed.root) {
    throw new EvaluationError("The filesystem root cannot be used as an output directory", {
      exitCode: 2,
      code: "UNSAFE_OUTPUT_DIR",
    });
  }
  let current = parsed.root;
  const segments = path.relative(parsed.root, absolute).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        fs.mkdirSync(current, { mode: SECURE_DIRECTORY_MODE });
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      }
      stat = fs.lstatSync(current);
    }
    if (stat.isSymbolicLink()) {
      throw new EvaluationError(`Symlink component is forbidden in output path: ${current}`, {
        exitCode: 2,
        code: "UNSAFE_OUTPUT_DIR",
      });
    }
    if (!stat.isDirectory()) {
      throw new EvaluationError(`Non-directory component in output path: ${current}`, {
        exitCode: 2,
        code: "UNSAFE_OUTPUT_DIR",
      });
    }
  }
  fs.chmodSync(absolute, SECURE_DIRECTORY_MODE);
  const realPath = fs.realpathSync(absolute);
  return { path: absolute, realPath };
}

function isPathContained(rootRealPath, candidateRealPath) {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertNoSymlinkComponents(existingPath, errorCode = "UNSAFE_OUTPUT_DIR") {
  const absolute = path.resolve(existingPath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new EvaluationError(`Symlink component is forbidden: ${current}`, {
        exitCode: 2,
        code: errorCode,
      });
    }
  }
}

function assertSecureArtifactPath(outputInfo, artifactPath, { allowExisting = false } = {}) {
  const absolute = path.resolve(artifactPath);
  const parentReal = fs.realpathSync(path.dirname(absolute));
  if (!isPathContained(outputInfo.realPath, parentReal) || parentReal !== outputInfo.realPath) {
    throw new EvaluationError(`Artifact escapes its output directory: ${absolute}`, {
      exitCode: 2,
      code: "UNSAFE_ARTIFACT_PATH",
    });
  }
  try {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new EvaluationError(`Unsafe artifact path: ${absolute}`, {
        exitCode: 2,
        code: "UNSAFE_ARTIFACT_PATH",
      });
    }
    const real = fs.realpathSync(absolute);
    if (!isPathContained(outputInfo.realPath, real)) {
      throw new EvaluationError(`Artifact realpath escapes its output directory: ${absolute}`, {
        exitCode: 2,
        code: "UNSAFE_ARTIFACT_PATH",
      });
    }
    if (!allowExisting) {
      throw new EvaluationError(`Output artifact already exists: ${absolute}`, {
        exitCode: 2,
        code: "OUTPUT_EXISTS",
      });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return absolute;
}

function secureCreateFile(outputInfo, filePath, data = "") {
  const absolute = assertSecureArtifactPath(outputInfo, filePath);
  let descriptor;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
      SECURE_FILE_MODE,
    );
    fs.writeFileSync(descriptor, data);
    fs.fchmodSync(descriptor, SECURE_FILE_MODE);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return absolute;
}

function writeJsonAtomic(outputInfo, filePath, value) {
  assertSecureArtifactPath(outputInfo, filePath, { allowExisting: true });
  const temporary = path.join(
    outputInfo.path,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
  );
  secureCreateFile(outputInfo, temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, SECURE_FILE_MODE);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertPdf(buffer, label) {
  if (!Buffer.isBuffer(buffer) || !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new EvaluationError(`${label} is not a PDF`, { code: "INVALID_PDF" });
  }
}

function openSecureAppender(outputInfo, filePath) {
  assertSecureArtifactPath(outputInfo, filePath, { allowExisting: true });
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | NOFOLLOW,
  );
  let closed = false;
  return {
    write(value) {
      if (closed) throw new Error(`Appender is closed: ${filePath}`);
      fs.writeSync(descriptor, value);
    },
    close() {
      if (closed) return;
      closed = true;
      fs.closeSync(descriptor);
    },
  };
}

function createLogger(outputInfo, logPath, { quiet = false } = {}) {
  const appender = openSecureAppender(outputInfo, logPath);
  const logger = (message) => {
    const line = `[${new Date().toISOString()}] ${String(message).replace(/\r?\n/g, "\n  ")}\n`;
    appender.write(line);
    if (!quiet) process.stdout.write(line);
  };
  logger.close = () => appender.close();
  return logger;
}

function cleanupExpiredRuns(evalRoot, { retentionDays, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) {
    throw new EvaluationError("retentionDays must be a non-negative integer", {
      exitCode: 2,
      code: "INVALID_RETENTION",
    });
  }
  const root = path.resolve(evalRoot);
  if (!fs.existsSync(root)) return { root, retentionDays, removed: [], skipped: [] };
  assertNoSymlinkComponents(root, "UNSAFE_CLEANUP_ROOT");
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new EvaluationError(`Unsafe evaluation cleanup root: ${root}`, {
      exitCode: 2,
      code: "UNSAFE_CLEANUP_ROOT",
    });
  }
  const rootReal = fs.realpathSync(root);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  const skipped = [];
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
        !/^\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(name)) {
      skipped.push(name);
      continue;
    }
    const real = fs.realpathSync(candidate);
    if (!isPathContained(rootReal, real)) {
      throw new EvaluationError(`Cleanup candidate escapes evaluation root: ${candidate}`, {
        exitCode: 2,
        code: "UNSAFE_CLEANUP_TARGET",
      });
    }
    if (stat.mtimeMs <= cutoff) {
      fs.rmSync(candidate, { recursive: true, force: false });
      removed.push(name);
    }
  }
  return { root, retentionDays, removed, skipped };
}

function delay(ms, signal = null) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done(signal.reason || new Error("aborted"));
    function done(error = null) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createAbortScope({ parentSignal = null, timeoutMs = null, timeoutError = null } = {}) {
  const controller = new AbortController();
  let reason = null;
  const abort = (value) => {
    if (controller.signal.aborted) return;
    reason = value instanceof Error ? value : new Error(String(value || "aborted"));
    controller.abort(reason);
  };
  const onParentAbort = () => abort(parentSignal.reason || new Error("parent deadline exceeded"));
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = Number.isFinite(timeoutMs) && timeoutMs >= 0
    ? setTimeout(() => abort(timeoutError || new Error(`deadline exceeded after ${timeoutMs}ms`)), timeoutMs)
    : null;
  return {
    signal: controller.signal,
    get reason() { return reason; },
    cleanup() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

async function awaitWithSignal(promise, signal) {
  if (!signal) return await promise;
  if (signal.aborted) throw signal.reason || new Error("aborted");
  return await new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function findAvailablePort(host = "127.0.0.1") {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function fetchBrief(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
  signal = null,
} = {}) {
  const scope = createAbortScope({
    parentSignal: signal,
    timeoutMs,
    timeoutError: new EvaluationError(`Health request exceeded ${timeoutMs}ms`, {
      code: "HEALTH_TIMEOUT",
    }),
  });
  try {
    const response = await fetchImpl(url, { signal: scope.signal, redirect: "error" });
    await response.arrayBuffer();
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (scope.signal.aborted) throw scope.reason;
    throw error;
  } finally {
    scope.cleanup();
  }
}

async function waitForHealth(baseUrl, {
  fetchImpl = globalThis.fetch,
  child = null,
  timeoutMs = 20_000,
  signal = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    if (child && child.exitCode !== null) {
      throw new EvaluationError(`translate-server exited during startup (code ${child.exitCode})`, {
        code: "SERVER_START_FAILED",
      });
    }
    try {
      const response = await fetchBrief(`${baseUrl}/healthz`, {
        fetchImpl,
        timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
        signal,
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      lastError = error;
    }
    await delay(Math.min(125, Math.max(1, deadline - Date.now())), signal);
  }
  throw new EvaluationError(
    `translate-server did not become healthy at ${baseUrl}: ${lastError?.message || "timeout"}`,
    { code: "SERVER_START_FAILED" },
  );
}

function signalProcessGroup(child, signal) {
  if (!child || child.exitCode !== null || !child.pid) return false;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      try { return child.kill(signal); } catch { return false; }
    }
  }
  try { return child.kill(signal); } catch { return false; }
}

async function terminateProcessGroup(child, {
  log = () => {},
  graceMs = 3_000,
  label = "child process",
} = {}) {
  if (!child || child.exitCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(graceMs).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    log(`${label} did not stop after SIGTERM; sending SIGKILL to its process group`);
    signalProcessGroup(child, "SIGKILL");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(1_000),
    ]);
  }
}

async function startManagedServer({
  repoRoot = REPO_ROOT,
  log,
  fetchImpl = globalThis.fetch,
  signal = null,
} = {}) {
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repoRoot, "translate-server.js")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      TRANSLATE_ALLOW_OPEN_DEV: "1",
      TRANSLATE_ACCESS_CODES: "",
      TRANSLATE_ACCESS_CODE: "",
      TRANSLATE_PORT: String(port),
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  child.stdout.on("data", (chunk) => log(`[server:stdout] ${chunk.toString("utf8").trimEnd()}`));
  child.stderr.on("data", (chunk) => log(`[server:stderr] ${chunk.toString("utf8").trimEnd()}`));
  child.on("error", (error) => log(`[server:error] ${error.message}`));
  try {
    await waitForHealth(baseUrl, { fetchImpl, child, signal });
  } catch (error) {
    await stopManagedServer(child, log);
    throw error;
  }
  return { child, baseUrl, port };
}

async function stopManagedServer(child, log = () => {}) {
  await terminateProcessGroup(child, { log, label: "Managed translate-server" });
}

function cookieFromResponse(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";", 1)[0] || "";
}

async function readJsonResponse(response, context) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new EvaluationError(`${context} returned invalid JSON (HTTP ${response.status})`, {
      code: "INVALID_SERVER_RESPONSE",
    });
  }
  if (!response.ok) {
    throw new EvaluationError(`${context} failed (HTTP ${response.status}): ${parsed.error || text}`, {
      code: "SERVER_REQUEST_FAILED",
    });
  }
  return parsed;
}

async function authenticate(baseUrl, accessCode, {
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
} = {}) {
  const scope = createAbortScope({
    parentSignal: signal,
    timeoutMs,
    timeoutError: new EvaluationError(`Authentication exceeded ${timeoutMs}ms`, {
      code: "AUTH_TIMEOUT",
    }),
  });
  try {
    const meResponse = await fetchImpl(`${baseUrl}/api/me`, {
      signal: scope.signal,
      redirect: "error",
    });
    if (meResponse.status === 404) {
      await meResponse.arrayBuffer();
      return "";
    }
    const me = await readJsonResponse(meResponse, "Authentication status");
    if (me.authed) return "";
    if (!accessCode) {
      throw new EvaluationError(
        "translate-server requires authentication; pass --access-code or TRANSLATE_ACCESS_CODE",
        { code: "AUTH_REQUIRED" },
      );
    }
    const response = await fetchImpl(`${baseUrl}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: accessCode }),
      signal: scope.signal,
      redirect: "error",
    });
    await readJsonResponse(response, "Login");
    const cookie = cookieFromResponse(response);
    if (!cookie) {
      throw new EvaluationError("Login succeeded without a session cookie", {
        code: "AUTH_COOKIE_MISSING",
      });
    }
    return cookie;
  } catch (error) {
    if (scope.signal.aborted) throw scope.reason;
    throw error;
  } finally {
    scope.cleanup();
  }
}

function requestHeaders(cookie) {
  return cookie ? { cookie } : {};
}

function describeEvent(event) {
  if (typeof event.data === "string") return event.data;
  return JSON.stringify(event.data);
}

function resolveEffectiveMode(doneData, events = []) {
  if (!doneData || typeof doneData !== "object" || Array.isArray(doneData)) {
    throw new EvaluationError("The done event must contain a structured payload", {
      code: "INVALID_DONE_PAYLOAD",
    });
  }
  const explicit = String(doneData.effectiveMode || "");
  if (!new Set(["inplace", "retypeset"]).has(explicit)) {
    throw new EvaluationError("The done event is missing a valid effectiveMode", {
      code: "MISSING_EFFECTIVE_MODE",
    });
  }

  const signals = { explicit, filename: null, progress: [] };
  const filename = String(doneData.filename || "");
  if (/_재조판\.pdf$/i.test(filename)) signals.filename = "retypeset";
  else if (/_KO\.pdf$/i.test(filename)) signals.filename = "inplace";

  const progressModes = new Set();
  for (const item of events.filter((event) => event.event === "progress")) {
    const line = String(item.data || "");
    if (/자동 변환방식\s*→\s*재조판|OCR 재조판으로 전환|재조판 완료!/.test(line)) {
      progressModes.add("retypeset");
    }
    if (/자동 변환방식\s*→\s*빠른 번역|🎉 완료!/.test(line) && !/재조판 완료!/.test(line)) {
      progressModes.add("inplace");
    }
  }
  signals.progress = [...progressModes];
  const observed = [explicit, signals.filename, ...signals.progress].filter(Boolean);
  if (new Set(observed).size !== 1) {
    throw new EvaluationError(
      `Conflicting effective-mode signals: ${JSON.stringify(signals)}`,
      { code: "EFFECTIVE_MODE_CONFLICT" },
    );
  }
  return { mode: explicit, signals };
}

function inferEffectiveMode(_requestedMode, doneData, events = []) {
  return resolveEffectiveMode(doneData, events).mode;
}

function choosePython(repoRoot = REPO_ROOT, env = process.env) {
  if (env.PYTHON_BIN) return env.PYTHON_BIN;
  for (const candidate of [
    path.join(repoRoot, ".venv", "bin", "python3"),
    path.join(repoRoot, ".venv", "bin", "python"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "python3";
}

function buildVerifierInvocation({
  translated,
  original,
  jsonPath,
  mode,
  repoRoot = REPO_ROOT,
  env = process.env,
} = {}) {
  if (!new Set(["inplace", "retypeset"]).has(mode)) {
    throw new EvaluationError(`Invalid effective verifier mode: ${mode}`, {
      code: "INVALID_VERIFIER_MODE",
    });
  }
  return {
    command: choosePython(repoRoot, env),
    args: [
      path.join(repoRoot, "scripts", "verify_translation.py"),
      translated,
      "--original",
      original,
      "--json",
      jsonPath,
      "--mode",
      mode,
    ],
  };
}

async function runVerifier(options) {
  const invocation = buildVerifierInvocation(options);
  if (options.signal?.aborted) {
    return {
      exitCode: 2,
      signal: null,
      stdout: "",
      stderr: `Verifier not started: ${options.signal.reason?.message || "overall deadline exceeded"}\n`,
      report: null,
      invocation,
      aborted: true,
    };
  }
  const scope = createAbortScope({
    parentSignal: options.signal || null,
    timeoutMs: options.timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS,
    timeoutError: new EvaluationError(
      `Verifier exceeded ${options.timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS}ms`,
      { exitCode: 2, code: "VERIFIER_TIMEOUT" },
    ),
  });
  const result = await new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.repoRoot || REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;
    const appendLimited = (current, chunk) => {
      if (Buffer.byteLength(current) >= 2 * 1024 * 1024) return current;
      return (current + chunk.toString("utf8")).slice(0, 2 * 1024 * 1024);
    };
    child.stdout.on("data", (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendLimited(stderr, chunk); });
    const onAbort = () => {
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 2_000);
    };
    if (scope.signal.aborted) onAbort();
    else scope.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      scope.signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    child.once("error", (error) => finish({
      exitCode: 2,
      signal: null,
      stdout,
      stderr: `${stderr}\nVerifier spawn failed: ${error.message}\n`,
      aborted: scope.signal.aborted,
    }));
    child.once("close", (exitCode, signal) => finish({
      exitCode: scope.signal.aborted ? 2 : (exitCode === null ? 2 : exitCode),
      signal: signal || null,
      stdout,
      stderr: scope.signal.aborted
        ? `${stderr}\n${scope.reason?.message || "Verifier aborted"}\n`
        : stderr,
      aborted: scope.signal.aborted,
    }));
  });
  scope.cleanup();

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(options.jsonPath, "utf8"));
  } catch (error) {
    result.exitCode = 2;
    result.stderr += `\nVerifier did not produce readable JSON: ${error.message}\n`;
  }
  return { ...result, report, invocation };
}

function validateVerifierOutcome(processExitCode, report) {
  const problems = [];
  if (![0, 1, 2].includes(processExitCode)) {
    problems.push(`unsupported verifier process exit code: ${processExitCode}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    problems.push("verifier report is missing or not an object");
    return { valid: false, problems, expectedExitCode: 2 };
  }
  if (![0, 1, 2].includes(report.exit_code)) {
    problems.push(`invalid report.exit_code: ${report.exit_code}`);
  }
  if (report.exit_code !== processExitCode) {
    problems.push(`process exit ${processExitCode} != report.exit_code ${report.exit_code}`);
  }
  if (typeof report.passed !== "boolean") problems.push("report.passed must be boolean");
  if (!Array.isArray(report.hard_failures) ||
      report.hard_failures.some((item) => typeof item !== "string" || !item)) {
    problems.push("report.hard_failures must be an array of non-empty strings");
  }
  const hardFailures = Array.isArray(report.hard_failures) ? report.hard_failures : [];
  if (processExitCode === 0 && (report.passed !== true || hardFailures.length !== 0)) {
    problems.push("exit 0 requires passed=true and zero hard_failures");
  }
  if ((processExitCode === 1 || processExitCode === 2) &&
      (report.passed !== false || hardFailures.length === 0)) {
    problems.push(`exit ${processExitCode} requires passed=false and at least one hard_failure`);
  }
  return {
    valid: problems.length === 0,
    problems,
    expectedExitCode: problems.length === 0 ? processExitCode : 2,
  };
}

async function runEvaluation(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const verifierRunner = dependencies.verifierRunner || runVerifier;
  if (typeof fetchImpl !== "function" || typeof FormData !== "function" || typeof Blob !== "function") {
    throw new EvaluationError("Node.js 18+ fetch, FormData, and Blob support is required", {
      exitCode: 2,
      code: "UNSUPPORTED_RUNTIME",
    });
  }

  const repoRoot = config.repoRoot || REPO_ROOT;
  const runId = config.runId || createRunId();
  const requestedOutputDir = config.outputDir || path.join(repoRoot, "output", "pdf", "evals", runId);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authTimeoutMs = config.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const verifyTimeoutMs = config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const deadlineMs = config.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const maxSseEvents = config.maxSseEvents ?? DEFAULT_MAX_SSE_EVENTS;
  const maxSseBytes = config.maxSseBytes ?? DEFAULT_MAX_SSE_BYTES;
  if (!ALLOWED_MODELS.has(config.model)) {
    throw new EvaluationError(`Unsupported model: ${config.model}`, {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  if (!ALLOWED_MODES.has(config.mode)) {
    throw new EvaluationError(`Unsupported mode: ${config.mode}`, {
      exitCode: 2,
      code: "INVALID_ARGUMENT",
    });
  }
  for (const [name, value] of Object.entries({
    timeoutMs,
    authTimeoutMs,
    verifyTimeoutMs,
    deadlineMs,
    maxSseEvents,
    maxSseBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new EvaluationError(`${name} must be a positive safe integer`, {
        exitCode: 2,
        code: "INVALID_ARGUMENT",
      });
    }
  }
  if (!fs.existsSync(config.input) || !fs.statSync(config.input).isFile()) {
    throw new EvaluationError(`Input file does not exist: ${config.input}`, {
      exitCode: 2,
      code: "INPUT_NOT_FOUND",
    });
  }
  const sourceBuffer = fs.readFileSync(config.input);
  assertPdf(sourceBuffer, "Input");
  const outputInfo = prepareSecureDirectory(requestedOutputDir);
  const outputDir = outputInfo.path;

  const paths = {
    source: path.join(outputDir, "source.pdf"),
    output: path.join(outputDir, "output.pdf"),
    events: path.join(outputDir, "events.jsonl"),
    log: path.join(outputDir, "run.log"),
    metadata: path.join(outputDir, "metadata.json"),
    verification: path.join(outputDir, "verification.json"),
  };
  for (const artifactPath of Object.values(paths)) assertSecureArtifactPath(outputInfo, artifactPath);
  secureCreateFile(outputInfo, paths.source, sourceBuffer);
  secureCreateFile(outputInfo, paths.events, "");
  secureCreateFile(outputInfo, paths.log, "");
  secureCreateFile(outputInfo, paths.metadata, "");
  const log = createLogger(outputInfo, paths.log, { quiet: dependencies.quiet === true });
  const eventAppender = openSecureAppender(outputInfo, paths.events);
  const startedAtMs = Date.now();
  const metadata = {
    schemaVersion: "quilo.pdf-translation-eval.v1",
    runId,
    status: "running",
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: null,
    model: config.model,
    mode: { requested: config.mode, effective: null, verification: null },
    durationMs: null,
    translationDurationMs: null,
    deadlinesMs: {
      overall: deadlineMs,
      authentication: authTimeoutMs,
      translation: timeoutMs,
      verification: verifyTimeoutMs,
    },
    sseLimits: { events: maxSseEvents, bytes: maxSseBytes },
    retention: config.retentionDays === null || config.retentionDays === undefined
      ? null
      : {
          days: config.retentionDays,
          removedRuns: config.cleanupResult?.removed || [],
        },
    sizeBytes: { source: sourceBuffer.length, output: null },
    source: {
      originalName: path.basename(config.input),
      sha256: sha256(sourceBuffer),
    },
    server: {
      managed: !config.baseUrl,
      baseUrl: config.baseUrl || null,
      port: null,
    },
    job: { id: null, terminalEvent: null, events: [] },
    verification: null,
    artifacts: {
      source: "source.pdf",
      output: null,
      events: "events.jsonl",
      log: "run.log",
      metadata: "metadata.json",
      verification: null,
    },
    error: null,
  };
  writeJsonAtomic(outputInfo, paths.metadata, metadata);

  let managed = null;
  let translationScope = null;
  let verificationScope = null;
  const overallScope = createAbortScope({
    timeoutMs: deadlineMs,
    timeoutError: new EvaluationError(`Evaluation exceeded the ${deadlineMs}ms overall deadline`, {
      exitCode: 2,
      code: "OVERALL_DEADLINE_EXCEEDED",
    }),
  });
  try {
    log(`Starting PDF evaluation run ${runId}`);
    log(`Input=${path.basename(config.input)} model=${config.model} requestedMode=${config.mode}`);
    let baseUrl = config.baseUrl;
    if (!baseUrl) {
      managed = await startManagedServer({
        repoRoot,
        log,
        fetchImpl,
        signal: overallScope.signal,
      });
      baseUrl = managed.baseUrl;
      metadata.server.baseUrl = baseUrl;
      metadata.server.port = managed.port;
      log(`Managed translate-server is healthy at ${baseUrl}`);
    } else {
      await waitForHealth(baseUrl, {
        fetchImpl,
        timeoutMs: Math.min(5_000, deadlineMs),
        signal: overallScope.signal,
      });
      log(`Connected to translate-server at ${baseUrl}`);
    }

    const cookie = await authenticate(baseUrl, config.accessCode || "", {
      fetchImpl,
      signal: overallScope.signal,
      timeoutMs: authTimeoutMs,
    });
    translationScope = createAbortScope({
      parentSignal: overallScope.signal,
      timeoutMs,
      timeoutError: new EvaluationError(`Translation HTTP flow exceeded ${timeoutMs}ms`, {
        code: "TRANSLATION_TIMEOUT",
      }),
    });
    const translationStartedAt = Date.now();
    const form = new FormData();
    form.append("pdf", new Blob([sourceBuffer], { type: "application/pdf" }), path.basename(config.input));
    form.append("model", config.model);
    form.append("mode", config.mode);
    log("Submitting POST /api/translate-pdf");
    const submitResponse = await fetchImpl(`${baseUrl}/api/translate-pdf`, {
      method: "POST",
      headers: requestHeaders(cookie),
      body: form,
      signal: translationScope.signal,
      redirect: "error",
    });
    const submit = await readJsonResponse(submitResponse, "Translation submission");
    if (!submit.jobId || typeof submit.jobId !== "string") {
      throw new EvaluationError("Translation submission returned no jobId", {
        code: "INVALID_SERVER_RESPONSE",
      });
    }
    metadata.job.id = submit.jobId;
    log(`Job created: ${submit.jobId}`);

    const streamResponse = await fetchImpl(
      `${baseUrl}/api/jobs/${encodeURIComponent(submit.jobId)}/stream`,
      {
        headers: requestHeaders(cookie),
        signal: translationScope.signal,
        redirect: "error",
      },
    );
    if (!streamResponse.ok) {
      throw new EvaluationError(`SSE stream failed (HTTP ${streamResponse.status})`, {
        code: "SSE_REQUEST_FAILED",
      });
    }
    const contentType = streamResponse.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      throw new EvaluationError(`Expected text/event-stream, got ${contentType || "unknown"}`, {
        code: "INVALID_SSE",
      });
    }
    const events = await consumeSse(streamResponse.body, {
      onEvent: (event) => {
        const stored = {
          sequence: metadata.job.events.length + 1,
          receivedAt: new Date().toISOString(),
          event: event.event,
          data: event.data,
          id: event.id,
        };
        metadata.job.events.push(stored);
        eventAppender.write(`${JSON.stringify(stored)}\n`);
        log(`[sse:${event.event}] ${describeEvent(event)}`);
      },
      stopWhen: (event) => event.event === "done" || event.event === "error",
      maxEvents: maxSseEvents,
      maxBytes: maxSseBytes,
    });
    const terminalEvents = events.filter((event) => event.event === "done" || event.event === "error");
    if (terminalEvents.length === 0) {
      throw new EvaluationError("SSE stream ended without a done/error event", {
        code: "SSE_TERMINAL_MISSING",
      });
    }
    if (terminalEvents.length !== 1 || events[events.length - 1] !== terminalEvents[0]) {
      throw new EvaluationError("SSE stream contained an ambiguous or non-final terminal event", {
        code: "SSE_TERMINAL_INVALID",
      });
    }
    const terminal = terminalEvents[0];
    metadata.job.terminalEvent = terminal.event;
    if (terminal.event === "error") {
      throw new EvaluationError(`Translation job failed: ${describeEvent(terminal)}`, {
        code: "TRANSLATION_JOB_FAILED",
      });
    }

    const modeResolution = resolveEffectiveMode(terminal.data, events);
    const effectiveMode = modeResolution.mode;
    metadata.mode.effective = effectiveMode;
    metadata.mode.verification = effectiveMode;
    metadata.mode.signals = modeResolution.signals;
    const downloadResponse = await fetchImpl(
      `${baseUrl}/api/jobs/${encodeURIComponent(submit.jobId)}/download`,
      {
        headers: requestHeaders(cookie),
        signal: translationScope.signal,
        redirect: "error",
      },
    );
    if (!downloadResponse.ok) {
      throw new EvaluationError(`Result download failed (HTTP ${downloadResponse.status})`, {
        code: "DOWNLOAD_FAILED",
      });
    }
    const outputBuffer = Buffer.from(await downloadResponse.arrayBuffer());
    assertPdf(outputBuffer, "Downloaded output");
    secureCreateFile(outputInfo, paths.output, outputBuffer);
    translationScope.cleanup();
    translationScope = null;
    metadata.translationDurationMs = Date.now() - translationStartedAt;
    metadata.sizeBytes.output = outputBuffer.length;
    metadata.output = {
      serverFilename: typeof terminal.data === "object" && terminal.data
        ? terminal.data.filename || null
        : null,
      sha256: sha256(outputBuffer),
    };
    metadata.artifacts.output = "output.pdf";
    log(`Downloaded output.pdf (${outputBuffer.length} bytes), effectiveMode=${effectiveMode}`);

    const verifierOptions = {
      translated: paths.output,
      original: paths.source,
      jsonPath: paths.verification,
      mode: effectiveMode,
      repoRoot,
      timeoutMs: verifyTimeoutMs,
    };
    secureCreateFile(outputInfo, paths.verification, "");
    verificationScope = createAbortScope({
      parentSignal: overallScope.signal,
      timeoutMs: verifyTimeoutMs,
      timeoutError: new EvaluationError(`Verifier exceeded ${verifyTimeoutMs}ms`, {
        exitCode: 2,
        code: "VERIFIER_TIMEOUT",
      }),
    });
    verifierOptions.signal = verificationScope.signal;
    const invocation = buildVerifierInvocation(verifierOptions);
    log(`Running verifier: ${invocation.command} ${invocation.args.join(" ")}`);
    let verification;
    try {
      verification = await awaitWithSignal(
        verifierRunner(verifierOptions),
        verificationScope.signal,
      );
    } catch (error) {
      const reason = verificationScope.reason || error;
      const timeoutReport = {
        schema_version: null,
        passed: false,
        hard_failures: [reason?.code === "OVERALL_DEADLINE_EXCEEDED"
          ? "overall_deadline"
          : "verifier_timeout"],
        exit_code: 2,
        error: reason?.message || String(reason),
      };
      writeJsonAtomic(outputInfo, paths.verification, timeoutReport);
      metadata.verification = {
        processExitCode: 2,
        reportExitCode: 2,
        signal: null,
        passed: false,
        hardFailures: timeoutReport.hard_failures,
        command: [invocation.command, ...invocation.args],
        contractValid: true,
        contractProblems: [],
      };
      metadata.artifacts.verification = "verification.json";
      metadata.status = "verifier_internal_error";
      throw reason;
    }
    verificationScope.cleanup();
    verificationScope = null;
    if (!verification || typeof verification !== "object" || Array.isArray(verification)) {
      verification = {
        exitCode: 2,
        signal: null,
        stdout: "",
        stderr: "Verifier runner returned no structured result",
        report: null,
      };
    }
    if (verification.stdout) log(`[verifier:stdout] ${String(verification.stdout).trimEnd()}`);
    if (verification.stderr) log(`[verifier:stderr] ${String(verification.stderr).trimEnd()}`);
    if (!verification.report) {
      verification.exitCode = 2;
      verification.report = {
        schema_version: null,
        passed: false,
        hard_failures: ["verifier_execution"],
        exit_code: 2,
        error: "Verifier did not produce a readable JSON report",
      };
    }
    const verifierExitCode = Number.isInteger(verification.exitCode) ? verification.exitCode : 2;
    const verifierContract = validateVerifierOutcome(verifierExitCode, verification.report);
    writeJsonAtomic(outputInfo, paths.verification, verification.report);
    metadata.verification = {
      processExitCode: verifierExitCode,
      reportExitCode: verification.report?.exit_code ?? null,
      signal: verification.signal || null,
      passed: verification.report?.passed === true,
      hardFailures: verification.report?.hard_failures || [],
      command: [invocation.command, ...invocation.args],
      contractValid: verifierContract.valid,
      contractProblems: verifierContract.problems,
    };
    metadata.artifacts.verification = "verification.json";
    if (!verifierContract.valid) {
      metadata.status = "verifier_contract_failed";
      throw new EvaluationError(
        `Verifier process/report contract mismatch: ${verifierContract.problems.join("; ")}`,
        { exitCode: 2, code: "VERIFIER_CONTRACT_MISMATCH" },
      );
    }
    if (verifierExitCode === 2) {
      metadata.status = "verifier_internal_error";
      throw new EvaluationError(
        `Strict PDF verifier failed internally; see ${paths.verification}`,
        { exitCode: 2, code: "VERIFIER_INTERNAL_ERROR" },
      );
    }
    if (verifierExitCode === 1) {
      metadata.status = "verification_failed";
      throw new EvaluationError(
        `Strict PDF verification failed (exit ${verifierExitCode}); see ${paths.verification}`,
        { exitCode: 1, code: "VERIFICATION_FAILED" },
      );
    }

    metadata.status = "passed";
    log("Strict PDF verification passed");
    return { outputDir, metadata, paths };
  } catch (error) {
    if (overallScope.signal.aborted) error = overallScope.reason;
    else if (verificationScope?.signal.aborted) error = verificationScope.reason;
    else if (translationScope?.signal.aborted) error = translationScope.reason;
    if (!(error instanceof Error)) error = new EvaluationError(String(error));
    if (metadata.status === "running") metadata.status = "failed";
    metadata.error = {
      name: error?.name || "Error",
      code: error?.code || "EVALUATION_FAILED",
      message: error?.message || String(error),
    };
    log(`Evaluation failed: ${metadata.error.code}: ${metadata.error.message}`);
    error.outputDir = outputDir;
    throw error;
  } finally {
    translationScope?.cleanup();
    verificationScope?.cleanup();
    metadata.completedAt = new Date().toISOString();
    metadata.durationMs = Date.now() - startedAtMs;
    if (managed) {
      try {
        await stopManagedServer(managed.child, log);
      } catch (error) {
        log(`Managed translate-server cleanup failed: ${error.message || error}`);
      }
    }
    try {
      writeJsonAtomic(outputInfo, paths.metadata, metadata);
    } finally {
      eventAppender.close();
      log.close();
      overallScope.cleanup();
    }
  }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  let config;
  try {
    config = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${usage()}`);
    return error.exitCode || 2;
  }
  if (config.help) {
    stdout.write(usage());
    return 0;
  }
  if (config.retentionDays !== null) {
    try {
      config.cleanupResult = cleanupExpiredRuns(
        path.join(config.repoRoot || REPO_ROOT, "output", "pdf", "evals"),
        { retentionDays: config.retentionDays },
      );
      stdout.write(
        `Cleanup: removed ${config.cleanupResult.removed.length} expired run(s), ` +
        `skipped ${config.cleanupResult.skipped.length}\n`,
      );
    } catch (error) {
      stderr.write(`Cleanup failed: ${error.message}\n`);
      return error.exitCode || 2;
    }
  }
  if (config.cleanupOnly) return 0;
  try {
    const result = await runEvaluation(config, dependencies);
    stdout.write(`\nPASS: ${result.outputDir}\n`);
    return 0;
  } catch (error) {
    stderr.write(`\nFAIL: ${error.message}\n`);
    if (error.outputDir) stderr.write(`Artifacts: ${error.outputDir}\n`);
    return error.exitCode || 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  ALLOWED_MODELS,
  EvaluationError,
  SseParser,
  buildVerifierInvocation,
  cleanupExpiredRuns,
  consumeSse,
  decodeSseData,
  inferEffectiveMode,
  main,
  normaliseBaseUrl,
  parseArgs,
  prepareSecureDirectory,
  resolveEffectiveMode,
  runEvaluation,
  runVerifier,
  terminateProcessGroup,
  usage,
  validateVerifierOutcome,
};
