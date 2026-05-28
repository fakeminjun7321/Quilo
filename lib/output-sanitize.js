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
// 기본값은 평문으로 벗기고, HWPX 생성 경로에서만 보존한다.
const APPROVED_EQUATION_RE = /\{\{\s*(?:EQN-LATEX|EQ-LATEX|EQN|EQ)\s*:\s*([\s\S]*?)\}\}/gi;

// 승인되지 않은 wiki-style 수식 마커. HWPX 경로에서는 수식 객체로 살릴 수 있게
// `{{EQ:...}}`로 승격하고, 그 외에는 기존처럼 평문으로 벗긴다.
const LEGACY_MATH_RE = /\{\{\s*(?:MATH|FORMULA|EQUATION)\s*:\s*([\s\S]*?)\}\}/gi;

// `<...>` 형태로 단락 시작에 나오는 임의 헤더(닫는 짝 없음).
//   예: `<NaOH가 두 가지 역할을 한다> ① ...` → 헤더 제거
//   안전을 위해 **한글이 한 글자 이상 포함된** angle-bracket만 제거.
//   이유: 화학식 `<H_{2}O>` 같은 영문 전용은 보존하고, 한글 요약 헤더만
//   타깃으로 잡기 위함.
const ANGLE_HEADER_RE = /<\s*[^<>\n]*[가-힣][^<>\n]{0,80}>\s*/g;

// 특수한 케이스: `<font color=...>` 같은 인라인 스타일 태그 잔재
const STYLE_TAG_RE = /<\/?(?:font|color|style|script)\b[^>]*>/gi;

// ANSI escape sequences (혹시라도 로그에서 흘러나온 경우)
const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

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
  out = out.replace(STYLE_TAG_RE, "");
  out = out.replace(HTML_TAG_RE, "");
  if (preserveEquationPlaceholders) {
    out = out.replace(LEGACY_MATH_RE, (_, body) => `{{EQ:${body.trim()}}}`);
  } else {
    out = out.replace(APPROVED_EQUATION_RE, (_, body) => body.trim());
    out = out.replace(LEGACY_MATH_RE, (_, body) => body.trim());
  }
  // angle-bracket 헤더는 마지막에 (다른 태그 처리 후 남은 것만)
  out = out.replace(ANGLE_HEADER_RE, "");
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
  // 정제 후 양 옆 공백·중복 공백 정리 (단, 줄바꿈은 보존)
  out = out.replace(/[ \t]{2,}/g, " ").replace(/^[ \t]+|[ \t]+$/gm, "");
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

module.exports = { sanitize, sanitizeString };
