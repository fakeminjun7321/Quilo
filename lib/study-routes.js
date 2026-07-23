const express = require("express");
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const rateLimit = require("./rate-limit");
const { toOpenAiContent } = require("./model-call");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
  describePreparedImage,
} = require("./anthropic-media");

const FEATURE_KEY = "relativity-study";
const DEFAULT_MODEL = process.env.STUDY_RELATIVITY_MODEL || "auto";
const GPT_BASE = (process.env.GPT_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
const GPT_REASONING_EFFORT = process.env.STUDY_RELATIVITY_GPT_REASONING_EFFORT || "low";
const MAX_TOKENS = parseInt(process.env.STUDY_RELATIVITY_MAX_TOKENS || "2400", 10);
const MAX_DESCRIPTION_CHARS = 5000;

const STUDY_MODELS = [
  { id: "auto", label: "자동 선택", provider: "auto" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openai" },
  { id: "gpt-5.4", label: "GPT-5.4", provider: "openai" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
];
const ALLOWED_MODEL_IDS = new Set(STUDY_MODELS.map((m) => m.id));
const DEFAULT_AUTO_LADDER = ["gpt-5.4-mini", "gpt-5.4", "gpt-5.5", "claude-sonnet-5", "claude-opus-4-8"];
const AUTO_LADDER = String(process.env.STUDY_RELATIVITY_AUTO_MODELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => ALLOWED_MODEL_IDS.has(s) && s !== "auto");
const EFFECTIVE_AUTO_LADDER = AUTO_LADDER.length ? AUTO_LADDER : DEFAULT_AUTO_LADDER;
const DIAGRAM_TYPES = new Set([
  "",
  "minkowski-clean",
  "length-contraction",
  "time-dilation",
  "simultaneity",
  "twin-paradox",
  "light-signal",
  "muon-frame-length-contraction",
]);
// diagramType별로 보정/불변 쌍곡선을 그릴지(브라우저와 공유하는 의미). 동시성/빛신호/clean은 무의미하므로 제외.
const HYPERBOLA_TYPES = new Set([
  "length-contraction",
  "time-dilation",
  "twin-paradox",
  "muon-frame-length-contraction",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.STUDY_RELATIVITY_IMAGE_MAX_MB || "12", 10) * 1024 * 1024,
    files: 1,
    parts: 8,
  },
});

const SYSTEM_PROMPT = `당신은 특수상대론 상황을 "민코프스키 평면 도식 명세(JSON)"로 바꾸는 한국어 학습 보조 AI입니다.

반드시 JSON 객체 하나만 출력하세요. JSON 밖에 Markdown, 코드펜스, SVG, HTML, 설명 문단을 쓰면 안 됩니다.
그림은 당신이 그리지 않습니다. 좌표·사건·세계선·측정선만 구조화하면 브라우저가 수학적으로 그립니다.

[좌표계와 기울기]
- c=1, 가로축 x, 세로축 ct. 핵심 사건은 가능하면 1사분면(x>=0, ct>=0)에 배치하세요.
- "기울기"는 (x,ct) 평면에서 d(ct)/dx 입니다. 다음 규칙을 반드시 지키세요.
  - 빛(광선): 기울기 ±1.
  - 드로잉 프레임에 "정지"한 물체의 세계선: 수직(x=일정).
  - 속도 β로 "움직이는" 물체의 세계선: 기울기 1/β (|기울기|>1, 시간꼴). 절대 기울기 β가 아닙니다.
  - 드로잉 프레임의 동시선(그 프레임의 '지금', ct=일정): 수평(기울기 0).
  - 움직이는 프레임의 동시선(그 프레임의 '지금'): 기울기 β (|기울기|<1).
- β(=v/c)는 문제에 값이 있으면 -0.95~0.95로 넣고, eta=atanh(β)도 계산해 넣으세요.

[데이터 무결성 — 매우 중요]
- 문제(사진/텍스트)에 분명히 보이는 숫자만 쓰세요. 보이지 않거나 없는 측정값은 절대 지어내지 마세요.
- 속도가 없으면 도식용 β=0.5(운동 방향 부호만 맞춤)를 쓰고 assumptions에 "문제에 속도 없음 → 도식용 β=0.5"처럼 명시하세요.
- 거리/시간 수치가 없으면 비율만 보이게 정성적 좌표를 쓰고, 그 값이 도식용임을 assumptions에 적으세요.
- 사진에서 못 읽은 값은 warnings에 적으세요. "없음"처럼 빈 항목은 넣지 마세요.

[단순함 — "딱 보고 이해"되는 최소 도식]
- 핵심 사건 2~4개, 핵심 세계선 2~4개, 측정선 1~3개만. 장식·보조선·불필요한 빛신호를 만들지 마세요.
- 그래프 안 라벨(annotations)은 3개 이내, 매우 짧게. 자세한 설명은 explanation(캡션)에 1~2문장, 160자 이내로.
- 좌표축(x, ct, x', ct')은 브라우저가 그립니다. worldlines/segments에 좌표축을 넣지 마세요.
- 보정/불변 쌍곡선도 브라우저가 알아서 그립니다(길이수축·시간지연·쌍둥이). annotations에 쌍곡선을 직접 넣지 마세요.

[측정선(segments) — 핵심]
- 측정선은 "무엇을, 어느 프레임의 같은 '지금'에서 재는가"를 보여줍니다. 길이/시간/동시성 비교는 반드시 측정선으로 넣으세요.
- 각 segment에 simultaneity를 주면 서버가 동시선 기울기를 β로 정확히 보정합니다.
  - "rest" = 드로잉 프레임의 지금 → 수평(기울기 0).
  - "moving" = 움직이는 프레임의 지금 → 기울기 β.
  - 동시선과 무관한 측정선(예: 빛신호 왕복시간)은 simultaneity를 생략하고 from/to로 직접 주세요.

[세계선 태그]
- 직선 세계선에는 kind를 주면 서버가 기울기를 정확히 맞춥니다: "vertical"(정지·수직), "moving"(기울기 1/β, 방향은 points 부호 유지), "light"(±1).
- 쌍둥이 역설처럼 꺾인 세계선은 kind를 주지 말고 points로 직접 표현하세요(가는 다리 기울기 1/β, 오는 다리 -1/β).

[프레임]
- frame: { "drawnIn": "S" 또는 "Sprime", "beta": β, "movingLabel": "..." } 로 어느 관성계를 똑바로 세워 그리는지 적으세요(선택).
- 길이수축은 보통 막대 정지계(S), 뮤온 길이수축은 뮤온계(Sprime)에서 그리면 직관적입니다.

[diagramType]
- "length-contraction", "time-dilation", "simultaneity", "twin-paradox", "light-signal", "muon-frame-length-contraction", "minkowski-clean" 중 하나.

[개념별 최소 도식]
- 길이수축(막대 정지계 S): 막대 양끝 수직 세계선 2개(kind:"vertical"), 수평 고유길이 측정선(simultaneity:"rest"), 기울기 β 수축길이 측정선(simultaneity:"moving").
- 뮤온 길이수축(뮤온계 Sprime, drawnIn:"Sprime"): 뮤온 수직 세계선(kind:"vertical"), 지면/생성고도 세계선(kind:"moving", 다가옴), 수평 수축거리 D=D0/γ(simultaneity:"rest"), 기울기 β 고유거리 D0(simultaneity:"moving").
- 시간지연: 정지계 세계선 수직(kind:"vertical"), 움직이는 시계 세계선(kind:"moving"), 고유시간 Δτ(시계 세계선 따라), 좌표시간 Δt(정지계, 수직).
- 동시성: 두 번개 사건은 같은 ct, 관찰자 세계선(kind:"moving"), S 동시 측정선(simultaneity:"rest", 수평), S'의 지금 측정선(simultaneity:"moving", dashed:true).
- 쌍둥이: 지구 세계선 수직(kind:"vertical"), 여행자 꺾인 세계선 points 3개 [(0,0),(xmax,ct_turn),(0,2*ct_turn)], 꺾임 사건 T.
- 빛신호: 관찰자 수직 세계선(kind:"vertical"), 나가는 빛(kind:"light", +1), 되돌아오는 빛(kind:"light", -1), 반사 사건.

[출력 스키마]
{
  "diagramType": "length-contraction",
  "title": "짧은 제목",
  "beta": 0.6,
  "eta": 0.6931,
  "frame": { "drawnIn": "S", "beta": 0.6, "movingLabel": "관찰자 S'" },
  "events": [ { "id": "O", "label": "원점", "x": 0, "t": 0, "color": "#0f9d6b" } ],
  "worldlines": [
    { "id": "end1", "label": "막대 왼끝", "kind": "vertical", "color": "#2563eb", "points": [{ "x": 0, "t": -1 }, { "x": 0, "t": 8 }] }
  ],
  "segments": [
    { "label": "고유길이 L0", "kind": "bracket", "simultaneity": "rest", "from": { "x": 0, "t": 0 }, "to": { "x": 8, "t": 0 }, "color": "#047857" }
  ],
  "annotations": [],
  "explanation": "그래프 아래에 붙일 1~2문장 한국어 캡션",
  "assumptions": ["문제에 속도 없음 → 도식용 β=0.6"],
  "warnings": []
}

세계선 points는 두 개 이상으로 표현하세요(꺾인 세계선은 3개). 기울기가 약간 틀려도 kind/simultaneity 태그를 주면 서버가 β로 정확히 보정합니다.`;

function gptKey() {
  return process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
}

function modelInfo(id) {
  return STUDY_MODELS.find((m) => m.id === id) || null;
}

function providerAvailable(provider) {
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!gptKey();
  if (provider === "auto") return EFFECTIVE_AUTO_LADDER.some((id) => {
    const m = modelInfo(id);
    return m && providerAvailable(m.provider);
  });
  return false;
}

function availableModelPayload() {
  return STUDY_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    available: providerAvailable(m.provider),
  }));
}

