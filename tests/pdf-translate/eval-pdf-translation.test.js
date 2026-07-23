"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  SseParser,
  buildVerifierInvocation,
  cleanupExpiredRuns,
  consumeSse,
  inferEffectiveMode,
  main,
  normaliseBaseUrl,
  parseArgs,
  resolveEffectiveMode,
  runEvaluation,
  terminateProcessGroup,
  validateVerifierOutcome,
} = require("../../scripts/eval_pdf_translation");

const ROOT = path.resolve(__dirname, "../..");
const FAKE_PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n", "ascii");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-pdf-eval-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
}

async function startFakeTranslationServer(t, {
  mode = "retypeset",
  doneData = null,
  progressMode = mode,
  hangAuth = false,
  keepSseOpen = false,
} = {}) {
  const state = { uploadBody: null, sseClosed: false };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/healthz") {
      response.setHeader("content-type", "application/json");
      response.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/api/me") {
      if (hangAuth) return;
      response.setHeader("content-type", "application/json");
      response.end('{"authed":true,"gated":false,"configured":true}');
      return;
    }
    if (url.pathname === "/api/translate-pdf" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      state.uploadBody = Buffer.concat(chunks).toString("latin1");
      response.setHeader("content-type", "application/json");
      response.end('{"jobId":"fake-job-1"}');
      return;
    }
    if (url.pathname === "/api/jobs/fake-job-1/stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.write("event: progress\r\n");
      const progress = progressMode === "retypeset"
        ? "[00:00:01] 자동 변환방식 → 재조판(수식·정밀)"
        : "[00:00:01] 자동 변환방식 → 빠른 번역(레이아웃 유지)";
      response.write(`data: ${JSON.stringify(progress)}\r\n\r\n`);
      response.write("event: done\n");
      const payload = doneData || {
        filename: mode === "retypeset" ? "fixture_재조판.pdf" : "fixture_KO.pdf",
        effectiveMode: mode,
      };
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      response.once("close", () => { state.sseClosed = true; });
      if (!keepSseOpen) response.end();
      return;
    }
    if (url.pathname === "/api/jobs/fake-job-1/download") {
      response.writeHead(200, {
        "content-type": "application/pdf",
        "content-length": String(FAKE_PDF.length),
      });
      response.end(FAKE_PDF);
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}`, state };
}

test("parseArgs validates and resolves the public CLI arguments", () => {
  const parsed = parseArgs(
    [
      "--input", "fixtures/source.pdf",
      "--model", "gpt-5.4",
      "--mode", "inplace",
      "--output-dir", "artifacts/run-1",
      "--base-url", "http://localhost:4100/",
      "--auth-timeout-ms", "2000",
      "--verify-timeout-ms", "3000",
      "--deadline-ms", "9000",
      "--max-sse-events", "20",
      "--max-sse-bytes", "4096",
      "--retention-days", "7",
    ],
    { cwd: "/workspace", env: {} },
  );
  assert.equal(parsed.input, "/workspace/fixtures/source.pdf");
  assert.equal(parsed.outputDir, "/workspace/artifacts/run-1");
  assert.equal(parsed.model, "gpt-5.4");
  assert.equal(parsed.mode, "inplace");
  assert.equal(parsed.baseUrl, "http://localhost:4100");
  assert.equal(parsed.timeoutMs, 30 * 60 * 1000);
  assert.equal(parsed.authTimeoutMs, 2000);
  assert.equal(parsed.verifyTimeoutMs, 3000);
  assert.equal(parsed.deadlineMs, 9000);
  assert.equal(parsed.maxSseEvents, 20);
  assert.equal(parsed.maxSseBytes, 4096);
  assert.equal(parsed.retentionDays, 7);

  assert.throws(
    () => parseArgs(["--input", "x.pdf", "--mode", "guess"], { cwd: "/tmp", env: {} }),
    /Unsupported --mode/,
  );
  assert.throws(
    () => parseArgs(["--input", "x.pdf", "--model", "imaginary-model"], { cwd: "/tmp", env: {} }),
    /Unsupported --model/,
  );
  assert.throws(() => parseArgs([], { cwd: "/tmp", env: {} }), /--input/);
  assert.equal(normaliseBaseUrl("https://example.test/base/"), "https://example.test/base");
  assert.equal(normaliseBaseUrl("http://127.0.0.2:4100/"), "http://127.0.0.2:4100");
  assert.throws(
    () => normaliseBaseUrl("http://example.test/"),
    (error) => error.code === "INSECURE_BASE_URL",
  );
  const cleanup = parseArgs(["--cleanup-only", "--retention-days", "0"], {
    cwd: "/tmp",
    env: {},
  });
  assert.equal(cleanup.input, null);
  assert.equal(cleanup.cleanupOnly, true);
});

test("SseParser preserves UTF-8 and CRLF events across arbitrary byte chunks", () => {
  const source = Buffer.from(
    ': keepalive\r\nevent: progress\r\nid: 7\r\ndata: "번역 중"\r\n\r\n' +
      'event: done\ndata: {"filename":"결과_재조판.pdf"}\n\n',
    "utf8",
  );
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  for (let index = 0; index < source.length; index += 3) {
    parser.feed(source.subarray(index, index + 3));
  }
  parser.finish();
  assert.deepEqual(
    events.map(({ event, data, id }) => ({ event, data, id })),
    [
      { event: "progress", data: "번역 중", id: "7" },
      { event: "done", data: { filename: "결과_재조판.pdf" }, id: "7" },
    ],
  );
});

test("consumeSse supports async-iterable bodies and multi-line data", async () => {
  async function* body() {
    yield Buffer.from("event: note\ndata: first\n", "utf8");
    yield Buffer.from("data: second\n\n", "utf8");
  }
  const events = await consumeSse(body());
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "note");
  assert.equal(events[0].data, "first\nsecond");
});

test("consumeSse cancels immediately at terminal events and enforces byte/event limits", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from('event: done\ndata: {"effectiveMode":"inplace"}\n\n'));
    },
    cancel() { cancelled = true; },
  });
  const terminal = await consumeSse(body, {
    stopWhen: (event) => event.event === "done",
  });
  assert.equal(terminal.length, 1);
  assert.equal(cancelled, true);

  async function* threeEvents() {
    yield Buffer.from("data: 1\n\ndata: 2\n\ndata: 3\n\n");
  }
  await assert.rejects(
    consumeSse(threeEvents(), { maxEvents: 2 }),
    (error) => error.code === "SSE_EVENT_LIMIT_EXCEEDED",
  );
  await assert.rejects(
    consumeSse(threeEvents(), { maxBytes: 5 }),
    (error) => error.code === "SSE_BYTE_LIMIT_EXCEEDED",
  );
});

test("effective verification mode follows the server's terminal filename", () => {
  assert.equal(
    inferEffectiveMode("auto", { filename: "paper_재조판.pdf", effectiveMode: "retypeset" }),
    "retypeset",
  );
  assert.equal(
    inferEffectiveMode("auto", { filename: "paper_KO.pdf", effectiveMode: "inplace" }),
    "inplace",
  );
  assert.throws(() => inferEffectiveMode("auto", {}, []), /missing a valid effectiveMode/);
  assert.throws(
    () => resolveEffectiveMode({ filename: "paper_KO.pdf", effectiveMode: "retypeset" }),
    (error) => error.code === "EFFECTIVE_MODE_CONFLICT",
  );
  assert.throws(
    () => resolveEffectiveMode(
      { filename: "paper_재조판.pdf", effectiveMode: "retypeset" },
      [{ event: "progress", data: "자동 변환방식 → 빠른 번역(레이아웃 유지)" }],
    ),
    (error) => error.code === "EFFECTIVE_MODE_CONFLICT",
  );
  assert.throws(
    () => resolveEffectiveMode("paper_KO.pdf"),
    (error) => error.code === "INVALID_DONE_PAYLOAD",
  );
});

test("verifier invocation always compares output with source using effective mode", () => {
  const invocation = buildVerifierInvocation({
    translated: "/tmp/output.pdf",
    original: "/tmp/source.pdf",
    jsonPath: "/tmp/verification.json",
    mode: "retypeset",
    repoRoot: ROOT,
    env: { PYTHON_BIN: "/custom/python" },
  });
  assert.equal(invocation.command, "/custom/python");
  assert.deepEqual(invocation.args, [
    path.join(ROOT, "scripts", "verify_translation.py"),
    "/tmp/output.pdf",
    "--original", "/tmp/source.pdf",
    "--json", "/tmp/verification.json",
    "--mode", "retypeset",
  ]);
});

test("verifier process exit and report contract must agree completely", () => {
  assert.equal(validateVerifierOutcome(0, {
    passed: true, exit_code: 0, hard_failures: [],
  }).valid, true);
  assert.equal(validateVerifierOutcome(1, {
    passed: false, exit_code: 1, hard_failures: ["page_correspondence"],
  }).valid, true);
  assert.equal(validateVerifierOutcome(2, {
    passed: false, exit_code: 2, hard_failures: ["internal_error"],
  }).valid, true);

  for (const [processExit, report] of [
    [0, { passed: false, exit_code: 0, hard_failures: ["x"] }],
    [1, { passed: false, exit_code: 0, hard_failures: ["x"] }],
    [1, { passed: false, exit_code: 1, hard_failures: [] }],
    [2, { passed: true, exit_code: 2, hard_failures: [] }],
  ]) {
    const result = validateVerifierOutcome(processExit, report);
    assert.equal(result.valid, false);
    assert.equal(result.expectedExitCode, 2);
  }
});

test("fake HTTP end-to-end run stores source/output/events/metadata and verification", async (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, "fixture.pdf");
  const outputDir = path.join(directory, "eval-output");
  fs.writeFileSync(input, FAKE_PDF);
  const fake = await startFakeTranslationServer(t, { keepSseOpen: true });
  let verifierOptions = null;
  const fetchOptions = [];

  const result = await runEvaluation(
    {
      input,
      outputDir,
      baseUrl: fake.baseUrl,
      accessCode: "",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 5_000,
      repoRoot: ROOT,
      runId: "fake-run",
    },
    {
      quiet: true,
      fetchImpl: (url, options = {}) => {
        fetchOptions.push({ url: String(url), redirect: options.redirect });
        return fetch(url, options);
      },
      verifierRunner: async (options) => {
        verifierOptions = options;
        return {
          exitCode: 0,
          signal: null,
          stdout: "fake verifier passed",
          stderr: "",
          report: { passed: true, hard_failures: [], exit_code: 0 },
        };
      },
    },
  );

  assert.equal(result.outputDir, outputDir);
  for (const filename of [
    "source.pdf",
    "output.pdf",
    "events.jsonl",
    "run.log",
    "metadata.json",
    "verification.json",
  ]) {
    assert.equal(fs.existsSync(path.join(outputDir, filename)), true, filename);
  }
  assert.deepEqual(fs.readFileSync(path.join(outputDir, "source.pdf")), FAKE_PDF);
  assert.deepEqual(fs.readFileSync(path.join(outputDir, "output.pdf")), FAKE_PDF);
  assert.equal(verifierOptions.mode, "retypeset");
  assert.equal(verifierOptions.original, path.join(outputDir, "source.pdf"));
  assert.equal(verifierOptions.translated, path.join(outputDir, "output.pdf"));

  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "passed");
  assert.equal(metadata.model, "gpt-5.4-mini");
  assert.equal(metadata.mode.requested, "auto");
  assert.equal(metadata.mode.effective, "retypeset");
  assert.equal(metadata.mode.verification, "retypeset");
  assert.equal(metadata.mode.signals.explicit, "retypeset");
  assert.equal(metadata.sizeBytes.source, FAKE_PDF.length);
  assert.equal(metadata.sizeBytes.output, FAKE_PDF.length);
  assert.equal(metadata.job.id, "fake-job-1");
  assert.equal(metadata.job.terminalEvent, "done");
  assert.deepEqual(metadata.job.events.map((event) => event.event), ["progress", "done"]);
  assert.equal(metadata.verification.passed, true);
  assert.equal(metadata.verification.processExitCode, 0);
  assert.equal(metadata.verification.contractValid, true);
  assert.equal(Number.isInteger(metadata.durationMs), true);
  assert.equal(fake.state.sseClosed, true);
  assert.equal(fetchOptions.length >= 5, true);
  assert.equal(fetchOptions.every((item) => item.redirect === "error"), true);
  assert.equal(fs.statSync(outputDir).mode & 0o777, 0o700);
  for (const filename of [
    "source.pdf", "output.pdf", "events.jsonl", "run.log", "metadata.json", "verification.json",
  ]) {
    assert.equal(fs.statSync(path.join(outputDir, filename)).mode & 0o777, 0o600, filename);
  }
  assert.match(fake.state.uploadBody, /name="model"\r\n\r\ngpt-5\.4-mini/);
  assert.match(fake.state.uploadBody, /name="mode"\r\n\r\nauto/);
});

test("the CLI returns failure when strict verification fails and retains artifacts", async (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, "fixture.pdf");
  const outputDir = path.join(directory, "failed-eval");
  fs.writeFileSync(input, FAKE_PDF);
  const fake = await startFakeTranslationServer(t, { mode: "inplace" });

  const sink = { write() {} };
  const exitCode = await main(
    [
      "--input", input,
      "--output-dir", outputDir,
      "--base-url", fake.baseUrl,
      "--model", "gpt-5.4-mini",
      "--mode", "inplace",
      "--timeout-ms", "5000",
    ],
    {
      quiet: true,
      stdout: sink,
      stderr: sink,
      verifierRunner: async () => ({
        exitCode: 1,
        signal: null,
        stdout: "fake verifier failed",
        stderr: "",
        report: { passed: false, hard_failures: ["page_correspondence"], exit_code: 1 },
      }),
    },
  );
  assert.equal(exitCode, 1);
  const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "verification_failed");
  assert.equal(metadata.verification.processExitCode, 1);
  assert.equal(metadata.verification.reportExitCode, 1);
  assert.deepEqual(metadata.verification.hardFailures, ["page_correspondence"]);
  assert.equal(fs.existsSync(path.join(outputDir, "output.pdf")), true);
  assert.equal(fs.existsSync(path.join(outputDir, "verification.json")), true);
});

test("verifier internal exit 2 and process/report mismatches propagate as CLI exit 2", async (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, "fixture.pdf");
  fs.writeFileSync(input, FAKE_PDF);
  const fake = await startFakeTranslationServer(t, { mode: "inplace" });
  const sink = { write() {} };

  const run = async (name, verifierRunner) => {
    const outputDir = path.join(directory, name);
    const exitCode = await main(
      [
        "--input", input,
        "--output-dir", outputDir,
        "--base-url", fake.baseUrl,
        "--model", "gpt-5.4-mini",
        "--mode", "inplace",
      ],
      { quiet: true, stdout: sink, stderr: sink, verifierRunner },
    );
    return {
      exitCode,
      metadata: JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8")),
    };
  };

  const internal = await run("internal", async () => ({
    exitCode: 2,
    signal: null,
    stdout: "",
    stderr: "internal",
    report: { passed: false, hard_failures: ["internal_error"], exit_code: 2 },
  }));
  assert.equal(internal.exitCode, 2);
  assert.equal(internal.metadata.status, "verifier_internal_error");
  assert.equal(internal.metadata.verification.contractValid, true);

  const mismatch = await run("mismatch", async () => ({
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    report: { passed: false, hard_failures: ["page_correspondence"], exit_code: 1 },
  }));
  assert.equal(mismatch.exitCode, 2);
  assert.equal(mismatch.metadata.status, "verifier_contract_failed");
  assert.equal(mismatch.metadata.verification.contractValid, false);
});

test("authentication, verification, and whole-run deadlines fail closed", async (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, "fixture.pdf");
  fs.writeFileSync(input, FAKE_PDF);

  const authServer = await startFakeTranslationServer(t, { hangAuth: true });
  const authOutput = path.join(directory, "auth-timeout");
  await assert.rejects(
    runEvaluation({
      input,
      outputDir: authOutput,
      baseUrl: authServer.baseUrl,
      accessCode: "",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 1_000,
      authTimeoutMs: 40,
      verifyTimeoutMs: 1_000,
      deadlineMs: 1_000,
      repoRoot: ROOT,
    }, { quiet: true }),
    (error) => error.code === "AUTH_TIMEOUT",
  );

  const fake = await startFakeTranslationServer(t);
  const verifyOutput = path.join(directory, "verify-timeout");
  await assert.rejects(
    runEvaluation({
      input,
      outputDir: verifyOutput,
      baseUrl: fake.baseUrl,
      accessCode: "",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 1_000,
      authTimeoutMs: 1_000,
      verifyTimeoutMs: 40,
      deadlineMs: 1_000,
      repoRoot: ROOT,
    }, {
      quiet: true,
      verifierRunner: () => new Promise(() => {}),
    }),
    (error) => error.code === "VERIFIER_TIMEOUT" && error.exitCode === 2,
  );
  const timeoutReport = JSON.parse(
    fs.readFileSync(path.join(verifyOutput, "verification.json"), "utf8"),
  );
  assert.equal(timeoutReport.exit_code, 2);
  assert.equal(timeoutReport.passed, false);

  const overallOutput = path.join(directory, "overall-timeout");
  await assert.rejects(
    runEvaluation({
      input,
      outputDir: overallOutput,
      baseUrl: fake.baseUrl,
      accessCode: "",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 1_000,
      authTimeoutMs: 1_000,
      verifyTimeoutMs: 1_000,
      deadlineMs: 40,
      repoRoot: ROOT,
    }, {
      quiet: true,
      verifierRunner: () => new Promise(() => {}),
    }),
    (error) => error.code === "OVERALL_DEADLINE_EXCEEDED" && error.exitCode === 2,
  );
});

test("output directory and artifact symlinks are rejected without overwrite", async (t) => {
  const directory = temporaryDirectory(t);
  const input = path.join(directory, "fixture.pdf");
  const outside = path.join(directory, "outside");
  const sentinel = path.join(directory, "sentinel.txt");
  fs.writeFileSync(input, FAKE_PDF);
  fs.mkdirSync(outside, { mode: 0o700 });
  fs.writeFileSync(sentinel, "untouched");

  const linkedOutput = path.join(directory, "linked-output");
  fs.symlinkSync(outside, linkedOutput);
  await assert.rejects(
    runEvaluation({
      input,
      outputDir: linkedOutput,
      baseUrl: "http://127.0.0.1:9",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 1_000,
      repoRoot: ROOT,
    }, { quiet: true }),
    (error) => error.code === "UNSAFE_OUTPUT_DIR",
  );

  const artifactOutput = path.join(directory, "artifact-output");
  fs.mkdirSync(artifactOutput, { mode: 0o700 });
  fs.symlinkSync(sentinel, path.join(artifactOutput, "source.pdf"));
  await assert.rejects(
    runEvaluation({
      input,
      outputDir: artifactOutput,
      baseUrl: "http://127.0.0.1:9",
      model: "gpt-5.4-mini",
      mode: "auto",
      timeoutMs: 1_000,
      repoRoot: ROOT,
    }, { quiet: true }),
    (error) => error.code === "UNSAFE_ARTIFACT_PATH",
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "untouched");
});

test("retention cleanup removes only expired real run directories", (t) => {
  const directory = temporaryDirectory(t);
  const root = path.join(directory, "evals");
  const outside = path.join(directory, "outside");
  const oldRun = path.join(root, "20200101T000000Z-aaaaaa");
  const newRun = path.join(root, "20990101T000000Z-bbbbbb");
  const linkedRun = path.join(root, "20200101T000001Z-cccccc");
  fs.mkdirSync(oldRun, { recursive: true });
  fs.mkdirSync(newRun, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, linkedRun);
  const old = new Date("2020-01-01T00:00:00Z");
  const recent = new Date("2026-07-10T00:00:00Z");
  fs.utimesSync(oldRun, old, old);
  fs.utimesSync(newRun, recent, recent);

  const result = cleanupExpiredRuns(root, {
    retentionDays: 7,
    now: Date.parse("2026-07-10T12:00:00Z"),
  });
  assert.deepEqual(result.removed, [path.basename(oldRun)]);
  assert.equal(fs.existsSync(oldRun), false);
  assert.equal(fs.existsSync(newRun), true);
  assert.equal(fs.lstatSync(linkedRun).isSymbolicLink(), true);
  assert.equal(fs.existsSync(outside), true);
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /^\/output\/$/m);
});

test("managed process groups escalate from TERM to KILL", async (t) => {
  if (process.platform === "win32") return;
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM',()=>{}); process.send?.('ready'); setInterval(()=>{},1000)",
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  });
  await new Promise((resolve) => child.once("spawn", resolve));
  // Under the full parallel suite the child may be spawned before its JS has
  // installed the SIGTERM handler. Wait for an explicit readiness handshake so
  // this test measures TERM→KILL escalation rather than process startup timing.
  await new Promise((resolve) => child.once("message", resolve));
  let exitSignal = null;
  child.once("exit", (_code, signal) => { exitSignal = signal; });
  await terminateProcessGroup(child, { graceMs: 30 });
  assert.equal(exitSignal, "SIGKILL");
});
