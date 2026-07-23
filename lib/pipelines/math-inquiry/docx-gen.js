// 수학Ⅲ 급수 탐구보고서 (수학 수행평가) - docx 생성
//
// JSON 스키마(prompt.md):
//   { title, inquiry_topic, inquiry_purpose, prior_research:{theory,analysis},
//     process, results_reflection, references }
// 본문은 블록 배열(문자열 | {subheading} | {equation} | {table} | {chart}).

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  ImageRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  TableLayoutType,
  WidthType,
  ShadingType,
  Footer,
  PageNumber,
  convertMillimetersToTwip,
} = require("docx");
const { parseRichText } = require("../../parser");
const { cleanEquation, stripEquationMarkersForDocx } = require("../../latex-to-unicode");
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
const CHART_WIDTH_PX = 228;
const CHART_HEIGHT_PX = 144;

const SECTIONS = [
  ["Ⅰ", "탐구 주제", "inquiry_topic"],
  ["Ⅱ", "탐구 목적", "inquiry_purpose"],
  ["Ⅲ", "선행연구 분석", null], // 하위 1./2. 별도 처리
  ["Ⅳ", "탐구 과정 및 탐구 내용", "process"],
  ["Ⅴ", "탐구 결과 정리 및 반성", "results_reflection"],
];

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

function subHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 160, after: 80 },
    children: [
      new TextRun({ text: String(text ?? ""), font: currentFont(), size: 24, bold: true }),
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

function asObj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
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

function buildChartBlock(chart, figCounter) {
  const blocks = [];
  if (!chart || !chart.pngBuffer) {
    if (chart) {
      blocks.push(p(`[그래프] ${chart.title || ""} - 렌더 실패`, { italic: true }));
    }
    return blocks;
  }
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 30 },
      children: [
        new ImageRun({
          data: chart.pngBuffer,
          type: "png", // chartjs-node-canvas는 항상 PNG
          transformation: {
            width: CHART_WIDTH_PX,
            height: CHART_HEIGHT_PX,
          },
        }),
      ],
    }),
  );
  figCounter.value += 1;
  const cap = `[그림 ${figCounter.value}] ${chart.title || ""}${chart.caption ? " - " + chart.caption : ""}`;
  blocks.push(
    p(cap, { align: AlignmentType.CENTER, size: 18, italic: true, spaceAfter: 80 }),
  );
  return blocks;
}

function renderBlocks(blocks, counters, { indent = 280 } = {}) {
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
    } else if (blk.table && Array.isArray(blk.table.headers) && blk.table.headers.length) {
      counters.table.value += 1;
      out.push(buildTable(blk.table.headers, blk.table.rows));
      const cap = blk.table.caption || "자료";
      out.push(
        p(`[표 ${counters.table.value}] ${cap}`, {
          align: AlignmentType.CENTER,
          size: 18,
          italic: true,
        }),
      );
      out.push(emptyP());
    } else if (blk.chart && typeof blk.chart === "object") {
      out.push(...buildChartBlock(blk.chart, counters.fig));
    }
  }
  return out;
}

// ── 섹션 빌더 ────────────────────────────────────────────────────────────────

function buildTitle(content) {
  const blocks = [];
  const title = String(content.title || "급수 탐구보고서").trim();
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: `<${title}>`,
          font: currentFont(),
          size: 34,
          bold: true,
        }),
      ],
    }),
  );
  const sid = String(content.student_id || "").trim();
  const sname = String(content.student_name || "").trim();
  const who = `${sid} ${sname}`.trim();
  if (who) {
    blocks.push(p(`작성자 ${who}`, { align: AlignmentType.RIGHT, size: 22, spaceAfter: 240 }));
  }
  return blocks;
}

function buildSections(content, counters) {
  const out = [];
  const pr = asObj(content.prior_research);
  for (const [roman, title, key] of SECTIONS) {
    out.push(sectionHeading(`${roman}. ${title}`));
    if (key) {
      out.push(...renderBlocks(content[key], counters));
    } else {
      out.push(subHeading("1. 이론적 배경"));
      out.push(...renderBlocks(pr.theory, counters));
      out.push(subHeading("2. 선행연구 분석"));
      out.push(...renderBlocks(pr.analysis, counters));
    }
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
    out.push(p(text, { indent: { left: 280 }, size: 20 }));
  });
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

async function generateDocx(content) {
  return fontStorage.run(
    resolveFontFace(content),
    () =>
      highlightStorage.run(content.__allowHighlights !== false, () =>
        generateDocxWithFont(content),
      ),
  );
}

async function generateDocxWithFont(content) {
  const counters = { fig: { value: 0 }, table: { value: 0 } };
  const children = [
    ...buildTitle(content),
    ...buildSections(content, counters),
    ...buildReferences(content),
  ];

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "급수 탐구보고서  - ", font: currentFont(), size: 16 }),
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