function resolveRequestedModel(value) {
  const requested = String(value || DEFAULT_MODEL || "auto").trim();
  return ALLOWED_MODEL_IDS.has(requested) ? requested : "auto";
}

function candidateModels(requested) {
  if (requested === "auto") {
    return EFFECTIVE_AUTO_LADDER.filter((id) => {
      const m = modelInfo(id);
      return m && providerAvailable(m.provider);
    });
  }
  const m = modelInfo(requested);
  if (!m || !providerAvailable(m.provider)) return [];
  return [requested];
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeText(value, max = 200) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function normalizeColor(value, fallback) {
  const s = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : fallback;
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI가 빈 응답을 반환했습니다.");
  try {
    return JSON.parse(raw);
  } catch (_) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error("AI 응답에서 JSON 객체를 찾지 못했습니다.");
  }
}

function normalizePoint(point, fallback = { x: 0, t: 0 }) {
  return {
    x: clamp(finiteOr(point && point.x, fallback.x), -20, 20),
    t: clamp(finiteOr(point && point.t, fallback.t), -20, 20),
  };
}

function normalizeSimultaneity(value) {
  const s = safeText(value, 16).toLowerCase();
  return s === "rest" || s === "moving" ? s : "";
}

function normalizeSegment(segment, idx) {
  const from = normalizePoint(segment && segment.from);
  const to = normalizePoint(segment && segment.to, { x: from.x + 1, t: from.t });
  const rawKind = safeText(segment && segment.kind, 16).toLowerCase();
  const kind = ["line", "arrow", "bracket"].includes(rawKind) ? rawKind : "line";
  return {
    label: safeText((segment && segment.label) || `측정선 ${idx + 1}`, 48),
    kind,
    simultaneity: normalizeSimultaneity(segment && segment.simultaneity),
    from,
    to,
    color: normalizeColor(segment && segment.color, idx % 2 ? "#c75a2a" : "#047857"),
    dashed: !!(segment && segment.dashed),
  };
}

