"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");

const createVibeRouter = require("../lib/vibe-routes");

function createLedger(initialCredits = 1) {
  let balance = initialCredits;
  const reservations = new Map();
  const jobIds = [];
  const calls = { reserve: 0, settle: 0, refund: 0 };
  return {
    calls,
    jobIds,
    balance: () => balance,
    supa: {
      isEnabled: () => true,
      getUserApiKeys: async () => [],
      getCredits: async () => balance,
      reserveCredits: async (_userId, amount, { jobId }) => {
        calls.reserve += 1;
        jobIds.push(jobId);
        if (balance < amount) {
          return { ok: false, newBalance: null, atomic: true };
        }
        balance -= amount;
        reservations.set(jobId, { amount, status: "reserved" });
        return { ok: true, newBalance: balance, atomic: true, durable: true };
      },
      settleCreditReservation: async (jobId, spent) => {
        calls.settle += 1;
        const reservation = reservations.get(jobId);
        assert.ok(reservation, "settlement must use the reserved job id");
        assert.equal(spent, reservation.amount);
        reservation.status = "settled";
        return {
          status: "settled",
          changed: true,
          newBalance: balance,
        };
      },
      refundCreditReservation: async (jobId) => {
        calls.refund += 1;
        const reservation = reservations.get(jobId);
        assert.ok(reservation, "refund must use the reserved job id");
        if (reservation.status === "reserved") {
          balance += reservation.amount;
          reservation.status = "refunded";
          return {
            status: "refunded",
            refunded: true,
            newBalance: balance,
          };
        }
        return {
          status: reservation.status,
          alreadySettled: reservation.status === "settled",
          refunded: reservation.status === "refunded",
          newBalance: balance,
        };
      },
    },
  };
}

