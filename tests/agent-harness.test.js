"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Codex and Claude Code share one instruction source", () => {
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");
  assert.match(claude, /^@AGENTS\.md$/m);
  assert.match(claude, /^@docs\/engineering\/agent-harness\.md$/m);
  assert.match(claude, /^@docs\/engineering\/agent-memory\.md$/m);
  assert.match(agents, /docs\/engineering\/agent-harness\.md/);
  assert.match(agents, /npm run harness:doctor/);
});

test("harness config uses only bounded allowlisted commands", () => {
  const config = JSON.parse(read(".harness/config.json"));
  assert.equal(config.version, 1);
  assert.equal(config.nodeMajor, 24);
  const allowlist = new Set(config.allowedExecutables);
  for (const [tierName, entries] of Object.entries(config.tiers)) {
    assert.ok(entries.length > 0, `${tierName} must not be empty`);
    for (const entry of entries) {
      assert.ok(allowlist.has(entry.argv[0]), `${entry.argv[0]} must be allowlisted`);
      assert.ok(entry.timeoutMs >= 1000, `${entry.name} must have a bounded timeout`);
      assert.ok(!entry.argv.some((arg) => /\b(?:deploy|push|migration|email|token)\b/i.test(arg)), `${entry.name} must not mutate production`);
    }
  }
});

test("checkpoint runs and transient evidence remain gitignored", () => {
  const gitignore = read(".gitignore");
  assert.match(gitignore, /^\.harness\/runs\/$/m);
  const schema = JSON.parse(read(".harness/state.schema.json"));
  for (const field of [
    "runId", "objective", "acceptanceCriteria", "allowedPaths", "baseRevision",
    "dirtyBaseline", "iteration", "changedFiles", "commands", "openRisks",
    "blockers", "status", "nextAction", "ruleReview", "promotedRules", "updatedAt",
  ]) {
    assert.ok(schema.required.includes(field), `schema must require ${field}`);
  }
});

test("complete checkpoints require a durable-rule review", (t) => {
  const runId = `test-rule-review-${process.pid}`;
  const runDir = path.join(ROOT, ".harness", "runs", runId);
  fs.rmSync(runDir, { recursive: true, force: true });
  t.after(() => fs.rmSync(runDir, { recursive: true, force: true }));

  const runHarness = (...args) => spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "agent-harness.mjs"), ...args],
    { cwd: ROOT, encoding: "utf8" },
  );

  const initialized = runHarness("init", runId, "--objective", "test rule review gate", "--tool", "codex");
  assert.equal(initialized.status, 0, initialized.stderr);

  const missingReview = runHarness("checkpoint", runId, "--status", "complete");
  assert.equal(missingReview.status, 1);
  assert.match(missingReview.stderr, /complete requires --rule-review/);

  const promotedWithoutSource = runHarness(
    "checkpoint", runId,
    "--status", "complete",
    "--rule-review", "new stable lesson",
    "--promoted-rule", "rule promotion contract",
  );
  assert.equal(promotedWithoutSource.status, 1);
  assert.match(promotedWithoutSource.stderr, /durable rule source/);

  const completed = runHarness(
    "checkpoint", runId,
    "--status", "complete",
    "--rule-review", "new stable lesson promoted",
    "--promoted-rule", "rule promotion contract",
    "--changed", "docs/engineering/agent-memory.md",
  );
  assert.equal(completed.status, 0, completed.stderr);
  const state = JSON.parse(read(path.relative(ROOT, path.join(runDir, "state.json"))));
  assert.equal(state.status, "complete");
  assert.equal(state.ruleReview, "new stable lesson promoted");
  assert.deepEqual(state.promotedRules, ["rule promotion contract"]);
});

test("package scripts expose the shared verification tiers", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const name of [
    "harness:doctor", "harness:init", "harness:checkpoint", "harness:resume",
    "verify:quick", "verify:core", "verify:release", "test:unit", "test:security", "test:pipelines",
  ]) {
    assert.ok(pkg.scripts[name], `package.json must define ${name}`);
  }
});