function normalizeWorldlineKind(value) {
  const s = safeText(value, 16).toLowerCase();
  return ["vertical", "moving", "light"].includes(s) ? s : "";
}

function normalizeFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  const drawnIn = safeText(frame.drawnIn, 12).toLowerCase();
  const out = {};
  if (drawnIn === "s" || drawnIn === "sprime") out.drawnIn = drawnIn === "sprime" ? "Sprime" : "S";
  if (Number.isFinite(Number(frame.beta))) out.beta = clamp(Number(frame.beta), -0.95, 0.95);
  const label = safeText(frame.movingLabel, 32);
  if (label) out.movingLabel = label;
  return Object.keys(out).length ? out : null;
}

function isCoordinateAxisWorldline(wl) {
  const s = `${wl && wl.id ? wl.id : ""} ${wl && wl.label ? wl.label : ""}`.toLowerCase();
  return /(x['′]\s*축|ct['′]\s*축|xprime|ctprime|xp_axis|ctp_axis|coordinate axis|좌표축)/i.test(s);
}

function isMuonFrameLengthPrompt(text) {
  const s = String(text || "").toLowerCase().replace(/\s+/g, "");
  const hasMuon = /뮤온|muon/.test(s);
  const hasLength = /길이수축|수축|lengthcontraction/.test(s);
  const hasFrame = /frame|프레임|뮤온계|s['′]?|관성계/.test(s);
  const hasGround = /지면|땅|ground|earth|거리|사이/.test(s);
  return hasMuon && hasLength && hasFrame && hasGround;
}

function normalizedPrompt(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, "");
}

function inferPromptKind(text) {
  const s = normalizedPrompt(text);
  if (!s) return "";
  const twin = /쌍둥이|쌍동이|twin/.test(s);
  const light = /빛신호|광신호|광원뿔|광추|레이더|radar|lightsignal|빛.*왕복|왕복.*빛/.test(s);
  const length = /길이수축|수축된길이|고유길이|lengthcontraction|contractedlength|properlength/.test(s);
  const time = /시간지연|수명|고유시간|propertime|timedilation|lifetime/.test(s);
  const simultaneity = /동시성|동시|simultaneity|번개|열차.*번개|lightning/.test(s);
  if (twin) return "twin-paradox";
  if (light) return "light-signal";
  if (length) return "length-contraction";
  if (time) return "time-dilation";
  if (simultaneity) return "simultaneity";
  return "";
}

// 폴백 템플릿은 모두 β로 일관된, 물리적으로 옳은 좌표를 쓴다.
// (kind/simultaneity 태그를 함께 달아 applyRelativityGeometry가 기울기를 한 번 더 보정한다.)
function muonFrameLengthTemplate() {
  return {
    diagramType: "muon-frame-length-contraction",
    title: "뮤온계에서 본 길이수축",
    beta: 0.6,
    eta: Math.atanh(0.6),
    frame: { drawnIn: "Sprime", beta: 0.6, movingLabel: "지구계 S" },
    events: [
      { id: "O", label: "뮤온 생성", x: 0, t: 0, color: "#0f9d6b" },
      { id: "G", label: "지면(지금)", x: 8, t: 0, color: "#6b7280" },
    ],
    worldlines: [
      { id: "muon", label: "뮤온(정지)", kind: "vertical", color: "#1d5fbf", points: [{ x: 0, t: -1 }, { x: 0, t: 8 }] },
      { id: "ground", label: "지면(다가옴)", kind: "moving", color: "#15946b", points: [{ x: 8, t: 0 }, { x: 3.2, t: 8 }] },
    ],
    segments: [
      { label: "수축거리 D=D0/γ", kind: "bracket", simultaneity: "rest", from: { x: 0, t: 0 }, to: { x: 8, t: 0 }, color: "#047857" },
      { label: "고유거리 D0", kind: "arrow", simultaneity: "moving", from: { x: 0, t: 0 }, to: { x: 10, t: 6 }, color: "#c75a2a", dashed: true },
    ],
    annotations: [],
    explanation: "뮤온계에서는 뮤온이 정지하고 지면이 다가옵니다. 같은 t′=0(뮤온의 지금)으로 잰 거리는 지구계 고유거리 D0가 아니라 D0/γ로 짧아집니다.",
    assumptions: ["문제에 속도 없음 → 도식용 β=0.6", "D0=10, D=8은 비율 설명용 도식값"],
    warnings: [],
  };
}

