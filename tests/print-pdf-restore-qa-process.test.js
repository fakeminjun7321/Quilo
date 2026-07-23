"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getEventListeners } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const {
  _runProcess: runProcess,
  _tesseractText: tesseractText,
} = require("../lib/pipelines/print-pdf-restore/qa");

function makeSleepingBinary(root) {
  const file = path.join(root, "fake-tesseract");
  fs.writeFileSync(file, "#!/bin/sh\nsleep 10\n", { mode: 0o755 });
  return file;
}

test("runProcess removes its abort listener after normal close", async () => {
  const controller = new AbortController();
  await runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], {
    signal: controller.signal,
    timeout: 5000,
  });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("Tesseract helper forwards AbortSignal and detaches after cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "print-qa-abort-test-"));
  const fakeTesseract = makeSleepingBinary(root);
  const controller = new AbortController();
  const startedAt = Date.now();
  try {
    const png = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "white",
      },
    }).png().toBuffer();
    const pending = tesseractText(
      png,
      fakeTesseract,
      root,
      "source",
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /프로세스 실패/);
    assert.ok(Date.now() - startedAt < 3000, "cancellation should not wait for OCR timeout");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
