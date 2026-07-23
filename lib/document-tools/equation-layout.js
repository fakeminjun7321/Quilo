"use strict";

const COMMANDS = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", theta: "θ", lambda: "λ", mu: "μ",
  pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", omega: "ω",
  Delta: "Δ", Gamma: "Γ", Theta: "Θ", Lambda: "Λ", Sigma: "Σ", Phi: "Φ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", leq: "≤", geq: "≥", neq: "≠",
  approx: "≈", propto: "∝", infty: "∞", rightarrow: "→", Rightarrow: "⇒",
  sum: "∑", int: "∫", partial: "∂", nabla: "∇", ldots: "…", cdots: "⋯",
  sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", exp: "exp",
};

function extractEquationLatex(value) {
  let text = String(value || "").trim();
  const marker = text.match(/^\{\{EQN?(?:-LATEX)?:\s*([\s\S]*?)\}\}$/i);
  if (marker) text = marker[1].trim();
  text = text
    .replace(/^\$\$([\s\S]*?)\$\$$/, "$1")
    .replace(/^\$([^$]*)\$$/, "$1")
    .replace(/^\\\[([\s\S]*?)\\\]$/, "$1")
    .replace(/^\\\(([\s\S]*?)\\\)$/, "$1")
    .trim();
  return text;
}

class LatexParser {
  constructor(source) {
    this.source = extractEquationLatex(source)
      .replace(/\\left\s*/g, "")
      .replace(/\\right\s*/g, "");
    this.index = 0;
  }

  peek() { return this.source[this.index] || ""; }
  take() { const value = this.peek(); this.index += value ? 1 : 0; return value; }
  skipSpaces() { while (/\s/.test(this.peek())) this.index += 1; }

  parse(stop = "") {
    const children = [];
    while (this.index < this.source.length && (!stop || this.peek() !== stop)) {
      this.skipSpaces();
      if (stop && this.peek() === stop) break;
      if (this.index >= this.source.length) break;
      let base = this.primary();
      if (!base) continue;
      let sub = null;
      let sup = null;
      while (this.peek() === "_" || this.peek() === "^") {
        const operator = this.take();
        const script = this.script();
        if (operator === "_") sub = script;
        else sup = script;
      }
      if (sub && sup) base = { type: "subsup", base, sub, sup };
      else if (sub) base = { type: "sub", base, sub };
      else if (sup) base = { type: "sup", base, sup };
      children.push(base);
    }
    if (stop && this.peek() === stop) this.index += 1;
    return children.length === 1 ? children[0] : { type: "sequence", children };
  }

  group() {
    this.skipSpaces();
    if (this.peek() === "{") {
      this.index += 1;
      return this.parse("}");
    }
    return this.primary() || { type: "text", value: "" };
  }

  script() {
    this.skipSpaces();
    return this.group();
  }

  command() {
    this.index += 1;
    const match = this.source.slice(this.index).match(/^([A-Za-z]+|.)/);
    if (!match) return { type: "text", value: "" };
    this.index += match[1].length;
    const name = match[1];
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      return { type: "fraction", numerator: this.group(), denominator: this.group() };
    }
    if (name === "sqrt") {
      this.skipSpaces();
      let degree = null;
      if (this.peek() === "[") {
        this.index += 1;
        degree = this.parse("]");
      }
      return { type: "radical", body: this.group(), degree };
    }
    if (name === "left" || name === "right" || name === "displaystyle" || name === "," || name === ";") {
      return this.primary();
    }
    if (name === "text" || name === "mathrm" || name === "operatorname") {
      const body = this.group();
      return { type: "text", value: astPlainText(body) };
    }
    if (["{", "}", "|", "%", "#", "_", "&"].includes(name)) {
      return { type: "text", value: name };
    }
    return { type: "text", value: COMMANDS[name] || name };
  }

  primary() {
    this.skipSpaces();
    const char = this.peek();
    if (!char) return null;
    if (char === "\\") return this.command();
    if (char === "{") {
      this.index += 1;
      return this.parse("}");
    }
    if (char === "(" || char === "[") {
      const close = char === "(" ? ")" : "]";
      this.index += 1;
      return { type: "bracket", open: char, close, body: this.parse(close) };
    }
    if (char === "}" || char === ")" || char === "]") {
      this.index += 1;
      return { type: "text", value: char };
    }
    const number = this.source.slice(this.index).match(/^\d+(?:[.,]\d+)?/);
    if (number) {
      this.index += number[0].length;
      return { type: "text", value: number[0] };
    }
    const word = this.source.slice(this.index).match(/^[A-Za-z가-힣]+/);
    if (word) {
      this.index += word[0].length;
      return { type: "text", value: word[0] };
    }
    this.index += 1;
    return { type: "text", value: char };
  }
}

function parseEquation(value) {
  try {
    return new LatexParser(value).parse();
  } catch {
    return { type: "text", value: extractEquationLatex(value) };
  }
}