function lengthContractionTemplate() {
  return {
    diagramType: "length-contraction",
    title: "움직이는 관찰자가 본 길이수축",
    beta: 0.6,
    eta: Math.atanh(0.6),
    frame: { drawnIn: "S", beta: 0.6, movingLabel: "관찰자 S'" },
    events: [
      { id: "O", label: "왼끝(지금)", x: 0, t: 0, color: "#0f9d6b" },
      { id: "P", label: "오른끝(S 지금)", x: 8, t: 0, color: "#6b7280" },
      { id: "Q", label: "오른끝(S′ 지금)", x: 8, t: 4.8, color: "#c0562b" },
    ],
    worldlines: [
      { id: "end_left", label: "막대 왼끝", kind: "vertical", color: "#2563eb", points: [{ x: 0, t: -1 }, { x: 0, t: 9 }] },
      { id: "end_right", label: "막대 오른끝", kind: "vertical", color: "#2563eb", points: [{ x: 8, t: -1 }, { x: 8, t: 9 }] },
      { id: "observer", label: "관찰자 S'", kind: "moving", color: "#1d5fbf", points: [{ x: 0, t: 0 }, { x: 4.8, t: 8 }] },
    ],
    segments: [
      { label: "고유길이 L0", kind: "bracket", simultaneity: "rest", from: { x: 0, t: 0 }, to: { x: 8, t: 0 }, color: "#047857" },
      { label: "수축길이 L0/γ", kind: "arrow", simultaneity: "moving", from: { x: 0, t: 0 }, to: { x: 8, t: 4.8 }, color: "#c75a2a", dashed: true },
    ],
    annotations: [],
    explanation: "막대 정지계에서 두 끝은 수직선입니다. S의 지금(수평)으로 재면 고유길이 L0, 움직이는 관찰자 S′의 지금(기울기 β)으로 재면 더 짧은 L0/γ가 보입니다.",
    assumptions: ["문제에 속도 없음 → 도식용 β=0.6", "L0=8은 비율 설명용 도식값"],
    warnings: [],
  };
}

function timeDilationTemplate() {
  return {
    diagramType: "time-dilation",
    title: "움직이는 시계의 시간지연",
    beta: 0.6,
    eta: Math.atanh(0.6),
    frame: { drawnIn: "S", beta: 0.6, movingLabel: "움직이는 시계 S'" },
    events: [
      { id: "O", label: "출발", x: 0, t: 0, color: "#0f9d6b" },
      { id: "A", label: "시계 1틱", x: 4.8, t: 8, color: "#c0562b" },
      { id: "B", label: "정지계 같은 시각", x: 0, t: 8, color: "#1d5fbf" },
    ],
    worldlines: [
      { id: "lab", label: "정지 관찰자", kind: "vertical", color: "#1d5fbf", points: [{ x: 0, t: -1 }, { x: 0, t: 9 }] },
      { id: "clock", label: "움직이는 시계", kind: "moving", color: "#c75a2a", points: [{ x: 0, t: 0 }, { x: 4.8, t: 8 }] },
    ],
    segments: [
      { label: "고유시간 Δτ", kind: "arrow", from: { x: 0, t: 0 }, to: { x: 4.8, t: 8 }, color: "#c75a2a" },
      { label: "좌표시간 Δt=γΔτ", kind: "bracket", from: { x: 0, t: 0 }, to: { x: 0, t: 8 }, color: "#1d5fbf" },
    ],
    annotations: [],
    explanation: "정지계에서 본 도표입니다. 기울어진 세계선을 따라 잰 시계의 고유시간 Δτ는 짧고, 정지계가 같은 위치(x=0)에서 읽는 좌표시간은 Δt=γΔτ로 더 깁니다.",
    assumptions: ["문제에 속도 없음 → 도식용 β=0.6"],
    warnings: [],
  };
}

function simultaneityTemplate() {
  return {
    diagramType: "simultaneity",
    title: "동시성의 상대성",
    beta: 0.55,
    eta: Math.atanh(0.55),
    frame: { drawnIn: "S", beta: 0.55, movingLabel: "열차 S'" },
    events: [
      { id: "L", label: "왼쪽 번개", x: 3, t: 5, color: "#0f9d6b" },
      { id: "R", label: "오른쪽 번개", x: 10, t: 5, color: "#0f9d6b" },
      { id: "O", label: "열차 중앙", x: 6.5, t: 0, color: "#1d5fbf" },
    ],
    worldlines: [
      { id: "left", label: "왼쪽 위치", kind: "vertical", color: "#6b7280", points: [{ x: 3, t: 0 }, { x: 3, t: 9 }] },
      { id: "right", label: "오른쪽 위치", kind: "vertical", color: "#6b7280", points: [{ x: 10, t: 0 }, { x: 10, t: 9 }] },
      { id: "observer", label: "열차 관찰자", kind: "moving", color: "#1d5fbf", points: [{ x: 6.5, t: 0 }, { x: 11, t: 9 }] },
    ],
    segments: [
      { label: "S 동시", kind: "line", simultaneity: "rest", from: { x: 3, t: 5 }, to: { x: 10, t: 5 }, color: "#047857" },
      { label: "S′ 지금", kind: "line", simultaneity: "moving", from: { x: 2, t: 0.6 }, to: { x: 11, t: 0 }, color: "#c75a2a", dashed: true },
    ],
    annotations: [],
    explanation: "S에서 같은 시각(수평선)에 일어난 두 번개도, 열차계 S′의 '지금' 선(기울기 β)에서는 한 선에 못 올라 동시가 아닙니다.",
    assumptions: ["문제에 속도 없음 → 도식용 β=0.55"],
    warnings: [],
  };
}

