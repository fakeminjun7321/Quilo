"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listFeatures, featureSearchScore } = require("../lib/quilo-catalog");

test("feature search resolves synonyms and English aliases", () => {
  assert.equal(listFeatures({ query: "영단어" })[0].id, "vocabulary-book");
  assert.equal(listFeatures({ query: "vocab" })[0].id, "vocabulary-book");
  assert.ok(listFeatures({ query: "엑셀" }).some((item) => item.id === "table-analysis"));
  assert.ok(listFeatures({ query: "레포트" }).some((item) => item.category === "reports"));
});

test("feature search tolerates a close Korean typo", () => {
  const results = listFeatures({ query: "단어짱" });
  assert.equal(results[0].id, "vocabulary-book");
  assert.ok(featureSearchScore(results[0], "단어짱") >= 38);
});
