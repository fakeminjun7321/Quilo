"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const migration = fs.readFileSync(
  path.join(ROOT, "db/migrations/20260721_add_credit_reservation_ledger.sql"),
  "utf8",
);
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const supabase = fs.readFileSync(path.join(ROOT, "lib/supabase.js"), "utf8");
const studio = fs.readFileSync(path.join(ROOT, "lib/ai-studio-core.js"), "utf8");
const reservationFlow = fs.readFileSync(path.join(ROOT, "lib/credit-reservation-flow.js"), "utf8");

test("credit reservations are ledgered with service-role-only atomic RPCs", () => {
  assert.match(migration, /create table if not exists credit_reservations/i);
  assert.match(migration, /job_id text primary key/i);
  assert.match(migration, /status in \('reserved', 'settled', 'refunded'\)/i);
  assert.match(migration, /create or replace function reserve_generation_credits/i);
  assert.match(migration, /create or replace function settle_generation_credit_reservation/i);
  assert.match(migration, /create or replace function refund_generation_credit_reservation/i);
  assert.match(migration, /create or replace function refund_stale_generation_credit_reservations/i);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /revoke all on table credit_reservations from public, anon, authenticated/i);
});

test("the server uses one job id for durable reserve, settle, and refund", () => {
  assert.match(server, /const pendingJobId = newJobId\(\)/);
  assert.match(server, /reserveCredits\(userInfo\.id, need, \{[\s\S]{0,180}jobId: pendingJobId/);
  assert.match(server, /createJob\(userInfo, pendingJobId\)/);
  assert.match(server, /settleDurableReservation\([\s\S]{0,160}job\.creditReservation\.jobId \|\| job\.id/);
  assert.match(server, /refundDurableReservation\([\s\S]{0,160}job\.creditReservation\.jobId \|\| job\.id/);
  assert.match(server, /maintainCreditReservations/);
  assert.match(server, /process\.once\("SIGTERM"/);
});

test("ledgerless reserve RPC is not used as a crash-unsafe fallback", () => {
  const reserveBody = supabase.match(
    /async function reserveCredits[\s\S]*?\n}\n\nasync function settleCreditReservation/,
  )?.[0] || "";
  assert.match(reserveBody, /reserve_generation_credits/);
  assert.doesNotMatch(reserveBody, /c\.rpc\("reserve_credits"/);
  assert.match(reserveBody, /return \{ unavailable: true \}/);
});

test("in-memory settled state is recorded only after durable RPC success", () => {
  const successBody = server.match(
    /async function settleReservationOnSuccess[\s\S]*?\n}\n\n\/\/ 실패\/중단 시/,
  )?.[0] || "";
  const failureBody = server.match(
    /async function settleReservationOnFailure[\s\S]*?\n}\n\nasync function runGeneration/,
  )?.[0] || "";
  assert.ok(
    successBody.indexOf("await settleDurableReservation") <
      successBody.indexOf("job.creditSettled = true"),
  );
  assert.ok(
    failureBody.indexOf("await refundDurableReservation") <
      failureBody.indexOf("job.creditSettled = true"),
  );
  assert.match(successBody, /catch \(e\)[\s\S]*throw e;/);
  assert.match(failureBody, /catch \(e\)[\s\S]*status: "uncertain"/);
  assert.match(server, /if \(r\.unavailable\) \{[\s\S]{0,140}status\(503\)/);
});

test("AI Studio also uses the durable job ledger and fails closed without it", () => {
  assert.match(studio, /const studioJobId = `\$\{spec\.feature\}-\$\{crypto\.randomBytes/);
  assert.match(studio, /reserveCredits\(userInfo\.id, reserveAmt, \{[\s\S]{0,120}jobId: studioJobId/);
  assert.match(studio, /settleDurableReservation\([\s\S]{0,120}studioReservation\.jobId,[\s\S]{0,40}cost/);
  assert.match(studio, /refundDurableReservation\(supa, studioReservation\.jobId\)/);
  assert.match(studio, /if \(r\.unavailable\) \{[\s\S]{0,120}status\(503\)/);
  assert.doesNotMatch(studio, /reserveCredits\(userInfo\.id, reserveAmt\);/);
  assert.match(studio, /if \(requested && !MODEL_IDS\.has\(requested\)\) \{[\s\S]{0,100}status\(400\)/);
});

test("durable refund distinguishes an already-settled reservation", () => {
  assert.match(migration, /'status', reservation\.status/);
  assert.match(supabase, /alreadySettled: data\.status === "settled"/);
  assert.match(reservationFlow, /if \(rollback\.alreadySettled \|\| rollback\.status === "settled"\)/);
});