function twinParadoxTemplate() {
  return {
    diagramType: "twin-paradox",
    title: "쌍둥이 역설",
    beta: 0.6,
    eta: Math.atanh(0.6),
    frame: { drawnIn: "S", beta: 0.6, movingLabel: "여행자 쌍둥이" },
    events: [
      { id: "O", label: "출발", x: 0, t: 0, color: "#0f9d6b" },
      { id: "T", label: "회항", x: 6, t: 10, color: "#c0562b" },
      { id: "R", label: "재회", x: 0, t: 20, color: "#1d5fbf" },
    ],
    worldlines: [
      { id: "earth", label: "지구 쌍둥이", kind: "vertical", color: "#1d5fbf", points: [{ x: 0, t: 0 }, { x: 0, t: 20 }] },
      { id: "traveler", label: "여행자", color: "#c75a2a", points: [{ x: 0, t: 0 }, { x: 6, t: 10 }, { x: 0, t: 20 }] },
    ],
    segments: [
      { label: "건너뛴 지구 시간", kind: "bracket", from: { x: 0, t: 6.4 }, to: { x: 0, t: 13.6 }, color: "#b45309", dashed: true },
    ],
    annotations: [],
    explanation: "지구 쌍둥이는 곧은 세계선(긴 고유시간), 여행자는 꺾인 세계선(짧은 고유시간)입니다. 회항 사건에서 여행자의 '지금'이 점프하며 비대칭이 생깁니다.",
    assumptions: ["문제에 속도 없음 → 도식용 β=0.6"],
    warnings: [],
  };
}

function lightSignalTemplate() {
  return {
    diagramType: "light-signal",
    title: "빛 신호 왕복(레이더)",
    beta: 0.5,
    eta: Math.atanh(0.5),
    frame: { drawnIn: "S", beta: 0.5, movingLabel: "표적" },
    events: [
      { id: "E", label: "송신", x: 0, t: 2, color: "#0f9d6b" },
      { id: "M", label: "반사", x: 5, t: 7, color: "#c0562b" },
      { id: "F", label: "수신", x: 0, t: 12, color: "#1d5fbf" },
    ],
    worldlines: [
      { id: "observer", label: "관찰자", kind: "vertical", color: "#1d5fbf", points: [{ x: 0, t: 0 }, { x: 0, t: 13 }] },
      { id: "mirror", label: "반사체", kind: "vertical", color: "#6b7280", points: [{ x: 5, t: 0 }, { x: 5, t: 13 }] },
      { id: "out", label: "빛(송신)", kind: "light", color: "#d4453f", points: [{ x: 0, t: 2 }, { x: 5, t: 7 }] },
      { id: "back", label: "빛(수신)", kind: "light", color: "#d4453f", points: [{ x: 5, t: 7 }, { x: 0, t: 12 }] },
    ],
    segments: [
      { label: "왕복 시간 Δt", kind: "bracket", from: { x: 0, t: 2 }, to: { x: 0, t: 12 }, color: "#047857" },
      { label: "거리 d=cΔt/2", kind: "line", simultaneity: "rest", from: { x: 0, t: 7 }, to: { x: 5, t: 7 }, color: "#c75a2a" },
    ],
    annotations: [],
    explanation: "빛이 관찰자에서 나가(기울기 +1) 반사체에 닿고 되돌아옵니다(기울기 −1). 왕복 시간 Δt로 거리 d=cΔt/2를 정합니다(레이더식 측정).",
    assumptions: ["거리·시간 수치 없음 → 도식용 값"],
    warnings: [],
  };
}

function inferTextTemplate(description) {
  if (isMuonFrameLengthPrompt(description)) return muonFrameLengthTemplate();
  const kind = inferPromptKind(description);
  if (kind === "length-contraction") {
    return /뮤온|muon/i.test(description || "") ? muonFrameLengthTemplate() : lengthContractionTemplate();
  }
  if (kind === "time-dilation") return timeDilationTemplate();
  if (kind === "simultaneity") return simultaneityTemplate();
  if (kind === "twin-paradox") return twinParadoxTemplate();
  if (kind === "light-signal") return lightSignalTemplate();
  return null;
}

function decorateInferredSpec(spec, description) {
  const out = spec && typeof spec === "object" ? spec : {};
  if (!out.diagramType) {
    out.diagramType = inferPromptKind(description) || "minkowski-clean";
  }
  // 보정/불변 쌍곡선은 브라우저가 diagramType에 맞춰 실제 기준점을 지나도록 직접 그린다.
  // (예전에 여기서 고정 좌표 (4.5,3.2)에 라벨만 박아 곡선과 어긋나던 버그를 제거.)
  return out;
}

