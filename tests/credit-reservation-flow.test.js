"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  refundDurableReservation,
  retryOperation,
  settleDurableReservation,
} = require("../lib/credit-reservation-flow");

test("retryOperation retries transient response loss", async () => {
  let calls = 0;
  const result = await retryOperation(async () => {
    calls += 1;
    if (calls < 3) throw new Error("network reset");
    return "ok";
  }, { baseDelayMs: 0 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("settle retry with the same amount recovers a committed response loss", async () => {
  let calls = 0;
  const supa = {
    settleCreditReservation: async (jobId, spent) => {
      assert.equal(jobId, "job-1");
      assert.equal(spent, 2);
      calls += 1;
      if (calls === 1) throw new Error("response lost after commit");
      return { status: "settled", changed: false, newBalance: 7 };
    },
    refundCreditReservation: async () => { throw new Error("must not refund"); },
  };
  const result = await settleDurableReservation(supa, "job-1", 2, { baseDelayMs: 0 });
  assert.equal(result.status, "settled");
  assert.equal(result.recovered, true);
  assert.equal(result.newBalance, 7);
  assert.equal(calls, 2);
});

test("refund status disambiguates a settlement whose responses were all lost", async () => {
  const supa = {
    settleCreditReservation: async () => { throw new Error("response unavailable"); },
    refundCreditReservation: async () => ({
      status: "settled",
      alreadySettled: true,
      changed: false,
      newBalance: 5,
    }),
  };
  const result = await settleDurableReservation(supa, "job-2", 4, { baseDelayMs: 0 });
  assert.equal(result.status, "settled");
  assert.equal(result.recovered, true);
  assert.equal(result.newBalance, 5);
});

test("failed settlement that was refunded is never reported as charged", async () => {
  const supa = {
    settleCreditReservation: async () => { throw new Error("database rejected settlement"); },
    refundCreditReservation: async () => ({
      status: "refunded",
      refunded: true,
      changed: true,
      newBalance: 9,
    }),
  };
  const result = await settleDurableReservation(supa, "job-3", 4, { baseDelayMs: 0 });
  assert.equal(result.status, "refunded");
  assert.equal(result.newBalance, 9);
});

test("unreachable settle and refund surfaces an explicit uncertain state", async () => {
  const supa = {
    settleCreditReservation: async () => { throw new Error("settle offline"); },
    refundCreditReservation: async () => { throw new Error("refund offline"); },
  };
  await assert.rejects(
    () => settleDurableReservation(supa, "job-4", 4, { attempts: 1, baseDelayMs: 0 }),
    (error) => error.code === "CREDIT_SETTLEMENT_UNCERTAIN" && error.errors.length === 2,
  );
});

test("failure refund preserves an already-settled status", async () => {
  const result = await refundDurableReservation({
    refundCreditReservation: async () => ({ status: "settled", alreadySettled: true, newBalance: 1 }),
  }, "job-5", { baseDelayMs: 0 });
  assert.equal(result.status, "settled");
  assert.equal(result.newBalance, 1);
});
