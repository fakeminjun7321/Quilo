// 일반물리학 탐구 및 사고 과정 성찰 보고서 (물리 수행평가) — docx 생성
//
// JSON 스키마(prompt.md):
//   { title, topic_title, problem_setup, thinking_process, interpretation, references }
// 본문은 블록 배열(문자열 | {subheading} | {equation} | {table}).

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
  Footer,
  PageNumber,
  convertMillimetersToTwip,
} = require("docx");
const { parseRichText } = require("../../parser");
const { AsyncLocalStorage } = require("async_hooks");
const { normalizeFontFace } = require("../../document-fonts");

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
const ROMAN = ["I", "II", "III", "IV", "V", "VI"];

// ── helpers ─────────────────────────────────────────────────────────────────

function p(text, opts = {}) {
  const runs = parseRichText(String(text ?? ""), {
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

function cleanEquation(text) {
  // docx에는 한컴 수식 마커가 없으므로 {{EQ:...}} 래퍼만 벗겨 본문 표기로.
  return String(text ?? "")
    .replace(/^\s*\{\{EQN?:\s*/, "")
    .replace(/\}\}\s*$/, "")
    .trim();
}

function tableCellParagraph(text, opts = {}) {
  const runs = parseRichText(String(text ?? ""), {
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

function renderBlocks(blocks, { indent = 280 } = {}) {
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
      out.push(buildTable(blk.table.headers, blk.table.rows));
      if (blk.table.caption) {
        out.push(
          p(blk.table.caption, { align: AlignmentType.CENTER, size: 18, italic: true }),
        );
      }
      out.push(emptyP());
    }
  }
  return out;
}

// ── section builders ────────────────────────────────────────────────────────

function buildTitle(content) {
  const blocks = [];
  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({
          text: content.title || "일반물리학 탐구 및 사고 과정 성찰 보고서",
          font: currentFont(),
          size: 34,
          bold: true,
        }),
      ],
    }),
  );
  if (content.topic_title) {
    blocks.push(
      p(`— ${content.topic_title} —`, { align: AlignmentType.CENTER, size: 22, spaceAfter: 80 }),
    );
  }
  const who = `${content.student_id || ""} ${content.student_name || ""}`.trim();
  if (who) {
    blocks.push(p(who, { align: AlignmentType.CENTER, size: 22, spaceAfter: 240 }));
  }
  return blocks;
}

function buildProblemSetup(content) {
  const ps = asObj(content.problem_setup);
  return [
    sectionHeading(`${ROMAN[0]}. 문제 상황 설정`),
    subHeading("1. 선택한 물리적 주제 / 상황"),
    ...renderBlocks(ps.topic_situation),
    subHeading("2. 탐구 배경 및 필요성"),
    ...renderBlocks(ps.background),
  ];
}

function buildThinkingProcess(content) {
  const tp = asObj(content.thinking_process);
  const out = [
    sectionHeading(`${ROMAN[1]}. 사고 과정 및 문제 해결`),
    subHeading("1. 초기 접근"),
    ...renderBlocks(tp.initial_approach),
    subHeading("2. 오류 인식"),
    ...renderBlocks(tp.error_recognition),
    subHeading("3. 새로운 관점의 접근 및 최종 해결"),
    ...renderBlocks(tp.resolution),
  ];
  const da = tp.detailed_analysis;
  if (da && typeof da === "object" && !Array.isArray(da) && da.body) {
    out.push(p(`3.1 ${da.title || "세부 분석 내용"}`, { bold: true, size: 22, indent: { left: 280 } }));
    out.push(...renderBlocks(da.body, { indent: 480 }));
  } else if (Array.isArray(da) && da.length) {
    out.push(p("3.1 세부 분석 내용", { bold: true, size: 22, indent: { left: 280 } }));
    out.push(...renderBlocks(da, { indent: 480 }));
  }
  return out;
}

function buildInterpretation(content) {
  const it = asObj(content.interpretation);
  return [
    sectionHeading(`${ROMAN[2]}. 물리적 해석 및 성찰`),
    subHeading("1. 결과의 물리적 의미 해석"),
    ...renderBlocks(it.physical_meaning),
    subHeading("2. 초기 오개념에 대한 성찰 및 일반화된 해석"),
    ...renderBlocks(it.reflection),
  ];
}

function buildReferences(content) {
  const refs = Array.isArray(content.references) ? content.references : [];
  if (!refs.length) return [];
  const out = [sectionHeading(`${ROMAN[3]}. 참고문헌`)];
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
    normalizeFontFace(content.__fontFace || content.font_face),
    () =>
      highlightStorage.run(content.__allowHighlights !== false, () =>
        generateDocxWithFont(content),
      ),
  );
}

async function generateDocxWithFont(content) {
  const children = [
    ...buildTitle(content),
    ...buildProblemSetup(content),
    ...buildThinkingProcess(content),
    ...buildInterpretation(content),
    ...buildReferences(content),
  ];

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "일반물리학 탐구 및 사고 과정 성찰 보고서  - ", font: currentFont(), size: 16 }),
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
