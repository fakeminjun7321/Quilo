// Deterministic invariant masking for retypeset PDF translation.
//
// This module is intentionally independent from model/API code.  It protects
// source literals that a translator must not rewrite (URLs, measurements,
// numbers, formulae, and code/file literals), then validates the returned
// placeholder stream before restoring the exact source bytes-as-text.

const crypto = require("node:crypto");

const PLACEHOLDER_PREFIX = "QINV_";
const PLACEHOLDER_TOKEN_RE = /QINV_[A-Za-z0-9_]+/g;
const RUN_ID_RE = /^[A-Za-z0-9]{8,32}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

const TYPE_PRIORITY = Object.freeze({
  code_file: 0,
  url: 1,
  math_formula: 2,
  chemical_formula: 3,
  number_unit: 4,
  number: 5,
});

const ELEMENT_SYMBOLS = new Set([
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg",
  "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr",
  "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
  "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
  "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf",
  "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po",
  "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm",
  "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs",
  "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
]);

class InvariantValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "InvariantValidationError";
    this.code = code;
    this.details = details;
  }
}

function assertPlainJsonValue(value, seen = new Set(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonical JSON does not allow non-finite numbers at ${path}`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not allow ${typeof value} at ${path}`);
  }
  if (seen.has(value)) throw new TypeError(`canonical JSON does not allow cycles at ${path}`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new TypeError(`canonical JSON does not allow sparse arrays at ${path}[${index}]`);
      }
      assertPlainJsonValue(value[index], seen, `${path}[${index}]`);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`canonical JSON only accepts plain objects at ${path}`);
    }
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) {
        throw new TypeError(`canonical JSON does not allow undefined at ${path}.${key}`);
      }
      assertPlainJsonValue(value[key], seen, `${path}.${key}`);
    }
  }
  seen.delete(value);
}

function canonicalJson(value) {
  assertPlainJsonValue(value);
  function encode(item) {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") return Object.is(item, -0) ? "0" : JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(encode).join(",")}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode(item[key])}`).join(",")}}`;
  }
  return encode(value);
}

function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256Canonical(value) {
  return sha256Hex(canonicalJson(value));
}

function compareStrings(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeText(value, name = "text") {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value.normalize("NFC");
}

function collectRegex(text, regex, type, target) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const literal = match[0];
    if (literal) {
      target.push({ type, start: match.index, end: match.index + literal.length, literal });
    }
    if (match[0] === "") regex.lastIndex += 1;
  }
}

function trimUrlCandidate(candidate) {
  let { literal, end } = candidate;
  while (/[.,;:!?]$/.test(literal)) {
    literal = literal.slice(0, -1);
    end -= 1;
  }
  const pairs = [[")", "("], ["]", "["], ["}", "{"]];
  for (const [closer, opener] of pairs) {
    while (literal.endsWith(closer)) {
      const openCount = literal.split(opener).length - 1;
      const closeCount = literal.split(closer).length - 1;
      if (closeCount <= openCount) break;
      literal = literal.slice(0, -1);
      end -= 1;
    }
  }
  return { ...candidate, literal, end };
}

function formulaAtoms(value) {
  const atoms = [];
  const atomRe = /([A-Z][a-z]?)(?:\d*)/g;
  let match;
  while ((match = atomRe.exec(value)) !== null) atoms.push(match[1]);
  return atoms;
}

function isChemicalFormula(value) {
  const compact = value.replace(/[\s·.]/g, "");
  if (!compact || compact.length > 120) return false;
  const cleaned = compact
    .replace(/(?:->|=>|→|⇌|↔|\+|=)/g, "")
    .replace(/[()\[\]{}0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹+\-^]/g, "");
  if (!cleaned || !/^[A-Za-z]+$/.test(cleaned)) return false;
  const atoms = formulaAtoms(compact);
  if (!atoms.length || atoms.some((atom) => !ELEMENT_SYMBOLS.has(atom))) return false;
  const reconstructedLetters = atoms.join("");
  if (reconstructedLetters !== cleaned) return false;
  return atoms.length >= 2 || /[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]|[()[\]]/.test(compact);
}

