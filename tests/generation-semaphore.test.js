"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { GenerationSemaphore } = require("../lib/generation-semaphore");

test("a queued generation aborts immediately and is removed from the FIFO", async () => {
  const gate = new GenerationSemaphore(1);
  await gate.acquire();
  const controller = new AbortController();
  const queued = gate.acquire({ signal: controller.signal });
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 1);

  controller.abort();
  await assert.rejects(queued, { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 0);

  gate.release();
  assert.equal(gate.active, 0);
});

test("release transfers one permit to the next non-aborted waiter", async () => {
  const gate = new GenerationSemaphore(1);
  await gate.acquire();
  let secondStarted = false;
  const second = gate.acquire().then(() => { secondStarted = true; });
  assert.equal(gate.waiting, 1);
  gate.release();
  await second;
  assert.equal(secondStarted, true);
  assert.equal(gate.active, 1);
  assert.equal(gate.waiting, 0);
  gate.release();
  assert.equal(gate.active, 0);
});

test("an already aborted request never consumes a permit", async () => {
  const gate = new GenerationSemaphore(2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    gate.acquire({ signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(gate.active, 0);
  assert.equal(gate.waiting, 0);
});

test("a full queue rejects immediately without retaining another waiter", async () => {
  const gate = new GenerationSemaphore(1, { maxQueue: 1, waitTimeoutMs: 1000 });
  await gate.acquire();
  const queued = gate.acquire();
  await assert.rejects(
    gate.acquire(),
    { name: "GenerationQueueError", code: "GENERATION_QUEUE_FULL", status: 503 },
  );
  assert.equal(gate.waiting, 1);
  gate.release();
  await queued;
  gate.release();
});

test("a queued generation times out and is removed", async () => {
  const gate = new GenerationSemaphore(1, { maxQueue: 2, waitTimeoutMs: 20 });
  await gate.acquire();
  const queued = gate.acquire();
  await assert.rejects(
    queued,
    { name: "GenerationQueueError", code: "GENERATION_QUEUE_TIMEOUT", status: 503 },
  );
  assert.equal(gate.waiting, 0);
  assert.equal(gate.active, 1);
  gate.release();
});
