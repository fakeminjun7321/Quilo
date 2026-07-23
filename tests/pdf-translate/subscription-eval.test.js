"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildTranslationSchema,
  parseArgs,
  requestedIds,
} = require("../../scripts/eval_pdf_translation_subscription");

test("subscription evaluator derives exact structured-output IDs from a retry request", () => {
  const user = [
    "This is a targeted correction retry.",
    "A diagnostic may contain [bracketed text] before the payload.",
    "Translate the following segments to Korean.",
    "",
    JSON.stringify([
      { id: "12", text: "Mass was 12.50 g." },
      { id: "__pdf_metadata__:title", text: "Calibration record" },
    ]),
  ].join("\n");
  const ids = requestedIds(user);
  assert.deepEqual(ids, ["12", "__pdf_metadata__:title"]);
  const schema = buildTranslationSchema(ids);
  assert.deepEqual(schema.properties.t.required, ids);
  assert.equal(schema.properties.t.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties.t.properties), ids);
});

test("subscription evaluator rejects duplicate IDs and unsafe arguments", () => {
  assert.throws(
    () => requestedIds(`${JSON.stringify([{ id: 1 }, { id: 1 }])}`),
    /duplicate IDs/,
  );
  assert.throws(
    () => parseArgs(["--input", "a.pdf", "--output-dir", "out", "--model", "unknown"]),
    /sonnet or opus/,
  );
  assert.throws(
    () => parseArgs(["--input", "a.pdf", "--output-dir", "out", "--timeout-ms", "50"]),
    /at least 1000/,
  );
});
