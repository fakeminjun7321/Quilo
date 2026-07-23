// Claude 출력에 흔히 섞여 나오는 비정상 마크업을 보고서 텍스트에서 제거.
//
// 베타테스터 피드백 기반:
//   1. `<cite index="3-2">` 같은 HTML/XML 인용 태그
//   2. `{{MATH:...}}` 같은 wiki/MediaWiki 스타일 수식 마커
//   3. `<NaOH가 두 가지 역할을 한다>` 같은 angle-bracket 단락 헤더
//      (보통 그 다음에 ①②③ 요약이 따라옴)
//   4. ANSI escape (혹시라도)
//
// JSON 객체의 모든 string 필드에 재귀 적용. 표 셀, 캡션, 분석 단락 모두 정제.

const HTML_TAG_RE = /<\/?(?:cite|ref|sup|sub|em|strong|b|i|u|span|div|mark)\b[^>]*>/gi;

// HWPX 출력에서는 `{{EQ:...}}`, `{{EQN:...}}`, `{{EQ-LATEX:...}}`가
// 내부 수식 객체 마커로 쓰인다. docx 출력에서는 마커가 그대로 보이면 안 되므로
// 본문을 유니코드 평문으로 변환해 벗기고(stripEquationMarkersForDocx),
// HWPX 생성 경로에서만 마커를 보존한다.

// 승인되지 않은 wiki-style 수식 마커. HWPX 경로에서는 수식 객체로 살릴 수 있게
// `{{EQ:...}}`로 승격하고, 그 외에는 기존처럼 평문으로 벗긴다.
const LEGACY_MATH_RE = /\{\{\s*(?:MATH|FORMULA|EQUATION)\s*:\s*([\s\S]*?)\}\}/gi;

// `[[수식]]`, `[[수식: x^2]]` 같은 위키식 수식 placeholder는 어떤 경로에서도 금지
// (CLAUDE.md "절대 하지 말 것"). 변환기가 없어 그대로 두면 최종 문서에 raw 마커가
// 노출되므로, 내용이 있으면 평문으로 남기고 없으면 마커째 제거한다.
const WIKI_EQUATION_RE = /\[\[\s*수식\s*(?::\s*([^\]\n]*?))?\s*\]\]/g;

// `<...>` 형태로 단락 시작에 나오는 임의 헤더(닫는 짝 없음).
//   예: `<NaOH가 두 가지 역할을 한다> ① ...` → 헤더 제거
//   안전을 위해 **한글이 한 글자 이상 포함된** angle-bracket만 제거.
//   이유: 화학식 `<H_{2}O>` 같은 영문 전용은 보존하고, 한글 요약 헤더만
//   타깃으로 잡기 위함.
//   주의: 부등식("A < B", "C > D"처럼 비교 연산자로 쓰인 < >)을 헤더로 오인해
//   문장째 지우면 안 된다. 비교 연산자는 보통 양옆에 공백이 있으므로, 괄호에
//   공백이 붙지 않은 경우(= 헤더 형태 `<한글...>`)만 매칭한다.
const ANGLE_HEADER_RE = /<(?!\s)[^<>\n]*[가-힣][^<>\n]*(?<!\s)>\s*/g;

// 특수한 케이스: `<font color=...>` 같은 인라인 스타일 태그 잔재
const STYLE_TAG_RE = /<\/?(?:font|color|style|script)\b[^>]*>/gi;

// ANSI escape sequences (혹시라도 로그에서 흘러나온 경우)
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

// U+FFFD(디코딩 실패 대체 문자)·NUL·C0 제어문자 제거 (DEF-031).
// 탭(U+0009)·개행(U+000A LF / U+000D CR)은 서식 문자이므로 보존한다.
// ANSI escape 정리(ANSI_RE) "이후"에 적용해야 한다. ESC(U+001B)를 먼저 지우면
// ANSI_RE가 매칭하지 못해 "[0m" 같은 시퀀스 잔재가 본문에 남는다.
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD]/g;