function sanitizeSpec(input) {
  const src = input && typeof input === "object" ? input : {};
  const beta = clamp(finiteOr(src.beta, 0.5), -0.95, 0.95);
  const eta = Number.isFinite(Number(src.eta))
    ? clamp(Number(src.eta), -3, 3)
    : Math.atanh(beta);

  const events = Array.isArray(src.events)
    ? src.events.slice(0, 8).map((ev, idx) => ({
        id: safeText(ev.id || `E${idx + 1}`, 32) || `E${idx + 1}`,
        label: safeText(ev.label || ev.id || `사건 ${idx + 1}`, 44),
        ...normalizePoint(ev),
        color: normalizeColor(ev.color, "#0f9d6b"),
      }))
    : [];

  const worldlines = Array.isArray(src.worldlines)
    ? src.worldlines.filter((wl) => !isCoordinateAxisWorldline(wl)).slice(0, 4).map((wl, idx) => {
        const rawPoints = Array.isArray(wl.points) ? wl.points : [];
        const points = rawPoints.slice(0, 8).map((p) => normalizePoint(p));
        if (points.length < 2) {
          points.push({ x: 0, t: -3 }, { x: 0, t: 3 });
        }
        return {
          id: safeText(wl.id || `W${idx + 1}`, 32) || `W${idx + 1}`,
          label: safeText(wl.label || wl.id || `세계선 ${idx + 1}`, 48),
          color: normalizeColor(wl.color, idx % 2 ? "#6b7280" : "#2563eb"),
          kind: normalizeWorldlineKind(wl.kind),
          points,
        };
      })
    : [];

  // 라벨이 없거나 "주석 1" 같은 의미 없는 placeholder는 만들지 말고 버린다(그래프 잡음 방지).
  const annotations = Array.isArray(src.annotations)
    ? src.annotations
        .map((a) => ({
          label: safeText(a && a.label, 48),
          ...normalizePoint(a),
          color: normalizeColor(a && a.color, "#64748b"),
        }))
        .filter((a) => a.label && !/^(주석|annotation|label|라벨|note)\s*\d*$/i.test(a.label))
        .slice(0, 3)
    : [];

  const segments = Array.isArray(src.segments)
    ? src.segments.slice(0, 4).map((seg, idx) => normalizeSegment(seg, idx))
    : [];

  const rawDiagramType = safeText(src.diagramType, 48);
  const frame = normalizeFrame(src.frame);

  return {
    diagramType: DIAGRAM_TYPES.has(rawDiagramType) ? rawDiagramType : "",
    title: safeText(src.title || "민코프스키 평면", 80) || "민코프스키 평면",
    beta,
    eta,
    ...(frame ? { frame } : {}),
    events,
    worldlines,
    annotations,
    segments,
    explanation: safeText(src.explanation, 260),
    assumptions: Array.isArray(src.assumptions)
      ? src.assumptions.map((x) => safeText(x, 200)).filter(Boolean).slice(0, 4)
      : [],
    warnings: Array.isArray(src.warnings)
      ? src.warnings.map((x) => safeText(x, 200)).filter(Boolean).slice(0, 4)
      : [],
  };
}

// β로부터 세계선 기울기와 측정선 동시선 기울기를 결정적으로 보정한다.
// kind/simultaneity 태그가 있는 항목만 손대고, 태그가 없으면 원본 좌표를 그대로 둔다(하위호환).
// 모델이 어떤 좌표를 주든 물리적으로 옳은 기울기(정지=수직, 운동=1/β, 빛=±1, 동시선=0 또는 β)를 강제한다.
function applyRelativityGeometry(spec) {
  const out = spec && typeof spec === "object" ? spec : {};
  const beta = clamp(finiteOr(out.frame && out.frame.beta, out.beta), -0.95, 0.95);
  // β가 0에 너무 가까우면 운동/동시선 보정이 무의미하므로 최소 크기를 둔다.
  const safeBeta = Math.abs(beta) < 0.05 ? (beta < 0 ? -0.05 : 0.05) : beta;

  if (Array.isArray(out.worldlines)) {
    out.worldlines = out.worldlines.map((wl) => {
      const kind = normalizeWorldlineKind(wl && wl.kind);
      const points = Array.isArray(wl && wl.points) ? wl.points.map((p) => normalizePoint(p)) : [];
      // 태그 없음 또는 꺾인 세계선(점 3개 이상, 예: 쌍둥이 역설)은 보정하지 않는다.
      if (!kind || points.length !== 2) return wl;
      const ts = points.map((p) => p.t);
      const tMin = Math.min(ts[0], ts[1]);
      const tMax = Math.max(ts[0], ts[1]);
      const anchor = points[0];
      if (kind === "vertical") {
        return { ...wl, points: [{ x: anchor.x, t: tMin }, { x: anchor.x, t: tMax }] };
      }
      // dx/d(ct) 부호는 원본 점이 가리키는 방향을 유지한다.
      const dxO = points[1].x - points[0].x;
      const dctO = points[1].t - points[0].t;
      const ratioSign = dxO === 0 || dctO === 0 ? 1 : Math.sign(dxO * dctO);
      const slopeXperCt = (kind === "light" ? 1 : Math.abs(safeBeta)) * ratioSign; // moving: dx/d(ct)=β, light: ±1
      const xAt = (ct) => clamp(anchor.x + slopeXperCt * (ct - anchor.t), -20, 20);
      return { ...wl, points: [{ x: xAt(tMin), t: tMin }, { x: xAt(tMax), t: tMax }] };
    });
  }

  if (Array.isArray(out.segments)) {
    out.segments = out.segments.map((seg) => {
      const sim = normalizeSimultaneity(seg && seg.simultaneity);
      if (!sim) return seg;
      const from = normalizePoint(seg && seg.from);
      const to = normalizePoint(seg && seg.to, { x: from.x + 1, t: from.t });
      // rest: 드로잉 프레임 동시선 → 수평(기울기 0). moving: 다른 프레임 동시선 → 기울기 β.
      const slope = sim === "rest" ? 0 : safeBeta;
      return { ...seg, from, to: { x: to.x, t: clamp(from.t + slope * (to.x - from.x), -20, 20) } };
    });
  }

  return out;
}

