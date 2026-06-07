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
// 영어 차트 어휘 → 한국어 (모델이 끝까지 영어 라벨을 낼 때의 결정론적 안전망).
// 긴 구(phrase)부터 치환. 단위·기호(Hz, N, kg, m/s 등)는 건드리지 않는다.
const EN_CHART_TERMS = [
  ["Harmonic Number", "차수"], ["Mass Difference", "질량 차이"], ["Mass difference", "질량 차이"],
  ["Speed squared", "속력 제곱"], ["Speed Squared", "속력 제곱"], ["Linear fit", "선형 회귀"],
  ["Linear Fit", "선형 회귀"], ["Initial Energy", "초기 에너지"], ["Final Energy", "나중 에너지"],
  ["Resonance Frequency", "공명 진동수"], ["Angular velocity", "각속도"], ["Angular Velocity", "각속도"],
  ["Measured mean", "측정 평균"], ["Measured", "측정값"], ["Theory", "이론값"], ["Theoretical", "이론값"],
  ["Corrected", "보정값"], ["Ideal", "이론"], ["Frequency", "진동수"], ["Acceleration", "가속도"],
  ["Velocity", "속도"], ["Speed", "속력"], ["Force", "힘"], ["Energy", "에너지"], ["Radius", "반지름"],
  ["Period", "주기"], ["Amplitude", "진폭"], ["Distance", "거리"], ["Length", "길이"], ["Angle", "각도"],
  ["Trial", "시행"], ["Run", "시행"], ["Exp.", "측정값"], ["Exp", "측정값"], ["Mass", "질량"],
  ["Time", "시간"], ["Number", "차수"], ["Initial", "초기"], ["Final", "나중"], ["before", "보정 전"],
  ["after", "보정 후"], ["Before", "보정 전"], ["After", "보정 후"],
];
function deEnglishLabel(s) {
  // 한글이 이미 있으면 모델이 한국어로 쓴 것 → 그대로 둔다.
  if (/[가-힣]/.test(s)) return s;
  // 순수 숫자/단위/기호만이면(번역할 영어 단어 없음) 그대로.
  if (!/[A-Za-z]{2,}/.test(s)) return s;
  let out = s;
  for (const [en, ko] of EN_CHART_TERMS) {
    out = out.replace(new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), ko);
  }
  return out;
}
// 한글 보존 라벨: markdown 강조 제거 + 위/아래첨자 유니코드화 + (영어면) 한글 보정
function koreanLabel(raw, fallback = "") {
  let s = String(raw ?? "").trim();
  if (!s) return fallback;
  s = s.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  s = toUnicodeScripts(s);
  return deEnglishLabel(s);
}

function normalizeChartSpecForImage(spec) {
  if (!spec || typeof spec !== "object") return spec;
  const normalized = { ...spec };
  // 폰트가 있으면 한글 라벨 유지(영어 강제 변환 금지). 없으면 기존 ASCII fallback.
  if (koreanFontAvailable()) {
    normalized.title = koreanLabel(spec.title, "실험 그래프");
    normalized.x_label = koreanLabel(spec.x_label, "");
    normalized.y_label = koreanLabel(spec.y_label, "");
    if (Array.isArray(spec.x_values)) {
      normalized.x_values = spec.x_values.map((v) => koreanLabel(v, ""));
    }
    if (Array.isArray(spec.series)) {
      normalized.series = spec.series.map((series, index) => ({
        ...series,
        label: koreanLabel(series?.label, `계열 ${index + 1}`),
      }));
    }
    for (const key of ["trendline", "fit_line", "regression_line", "reference_line"]) {
      if (spec[key] && typeof spec[key] === "object") {
        normalized[key] = { ...spec[key], label: koreanLabel(spec[key].label, "") };
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
  if (rawPoints) {
    return rawPoints
      .map((point, i) => normalizePoint(point, spec.x_values?.[i] ?? i))
      .filter(Boolean);
  }

  const values = Array.isArray(seriesItem.values) ? seriesItem.values : [];
  return values
    .map((y, i) => normalizePoint(y, spec.x_values?.[i] ?? i))
    .filter(Boolean);
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

  const color = trend.color || "#d0021b";
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
  const labels = cleanLabels(spec.x_values);
  const series = Array.isArray(spec.series) ? spec.series : [];
  const isScatter = spec.type === "scatter";

  const datasets = series.map((s, i) => {
    const color = COLORS[i % COLORS.length];
    const base = {
      label: stripMarkers(s.label || `series ${i + 1}`),
      data: isScatter ? scatterPoints(spec, s) : (Array.isArray(s.values) ? s.values : []),
    };
    if (spec.type === "line") {
      return {
        ...base,
        borderColor: color,
        backgroundColor: color + "33",
        fill: false,
        tension: 0.1,
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

  // 참값 라인 — horizontal line dataset
  if (
    spec.reference_line &&
    typeof spec.reference_line.value === "number" &&
    labels.length > 0
  ) {
    datasets.push({
      label: stripMarkers(spec.reference_line.label || "참값"),
      type: "line",
      data: labels.map(() => spec.reference_line.value),
      borderColor: "#d0021b",
      borderDash: [6, 4],
      borderWidth: 2,
      fill: false,
      pointRadius: 0,
      order: -1, // 다른 dataset 위에
    });
  }

  return {
    type: spec.type === "scatter" ? "scatter" : spec.type === "line" ? "line" : "bar",
    data: spec.type === "scatter" ? { datasets } : { labels, datasets },
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
 * 실패하면 null 반환 (보고서 전체는 계속).
 */
async function renderChartDirect(spec) {
  try {
    const config = buildConfig(spec);
    return await getCanvas().renderToBuffer(config);
  } catch (e) {
    console.warn("[chart-gen] render error:", e.message);
    return null;
  }
}

async function renderChartBestEffort(spec) {
  spec = normalizeChartSpecForImage(spec);
  if (process.env.CHART_RENDER_ENGINE !== "chartjs") {
    const { renderChartSvg } = require("./svg-chart-gen");
    const svgBuffer = await renderChartSvg(spec);
    if (svgBuffer) return svgBuffer;
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
  module.exports = { renderChart };
}
