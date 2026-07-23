"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePageOrder, prepareInput, extractJson } = require("./generate");
const { validateLatex, validatePagePlan, validateDocumentPlan } = require("./schema");
const { buildTex, renderDocumentPlan } = require("./semantic-renderer");
const { diceSimilarity, validateQaResponse, renderPdf300 } = require("./qa");

function page(overrides = {}) {
  return {
    source_index: 1,
    background: "white",
    confidence: 0.98,
    unreadable: [],
    blocks: [
      { type: "text", x: 0.08, y: 0.08, w: 0.84, h: 0.08, text: "제4장 원자 구조", font_size: 14, weight: "bold" },
      {
        type: "diagram", x: 0.1, y: 0.2, w: 0.5, h: 0.3,
        invariants: ["힘 화살표는 핵에서 입자를 향한다"],
        primitives: [
          { type: "circle", cx: 0.5, cy: 0.6, r: 0.04 },
          { type: "arrow", x1: 0.5, y1: 0.6, x2: 0.7, y2: 0.3 },
          { type: "math_label", x: 0.74, y: 0.28, latex: "\\vec F", size: 9 },
        ],
      },
      {
        type: "equation", x: 0.08, y: 0.58, w: 0.84, h: 0.08,
        latex: "\\textbf{Quiz}\\quad E_n=\\frac{n^2\\pi^2\\hbar^2}{2mL^2}",
        font_size: 10,
      },
    ],
    ...overrides,
  };
}

test("page order is a strict permutation", () => {
  assert.deepEqual(parsePageOrder("3,1,2", 3), [3, 1, 2]);
  assert.deepEqual(parsePageOrder("[2,1]", 2), [2, 1]);
  assert.throws(() => parsePageOrder("1,1", 2), /중복 없이/);
  assert.throws(() => parsePageOrder("1,2", 3), /사진 3장/);
});

test("prepareInput requires images and applies page order", () => {
  const a = { buffer: Buffer.from([1]), originalname: "a.jpg", mimetype: "image/jpeg" };
  const b = { buffer: Buffer.from([2]), originalname: "b.png", mimetype: "image/png" };
  const got = prepareInput({ photos: [a, b] }, { pageOrder: "2,1", semanticRedraw: "true" });
  assert.deepEqual(got.photos.map((p) => p.name), ["b.png", "a.jpg"]);
  assert.equal(got.semanticRedraw, true);
  assert.throws(() => prepareInput({}, {}), /사진/);
});

test("model JSON is fenced or bare", () => {
  assert.deepEqual(extractJson("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(extractJson("{\"a\":2}"), { a: 2 });
});

test("schema blocks executable TeX and unbounded geometry", () => {
  assert.equal(validateLatex("E=mc^{2}", "eq"), "E=mc^{2}");
  assert.equal(
    validateLatex("\\textbf{Quiz}\\quad E_n=\\frac{n^2\\pi^2\\hbar^2}{2mL^2}", "eq"),
    "\\textbf{Quiz}\\quad E_n=\\frac{n^2\\pi^2\\hbar^2}{2mL^2}",
  );
  assert.throws(() => validateLatex("\\input{/etc/passwd}", "eq"), /허용되지/);
  assert.throws(() => validateLatex("\\textbf{\\input{/etc/passwd}}", "eq"), /허용되지/);
  assert.throws(() => validateLatex("^^5cinput{/etc/passwd}", "eq"), /허용되지/);
  assert.throws(() => validateLatex("\\textbf{^^5cwrite18{touch pwn}}", "eq"), /허용되지/);
  assert.throws(() => validateLatex("x$};\\node at (0,0) {pwn}", "eq"), /허용되지/);
  assert.throws(() => validateLatex("\\draw (0,0)--(1,1)", "eq"), /허용되지 않은 수식 명령/);
  assert.throws(() => validatePagePlan(page({ blocks: [{ type: "text", x: 0.9, y: 0, w: 0.2, h: 0.1, text: "x" }] }), 1), /경계를 벗어/);
  assert.throws(() => validatePagePlan(page({ blocks: [{ type: "diagram", x: 0, y: 0, w: 1, h: 1, invariants: [], primitives: [{ type: "line", x1: 0, y1: 0, x2: 1, y2: 1 }] }] }), 1), /의미 조건/);
});

test("document plan and deterministic renderer keep semantic primitives", () => {
  const plan = validateDocumentPlan({ title: "원자", pages: [page()] }, 1);
  const tex = buildTex(plan);
  assert.match(tex, /\\documentclass/);
  assert.match(tex, /힘 화살표는 핵에서 입자를 향한다|\\draw/);
  assert.match(tex, /\\vec F/);
  assert.doesNotMatch(tex, /\\input|\\write18/);
});

test("independent OCR QA is locally recomputed and fail closed", () => {
  assert.ok(diceSimilarity("가속 전압 4.9 eV", "가속전압 4.9eV") > 0.9);
  const good = validateQaResponse({
    source_transcript: "프랑크 헤르츠 실험 가속 전압 4.9 eV 원자 에너지 준위",
    output_transcript: "프랑크 헤르츠 실험 가속 전압 4.9 eV 원자 에너지 준위",
    text_similarity: 0.99,
    layout_similarity: 0.95,
    diagram_semantics_ok: true,
    no_overlap: true,
    no_clipping: true,
    critical_issues: [],
    warnings: [],
  }, 1);
  assert.equal(good.ok, true);
  const bad = validateQaResponse({
    source_transcript: "입사 운동량 산란 운동량 충격 매개 변수",
    output_transcript: "다른 문장과 잘못된 숫자 999",
    text_similarity: 0.2,
    layout_similarity: 0.9,
    diagram_semantics_ok: false,
    no_overlap: true,
    no_clipping: true,
    critical_issues: ["산란각 방향이 반대"],
    warnings: [],
  }, 1);
  assert.equal(bad.ok, false);
  assert.match(bad.defects.join(" "), /의미 관계|산란각/);
});

test("one-page fixture compiles and renders as 300 dpi A4 without an API", { timeout: 120000 }, async () => {
  const plan = validateDocumentPlan({ title: "fixture", pages: [page()] }, 1);
  const generated = await renderDocumentPlan(plan, [], { onProgress: () => {} });
  assert.ok(generated.buffer.subarray(0, 5).equals(Buffer.from("%PDF-")));
  const rendered = await renderPdf300(generated.buffer);
  try {
    assert.equal(rendered.pages.length, 1);
    assert.equal(rendered.pages[0].dpi, 300);
    assert.ok(rendered.pages[0].width >= 2400);
    assert.ok(rendered.pages[0].height >= 3400);
  } finally {
    rendered.cleanup();
  }
});
