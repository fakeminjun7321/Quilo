"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const sharp = require("sharp");
const { compileTex } = require("../pdf-translate/latex-pdf");

const FONT_DIR = path.join(__dirname, "../../fonts");
const BODY_FONT = "Pretendard-Regular.ttf";
const BOLD_FONT = "Pretendard-Bold.ttf";
const PAGE_W_MM = 210;
const PAGE_H_MM = 297;

function escapeTex(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/\n/g, "\\par ");
}

function f(value) {
  return Number(value).toFixed(3).replace(/\.000$/, "");
}

function pageX(v) { return f(v * PAGE_W_MM); }
function pageY(v) { return f(v * PAGE_H_MM); }

function colorKey(color) {
  const c = String(color || "black").toLowerCase();
  if (!c.startsWith("#")) return c;
  return `rest${crypto.createHash("sha1").update(c).digest("hex").slice(0, 8)}`;
}

function collectColors(plan) {
  const colors = new Map();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    for (const [key, child] of Object.entries(value)) {
      if ((key === "stroke" || key === "fill" || key === "background") && /^#[0-9a-f]{6}$/i.test(String(child))) {
        colors.set(colorKey(child), String(child).slice(1).toUpperCase());
      } else visit(child);
    }
  };
  visit(plan);
  return colors;
}

function tikzColor(value) {
  return colorKey(value || "black");
}

function primitiveStyle(p, { arrow = false, both = false } = {}) {
  const parts = [
    `draw=${tikzColor(p.stroke)}`,
    `line width=${f(p.width * 0.32)}mm`,
    `opacity=${f(p.opacity)}`,
  ];
  if (p.fill && p.fill !== "none") parts.push(`fill=${tikzColor(p.fill)}`);
  if (p.dash === "dashed") parts.push("dashed");
  if (p.dash === "dotted") parts.push("dotted");
  if (both) parts.push("<->", ">={Stealth[length=2mm]}");
  else if (arrow) parts.push("->", ">={Stealth[length=2mm]}");
  return parts.join(",");
}

function localPoint(block, x, y) {
  return [
    (block.x + x * block.w) * PAGE_W_MM,
    (block.y + y * block.h) * PAGE_H_MM,
  ];
}

function coord(block, x, y) {
  const [px, py] = localPoint(block, x, y);
  return `(${f(px)},${f(py)})`;
}

function renderLabel(block, p, math = false) {
  const [x, y] = localPoint(block, p.x, p.y);
  const body = math ? `$${p.latex}$` : escapeTex(p.text);
  return `\\node[anchor=${p.anchor},inner sep=0pt,text=${tikzColor(p.stroke)},opacity=${f(p.opacity)}] at (${f(x)},${f(y)}) {\\fontsize{${f(p.size)}}{${f(p.size * 1.18)}}\\selectfont ${body}};`;
}

function renderAxis(block, p) {
  const lines = [`\\draw[${primitiveStyle(p, { arrow: true })}] ${coord(block, p.x1, p.y1)} -- ${coord(block, p.x2, p.y2)};`];
  const [ax, ay] = localPoint(block, p.x1, p.y1);
  const [bx, by] = localPoint(block, p.x2, p.y2);
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  const nx = -dy / length;
  const ny = dx / length;
  for (const tick of p.ticks) {
    const tx = ax + dx * tick.at;
    const ty = ay + dy * tick.at;
    const tickHalf = 1.1;
    lines.push(`\\draw[draw=${tikzColor(p.stroke)},line width=0.18mm] (${f(tx - nx * tickHalf)},${f(ty - ny * tickHalf)}) -- (${f(tx + nx * tickHalf)},${f(ty + ny * tickHalf)});`);
    if (tick.label) lines.push(`\\node[anchor=north,inner sep=1pt] at (${f(tx + nx * 2)},${f(ty + ny * 2)}) {\\fontsize{7}{8}\\selectfont ${escapeTex(tick.label)}};`);
  }
  if (p.label) lines.push(`\\node[anchor=south west,inner sep=1pt] at (${f(bx)},${f(by)}) {\\fontsize{8}{9}\\selectfont ${escapeTex(p.label)}};`);
  return lines.join("\n");
}

