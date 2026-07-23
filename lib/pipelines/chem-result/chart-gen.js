// Claude가 응답에 포함한 charts JSON spec을 받아 PNG buffer로 렌더.
// chartjs-node-canvas + chart.js 사용 (Node-only, native canvas 의존).
//
// 지원 차트 타입: bar, line, scatter
// 참값 라인은 horizontal line dataset으로 표현 (annotation plugin 불필요)
//
// 한글 폰트: Render 리눅스 컨테이너에는 CJK 폰트가 없어 한글이 □로 렌더된다.
// repo에 NanumGothic-Regular.ttf를 포함하고 startup에서 등록.

const path = require("path");
const fs = require("fs");
const { fork } = require("child_process");

const WIDTH = 800;
const HEIGHT = 500;
const KOREAN_FONT_FAMILY = "NanumGothic";
const CHART_WORKER_TIMEOUT_MS = Number(process.env.CHART_WORKER_TIMEOUT_MS || 15000);
const KOREAN_FONT_PATH = path.join(
  __dirname,
  "..",
  "..",
  "fonts",
  "NanumGothic-Regular.ttf",
);

let canvas = null;

function getCanvas() {
  if (canvas) return canvas;
  const { ChartJSNodeCanvas } = require("chartjs-node-canvas");
  canvas = new ChartJSNodeCanvas({
    width: WIDTH,
    height: HEIGHT,
    backgroundColour: "white",
    // Chart.js 전역 기본 폰트를 한글로 지정 → title·legend·ticks 모두 적용.
    chartCallback: (ChartJS) => {
      ChartJS.defaults.font.family = KOREAN_FONT_FAMILY;
    },
  });

  // node-canvas의 registerFont는 process 첫 사용 전에 호출돼야 한다.
  // chartjs-node-canvas 인스턴스에 wrapper가 있어 그걸 사용.
  try {
    canvas.registerFont(KOREAN_FONT_PATH, { family: KOREAN_FONT_FAMILY });
  } catch (e) {
    console.warn(
      `[chart-gen] 한글 폰트 등록 실패 (${KOREAN_FONT_PATH}): ${e.message}. 차트 한글이 □로 렌더될 수 있음.`,
    );
  }
  return canvas;
}

const COLORS = [
  "#4a90e2",
  "#e94e77",
  "#43b97f",
  "#f5a623",
  "#9013fe",
  "#50e3c2",
];
const NAMED_COLORS = new Set(["black", "blue", "green", "gray", "grey", "orange", "purple", "red", "teal"]);

function safeColor(value, fallback = "#d0021b") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(raw)) return raw;
  const lower = raw.toLowerCase();
  if (NAMED_COLORS.has(lower)) return lower;
  return fallback;
}

// 차트는 plain text만 받으므로 *italic*, **bold**, _{sub}, ^{sup} 마커를
// 그대로 두면 raw 문자가 노출됨. 마커를 벗겨 plain text로 변환.
//   `*I*_pivot` → `I_pivot`,  `H_{2}O` → `H2O`,  `m^{3}` → `m3`
function stripMarkers(s) {
  return String(s ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_\{([^}]+)\}/g, "$1")
    .replace(/\^\{([^}]+)\}/g, "$1");
}

const GREEK_ASCII = {
  α: "alpha",
  β: "beta",
  γ: "gamma",
  Δ: "Delta",
  δ: "delta",
  θ: "theta",
  λ: "lambda",
  μ: "mu",
  π: "pi",
  ρ: "rho",
  σ: "sigma",
  ω: "omega",
  Ω: "Omega",
};

const SUPERSCRIPT_ASCII = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  "⁻": "-",
};

const KOREAN_CHART_TERMS = [
  [/자유\s*진동/g, "free oscillation"],
  [/강제\s*진동/g, "driven oscillation"],
  [/감쇠\s*진동/g, "damped oscillation"],
  [/공명/g, "resonance"],
  [/진동수|주파수/g, "frequency"],
  [/진폭/g, "amplitude"],
  [/위상/g, "phase"],
  [/각속도/g, "angular velocity"],
  [/각도/g, "angle"],
  [/시간/g, "time"],
  [/주기/g, "period"],
  [/회전\s*관성|관성\s*모멘트/g, "moment of inertia"],
  [/에너지/g, "energy"],
  [/손실률/g, "loss rate"],
  [/초기/g, "initial"],
  [/나중|최종/g, "final"],
  [/측정값|측정/g, "measured"],
  [/이론값|이론/g, "theory"],
  [/참값|기준/g, "reference"],
  [/평균/g, "average"],
  [/회귀선|선형\s*회귀/g, "fit"],
  [/시행|회차/g, "trial"],
  [/실험/g, "experiment"],
  [/시편/g, "object"],
  [/원판/g, "disk"],
  [/막대/g, "rod"],
  [/비정형/g, "irregular"],
  [/질량/g, "mass"],
  [/거리/g, "distance"],
  [/길이/g, "length"],
  [/높이/g, "height"],
  [/힘|구심력/g, "force"],
  [/속도/g, "velocity"],
  [/가속도/g, "acceleration"],
  [/압력/g, "pressure"],
  [/부피/g, "volume"],
  [/온도/g, "temperature"],
  [/파장/g, "wavelength"],
  [/농도/g, "concentration"],
  [/흡광도/g, "absorbance"],
  [/전압/g, "voltage"],
  [/전류/g, "current"],
  [/저항/g, "resistance"],
  [/단형/g, "simple"],
  [/복합/g, "compound"],
  [/비교/g, "comparison"],
  [/변화/g, "change"],
];

function asciiMath(value) {
  return String(value ?? "")
    .replace(/[αβγΔδθλμπρσωΩ]/g, (ch) => GREEK_ASCII[ch] || "")
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, (ch) => SUPERSCRIPT_ASCII[ch] || "")
    .replace(/[×·]/g, " ")
    .replace(/[−–—]/g, "-");
}

function axisLabel(raw, fallback) {
  const text = String(raw || "");
  if (/시간/.test(text)) return /s|초/.test(text) ? "Time (s)" : "Time";
  if (/각도/.test(text)) return /rad|라디안/.test(text) ? "Angle (rad)" : "Angle";
  if (/진폭/.test(text)) return "Amplitude";
  if (/주파수|진동수/.test(text)) return /Hz|헤르츠/.test(text) ? "Frequency (Hz)" : "Frequency";
  if (/주기/.test(text)) return /s|초/.test(text) ? "Period (s)" : "Period";
  if (/회전\s*관성|관성\s*모멘트/.test(text)) return /10|kg|m/.test(text) ? "Moment of Inertia" : "Moment of Inertia";
  if (/에너지/.test(text)) return /J/.test(text) ? "Energy (J)" : "Energy";
  if (/손실률/.test(text)) return "Loss Rate (%)";
  if (/질량/.test(text)) return /kg/.test(text) ? "Mass (kg)" : /g/.test(text) ? "Mass (g)" : "Mass";
  if (/거리/.test(text)) return /m/.test(text) ? "Distance (m)" : "Distance";
  if (/길이/.test(text)) return /m/.test(text) ? "Length (m)" : "Length";
  if (/힘|구심력/.test(text)) return /N/.test(text) ? "Force (N)" : "Force";
  if (/속도/.test(text)) return "Velocity";
  if (/가속도/.test(text)) return "Acceleration";
  if (/압력/.test(text)) return "Pressure";
  if (/부피/.test(text)) return "Volume";
  if (/온도/.test(text)) return "Temperature";
  if (/파장/.test(text)) return "Wavelength";
  if (/농도/.test(text)) return "Concentration";
  if (/흡광도/.test(text)) return "Absorbance";
  if (/시행|회차/.test(text)) return "Trial";
  return fallback;
}

function makeAsciiLabel(value, fallback, index = null) {
  const raw = stripMarkers(value);
  if (!raw) return fallback;
  let text = asciiMath(raw);
  for (const [pattern, replacement] of KOREAN_CHART_TERMS) {
    text = text.replace(pattern, replacement);
  }
  text = text
    .replace(/에\s*따른|에 대한|대비|vs\./gi, " vs ")
    .replace(/에서|의|별|과|와|및|에|로|으로|값/g, " ")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text;

  const numbers = raw.match(/[+-]?\d+(?:\.\d+)?\s*(?:kg|g|cm|mm|m|s|Hz|N|J|rad|%)?/gi);
  const base = index == null ? fallback : `${fallback} ${index + 1}`;
  return numbers?.length ? `${base} (${numbers.join(" ")})` : base;
}

