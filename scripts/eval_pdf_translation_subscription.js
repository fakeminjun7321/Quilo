#!/usr/bin/env node
"use strict";

// Local, reproducible in-place evaluation through an authenticated Claude
// subscription. This is intentionally an evaluation adapter: production
// requests continue to use the API caller configured by translate-server.js.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  createPdfTranslateResourceLimits,
  makeGate,
  translateSinglePdf,
} = require("../lib/pipelines/pdf-translate/translate");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;

function usage() {
  return [
    "Usage: node scripts/eval_pdf_translation_subscription.js --input FILE.pdf --output-dir DIR [options]",
    "",
    "Options:",
    "  --model sonnet|opus    Claude subscription model alias (default: sonnet)",
    "  --timeout-ms N         Per-model-call deadline (default: 600000)",
    "  --help                 Show this help",
  ].join("\n");
}

function parseArgs(argv, cwd = process.cwd()) {
  const out = { input: null, outputDir: null, model: "sonnet", timeoutMs: DEFAULT_TIMEOUT_MS };
  const valueAfter = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { ...out, help: true };
    if (arg === "--input" || arg === "-i") {
      out.input = path.resolve(cwd, valueAfter(index, arg));
      index += 1;
    } else if (arg === "--output-dir") {
      out.outputDir = path.resolve(cwd, valueAfter(index, arg));
      index += 1;
    } else if (arg === "--model") {
      out.model = valueAfter(index, arg);
      index += 1;
    } else if (arg === "--timeout-ms") {
      out.timeoutMs = Number(valueAfter(index, arg));
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!out.input || !out.outputDir) throw new Error("--input and --output-dir are required");
  if (!new Set(["sonnet", "opus"]).has(out.model)) throw new Error("--model must be sonnet or opus");
  if (!Number.isSafeInteger(out.timeoutMs) || out.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be an integer of at least 1000");
  }
  return out;
}

function requestedIds(user) {
  const lines = String(user || "").trimEnd().split(/\r?\n/);
  const jsonLine = [...lines].reverse().find((line) => {
    const value = line.trim();
    return value.startsWith("[") && value.endsWith("]");
  });
  if (!jsonLine) throw new Error("translation request did not end in a JSON item array");
  const items = JSON.parse(jsonLine.trim());
  if (!Array.isArray(items) || !items.length) throw new Error("translation request item array is empty");
  const ids = items.map((item) => String(item && item.id));
  if (ids.some((id) => !id || id === "undefined") || new Set(ids).size !== ids.length) {
    throw new Error("translation request contains invalid or duplicate IDs");
  }
  return ids;
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

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function runProcess(command, args, {
  input = "",
  signal,
  timeoutMs,
  maxStdout = MAX_STDOUT_BYTES,
  allowNonzero = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const stop = (error) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };
    const timer = setTimeout(() => stop(new Error(`${command} timed out`)), timeoutMs || DEFAULT_TIMEOUT_MS);
    const onAbort = () => stop(Object.assign(new Error("evaluation aborted"), { name: "AbortError" }));
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdout) return stop(new Error(`${command} stdout exceeded limit`));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return stop(new Error(`${command} stderr exceeded limit`));
      stderr.push(chunk);
    });
    child.on("error", stop);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (settled) return;
      settled = true;
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0 && !allowNonzero) {
        return reject(new Error(`${command} exited ${code}: ${err.slice(0, 800)}`));
      }
      resolve({ stdout: out, stderr: err, code });
    });
    child.stdin.end(input);
  });
}

