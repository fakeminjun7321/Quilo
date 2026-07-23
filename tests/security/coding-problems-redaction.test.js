const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("coding problems JSON contains public examples only", () => {
  const data = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../lib/coding/problems.json"), "utf8"),
  );
  for (const problem of data.problems || []) {
    assert.equal(
      (problem.tests || []).some((t) => t && t.hidden),
      false,
      `${problem.id} leaked a hidden test`,
    );
    assert.equal(typeof problem.hidden_test_count, "number");
  }
});
