"use strict";

// The model never emits TeX/TikZ documents. It emits this bounded, declarative
// page plan and the renderer below owns every executable token. This is both a
// reproducibility boundary and a prompt-injection boundary.

const MAX_PAGES = 40;
const MAX_BLOCKS_PER_PAGE = 180;
const MAX_PRIMITIVES_PER_DIAGRAM = 450;
const MAX_TEXT_LENGTH = 12000;
const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLS = 16;

const BLOCK_TYPES = new Set([
  "text",
  "equation",
  "table",
  "diagram",
  "raster",
  "rule",
]);

const PRIMITIVE_TYPES = new Set([
  "line",
  "arrow",
  "polyline",
  "curve",
  "circle",
  "ellipse",
  "rect",
  "label",
  "math_label",
  "axis",
  "plot",
  "angle",
  "dimension",
]);

const SAFE_COLORS = new Set([
  "black", "white", "gray", "lightgray", "darkgray",
  "red", "blue", "green", "purple", "orange", "brown",
]);

const FORBIDDEN_TEX = /\\(?:input|include|openin|openout|read|write|special|usepackage|documentclass|begin\s*\{\s*document|end\s*\{\s*document|csname|catcode|makeatletter|def|edef|gdef|xdef|let|newcommand|renewcommand|providecommand|loop|repeat|directlua|immediate)(?![A-Za-z@])/i;
const ALLOWED_MATH_COMMANDS = new Set([
  "frac", "dfrac", "tfrac", "sqrt", "sum", "prod", "int", "iint", "iiint", "oint",
  "lim", "min", "max", "sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp",
  "mathrm", "mathbf", "mathit", "mathsf", "mathcal", "mathbb", "operatorname", "text", "substack",
  // Vision models sometimes preserve bold/italic emphasis inside an equation
  // block with the text-mode variants below. They only style their braced
  // argument and are safe inside our already sandboxed, deterministic TeX
  // document. Executable commands remain blocked by FORBIDDEN_TEX first.
  "textbf", "textit", "textrm", "textsf", "textnormal", "emph",
  "partial", "nabla", "infty", "hbar", "ell", "imath", "jmath",
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta",
  "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho", "varrho", "sigma", "varsigma",
  "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "cdot", "cdots", "ldots", "dots", "vdots", "ddots", "times", "div", "pm", "mp", "le", "leq", "ge", "geq", "neq", "approx", "sim", "simeq",
  "equiv", "propto", "to", "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow",
  "in", "notin", "subset", "subseteq", "supset", "supseteq", "cup", "cap", "setminus",
  "left", "right", "big", "Big", "bigg", "Bigg", "vec", "hat", "widehat", "bar", "overline", "underline", "dot", "ddot",
  "overbrace", "underbrace", "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "vert", "Vert", "mid",
  "circ", "prime", "perp", "parallel", "angle", "triangle", "forall", "exists", "therefore", "because", "oplus", "otimes", "det", "Re", "Im", "binom",
  "quad", "qquad", "!", ",", ";", ":",
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function fail(path, message) {
  throw new Error(`복원 스키마 오류 (${path}): ${message}`);
}

function cleanString(value, path, { max = MAX_TEXT_LENGTH, allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(path, "문자열이어야 합니다.");
  const out = value.replace(/\u0000/g, "").replace(/\r\n?/g, "\n");
  if (!allowEmpty && !out.trim()) fail(path, "빈 문자열은 허용되지 않습니다.");
  if (out.length > max) fail(path, `${max}자를 초과했습니다.`);
  return out;
}

function finite(value, path, min = -Infinity, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    fail(path, `${min}~${max} 범위의 유한한 수여야 합니다.`);
  }
  return n;
}

function norm(value, path) {
  return finite(value, path, 0, 1);
}

function positiveNorm(value, path) {
  return finite(value, path, 0.001, 1);
}

function cleanColor(value, path, fallback = "black") {
  if (value == null || value === "") return fallback;
  const c = String(value).trim().toLowerCase();
  if (SAFE_COLORS.has(c) || /^#[0-9a-f]{6}$/.test(c)) return c;
  fail(path, "허용되지 않은 색상입니다.");
}

function validateLatex(value, path) {
  const text = cleanString(value, path, { max: 3000 });
  // TeX converts ^^5c to a backslash before command tokenization. Reject every
  // double-caret sequence so a model cannot smuggle \input/\write past the
  // literal-backslash allowlist (single ^ remains available for superscripts).
  if (/\^\^/.test(text) || FORBIDDEN_TEX.test(text) || /\\(?:begin|end)\s*\{/i.test(text) || /[$#&]/.test(text) || /(^|[^\\])%/.test(text)) {
    fail(path, "실행 가능하거나 환경을 여는 LaTeX 명령은 허용되지 않습니다.");
  }
  for (const match of text.matchAll(/\\([A-Za-z]+|[!,;:])/g)) {
    if (!ALLOWED_MATH_COMMANDS.has(match[1])) {
      fail(path, `허용되지 않은 수식 명령 \\${match[1]} 입니다.`);
    }
  }
  for (const match of text.matchAll(/\\([^A-Za-z])/g)) {
    if (!new Set([",", ";", ":", "!", "{", "}", "|", "%", " "]).has(match[1])) {
      fail(path, `허용되지 않은 수식 제어문자 \\${match[1]} 입니다.`);
    }
  }
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") { i += 1; continue; }
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") depth -= 1;
    if (depth < 0) fail(path, "중괄호가 올바르게 닫히지 않았습니다.");
  }
  if (depth !== 0) fail(path, "중괄호가 올바르게 닫히지 않았습니다.");
  return text;
}

function validateBox(raw, path) {
  if (!isPlainObject(raw)) fail(path, "객체여야 합니다.");
  const x = norm(raw.x, `${path}.x`);
  const y = norm(raw.y, `${path}.y`);
  const w = positiveNorm(raw.w, `${path}.w`);
  const h = positiveNorm(raw.h, `${path}.h`);
  if (x + w > 1.001 || y + h > 1.001) fail(path, "페이지 경계를 벗어났습니다.");
  return { x, y, w, h };
}

function validatePoint(raw, path) {
  if (!Array.isArray(raw) || raw.length !== 2) fail(path, "[x,y] 좌표여야 합니다.");
  return [norm(raw[0], `${path}[0]`), norm(raw[1], `${path}[1]`)];
}

function validatePoints(raw, path, { min = 2, max = 250 } = {}) {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) {
    fail(path, `${min}~${max}개의 점 배열이어야 합니다.`);
  }
  return raw.map((p, i) => validatePoint(p, `${path}[${i}]`));
}

function primitiveBase(raw, path) {
  const type = String(raw.type || "").toLowerCase();
  if (!PRIMITIVE_TYPES.has(type)) fail(`${path}.type`, "지원하지 않는 primitive입니다.");
  return {
    type,
    stroke: cleanColor(raw.stroke, `${path}.stroke`, "black"),
    fill: raw.fill === "none" || raw.fill == null
      ? "none"
      : cleanColor(raw.fill, `${path}.fill`, "white"),
    width: finite(raw.width == null ? 1 : raw.width, `${path}.width`, 0.2, 8),
    opacity: finite(raw.opacity == null ? 1 : raw.opacity, `${path}.opacity`, 0.03, 1),
    dash: ["solid", "dashed", "dotted"].includes(raw.dash) ? raw.dash : "solid",
  };
}

function validatePrimitive(raw, path) {
  if (!isPlainObject(raw)) fail(path, "객체여야 합니다.");
  const out = primitiveBase(raw, path);
  const p = (name) => norm(raw[name], `${path}.${name}`);
  switch (out.type) {
    case "line":
    case "arrow":
      return { ...out, x1: p("x1"), y1: p("y1"), x2: p("x2"), y2: p("y2") };
    case "polyline":
    case "curve":
      return { ...out, points: validatePoints(raw.points, `${path}.points`, { min: 2, max: 250 }) };
    case "circle":
      return { ...out, cx: p("cx"), cy: p("cy"), r: positiveNorm(raw.r, `${path}.r`) };
    case "ellipse":
      return { ...out, cx: p("cx"), cy: p("cy"), rx: positiveNorm(raw.rx, `${path}.rx`), ry: positiveNorm(raw.ry, `${path}.ry`) };
    case "rect":
      return { ...out, ...validateBox(raw, path), radius: finite(raw.radius || 0, `${path}.radius`, 0, 0.2) };
    case "label":
      return { ...out, x: p("x"), y: p("y"), text: cleanString(raw.text, `${path}.text`, { max: 500 }), size: finite(raw.size || 10, `${path}.size`, 5, 30), anchor: cleanAnchor(raw.anchor) };
    case "math_label":
      return { ...out, x: p("x"), y: p("y"), latex: validateLatex(raw.latex, `${path}.latex`), size: finite(raw.size || 10, `${path}.size`, 5, 30), anchor: cleanAnchor(raw.anchor) };
    case "axis": {
      const ticks = Array.isArray(raw.ticks) ? raw.ticks : [];
      if (ticks.length > 80) fail(`${path}.ticks`, "눈금이 너무 많습니다.");
      return {
        ...out, x1: p("x1"), y1: p("y1"), x2: p("x2"), y2: p("y2"),
        label: cleanString(String(raw.label || ""), `${path}.label`, { max: 100, allowEmpty: true }),
        ticks: ticks.map((t, i) => {
          if (!isPlainObject(t)) fail(`${path}.ticks[${i}]`, "객체여야 합니다.");
          return { at: norm(t.at, `${path}.ticks[${i}].at`), label: cleanString(String(t.label ?? ""), `${path}.ticks[${i}].label`, { max: 40, allowEmpty: true }) };
        }),
      };
    }
    case "plot":
      return { ...out, points: validatePoints(raw.points, `${path}.points`, { min: 2, max: 250 }), marker: ["none", "circle", "square"].includes(raw.marker) ? raw.marker : "none" };
    case "angle":
      return { ...out, cx: p("cx"), cy: p("cy"), r: positiveNorm(raw.r, `${path}.r`), start_deg: finite(raw.start_deg, `${path}.start_deg`, -720, 720), end_deg: finite(raw.end_deg, `${path}.end_deg`, -720, 720), label: cleanString(String(raw.label || ""), `${path}.label`, { max: 80, allowEmpty: true }) };
    case "dimension":
      return { ...out, x1: p("x1"), y1: p("y1"), x2: p("x2"), y2: p("y2"), label: cleanString(raw.label, `${path}.label`, { max: 100 }), offset: finite(raw.offset || 0, `${path}.offset`, -0.25, 0.25) };
    default:
      fail(path, "지원하지 않는 primitive입니다.");
  }
}

function cleanAnchor(value) {
  const anchor = String(value || "center").toLowerCase();
  return ["center", "north", "south", "east", "west", "north west", "north east", "south west", "south east"].includes(anchor)
    ? anchor
    : "center";
}

function validateBlock(raw, path) {
  if (!isPlainObject(raw)) fail(path, "객체여야 합니다.");
  const type = String(raw.type || "").toLowerCase();
  if (!BLOCK_TYPES.has(type)) fail(`${path}.type`, "지원하지 않는 블록입니다.");
  const common = {
    type,
    ...validateBox(raw, path),
    layer: raw.layer === "background" ? "background" : "foreground",
    opacity: finite(raw.opacity == null ? 1 : raw.opacity, `${path}.opacity`, 0.03, 1),
  };
  if (type === "text") {
    return {
      ...common,
      text: cleanString(raw.text, `${path}.text`),
      font_size: finite(raw.font_size || 10, `${path}.font_size`, 5, 32),
      line_height: finite(raw.line_height || 1.28, `${path}.line_height`, 0.9, 2.2),
      weight: raw.weight === "bold" ? "bold" : "normal",
      align: ["left", "center", "right", "justify"].includes(raw.align) ? raw.align : "left",
    };
  }
  if (type === "equation") {
    return { ...common, latex: validateLatex(raw.latex, `${path}.latex`), font_size: finite(raw.font_size || 10, `${path}.font_size`, 6, 32), align: ["left", "center", "right"].includes(raw.align) ? raw.align : "center" };
  }
  if (type === "table") {
    if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > MAX_TABLE_ROWS) {
      fail(`${path}.rows`, `1~${MAX_TABLE_ROWS}행이어야 합니다.`);
    }
    const rows = raw.rows.map((row, ri) => {
      if (!Array.isArray(row) || row.length < 1 || row.length > MAX_TABLE_COLS) fail(`${path}.rows[${ri}]`, `1~${MAX_TABLE_COLS}열이어야 합니다.`);
      return row.map((cell, ci) => cleanString(String(cell ?? ""), `${path}.rows[${ri}][${ci}]`, { max: 1000, allowEmpty: true }));
    });
    const cols = rows[0].length;
    if (rows.some((row) => row.length !== cols)) fail(`${path}.rows`, "모든 행의 열 개수가 같아야 합니다.");
    return { ...common, rows, header_rows: Math.min(rows.length, Math.max(0, Math.trunc(Number(raw.header_rows) || 0))), font_size: finite(raw.font_size || 8, `${path}.font_size`, 5, 18), borders: raw.borders !== false };
  }
  if (type === "diagram") {
    if (!Array.isArray(raw.primitives) || raw.primitives.length < 1 || raw.primitives.length > MAX_PRIMITIVES_PER_DIAGRAM) {
      fail(`${path}.primitives`, `1~${MAX_PRIMITIVES_PER_DIAGRAM}개의 primitive가 필요합니다.`);
    }
    const invariants = Array.isArray(raw.invariants) ? raw.invariants : [];
    if (!invariants.length) fail(`${path}.invariants`, "그림의 물리적·기하학적 의미 조건이 하나 이상 필요합니다.");
    return {
      ...common,
      primitives: raw.primitives.map((p, i) => validatePrimitive(p, `${path}.primitives[${i}]`)),
      invariants: invariants.slice(0, 30).map((v, i) => cleanString(v, `${path}.invariants[${i}]`, { max: 500 })),
      alt: cleanString(String(raw.alt || ""), `${path}.alt`, { max: 500, allowEmpty: true }),
    };
  }
  if (type === "raster") {
    const crop = raw.crop;
    if (!isPlainObject(crop)) fail(`${path}.crop`, "원본 사진 crop 객체가 필요합니다.");
    const source_index = Math.trunc(finite(crop.source_index, `${path}.crop.source_index`, 1, MAX_PAGES));
    const cropBox = validateBox(crop, `${path}.crop`);
    const purpose = String(raw.purpose || "").toLowerCase();
    if (!["photo", "logo", "complex_illustration"].includes(purpose)) {
      fail(`${path}.purpose`, "raster는 실제 사진, 로고, 복잡한 삽화에만 허용됩니다.");
    }
    return { ...common, crop: { source_index, ...cropBox }, purpose };
  }
  return {
    ...common,
    orientation: raw.orientation === "vertical" ? "vertical" : "horizontal",
    stroke: cleanColor(raw.stroke, `${path}.stroke`, "black"),
    width: finite(raw.width || 0.5, `${path}.width`, 0.1, 5),
  };
}

function validatePagePlan(raw, expectedSourceIndex) {
  if (!isPlainObject(raw)) fail("page", "객체여야 합니다.");
  const page = isPlainObject(raw.page) ? raw.page : raw;
  const source_index = Math.trunc(finite(page.source_index, "page.source_index", 1, MAX_PAGES));
  if (expectedSourceIndex != null && source_index !== expectedSourceIndex) {
    fail("page.source_index", `요청한 페이지 ${expectedSourceIndex}와 일치하지 않습니다.`);
  }
  if (!Array.isArray(page.blocks) || page.blocks.length < 1 || page.blocks.length > MAX_BLOCKS_PER_PAGE) {
    fail("page.blocks", `1~${MAX_BLOCKS_PER_PAGE}개의 블록이 필요합니다.`);
  }
  return {
    source_index,
    background: cleanColor(page.background, "page.background", "white"),
    blocks: page.blocks.map((b, i) => validateBlock(b, `page.blocks[${i}]`)),
    unreadable: (Array.isArray(page.unreadable) ? page.unreadable : []).slice(0, 50).map((v, i) => cleanString(v, `page.unreadable[${i}]`, { max: 500 })),
    confidence: finite(page.confidence == null ? 0.8 : page.confidence, "page.confidence", 0, 1),
  };
}

function validateDocumentPlan(raw, expectedPages) {
  if (!isPlainObject(raw)) fail("document", "객체여야 합니다.");
  if (!Array.isArray(raw.pages) || raw.pages.length !== expectedPages) {
    fail("document.pages", `입력 사진 수(${expectedPages})와 페이지 수가 같아야 합니다.`);
  }
  const pages = raw.pages.map((p, i) => validatePagePlan(p, i + 1));
  return {
    version: "1.0",
    title: cleanString(String(raw.title || "복원 문서"), "document.title", { max: 300 }),
    page_size: "A4",
    pages,
  };
}

module.exports = {
  MAX_PAGES,
  MAX_BLOCKS_PER_PAGE,
  MAX_PRIMITIVES_PER_DIAGRAM,
  validateLatex,
  validatePagePlan,
  validateDocumentPlan,
};
