"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  getVersionInfo,
  PATCH_NOTES,
  pullRequestNumberFromSubject,
} = require("../lib/version-info");

test("release version recognizes merge and squash PR commit subjects", () => {
  assert.equal(pullRequestNumberFromSubject("Merge pull request #39 from owner/branch"), 39);
  assert.equal(pullRequestNumberFromSubject("release: deploy PR #41"), 41);
  assert.equal(pullRequestNumberFromSubject("feat: add telemetry (#40)"), 40);
  assert.equal(pullRequestNumberFromSubject("fix: reference #42 in body"), 0);
});

test("version metadata is lightweight unless patch notes are explicitly requested", () => {
  const metadata = getVersionInfo();
  assert.equal(Object.hasOwn(metadata, "patchNotes"), false);
  assert.ok(metadata.version);
  assert.ok(metadata.releaseVersion);

  const full = getVersionInfo({ includeNotes: true });
  assert.equal(full.patchNotes, PATCH_NOTES);
  assert.ok(full.patchNotes.length > 0);
  assert.ok(JSON.stringify(full).length > JSON.stringify(metadata).length * 10);
});

test("version API and changelog keep patch notes behind the includeNotes opt-in", () => {
  const root = path.resolve(__dirname, "..");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const changelog = fs.readFileSync(path.join(root, "public/ui/changelog.js"), "utf8");

  assert.match(
    server,
    /getVersionInfo\(\{ includeNotes: req\.query\.includeNotes === "1" \}\)/,
  );
  assert.match(changelog, /fetch\("\/api\/version\?includeNotes=1"/);
});

test("public patch notes do not re-expose retired feature names or ids", () => {
  const notes = JSON.stringify(getVersionInfo({ includeNotes: true }).patchNotes);
  for (const term of [
    "phys-inquiry",
    "math-inquiry",
    "eng-exam-prep",
    "korean-lit-exam",
    "phys-mock-exam",
    "물리 수행평가",
    "수학 수행평가",
    "영어 시험대비",
    "국어 문학 시험",
    "물리 모의고사",
  ]) {
    assert.equal(notes.includes(term), false, `retired term leaked: ${term}`);
  }
});
