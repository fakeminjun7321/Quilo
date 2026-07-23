const test = require("node:test");
const assert = require("node:assert/strict");

const { safeColor } = require("../../lib/pipelines/chem-result/svg-chart-gen");

test("SVG chart colors are constrained to safe values", () => {
  assert.equal(safeColor("#abc"), "#abc");
  assert.equal(safeColor("#AABBCC"), "#AABBCC");
  assert.equal(safeColor("red"), "red");
  assert.equal(safeColor('" /><script>alert(1)</script><line stroke="'), "#d0021b");
  assert.equal(safeColor("url(javascript:alert(1))"), "#d0021b");
});
