const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const {
  calcCost,
  calcImageCost,
  formatCostLine,
} = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { renderChart } = require("../chem-result/chart-gen");
const { parseCap, summarizeForPrompt } = require("./cap-parser");
const { parseSpreadsheet } = require("../../excel-parser");
const {
  describePreparedImage,
  getBatchImageOptions,
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("../../anthropic-media");
const styleRef = require("../../style-ref");
const {
  isGptModel,
  usesOpenAiCompat,
  providerConfigured,
  callGptReport,
  gptConfigured,
} = require("../../model-call");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { streamWithContinuation, extractJson } = require("../../claude-stream");

// 사용자가 폼에서 모델을 선택. 누락 시 fallback.
// 기본 Opus 4.8 (품질 우선). 환경변수로 변경 가능: DEFAULT_MODEL=claude-sonnet-5
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
// Sonnet 품질을 Opus 수준으로 끌어올리는 adaptive thinking + effort.
// 추론 기본 OFF (Sonnet thinking이 무거운 입력에서 너무 느려 타임아웃). 켜려면 ENABLE_THINKING=1. effort: low|medium|high.
const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "medium";

const SKILL_PATH = path.join(__dirname, "prompt.md");
// 양식 PDF는 모든 보고서 동일 — 코드에 내장
const FORM_PDF_PATH = path.join(__dirname, "form.pdf");
let _formPdfBuffer = null;
let _formPdfMissing = false;
function loadFormPdfBuffer() {
  if (_formPdfBuffer) return _formPdfBuffer;
  if (_formPdfMissing) return null;
  try {
    _formPdfBuffer = fs.readFileSync(FORM_PDF_PATH);
    return _formPdfBuffer;
  } catch {
    _formPdfMissing = true;
    return null; // form.pdf 없으면 첨부 안 함 (graceful)
  }
}

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 / 실험자 의견 ===
${notes}
=== 메모 끝 ===

이 메모는 학생이 실제로 실험을 수행하면서 남긴 맥락입니다. 업로드 데이터와 명백히 충돌하지 않는 범위에서 반드시 반영하세요.

반영 위치 가이드:
- 측정 절차, 장치 세팅, 반복 측정 방식 → experiment_setup, method_summary, 각 experiments[].analysis
- 제외하거나 버린 데이터의 이유 → 해당 실험 파트의 analysis, conclusion.error_analysis
- 실험 중 발생한 문제와 해결 시도 → conclusion.problem_solving에 구체적으로 서술
- 관찰한 오차 원인 → 과학 이론과 연결하여 conclusion.error_analysis에 서술

메모 문장을 그대로 붙이지 말고, 평가기준의 "실험 결과의 표현 및 해석", "결론 및 오차 분석", "문제 인식 및 해결"에 맞는 보고서 문체로 녹여 쓰세요.

반영 강도 제한:
- 사용자 메모는 보조 맥락입니다. 업로드 데이터 분석보다 앞서거나 보고서 전체의 주된 결론이 되면 안 됩니다.
- 같은 메모의 동일한 사실은 보고서 전체에서 최대 2회만 언급하세요.
- 실험 장치/세팅에 1문장, conclusion.error_analysis 또는 conclusion.problem_solving에 1~2문장 정도만 반영하세요.
- experiments[].analysis에서는 사용자 메모를 직접 반복하지 마세요. 각 실험 파트 분석은 표·그래프·계산값에서 나온 경향성 중심으로 작성하세요.
- 메모가 특정 예비 시행이나 관찰에 관한 것이면 "일부 예비 시행", "가능한 오차 요인", "오차 분석에 고려하였다"처럼 조심스럽게 표현하세요.
- 사용자 메모의 정성적 표현을 정량값으로 바꾸지 마세요. 예: "비정상적으로 흔들림" → "속도값이 불안정했다"까지만 가능, "±0.05 m/s"처럼 수치화 금지.
- 사용자 메모 안의 "꼭", "반드시" 같은 강조 표현은 사용자의 희망으로만 해석하고, 보고서 전체를 그 내용 중심으로 재구성하지 마세요.
- before/after 데이터가 첨부 파일에 명확히 없으면, 사용자 메모의 조치 때문에 측정 분산·오차·손실률이 얼마나 개선되었다고 인과적으로 쓰지 마세요.
- 사용자 메모 기반 문장 뒤에 "그 결과 ..."로 재현성·분산·편차·오차 개선을 주장하지 마세요.
- 사용자 메모에 없는 문제 해결 절차(예: 재출발 절차 통일, 추가 정렬 검증, 실패 방지용 사전 계산)를 새로 만들지 마세요. 메모에 해결 시도가 없으면 "오차 요인으로 고려하였다" 수준으로만 쓰세요.
- 데이터 제외/배제 메모가 모호하면 제외 이유도 모호한 수준으로만 쓰세요. 예: "정확도가 떨어지는 데이터는 배제했다" → "정확도가 낮다고 판단한 일부 회차를 평균 산출에서 제외하였다"까지만 가능. "초기 흔들림", "후반부 감쇠", "축이 비스듬함", "표준편차가 얼마 이상" 같은 구체 사유는 사용자 메모·정리 파일·cap 텍스트에 명시된 경우에만 쓰세요.
- 사용자 메모의 조치가 실제로 평균이나 표준편차를 얼마나 바꾸었는지 첨부 데이터로 직접 비교할 수 없으면, "분산이 감소했다", "오차가 줄었다", "신뢰도가 높아졌다"처럼 효과를 단정하지 말고 "대표값 산출 시 고려하였다" 정도로 제한하세요.

중요한 제한:
- 메모와 첨부 데이터에 없는 구체적인 수치, 제외 횟수, 프레임 수, 장비 조정 절차, 추가 측정 결과는 만들어내지 마세요.
- 사용자가 "안정 구간 중심", "데이터 제외"처럼 범위만 적었다면, 그 수준으로만 표현하고 임의로 "1~2프레임 제외", "표준편차가 얼마로 감소"처럼 세부값을 붙이지 마세요.`;
}

function shouldConstrainExclusionNote(userNotes) {
  const notes = String(userNotes || "");
  return (
    /(배제|제외)/.test(notes) &&
    /(정확도|부정확|정확하지|떨어지|낮)/.test(notes)
  );
}

function notesExplicitlyNameExclusionCause(userNotes) {
  return /(초기|후반|말기|진폭|흔들|비스듬|기울|감쇠|표준편차|분산|마찰|센서|축)/.test(
    String(userNotes || ""),
  );
}

function sanitizeExclusionSentence(sentence) {
  const text = String(sentence || "");
  const hasExclusion = /(평균|대표|회차|데이터|측정값|시행).*(배제|제외)|(배제|제외).*(평균|대표|회차|데이터|측정값|시행)/.test(text);
  const hasUnsupportedCause = /(초기|후반|말기|진폭|흔들|비스듬|기울|감쇠|표준편차|분산|마찰|센서|축)/.test(text);
  if (!hasExclusion || !hasUnsupportedCause) {
    return { text, changed: false };
  }
  const leading = text.match(/^\s*/)?.[0] || "";
  const trailing = text.match(/\s*$/)?.[0] || "";
  const punct = /[.!?。]\s*$/.test(text) ? "" : ".";
  return {
    text:
      leading +
      "정확도가 낮다고 판단한 일부 회차는 평균 산출에서 제외하고, 첨부된 정리 데이터의 대표값을 기준으로 계산하였다" +
      punct +
      trailing,
    changed: true,
  };
}

function splitTextIntoSentences(text) {
  const raw = String(text || "");
  if (!raw) return [];

  const sentences = [];
  let start = 0;
  const boundaryChars = new Set([".", "!", "?", "。", "！", "？"]);
  let parenDepth = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (!boundaryChars.has(ch)) continue;

    // 괄호가 안 닫힌 상태에서는 문장 경계로 보지 않는다 —
    // "(Effect. Rot. m)" 같은 괄호 안 약어에서 자르면 미닫힘 파편이 생겨
    // 분량 압축(compactField)이 결론을 "...(Effect." 로 절단한 실사고가 있었다.
    if (parenDepth > 0) continue;

    const prev = raw[i - 1] || "";
    const next = raw[i + 1] || "";
    const nextNonSpaceMatch = raw.slice(i + 1).match(/\S/);
    const nextNonSpace = nextNonSpaceMatch ? nextNonSpaceMatch[0] : "";
    if (
      ch === "." &&
      /\d/.test(prev) &&
      (/\d/.test(next) || /\d/.test(nextNonSpace))
    ) {
      continue;
    }

    // 영문 약어 마침표 보호: 마침표 앞이 대문자로 시작하는 짧은 라틴 토큰이고
    // (Effect. / Rot. / Exp. / Fig. / No. ...) 뒤에 라틴 문자·숫자가 이어지면
    // 문장 종결이 아니라 약어로 본다. 한국어 종결(다.)은 prev가 한글이라 영향 없음.
    if (ch === "." && /[A-Za-z]/.test(prev) && /[A-Za-z0-9]/.test(nextNonSpace)) {
      const tokenMatch = raw.slice(0, i).match(/([A-Za-z]+)$/);
      const token = tokenMatch ? tokenMatch[1] : "";
      if (token && token.length <= 7 && /^[A-Z]/.test(token)) {
        continue;
      }
    }

    const end = i + 1;
    sentences.push(raw.slice(start, end));
    let nextStart = end;
    while (nextStart < raw.length && /\s/.test(raw[nextStart])) nextStart++;
    i = nextStart - 1;
    start = nextStart;
  }

  const tail = raw.slice(start);
  if (tail) sentences.push(tail);
  return sentences.length ? sentences : [raw];
}

function sanitizePhysicsNoteOverreach(value, userNotes) {
  if (!shouldConstrainExclusionNote(userNotes) || notesExplicitlyNameExclusionCause(userNotes)) {
    return { value, changes: 0 };
  }

  if (typeof value === "string") {
    let changes = 0;
    const pieces = splitTextIntoSentences(value);
    const rewritten = pieces.map((piece) => {
      if (!piece.trim()) return piece;
      const sanitized = sanitizeExclusionSentence(piece);
      if (sanitized.changed) changes++;
      return sanitized.text;
    });
    // splitTextIntoSentences drops the whitespace between sentences, so joining
    // with "" would delete inter-sentence spaces. When nothing changed, return
    // the original string untouched; otherwise rejoin with a single space so the
    // surviving sentences stay readable.
    if (changes === 0) {
      return { value, changes: 0 };
    }
    const next = rewritten.map((piece) => piece.trim()).filter(Boolean).join(" ");
    return { value: next, changes };
  }

  if (Array.isArray(value)) {
    let changes = 0;
    const next = value.map((item) => {
      const sanitized = sanitizePhysicsNoteOverreach(item, userNotes);
      changes += sanitized.changes;
      return sanitized.value;
    });
    return { value: next, changes };
  }

  if (value && typeof value === "object") {
    let changes = 0;
    const next = { ...value };
    for (const key of Object.keys(next)) {
      const sanitized = sanitizePhysicsNoteOverreach(next[key], userNotes);
      changes += sanitized.changes;
      next[key] = sanitized.value;
    }
    return { value: next, changes };
  }

  return { value, changes: 0 };
}

function fixSamplePeriodFrequencyPairs(text) {
  if (typeof text !== "string" || !/ms|Hz/.test(text)) {
    return { text, changes: 0 };
  }
  let changes = 0;
  const fixed = text.replace(
    /(\d+(?:\.\d+)?)\s*ms\s*(?:주기|간격|sample\s*period)?\s*\(\s*(\d+(?:\.\d+)?)\s*Hz\s*\)/gi,
    (match, msRaw, hzRaw) => {
      const ms = Number(msRaw);
      const hz = Number(hzRaw);
      if (!Number.isFinite(ms) || !Number.isFinite(hz) || ms <= 0 || hz <= 0) {
        return match;
      }
      const expectedMs = 1000 / hz;
      if (Math.abs(expectedMs - ms) / expectedMs <= 0.02) {
        return match;
      }
      const msText = Number.isInteger(expectedMs)
        ? String(Math.round(expectedMs))
        : expectedMs.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
      changes++;
      return `${msText} ms 주기(${hzRaw} Hz)`;
    },
  );
  return { text: fixed, changes };
}

function normalizePlainPhysicsNotation(text) {
  if (typeof text !== "string" || !/[A-Za-zα-ωΑ-Ω]_[A-Za-z0-9]/.test(text)) {
    return { text, changes: 0 };
  }
  const before = text;
  const sub = {
    0: "₀",
    1: "₁",
    2: "₂",
    3: "₃",
    4: "₄",
    5: "₅",
    6: "₆",
    7: "₇",
    8: "₈",
    9: "₉",
  };
  const fixed = text
    .replace(/([A-Za-zα-ωΑ-Ω])_([0-9])/g, (_, base, digit) => `${base}${sub[digit] || digit}`)
    .replace(/\|([A-Za-zα-ωΑ-Ω]+)\|_max/g, "|$1|max")
    .replace(/\b([A-Za-zα-ωΑ-Ω]+)_max\b/g, "$1max")
    .replace(/\b([A-Za-zα-ωΑ-Ω]+)_cm\b/g, "$1cm")
    .replace(/\b([A-Za-zα-ωΑ-Ω]+)_pivot\b/g, "$1pivot");
  return { text: fixed, changes: fixed === before ? 0 : 1 };
}

function sanitizePhysicsUnitConsistency(value) {
  if (typeof value === "string") {
    const periodFixed = fixSamplePeriodFrequencyPairs(value);
    const notationFixed = normalizePlainPhysicsNotation(periodFixed.text);
    return {
      value: notationFixed.text,
      changes: periodFixed.changes + notationFixed.changes,
    };
  }
  if (Array.isArray(value)) {
    let changes = 0;
    const next = value.map((item) => {
      const fixed = sanitizePhysicsUnitConsistency(item);
      changes += fixed.changes;
      return fixed.value;
    });
    return { value: next, changes };
  }
  if (value && typeof value === "object") {
    let changes = 0;
    const next = { ...value };
    for (const key of Object.keys(next)) {
      const fixed = sanitizePhysicsUnitConsistency(next[key]);
      changes += fixed.changes;
      next[key] = fixed.value;
    }
    return { value: next, changes };
  }
  return { value, changes: 0 };
}

// 끝이 '가.'/'나.'/'(2)' 같은 소제목 마커로 끝나면(=뒤따르는 내용이 잘려나감)
// 그 dangling 토막을 제거한다.
function stripDanglingStructureMarker(s) {
  let out = String(s || "");
  // 반복 제거(여러 소제목이 연달아 비어 끝나는 경우)
  for (let i = 0; i < 4; i++) {
    const next = out.replace(
      /(?:\n|^|\s)(?:[가-하]\.|[A-Za-z]\.|\([0-9]+\)|[0-9]+\))\s*$/u,
      "",
    ).trimEnd();
    if (next === out) break;
    out = next;
  }
  return out;
}

function compactTextForPageLimit(value, maxSentences, maxChars) {
  const raw0 = String(value || "");
  if (!raw0.trim()) return raw0.trim();
  // 구조 마커(가./나./(1)/A.)가 있는 다단 분석은, 문장수 절단이 소제목만 남기고
  // 본문을 통째로 버려 dangling header 를 만든다 → 문장수 절단을 적용하지 않고
  // 줄바꿈을 보존하며 길이만 넉넉히 제한한다.
  const hasStructure = /(?:^|\n|\s)(?:[가-하]\.|\([0-9]+\))\s/u.test(raw0);
  if (hasStructure) {
    // 공백/탭만 정리하고 줄바꿈은 보존(소제목 줄 구분 유지).
    const kept = raw0.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim();
    const cap = Math.max(maxChars, 1400);
    if (kept.length <= cap) return stripDanglingStructureMarker(kept);
    let clipped = kept.slice(0, cap).replace(/\s+\S*$/, "").trim();
    clipped = stripDanglingStructureMarker(clipped);
    return /[.!?。]$/.test(clipped) ? clipped : `${clipped}.`;
  }

  const raw = raw0.replace(/\s+/g, " ").trim();
  const sentences = splitTextIntoSentences(raw);
  if (sentences.length <= maxSentences && raw.length <= maxChars) return raw;

  const picked = [];
  let length = 0;
  for (const sentence of sentences) {
    const clean = sentence.trim();
    if (!clean) continue;
    if (picked.length >= maxSentences) break;
    if (picked.length > 0 && length + clean.length + 1 > maxChars) break;
    if (picked.length === 0 && clean.length > maxChars) {
      const clipped = clean.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
      return /[.!?。]$/.test(clipped) ? clipped : `${clipped}.`;
    }
    picked.push(clean);
    length += clean.length + 1;
  }

  const compacted = stripDanglingStructureMarker(picked.join(" ").trim());
  if (compacted) return /[.!?。]$/.test(compacted) ? compacted : `${compacted}.`;
  const clipped = raw.slice(0, maxChars).replace(/\s+\S*$/, "").trim();
  return /[.!?。]$/.test(clipped) ? clipped : `${clipped}.`;
}

function compactField(object, key, maxSentences, maxChars) {
  if (!object || !object[key]) return 0;
  const before = String(object[key]);
  const after = compactTextForPageLimit(before, maxSentences, maxChars);
  if (after === before) return 0;
  object[key] = after;
  return 1;
}

function compactConclusionValue(value, maxSentences, maxChars, maxItems = 3) {
  if (Array.isArray(value)) {
    return value
      .filter(Boolean)
      .slice(0, maxItems)
      .map((item) => compactTextForPageLimit(item, maxSentences, maxChars));
  }
  return compactTextForPageLimit(value, maxSentences, maxChars);
}

function enforcePhysicsPageLimit(parsed, onProgress = () => {}, opts = {}) {
  if (!parsed || typeof parsed !== "object") return parsed;
  // 사진이 없으면 사진이 차지했을 ~1~1.5쪽을 본문(심화 분석)으로 채울 수 있도록 압축 캡을 완화한다.
  // 기본값(opts 미전달)은 "사진 있음"(=기존 캡)으로 둬, 실수로 전역 완화되어 5쪽을 넘기는 회귀를 막는다.
  const hasPhotos = opts.hasPhotos !== false;
  let changes = 0;

  const setup = parsed.experiment_setup || {};
  changes += compactField(setup, "description", 3, 520);

  const experiments = Array.isArray(parsed.experiments) ? parsed.experiments : [];
  const manyParts = experiments.length >= 3;
  for (const exp of experiments) {
    changes += compactField(exp, "method_summary", 2, hasPhotos ? (manyParts ? 220 : 280) : (manyParts ? 300 : 340));
    changes += compactField(
      exp,
      "analysis",
      hasPhotos ? (manyParts ? 4 : 5) : 6,
      hasPhotos ? (manyParts ? 620 : 820) : (manyParts ? 900 : 980),
    );
  }

  const conclusion = parsed.conclusion || {};
  changes += compactField(conclusion, "objective_recap", 2, 260);
  changes += compactField(conclusion, "result_summary", 4, hasPhotos ? 560 : 780);
  if (conclusion.error_analysis) {
    const before = JSON.stringify(conclusion.error_analysis);
    conclusion.error_analysis = compactConclusionValue(
      conclusion.error_analysis,
      hasPhotos ? 2 : 3,
      hasPhotos ? 300 : 440,
      hasPhotos ? 3 : 4,
    );
    if (JSON.stringify(conclusion.error_analysis) !== before) changes++;
  }
  changes += compactField(conclusion, "problem_solving", 3, hasPhotos ? 430 : 600);
  changes += compactField(conclusion, "physical_meaning", 4, hasPhotos ? 560 : 780);
  changes += compactField(conclusion, "theory_connection", 4, hasPhotos ? 560 : 780);

  if (changes) onProgress(`✂️ 5페이지 제한 후처리: 긴 문단 ${changes}곳 압축`);
  return parsed;
}

function parseTextDataFile(buffer) {
  const MAX_CHARS = 80000;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const utf8 = buf.toString("utf8");
  let raw = utf8;
  try {
    const eucKr = new TextDecoder("euc-kr").decode(buf);
    const badUtf8 = (utf8.match(/\uFFFD/g) || []).length;
    const badEucKr = (eucKr.match(/\uFFFD/g) || []).length;
    if (badEucKr < badUtf8) raw = eucKr;
  } catch {
    // UTF-8 is still the normal path; keep it if legacy Korean decoding fails.
  }
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!cleaned) {
    throw new Error("텍스트 파일에 읽을 수 있는 내용이 없습니다.");
  }
  const truncated = cleaned.length > MAX_CHARS;
  return {
    text: truncated ? cleaned.slice(0, MAX_CHARS) : cleaned,
    charCount: cleaned.length,
    truncated,
  };
}

// 물리 결과보고서는 학교 양식 기본 버전만 지원한다.
const STYLE_INSTRUCTIONS = {
  default: `## 현재 양식

**기본 양식** (학교 양식 + 65점 평가 최적화)

위 스킬 명세의 default 모드 가이드 모두 적용:
- 최대 5페이지, 목표 4페이지 안팎. 분량이 애매하면 반드시 짧게 압축
- experiments[] (data_table + chart + analysis) + conclusion{...} 구조
- 65점 평가기준 모두 만점 노림
- 1.1, 1.2 자동 번호 + 분석 텍스트 안에 가./나./(1)/(2)`,
};

function normalizeDataKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[(){}\[\]·._/-]/g, "")
    .replace(/㎠|cm2/g, "cm2")
    .trim();
}

function findColumn(headers, candidates) {
  const normalized = headers.map(normalizeDataKey);
  for (const candidate of candidates) {
    const key = normalizeDataKey(candidate);
    const exact = normalized.indexOf(key);
    if (exact >= 0) return exact;
    const partial = normalized.findIndex((h) => h && (h.includes(key) || key.includes(h)));
    if (partial >= 0) return partial;
  }
  return -1;
}

function parseNumberCell(value) {
  const raw = String(value ?? "").trim();
  if (!raw || /^[-–—]+$/.test(raw)) return null;
  const cleaned = raw
    .replace(/,/g, "")
    .replace(/[−–—]/g, "-")
    .match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
  if (!cleaned) return null;
  const n = Number(cleaned[0]);
  return Number.isFinite(n) ? n : null;
}

function formatPlainNumber(value, { decimals = null, sig = 4 } = {}) {
  if (!Number.isFinite(value)) return "";
  if (decimals !== null) return value.toFixed(decimals);
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.001 || abs >= 10000)) {
    return value.toExponential(Math.max(sig - 1, 1)).replace(/\.?0+e/, "e");
  }
  return Number(value.toPrecision(sig)).toString();
}

function tableCell(row, idx) {
  return idx >= 0 && idx < row.length ? String(row[idx] || "").trim() : "";
}

function pendulumHeaderFlags(table) {
  const headers = table.headers || [];
  return {
    hasPendulum: findColumn(headers, ["Pendulum Type", "시편"]) >= 0,
    hasPeriod: findColumn(headers, ["Avg Period", "Period", "T (s)"]) >= 0,
    hasIpivot: findColumn(headers, ["Ipivot", "I_pivot"]) >= 0,
    hasIcm: findColumn(headers, ["Icm", "I_cm"]) >= 0,
    hasTheory: findColumn(headers, ["Calculated Rotational Inertia", "Theoretical", "이론"]) >= 0,
    hasDiff: findColumn(headers, ["%Diff", "% Difference", "% 차이", "오차"]) >= 0,
  };
}

// 데이터정리1/2 파일명 폴백을 허용할 최소한의 헤더 증거(진자/주기/이론 계열 column).
// %Diff/오차는 어떤 실험 표에나 흔해서 증거로 치지 않는다. 파일명만 같은 비진자
// 실험 엑셀이 theory-comparison 등으로 오배정되어 canonical 보정이 보고서 표를
// 오염시키는 것을 막는 안전장치다.
function hasPendulumHeaderEvidence(table) {
  const f = pendulumHeaderFlags(table);
  return f.hasPendulum || f.hasPeriod || f.hasIpivot || f.hasIcm || f.hasTheory;
}

function classifyPhysicsTable(fileName, table) {
  const sheetKey = normalizeDataKey(table.sheetName);
  const headerText = (table.headers || []).map(normalizeDataKey).join("|");
  const { hasPendulum, hasPeriod, hasIpivot, hasIcm, hasTheory, hasDiff } =
    pendulumHeaderFlags(table);

  if (hasPendulum && hasPeriod && hasIpivot && hasIcm) return "measured-period";
  if (hasPendulum && (hasTheory || hasDiff || sheetKey.includes("theoretical"))) {
    return "theory-comparison";
  }
  if (hasPendulum && hasIcm && headerText.includes("mass")) return "pendulum-data";
  // 파일명 폴백은 헤더 증거가 있을 때만 믿는다. 증거가 하나도 없으면 general 처리.
  if (hasPendulumHeaderEvidence(table)) {
    if (normalizeDataKey(fileName).includes("데이터정리2")) return "measured-period";
    if (normalizeDataKey(fileName).includes("데이터정리1")) return "theory-comparison";
  }
  return "general";
}

function buildCanonicalPhysicsData(structuredTables) {
  const canonical = {
    measured: null,
    theory: null,
    conflicts: [],
    roles: [],
  };
  const seenIcm = new Map();

  for (const item of structuredTables) {
    const { fileName, table, role } = item;
    const headers = table.headers || [];
    const pendulumCol = findColumn(headers, ["Pendulum Type", "시편"]);
    const icmCol = findColumn(headers, ["Icm", "I_cm"]);
    const roleLabel = `${fileName} / ${table.sheetName}: ${role}`;
    canonical.roles.push(roleLabel);

    // 파일명은 데이터정리1/2인데 헤더 증거가 없어 폴백이 기각된 표는 그 이유를 남긴다.
    if (
      role === "general" &&
      /데이터정리[12]/.test(normalizeDataKey(fileName)) &&
      !hasPendulumHeaderEvidence(table)
    ) {
      canonical.conflicts.push(
        `${fileName} / ${table.sheetName}: 파일명 휴리스틱-헤더 불일치로 general 처리`,
      );
    }

    if (role === "measured-period" && !canonical.measured) {
      const cols = {
        pendulum: pendulumCol,
        period: findColumn(headers, ["Avg Period", "Period", "T (s)"]),
        mass: findColumn(headers, ["Mass", "m (kg)", "질량"]),
        distance: findColumn(headers, ["Distance from Pivot", "d (m)", "Pivot"]),
        ipivot: findColumn(headers, ["Ipivot", "I_pivot"]),
        icm: icmCol,
      };
      canonical.measured = {
        source: roleLabel,
        rows: table.rows
          .filter((row) => tableCell(row, cols.pendulum))
          .map((row) => ({
            pendulum: tableCell(row, cols.pendulum),
            period: tableCell(row, cols.period),
            mass: tableCell(row, cols.mass),
            distance: tableCell(row, cols.distance),
            ipivot: tableCell(row, cols.ipivot),
            icm: tableCell(row, cols.icm),
          })),
      };
    }

    if (role === "theory-comparison" && !canonical.theory) {
      const cols = {
        pendulum: pendulumCol,
        mass: findColumn(headers, ["Mass", "m (kg)", "질량"]),
        theory: findColumn(headers, ["Calculated Rotational Inertia", "Theoretical", "이론"]),
        icm: icmCol,
        diff: findColumn(headers, ["%Diff", "% Difference", "% 차이", "오차"]),
      };
      canonical.theory = {
        source: roleLabel,
        rows: table.rows
          .filter((row) => tableCell(row, cols.pendulum))
          .map((row) => ({
            pendulum: tableCell(row, cols.pendulum),
            mass: tableCell(row, cols.mass),
            theory: tableCell(row, cols.theory),
            icm: tableCell(row, cols.icm),
            diff: tableCell(row, cols.diff),
          })),
      };
    }

    if (pendulumCol >= 0 && icmCol >= 0) {
      for (const row of table.rows || []) {
        const label = normalizeDataKey(tableCell(row, pendulumCol));
        if (!label) continue;
        const icm = parseNumberCell(tableCell(row, icmCol));
        if (!Number.isFinite(icm)) continue;
        const prev = seenIcm.get(label);
        if (prev && prev.value !== 0) {
          const ratio = Math.abs(icm / prev.value);
          if (ratio > 1.25 || ratio < 0.8) {
            canonical.conflicts.push(
              `${tableCell(row, pendulumCol)} Icm 충돌: ${prev.raw} (${prev.source}) vs ${tableCell(row, icmCol)} (${roleLabel})`,
            );
          }
        } else {
          seenIcm.set(label, {
            value: icm,
            raw: tableCell(row, icmCol),
            source: roleLabel,
          });
        }
      }
    }
  }
  return canonical;
}

// 원시 회전관성(kg·m², 보통 1e-4~1e-3대)만 10⁻⁴ 단위로 환산한다. 이미 10⁻⁴
// 스케일(예: 5.0처럼 |값|≥1)인 데이터를 또 ×1e4 해서 값이 1만 배 틀리지 않도록 가드.
function scaleInertia(n) {
  return Math.abs(n) < 1 ? n * 1e4 : n;
}

function scaledInertiaCell(rawValue) {
  const n = parseNumberCell(rawValue);
  if (!Number.isFinite(n)) return rawValue || "";
  return formatPlainNumber(scaleInertia(n), { sig: 3 });
}

function scaledInertiaNumber(rawValue) {
  const n = parseNumberCell(rawValue);
  return Number.isFinite(n) ? scaleInertia(n) : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceNarrativeText(text, corrections, measuredRange) {
  let next = String(text || "");
  let changed = false;
  const measurementContext =
    /I\s*(?:_|cm|CM)|Icm|회전관성|평행축|주기법|측정|비정형|Irregular|질량중심/.test(
      next,
    );
  if (!measurementContext) return { text: next, changed };

  for (const correction of corrections) {
    const wrong = escapeRegExp(correction.wrong);
    const correct = correction.correct;

    // 예: "0.565~3.96 × 10^-4"처럼 충돌값이 범위 하한으로 남은 경우.
    if (measuredRange) {
      const before = next;
      next = next.replace(
        new RegExp(`\\b${wrong}\\s*([~∼-])\\s*\\d+(?:\\.\\d+)?`, "g"),
        measuredRange,
      );
      next = next.replace(
        new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*([~∼-])\\s*${wrong}\\b`, "g"),
        measuredRange,
      );
      if (next !== before) changed = true;
    }

    // 예: "I_{cm} = 0.565 \times 10^{-4}"처럼 측정값 문장에 비교용 값이 남은 경우.
    const beforeScalar = next;
    next = next.replace(
      new RegExp(
        `(I\\s*(?:_\\s*\\{?\\s*(?:cm|CM)\\s*\\}?|cm|CM)[^\\n.;]{0,40}=\\s*)${wrong}\\b`,
        "g",
      ),
      `$1${correct}`,
    );
    next = next.replace(
      new RegExp(`\\b${wrong}\\s*((?:×|x|X|TIMES|\\\\times)\\s*10\\s*(?:\\^|\\{|-|⁻))`, "g"),
      `${correct} $1`,
    );
    if (next !== beforeScalar) changed = true;
  }

  return { text: next, changed };
}