function makeClaudeSubscriptionCaller({ model = "sonnet", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const diagnostics = [];
  const caller = async ({ system, user, signal }) => {
    const ids = requestedIds(user);
    const schema = buildTranslationSchema(ids);
    const result = await runProcess(
      "claude",
      [
        "-p",
        "--safe-mode",
        "--no-session-persistence",
        "--model", model,
        "--effort", "high",
        "--output-format", "json",
        "--permission-mode", "dontAsk",
        "--tools", "",
        "--system-prompt", String(system || ""),
        "--json-schema", JSON.stringify(schema),
      ],
      { input: String(user || ""), signal, timeoutMs },
    );
    let envelope;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      throw new Error("Claude subscription response was not JSON");
    }
    if (envelope.is_error || envelope.subtype !== "success") {
      throw new Error(`Claude subscription call failed: ${String(envelope.result || envelope.subtype || "unknown")}`);
    }
    const structured = envelope.structured_output || JSON.parse(envelope.result || "null");
    if (!structured || typeof structured !== "object") {
      throw new Error("Claude subscription response lacked structured output");
    }
    const usage = envelope.usage || {};
    diagnostics.push({
      requested_model: model,
      models_used: Object.keys(envelope.modelUsage || {}).sort(),
      request_uuid: String(envelope.uuid || ""),
      session_id: String(envelope.session_id || ""),
      duration_ms: Number(envelope.duration_ms || 0),
      terminal_reason: String(envelope.terminal_reason || ""),
      item_count: ids.length,
      total_cost_usd: Number(envelope.total_cost_usd || 0),
    });
    return {
      text: JSON.stringify(structured),
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
      },
    };
  };
  caller.diagnostics = diagnostics;
  return caller;
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
  const sourcePath = path.join(options.outputDir, "source.pdf");
  const outputPath = path.join(options.outputDir, "output.pdf");
  const verificationPath = path.join(options.outputDir, "verification.json");
  fs.copyFileSync(options.input, sourcePath);

  const events = [];
  const caller = makeClaudeSubscriptionCaller(options);
  const resourceLimits = createPdfTranslateResourceLimits({ apiConcurrency: 1, documentConcurrency: 1 });
  const result = await translateSinglePdf({
    pdfBuffer: fs.readFileSync(options.input),
    caller,
    gate: makeGate(1),
    progress: { addTotal() {}, tick() {} },
    onProgress(message) {
      events.push({ at: new Date().toISOString(), message });
      console.error(message);
    },
    resourceLimits,
  });
  fs.writeFileSync(outputPath, result.buffer);
  fs.writeFileSync(path.join(options.outputDir, "events.json"), JSON.stringify(events, null, 2));

  const verification = await runProcess(
    path.join(ROOT, ".venv", "bin", "python"),
    [
      path.join(ROOT, "scripts", "verify_translation.py"),
      outputPath,
      "--original", sourcePath,
      "--mode", "inplace",
      "--intent", "translate",
      "--json", verificationPath,
    ],
    { timeoutMs: 5 * 60 * 1000, allowNonzero: true },
  );
  fs.writeFileSync(path.join(options.outputDir, "verification.stdout.txt"), verification.stdout);
  fs.writeFileSync(path.join(options.outputDir, "verification.stderr.txt"), verification.stderr);
  const outputBuffer = fs.readFileSync(outputPath);
  const verificationBuffer = fs.existsSync(verificationPath)
    ? fs.readFileSync(verificationPath)
    : null;
  fs.writeFileSync(path.join(options.outputDir, "metadata.json"), JSON.stringify({
    model: options.model,
    input: options.input,
    output: outputPath,
    usage: result.usage,
    page_count: result.pageCount,
    block_count: result.blockCount,
    render_stats: result.stats,
    verification_passed: verification.code === 0,
    source_sha256: sha256(fs.readFileSync(sourcePath)),
    output_sha256: sha256(outputBuffer),
    verification_sha256: verificationBuffer ? sha256(verificationBuffer) : null,
    subscription_calls: caller.diagnostics,
  }, null, 2));
  if (verification.code !== 0) process.exitCode = 3;
  console.log(outputPath);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  buildTranslationSchema,
  makeClaudeSubscriptionCaller,
  parseArgs,
  requestedIds,
  runProcess,
};
