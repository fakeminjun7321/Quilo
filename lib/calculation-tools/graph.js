"use strict";

const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const TYPES = new Set(["scatter", "line", "bar"]);
const colorPattern = /^#[0-9a-f]{6}$/i;
const escapeXml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);

function normalizeGraph(input = {}) {
  const type = TYPES.has(input.type) ? input.type : "scatter";
  const x = Array.isArray(input.x) ? input.x : [];
  const y = Array.isArray(input.y) ? input.y : [];
  if (!y.length || y.length > 5000) throw new Error("y 데이터는 1~5,000개가 필요합니다.");
  if (x.length && x.length !== y.length) throw new Error("x와 y 데이터 개수가 같아야 합니다.");
  const labels = x.length ? x : y.map((_, index) => index + 1);
  const pairs = y.map((raw, index) => ({ x: labels[index], y: Number(raw) }));
  if (pairs.some((point) => !Number.isFinite(point.y))) throw new Error("y에는 유효한 숫자만 사용할 수 있습니다.");
  if (type !== "bar" && pairs.some((point) => !Number.isFinite(Number(point.x)))) throw new Error("산점도와 선 그래프의 x는 숫자여야 합니다.");
  return {
    type,
    title: String(input.title || "그래프").slice(0, 120),
    xLabel: String(input.xLabel || "x").slice(0, 80),
    yLabel: String(input.yLabel || "y").slice(0, 80),
    seriesLabel: String(input.seriesLabel || "데이터").slice(0, 80),
    color: colorPattern.test(input.color || "") ? input.color : "#2563eb",
    labels,
    pairs,
  };
}

function chartConfig(graph) {
  const bar = graph.type === "bar";
  return {
    type: bar ? "bar" : graph.type === "line" ? "line" : "scatter",
    data: bar
      ? { labels: graph.labels.map(String), datasets: [{ label: graph.seriesLabel, data: graph.pairs.map((p) => p.y), backgroundColor: `${graph.color}bb`, borderColor: graph.color, borderWidth: 2 }] }
      : { datasets: [{ label: graph.seriesLabel, data: graph.pairs.map((p) => ({ x: Number(p.x), y: p.y })), borderColor: graph.color, backgroundColor: graph.color, showLine: graph.type === "line", pointRadius: 3, borderWidth: 2 }] },
    options: {
      responsive: false,
      animation: false,
      plugins: { title: { display: true, text: graph.title, font: { size: 22 } }, legend: { display: true } },
      scales: {
        x: { type: bar ? "category" : "linear", title: { display: true, text: graph.xLabel }, grid: { color: "#e5e7eb" } },
        y: { title: { display: true, text: graph.yLabel }, grid: { color: "#e5e7eb" } },
      },
    },
    plugins: [{ id: "white-background", beforeDraw(chart) { const ctx = chart.ctx; ctx.save(); ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, chart.width, chart.height); ctx.restore(); } }],
  };
}

async function renderPng(input) {
  const graph = normalizeGraph(input);
  const width = Math.min(2000, Math.max(400, Number(input.width) || 1000));
  const height = Math.min(1400, Math.max(300, Number(input.height) || 650));
  const canvas = new ChartJSNodeCanvas({ width, height, backgroundColour: "white" });
  return canvas.renderToBuffer(chartConfig(graph), "image/png");
}

function renderSvg(input) {
  const graph = normalizeGraph(input);
  const width = Math.min(2000, Math.max(400, Number(input.width) || 1000));
  const height = Math.min(1400, Math.max(300, Number(input.height) || 650));
  const pad = { left: 90, right: 40, top: 70, bottom: 80 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const xNumbers = graph.type === "bar" ? graph.pairs.map((_, index) => index) : graph.pairs.map((p) => Number(p.x));
  const yNumbers = graph.type === "bar" ? [0, ...graph.pairs.map((p) => p.y)] : graph.pairs.map((p) => p.y);
  const extent = (values) => { let min = Math.min(...values); let max = Math.max(...values); if (min === max) { min -= 1; max += 1; } return [min, max]; };
  const [minX, maxX] = extent(xNumbers);
  const [minY, maxY] = extent(yNumbers);
  const px = (value) => pad.left + (value - minX) / (maxX - minX) * plotW;
  const py = (value) => pad.top + plotH - (value - minY) / (maxY - minY) * plotH;
  const marks = [];
  if (graph.type === "bar") {
    const barWidth = Math.max(2, plotW / graph.pairs.length * 0.72);
    graph.pairs.forEach((point, index) => {
      const x = px(index) - barWidth / 2;
      const y = py(Math.max(0, point.y));
      const base = py(Math.min(0, point.y));
      marks.push(`<rect x="${x}" y="${Math.min(y, base)}" width="${barWidth}" height="${Math.max(1, Math.abs(base - y))}" fill="${graph.color}" fill-opacity="0.75"/>`);
    });
  } else {
    if (graph.type === "line") marks.push(`<polyline fill="none" stroke="${graph.color}" stroke-width="2" points="${graph.pairs.map((p) => `${px(Number(p.x))},${py(p.y)}`).join(" ")}"/>`);
    graph.pairs.forEach((point) => marks.push(`<circle cx="${px(Number(point.x))}" cy="${py(point.y)}" r="3.5" fill="${graph.color}"/>`));
  }
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="100%" height="100%" fill="white"/><text x="${width / 2}" y="34" text-anchor="middle" font-family="sans-serif" font-size="22">${escapeXml(graph.title)}</text>
<line x1="${pad.left}" y1="${pad.top + plotH}" x2="${pad.left + plotW}" y2="${pad.top + plotH}" stroke="#111827"/><line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${pad.top + plotH}" stroke="#111827"/>
${marks.join("")}<text x="${pad.left + plotW / 2}" y="${height - 24}" text-anchor="middle" font-family="sans-serif">${escapeXml(graph.xLabel)}</text>
<text x="22" y="${pad.top + plotH / 2}" text-anchor="middle" font-family="sans-serif" transform="rotate(-90 22 ${pad.top + plotH / 2})">${escapeXml(graph.yLabel)}</text>
</svg>`, "utf8");
}

module.exports = { normalizeGraph, renderPng, renderSvg };