function rewriteMeasuredIcmRangeSentence(text, measuredRange) {
  if (!measuredRange) return { text, changed: false };
  const source = String(text || "");
  const rangeSummary = `평행축 정리로부터 환산한 Icm은 엑셀 측정 데이터 기준 ${measuredRange}×10⁻⁴ kg·m² 범위이며`;
  const icmName = String.raw`(?:I\s*(?:_\s*\{?\s*(?:cm|CM)\s*\}?|cm|CM)|Icm|질량중심\s*회전관성)`;
  const sentencePatterns = [
    new RegExp(`평행축\\s*정리[\\s\\S]{0,240}?${icmName}[\\s\\S]{0,240}?이르며`, "g"),
    new RegExp(`평행축\\s*정리[\\s\\S]{0,240}?${icmName}[\\s\\S]{0,240}?범위(?:였|로|이며|이고)`, "g"),
    new RegExp(`${icmName}[\\s\\S]{0,160}?\\d+(?:\\.\\d+)?\\s*[~∼-]\\s*\\d+(?:\\.\\d+)?\\s*×\\s*10[\\s\\S]{0,120}?(?:범위|이르며)`, "g"),
  ];

  let next = source;
  for (const pattern of sentencePatterns) {
    next = next.replace(pattern, rangeSummary);
  }
  next = next
    .replace(
      /평행축\s*정리로부터\s*환산한\s+평행축\s*정리로부터\s*환산한/g,
      "평행축 정리로부터 환산한",
    )
    .replace(/범위이며이며/g, "범위이며");
  return { text: next, changed: next !== source };
}

