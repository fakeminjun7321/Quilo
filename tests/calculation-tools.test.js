"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { wordCount, equationToUnicode } = require("../lib/calculation-tools/core");
const { describe, linearRegression } = require("../lib/calculation-tools/statistics");
const { convertUnit } = require("../lib/calculation-tools/units");
const { renderPng, renderSvg } = require("../lib/calculation-tools/graph");

test("word count handles Unicode code points, whitespace and UTF-8 bytes", () => {
  assert.deepEqual(wordCount("가 나\n🙂"), {
    characters: 5,
    charactersNoWhitespace: 3,
    words: 3,
    lines: 2,
    paragraphs: 1,
    bytesUtf8: 12,
  });
});

test("statistics and regression return deterministic scientific values", () => {
  const stats = describe([1, 2, 3, 4]);
  assert.equal(stats.mean, 2.5);
  assert.equal(stats.median, 2.5);
  assert.equal(stats.standardDeviationPopulation, Math.sqrt(1.25));
  const regression = linearRegression([1, 2, 3], [3, 5, 7]);
  assert.equal(regression.slope, 2);
  assert.equal(regression.intercept, 1);
  assert.equal(regression.rSquared, 1);
  assert.throws(() => describe([1, ""]), /모든 값/);
});

test("unit and equation notation conversion cover lab-report use cases", () => {
  assert.equal(convertUnit(1, "km", "m", "length").result, 1000);
  assert.equal(convertUnit(0, "c", "k", "temperature").result, 273.15);
  assert.throws(() => convertUnit(-300, "c", "f", "temperature"), /0 K/);
  assert.equal(equationToUnicode("\\frac{1}{2}mv^{2}").result, "(1)/(2)mv²");
});

test("graph renderer returns valid SVG and PNG bytes", async () => {
  const input = { type: "line", x: [0, 1, 2], y: [1, 3, 5], title: "실험 결과", format: "svg" };
  const svg = renderSvg(input);
  assert.match(svg.toString("utf8"), /^<\?xml[\s\S]*<svg/);
  const png = await renderPng({ ...input, format: "png", width: 500, height: 320 });
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});