function renderDimension(block, p) {
  let [ax, ay] = localPoint(block, p.x1, p.y1);
  let [bx, by] = localPoint(block, p.x2, p.y2);
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.max(0.001, Math.hypot(dx, dy));
  const offMm = p.offset * Math.min(block.w * PAGE_W_MM, block.h * PAGE_H_MM);
  const nx = (-dy / length) * offMm;
  const ny = (dx / length) * offMm;
  ax += nx; ay += ny; bx += nx; by += ny;
  return [
    `\\draw[${primitiveStyle(p, { both: true })}] (${f(ax)},${f(ay)}) -- (${f(bx)},${f(by)});`,
    `\\node[fill=white,fill opacity=.88,text opacity=1,inner sep=1pt] at (${f((ax + bx) / 2)},${f((ay + by) / 2)}) {\\fontsize{8}{9}\\selectfont ${escapeTex(p.label)}};`,
  ].join("\n");
}

function renderPrimitive(block, p) {
  switch (p.type) {
    case "line":
      return `\\draw[${primitiveStyle(p)}] ${coord(block, p.x1, p.y1)} -- ${coord(block, p.x2, p.y2)};`;
    case "arrow":
      return `\\draw[${primitiveStyle(p, { arrow: true })}] ${coord(block, p.x1, p.y1)} -- ${coord(block, p.x2, p.y2)};`;
    case "polyline":
    case "curve": {
      const points = p.points.map(([x, y]) => coord(block, x, y)).join(" ");
      const smooth = p.type === "curve" ? "plot[smooth] coordinates" : "plot coordinates";
      return `\\draw[${primitiveStyle(p)}] ${smooth} {${points}};`;
    }
    case "circle": {
      const [cx, cy] = localPoint(block, p.cx, p.cy);
      const radius = p.r * Math.min(block.w * PAGE_W_MM, block.h * PAGE_H_MM);
      return `\\draw[${primitiveStyle(p)}] (${f(cx)},${f(cy)}) circle (${f(radius)}mm);`;
    }
    case "ellipse": {
      const [cx, cy] = localPoint(block, p.cx, p.cy);
      return `\\draw[${primitiveStyle(p)}] (${f(cx)},${f(cy)}) ellipse [x radius=${f(p.rx * block.w * PAGE_W_MM)}mm,y radius=${f(p.ry * block.h * PAGE_H_MM)}mm];`;
    }
    case "rect": {
      const x1 = (block.x + p.x * block.w) * PAGE_W_MM;
      const y1 = (block.y + p.y * block.h) * PAGE_H_MM;
      const x2 = x1 + p.w * block.w * PAGE_W_MM;
      const y2 = y1 + p.h * block.h * PAGE_H_MM;
      const radius = p.radius * Math.min(block.w * PAGE_W_MM, block.h * PAGE_H_MM);
      return `\\draw[${primitiveStyle(p)},rounded corners=${f(radius)}mm] (${f(x1)},${f(y1)}) rectangle (${f(x2)},${f(y2)});`;
    }
    case "label": return renderLabel(block, p, false);
    case "math_label": return renderLabel(block, p, true);
    case "axis": return renderAxis(block, p);
    case "plot": {
      const points = p.points.map(([x, y]) => coord(block, x, y)).join(" ");
      const marks = p.marker === "circle" ? "mark=*" : p.marker === "square" ? "mark=square*" : "mark=none";
      return `\\draw[${primitiveStyle(p)}] plot[smooth,${marks},mark size=1pt] coordinates {${points}};`;
    }
    case "angle": {
      const [cx, cy] = localPoint(block, p.cx, p.cy);
      const r = p.r * Math.min(block.w * PAGE_W_MM, block.h * PAGE_H_MM);
      const mid = ((p.start_deg + p.end_deg) / 2) * Math.PI / 180;
      const label = p.label
        ? `\n\\node[inner sep=1pt] at (${f(cx + Math.cos(mid) * r * 1.25)},${f(cy - Math.sin(mid) * r * 1.25)}) {\\fontsize{8}{9}\\selectfont ${escapeTex(p.label)}};`
        : "";
      return `\\draw[${primitiveStyle(p, { arrow: true })}] (${f(cx + Math.cos(p.start_deg * Math.PI / 180) * r)},${f(cy - Math.sin(p.start_deg * Math.PI / 180) * r)}) arc[start angle=${f(-p.start_deg)},end angle=${f(-p.end_deg)},radius=${f(r)}mm];${label}`;
    }
    case "dimension": return renderDimension(block, p);
    default: return "";
  }
}