function reconcilePhysicsNarrativeWithCanonicalData(parsed, canonical) {
  if (!canonical.measured?.rows?.length || !canonical.theory?.rows?.length) return 0;

  const measuredByKey = new Map();
  const measuredIcms = [];
  for (const row of canonical.measured.rows) {
    const key = normalizeDataKey(row.pendulum);
    const scaled = scaledInertiaNumber(row.icm);
    if (!key || !Number.isFinite(scaled)) continue;
    measuredByKey.set(key, { ...row, scaled });
    measuredIcms.push(scaled);
  }

  const corrections = [];
  for (const row of canonical.theory.rows) {
    const key = normalizeDataKey(row.pendulum);
    const measured = measuredByKey.get(key);
    const wrongScaled = scaledInertiaNumber(row.icm);
    if (!measured || !Number.isFinite(wrongScaled)) continue;
    if (Math.abs(measured.scaled - wrongScaled) < 1e-9) continue;
    corrections.push({
      pendulum: row.pendulum,
      wrong: formatPlainNumber(wrongScaled, { sig: 3 }),
      correct: formatPlainNumber(measured.scaled, { sig: 3 }),
    });
  }
  if (!corrections.length) return 0;

  const measuredRange = measuredIcms.length
    ? `${formatPlainNumber(Math.min(...measuredIcms), { sig: 3 })}~${formatPlainNumber(Math.max(...measuredIcms), { sig: 3 })}`
    : "";

  let changes = 0;
  const visit = (value, key = "") => {
    if (!value || typeof value !== "object") return;
    for (const [childKey, childValue] of Object.entries(value)) {
      if (["data_table", "chart", "__photos"].includes(childKey)) continue;
      if (typeof childValue === "string") {
        const result = replaceNarrativeText(childValue, corrections, measuredRange);
        if (result.changed) {
          value[childKey] = result.text;
          changes++;
        }
      } else if (childValue && typeof childValue === "object") {
        visit(childValue, childKey);
      }
    }
  };
  visit(parsed);

  const irregular = canonical.measured.rows.find((row) =>
    /irregular|비정형|긴/.test(String(row.pendulum).toLowerCase()),
  );
  const irregularScaled = irregular ? scaledInertiaCell(irregular.icm) : "";
  if (parsed.conclusion && measuredRange && irregularScaled) {
    if (typeof parsed.conclusion.result_summary === "string") {
      const result = rewriteMeasuredIcmRangeSentence(
        parsed.conclusion.result_summary,
        measuredRange,
      );
      if (result.changed) {
        parsed.conclusion.result_summary = result.text;
        changes++;
      }
    }
    if (
      typeof parsed.conclusion.result_summary === "string" &&
      !parsed.conclusion.result_summary.includes(`비정형 시편은 ${irregularScaled}`)
    ) {
      const hasMeasuredRange = parsed.conclusion.result_summary.includes(`${measuredRange}×10`);
      const summary = hasMeasuredRange
        ? ` 특히 비정형 시편은 ${irregularScaled}×10⁻⁴ kg·m²로 정리된다.`
        : ` 엑셀 측정 데이터 기준 Icm 범위는 ${measuredRange}×10⁻⁴ kg·m²이며, 비정형 시편은 ${irregularScaled}×10⁻⁴ kg·m²로 정리된다.`;
      parsed.conclusion.result_summary += summary;
      changes++;
    }
  }

  return changes;
}

