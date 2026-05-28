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
    aliases: ["나눔명조", "나눔 명조", "Nanum Myeongjo", "nanum-myeongjo"],
    face: "Nanum Myeongjo",
  },
  {
    id: "nanum-gothic",
    label: "나눔고딕",
    aliases: ["나눔고딕", "나눔 고딕", "Nanum Gothic", "nanum-gothic"],
    face: "Nanum Gothic",
  },
];

const DEFAULT_FONT_FACE = "Malgun Gothic";
const HWPX_ONLY_FONT_FACES = new Set();

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

module.exports = {
  DEFAULT_FONT_FACE,
  FONT_OPTIONS,
  fontLabelForFace,
  normalizeFontFace,
  normalizeFontFaceForFormat,
};