// diagramType에 맞는 보정/불변 쌍곡선의 종류와 기준값 k를 실제 사건에서 결정한다.
// 길이수축/뮤온: 공간꼴(x²-ct²=k²), 시간지연/쌍둥이: 시간꼴(ct²-x²=k²).
// 곡선은 반드시 의미 있는 실제 사건을 지나야 한다(예전의 고정 (4.5,3.2) 곡선 제거).
function computeCalibration(spec) {
  const type = spec && spec.diagramType;
  if (!HYPERBOLA_TYPES.has(type)) return null;
  const spacelike = type === "length-contraction" || type === "muon-frame-length-contraction";
  const events = Array.isArray(spec.events)
    ? spec.events.map((e) => ({ x: Number(e.x) || 0, t: Number(e.t) || 0 }))
    : [];
  if (!events.length) return null;
  let best = null;
  events.forEach((p) => {
    const inv = spacelike ? p.x * p.x - p.t * p.t : p.t * p.t - p.x * p.x;
    if (inv <= 0.5) return;
    // 공간꼴은 동시선(t≈0)의 끝점을, 시간꼴은 움직이는 세계선 위(x≠0)의 사건을 선호한다.
    const preferred = spacelike ? Math.abs(p.t) < 0.6 : Math.abs(p.x) > 0.3;
    const score = inv + (preferred ? 10000 : 0);
    if (!best || score > best.score) best = { inv, score };
  });
  if (!best) return null;
  return {
    axis: spacelike ? "x" : "t",
    value: clamp(Math.sqrt(best.inv), 0.5, 20),
    label: spacelike ? "보정쌍곡선" : "불변쌍곡선",
  };
}

// 모든 spec(AI 응답이든 폴백 템플릿이든)이 거치는 단일 후처리 경로.
function finalizeSpec(spec, description) {
  const out = decorateInferredSpec(applyRelativityGeometry(sanitizeSpec(spec)), description);
  const cal = computeCalibration(out);
  if (cal) out.calibration = cal;
  return out;
}

async function callAnthropicModel(model, content) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY가 설정되지 않았습니다.");
  }
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 90 * 1000,
  });
  const msg = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    // 최신 모델(Sonnet 5/Opus 4.8 등)은 커스텀 temperature 미지원(400). 추론도 OFF로 고정해
    // 도식 좌표 생성을 빠르고 일관되게 유지한다(study 모델 사다리에 Fable 없음).
    thinking: { type: "disabled" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
  });
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function postGpt(body) {
  const resp = await fetch(`${GPT_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gptKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    const err = new Error(`OpenAI ${resp.status}: ${raw.slice(0, 300)}`);
    err.status = resp.status;
    err.raw = raw;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI 응답을 해석할 수 없습니다: ${raw.slice(0, 200)}`);
  }
  return (((json.choices || [])[0] || {}).message || {}).content || "";
}

async function callGptModel(model, content) {
  if (!gptKey()) {
    throw new Error("GPT_API_KEY 또는 OPENAI_API_KEY가 설정되지 않았습니다.");
  }
  const messages = [
    {
      role: "system",
      content:
        SYSTEM_PROMPT +
        "\n\n[GPT 전용 추가 규칙]\nresponse_format=json_object를 사용합니다. 출력은 반드시 유효한 JSON 객체 하나여야 합니다.",
    },
    { role: "user", content: toOpenAiContent(content) },
  ];
  const body = {
    model,
    messages,
    max_completion_tokens: Math.max(MAX_TOKENS, 4000),
    reasoning_effort: GPT_REASONING_EFFORT,
    response_format: { type: "json_object" },
  };
  try {
    return await postGpt(body);
  } catch (e) {
    if (e.status === 400 && /response_format|json_object/i.test(e.raw || e.message || "")) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      return await postGpt(retryBody);
    }
    throw e;
  }
}

async function callModel(model, content) {
  const info = modelInfo(model);
  if (!info) throw new Error(`지원하지 않는 모델입니다: ${model}`);
  if (info.provider === "openai") return callGptModel(model, content);
  if (info.provider === "anthropic") return callAnthropicModel(model, content);
  throw new Error(`지원하지 않는 provider입니다: ${info.provider}`);
}

