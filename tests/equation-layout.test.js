"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  astPlainText,
  equationMathMl,
  extractEquationLatex,
  parseEquation,
} = require("../lib/document-tools/equation-layout");

test("OCR equation layout parses fractions, radicals, and scripts into editable math structure", () => {
  const source = "{{EQ-LATEX:\\frac{x^{2}}{\\sqrt{a_{1}+b}}}}";
  assert.equal(extractEquationLatex(source), "\\frac{x^{2}}{\\sqrt{a_{1}+b}}" );
  const ast = parseEquation(source);
  const plain = astPlainText(ast);
  assert.match(plain, /x\^\(2\)/);
  assert.match(plain, /√/);
  const mathml = equationMathMl(source);
  assert.match(mathml, /<mfrac>/);
  assert.match(mathml, /<msqrt>/);
  assert.match(mathml, /<msup>/);
  assert.match(mathml, /<msub>/);
  assert.doesNotMatch(mathml, /\{\{EQ/);

  const delimited = equationMathMl("\\left(\\frac{a}{b}\\right)^2");
  assert.match(delimited, /<mo>\(<\/mo>/);
  assert.match(delimited, /<mfrac>/);
  assert.match(delimited, /<msup>/);
  assert.match(delimited, /<mo>\)<\/mo>/);
});
