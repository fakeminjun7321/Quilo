// 자유 보고서 (free-report) - docx 생성
//
// JSON 스키마(prompt.md):
//   { title, subtitle?, sections:[{heading, blocks:[...]}], references? }
// blocks 원소: 문자열(문단) | {subheading} | {equation} | {table} | {chart} | {image} | {list}

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  TableLayoutType,
  WidthType,
  ShadingType,
  ImageRun,
  Footer,
  PageNumber,
  convertMillimetersToTwip,
} = require("docx");
const sizeOf = require("image-size");
const { parseRichText } = require("../../parser");
const { cleanEquation, stripEquationMarkersForDocx } = require("../../latex-to-unicode");
const { detectImageType } = require("../../image-type");
const { AsyncLocalStorage } = require("async_hooks");
const { normalizeFontFace, resolveFontFace } = require("../../document-fonts");

const DEFAULT_FONT = normalizeFontFace();
const fontStorage = new AsyncLocalStorage();
const highlightStorage = new AsyncLocalStorage();
function currentFont() {
  return fontStorage.getStore() || DEFAULT_FONT;
}
function allowHighlights() {
  return highlightStorage.getStore() !== false;
}

const TABLE_WIDTH_TWIP = convertMillimetersToTwip(150);
const CHART_WIDTH_PX = 380;
const CHART_HEIGHT_PX = 240;
const PHOTO_TARGET_WIDTH_PX = 200;
const PHOTO_MAX_HEIGHT_PX = 240;
const PHOTO_FALLBACK_HEIGHT_PX = 150;

// ── helpers ─────────────────────────────────────────────────────────────────

function p(text, opts = {}) {
  // 산문에 남은 {{EQ:...}}/{{EQ-LATEX:...}} 마커는 유니코드 평문으로 변환.
  const runs = parseRichText(stripEquationMarkersForDocx(text), {
    font: currentFont(),
    size: opts.size || 22,
    bold: opts.bold,
    italic: opts.italic,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.spaceAfter ?? 120, line: 312 },
    indent: opts.indent,
    bullet: opts.bullet,
    children: runs,
  });
}

function sectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 280, after: 120 },
    children: [
      new TextRun({ text: String(text ?? ""), font: currentFont(), size: 28, bold: true }),
    ],
  });
}

function emptyP() {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}

function asBlocks(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function tableCellParagraph(text, opts = {}) {
  const runs = parseRichText(stripEquationMarkersForDocx(text), {
    font: currentFont(),
    size: opts.size || 18,
    bold: opts.bold,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({ alignment: AlignmentType.CENTER, children: runs });
}

function buildTable(headers, rows) {
  headers = Array.isArray(headers) ? headers : [];
  rows = (Array.isArray(rows) ? rows : []).map((r) =>
    Array.isArray(r) ? r : r == null ? [] : [r],
  );
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const colWidth = Math.max(720, Math.floor(TABLE_WIDTH_TWIP / colCount));
  const columnWidths = Array.from({ length: colCount }, () => colWidth);
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(
      (h, i) =>
        new TableCell({
          width: { size: columnWidths[i], type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "D5E8F0" },
          margins: { top: 60, bottom: 60, left: 60, right: 60 },
          children: [tableCellParagraph(h, { bold: true })],
        }),
    ),
  });
  const dataRows = rows.map(
    (row) =>
      new TableRow({
        children: Array.from({ length: colCount }, (_, i) => row[i] ?? "").map(
          (cell) =>
            new TableCell({
              width: { size: colWidth, type: WidthType.DXA },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [tableCellParagraph(cell)],
            }),
        ),
      }),
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: TABLE_WIDTH_TWIP, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
  });
}

function getPhotoDimensions(buffer) {
  try {
    const dim = sizeOf(buffer);
    if (dim && dim.width && dim.height) {
      const aspect = dim.height / dim.width;
      let w = PHOTO_TARGET_WIDTH_PX;
      let h = Math.round(w * aspect);
      if (h > PHOTO_MAX_HEIGHT_PX) {
        h = PHOTO_MAX_HEIGHT_PX;
        w = Math.round(h / aspect);
      }
      return { width: w, height: h };
    }
  } catch {
    /* fall through */
  }
  return { width: PHOTO_TARGET_WIDTH_PX, height: PHOTO_FALLBACK_HEIGHT_PX };
}