function buildPhysicsDataDigest(canonical) {
  if (!canonical.roles.length) return "";
  const lines = [
    "=== 서버 구조화 데이터 요약 / 데이터 우선순위 ===",
    "아래 내용은 서버가 엑셀/CSV 헤더를 판별해 만든 역할 요약입니다. 원본 markdown 표보다 이 요약의 역할 구분을 우선하세요.",
    "",
    "역할 판별:",
    ...canonical.roles.map((r) => `- ${r}`),
    "",
    "사용 규칙:",
    "- role=measured-period 표는 측정 결과 표의 원본입니다. T, m, d, Ipivot, Icm 값을 이 표에서 그대로 가져오세요.",
    "- role=theory-comparison 표는 이론값/비교용입니다. 측정 결과 표의 Icm 값으로 섞어 쓰지 마세요.",
    "- 표 헤더를 `(10^-4 kg·m²)`로 쓰면 원본 kg·m² 값을 10^4배 해서 표시하세요. 예: 5.65E-04 kg·m² → 5.65.",
    "- 같은 시편의 같은 물리량이 파일별로 다르면 조용히 평균내거나 한쪽으로 덮어쓰지 말고, 역할에 따라 분리해서 사용하세요.",
  ];

  if (canonical.conflicts.length) {
    lines.push("", "감지된 값 충돌:");
    for (const conflict of canonical.conflicts) lines.push(`- ${conflict}`);
    lines.push("위 충돌은 보고서에서 같은 표 안에 섞으면 안 됩니다.");
  }

  if (canonical.measured?.rows?.length) {
    lines.push("", `[측정 데이터 원본] ${canonical.measured.source}`);
    lines.push("| 시편 | T(s) | m(kg) | d(m) | Ipivot(kg·m²) | Icm(kg·m²) | Icm(10^-4 kg·m²) |");
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const row of canonical.measured.rows) {
      lines.push(
        `| ${row.pendulum} | ${row.period} | ${row.mass} | ${row.distance} | ${row.ipivot} | ${row.icm} | ${scaledInertiaCell(row.icm)} |`,
      );
    }
  }

  if (canonical.theory?.rows?.length) {
    lines.push("", `[이론/비교 데이터 원본] ${canonical.theory.source}`);
    lines.push("| 시편 | 이론/계산 회전관성(kg·m²) | 비교 Icm(kg·m²) | %Diff |");
    lines.push("|---|---:|---:|---:|");
    for (const row of canonical.theory.rows) {
      lines.push(`| ${row.pendulum} | ${row.theory} | ${row.icm} | ${row.diff} |`);
    }
  }

  lines.push("=== 구조화 데이터 요약 끝 ===");
  return lines.join("\n");
}

function reconcilePhysicsContentWithCanonicalData(parsed, canonical, onProgress = () => {}) {
  if (!parsed || !Array.isArray(parsed.experiments)) return parsed;
  let changes = 0;
  // 측정 표가 들어간 실험을 기억해, 이론 표가 같은 실험을 덮어써 데이터를 잃지 않게 한다.
  let measuredTarget = null;

  if (canonical.measured?.rows?.length) {
    const measuredHeaders = [
      "시편",
      "T (s)",
      "m (kg)",
      "d (m)",
      "Ipivot (10⁻⁴ kg·m²)",
      "Icm (10⁻⁴ kg·m²)",
    ];
    const measuredRows = canonical.measured.rows.map((row) => [
      row.pendulum,
      row.period,
      row.mass,
      row.distance,
      scaledInertiaCell(row.ipivot),
      scaledInertiaCell(row.icm),
    ]);
    const target = parsed.experiments.find((exp) => {
      const table = exp?.data_table || {};
      const text = [...(table.headers || []), exp.name || ""].join(" ").toLowerCase();
      return /\bperiod\b|주기|ipivot|icm|회전관성/.test(text);
    }) || parsed.experiments[0];
    measuredTarget = target;
    if (target) {
      target.data_table = { headers: measuredHeaders, rows: measuredRows };
      changes++;
      if (!target.analysis) target.analysis = "";
      const irregular = canonical.measured.rows.find((row) => /irregular|비정형|긴/.test(String(row.pendulum).toLowerCase()));
      if (irregular) {
        const scaled = scaledInertiaCell(irregular.icm);
        if (scaled && !String(target.analysis).includes(scaled)) {
          target.analysis += `\n첨부된 측정 데이터 기준 비정형 시편의 Icm은 ${scaled}×10⁻⁴ kg·m²이다.`;
        }
      }
    }
  }

  if (canonical.theory?.rows?.length) {
    const theoryHeaders = [
      "시편",
      "이론/계산 회전관성 (10⁻⁴ kg·m²)",
      "비교 Icm (10⁻⁴ kg·m²)",
      "%Diff",
    ];
    const theoryRows = canonical.theory.rows.map((row) => [
      row.pendulum,
      Number.isFinite(parseNumberCell(row.theory)) ? scaledInertiaCell(row.theory) : row.theory,
      Number.isFinite(parseNumberCell(row.icm)) ? scaledInertiaCell(row.icm) : row.icm,
      row.diff,
    ]);
    const target = parsed.experiments.find((exp, idx) => {
      if (idx === 0) return false;
      if (exp === measuredTarget) return false; // 측정 표가 들어간 실험은 제외(덮어쓰기 방지)
      const table = exp?.data_table || {};
      const text = [...(table.headers || []), exp.name || "", exp.analysis || ""].join(" ").toLowerCase();
      return /diff|이론|비교|theory|calculated/.test(text);
    }) || parsed.experiments.find((exp, idx) => idx > 0 && exp !== measuredTarget) || null;
    if (target) {
      target.data_table = { headers: theoryHeaders, rows: theoryRows };
      changes++;
    }
  }

  if (canonical.conflicts.length) {
    Object.defineProperty(parsed, "__dataConflicts", {
      value: canonical.conflicts,
      enumerable: false,
      configurable: true,
    });
  }
  const narrativeChanges = reconcilePhysicsNarrativeWithCanonicalData(parsed, canonical);
  if (narrativeChanges) onProgress(`🧮 데이터 충돌 기반 서술 ${narrativeChanges}곳 보정`);
  if (changes) onProgress(`🧮 엑셀 원본 기준 데이터 표 ${changes}개 보정`);
  return parsed;
}