function chartTitle(raw) {
  const text = String(raw || "");
  if (/각도/.test(text) && /시간/.test(text)) return "Angle vs Time";
  if (/진폭/.test(text) && /주파수|진동수/.test(text)) return "Amplitude vs Frequency";
  if (/에너지/.test(text) && /(초기|나중|최종)/.test(text)) return "Initial and Final Energy";
  if (/(힘|구심력)/.test(text) && /(각속도|ω|omega|질량)/.test(text)) return "Force Relationship";
  if (/회전\s*관성|관성\s*모멘트/.test(text)) return "Moment of Inertia Comparison";
  if (/공명/.test(text)) return "Resonance Analysis";
  return makeAsciiLabel(raw, "Experiment Chart");
}

// 한글 폰트(NanumGothic)가 repo에 있으면 차트 라벨을 한글 그대로 렌더한다.
// (과거엔 CJK 폰트가 없어 한글→영어 ASCII로 강제 변환했으나, 폰트가 등록된
// 지금은 그 변환이 gold(한글 보고서)와의 불일치만 만든다.)
function koreanFontAvailable() {
  try {
    return fs.existsSync(KOREAN_FONT_PATH);
  } catch {
    return false;
  }
}

const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹", "+": "⁺", "-": "⁻", n: "ⁿ", i: "ⁱ" };
const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉", "+": "₊", "-": "₋" };
function toUnicodeScripts(s) {
  return String(s ?? "")
    .replace(/\^\{([^}]+)\}/g, (_, b) => b.replace(/./g, (c) => SUP[c] || c))
    .replace(/\^([0-9+\-ni])/g, (_, c) => SUP[c] || c)
    .replace(/_\{([^}]+)\}/g, (_, b) => b.replace(/./g, (c) => SUB[c] || c))
    .replace(/_([0-9+\-])/g, (_, c) => SUB[c] || c);
}
// 한국어 차트 어휘 → 영어 (모델이 한국어 라벨을 낼 때의 결정론적 안전망).
// 긴 구(phrase)부터 치환해야 부분 치환을 막는다(예: '각속도' 전에 '속도'가 오면 안 됨).
// 단위·기호(Hz, N, kg, m/s 등)는 건드리지 않는다.
const KO_CHART_TERMS = [
  // ── 다어절 구(phrase) 먼저: 부분 치환 방지 ──
  ["측정 평균", "Measured Mean"], ["질량 차이", "Mass Difference"], ["속력 제곱", "Speed Squared"],
  ["선형 회귀", "Linear Fit"], ["초기 에너지", "Initial Energy"], ["나중 에너지", "Final Energy"],
  ["공명 진동수", "Resonance Frequency"], ["보정 전", "Before"], ["보정 후", "After"],
  // ── 화학 용어(복합어 → 단어 순서: 몰질량은 질량보다 먼저 와야 '몰Mass' 깨짐 방지) ──
  ["반응 엔탈피", "Reaction Enthalpy"], ["백분율 오차", "Percent Error"],
  ["표준 편차", "Standard Deviation"], ["표준편차", "Standard Deviation"],
  ["몰농도", "Molarity"], ["몰질량", "Molar Mass"], ["몰분율", "Mole Fraction"], ["몰수", "Moles"],
  ["평균 부피", "Mean Volume"], ["평균값", "Mean"],
  ["검량선", "Calibration Curve"], ["당량점", "Equivalence Point"],
  ["눈금실린더", "Graduated Cylinder"], ["눈금 실린더", "Graduated Cylinder"],
  ["끓는점", "Boiling Point"], ["어는점", "Freezing Point"], ["녹는점", "Melting Point"],
  ["증기압", "Vapor Pressure"], ["기구별", "by Apparatus"], ["기구", "Apparatus"],
  ["흡광도", "Absorbance"], ["농도", "Concentration"], ["수율", "Yield"], ["엔탈피", "Enthalpy"],
  ["부피", "Volume"], ["평균", "Mean"], ["오차", "Error"], ["편차", "Deviation"],
  ["피펫", "Pipette"], ["뷰렛", "Buret"], ["적정", "Titration"], ["당량", "Equivalent"],
  ["시료", "Sample"], ["파장", "Wavelength"], ["온도", "Temperature"], ["압력", "Pressure"],
  ["밀도", "Density"], ["비교", "Comparison"], ["변화량", "Change"], ["변화", "Change"],
  // ── 물리 용어(복합어 → 단어 순서) ──
  ["구심력", "Centripetal Force"], ["원심력", "Centrifugal Force"],
  ["각속도", "Angular Velocity"], ["측정값", "Measured"], ["이론값", "Theory"], ["보정값", "Corrected"],
  ["진동수", "Frequency"], ["가속도", "Acceleration"], ["반지름", "Radius"], ["에너지", "Energy"],
  ["속도", "Velocity"], ["속력", "Speed"], ["주기", "Period"], ["진폭", "Amplitude"],
  ["거리", "Distance"], ["길이", "Length"], ["각도", "Angle"], ["시행", "Trial"],
  ["질량", "Mass"], ["시간", "Time"], ["차수", "Harmonic Number"], ["초기", "Initial"],
  ["나중", "Final"], ["이론", "Ideal"], ["힘", "Force"], ["계열", "Series"],
];
function toEnglishLabel(s) {
  // 한글이 없으면 모델이 이미 영어로 쓴 것 → 그대로 둔다.
  if (!/[가-힣]/.test(s)) return s;
  let out = s;
  for (const [ko, en] of KO_CHART_TERMS) out = out.split(ko).join(en);
  return out;
}
// 차트 라벨(영어 출력): markdown 강조 제거 + 위/아래첨자 유니코드화 + (한글이면) 영어 보정
function englishLabel(raw, fallback = "") {
  let s = String(raw ?? "").trim();
  if (!s) return fallback;
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  s = toUnicodeScripts(s);
  return toEnglishLabel(s);
}