function buildPhotoBlocks(photoIndices, allPhotos, figCounter, captionPrefix, photoCaptions) {
  const blocks = [];
  const indices = Array.isArray(photoIndices) ? photoIndices : [];
  const caps = Array.isArray(photoCaptions) ? photoCaptions : [];
  const selected = indices
    .map((idx, pos) => ({
      photo: allPhotos[idx],
      cap: typeof caps[pos] === "string" ? caps[pos].trim() : "",
    }))
    .filter((x) => x.photo && Buffer.isBuffer(x.photo.buffer) && x.photo.buffer.length > 0);
  const multiple = selected.length > 1;
  let gpos = -1;
  for (let start = 0; start < selected.length; start += 3) {
    const group = selected.slice(start, start + 3);
    const cols = group.length;
    const cellWidth = Math.floor(TABLE_WIDTH_TWIP / cols);
    const targetWidth = cols >= 3 ? 132 : cols === 2 ? 168 : PHOTO_TARGET_WIDTH_PX;
    const imageCells = [];
    const captionCells = [];
    for (const item of group) {
      gpos += 1;
      const photo = item.photo;
      const originalDim = getPhotoDimensions(photo.buffer);
      const scale = Math.min(targetWidth / originalDim.width, PHOTO_MAX_HEIGHT_PX / originalDim.height, 1);
      const dim = {
        width: Math.max(1, Math.round(originalDim.width * scale)),
        height: Math.max(1, Math.round(originalDim.height * scale)),
      };
      figCounter.value += 1;
      imageCells.push(
        new TableCell({
          width: { size: cellWidth, type: WidthType.DXA },
          margins: { top: 60, bottom: 30, left: 60, right: 60 },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [
                new ImageRun({
                  data: photo.buffer,
                  type: detectImageType(photo.buffer),
                  transformation: dim,
                }),
              ],
            }),
          ],
        }),
      );
      captionCells.push(
        new TableCell({
          width: { size: cellWidth, type: WidthType.DXA },
          margins: { top: 20, bottom: 50, left: 40, right: 40 },
          children: [
            p(
              (() => {
                const desc = item.cap || (multiple ? (gpos === 0 ? captionPrefix || "" : "") : captionPrefix || "");
                return `[그림 ${figCounter.value}]${desc ? " " + desc : ""}`;
              })(),
              { align: AlignmentType.CENTER, size: 16, spaceAfter: 0 },
            ),
          ],
        }),
      );
    }
    blocks.push(
      new Table({
        rows: [
          new TableRow({ children: imageCells }),
          new TableRow({ children: captionCells }),
        ],
        width: { size: TABLE_WIDTH_TWIP, type: WidthType.DXA },
        columnWidths: Array.from({ length: cols }, () => cellWidth),
        layout: TableLayoutType.FIXED,
      }),
    );
    blocks.push(emptyP());
  }
  return blocks;
}

function buildChartBlock(chart, figCounter) {
  const blocks = [];
  if (!chart || !chart.pngBuffer) {
    if (chart && chart.title) {
      blocks.push(p(`[그래프] ${chart.title} - 렌더 실패`, { italic: true }));
    }
    return blocks;
  }
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 80, after: 40 },
      children: [
        new ImageRun({
          data: chart.pngBuffer,
          type: "png",
          transformation: { width: CHART_WIDTH_PX, height: CHART_HEIGHT_PX },
        }),
      ],
    }),
  );
  figCounter.value += 1;
  const cap = `[그림 ${figCounter.value}] ${chart.title || ""}${chart.caption ? " - " + chart.caption : ""}`;
  blocks.push(p(cap, { align: AlignmentType.CENTER, size: 18, italic: true, spaceAfter: 100 }));
  return blocks;
}

// ── 블록 렌더 ────────────────────────────────────────────────────────────────

