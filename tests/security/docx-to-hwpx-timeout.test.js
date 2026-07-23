const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

test("DOCX to HWPX converter enforces subprocess timeout", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d2h-timeout-test-"));
  const fakePython = path.join(tmp, "python3");
  fs.writeFileSync(
    fakePython,
    "#!/usr/bin/env sh\nsleep 10\n",
    { mode: 0o755 },
  );
  const oldPython = process.env.PYTHON_BIN;
  process.env.PYTHON_BIN = fakePython;
  delete require.cache[require.resolve("../../lib/pipelines/docx-to-hwpx")];
  const { convertDocxToHwpx } = require("../../lib/pipelines/docx-to-hwpx");
  try {
    await assert.rejects(
      () => convertDocxToHwpx(Buffer.from("PK\x03\x04"), { timeoutMs: 100 }),
      /제한 시간/,
    );
  } finally {
    if (oldPython == null) delete process.env.PYTHON_BIN;
    else process.env.PYTHON_BIN = oldPython;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
