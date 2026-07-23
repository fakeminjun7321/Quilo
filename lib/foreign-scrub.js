// 해외(중국 등) 제공자로 보낼 텍스트에서 개인정보를 제거하는 방어 레이어.
//
// 배경: 중국 등 해외 서버로 데이터가 전송되는 저가·고성능 제공자(향후 도입 대비, 현재 휴면).
// 그런 제공자를 다시 붙일 때 사용자 동의 게이트와 함께 쓰되, **개인정보는 절대 전송하지
// 않는다**는 원칙을 지키기 위해 전송 직전 텍스트를 스크럽한다(model-call.js 의 foreign 분기).
//
// 중요 — 데이터 무결성:
// - 측정값·계산값(예: 4자리 숫자, 온도, 질량)은 절대 건드리지 않는다. 학번처럼 보이는
//   일반 숫자열을 뭉개면 실험 데이터가 훼손된다(CLAUDE.md 절대 금지 규칙).
// - 그래서 "패턴이 확실한 것(이메일·전화·학교명)" + "서버가 정확히 아는 값(이름·학번)"만
//   정확히 치환한다. 애매한 일반 숫자열은 손대지 않는다.
//
// 이름/학번은 원래 보고서 프롬프트에 들어가지 않지만(표지 값은 문서 렌더 단계 주입),
// 사용자 메모(userNotes)나 업로드 텍스트에 우연히 섞여 들어온 경우까지 잡기 위한 2차 방어다.

// 학교명(고정) — 공개 저장소라 일반화. 배포처가 필요하면 SCRUB_SCHOOL_NAMES(쉼표구분)로 추가.
const BASE_SCHOOL_NAMES = [];
function schoolNameTerms() {
  const extra = String(process.env.SCRUB_SCHOOL_NAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return [...BASE_SCHOOL_NAMES, ...extra];
}

// 정규식 특수문자 이스케이프.
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 텍스트 1개 스크럽.
// extraTerms: 서버가 아는 정확한 개인정보 값(이름, 학번, username 등). 정확 일치만 치환.
function scrubText(text, extraTerms = []) {
  let s = String(text == null ? "" : text);
  if (!s) return s;

  // 1) 이메일
  s = s.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[이메일]",
  );
  // 2) 한국 휴대폰/전화번호 (01X-XXXX-XXXX, 지역번호 포함 형태)
  s = s.replace(/\b01[0-9][-\s.]?\d{3,4}[-\s.]?\d{4}\b/g, "[전화번호]");
  s = s.replace(/\b0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}\b/g, "[전화번호]");

  // 3) 학교명(고정 목록)
  for (const name of schoolNameTerms()) {
    s = s.replace(new RegExp(escapeRe(name), "g"), "[학교]");
  }

  // 4) 서버가 넘겨준 정확한 개인정보 값(이름·학번 등). 정확 일치만 — 측정값 훼손 방지.
  //    2자 미만이거나 순수 흔한 토큰은 건너뛴다(과도 치환 방지).
  for (const raw of extraTerms || []) {
    const term = String(raw == null ? "" : raw).trim();
    if (term.length < 2) continue;
    s = s.split(term).join("[비공개]");
  }
  return s;
}

// Anthropic content 블록 배열에서 text 블록만 스크럽. image/document(업로드 원본)는
// 사용자가 동의한 자료라 그대로 두되, 텍스트 지시/메모의 개인정보는 제거한다.
function scrubBlocks(blocks, extraTerms = []) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((b) => {
    if (b && b.type === "text" && typeof b.text === "string") {
      return { ...b, text: scrubText(b.text, extraTerms) };
    }
    return b;
  });
}

// 시스템 프롬프트(문자열 또는 배열) 스크럽.
function scrubSystem(system, extraTerms = []) {
  if (Array.isArray(system)) {
    return system.map((b) =>
      b && typeof b === "object" && typeof b.text === "string"
        ? { ...b, text: scrubText(b.text, extraTerms) }
        : typeof b === "string"
          ? scrubText(b, extraTerms)
          : b,
    );
  }
  return scrubText(system, extraTerms);
}

module.exports = { scrubText, scrubBlocks, scrubSystem };