// 사용자가 AI 참고 메모를 .md로 넣으면 Claude가 Markdown 서식 기호를
// 보고서 본문으로 복사하는 경우가 있다. 보고서 렌더러가 직접 지원하는
// 일부 마커(*변수*, _{아래첨자}, ^{위첨자}, 관리자 **하이라이트**)는
// 보존해야 하므로, 문제가 되는 장식 마커만 좁게 벗긴다.
const MARKDOWN_STRIKE_RE = /~~([^~\n]{1,500})~~/g;
const MARKDOWN_BOLD_STRIKE_RE = /\*\*\s*~~([^~\n]{1,500})~~\s*\*\*/g;
const MARKDOWN_UNDERSCORE_BOLD_STRIKE_RE = /__\s*~~([^~\n]{1,500})~~\s*__/g;
const MARKDOWN_INLINE_CODE_RE = /`([^`\n]{1,300})`/g;
const MARKDOWN_BOLD_RE = /\*\*([^*\n]{1,500})\*\*/g;
const MARKDOWN_UNDERSCORE_BOLD_RE = /__([^_\n]{1,500})__/g;

function sanitizeString(s, options = {}) {
  if (typeof s !== "string") return s;
  const preserveEquationPlaceholders = !!options.preserveEquationPlaceholders;
  const allowHighlights = options.allowHighlights !== false;
  let out = s;
  out = out.replace(ANSI_RE, "");
  out = out.replace(CONTROL_CHARS_RE, "");
  out = out.replace(/[\u2013\u2014\u2015]/g, "-");
  out = out.replace(STYLE_TAG_RE, "");
  out = out.replace(HTML_TAG_RE, "");
  if (preserveEquationPlaceholders) {
    out = out.replace(LEGACY_MATH_RE, (_, body) => `{{EQ:${body.trim()}}}`);
  } else {
    // DOCX 출력: 한컴 수식 객체가 없으므로 마커 본문의 LaTeX/raw 유니코드를
    // 읽기 좋은 평문 수식(∇·∫·√·π·분수, ε₀ 등)으로 변환한다. (래퍼만 벗기고
    // 본문을 그대로 두면 '\nabla \cdot E' 가 글자로 노출됨)
    //
    // 중괄호 균형을 맞춰 본문을 추출한다 — 정규식 `([\s\S]*?)\}\}` 는
    // \frac{a}{b}·x^{2}} 처럼 본문에 `}}`가 생기면 첫 `}}`에서 잘려 식이 깨졌다.
    const { stripEquationMarkersForDocx } = require("./latex-to-unicode");
    out = stripEquationMarkersForDocx(out);
  }
  // `[[수식]]` 위키 마커는 승인되지 않은 형식이라 보존 경로에서도 항상 제거.
  out = out.replace(WIKI_EQUATION_RE, (_, body) => (body ? body.trim() : ""));
  // angle-bracket 헤더는 마지막에 (다른 태그 처리 후 남은 것만).
  // 단, `<그림 3>`·`<표 1>`·`<사진 2>` 같은 그림/표 상호참조는 헤더가 아니므로 보존.
  out = out.replace(ANGLE_HEADER_RE, (m) => {
    const inner = (m.match(/<([^<>\n]*)>/) || ["", ""])[1].trim();
    if (/^(?:그림|표|사진|도표|식|fig\.?|figure|table)\s*\d/i.test(inner)) return m;
    return "";
  });
  // Markdown 입력 파일에서 딸려온 장식 기호 제거.
  // 순서 중요: **~~내용~~** → 내용, **내용** → (비관리자면) 내용
  out = out
    .replace(MARKDOWN_BOLD_STRIKE_RE, "$1")
    .replace(MARKDOWN_UNDERSCORE_BOLD_STRIKE_RE, "$1");
  out = out.replace(MARKDOWN_STRIKE_RE, "$1").replace(/~~/g, "");
  out = out.replace(MARKDOWN_INLINE_CODE_RE, "$1");
  if (!allowHighlights) {
    out = out
      .replace(MARKDOWN_BOLD_RE, "$1")
      .replace(MARKDOWN_UNDERSCORE_BOLD_RE, "$1")
      .replace(/\*\*/g, "")
      .replace(/__/g, "");
  }
  // 미매칭(닫히지 않은) 강조 마커 정리 — GPT 가 ** 를 안 닫거나 * 를 홀수개
  // 남기면 렌더러가 그대로 노출한다. 짝이 안 맞는 잉여 마커를 평문화한다.
  out = balanceMarkers(out);
  // 정제 후 양 옆 공백·중복 공백 정리 (단, 줄바꿈은 보존)
  out = out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "");
  return out;
}

// 한 문자열 안에서 ** / * 마커의 개수가 홀수면(=닫히지 않음) 마지막 잉여 마커를
// 제거해 raw 마커 노출을 막는다. well-formed 한 짝은 그대로 둬서 렌더러가 처리.
function balanceMarkers(str) {
  let out = str;
  // 1) ** (굵게/하이라이트): 홀수면 마지막 ** 제거
  const doubles = out.match(/\*\*/g);
  if (doubles && doubles.length % 2 === 1) {
    const idx = out.lastIndexOf("**");
    out = out.slice(0, idx) + out.slice(idx + 2);
  }
  // 2) 단일 * (기울임): ** 를 잠시 치환해 제외한 뒤 홀수면 마지막 * 제거
  const PH = "\uE000BOLD\uE001";
  let tmp = out.replace(/\*\*/g, PH);
  const singles = tmp.match(/\*/g);
  if (singles && singles.length % 2 === 1) {
    const idx = tmp.lastIndexOf("*");
    tmp = tmp.slice(0, idx) + tmp.slice(idx + 1);
    out = tmp.split(PH).join("**");
  }
  return out;
}

function sanitize(value, options = {}) {
  if (value == null) return value;
  if (typeof value === "string") return sanitizeString(value, options);
  if (Array.isArray(value)) return value.map((v) => sanitize(v, options));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, options);
    return out;
  }
  return value;
}

// ── 콘텐츠 스키마 검증 배선 (DEF-010 / W2-A) ────────────────────────────────
// lib/content-schema.js 의 validateContent 를 각 파이프라인의 파싱·sanitize 완료
// 지점에서 호출하는 공통 래퍼.
//   - hardFailures: 렌더러가 빈 문서/깨진 문서를 만들게 되는 결함. 즉시 throw 해서
//     기존 오류 흐름(사용자 재시도 안내)과 동일하게 실패시킨다.
//   - warnings: 품질성 결함. 진행 로그로 1줄 요약(최대 2건 표시).
//   - 스키마 로드 실패/알 수 없는 type 같은 "검증 인프라" 오류는 보고서 생성 자체를
//     막지 않고 진행 로그로만 알린다.
// 메시지에 긴 하이픈이 섞이지 않도록 ASCII 하이픈으로 정규화한다.
function assertContentSchema(type, content, { format, onProgress } = {}) {
  const progress = typeof onProgress === "function" ? onProgress : () => {};
  const plainDash = (s) =>
    String(s == null ? "" : s).replace(/[\u2013\u2014\u2015]/g, "-");
  let result;
  try {
    const { validateContent } = require("./content-schema");
    result = validateContent(type, content, { format });
  } catch (e) {
    progress(`⚠️ 콘텐츠 구조 검증 건너뜀: ${plainDash(e && e.message)}`);
    return null;
  }
  const summarize = (list, max) => {
    const shown = list
      .slice(0, max)
      .map((f) => plainDash(`${f.path}: ${f.detail}`))
      .join(" / ");
    const rest = list.length > max ? ` 외 ${list.length - max}건` : "";
    return shown + rest;
  };
  if (Array.isArray(result.hardFailures) && result.hardFailures.length > 0) {
    throw new Error(
      `생성 결과 구조 오류: ${summarize(result.hardFailures, 3)}. 다시 시도해 주세요.`,
    );
  }
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    progress(`⚠️ 구조 경고: ${summarize(result.warnings, 2)}`);
  }
  return result;
}

module.exports = { sanitize, sanitizeString, balanceMarkers, assertContentSchema };