// ── 차트 추세선 서버측 검증 ─────────────────────────────────────────────────
// 모델이 scatter chart spec에 실측과 무관한 trendline(slope/intercept)을 넣으면
// 실제 데이터 위에 가공 점선이 그려진다. 렌더 직전에 시리즈 데이터로 최소제곱
// 직선을 재계산해 크게 어긋나면 되돌리고, fit할 데이터가 없으면 추세선을
// 제거한다. 이론선(label에 Theory/이론 등 명시적 이론 참조)은 실측 fit 대상이
// 아니므로 건드리지 않는다.

const THEORY_LINE_LABEL_RE = /theor|이론|ideal|expected|예측|예상/i;

function isTheoryLineLabel(label) {
  return THEORY_LINE_LABEL_RE.test(String(label || ""));
}

function chartNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// chart-gen normalizePoint와 같은 입력 형태([x, y] 배열 또는 {x, y})를 수용한다.
function numericPointList(rawPoints) {
  const points = [];
  for (const point of Array.isArray(rawPoints) ? rawPoints : []) {
    let x = null;
    let y = null;
    if (Array.isArray(point) && point.length >= 2) {
      x = chartNumber(point[0]);
      y = chartNumber(point[1]);
    } else if (point && typeof point === "object") {
      x = chartNumber(point.x);
      y = chartNumber(point.y);
    }
    if (x != null && y != null) points.push({ x, y });
  }
  return points;
}

// x·y가 모두 수치인 실측 점만 모은다. 이론선 시리즈(label 기준)는 fit 대상에서
// 제외하고, x_values가 카테고리 문자열이면 점이 모이지 않아 fit이 기각된다.
function chartMeasuredPoints(chart) {
  const series = Array.isArray(chart.series) ? chart.series : [];
  const measured = series.filter((s) => s && !isTheoryLineLabel(s.label));
  const targets = measured.length ? measured : series.filter(Boolean);
  const points = [];
  for (const s of targets) {
    const rawPoints = Array.isArray(s.points) ? s.points : Array.isArray(s.data) ? s.data : null;
    if (rawPoints) {
      points.push(...numericPointList(rawPoints));
      continue;
    }
    const values = Array.isArray(s.values) ? s.values : [];
    values.forEach((v, i) => {
      const x = chartNumber(chart.x_values?.[i]);
      const y = chartNumber(v);
      if (x != null && y != null) points.push({ x, y });
    });
  }
  return points;
}

function leastSquaresFit(points) {
  if (!Array.isArray(points) || points.length < 2) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXX += p.x * p.x;
    sumXY += p.x * p.y;
  }
  const meanXX = sumXX / n;
  const varX = meanXX - (sumX / n) ** 2;
  // x가 전부 같으면(분산 0) 직선 fit이 정의되지 않는다. 스케일 상대 기준으로 판정.
  if (!Number.isFinite(varX) || varX <= meanXX * 1e-12) return null;
  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  return { slope, intercept };
}

function relativeFitDiff(modelValue, fitValue) {
  return Math.abs(modelValue - fitValue) / Math.max(Math.abs(fitValue), 1e-12);
}

// 반환: null(변경 없음) | { action: "recomputed" } | { action: "removed" }
function reconcileChartTrendline(chart) {
  if (!chart || typeof chart !== "object" || chart.type !== "scatter") return null;
  // 렌더러(chart-gen)와 같은 우선순위로 추세선 키를 찾는다.
  const trendKey = ["trendline", "fit_line", "regression_line"].find(
    (key) => chart[key] && typeof chart[key] === "object",
  );
  if (!trendKey) return null;
  const trend = chart[trendKey];
  if (isTheoryLineLabel(trend.label)) return null;

  // 모델이 그리려던 직선. 렌더러처럼 points가 있으면 points를 우선한다.
  let modelSlope = null;
  let modelIntercept = null;
  if (Array.isArray(trend.points)) {
    const trendPoints = numericPointList(trend.points);
    if (trendPoints.length < 2) return null; // 렌더러도 그리지 않는 형태
    const modelFit = leastSquaresFit(trendPoints);
    if (modelFit) {
      modelSlope = modelFit.slope;
      modelIntercept = modelFit.intercept;
    }
    // fit 불가(수직선 등)면 null로 남겨 아래에서 실측 fit으로 교체한다.
  } else {
    modelSlope = chartNumber(trend.slope ?? trend.m);
    modelIntercept = chartNumber(trend.intercept ?? trend.b);
    if (modelSlope == null || modelIntercept == null) return null; // 렌더러도 그리지 않는 형태
  }

  const fit = leastSquaresFit(chartMeasuredPoints(chart));
  if (!fit) {
    // 수치 (x, y) 점이 2개 미만이거나 x가 비수치·전부 동일값이면 fit할 근거가 없다.
    delete chart[trendKey];
    return { action: "removed" };
  }

  const mismatch =
    modelSlope == null ||
    modelIntercept == null ||
    relativeFitDiff(modelSlope, fit.slope) > 0.2 ||
    relativeFitDiff(modelIntercept, fit.intercept) > 0.2;
  if (!mismatch) return null;

  trend.slope = fit.slope;
  trend.intercept = fit.intercept;
  // 가공 직선의 근거가 될 수 있는 값은 지우고 실측 데이터 범위로 그리게 한다.
  delete trend.m;
  delete trend.b;
  delete trend.points;
  delete trend.x_min;
  delete trend.x_max;
  delete trend.xMin;
  delete trend.xMax;
  return { action: "recomputed" };
}

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  const plainLine =
    "- 핵심 하이라이트: 관리자 전용 기능이므로 `**내용**` 마커를 사용하지 마세요. 강조가 필요하면 일반 문장으로 자연스럽게 표현하세요.";
  const boldLine =
    "- **핵심 하이라이트**: 관리자 전용 기능이므로 `**내용**` 마커를 사용하지 마세요. 강조가 필요하면 일반 문장으로 자연스럽게 표현하세요.";
  return String(text)
    .replace(/- 핵심 하이라이트: `\*\*내용\*\*`[^\n]*/g, plainLine)
    .replace(/- \*\*핵심 하이라이트\*\*: `\*\*내용\*\*`[^\n]*/g, boldLine);
}

function buildSystemPrompt({ allowHighlights = true } = {}) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const styleSection = STYLE_INSTRUCTIONS.default;
  const fivePageWarning = `

⚠️ **반드시 최대 5페이지 이내**여야 합니다. 목표는 4페이지 안팎이되, **실험 사진이 없으면 4.5~5페이지를 목표로** 채웁니다. 5쪽을 넘길 때만 짧게 압축하고, 같은 말 반복으로 빈 공간을 채우지는 않습니다(채울 때는 심화 분석·변환좌표 표·추가 그래프 등 데이터 기반 내용으로). 표·그래프·정량 해석·오차·문제 해결은 항상 유지합니다.

⚠️ **차트 이미지 내부 텍스트(전부 영어)**: chart.title, chart.x_label, chart.y_label, chart.series[].label, chart.x_values, trendline/reference_line label은 **영어로** 작성하세요(예: "Angle vs Time", "Time (s)", "Measured", "Theory", "Linear Fit"). 단위·변수 기호(°C, mL, N, m/s², 1/T, ln P, mω²)는 그대로 둡니다. **본문·표·캡션은 한국어로 쓰되, 차트(그래프) 이미지 안 글자만 영어입니다.**

⚠️ **Capstone 그래프 정의 우선**: .cap 파싱 결과에 "캡스톤 그래프 정의"가 있으면 그 안의 CSLineGraph 축, 시리즈, 선택 구간, curve fit, RMSE를 학생이 Capstone에서 실제로 구성한 그래프 정보로 취급하세요. 보고서에는 이 정의를 기준으로 서버 chart를 재구성하고, .cap의 images/* 내장 이미지를 그래프 화면으로 자동 간주하지 마세요.

⚠️ **번호 매기기**: 1.1 / 1.2 같은 dot 번호는 자동 생성. 분석 텍스트 안에서 더 세부 항목 필요하면 \`가.\`, \`나.\` → \`(1)\`, \`(2)\` 순서로 사용 (analysis 필드 안에 직접 작성).`;

  return `당신은 (영재학교)과학고등학교 일반물리학실험 결과보고서 자동 생성 도우미입니다.

서버가 입력 데이터(.cap, 엑셀/CSV/텍스트 파일)를 자동 파싱하고, 이미지 자료는 vision 입력으로 제공합니다. 이 정보와 매뉴얼 PDF(있으면)를 바탕으로 보고서를 작성하세요.${fivePageWarning}

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

## 작업 절차

1. 첨부 파일 분석 (.cap 파싱 결과, 엑셀/CSV markdown table, 텍스트 데이터, 매뉴얼 PDF, 이미지 자료).
2. 이미지 자료가 있으면 vision으로 직접 보고 실험 사진인지, 데이터표 스크린샷인지, 그래프 스크린샷인지 구분한다. 표/그래프 스크린샷이면 읽히는 숫자·축·회귀식만 데이터로 사용한다. .cap 내부 images/*는 자동 첨부하지 않으므로, Capstone에서 만든 그래프는 "캡스톤 그래프 정의" 텍스트를 기준으로 chart로 재구성한다.
3. 기본 양식 JSON 스키마로 작성.
4. JSON 출력.

${styleSection}

## 출력 형식 (매우 중요)

**최종 출력은 반드시 단 하나의 JSON 코드 블록 (\`\`\`json ... \`\`\`)입니다.** 그 외 텍스트 일체 금지.
`;
}