module.exports = function studyRouter(deps = {}) {
  const { requireBeta, getSessionUser } = deps;
  if (typeof requireBeta !== "function") {
    throw new Error("study-routes: requireBeta 의존성이 필요합니다.");
  }
  const sessionUser = typeof getSessionUser === "function" ? getSessionUser : () => null;

  const r = express.Router();

  r.get("/relativity/models", requireBeta(FEATURE_KEY), (_req, res) => {
    res.json({
      defaultModel: ALLOWED_MODEL_IDS.has(DEFAULT_MODEL) ? DEFAULT_MODEL : "auto",
      models: availableModelPayload(),
      autoLadder: EFFECTIVE_AUTO_LADDER,
    });
  });

  r.post(
    "/relativity/analyze",
    requireBeta(FEATURE_KEY),
    upload.single("image"),
    async (req, res) => {
      const description = String(req.body.description || "")
        .trim()
        .slice(0, MAX_DESCRIPTION_CHARS);
      const modeHint = String(req.body.modeHint || "").trim().slice(0, 60);
      const requestedModel = resolveRequestedModel(req.body.model);
      const file = req.file || null;
      if (!description && !file) {
        return res.status(400).json({ error: "상황 설명을 쓰거나 문제 사진을 올려 주세요." });
      }
      if (!ALLOWED_MODEL_IDS.has(requestedModel)) {
        return res.status(400).json({ error: "지원하지 않는 모델입니다." });
      }
      const u = sessionUser(req);
      if (u && u.id && !u.isAdmin) rateLimit.recordBetaUsage(u.id, FEATURE_KEY);

      // 템플릿은 더 이상 AI를 가로채지 않는다. AI 키가 없거나 모든 모델이 실패할 때만 쓰는 안전망이다.
      const fallbackTemplate = () => (file ? null : inferTextTemplate(description));
      const sendFallback = (note) => {
        const template = fallbackTemplate();
        if (!template) return false;
        const out = finalizeSpec(template, description);
        out.model = "fallback";
        out.modelLabel = "상대론 개념 템플릿";
        out.warnings = out.warnings.concat(note).slice(0, 5);
        res.json(out);
        return true;
      };

      const candidates = candidateModels(requestedModel);
      if (!candidates.length) {
        if (sendFallback("서버에 사용 가능한 AI 키가 없어 개념 템플릿으로 그렸습니다.")) return;
        return res.status(503).json({
          error:
            requestedModel === "auto"
              ? "사용 가능한 AI 모델 키가 서버에 설정되지 않았습니다."
              : "선택한 모델의 API 키가 서버에 설정되지 않았습니다.",
          models: availableModelPayload(),
        });
      }

      try {
        const content = [];
        const imageNotes = [];
        if (file) {
          const prepared = await prepareImageForAnthropic(
            {
              buffer: file.buffer,
              name: file.originalname,
              mimetype: file.mimetype,
            },
            { maxEdge: 1800 },
          );
          if (!prepared.ok) {
            return res.status(400).json({ error: prepared.reason || "이미지를 처리하지 못했습니다." });
          }
          imageNotes.push(describePreparedImage(prepared));
          content.push(toAnthropicImageBlock(prepared));
        }
        content.push({
          type: "text",
          text: [
            "[사용자 상황 설명]",
            description || "(텍스트 설명 없음. 첨부 이미지에서 문제를 읽어야 함.)",
            "",
            `[선호 렌더링 모드] ${modeHint || "사용자가 화면에서 선택함"}`,
            imageNotes.length ? `[첨부 이미지] ${imageNotes.join(", ")}` : "",
            "",
            "위 내용을 민코프스키 평면 JSON 명세로 변환하세요.",
          ]
            .filter(Boolean)
            .join("\n"),
        });

        const failures = [];
        for (const model of candidates) {
          try {
            const text = await callModel(model, content);
            const parsed = extractJson(text);
            const out = finalizeSpec(parsed, description);
            const info = modelInfo(model);
            out.model = model;
            out.modelLabel = info ? info.label : model;
            if (failures.length) {
              out.warnings.push(
                `자동 선택 중 ${failures.length}개 모델 실패 후 ${out.modelLabel}로 생성했습니다.`,
              );
            }
            return res.json(out);
          } catch (e) {
            failures.push(`${model}: ${e.message || e}`);
            if (requestedModel !== "auto") break;
          }
        }

        console.error("[study relativity] all models failed:", failures.join(" | "));
        if (sendFallback("AI 응답 생성에 실패해 개념 템플릿으로 그렸습니다.")) return;
        return res.status(502).json({
          error: "AI가 민코프스키 도식 JSON을 만들지 못했습니다. 다른 모델을 선택하거나 설명을 조금 더 구체적으로 써 주세요.",
        });
      } catch (e) {
        console.error("[study relativity]", e && e.stack ? e.stack : e);
        if (!res.headersSent && sendFallback("AI 처리 중 오류가 발생해 개념 템플릿으로 그렸습니다.")) return;
        if (!res.headersSent) {
          return res.status(502).json({
            error: "민코프스키 도식 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.",
          });
        }
      }
    },
  );

  return r;
};

// 테스트 전용 시드(라우터 동작에는 영향 없음): 결정적 기하 보정/템플릿을 단위 검증할 때 쓴다.
module.exports._test = {
  sanitizeSpec,
  applyRelativityGeometry,
  computeCalibration,
  finalizeSpec,
  inferTextTemplate,
  inferPromptKind,
  muonFrameLengthTemplate,
  lengthContractionTemplate,
  timeDilationTemplate,
  simultaneityTemplate,
  twinParadoxTemplate,
  lightSignalTemplate,
};
