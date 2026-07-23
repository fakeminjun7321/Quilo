const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const {
  assertGeneratedOutputMagic,
  assertCompletePdf,
  normalizeGeneratedArtifact,
  validateReportArtifact,
} = require("../lib/output-validate");
const {
  getDefaultModel,
} = require("../lib/pipelines/print-pdf-restore");
const { isolatedServerEnv } = require("./QA/support/isolated-server-env");

const ROOT = path.resolve(__dirname, "..");

function minimalPdf(extra = "") {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n${extra}\ntrailer\n<<>>\n%%EOF\n`,
    "latin1",
  );
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(origin, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`server exited with ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch (_) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server did not become healthy");
}

function printRestoreForm(model = "") {
  const form = new FormData();
  form.append("type", "print-pdf-restore");
  form.append("copyrightAccepted", "true");
  form.append("academicIntegrityAccepted", "true");
  if (model) form.append("model", model);
  // Valid 1x1 PNG. The provider gate runs before asynchronous image analysis.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  form.append("photos", new Blob([png], { type: "image/png" }), "page.png");
  return form;
}

test("legacy PDF magic stays compatible while restored artifacts require EOF", () => {
  const valid = minimalPdf();
  assert.equal(assertGeneratedOutputMagic(valid, "pdf"), valid);
  assert.throws(
    () => assertGeneratedOutputMagic(Buffer.from("not-a-pdf"), "pdf"),
    /expected PDF output to start with %PDF-/,
  );
  assert.doesNotThrow(() =>
    assertGeneratedOutputMagic(Buffer.from("%PDF-1.4\nlegacy-fixture"), "pdf"),
  );
  assert.throws(
    () => assertCompletePdf(Buffer.from("%PDF-1.4\ntruncated")),
    /missing a trailing %%EOF marker/,
  );
});

test("PDF artifact normalization forces safe filename and MIME type", () => {
  const result = normalizeGeneratedArtifact(
    {
      buffer: minimalPdf(),
      filename: "../../복원본\r\nContent-Type: text/html.docx",
      mimeType: "text/html",
      qa: { ok: true, ocrPages: 2 },
    },
    { kind: "pdf", fallbackFilename: "fallback.pdf" },
  );
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.filename, "html.pdf");
  assert.doesNotMatch(result.filename, /[\\/\r\n:]/);
  assert.deepEqual(result.qa, { ok: true, ocrPages: 2 });
  assert.equal(result.buffer.subarray(0, 5).toString("latin1"), "%PDF-");
});

test("raw PDF buffers use the server fallback filename", () => {
  const result = normalizeGeneratedArtifact(minimalPdf(), {
    kind: "pdf",
    fallbackFilename: "프린트복원_현대물리학.pdf",
  });
  assert.equal(result.filename, "프린트복원_현대물리학.pdf");
  assert.equal(result.qa, null);
});

test("deep artifact validation reports malformed PDF without throwing", async () => {
  const check = await validateReportArtifact(Buffer.from("%PDF-1.4\ntruncated"), {
    format: "pdf",
    type: "print-pdf-restore",
  });
  assert.equal(check.ok, false);
  assert.equal(check.problems[0].rule, "pdf-structure");
});