/**
 * Generate physics result report content.
 *
 * 입력 시나리오 (아래 중 하나 이상은 있어야 함):
 *   A) .cap 파일 (PASCO Capstone) — 자동 파싱
 *   B) 엑셀/CSV/텍스트 데이터 + (선택) 매뉴얼 PDF
 *   C) 데이터표/그래프 스크린샷
 *
 * 양식 PDF·평가기준은 모든 보고서 동일이라 코드에 내장 (사용자 입력 X).
 *
 * @param {Object} args
 * @param {Buffer|null} args.capBuffer       PASCO Capstone .cap (선택)
 * @param {string} args.capName              파일명
 * @param {Array<{buffer, name, mimetype}>} args.dataFiles  엑셀/CSV/텍스트 데이터들
 * @param {Buffer|null} args.dataBuffer      구버전 단일 엑셀/CSV 데이터
 * @param {string} args.dataName             파일명
 * @param {Buffer|null} args.manualBuffer    실험 매뉴얼 PDF (선택)
 * @param {Array<{buffer, name, mimetype}>} args.photos  실험 사진들 (선택)
 * @param {string} args.userNotes            사용자 참고 메모/의견
 * @param {string} args.date
 * @param {Function} args.onProgress
 * @param {AbortSignal} args.signal
 * @param {string|null} args.model
 */