function renderBlocks(blocks, ctx, { indent = 240 } = {}) {
  const out = [];
  for (const blk of asBlocks(blocks)) {
    if (typeof blk === "string") {
      if (blk.trim()) out.push(p(blk, { indent: { left: indent } }));
      continue;
    }
    if (!blk || typeof blk !== "object") continue;
    if (blk.subheading) {
      out.push(p(blk.subheading, { bold: true, size: 23, indent: { left: indent } }));
    } else if (blk.equation) {
      const eq = cleanEquation(blk.equation);
      if (eq) out.push(p(eq, { align: AlignmentType.CENTER }));
    } else if (blk.table && typeof blk.table === "object" && Array.isArray(blk.table.headers) && blk.table.headers.length) {
      out.push(buildTable(blk.table.headers, blk.table.rows));
      if (blk.table.caption) {
        out.push(p(blk.table.caption, { align: AlignmentType.CENTER, size: 18, italic: true }));
      }
      out.push(emptyP());
    } else if (blk.chart && typeof blk.chart === "object") {
      out.push(...buildChartBlock(blk.chart, ctx.figCounter));
    } else if (blk.image && typeof blk.image === "object") {
      out.push(
        ...buildPhotoBlocks(
          blk.image.photo_indices,
          ctx.allPhotos,
          ctx.figCounter,
          blk.image.caption || "",
          blk.image.photo_captions,
        ),
      );
    } else if (Array.isArray(blk.list)) {
      for (const item of blk.list) {
        if (item == null || String(item).trim() === "") continue;
        out.push(p(String(item), { indent: { left: indent }, bullet: { level: 0 } }));
      }
    }
  }
  return out;
}

// ── 문서 빌드 ─────────────────────────────────────────────────────────────────

function buildTitle(content) {
  const blocks = [];
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: content.title || "보고서",
          font: currentFont(),
          size: 34,
          bold: true,
        }),
      ],
    }),
  );
  if (content.subtitle) {
    blocks.push(p(String(content.subtitle), { align: AlignmentType.CENTER, size: 22, spaceAfter: 80 }));
  }
  const who = `${content.student_id || ""} ${content.student_name || ""}`.trim();
  if (who) {
    blocks.push(p(who, { align: AlignmentType.CENTER, size: 22, spaceAfter: 120 }));
  }
  if (content.date) {
    blocks.push(p(String(content.date), { align: AlignmentType.CENTER, size: 20, spaceAfter: 240 }));
  }
  return blocks;
}

function buildSections(content, ctx) {
  const out = [];
  const sections = Array.isArray(content.sections) ? content.sections : [];
  for (const sec of sections) {
    if (!sec || typeof sec !== "object") continue;
    if (sec.heading) out.push(sectionHeading(String(sec.heading)));
    out.push(...renderBlocks(sec.blocks, ctx));
  }
  return out;
}

function buildReferences(content) {
  const refs = Array.isArray(content.references) ? content.references : [];
  if (!refs.length) return [];
  const out = [sectionHeading("참고문헌")];
  refs.forEach((ref, i) => {
    let label = "";
    let url = "";
    if (ref && typeof ref === "object") {
      label = String(ref.label || "").trim();
      url = String(ref.url || "").trim();
    } else {
      label = String(ref || "").trim();
    }
    if (!label && !url) return;
    let text = `[${i + 1}] ${label}`.trim();
    if (url) text = `${text} ${url}`.trim();
    out.push(p(text, { indent: { left: 240 }, size: 20 }));
  });
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

async function generateDocx(content) {
  return fontStorage.run(resolveFontFace(content), () =>
    highlightStorage.run(content.__allowHighlights !== false, () =>
      generateDocxWithFont(content),
    ),
  );
}

async function generateDocxWithFont(content) {
  const ctx = {
    allPhotos: Array.isArray(content.__photos) ? content.__photos : [],
    figCounter: { value: 0 },
  };
  const children = [
    ...buildTitle(content),
    ...buildSections(content, ctx),
    ...buildReferences(content),
  ];

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "- ", font: currentFont(), size: 16 }),
          new TextRun({ children: [PageNumber.CURRENT], font: currentFont(), size: 16 }),
          new TextRun({ text: " -", font: currentFont(), size: 16 }),
        ],
      }),
    ],
  });

  const doc = new Document({
    styles: { default: { document: { run: { font: currentFont(), size: 22 } } } },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(20),
              bottom: convertMillimetersToTwip(20),
              left: convertMillimetersToTwip(20),
              right: convertMillimetersToTwip(20),
            },
          },
        },
        footers: { default: footer },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateDocx };
