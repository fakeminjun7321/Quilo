// Lightweight SVG chart renderer used before the Chart.js/native-canvas fallback.
// It keeps report generation alive on Render even when node-canvas crashes.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const WIDTH = 800;
const HEIGHT = 500;
const FONT_FAMILY = "NanumGothic";
const FONT_PATH = path.join(__dirname, "..", "..", "fonts", "NanumGothic-Regular.ttf");
const COLORS = ["#4a90e2", "#e94e77", "#43b97f", "#f5a623", "#9013fe", "#50e3c2"];
const NAMED_COLORS = new Set([
  "black",
  "blue",
  "green",
  "gray",
  "grey",
  "orange",
  "purple",
  "red",
  "teal",
]);

let fontCss = null;

function getFontCss() {
  if (fontCss != null) return fontCss;
  try {
    const base64 = fs.readFileSync(FONT_PATH).toString("base64");
    fontCss = `@font-face{font-family:${FONT_FAMILY};src:url(data:font/truetype;base64,${base64}) format('truetype');}`;
  } catch (e) {
    console.warn(
      `[svg-chart-gen] 한글 폰트 로드 실패 (${FONT_PATH}): ${e.message}. 차트 한글이 기본 폰트로 렌더될 수 있음.`,
    );
    fontCss = "";
  }
  return fontCss;
}

function stripMarkers(s) {
  return String(s ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_\{([^}]+)\}/g, "$1")
    .replace(/\^\{([^}]+)\}/g, "$1");
}

function esc(s) {
  return stripMarkers(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeColor(value, fallback = "#d0021b") {
  const raw = String(value || "").trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(raw)) return raw;
  const lower = raw.toLowerCase();
  if (NAMED_COLORS.has(lower)) return lower;
  return fallback;
}

function n(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function fmt(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  const abs = Math.abs(num);
  if (abs !== 0 && (abs >= 10000 || abs < 0.001)) return num.toExponential(1);
  if (abs >= 100) return num.toFixed(0);
  if (abs >= 10) return num.toFixed(1);
  return num.toFixed(2).replace(/\.?0+$/, "");
}

function normalizePoint(point, fallbackX = null) {
  if (Array.isArray(point) && point.length >= 2) {
    const x = n(point[0]);
    const y = n(point[1]);
    return x == null || y == null ? null : { x, y };
  }
  if (point && typeof point === "object") {
    const x = n(point.x);
    const y = n(point.y);
    return x == null || y == null ? null : { x, y };
  }
  const y = n(point);
  const x = n(fallbackX);
  return x == null || y == null ? null : { x, y };
}

// series의 점 배열 필드(points 우선, data 폴백)를 얻는다. 없으면 null.
// chart-gen.js의 seriesPointList와 동일 규칙(DEF-032).
function seriesPointList(s) {
  if (Array.isArray(s?.points) && s.points.length > 0) return s.points;
  if (Array.isArray(s?.data) && s.data.length > 0) return s.data;
  return null;
}

// line spec의 데이터 series가 values 없이 수치 x·y의 points({x,y})만 갖는지 판별.
// chart-gen.js의 R1 규칙과 동일(DEF-032): 이 경우 category 축 대신 scatter식
// 선형 x축에 점을 찍고 선으로 이어야 점 간격과 trendline x 도메인이 맞는다.
function seriesUseNumericPointsOnly(series) {
  const withPoints = series.filter((s) => seriesPointList(s));
  if (withPoints.length === 0) return false;
  // values를 이미 가진 series가 섞여 있으면 기존 category 경로를 유지한다.
  if (series.some((s) => Array.isArray(s?.values) && s.values.length > 0)) return false;
  return withPoints.every((s) => seriesPointList(s).every((p) => normalizePoint(p) != null));
}

// 점 항목({x,y} 객체·[x,y] 쌍·스칼라)에서 y 수치를 뽑는다. 수치가 아니면 null.
function pointYValue(p) {
  if (Array.isArray(p)) return p.length >= 2 ? n(p[1]) : null;
  if (p && typeof p === "object") return n(p.y);
  return n(p);
}

function seriesValues(spec, item) {
  // values 우선, 없으면 points/data의 점 목록에서 y만 뽑는다(카테고리형 규칙, DEF-032).
  // null/비수치는 걸러내되 인덱스는 유지해야 x축 라벨과 정렬이 어긋나지 않는다.
  // Chart.js처럼 구멍(null)을 그 자리에 남긴다. (filter-then-reindex 금지)
  const raw =
    Array.isArray(item.values) && item.values.length > 0
      ? item.values
      : seriesPointList(item) || (Array.isArray(item.values) ? item.values : []);
  return raw.map((v) => pointYValue(v));
}

function scatterPoints(spec, item) {
  const raw = Array.isArray(item.points)
    ? item.points
    : Array.isArray(item.data)
      ? item.data
      : Array.isArray(item.values)
        ? item.values
        : [];
  return raw
    .map((point, i) => {
      // x_value가 수치가 아니면(카테고리 문자열) 인덱스 i를 x로 폴백해
      // 모든 점이 조용히 버려지는 것을 막는다.
      const rawX = spec.x_values?.[i];
      const fallbackX = n(rawX) != null ? rawX : i;
      return normalizePoint(point, fallbackX);
    })
    .filter(Boolean);
}

function niceDomain(values, includeZero = false) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length === 0) return null;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (includeZero) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.1;
    min -= pad;
    max += pad;
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

function ticks(domain, count = 5) {
  if (!domain) return [];
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(domain.min + ((domain.max - domain.min) * i) / (count - 1));
  }
  return out;
}