async function generateReportContent({
  capBuffer = null,
  capName = "",
  dataFiles = [],
  dataBuffer = null,
  dataName = "",
  manualBuffer = null,
  photos = [],
  userNotes = "",
  styleRefs = [],
  styleNote = "",
  date,
  onProgress = () => {},
  signal,
  model = null,
  allowHighlights = true,
  outputFormat = "docx",
}) {
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  if (usesOpenAiCompat(model || DEFAULT_MODEL)) {
    if (!providerConfigured(model || DEFAULT_MODEL)) {
      throw new Error(
        `${model || DEFAULT_MODEL} 제공자 API 키가 서버에 설정되지 않았습니다.`,
      );
    }
  } else if (!byok.anthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const normalizedDataFiles = Array.isArray(dataFiles) ? [...dataFiles] : [];
  if (dataBuffer) {
    normalizedDataFiles.push({
      buffer: dataBuffer,
      name: dataName,
      mimetype: "",
    });
  }
  if (!capBuffer && normalizedDataFiles.length === 0 && photos.length === 0) {
    throw new Error(
      ".cap 파일, 엑셀/CSV/텍스트 데이터, 또는 데이터표·그래프 스크린샷 중 하나는 업로드해야 합니다.",
    );
  }

  const MODEL = model || DEFAULT_MODEL;
  const USE_GPT = usesOpenAiCompat(MODEL);
  const hasStyleRef = styleRef.hasStyle({ styleRefs, styleNote });
  const system =
    buildSystemPrompt({ allowHighlights }) +
    (hasStyleRef ? "\n\n" + styleRef.STYLE_SYSTEM_SECTION : "");
  onProgress(`🤖 모델: ${MODEL} | 양식: 기본${hasStyleRef ? " | 내 문체 반영" : ""}`);

  // ── 사용자 메시지 구성 ──────────────────────────────────────────────────────
  const content = [];
  const attachmentSummary = [];
  const structuredTables = [];

  // 큰 PDF(매뉴얼/양식)는 인라인 base64(요청당 32MB 한도)로 못 보내므로 Files API 로
  // 업로드해 file_id 로 참조한다. 작은 PDF 는 그대로 인라인. GPT 경로는 file_id 블록을
  // 처리하지 못하므로(model-call.js 의 toOpenAiContent 는 base64 document 만 변환) 항상
  // 인라인을 유지한다. usedFileApi 면 메시지에 files beta 헤더를 붙이고, 끝나면 정리한다.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024; // ≥4.5MB raw PDF → Files API
  const INLINE_B64_BUDGET = 18 * 1024 * 1024; // 누적 인라인 base64 상한(32MB 요청 한도 여유)
  let inlineB64Used = 0;
  let usedFileApi = false;
  const uploadedFileIds = [];
  // file_id는 키/계정 범위이므로 업로드와 finally 삭제에 같은 키를 고정한다.
  const filesApiKey = !USE_GPT ? byok.anthropicKey() : "";

  async function pushPdfBlock(buffer, fileName) {
    const b64Len = Math.ceil(buffer.length / 3) * 4;
    const tooBigInline =
      buffer.length >= FILES_API_RAW_THRESHOLD ||
      inlineB64Used + b64Len > INLINE_B64_BUDGET;
    // GPT 경로는 항상 인라인(Files API file_id 미지원).
    if (tooBigInline && !USE_GPT) {
      try {
        const fileId = await uploadFileToAnthropic(buffer, fileName, {
          signal,
          apiKey: filesApiKey,
        });
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        onProgress(
          `📤 큰 PDF 파일 업로드(Files API): ${fileName} (${Math.round((buffer.length / 1048576) * 10) / 10}MB)`,
        );
        return;
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
        // 인라인으로 폴백(요청이 32MB 를 넘으면 Anthropic 이 413 으로 막을 수 있음)
      }
    }
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: buffer.toString("base64"),
      },
    });
    inlineB64Used += b64Len;
  }

  // ── 시나리오 A: .cap 파싱 ───────────────────────────────────────────────────
  if (capBuffer) {
    onProgress(`📦 .cap 파일 파싱 중... (${Math.round(capBuffer.length / 1024)}KB)`);
    let parsedCap;
    try {
      parsedCap = await parseCap(capBuffer);
    } catch (e) {
      throw new Error(`.cap 파일 파싱 실패: ${e.message}`);
    }
    const datasetCount = Object.keys(parsedCap.datasets).length;
    onProgress(
      `✓ .cap 파싱 완료 — 페이지 ${parsedCap.pages.length}, 센서 ${parsedCap.sensors.length}, dataset ${datasetCount}, 그래프정의 ${(parsedCap.graphs || []).length}, 내장이미지 ${parsedCap.images.length}`,
    );
    const capSummary = summarizeForPrompt(parsedCap);
    content.push({
      type: "text",
      text: `=== PASCO Capstone 파일 파싱 결과 (${capName}) ===

${capSummary}

=== 파싱 결과 끝 ===

위 정보는 서버가 .cap ZIP을 풀고 main.xml과 binary 데이터를 읽어 추출한 것입니다.

⚠️ **데이터 사용 가이드 (반드시 준수)**:

1. **"## 캡스톤 사용자 입력 표" 섹션이 있으면 그게 최우선 데이터**입니다. 그 표의 각 행은 한 시편(측정 회차)에 해당하고, 보고서의 측정 데이터 표는 그 값을 **그대로 옮겨** 쓰세요. 행 순서를 바꾸거나 임의 매칭하지 마세요.

2. 사용자 입력 표에 Pendulum Type 같은 라벨 column이 있으면 그게 시편 식별자입니다. 같은 row index = 같은 시편.

3. dataset 파일명(Z_*.tmp)은 의미 없습니다. **measurement 이름으로만 판단**하세요.

4. 일부 measurement는 캡스톤이 자동 계산하는 column (Ipivot, Icm, %Diff 등)이라 .cap에 저장되지 않을 수 있습니다. **공식에 필요한 원자료(m, d, T 등)가 파싱 결과·업로드 엑셀·사용자 메모에 모두 보일 때만** 다시 계산하세요. 하나라도 없으면 값을 만들지 말고 "첨부 데이터만으로는 직접 산출하기 어렵다"고 쓰세요.

5. "측정 데이터 상세" 섹션의 다회차 run은 시계열 측정(센서 자동 기록) 또는 시편별 반복 측정입니다. 짧은 단일 run은 보통 위 사용자 입력 표와 같은 데이터의 다른 표현이므로 **표를 우선** 참조하고, 시계열은 그래프·통계 분석용으로 쓰세요.

6. 측정값은 sensor 방향성으로 음수일 수 있습니다. 부호가 물리적으로 의미 있는 각속도·변위·위상 데이터라면 부호를 보존하고, 속력·진폭·거리처럼 크기만 쓰는 물리량일 때만 절대값을 사용하세요.

7. 평균값은 제공된 mean을 그대로 쓰세요 — 일부 sample로 평균 추정 금지.

8. 부호와 단위, 유효숫자(보통 3~4자리)에 주의하세요. 사용자 입력 값의 정밀도를 그대로 보존하세요 (예: 0.089663 → 0.0897 또는 0.089663, 임의로 0.09로 반올림하지 말 것).

9. Workbook/Page 텍스트에 "Questions", "Question", "질문", "Answer"처럼 실험 중 해결해야 하는 문항이 있으면 반드시 확인하세요. 보고서에는 문답지를 그대로 복사하지 말고, 해당 질문을 해결하는 계산·근거·판단 과정을 실험 파트 분석, 결론, 문제 인식 및 해결에 자연스럽게 녹여 쓰세요. 질문에서 요구한 물리량이나 비교가 데이터로 판단 불가능하면 "첨부 데이터만으로는 직접 산출하기 어렵다"는 한계를 짧게 밝히세요.

10. 매뉴얼/워크북 절차에 등장하는 숫자(예: 20 g 추, 1000 s 스윕, 50 Hz 샘플링)는 절차 조건으로만 사용할 수 있습니다. 실제 측정 결과가 아닌 숫자로 이론값·오차율·Q값·감쇠계수·위상차를 확정하지 마세요.

11. 차트 값을 데이터에서 직접 만들 수 없고 경향 설명용으로 재구성해야 한다면 \`title\` 또는 \`y_label\`에 \`qualitative\`/\`arb. units\`를 넣고, 본문에서는 해당 차트의 y값을 실제 측정값처럼 인용하지 마세요.

12. 오차 요인의 크기(±값, %, 분해능, 거리 오차 등)는 업로드 데이터·매뉴얼·사용자 메모에 명시된 경우에만 수치로 쓰세요. 근거가 없으면 "재현성 한계", "정렬 오차 가능성"처럼 정성적으로만 설명하세요.

13. 샘플링 주기와 샘플링 주파수를 함께 쓸 때는 반드시 역수 관계를 맞추세요. 예를 들어 50 Hz는 20 ms 주기이며, 25 ms와 함께 쓰면 안 됩니다.

14. "캡스톤 그래프 정의" 섹션이 있으면 Capstone에서 만든 그래프의 축·시리즈·선택구간·피팅 결과입니다. 이 정보를 기준으로 \`chart\`를 재구성하고, images/* 내장 이미지를 그래프 화면으로 가정하지 마세요.`,
    });
    attachmentSummary.push(`.cap 파싱 결과 텍스트`);
  }

  // ── 시나리오 B: 엑셀/CSV/텍스트 파싱 ───────────────────────────────────────
  for (const dataFile of normalizedDataFiles) {
    const name = dataFile.name || "data";
    const dataExt = (name.split(".").pop() || "").toLowerCase();
    if (["xlsx", "xls", "csv"].includes(dataExt)) {
      try {
        // Markdown 입력과 canonical 보정 표를 한 번의 workbook/시트 파싱으로 만든다.
        const parsed = parseSpreadsheet(dataFile.buffer, dataExt);
        for (const table of parsed.tables || []) {
          const role = classifyPhysicsTable(name, table);
          structuredTables.push({ fileName: name, table, role });
        }
        content.push({
          type: "text",
          text: `=== 실험 데이터 (${name}, 자동 파싱됨) ===

${parsed.text}

=== 데이터 끝 ===

위 데이터를 바탕으로 분석·통계 계산·차트 생성을 수행하세요. 여러 데이터 파일이 있을 경우 파일명을 기준으로 실험 파트나 측정 조건을 구분하세요.

업로드된 엑셀/CSV/텍스트 데이터는 사용자가 .cap 원자료 중 일부를 직접 정리한 파일일 수 있습니다. 같은 물리량이 .cap 원자료와 정리 파일에 함께 있으면 정리 파일을 우선 사용하되, 데이터 제외·평균 산출·대표값 선택 이유가 사용자 메모나 파일명에서 확인될 때만 그 이유를 보고서에 반영하세요.`,
        });
        attachmentSummary.push(
          `${name} (${parsed.sheetCount}개 시트, ${parsed.totalRows}행 자동 파싱)`,
        );
      } catch (e) {
        throw new Error(`${name} 파싱 실패: ${e.message}`);
      }
    } else if (["txt", "md"].includes(dataExt)) {
      const parsedText = parseTextDataFile(dataFile.buffer);
      content.push({
        type: "text",
        text: `=== 텍스트 데이터 (${name}) ===

${parsedText.text}

=== 텍스트 데이터 끝 ===

위 텍스트가 측정값 표, 계산 기록, 그래프 해석, 실험 메모 중 무엇인지 먼저 판단하세요. 숫자·단위·조건명이 있으면 보고서 표와 분석에 반영하되, 텍스트에 없는 값은 만들지 마세요. 사용자가 직접 정리한 측정값·제외 사유·평균 계산 기록이면 .cap 원자료보다 보고서 산출 근거로 우선 고려하세요.${parsedText.truncated ? "\n\n⚠️ 원본 텍스트가 길어 앞부분만 전달되었습니다. 누락 가능성을 검토하세요." : ""}`,
      });
      attachmentSummary.push(
        `${name} (텍스트 ${parsedText.charCount.toLocaleString()}자${parsedText.truncated ? ", 일부 잘림" : ""})`,
      );
    } else {
      throw new Error(`지원하지 않는 데이터 형식: ${dataExt}. xlsx/xls/csv/txt/md만 가능합니다.`);
    }
  }

  const canonicalPhysicsData = buildCanonicalPhysicsData(structuredTables);
  const structuredDigest = buildPhysicsDataDigest(canonicalPhysicsData);
  if (structuredDigest) {
    content.push({ type: "text", text: structuredDigest });
    attachmentSummary.push("구조화 데이터 우선순위 요약");
  }

  // ── 매뉴얼 PDF (선택) — 엑셀로 입력 시 특히 권장 ──────────────────────────
  if (manualBuffer) {
    await pushPdfBlock(manualBuffer, "manual.pdf");
    attachmentSummary.push(`매뉴얼 PDF (${Math.round(manualBuffer.length / 1024)}KB)`);
  }

  // 양식 PDF — 모든 보고서 동일이라 코드에 내장
  const formBuffer = loadFormPdfBuffer();
  if (formBuffer) {
    await pushPdfBlock(formBuffer, "form.pdf");
    attachmentSummary.push(`양식 PDF (내장)`);
  }

  // 평가기준은 prompt.md에 점수표로 직접 명시 — 별도 첨부 없음

  // 실험 사진 / 데이터표·그래프 스크린샷 (vision)
  let visionImageCount = 0;
  let compressedImageCount = 0;
  let skippedImageCount = 0;
  const preparedImages = [];
  const imageOptions = getBatchImageOptions(photos.length);
  for (const [imageIndex, photo] of photos.entries()) {
    const prepared = await prepareImageForAnthropic(photo, imageOptions);
    preparedImages.push(prepared);
    content.push({
      type: "text",
      text: `=== 이미지 자료 #${imageIndex} (${photo.name}) ===
이 이미지는 실험 사진, 데이터 표 스크린샷, 그래프 스크린샷 중 하나일 수 있습니다. 표라면 행·열 제목과 숫자를 읽어 데이터로 사용하고, 그래프라면 축 이름·단위·추세·회귀식·표시된 값이 있는지 확인하세요. 이미지에서 읽히지 않는 숫자는 추정하지 마세요.`,
    });
    if (prepared.ok) {
      // 이후 문서 생성 단계도 원본 대용량 사진 대신 축소본을 사용한다.
      // Render 메모리 사용량과 최종 HWPX/DOCX 크기를 함께 낮추기 위함.
      photo.buffer = prepared.buffer;
      photo.mimetype = prepared.mediaType;
      photo.name = prepared.name;
      content.push(toAnthropicImageBlock(prepared));
      visionImageCount++;
      if (prepared.compressed) compressedImageCount++;
    } else {
      photo.buffer = null;
      skippedImageCount++;
      content.push({
        type: "text",
        text: `⚠️ 이 이미지는 Claude vision 입력에서 제외되었습니다. 이유: ${prepared.reason}`,
      });
    }
  }
  if (photos.length) {
    const details = photos.length <= 3
      ? preparedImages.map(describePreparedImage).join(", ")
      : `${photos.length}장`;
    const status = [
      `${visionImageCount}장 전송`,
      compressedImageCount ? `${compressedImageCount}장 자동 축소` : "",
      skippedImageCount ? `${skippedImageCount}장 제외` : "",
    ]
      .filter(Boolean)
      .join(", ");
    attachmentSummary.push(`이미지 자료 ${details} (${status})`);
    if (compressedImageCount) {
      onProgress(`🖼️ 큰 이미지 ${compressedImageCount}장 자동 축소 후 Claude에 전송`);
    }
    if (skippedImageCount) {
      const skipped = preparedImages
        .filter((prepared) => !prepared.ok)
        .map((prepared) => prepared.name)
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");
      onProgress(`⚠️ 이미지 ${skippedImageCount}장 전송 제외${skipped ? `: ${skipped}` : ""}`);
    }
  }

  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("사용자 참고 메모");
  }

  if (hasStyleRef) {
    content.push(...(await styleRef.buildStyleBlocks({ styleRefs, styleNote })));
    attachmentSummary.push("내 문체 참고");
  }

  // 마지막에 텍스트 지시
  const styleHints =
    `⚠️ **최대 5페이지 이내**, 목표 4페이지 안팎입니다. 65점 평가 요소(① 표/그래프 + 경향성 ② 이론연결 + 오차분석 ③ 문제 인식·해결)는 유지하세요.
⚠️ **언어 규칙**: report.title·experiments[].name·data_table.headers·caption·본문·분석은 **한국어**로 작성하세요. 단, **차트(그래프) 이미지 안 텍스트(chart의 title/x_label/y_label/x_values/series.label/trendline.label)는 영어로** 작성합니다. 단위·변수 기호(°C, mL, N, m/s², 1/T, ln P, mω²)는 그대로. 표 헤더·실험명·제목·본문은 한국어로 두고(영어 금지), **차트 라벨만 영어**로 쓰세요.
⚠️ **실험 파트 매핑**: 엑셀/CSV의 각 시트, 또는 명확히 구분되는 각 측정 조건(트랙·시편·질량조건 등)은 experiments[]의 독립 항목으로 1:1 매핑하세요. 시트/조건을 임의로 병합하거나 누락하지 마세요. method_summary에 적은 조건(예: Δm 0,9,13,17g)은 실제 표의 조건과 일치해야 합니다.
⚠️ **데이터 진실성**: 이론값은 측정 평균에서 역산하지 말고 원자료로 독립 계산하세요(모든 행 오차율이 거의 동일하면 역산 신호). 각속도(ω)·주기(T)가 있으면 표에 컬럼으로 넣고 F=mω²r로 검토하세요.`;
  content.push({
    type: "text",
    text: `위 첨부를 바탕으로 일반물리학실험 결과보고서 콘텐츠를 JSON으로 생성하세요.

**실험 날짜: ${date || "(미지정)"}**

**첨부 파일 요약:**
${attachmentSummary.map((s) => "- " + s).join("\n")}

스킬 명세에 정의된 JSON 스키마를 정확히 따르세요.

${styleHints}

최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };

  onProgress(`📤 첨부: ${attachmentSummary.join(", ")}`);

  // ── Stream + heartbeat ─────────────────────────────────────────────────────
  const startedAt = Date.now();
  let charCount = 0;
  let lastReportedChars = 0;
  let lastEventAt = Date.now();
  let textBlocksStarted = 0;
  let firstTokenSeen = false;

  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);

  const heartbeat = setInterval(() => {
    const sinceLast = (Date.now() - lastEventAt) / 1000;
    if (sinceLast >= 12) {
      const note = !firstTokenSeen
        ? `모델이 분석 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    if (usesOpenAiCompat(MODEL)) {
      const gpt = await callGptReport({
        model: MODEL,
        system,
        content,
        maxTokens: MAX_TOKENS,
        signal,
        onProgress,
      });
      finalText = gpt.text;
      firstTokenSeen = true;
      cost = calcCost({ usage: gpt.usage, webSearchCount: 0, model: MODEL });
    } else {
      // 끊김(Premature close)·길이(max_tokens) 복구 포함 스트리밍(공용 헬퍼).
      // 외부 heartbeat 는 헬퍼가 자체 heartbeat 로 대신하므로 여기서 멈춘다.
      clearInterval(heartbeat);
      const client = new Anthropic({
        apiKey: byok.anthropicKey(),
        timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃보다 길게 */,
      });
      const result = await streamWithContinuation({
        client,
        model: MODEL,
        maxTokens: MAX_TOKENS,
        system,
        userContent: userMessage,
        signal,
        betaHeaders: usedFileApi ? FILES_BETA : null,
        enableThinking: ENABLE_THINKING,
        thinkingEffort: THINKING_EFFORT,
        onProgress,
        startedAt,
      });
      finalText = result.text;
      firstTokenSeen = true;
      cost = calcCost({
        usage: result.usage,
        webSearchCount: result.webSearchCount,
        model: MODEL,
      });
    }
  } finally {
    clearInterval(heartbeat);
    // Files API 로 업로드한 PDF 정리(베스트에포트). 스트림이 끝났으니 더 이상 필요 없다.
    if (uploadedFileIds.length) {
      await Promise.all(
        uploadedFileIds.map((id) =>
          deleteAnthropicFile(id, { apiKey: filesApiKey }),
        ),
      );
    }
  }

  charCount = (finalText || "").length;
  onProgress(`✓ 응답 완료 (총 ${charCount}자, ${elapsed()}초) — JSON 파싱 중`);
  onProgress(formatCostLine(cost));

  const json = extractJson(finalText);
  if (!json) {
    throw new Error(
      "JSON 코드 블록을 찾을 수 없습니다. 응답 앞부분: " + finalText.slice(0, 300),
    );
  }

  let parsed;
  try {
    parsed = parseJsonLenient(json);
  } catch (e) {
    throw new Error("JSON 파싱 실패: " + e.message);
  }
  // Claude 출력에 섞일 수 있는 비정상 마크업 제거.
  parsed = require("../../output-sanitize").sanitize(parsed, {
    allowHighlights,
    // HWPX 출력 경로에서는 승인된 수식 placeholder({{EQ:...}}, {{EQ-LATEX:...}})를
    // 보존해 Python 후처리가 실제 한컴 수식 객체로 변환하게 한다(chem-pre/chem-result 동일).
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
  });
  const noteSanitize = sanitizePhysicsNoteOverreach(parsed, userNotes);
  parsed = noteSanitize.value;
  if (noteSanitize.changes) {
    onProgress(`🧹 사용자 메모 과대 반영 표현 ${noteSanitize.changes}개 정리`);
  }
  const unitSanitize = sanitizePhysicsUnitConsistency(parsed);
  parsed = unitSanitize.value;
  if (unitSanitize.changes) {
    onProgress(`🧮 주기-주파수 불일치 ${unitSanitize.changes}곳 보정`);
  }
  parsed = reconcilePhysicsContentWithCanonicalData(parsed, canonicalPhysicsData, onProgress);
  // 실제로 문서에 그려지는 사진(버퍼 생존)이 있는지 — docx/hwpx 렌더러의 필터 기준과 일치.
  // 사진이 없으면 그 자리를 분석으로 채우도록 페이지 제한 캡을 완화한다.
  const hasRenderablePhotos =
    Array.isArray(photos) && photos.some((p) => p && Buffer.isBuffer(p.buffer) && p.buffer.length > 0);
  parsed = enforcePhysicsPageLimit(parsed, onProgress, { hasPhotos: hasRenderablePhotos });
  if (!hasRenderablePhotos) {
    onProgress("📄 사진 없음 — 분석·표·그래프 중심으로 분량 확보(목표 4.5~5쪽)");
  }
  // 압축이 문장을 자르면서 닫는 ** 를 떨굴 수 있으므로, 압축 이후 마커 재정리.
  {
    const { balanceMarkers } = require("../../output-sanitize");
    const fixStr = (s) => (typeof s === "string" ? balanceMarkers(s) : s);
    const fixArr = (a) => (Array.isArray(a) ? a.map(fixStr) : a);
    if (parsed.conclusion && typeof parsed.conclusion === "object") {
      const c = parsed.conclusion;
      for (const k of ["objective_recap", "result_summary", "problem_solving", "physical_meaning", "theory_connection"]) {
        if (typeof c[k] === "string") c[k] = fixStr(c[k]);
      }
      if (Array.isArray(c.error_analysis)) c.error_analysis = fixArr(c.error_analysis);
    }
    if (Array.isArray(parsed.additional_investigations)) {
      parsed.additional_investigations.forEach((it) => {
        if (it && typeof it.body === "string") it.body = fixStr(it.body);
      });
    }
    if (Array.isArray(parsed.experiments)) {
      parsed.experiments.forEach((e) => {
        if (e && typeof e.analysis === "string") e.analysis = fixStr(e.analysis);
        if (e && typeof e.method_summary === "string") e.method_summary = fixStr(e.method_summary);
      });
    }
  }

  // 통계 메시지
  const stats = [];
  if (Array.isArray(parsed.experiments)) stats.push(`실험 파트 ${parsed.experiments.length}개`);

  let chartCount = 0;
  if (Array.isArray(parsed.experiments)) {
    for (const e of parsed.experiments) if (e.chart) chartCount++;
  }
  if (chartCount) stats.push(`차트 ${chartCount}개`);
  if (stats.length) onProgress(`📋 콘텐츠: ${stats.join(", ")}`);

  if (date) parsed.date = date;

  // 사진을 parsed에 attach (docx-gen이 photo_indices로 매칭)
  if (photos.length > 0) {
    Object.defineProperty(parsed, "__photos", {
      value: photos.map((p) => ({
        buffer: p.buffer,
        name: p.name,
        mimetype: p.mimetype,
      })),
      enumerable: false,
    });
  }

  // 빈 데이터 차트(스펙은 있으나 x_values·series 값이 전부 빔) 제거 — 빈 그래프 방지.
  const chartHasData = (ch) => {
    if (!ch || typeof ch !== "object") return false;
    const xs = Array.isArray(ch.x_values) ? ch.x_values.filter((v) => v !== "" && v != null) : [];
    const series = Array.isArray(ch.series) ? ch.series : [];
    const seriesHasVals = series.some((s) => {
      const vals = s && (s.values || s.data || s.points);
      return Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0;
    });
    return xs.length > 0 || seriesHasVals;
  };
  let droppedCharts = 0;
  if (Array.isArray(parsed.experiments)) {
    for (const exp of parsed.experiments) {
      if (exp.chart && !chartHasData(exp.chart)) {
        delete exp.chart;
        droppedCharts++;
      }
    }
  }
  if (droppedCharts) onProgress(`⚠️ 데이터 없는 빈 차트 ${droppedCharts}개 제외`);
  // 차트 수 재계산(빈 차트 제거 후)
  chartCount = Array.isArray(parsed.experiments) ? parsed.experiments.filter((e) => e.chart).length : 0;

  // 콘텐츠 구조 검증(DEF-010) - 파싱·sanitize·분량 보정·빈 차트 정리까지 끝난
  // 최종 콘텐츠 기준. hard 결함은 차트 PNG 렌더 전에 즉시 실패시킨다.
  require("../../output-sanitize").assertContentSchema("phys-result", parsed, {
    format: OUTPUT_FORMAT,
    onProgress,
  });

  // 차트 spec의 series에 실제로 그릴 값이 있는지 - 렌더 재실패를 fatal로 볼지
  // 판정(DEF-009). x_values만 있고 series 값이 빈 spec은 fatal 대상이 아니다.
  const chartSeriesHasValues = (ch) => {
    const series = Array.isArray(ch && ch.series) ? ch.series : [];
    return series.some((s) => {
      const vals = s && (s.values || s.data || s.points);
      return (
        Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0
      );
    });
  };

  // 차트 렌더링
  if (chartCount > 0) {
    onProgress(`📊 차트 ${chartCount}개 렌더링 중...`);
    let renderedCount = 0;
    let trendRecomputed = 0;
    let trendRemoved = 0;
    if (Array.isArray(parsed.experiments)) {
      for (const exp of parsed.experiments) {
        if (exp.chart) {
          // 렌더 직전 추세선 검증: 모델이 넣은 가공 slope/intercept를 실측 최소제곱으로 되돌린다.
          const trendCheck = reconcileChartTrendline(exp.chart);
          if (trendCheck?.action === "recomputed") trendRecomputed++;
          else if (trendCheck?.action === "removed") trendRemoved++;
          let buf = await renderChart(exp.chart);
          if (!buf) {
            // 렌더 실패를 무음 스킵하지 않는다. 알린 뒤 1회 재시도.
            onProgress(
              `⚠️ 차트 렌더 실패: ${exp.name || exp.chart.title || "이름 없는 차트"} (1회 재시도)`,
            );
            buf = await renderChart(exp.chart);
          }
          if (buf) {
            Object.defineProperty(exp.chart, "pngBuffer", {
              value: buf,
              enumerable: false,
            });
            renderedCount++;
          } else if (chartSeriesHasValues(exp.chart)) {
            // 유효 데이터가 있는 차트의 렌더 실패는 fatal(DEF-009) - 그래프 빠진
            // 보고서를 조용히 내보내지 않는다.
            throw new Error(
              `차트 렌더링 실패: ${exp.name || exp.chart.title || "이름 없는 차트"} - 잠시 후 다시 시도해 주세요.`,
            );
          } else {
            // 값 없는 spec은 기존대로 렌더 제외 + 경고.
            onProgress(
              `⚠️ 차트 렌더 재실패(그릴 값 없음, 제외): ${exp.name || exp.chart.title || "이름 없는 차트"}`,
            );
          }
        }
      }
    }
    if (trendRecomputed) onProgress(`🧮 추세선 서버 재계산 보정 ${trendRecomputed}개`);
    if (trendRemoved) onProgress(`⚠️ fit 근거 없는 추세선 ${trendRemoved}개 제거`);
    onProgress(`✓ 차트 ${renderedCount}/${chartCount}개 PNG 생성 완료`);
  }

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });

  Object.defineProperty(parsed, "__cost", {
    value: cost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__imageCost", {
    value: imageCost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__style", {
    value: "default",
    enumerable: false,
    writable: false,
  });

  return parsed;
}

// (Claude 스트리밍·끊김복구는 lib/claude-stream.js 의 streamWithContinuation,
//  JSON 추출은 동 모듈의 extractJson 을 import 해서 쓴다 — 위 generateReportContent 참고.)

module.exports = {
  generateReportContent,
  _sanitizePhysicsNoteOverreach: sanitizePhysicsNoteOverreach,
  _prepareImageForAnthropic: prepareImageForAnthropic,
  _describePreparedImage: describePreparedImage,
  _classifyPhysicsTable: classifyPhysicsTable,
  _splitTextIntoSentences: splitTextIntoSentences,
  _buildCanonicalPhysicsData: buildCanonicalPhysicsData,
  _leastSquaresFit: leastSquaresFit,
  _reconcileChartTrendline: reconcileChartTrendline,
  _buildPhysicsDataDigest: buildPhysicsDataDigest,
  _reconcilePhysicsContentWithCanonicalData: reconcilePhysicsContentWithCanonicalData,
  _enforcePhysicsPageLimit: enforcePhysicsPageLimit,
  _sanitizePhysicsUnitConsistency: sanitizePhysicsUnitConsistency,
};