function alignCommand(align) {
  if (align === "center") return "\\centering ";
  if (align === "right") return "\\RaggedLeft ";
  if (align === "justify") return "\\justifying ";
  return "\\RaggedRight ";
}

function renderTextBlock(block) {
  const x = pageX(block.x);
  const y = pageY(block.y);
  const width = f(block.w * PAGE_W_MM);
  const weight = block.weight === "bold" ? "\\bfseries " : "";
  const tikzAlign = block.align === "center" ? "center" : block.align === "right" ? "right" : "left";
  return `\\node[anchor=north west,inner sep=0pt,text width=${width}mm,align=${tikzAlign},opacity=${f(block.opacity)}] at (${x},${y}) {\\fontsize{${f(block.font_size)}}{${f(block.font_size * block.line_height)}}\\selectfont ${weight}${alignCommand(block.align)}${escapeTex(block.text)}};`;
}

function renderEquationBlock(block) {
  const x = (block.x + (block.align === "left" ? 0 : block.align === "right" ? block.w : block.w / 2)) * PAGE_W_MM;
  const anchor = block.align === "left" ? "north west" : block.align === "right" ? "north east" : "north";
  return `\\node[anchor=${anchor},inner sep=0pt,opacity=${f(block.opacity)}] at (${f(x)},${pageY(block.y)}) {\\fontsize{${f(block.font_size)}}{${f(block.font_size * 1.2)}}\\selectfont $\\displaystyle ${block.latex}$};`;
}

function renderTableBlock(block) {
  const cols = block.rows[0].length;
  const widthMm = block.w * PAGE_W_MM;
  const colMm = Math.max(6, (widthMm - (cols + 1) * 1.2) / cols);
  const spec = Array.from({ length: cols }, () => `p{${f(colMm)}mm}`).join(block.borders ? "|" : "");
  const rows = [];
  if (block.borders) rows.push("\\hline");
  block.rows.forEach((row, ri) => {
    const cells = row.map((cell) => `${ri < block.header_rows ? "\\bfseries " : ""}${escapeTex(cell)}`);
    rows.push(`${cells.join(" & ")} \\\\`);
    if (block.borders || ri + 1 === block.header_rows) rows.push("\\hline");
  });
  return `\\node[anchor=north west,inner sep=0pt,opacity=${f(block.opacity)}] at (${pageX(block.x)},${pageY(block.y)}) {\\fontsize{${f(block.font_size)}}{${f(block.font_size * 1.25)}}\\selectfont \\begin{tabular}{${block.borders ? `|${spec}|` : spec}}${rows.join("\n")}\\end{tabular}};`;
}

function renderBlock(block, rasterAssetName) {
  if (block.type === "text") return renderTextBlock(block);
  if (block.type === "equation") return renderEquationBlock(block);
  if (block.type === "table") return renderTableBlock(block);
  if (block.type === "diagram") return block.primitives.map((p) => renderPrimitive(block, p)).join("\n");
  if (block.type === "raster" && rasterAssetName) {
    const x = (block.x + block.w / 2) * PAGE_W_MM;
    const y = (block.y + block.h / 2) * PAGE_H_MM;
    return `\\node[inner sep=0pt,opacity=${f(block.opacity)}] at (${f(x)},${f(y)}) {\\includegraphics[width=${f(block.w * PAGE_W_MM)}mm,height=${f(block.h * PAGE_H_MM)}mm,keepaspectratio]{${rasterAssetName}}};`;
  }
  if (block.type === "rule") {
    if (block.orientation === "vertical") {
      return `\\draw[draw=${tikzColor(block.stroke)},line width=${f(block.width * 0.32)}mm] (${pageX(block.x)},${pageY(block.y)}) -- (${pageX(block.x)},${pageY(block.y + block.h)});`;
    }
    return `\\draw[draw=${tikzColor(block.stroke)},line width=${f(block.width * 0.32)}mm] (${pageX(block.x)},${pageY(block.y)}) -- (${pageX(block.x + block.w)},${pageY(block.y)});`;
  }
  return "";
}