function labelEvery(count) {
  if (count <= 8) return 1;
  if (count <= 14) return 2;
  return Math.ceil(count / 8);
}

function makeSvg(spec) {
  const series = Array.isArray(spec.series) ? spec.series : [];
  // line spec이 values 없이 수치 points({x,y})만 갖고 오면(DEF-032) scatter식
  // 선형 x축으로 그리고 점을 데이터 순서대로 선으로 잇는다(chart-gen.js와 동일 규칙).
  const lineAsScatter = spec.type === "line" && seriesUseNumericPointsOnly(series);
  const type =
    spec.type === "scatter" || lineAsScatter
      ? "scatter"
      : spec.type === "line"
        ? "line"
        : "bar";
  let labels = Array.isArray(spec.x_values) ? spec.x_values.map(stripMarkers) : [];
  // 카테고리형인데 x_values가 비어 있고 series가 points로만 온 경우,
  // points의 x를 카테고리 라벨로 대신 쓴다(chart-gen.js buildConfig와 동일 규칙).
  if (type !== "scatter" && labels.length === 0) {
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
  const legendPerRow =
    series.length > 1 ? Math.max(1, Math.min(series.length, Math.floor((WIDTH - 114) / 220))) : 0;
  const legendRows = legendPerRow ? Math.ceil(series.length / legendPerRow) : 0;
  const plot = { left: 82, top: 72 + legendRows * 18, right: 32, bottom: 78 };
  const plotW = WIDTH - plot.left - plot.right;
  const plotH = HEIGHT - plot.top - plot.bottom;
  const chartBottom = HEIGHT - plot.bottom;
  const parts = [];
  const valueSet = [];
  const pointSeries = series.map((item) => {
    if (type === "scatter") {
      const points = scatterPoints(spec, item);
      points.forEach((p) => valueSet.push(p.y));
      return { label: stripMarkers(item.label || "series"), points };
    }
    const values = seriesValues(spec, item);
    values.forEach((v) => valueSet.push(v));
    return { label: stripMarkers(item.label || "series"), values };
  });

  if (spec.reference_line && n(spec.reference_line.value) != null) {
    valueSet.push(n(spec.reference_line.value));
  }

  let xDomain = null;
  if (type === "scatter") {
    const xs = pointSeries.flatMap((s) => s.points.map((p) => p.x));
    const trend = spec.trendline || spec.fit_line || spec.regression_line;
    if (trend && Array.isArray(trend.points)) {
      trend.points.map(normalizePoint).filter(Boolean).forEach((p) => {
        xs.push(p.x);
        valueSet.push(p.y);
      });
    }
    xDomain = niceDomain(xs, false);
  }

  const yDomain = niceDomain(valueSet, type === "bar" || spec.begin_at_zero === true);
  if (!yDomain || (type === "scatter" && !xDomain) || pointSeries.length === 0) return null;

  const xForIndex = (i) => {
    const count = Math.max(labels.length, pointSeries[0]?.values?.length || 0, 1);
    if (type === "bar") return plot.left + ((i + 0.5) * plotW) / count;
    return plot.left + (count === 1 ? plotW / 2 : (i * plotW) / (count - 1));
  };
  const xForValue = (x) =>
    plot.left + ((x - xDomain.min) / (xDomain.max - xDomain.min)) * plotW;
  const yForValue = (y) =>
    chartBottom - ((y - yDomain.min) / (yDomain.max - yDomain.min)) * plotH;

  parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="white"/>`);
  parts.push(`<rect x="${plot.left}" y="${plot.top}" width="${plotW}" height="${plotH}" fill="#fbfcfe" stroke="#ccd4df"/>`);

  for (const t of ticks(yDomain)) {
    const y = yForValue(t);
    parts.push(`<line x1="${plot.left}" y1="${y}" x2="${WIDTH - plot.right}" y2="${y}" stroke="#e1e6ee"/>`);
    parts.push(`<text x="${plot.left - 10}" y="${y + 4}" text-anchor="end" class="tick">${fmt(t)}</text>`);
  }

  if (type === "scatter") {
    for (const t of ticks(xDomain)) {
      const x = xForValue(t);
      parts.push(`<line x1="${x}" y1="${plot.top}" x2="${x}" y2="${chartBottom}" stroke="#eef1f5"/>`);
      parts.push(`<text x="${x}" y="${chartBottom + 22}" text-anchor="middle" class="tick">${fmt(t)}</text>`);
    }
  } else {
    const count = Math.max(labels.length, pointSeries[0]?.values?.length || 0);
    const every = labelEvery(count);
    for (let i = 0; i < count; i++) {
      const x = xForIndex(i);
      parts.push(`<line x1="${x}" y1="${chartBottom}" x2="${x}" y2="${chartBottom + 5}" stroke="#9aa8b7"/>`);
      if (i % every === 0) {
        const label = labels[i] || String(i + 1);
        parts.push(`<text x="${x}" y="${chartBottom + 23}" text-anchor="middle" class="tick">${esc(label)}</text>`);
      }
    }
  }

  if (spec.reference_line && n(spec.reference_line.value) != null) {
    const y = yForValue(n(spec.reference_line.value));
    parts.push(`<line x1="${plot.left}" y1="${y}" x2="${WIDTH - plot.right}" y2="${y}" stroke="#d0021b" stroke-width="2" stroke-dasharray="7 5"/>`);
    if (spec.reference_line.label) {
      parts.push(`<text x="${WIDTH - plot.right - 4}" y="${y - 6}" text-anchor="end" class="legend">${esc(spec.reference_line.label)}</text>`);
    }
  }

  if (type === "bar") {
    const count = Math.max(labels.length, pointSeries[0]?.values?.length || 0, 1);
    const groupW = plotW / count;
    const barW = Math.max(6, Math.min(36, (groupW * 0.72) / Math.max(pointSeries.length, 1)));
    const zeroY = yForValue(Math.max(0, yDomain.min));
    pointSeries.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      s.values.forEach((v, i) => {
        // null/비수치는 막대를 생략하되 슬롯(인덱스 i)은 그대로 둔다.
        if (v == null || !Number.isFinite(v)) return;
        const x = xForIndex(i) - (barW * pointSeries.length) / 2 + si * barW;
        const y = yForValue(v);
        const h = Math.abs(zeroY - y);
        parts.push(`<rect x="${x}" y="${Math.min(y, zeroY)}" width="${barW - 2}" height="${h}" fill="${color}" opacity="0.86"/>`);
      });
    });
  } else if (type === "line") {
    pointSeries.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      // null 구멍에서 선을 끊는다(Chart.js의 null=gap 동작). 각 점은 원래 인덱스 i의
      // x 위치에 찍고, 연속 구간마다 별도 polyline으로 그린다.
      let segment = [];
      const flush = () => {
        if (segment.length >= 2) {
          parts.push(`<polyline points="${segment.join(" ")}" fill="none" stroke="${color}" stroke-width="3"/>`);
        }
        segment = [];
      };
      s.values.forEach((v, i) => {
        if (v == null || !Number.isFinite(v)) {
          flush();
          return;
        }
        segment.push(`${xForIndex(i)},${yForValue(v)}`);
        parts.push(`<circle cx="${xForIndex(i)}" cy="${yForValue(v)}" r="4" fill="${color}"/>`);
      });
      flush();
    });
  } else {
    pointSeries.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      // points-only line spec(DEF-032): Chart.js의 scatter+showLine처럼
      // 점을 데이터 순서대로 선으로 이어 line 차트로 보이게 한다.
      if (lineAsScatter && s.points.length >= 2) {
        const linePath = s.points
          .map((p) => `${xForValue(p.x)},${yForValue(p.y)}`)
          .join(" ");
        parts.push(`<polyline points="${linePath}" fill="none" stroke="${color}" stroke-width="3"/>`);
      }
      s.points.forEach((p) => {
        parts.push(`<circle cx="${xForValue(p.x)}" cy="${yForValue(p.y)}" r="${lineAsScatter ? 4 : 5}" fill="${color}" opacity="0.88"/>`);
      });
    });
    const trend = spec.trendline || spec.fit_line || spec.regression_line;
    let trendPoints = null;
    if (trend && Array.isArray(trend.points)) {
      trendPoints = trend.points.map(normalizePoint).filter(Boolean);
    } else if (trend) {
      const slope = n(trend.slope ?? trend.m);
      const intercept = n(trend.intercept ?? trend.b);
      const xMin = n(trend.x_min ?? trend.xMin) ?? xDomain.min;
      const xMax = n(trend.x_max ?? trend.xMax) ?? xDomain.max;
      if (slope != null && intercept != null) {
        trendPoints = [
          { x: xMin, y: slope * xMin + intercept },
          { x: xMax, y: slope * xMax + intercept },
        ];
      }
    }
    if (trendPoints && trendPoints.length >= 2) {
      const p1 = trendPoints[0];
      const p2 = trendPoints[trendPoints.length - 1];
      parts.push(`<line x1="${xForValue(p1.x)}" y1="${yForValue(p1.y)}" x2="${xForValue(p2.x)}" y2="${yForValue(p2.y)}" stroke="${safeColor(trend?.color)}" stroke-width="2.5" stroke-dasharray="7 5"/>`);
    }
  }

  if (spec.title) {
    parts.push(`<text x="${WIDTH / 2}" y="34" text-anchor="middle" class="title">${esc(spec.title)}</text>`);
  }
  if (spec.x_label) {
    parts.push(`<text x="${plot.left + plotW / 2}" y="${HEIGHT - 24}" text-anchor="middle" class="axis">${esc(spec.x_label)}</text>`);
  }
  if (spec.y_label) {
    parts.push(`<text transform="translate(24 ${plot.top + plotH / 2}) rotate(-90)" text-anchor="middle" class="axis">${esc(spec.y_label)}</text>`);
  }

  if (pointSeries.length > 1) {
    const itemW = plotW / Math.max(legendPerRow, 1);
    pointSeries.forEach((s, i) => {
      const col = i % Math.max(legendPerRow, 1);
      const row = Math.floor(i / Math.max(legendPerRow, 1));
      const x = plot.left + col * itemW;
      const y = 52 + row * 18;
      parts.push(`<rect x="${x}" y="${y - 10}" width="12" height="12" fill="${COLORS[i % COLORS.length]}"/>`);
      parts.push(`<text x="${x + 18}" y="${y}" class="legend">${esc(s.label)}</text>`);
    });
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
<style>${getFontCss()}
text{font-family:${FONT_FAMILY},Arial,sans-serif;fill:#172033}
.title{font-size:22px;font-weight:700}
.axis{font-size:15px;font-weight:700}
.tick{font-size:12px}
.legend{font-size:13px;font-weight:600}
</style>
${parts.join("\n")}
</svg>`;
}

// 경고 로그용 차트 제목(마커 제거, 없으면 자리표시 문구).
function specTitleForLog(spec) {
  return stripMarkers(spec?.title) || "(제목 없음)";
}

// gpt-5.5가 x_values 없이 series[].values만 담은 spec을 내는 경우(DEF-005).
// 보통은 chart-gen.js가 먼저 보완한 spec을 넘겨주지만(그 경우 여기는 no-op),
// 이 모듈이 직접 호출될 때도 무음이 아니도록 같은 규칙으로 x 라벨을
// 1..N 인덱스로 보완하고 누락 필드를 console.warn으로 남긴다.
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
    `[svg-chart-gen] chart spec 결함(누락 필드: ${missing.join(", ")}) 차트: ${specTitleForLog(spec)} / x_values를 1..${count} 인덱스 라벨로 보완`,
  );
  return {
    ...spec,
    x_values: Array.from({ length: count }, (_, i) => String(i + 1)),
  };
}

async function renderChartSvg(spec) {
  try {
    spec = backfillChartSpec(spec);
    const svg = makeSvg(spec);
    if (!svg) return null;
    return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  } catch (e) {
    console.warn(`[svg-chart-gen] render error (차트: ${specTitleForLog(spec)}): ${e.message}`);
    return null;
  }
}

module.exports = { renderChartSvg, safeColor };
