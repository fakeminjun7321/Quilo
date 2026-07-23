const FONT_OPTIONS = [
  {
    id: "hamchorom-batang",
    label: "함초롬바탕",
    aliases: ["함초롬바탕", "함초롱바탕", "hamchorom-batang"],
    face: "함초롬바탕",
  },
  {
    id: "malgun-gothic",
    label: "맑은 고딕",
    aliases: ["맑은 고딕", "Malgun Gothic", "malgun-gothic"],
    face: "Malgun Gothic",
  },
  {
    id: "nanum-myeongjo",
    label: "나눔명조",
    // face must match the installed font's family name. Naver's Nanum fonts
    // register under the Korean family name (나눔명조), not "Nanum Myeongjo"
    // (with a space) — using the English-spaced name matches nothing, so
    // Word/Hancom silently fall back to the system default (맑은 고딕).
    aliases: ["나눔명조", "나눔 명조", "Nanum Myeongjo", "NanumMyeongjo", "nanum-myeongjo"],
    face: "나눔명조",
  },
  {
    id: "nanum-gothic",
    label: "나눔고딕",
    aliases: ["나눔고딕", "나눔 고딕", "Nanum Gothic", "NanumGothic", "nanum-gothic"],
    face: "나눔고딕",
  },
];

const DEFAULT_FONT_FACE = "Malgun Gothic";
// 함초롬바탕은 한컴 전용 글꼴이라 일반 PC의 MS Word(docx)에는 설치돼 있지 않다.
// docx 출력으로 요청되면 무음 fallback(맑은 고딕)을 막기 위해 서버에서 강제로
// 기본 글꼴로 다운그레이드한다(normalizeFontFaceForFormat). hwpx 출력은 그대로 유지.
const HWPX_ONLY_FONT_FACES = new Set(["함초롬바탕"]);

function normalizeFontFace(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_FONT_FACE;
  const found = FONT_OPTIONS.find((opt) =>
    opt.aliases.some((alias) => alias.toLowerCase() === raw.toLowerCase()),
  );
  return found ? found.face : DEFAULT_FONT_FACE;
}

function normalizeFontFaceForFormat(value, format = "docx") {
  const face = normalizeFontFace(value);
  if (String(format || "").trim().toLowerCase() === "hwpx") return face;
  return HWPX_ONLY_FONT_FACES.has(face) ? DEFAULT_FONT_FACE : face;
}

function fontLabelForFace(face) {
  const normalized = normalizeFontFace(face);
  return FONT_OPTIONS.find((opt) => opt.face === normalized)?.label || "맑은 고딕";
}

// 출력에 쓸 글꼴 결정. 업로드한 .hwpx 에서 감지한 글꼴(content.detected_font_face)이
// 있으면 그 사람 글꼴을 그대로 사용(설치돼 있어야 표시). 없으면 드롭다운 선택값을
// 4종 프리셋으로 정규화한다. 감지 글꼴은 실제 HWPX 의 family name 이라 그대로 신뢰.
function resolveFontFace(content) {
  const detected = content && content.detected_font_face;
  if (detected && String(detected).trim()) return String(detected).trim();
  return normalizeFontFace((content && (content.__fontFace || content.font_face)) || "");
}

module.exports = {
  DEFAULT_FONT_FACE,
  FONT_OPTIONS,
  fontLabelForFace,
  normalizeFontFace,
  normalizeFontFaceForFormat,
  resolveFontFace,
};
