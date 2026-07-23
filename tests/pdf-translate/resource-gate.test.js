"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  DEFAULT_GLOBAL_API_CONCURRENCY,
  DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY,
  createFifoSemaphore,
  createPdfTranslateResourceLimits,
} = require("../../lib/pipelines/pdf-translate/resource-gate");
const {
  makeGate,
  translateBlocksWithRetries,
  translateSinglePdf,
} = require("../../lib/pipelines/pdf-translate/translate");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("FIFO semaphore preserves waiter order without starvation", async () => {
  const semaphore = createFifoSemaphore(1);
  const releaseFirst = deferred();
  const started = [];

  const first = semaphore.run(async () => {
    started.push(1);
    await releaseFirst.promise;
    return 1;
  });
  const second = semaphore.run(async () => {
    started.push(2);
    return 2;
  });
  const third = semaphore.run(async () => {
    started.push(3);
    return 3;
  });

  await nextTurn();
  assert.deepEqual(started, [1]);
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 1, queued: 2 });

  releaseFirst.resolve();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 3]);
  assert.deepEqual(started, [1, 2, 3]);
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 0, queued: 0 });
});

test("queued abort is removed and rejected before the active task finishes", async () => {
  const semaphore = createFifoSemaphore(1);
  const releaseFirst = deferred();
  const controller = new AbortController();
  const started = [];

  const first = semaphore.run(async () => {
    started.push("first");
    await releaseFirst.promise;
  });
  const cancelled = semaphore.run(async () => {
    started.push("cancelled");
  }, { signal: controller.signal });
  const third = semaphore.run(async () => {
    started.push("third");
  });

  await nextTurn();
  controller.abort();
  await assert.rejects(
    cancelled,
    (error) => error.name === "AbortError" && error.code === "ABORT_ERR",
  );
  assert.deepEqual(started, ["first"]);
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 1, queued: 1 });

  releaseFirst.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(started, ["first", "third"]);
});

test("synchronous throw and rejection always release their permits", async () => {
  const semaphore = createFifoSemaphore(1);
  const order = [];

  const failed = semaphore.run(() => {
    order.push("failed");
    throw new Error("boom");
  });
  const next = semaphore.run(async () => {
    order.push("next");
    return "ok";
  });

  await assert.rejects(failed, /boom/);
  assert.equal(await next, "ok");
  assert.deepEqual(order, ["failed", "next"]);
  assert.equal(semaphore.stats().active, 0);
});

test("resource factory safely falls back for malformed env and accepts valid overrides", () => {
  const malformed = createPdfTranslateResourceLimits({
    env: {
      PDF_TRANSLATE_GLOBAL_API_CONCURRENCY: "12workers",
      PDF_TRANSLATE_GLOBAL_DOCUMENT_CONCURRENCY: "0",
    },
  });
  assert.equal(malformed.apiConcurrency, DEFAULT_GLOBAL_API_CONCURRENCY);
  assert.equal(
    malformed.documentConcurrency,
    DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY,
  );

  const valid = createPdfTranslateResourceLimits({
    env: {
      PDF_TRANSLATE_GLOBAL_API_CONCURRENCY: "3",
      PDF_TRANSLATE_GLOBAL_DOCUMENT_CONCURRENCY: "1",
    },
  });
  assert.equal(valid.apiConcurrency, 3);
  assert.equal(valid.documentConcurrency, 1);

  const explicitMalformed = createPdfTranslateResourceLimits({
    env: {
      PDF_TRANSLATE_GLOBAL_API_CONCURRENCY: "4",
      PDF_TRANSLATE_GLOBAL_DOCUMENT_CONCURRENCY: "4",
    },
    apiConcurrency: Number.NaN,
    documentConcurrency: -2,
  });
  assert.equal(explicitMalformed.apiConcurrency, DEFAULT_GLOBAL_API_CONCURRENCY);
  assert.equal(
    explicitMalformed.documentConcurrency,
    DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY,
  );
});

test("concurrent translation jobs share one global provider-call ceiling", async () => {
  const resourceLimits = createPdfTranslateResourceLimits({
    apiConcurrency: 2,
    documentConcurrency: 4,
    env: {},
  });
  let active = 0;
  let maxActive = 0;
  let callCount = 0;

  const caller = async ({ user }) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    callCount += 1;
    try {
      await delay(12);
      const marker = user.lastIndexOf("\n\n");
      const items = JSON.parse(user.slice(marker + 2));
      const translated = {};
      for (const item of items) translated[item.id] = `샘플은 ${item.id}개입니다.`;
      return { text: JSON.stringify({ t: translated }), usage: {} };
    } finally {
      active -= 1;
    }
  };

  const makeBlocks = (offset) => Array.from({ length: 4 }, (_, index) => {
    const id = offset + index + 1;
    return { id, text: `There are ${id} samples.` };
  });
  const runJob = (offset) => translateBlocksWithRetries({
    blocks: makeBlocks(offset),
    caller,
    gate: makeGate(12),
    batchChars: 1,
    retrySizes: [],
    verbose: false,
    resourceLimits,
  });

  const results = await Promise.all([runJob(0), runJob(100)]);
  assert.equal(callCount, 8);
  assert.equal(maxActive, 2);
  assert.equal(Object.keys(results[0].translations).length, 4);
  assert.equal(Object.keys(results[1].translations).length, 4);
  assert.deepEqual(resourceLimits.stats().api, {
    capacity: 2,
    active: 0,
    queued: 0,
  });
});

test("translated document jobs share the global heavy-pipeline ceiling", async () => {
  const resourceLimits = createPdfTranslateResourceLimits({
    apiConcurrency: 8,
    documentConcurrency: 2,
    env: {},
  });
  let activeDocuments = 0;
  let maxActiveDocuments = 0;

  const fakePdfTool = {
    async extractBlocks() {
      activeDocuments += 1;
      maxActiveDocuments = Math.max(maxActiveDocuments, activeDocuments);
      await delay(8);
      return {
        page_count: 1,
        scanned: false,
        blocks: [{ id: 1, text: "There are 42 samples." }],
        fig_regions: 0,
        fitz: "fake",
      };
    },
    async renderTranslated(_inPath, outPath) {
      try {
        await delay(8);
        fs.writeFileSync(outPath, Buffer.from("%PDF-fake", "ascii"));
        return {
          ok: true,
          replaced: 1,
          drawn: 1,
          shrunk: 0,
          overflow: 0,
          failed: 0,
          overflow_ids: [],
          failed_ids: [],
          min_font: 10,
          min_glyph_font: 10,
          font_sizes: [{ id: 1, source: 10, rendered: 10, min_glyph: 10 }],
        };
      } finally {
        activeDocuments -= 1;
      }
    },
  };
  const caller = async () => ({
    text: JSON.stringify({ t: { 1: "샘플은 42개입니다." } }),
    usage: {},
  });

  const jobs = Array.from({ length: 5 }, () => translateSinglePdf({
    pdfBuffer: Buffer.from("%PDF-input", "ascii"),
    caller,
    gate: makeGate(12),
    progress: { addTotal() {}, tick() {} },
    verbose: false,
    resourceLimits,
    pdfTool: fakePdfTool,
  }));
  const results = await Promise.all(jobs);

  assert.equal(maxActiveDocuments, 2);
  assert.equal(activeDocuments, 0);
  assert.equal(results.length, 5);
  assert.ok(results.every((result) => result.buffer.toString("ascii") === "%PDF-fake"));
  assert.deepEqual(resourceLimits.stats().document, {
    capacity: 2,
    active: 0,
    queued: 0,
  });
});