test("server contract keeps print restoration admin-only with fixed PDF output", () => {
  const source = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.match(source, /"print-pdf-restore"\s*:\s*\{/);
  assert.match(source, /const ADMIN_ONLY_REPORT_TYPES = new Set\(\["print-pdf-restore"\]\)/);
  assert.match(source, /outputKind:\s*"pdf"/);
  assert.match(source, /requireArtifactQa:\s*true/);
  assert.match(source, /pipeline\.outputKind === "pdf"[\s\S]{0,120}\? "pdf"/);
  assert.match(source, /typeof pipeline\.generatePdf !== "function"/);
  assert.match(source, /restoreQa\.visualPassed === true/);
  assert.match(source, /restoreQa\.renderedDpi === 300/);
  assert.match(source, /restoreQa\.pageCount === expectedRestorePages/);
  assert.match(source, /Number\.isFinite\(restoreQa\.ocrCoverage\)/);
  assert.match(source, /isAdmin = !!freshUser\.is_admin/);
  assert.match(source, /req\.session\.userInfo\.isAdmin = isAdmin/);
  assert.match(source, /const reportEligible = isAdmin \|\| \(emailVerified && approved\)/);
});
test("print restoration validates configured defaults and never enables Gemini", () => {
  const allowed = [
    "claude-opus-4-8",
    "claude-sonnet-5",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
  ];

  assert.equal(
    getDefaultModel({ PRINT_RESTORE_MODEL: "gpt-5.4", DEFAULT_MODEL: "claude-sonnet-5" }, allowed),
    "gpt-5.4",
    "pipeline-specific configuration has priority over DEFAULT_MODEL",
  );
  assert.equal(
    getDefaultModel({ DEFAULT_MODEL: "claude-sonnet-5" }, allowed),
    "claude-sonnet-5",
  );
  for (const invalid of ["gemini-3.1-pro", "gemini-2.5-flash", "unknown-model", ""]) {
    assert.equal(
      getDefaultModel({ PRINT_RESTORE_MODEL: invalid }, allowed),
      "claude-opus-4-8",
      `${invalid || "empty config"} must fail closed to Opus`,
    );
  }
  assert.equal(
    getDefaultModel({ PRINT_RESTORE_MODEL: "claude-fable-5" }, allowed),
    "claude-opus-4-8",
    "a model excluded by the current server policy cannot be restored through env configuration",
  );
});

test("server defaults only blank requests and never silently replaces explicit models", () => {
  const source = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const requested = source.indexOf("const requestedModel =");
  const configured = source.indexOf('typeof pipeline.defaultModel === "function"', requested);
  const resolved = source.indexOf("resolveRequestedReportModel({", configured);
  const restricted = source.indexOf("if (effectiveRestrictedModel)", resolved);

  assert.ok(requested >= 0);
  assert.ok(configured > requested);
  assert.ok(resolved > configured);
  assert.ok(restricted > resolved);
  assert.match(source, /defaultModel:\s*require\("\.\/lib\/pipelines\/print-pdf-restore"\)\.getDefaultModel/);
  assert.match(source, /pipeline\.defaultModel\(process\.env, allowedModels\)/);
  assert.match(source, /if \(requestedModel && !usable\.includes\(model\)\) \{[\s\S]{0,120}status\(403\)/);
});

test("print restoration reports missing providers and rejects an explicit unknown model", { timeout: 30_000 }, async (t) => {
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: isolatedServerEnv({
      PORT: String(port),
      DEV_FAKE_AUTH: "1",
      SESSION_SECRET: "print-restore-model-default-test-secret",
      PRINT_RESTORE_MODEL: "gpt-5.4",
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString().slice(0, 4_000);
  });
  t.after(() => {
    if (child.exitCode == null) child.kill();
  });

  await waitForHealth(origin, child);
  const configuredResponse = await fetch(`${origin}/api/generate`, {
    method: "POST",
    body: printRestoreForm(),
  });
  assert.equal(configuredResponse.status, 503, stderr);
  assert.match((await configuredResponse.json()).error, /GPT 모델.*사용할 수 없습니다/);

  const explicitResponse = await fetch(`${origin}/api/generate`, {
    method: "POST",
    body: printRestoreForm("claude-opus-4-8"),
  });
  assert.equal(explicitResponse.status, 503, stderr);
  assert.match((await explicitResponse.json()).error, /Claude 모델.*사용할 수 없습니다/);

  const unknownResponse = await fetch(`${origin}/api/generate`, {
    method: "POST",
    body: printRestoreForm("not-a-real-model"),
  });
  assert.equal(unknownResponse.status, 400, stderr);
  assert.match((await unknownResponse.json()).error, /요청한 AI 모델/);
});