function astPlainText(node) {
  if (!node) return "";
  if (node.type === "text") return node.value || "";
  if (node.type === "sequence") return (node.children || []).map(astPlainText).join("");
  if (node.type === "fraction") return `(${astPlainText(node.numerator)})/(${astPlainText(node.denominator)})`;
  if (node.type === "radical") return `${node.degree ? `${astPlainText(node.degree)}` : ""}√(${astPlainText(node.body)})`;
  if (node.type === "sup") return `${astPlainText(node.base)}^(${astPlainText(node.sup)})`;
  if (node.type === "sub") return `${astPlainText(node.base)}_(${astPlainText(node.sub)})`;
  if (node.type === "subsup") return `${astPlainText(node.base)}_(${astPlainText(node.sub)})^(${astPlainText(node.sup)})`;
  if (node.type === "bracket") return `${node.open}${astPlainText(node.body)}${node.close}`;
  return "";
}

function escapeXml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textMathMl(value) {
  const escaped = escapeXml(value);
  if (/^\d+(?:[.,]\d+)?$/.test(value)) return `<mn>${escaped}</mn>`;
  if (/^[=+\-×÷·<>≤≥≈≠±∓∝→⇒,;:|]$/.test(value)) return `<mo>${escaped}</mo>`;
  if (/^[([{\])}]$/.test(value)) return `<mo>${escaped}</mo>`;
  if (/^[가-힣]{2,}$/.test(value) || /^(?:sin|cos|tan|log|ln|exp)$/.test(value)) return `<mtext>${escaped}</mtext>`;
  return `<mi>${escaped}</mi>`;
}

function astToMathMl(node) {
  if (!node) return "";
  if (node.type === "text") return textMathMl(node.value || "");
  if (node.type === "sequence") return `<mrow>${(node.children || []).map(astToMathMl).join("")}</mrow>`;
  if (node.type === "fraction") return `<mfrac>${astToMathMl(node.numerator)}${astToMathMl(node.denominator)}</mfrac>`;
  if (node.type === "radical") return node.degree
    ? `<mroot>${astToMathMl(node.body)}${astToMathMl(node.degree)}</mroot>`
    : `<msqrt>${astToMathMl(node.body)}</msqrt>`;
  if (node.type === "sup") return `<msup>${astToMathMl(node.base)}${astToMathMl(node.sup)}</msup>`;
  if (node.type === "sub") return `<msub>${astToMathMl(node.base)}${astToMathMl(node.sub)}</msub>`;
  if (node.type === "subsup") return `<msubsup>${astToMathMl(node.base)}${astToMathMl(node.sub)}${astToMathMl(node.sup)}</msubsup>`;
  if (node.type === "bracket") return `<mrow><mo>${escapeXml(node.open)}</mo>${astToMathMl(node.body)}<mo>${escapeXml(node.close)}</mo></mrow>`;
  return "";
}

function equationMathMl(value) {
  const latex = extractEquationLatex(value);
  return `<math xmlns="http://www.w3.org/1998/Math/MathML" display="block" data-latex="${escapeXml(latex)}">${astToMathMl(parseEquation(latex))}</math>`;
}

function astToDocxMath(node, constructors) {
  const {
    MathRun,
    MathFraction,
    MathRadical,
    MathSuperScript,
    MathSubScript,
    MathSubSuperScript,
    MathRoundBrackets,
    MathSquareBrackets,
  } = constructors;
  if (!node) return [];
  if (node.type === "text") return [new MathRun(node.value || "")];
  if (node.type === "sequence") return (node.children || []).flatMap((child) => astToDocxMath(child, constructors));
  if (node.type === "fraction") return [new MathFraction({
    numerator: astToDocxMath(node.numerator, constructors),
    denominator: astToDocxMath(node.denominator, constructors),
  })];
  if (node.type === "radical") return [new MathRadical({
    children: astToDocxMath(node.body, constructors),
    degree: node.degree ? astToDocxMath(node.degree, constructors) : undefined,
  })];
  if (node.type === "sup") return [new MathSuperScript({
    children: astToDocxMath(node.base, constructors),
    superScript: astToDocxMath(node.sup, constructors),
  })];
  if (node.type === "sub") return [new MathSubScript({
    children: astToDocxMath(node.base, constructors),
    subScript: astToDocxMath(node.sub, constructors),
  })];
  if (node.type === "subsup") return [new MathSubSuperScript({
    children: astToDocxMath(node.base, constructors),
    subScript: astToDocxMath(node.sub, constructors),
    superScript: astToDocxMath(node.sup, constructors),
  })];
  if (node.type === "bracket") {
    const Brackets = node.open === "[" ? MathSquareBrackets : MathRoundBrackets;
    return [new Brackets({ children: astToDocxMath(node.body, constructors) })];
  }
  return [new MathRun(astPlainText(node))];
}

module.exports = {
  astPlainText,
  astToDocxMath,
  equationMathMl,
  extractEquationLatex,
  parseEquation,
};
