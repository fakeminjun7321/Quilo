"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const scriptDir = path.join(__dirname, "..", "lib", "equation");

function wrap(text) {
  const code = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(scriptDir)})`,
    "from hwpx_batch_convert import wrap_latex_spans",
    `print(json.dumps(wrap_latex_spans(${JSON.stringify(text)}), ensure_ascii=False))`,
  ].join("; ");
  return JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf8" }));
}

test("HWPX batch converter marks display and inline LaTeX but leaves currency numbers", () => {
  assert.deepEqual(wrap("식은 $x^2+y^2=1$ 이고 $$\\frac{a}{b}$$ 이다."), [
    "식은 {{EQ-LATEX:x^2+y^2=1}} 이고 {{EQ-LATEX:\\frac{a}{b}}} 이다.",
    2,
  ]);
  assert.deepEqual(wrap("가격은 $1200$이다."), ["가격은 $1200$이다.", 0]);
});

test("HWPX batch converter does not double-wrap existing Quilo markers", () => {
  assert.deepEqual(wrap("{{EQ-LATEX:\\sqrt{x}}}"), ["{{EQ-LATEX:\\sqrt{x}}}", 0]);
});