function normalizeChartSpecForImage(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const normalized = { ...spec };
  // 모든 차트 라벨은 영어로 출력한다. 모델이 한글을 내면 결정론적으로 영어로 보정.
  // NanumGothic 이 있으면 영어 라벨을 그대로 렌더(없어도 어차피 영어 ASCII fallback).
  if (koreanFontAvailable()) {
    normalized.title = englishLabel(spec.title, "Experiment Graph");
    normalized.x_label = englishLabel(spec.x_label, "");
    normalized.y_label = englishLabel(spec.y_label, "");
    if (Array.isArray(spec.x_values)) {
      normalized.x_values = spec.x_values.map((v) => englishLabel(v, ""));
    }
    if (Array.isArray(spec.series)) {
      normalized.series = spec.series.map((series, index) => ({
        ...series,
        label: englishLabel(series?.label, `Series ${index + 1}`),
      }));
    }
    for (const key of ["trendline", "fit_line", "regression_line", "reference_line"]) {
      if (spec[key] && typeof spec[key] === "object") {
        normalized[key] = { ...spec[key], label: englishLabel(spec[key].label, "") };
      }
    }
    return normalized;
  }
  normalized.title = chartTitle(spec.title || "");
  normalized.x_label = axisLabel(spec.x_label, makeAsciiLabel(spec.x_label, "X"));
  normalized.y_label = axisLabel(spec.y_label, makeAsciiLabel(spec.y_label, "Y"));
  if (Array.isArray(spec.x_values)) {
    normalized.x_values = spec.x_values.map((value, index) =>
      makeAsciiLabel(value, "Item", index),
    );
  }
  if (Array.isArray(spec.series)) {
    normalized.series = spec.series.map((series, index) => ({
      ...series,
      label: makeAsciiLabel(series?.label, `Series ${index + 1}`),
    }));
  }
  for (const key of ["trendline", "fit_line", "regression_line", "reference_line"]) {
    if (spec[key] && typeof spec[key] === "object") {
      normalized[key] = {
        ...spec[key],
        label: makeAsciiLabel(
          spec[key].label,
          key === "reference_line" ? "Reference" : "Fit",
        ),
      };
    }
  }
  return normalized;
}