async function cropRaster(source, crop) {
  const oriented = await sharp(source, { limitInputPixels: 80_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .png()
    .toBuffer();
  const meta = await sharp(oriented).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (!W || !H) throw new Error("원본 사진 크기를 읽을 수 없습니다.");
  const left = Math.min(W - 1, Math.max(0, Math.floor(crop.x * W)));
  const top = Math.min(H - 1, Math.max(0, Math.floor(crop.y * H)));
  const width = Math.max(2, Math.min(W - left, Math.ceil(crop.w * W)));
  const height = Math.max(2, Math.min(H - top, Math.ceil(crop.h * H)));
  return sharp(oriented).extract({ left, top, width, height }).png({ compressionLevel: 6 }).toBuffer();
}

async function prepareRasterAssets(plan, sourcePhotos) {
  const assets = [];
  const names = new Map();
  for (let pi = 0; pi < plan.pages.length; pi += 1) {
    const page = plan.pages[pi];
    for (let bi = 0; bi < page.blocks.length; bi += 1) {
      const block = page.blocks[bi];
      if (block.type !== "raster") continue;
      const src = sourcePhotos[block.crop.source_index - 1];
      if (!src || !Buffer.isBuffer(src.buffer)) {
        throw new Error(`raster 원본 사진 ${block.crop.source_index}을 찾을 수 없습니다.`);
      }
      const name = `restore-raster-p${pi + 1}-b${bi + 1}.png`;
      const buffer = await cropRaster(src.buffer, block.crop);
      if (buffer.length < 100) throw new Error(`raster crop ${pi + 1}/${bi + 1}가 비어 있습니다.`);
      assets.push({ name, buffer });
      names.set(`${pi}:${bi}`, name);
    }
  }
  return { assets, names };
}

function buildTex(plan, rasterNames = new Map()) {
  const colors = collectColors(plan);
  const colorDefs = [...colors.entries()].map(([name, hex]) => `\\definecolor{${name}}{HTML}{${hex}}`).join("\n");
  const pages = plan.pages.map((page, pi) => {
    const background = tikzColor(page.background);
    const layers = ["background", "foreground"].map((layer) => page.blocks
      .map((block, bi) => block.layer === layer ? renderBlock(block, rasterNames.get(`${pi}:${bi}`)) : "")
      .filter(Boolean)
      .join("\n"));
    return `\\begin{tikzpicture}[x=1mm,y=-1mm]
\\useasboundingbox (0,0) rectangle (${PAGE_W_MM},${PAGE_H_MM});
\\fill[${background}] (0,0) rectangle (${PAGE_W_MM},${PAGE_H_MM});
${layers[0]}
${layers[1]}
\\end{tikzpicture}${pi + 1 < plan.pages.length ? "\\newpage" : ""}`;
  }).join("\n");
  return `\\documentclass[10pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath,amssymb}
\\usepackage[a4paper,margin=0pt]{geometry}
\\usepackage{tikz}
\\usetikzlibrary{arrows.meta}
\\usepackage{xcolor}
\\usepackage{graphicx}
\\usepackage{array}
\\usepackage{ragged2e}
\\setmainfont{${BODY_FONT}}[Path=${FONT_DIR}/,BoldFont=${BOLD_FONT}]
\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
${colorDefs}
\\begin{document}
${pages}
\\end{document}
`;
}

async function renderDocumentPlan(plan, sourcePhotos, { signal, onProgress = () => {} } = {}) {
  onProgress("🧩 의미 기반 도형과 문서 레이아웃을 벡터로 조판 중...");
  const { assets, names } = await prepareRasterAssets(plan, sourcePhotos);
  const tex = buildTex(plan, names);
  const buffer = await compileTex(tex, { assets, signal, onProgress });
  return { buffer, tex, rasterAssetCount: assets.length };
}

module.exports = {
  PAGE_W_MM,
  PAGE_H_MM,
  escapeTex,
  buildTex,
  prepareRasterAssets,
  renderDocumentPlan,
};