async function startVibeRouter(t, {
  supa,
  user = { id: "user-1", isAdmin: false, unlimited: false },
  generateImage = async () => Buffer.from("png"),
  imageConcurrencyLimit = 2,
  creditFlowOptions = { attempts: 1, baseDelayMs: 0 },
} = {}) {
  const app = express();
  app.use(express.json());
  app.use("/api/vibe", createVibeRouter({
    requireAuth: (_req, _res, next) => next(),
    requirePro: (_req, _res, next) => next(),
    getSessionUser: () => user,
    refreshSessionUser: async () => user,
    supa,
    pricing: { getModelCredits: () => 1 },
    generateImage,
    imageKeyAvailable: () => true,
    imageConcurrencyLimit,
    creditFlowOptions,
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function postImage(origin, prompt = "a useful app concept") {
  const response = await fetch(`${origin}/api/vibe/image`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  return { status: response.status, body: await response.json() };
}

test("concurrent one-credit Vibe image requests generate and settle only once", async (t) => {
  const ledger = createLedger(1);
  let releaseImage;
  let imageStarted;
  const started = new Promise((resolve) => { imageStarted = resolve; });
  const release = new Promise((resolve) => { releaseImage = resolve; });
  let generated = 0;
  const origin = await startVibeRouter(t, {
    supa: ledger.supa,
    imageConcurrencyLimit: 2,
    generateImage: async () => {
      generated += 1;
      imageStarted();
      await release;
      return Buffer.from("paid-image");
    },
  });

  const firstRequest = postImage(origin);
  await started;
  const second = await postImage(origin);
  assert.equal(second.status, 402);
  assert.match(second.body.error, /크레딧 부족/);

  releaseImage();
  const first = await firstRequest;
  assert.equal(first.status, 200);
  assert.equal(first.body.creditsCharged, 1);
  assert.match(first.body.dataUrl, /^data:image\/png;base64,/);
  assert.equal(generated, 1);
  assert.deepEqual(ledger.calls, { reserve: 2, settle: 1, refund: 0 });
  assert.equal(new Set(ledger.jobIds).size, 2, "every request must reserve with a unique job id");
  assert.ok(ledger.jobIds.every((id) => /^vibe-image-[a-f0-9]{24}$/.test(id)));
  assert.equal(ledger.balance(), 0);
});

test("per-user image concurrency cap rejects overlap and releases after completion", async (t) => {
  const ledger = createLedger(2);
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  let generated = 0;
  const origin = await startVibeRouter(t, {
    supa: ledger.supa,
    imageConcurrencyLimit: 1,
    generateImage: async () => {
      generated += 1;
      if (generated === 1) {
        firstStarted();
        await release;
      }
      return Buffer.from(`image-${generated}`);
    },
  });

  const firstRequest = postImage(origin);
  await started;
  const overlapping = await postImage(origin);
  assert.equal(overlapping.status, 429);
  assert.equal(generated, 1);

  releaseFirst();
  assert.equal((await firstRequest).status, 200);
  const afterCompletion = await postImage(origin);
  assert.equal(afterCompletion.status, 200, "a completed request must release its user slot");
  assert.equal(generated, 2);
  assert.deepEqual(ledger.calls, { reserve: 2, settle: 2, refund: 0 });
});

test("provider failure refunds the reservation and releases the concurrency slot", async (t) => {
  const ledger = createLedger(1);
  let shouldFail = true;
  let generated = 0;
  const origin = await startVibeRouter(t, {
    supa: ledger.supa,
    imageConcurrencyLimit: 1,
    generateImage: async () => {
      generated += 1;
      if (shouldFail) throw new Error("provider unavailable");
      return Buffer.from("recovered-image");
    },
  });

  const failed = await postImage(origin);
  assert.equal(failed.status, 502);
  assert.match(failed.body.error, /이미지 생성에 실패/);
  assert.equal(ledger.balance(), 1);
  assert.deepEqual(ledger.calls, { reserve: 1, settle: 0, refund: 1 });

  shouldFail = false;
  const retried = await postImage(origin);
  assert.equal(retried.status, 200, "a failed request must not leak its user slot");
  assert.equal(retried.body.creditsCharged, 1);
  assert.equal(generated, 3, "the failed request tries primary and fallback once each");
  assert.deepEqual(ledger.calls, { reserve: 2, settle: 1, refund: 1 });
  assert.equal(ledger.balance(), 0);
});

test("settlement uncertainty fails closed without returning generated image bytes", async (t) => {
  const ledger = createLedger(1);
  ledger.supa.settleCreditReservation = async () => {
    ledger.calls.settle += 1;
    throw new Error("settlement response lost");
  };
  ledger.supa.refundCreditReservation = async () => {
    ledger.calls.refund += 1;
    throw new Error("ledger unavailable");
  };
  const origin = await startVibeRouter(t, { supa: ledger.supa });

  const result = await postImage(origin);
  assert.equal(result.status, 503);
  assert.match(result.body.error, /정산 확인이 지연/);
  assert.equal(result.body.dataUrl, undefined);
  assert.deepEqual(ledger.calls, { reserve: 1, settle: 1, refund: 1 });
  assert.equal(ledger.balance(), 0, "an unresolved reservation must not be silently refunded locally");
});

test("missing durable reservation ledger fails closed before provider work", async (t) => {
  let generated = 0;
  const supa = {
    isEnabled: () => true,
    getUserApiKeys: async () => [],
    reserveCredits: async () => ({ unavailable: true }),
    getCredits: async () => 1,
    settleCreditReservation: async () => assert.fail("unreserved work must not settle"),
    refundCreditReservation: async () => assert.fail("unreserved work must not refund"),
  };
  const origin = await startVibeRouter(t, {
    supa,
    generateImage: async () => {
      generated += 1;
      return Buffer.from("must-not-run");
    },
  });

  const result = await postImage(origin);
  assert.equal(result.status, 503);
  assert.match(result.body.error, /예약 시스템/);
  assert.equal(generated, 0);
});

test("admin and unlimited users remain billing-exempt", async (t) => {
  for (const user of [
    { id: "admin-1", isAdmin: true, unlimited: false },
    { id: "unlimited-1", isAdmin: false, unlimited: true },
  ]) {
    await t.test(user.isAdmin ? "admin" : "unlimited", async (t) => {
      let generated = 0;
      const noBilling = {
        isEnabled: () => true,
        getUserApiKeys: async () => [],
        reserveCredits: async () => assert.fail("exempt users must not reserve credits"),
        settleCreditReservation: async () => assert.fail("exempt users must not settle credits"),
        refundCreditReservation: async () => assert.fail("exempt users must not refund credits"),
      };
      const origin = await startVibeRouter(t, {
        supa: noBilling,
        user,
        generateImage: async () => {
          generated += 1;
          return Buffer.from("exempt-image");
        },
      });

      const result = await postImage(origin);
      assert.equal(result.status, 200);
      assert.equal(result.body.creditsCharged, 0);
      assert.equal(generated, 1);
    });
  }
});