function cleanLabels(arr) {
  return Array.isArray(arr) ? arr.map(stripMarkers) : [];
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePoint(point, fallbackX = null) {
  if (Array.isArray(point) && point.length >= 2) {
    const x = toNumberOrNull(point[0]);
    const y = toNumberOrNull(point[1]);
    return x == null || y == null ? null : { x, y };
  }
  if (point && typeof point === "object") {
    const x = toNumberOrNull(point.x);
    const y = toNumberOrNull(point.y);
    return x == null || y == null ? null : { x, y };
  }
  const y = toNumberOrNull(point);
  const x = toNumberOrNull(fallbackX);
  return x == null || y == null ? null : { x, y };
}

function scatterPoints(spec, seriesItem) {
  const rawPoints = Array.isArray(seriesItem.points)
    ? seriesItem.points
    : Array.isArray(seriesItem.data)
      ? seriesItem.data
      : null;
  // x_value가 수치가 아니면(카테고리 문자열) 인덱스 i를 x로 폴백한다.
  // 그러지 않으면 모든 점이 조용히 버려진다(silent total-drop).
  const fallbackXAt = (i) => {
    const rawX = spec.x_values?.[i];
    return toNumberOrNull(rawX) != null ? rawX : i;
  };

  if (rawPoints) {
    return rawPoints
      .map((point, i) => normalizePoint(point, fallbackXAt(i)))
      .filter(Boolean);
  }

  const values = Array.isArray(seriesItem.values) ? seriesItem.values : [];
  return values
    .map((y, i) => normalizePoint(y, fallbackXAt(i)))
    .filter(Boolean);
}

// series의 점 배열 필드(points 우선, data 폴백)를 얻는다. 없으면 null.
function seriesPointList(s) {
  if (Array.isArray(s?.points) && s.points.length > 0) return s.points;
  if (Array.isArray(s?.data) && s.data.length > 0) return s.data;
  return null;
}

// line spec의 데이터 series가 values 없이 수치 x·y의 points({x,y})만 갖는지 판별.
// 모델이 line 타입에 scatter식 points를 내는 경우가 실측됨(DEF-017). 이때는
// category 축(values 경로) 대신 scatter+showLine(선형 x축)으로 그려야
// 점 간격과 trendline x 도메인이 맞는다.
function seriesUseNumericPointsOnly(series) {
  const withPoints = series.filter((s) => seriesPointList(s));
  if (withPoints.length === 0) return false;
  // values를 이미 가진 series가 섞여 있으면 기존 category 경로를 유지한다.
  if (series.some((s) => Array.isArray(s?.values) && s.values.length > 0)) return false;
  return withPoints.every((s) => seriesPointList(s).every((p) => normalizePoint(p) != null));
}

// 점 항목({x,y} 객체·[x,y] 쌍·스칼라)에서 y 수치를 뽑는다. 수치가 아니면 null.
function pointYValue(p) {
  if (Array.isArray(p)) return p.length >= 2 ? toNumberOrNull(p[1]) : null;
  if (p && typeof p === "object") return toNumberOrNull(p.y);
  return toNumberOrNull(p);
}

// 카테고리형(bar/line) series가 values 대신 points({x,y})로 온 경우 y만 뽑아 values로 쓴다.
function categorySeriesValues(s) {
  if (Array.isArray(s?.values) && s.values.length > 0) return s.values;
  const points = seriesPointList(s);
  if (!points) return Array.isArray(s?.values) ? s.values : [];
  return points.map(pointYValue);
}

// series 기준 렌더 가능한 데이터 포인트 수. 합성 trendline/참값 라인은 세지 않는다.
// 0이면 축만 있는 빈 차트가 되므로 renderChart()가 렌더 없이 null을 반환한다(DEF-017).
function countRenderableSpecPoints(spec) {
  const series = Array.isArray(spec?.series) ? spec.series : [];
  let count = 0;
  for (const s of series) {
    if (spec?.type === "scatter") {
      count += scatterPoints(spec, s).length;
      continue;
    }
    // values 안에 {x,y} 객체가 섞여 와도(Chart.js는 렌더 가능) y 수치 기준으로 센다.
    for (const v of categorySeriesValues(s)) {
      if (pointYValue(v) != null) count += 1;
    }
  }
  return count;
}

// 경고 로그용 차트 제목(마커 제거, 없으면 자리표시 문구).
function specTitleForLog(spec) {
  return stripMarkers(spec?.title) || "(제목 없음)";
}

// gpt-5.5가 x_values 없이 series[].values만 담은 spec을 내는 경우가 실측됨(DEF-005).
// 카테고리 축 차트(bar/line)에서 x 라벨을 1..N 인덱스로 보완하고,
// 어떤 필드가 비었는지 console.warn으로 남긴다(무음 보정 금지).
// scatter는 선형 x축이라 x_values가 필수가 아니므로 건드리지 않는다.
function backfillChartSpec(spec) {
  if (!spec || typeof spec !== "object") return spec;
  if (spec.type === "scatter") return spec;
  const hasXValues = Array.isArray(spec.x_values) && spec.x_values.length > 0;
  if (hasXValues) return spec;
  const series = Array.isArray(spec.series) ? spec.series : [];
  const valueCounts = series
    .map((s) => (Array.isArray(s?.values) ? s.values.length : 0))
    .filter((len) => len > 0);
  if (valueCounts.length === 0) return spec;

  const missing = ["x_values"];
  if (!String(spec.title ?? "").trim()) missing.push("title");
  if (!String(spec.x_label ?? "").trim()) missing.push("x_label");
  if (!String(spec.y_label ?? "").trim()) missing.push("y_label");

  const count = Math.max(...valueCounts);
  console.warn(
    `[chart-gen] chart spec 결함(누락 필드: ${missing.join(", ")}) 차트: ${specTitleForLog(spec)} / x_values를 1..${count} 인덱스 라벨로 보완`,
  );
  return {
    ...spec,
    x_values: Array.from({ length: count }, (_, i) => String(i + 1)),
  };
}

function pointDomain(datasets) {
  const xs = [];
  for (const ds of datasets) {
    for (const point of ds.data || []) {
      if (point && typeof point === "object" && Number.isFinite(point.x)) {
        xs.push(point.x);
      }
    }
  }
  if (xs.length === 0) return null;
  return { min: Math.min(...xs), max: Math.max(...xs) };
}

function trendlineDataset(spec, datasets) {
  const trend = spec.trendline || spec.fit_line || spec.regression_line;
  if (!trend || typeof trend !== "object") return null;

  const color = safeColor(trend.color);
  let data = null;
  if (Array.isArray(trend.points)) {
    data = trend.points.map(normalizePoint).filter(Boolean);
  } else {
    const slope = toNumberOrNull(trend.slope ?? trend.m);
    const intercept = toNumberOrNull(trend.intercept ?? trend.b);
    const domain = pointDomain(datasets);
    const xMin = toNumberOrNull(trend.x_min ?? trend.xMin) ?? domain?.min;
    const xMax = toNumberOrNull(trend.x_max ?? trend.xMax) ?? domain?.max;
    if (slope != null && intercept != null && xMin != null && xMax != null) {
      data = [
        { x: xMin, y: slope * xMin + intercept },
        { x: xMax, y: slope * xMax + intercept },
      ];
    }
  }
  if (!data || data.length < 2) return null;

  return {
    label: stripMarkers(trend.label || "회귀선"),
    data,
    showLine: true,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderDash: trend.dashed === false ? undefined : [6, 4],
    pointRadius: 0,
    fill: false,
    order: -1,
  };
}

function buildConfig(spec) {
  let labels = cleanLabels(spec.x_values);
  const series = Array.isArray(spec.series) ? spec.series : [];
  // line인데 series가 values 없이 수치 points({x,y})만 갖고 오면(DEF-017 실측 spec)
  // scatter+showLine으로 변환해 선형 x축 위에 그린다. trendline도 scatter 경로를 그대로 탄다.
  const lineAsScatter = spec.type === "line" && seriesUseNumericPointsOnly(series);
  const isScatter = spec.type === "scatter" || lineAsScatter;

  // 카테고리형인데 x_values가 비어 있고 series가 points로만 온 경우,
  // points의 x를 카테고리 라벨로 대신 쓴다(라벨이 없으면 눈금이 비어 보인다).
  if (!isScatter && labels.length === 0) {
    const pointsOnly = series.find(
      (s) => seriesPointList(s) && !(Array.isArray(s?.values) && s.values.length > 0),
    );
    if (pointsOnly) {
      labels = seriesPointList(pointsOnly).map((p, i) => {
        const x = Array.isArray(p) ? p[0] : p && typeof p === "object" ? p.x : null;
        return x == null ? String(i + 1) : stripMarkers(String(x));
      });
    }
  }

  const datasets = series.map((s, i) => {
    const color = COLORS[i % COLORS.length];
    const base = {
      label: stripMarkers(s.label || `series ${i + 1}`),
      data: isScatter ? scatterPoints(spec, s) : categorySeriesValues(s),
    };
    if (spec.type === "line") {
      return {
        ...base,
        borderColor: color,
        backgroundColor: color + "33",
        fill: false,
        tension: 0.1,
        // scatter로 변환해 그리는 line은 점을 선으로 이어야 line 차트로 보인다.
        ...(lineAsScatter ? { showLine: true, pointRadius: 3 } : {}),
      };
    }
    if (spec.type === "scatter") {
      return {
        ...base,
        showLine: s.showLine === true || s.show_line === true,
        backgroundColor: color,
        borderColor: color,
        pointRadius: 5,
        borderWidth: 2,
        fill: false,
      };
    }
    // 기본: bar
    return {
      ...base,
      backgroundColor: color,
      borderColor: color,
      borderWidth: 1,
    };
  });

  if (isScatter) {
    const fit = trendlineDataset(spec, datasets);
    if (fit) datasets.push(fit);
  }

  // 참값 라인: horizontal line dataset
  // SVG 엔진과 수용 기준을 일치시킨다: 유한 수치(문자열 "10.0" 포함) 허용,
  // labels.length > 0 요구 제거(scatter는 labels가 비어 있음).
  const refValue = spec.reference_line
    ? toNumberOrNull(spec.reference_line.value)
    : null;
  if (refValue != null) {
    if (isScatter) {
      // scatter는 labels가 없으므로 x 도메인 양 끝을 잇는 진짜 수평 y-라인으로 그린다.
      const domain = pointDomain(datasets);
      if (domain) {
        datasets.push({
          label: stripMarkers(spec.reference_line.label || "참값"),
          type: "line",
          data: [
            { x: domain.min, y: refValue },
            { x: domain.max, y: refValue },
          ],
          borderColor: "#d0021b",
          borderDash: [6, 4],
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          order: -1,
        });
      }
    } else if (labels.length > 0) {
      datasets.push({
        label: stripMarkers(spec.reference_line.label || "참값"),
        type: "line",
        data: labels.map(() => refValue),
        borderColor: "#d0021b",
        borderDash: [6, 4],
        borderWidth: 2,
        fill: false,
        pointRadius: 0,
        order: -1, // 다른 dataset 위에
      });
    }
  }

  return {
    type: isScatter ? "scatter" : spec.type === "line" ? "line" : "bar",
    data: isScatter ? { datasets } : { labels, datasets },
    options: {
      responsive: false,
      plugins: {
        title: spec.title
          ? {
              display: true,
              text: stripMarkers(spec.title),
              font: { size: 16, weight: "bold" },
              padding: { bottom: 12 },
            }
          : { display: false },
        legend: {
          display: datasets.length > 1,
          position: "bottom",
          labels: { boxWidth: 12, padding: 14, font: { size: 11 } },
        },
      },
      layout: { padding: { top: 10, right: 28, bottom: 8, left: 12 } },
      scales: {
        x: {
          title: spec.x_label
            ? { display: true, text: stripMarkers(spec.x_label) }
            : undefined,
        },
        y: {
          title: spec.y_label
            ? { display: true, text: stripMarkers(spec.y_label) }
            : undefined,
          beginAtZero: spec.begin_at_zero === true,
        },
      },
    },
  };
}

/**
 * Chart spec을 PNG buffer로 렌더.
 * spec 형식 예시:
 * {
 *   "title": "기구별 평균 부피 비교",
 *   "type": "bar",         // bar | line | scatter
 *   "x_label": "기구",
 *   "y_label": "평균 부피 (mL)",
 *   "x_values": ["피펫", "뷰렛"],
 *   "series": [
 *     { "label": "평균값", "values": [10.0090, 10.0234] }
 *   ],
 *   "reference_line": { "value": 10.0, "label": "이론값" }
 * }
 *
 * series는 values 대신 points([{x,y}...]) 형태도 지원한다.
 * (x가 전부 수치인 line은 내부적으로 scatter+showLine 선형 x축으로 렌더)
 *
 * 실패하면 null 반환 (보고서 전체는 계속).
 */
async function renderChartDirect(spec) {
  try {
    const config = buildConfig(spec);
    return await getCanvas().renderToBuffer(config);
  } catch (e) {
    console.warn(`[chart-gen] render error (차트: ${specTitleForLog(spec)}): ${e.message}`);
    return null;
  }
}

async function renderChartBestEffort(spec) {
  // 부모(renderChart)가 이미 보완한 spec이면 no-op. worker로 직접 들어온 spec도 방어.
  spec = backfillChartSpec(spec);
  spec = normalizeChartSpecForImage(spec);
  if (process.env.CHART_RENDER_ENGINE !== "chartjs") {
    // SVG 엔진 실패(모듈 로드 포함)를 조용히 삼키지 않는다: 원인과 차트 제목을 남기고 폴백.
    try {
      const { renderChartSvg } = require("./svg-chart-gen");
      const svgBuffer = await renderChartSvg(spec);
      if (svgBuffer) return svgBuffer;
      console.warn(
        `[chart-gen] SVG 렌더가 null 반환, Chart.js로 폴백 (차트: ${specTitleForLog(spec)})`,
      );
    } catch (e) {
      console.warn(
        `[chart-gen] SVG 엔진 오류, Chart.js로 폴백 (차트: ${specTitleForLog(spec)}): ${e.message}`,
      );
    }
  }
  return renderChartDirect(spec);
}

function renderChartInWorker(spec) {
  return new Promise((resolve) => {
    const child = fork(__filename, ["--chart-worker"], {
      env: { ...process.env, CHART_RENDER_WORKER: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let settled = false;
    let stderr = "";

    const finish = (buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buffer || null);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      stderr = `${stderr}\nworker timeout after ${CHART_WORKER_TIMEOUT_MS}ms`;
      child.kill("SIGKILL");
      console.warn(`[chart-gen] worker timeout:${stderr.slice(-500)}`);
      finish(null);
    }, CHART_WORKER_TIMEOUT_MS);

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("message", (msg) => {
      if (!msg || msg.type !== "chart-result") return;
      if (msg.ok && msg.base64) {
        finish(Buffer.from(msg.base64, "base64"));
      } else {
        if (msg.error || stderr) {
          console.warn(
            `[chart-gen] worker render error: ${(msg.error || stderr).slice(0, 500)}`,
          );
        }
        finish(null);
      }
      child.disconnect?.();
    });

    child.on("error", (e) => {
      console.warn(`[chart-gen] worker spawn error: ${e.message}`);
      finish(null);
    });

    child.on("exit", (code, signal) => {
      if (settled) return;
      console.warn(
        `[chart-gen] worker exited before result (code=${code}, signal=${signal})${stderr ? `: ${stderr.slice(0, 500)}` : ""}`,
      );
      finish(null);
    });

    try {
      child.send({ type: "render-chart", spec });
    } catch (e) {
      console.warn(`[chart-gen] worker send error: ${e.message}`);
      finish(null);
    }
  });
}

async function renderChart(spec) {
  // spec 결함 보완(DEF-005)은 부모 프로세스에서 수행해야 warn이 서버 로그에 보인다.
  // (worker의 stderr는 성공 렌더 시 버려지므로 worker 안 warn은 무음이 된다.)
  spec = backfillChartSpec(spec);
  // 유효 데이터 포인트가 0개면 축만 있는 빈 차트가 조용히 삽입된다(DEF-017).
  // 빈 PNG를 만들지 말고 null을 반환해 호출부(generate.js)가 실패를 가시화하게 한다.
  if (countRenderableSpecPoints(spec) === 0) {
    console.warn(`[chart-gen] 데이터 0점: ${specTitleForLog(spec)}`);
    return null;
  }
  if (process.env.CHART_RENDER_WORKER === "1" || process.env.CHART_RENDER_INLINE === "1") {
    return renderChartBestEffort(spec);
  }
  return renderChartInWorker(spec);
}

if (process.argv.includes("--chart-worker")) {
  process.on("message", async (msg) => {
    if (!msg || msg.type !== "render-chart") return;
    const buf = await renderChartBestEffort(msg.spec);
    if (buf) {
      process.send?.({ type: "chart-result", ok: true, base64: buf.toString("base64") });
    } else {
      process.send?.({ type: "chart-result", ok: false, error: "render returned null" });
    }
    process.exit(0);
  });
} else {
  module.exports = { renderChart, normalizeChartSpecForImage, toEnglishLabel };
}
