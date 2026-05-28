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

let fontCss = null;

function getFontCss() {
  if (fontCss != null) return fontCss;
  try {
    const base64 = fs.readFileSync(FONT_PATH).toString("base64");
    fontCss = `@font-face{font-family:${FONT_FAMILY};src:url(data:font/truetype;base64,${base64}) format('truetype');}`;
  } catch (_) {
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

function seriesValues(spec, item) {
  const raw = Array.isArray(item.values) ? item.values : Array.isArray(item.data) ? item.data : [];
  return raw.map(n).filter((v) => v != null);
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
    .map((point, i) => normalizePoint(point, spec.x_values?.[i] ?? i))
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
  const type = spec.type === "scatter" ? "scatter" : spec.type === "line" ? "line" : "bar";
  const series = Array.isArray(spec.series) ? spec.series : [];
  const labels = Array.isArray(spec.x_values) ? spec.x_values.map(stripMarkers) : [];
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
        const x = xForIndex(i) - (barW * pointSeries.length) / 2 + si * barW;
        const y = yForValue(v);
        const h = Math.abs(zeroY - y);
        parts.push(`<rect x="${x}" y="${Math.min(y, zeroY)}" width="${barW - 2}" height="${h}" fill="${color}" opacity="0.86"/>`);
      });
    });
  } else if (type === "line") {
    pointSeries.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      const points = s.values
        .map((v, i) => `${xForIndex(i)},${yForValue(v)}`)
        .join(" ");
      if (points) {
        parts.push(`<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>`);
        s.values.forEach((v, i) => {
          parts.push(`<circle cx="${xForIndex(i)}" cy="${yForValue(v)}" r="4" fill="${color}"/>`);
        });
      }
    });
  } else {
    pointSeries.forEach((s, si) => {
      const color = COLORS[si % COLORS.length];
      s.points.forEach((p) => {
        parts.push(`<circle cx="${xForValue(p.x)}" cy="${yForValue(p.y)}" r="5" fill="${color}" opacity="0.88"/>`);
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
      parts.push(`<line x1="${xForValue(p1.x)}" y1="${yForValue(p1.y)}" x2="${xForValue(p2.x)}" y2="${yForValue(p2.y)}" stroke="${trend?.color || "#d0021b"}" stroke-width="2.5" stroke-dasharray="7 5"/>`);
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

async function renderChartSvg(spec) {
  try {
    const svg = makeSvg(spec);
    if (!svg) return null;
    return await sharp(Buffer.from(svg, "utf8")).png().toBuffer();
  } catch (e) {
    console.warn("[svg-chart-gen] render error:", e.message);
    return null;
  }
}

module.exports = { renderChartSvg };