function collectChemicalCandidates(text, target) {
  // Reactions are collected before individual formulae, so longest-first
  // selection preserves the complete expression as one invariant.
  const reactionRe = /(?<![A-Za-z0-9])(?:[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*\s*)?(?:[A-Z][a-z]?(?:[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?|\([A-Z][A-Za-z0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*\)[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*)(?:[A-Za-z0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹()[\]]*)(?:\s*(?:\+|->|=>|→|⇌|↔|=)\s*(?:[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*\s*)?(?:[A-Z][A-Za-z0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹()[\]]*)){1,}(?![A-Za-z0-9])/g;
  reactionRe.lastIndex = 0;
  let match;
  while ((match = reactionRe.exec(text)) !== null) {
    if (isChemicalFormula(match[0])) {
      target.push({
        type: "chemical_formula",
        start: match.index,
        end: match.index + match[0].length,
        literal: match[0],
      });
    }
  }

  const formulaRe = /(?<![A-Za-z0-9])(?:[A-Z][a-z]?(?:[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?|\([A-Z][A-Za-z0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*\)[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)(?:[A-Z][a-z]?(?:[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?|\([A-Z][A-Za-z0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]*\)[\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)*(?![A-Za-z0-9])/g;
  formulaRe.lastIndex = 0;
  while ((match = formulaRe.exec(text)) !== null) {
    if (isChemicalFormula(match[0])) {
      target.push({
        type: "chemical_formula",
        start: match.index,
        end: match.index + match[0].length,
        literal: match[0],
      });
    }
  }
}

function collectMathCandidates(text, target) {
  collectRegex(text, /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, "math_formula", target);
  // Plain-text equations may contain expressions on both sides.  A relation
  // alone is not sufficient: prose-like "status = ready" is skipped unless
  // there is a mathematical signal or both sides are compact variables.
  const atom = "(?:[A-Za-zα-ωΑ-Ω][A-Za-zα-ωΑ-Ω0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹_{}^().]*|[-+]?[\\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+(?:\\.[\\d₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹]+)?)";
  const expression = `${atom}(?:\\s*[+*/\\-]\\s*${atom})*`;
  const equationRe = new RegExp(`(?<![A-Za-z0-9_])${expression}\\s*(?:=|≈|≠|≤|≥|∝)\\s*${expression}(?![A-Za-z0-9_])`, "g");
  equationRe.lastIndex = 0;
  let match;
  while ((match = equationRe.exec(text)) !== null) {
    const literal = match[0];
    const parts = literal.split(/(?:=|≈|≠|≤|≥|∝)/, 2).map((part) => part.replace(/\s/g, ""));
    const hasMathSignal = /[0-9₀-₉⁰¹²³⁴⁵⁶⁷⁸⁹^{}+*/\-]|[α-ωΑ-Ω]|[≈≠≤≥∝]/.test(literal);
    const compactVariables = parts.length === 2 && parts.every((part) => part.length >= 1 && part.length <= 3);
    if (hasMathSignal || compactVariables) {
      target.push({
        type: "math_formula",
        start: match.index,
        end: match.index + literal.length,
        literal,
      });
    }
  }
}

function collectCodeAndFileCandidates(text, target) {
  collectRegex(text, /```[\s\S]*?```|`[^`\n]+`/g, "code_file", target);
  const pathStart = target.length;
  collectRegex(text, /(?<![A-Za-z0-9])(?:[A-Za-z]:\\(?:[^\\\s<>:"|?*]+\\)*[^\\\s<>:"|?*]+|\/(?:[^/\s]+\/)*[^/\s]+)(?![A-Za-z0-9])/g, "code_file", target);
  // Path matching must allow dots inside filenames, but sentence punctuation
  // following a path is not part of the literal.
  for (let index = pathStart; index < target.length; index += 1) {
    const candidate = target[index];
    const trimmed = trimUrlCandidate(candidate);
    candidate.end = trimmed.end;
    candidate.literal = trimmed.literal;
  }
  collectRegex(text, /(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9_.-]+\.(?:pdf|docx?|xlsx?|pptx?|csv|tsv|txt|md|json|ya?ml|xml|html?|css|m?js|cjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|rs|go|sh|zsh|zip|tar|gz|png|jpe?g|gif|svg))(?![A-Za-z0-9_.-])/gi, "code_file", target);
  collectRegex(text, /(?<![A-Za-z0-9_])(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\(\)(?![A-Za-z0-9_])/g, "code_file", target);
}

function collectCandidates(text) {
  const candidates = [];
  collectCodeAndFileCandidates(text, candidates);
  const urlRe = /(?:https?:\/\/|mailto:|www\.)[^\s<>{}"'`]+/gi;
  urlRe.lastIndex = 0;
  let match;
  while ((match = urlRe.exec(text)) !== null) {
    const trimmed = trimUrlCandidate({
      type: "url",
      start: match.index,
      end: match.index + match[0].length,
      literal: match[0],
    });
    if (trimmed.literal) candidates.push(trimmed);
  }
  collectMathCandidates(text, candidates);
  collectChemicalCandidates(text, candidates);

  const number = "[-+]?(?:(?:\\d{1,3}(?:,\\d{3})+)|\\d+)(?:\\.\\d+)?(?:[eE][-+]?\\d+)?";
  const units = "(?:%|‰|°[CFK]|kg|mg|[µμ]g|g|km|cm|mm|[µμ]m|nm|m|ms|[µμ]s|ns|s|min|h|K|mol|mmol|[µμ]mol|L|mL|[µμ]L|Pa|kPa|MPa|GPa|N|kN|J|kJ|W|kW|V|mV|A|mA|Hz|kHz|MHz|GHz|rpm|dB|Ω|ohm)(?:[²³23]|\\^[+-]?\\d+)?(?:[·*/](?:kg|mg|g|km|cm|mm|[µμ]m|nm|m|ms|[µμ]s|ns|s|min|h|K|mol|L|Pa|N|J|W|V|A|Hz|Ω)(?:[²³23]|\\^[+-]?\\d+)?)?";
  collectRegex(text, new RegExp(`(?<![A-Za-z0-9_.])${number}\\s*${units}(?![A-Za-z0-9_])`, "gi"), "number_unit", candidates);
  collectRegex(text, new RegExp(`(?<![A-Za-z0-9_.])${number}(?![A-Za-z0-9_]|\\.\\d)`, "g"), "number", candidates);
  collectRegex(
    text,
    /(?<![\p{L}\p{N}_.])[-+]?[\p{N}]+(?:[.,][\p{N}]+)?(?![\p{L}\p{N}_]|\.[\p{N}])/gu,
    "number",
    candidates,
  );
  return candidates;
}

function selectLongestNonOverlapping(candidates) {
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate.literal || candidate.end <= candidate.start) continue;
    const key = `${candidate.start}:${candidate.end}`;
    const previous = unique.get(key);
    if (!previous || TYPE_PRIORITY[candidate.type] < TYPE_PRIORITY[previous.type]) {
      unique.set(key, candidate);
    }
  }
  const ranked = [...unique.values()].sort((left, right) =>
    (right.end - right.start) - (left.end - left.start) ||
    left.start - right.start ||
    TYPE_PRIORITY[left.type] - TYPE_PRIORITY[right.type] ||
    compareStrings(left.literal, right.literal));
  const selected = [];
  for (const candidate of ranked) {
    const overlaps = selected.some((item) => candidate.start < item.end && item.start < candidate.end);
    if (!overlaps) selected.push(candidate);
  }
  return selected.sort((left, right) =>
    left.start - right.start || left.end - right.end || TYPE_PRIORITY[left.type] - TYPE_PRIORITY[right.type]);
}

function deriveRunId({ text, documentSha256 = "", kind = "text", page = 0, order = 0 }) {
  return sha256Canonical({
    document_sha256: String(documentSha256).toLowerCase(),
    kind: String(kind),
    order: Number(order),
    page: Number(page),
    text: normalizeText(text),
  }).slice(0, 12);
}

function canonicalInvariantManifest(entries) {
  if (!Array.isArray(entries)) throw new TypeError("invariant entries must be an array");
  const manifest = entries.map((entry) => ({
    end: Number(entry.end),
    kind: String(entry.type || entry.kind),
    placeholder: String(entry.placeholder),
    sequence: Number(entry.sequence),
    start: Number(entry.start),
    value_sha256: String(entry.value_sha256 || sha256Hex(normalizeText(entry.literal, "invariant literal"))),
  }));
  manifest.sort((left, right) =>
    left.start - right.start || left.end - right.end ||
    compareStrings(left.kind, right.kind) || compareStrings(left.placeholder, right.placeholder));
  return manifest;
}

function maskInvariants(sourceText, options = {}) {
  const text = normalizeText(sourceText, "sourceText");
  if (text.includes(PLACEHOLDER_PREFIX)) {
    throw new InvariantValidationError(
      "INVARIANT_SOURCE_NAMESPACE_COLLISION",
      "Source text contains the reserved invariant placeholder namespace",
      {},
    );
  }
  const run = options.runId == null
    ? deriveRunId({
        text,
        documentSha256: options.documentSha256,
        kind: options.kind,
        page: options.page,
        order: options.order,
      })
    : String(options.runId);
  if (!RUN_ID_RE.test(run)) {
    throw new TypeError("runId must contain 8-32 ASCII letters or digits");
  }
  const selected = selectLongestNonOverlapping(collectCandidates(text));
  const entries = selected.map((candidate, index) => {
    const sequence = index + 1;
    const macPayload = canonicalJson({
      end: candidate.end,
      kind: candidate.type,
      literal: candidate.literal.normalize("NFC"),
      run,
      sequence,
      start: candidate.start,
    });
    const mac = crypto.createHmac("sha256", run).update(macPayload, "utf8").digest("hex").slice(0, 12);
    return {
      ...candidate,
      sequence,
      value_sha256: sha256Hex(candidate.literal.normalize("NFC")),
      placeholder: `${PLACEHOLDER_PREFIX}${run}_${String(sequence).padStart(4, "0")}_${mac}`,
    };
  });
  let maskedText = text;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    maskedText = `${maskedText.slice(0, entry.start)}${entry.placeholder}${maskedText.slice(entry.end)}`;
  }
  const manifest = canonicalInvariantManifest(entries);
  return {
    maskedText,
    runId: run,
    entries,
    manifest,
    manifestSha256: sha256Canonical(manifest),
  };
}

function placeholderOccurrences(text) {
  const occurrences = [];
  PLACEHOLDER_TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = PLACEHOLDER_TOKEN_RE.exec(text)) !== null) {
    const previous = match.index > 0 ? text[match.index - 1] : "";
    occurrences.push({
      token: match[0],
      index: match.index,
      embedded: /[A-Za-z0-9_]/.test(previous),
    });
  }
  return occurrences;
}

function classifyResidualInvariants(text) {
  return selectLongestNonOverlapping(collectCandidates(text)).map((item) => ({
    kind: item.type,
    start: item.start,
    end: item.end,
  }));
}

function validateInvariantPlaceholders(maskResult, targetText) {
  if (!maskResult || !Array.isArray(maskResult.entries)) {
    throw new TypeError("maskResult must be returned by maskInvariants");
  }
  const target = normalizeText(targetText, "targetText");
  const expected = maskResult.entries.map((entry) => entry.placeholder);
  const expectedSet = new Set(expected);
  const occurrences = placeholderOccurrences(target);
  const actual = occurrences.map((item) => item.token);
  const unknown = [...new Set(actual.filter((token) => !expectedSet.has(token)))];
  const counts = new Map(expected.map((token) => [token, 0]));
  for (const token of actual) {
    if (counts.has(token)) counts.set(token, counts.get(token) + 1);
  }
  const missing = expected.filter((token) => counts.get(token) === 0);
  const duplicate = expected.filter((token) => counts.get(token) > 1);
  const knownActual = actual.filter((token) => expectedSet.has(token));
  const orderMatches = knownActual.length === expected.length &&
    knownActual.every((token, index) => token === expected[index]);

  const embedded = occurrences.filter((item) => item.embedded).map((item) => item.token);
  if (unknown.length || missing.length || duplicate.length || embedded.length || actual.length !== expected.length || !orderMatches) {
    throw new InvariantValidationError(
      "INVARIANT_PLACEHOLDER_MISMATCH",
      "Invariant placeholder set, order, or count does not exactly match the source",
      {
        expected_count: expected.length,
        actual_count: actual.length,
        unknown,
        missing,
        duplicate,
        embedded,
        order_mismatch: !orderMatches,
      },
    );
  }

  let residual = target;
  for (let index = occurrences.length - 1; index >= 0; index -= 1) {
    const occurrence = occurrences[index];
    residual = `${residual.slice(0, occurrence.index)} ${residual.slice(occurrence.index + occurrence.token.length)}`;
  }
  if (residual.includes(PLACEHOLDER_PREFIX)) {
    throw new InvariantValidationError(
      "INVARIANT_PLACEHOLDER_MALFORMED",
      "A malformed invariant placeholder remains in the target",
      {},
    );
  }
  const additional = classifyResidualInvariants(residual);
  if (additional.length) {
    throw new InvariantValidationError(
      "INVARIANT_ADDITION",
      "The target introduced a numeric, URL, formula, code, or file literal outside invariant placeholders",
      {
        count: additional.length,
        kinds: [...new Set(additional.map((item) => item.kind))].sort(),
        locations: additional.map(({ kind, start, end }) => ({ kind, start, end })),
      },
    );
  }
  return { expectedCount: expected.length, actualCount: actual.length, placeholders: [...expected] };
}

function restoreInvariantLiterals(maskResult, targetText) {
  const target = normalizeText(targetText, "targetText");
  validateInvariantPlaceholders(maskResult, target);
  let restored = target;
  for (const entry of maskResult.entries) {
    restored = restored.replace(entry.placeholder, entry.literal);
  }
  if (restored.includes(PLACEHOLDER_PREFIX)) {
    throw new InvariantValidationError(
      "INVARIANT_RESTORATION_FAILED",
      "An invariant placeholder remained after restoration",
      {},
    );
  }
  return restored;
}

function assertSha256(value, name = "sha256") {
  const normalized = String(value || "").toLowerCase();
  if (!SHA256_RE.test(normalized)) throw new TypeError(`${name} must be a lowercase SHA-256 hex digest`);
  return normalized;
}

module.exports = {
  InvariantValidationError,
  PLACEHOLDER_PREFIX,
  assertSha256,
  canonicalInvariantManifest,
  canonicalJson,
  classifyResidualInvariants,
  deriveRunId,
  maskInvariants,
  normalizeText,
  restoreInvariantLiterals,
  selectLongestNonOverlapping,
  sha256Canonical,
  sha256Hex,
  validateInvariantPlaceholders,
};
