// 일반물리학실험 결과보고서 docx 생성 (5p 강제, 1.1/1.2 구조)
//
// JSON 스키마는 chem-result와 다름:
//   { title, experiment_setup, experiments[], conclusion }
// 차트·사진은 chem-result와 동일 (chartjs-node-canvas + photo_indices)

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
const sizeOf = require("image-size");
const { parseRichText } = require("../../parser");
const { detectImageType } = require("../../image-type");

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

// 5p 안에 들어가도록 표·차트·사진을 기존 대비 약 0.6배로 축소.
const CHART_WIDTH_PX = 228;
const CHART_HEIGHT_PX = 144;
const PHOTO_TARGET_WIDTH_PX = 144;
const PHOTO_MAX_HEIGHT_PX = 168;
const PHOTO_FALLBACK_HEIGHT_PX = 108;

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

// ── Style helpers ─────────────────────────────────────────────────────────────

function p(text, opts = {}) {
  const runs = parseRichText(String(text ?? ""), {
    font: currentFont(),
    size: opts.size || 20, // 5p 강제 위해 약간 작게
    bold: opts.bold,
    italic: opts.italic,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.spaceAfter ?? 60, line: 280 }, // 행간도 약간 좁게
    indent: opts.indent,
    children: runs,
  });
}

function heading(text, opts = {}) {
  return new Paragraph({
    heading: opts.level || HeadingLevel.HEADING_1,
    spacing: { before: opts.before ?? 160, after: opts.after ?? 80 },
    children: [
      new TextRun({
        text: String(text ?? ""),
        font: currentFont(),
        size: opts.size || 24,
        bold: true,
      }),
    ],
  });
}

function emptyP() {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}

const TABLE_WIDTH_TWIP = convertMillimetersToTwip(102);

// 표 셀
function tableCellParagraph(text, opts = {}) {
  const runs = parseRichText(String(text ?? ""), {
    font: currentFont(),
    size: opts.size || 16, // 작게 (5p 강제)
    bold: opts.bold,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: runs,
  });
}

function hasUsableTable(table) {
  return (
    table &&
    Array.isArray(table.headers) &&
    table.headers.length > 0 &&
    Array.isArray(table.rows)
  );
}

function buildTable(headers, rows) {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const colWidth = Math.max(720, Math.floor(TABLE_WIDTH_TWIP / colCount));
  const columnWidths = Array.from({ length: colCount }, () => colWidth);
  const headerCells = headers.map(
    (h, i) =>
      new TableCell({
        width: { size: columnWidths[i], type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: "D5E8F0" },
        margins: { top: 60, bottom: 60, left: 60, right: 60 },
        children: [tableCellParagraph(h, { bold: true, size: 15 })],
      }),
  );
  const headerRow = new TableRow({ children: headerCells, tableHeader: true });
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

function buildPhotoBlocks(photoIndices, allPhotos, figCounter, captionPrefix) {
  const blocks = [];
  const indices = Array.isArray(photoIndices) ? photoIndices : [];
  const selected = indices
    .map((idx) => allPhotos[idx])
    .filter((photo) => photo && Buffer.isBuffer(photo.buffer) && photo.buffer.length > 0);
  for (let start = 0; start < selected.length; start += 3) {
    const group = selected.slice(start, start + 3);
    const cols = group.length;
    const cellWidth = Math.floor(TABLE_WIDTH_TWIP / cols);
    const targetWidth = cols >= 3 ? 96 : cols === 2 ? 132 : PHOTO_TARGET_WIDTH_PX;
    const imageCells = [];
    const captionCells = [];
    for (const photo of group) {
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
            p(`[그림 ${figCounter.value}] ${captionPrefix || ""}`, {
              align: AlignmentType.CENTER,
              size: 16,
              spaceAfter: 0,
            }),
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
    if (chart) {
      blocks.push(
        p(`[그래프] ${chart.title || ""} — 렌더 실패`, { italic: true }),
      );
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
  const cap = `[그림 ${figCounter.value}] ${chart.title || ""}${chart.caption ? " — " + chart.caption : ""}`;
  // 마커(*var*, _{}, ^{} 등)가 raw로 남지 않게 p()를 사용 (parseRichText 처리)
  blocks.push(
    p(cap, {
      align: AlignmentType.CENTER,
      size: 18,
      italic: true,
      spaceAfter: 80,
    }),
  );
  return blocks;
}

// ── 섹션 빌더 ──────────────────────────────────────────────────────────────

function buildHeader(content) {
  const blocks = [];
  // 본문에는 "실험 주제 : {title}" 형태로만 표시 (학번·이름은 파일명에만)
  // PDF 양식: "실험 주제 : Energy Conservation"
  // 제목도 마커 처리 거치도록 p() 사용 (Claude가 *변수*·_{} 등 마커 사용 가능성)
  if (content.title) {
    blocks.push(
      p(`실험 주제 : ${content.title}`, {
        align: AlignmentType.LEFT,
        bold: true,
        size: 24,
        spaceAfter: 240,
      }),
    );
  }
  return blocks;
}

function buildResults(content, allPhotos, figCounter, tableCounter) {
  const blocks = [heading("1. 실험 결과")];

  // 1.1 실험 장치 및 세팅
  blocks.push(p("1.1 실험 장치 및 세팅", { bold: true, size: 22 }));
  const setup = content.experiment_setup || {};
  if (setup.description) {
    blocks.push(p(setup.description, { indent: { left: 240 } }));
  }
  blocks.push(...buildPhotoBlocks(setup.photo_indices, allPhotos, figCounter, "실험 장치"));
  blocks.push(emptyP());

  // 1.2, 1.3, ... 각 실험 파트
  const experiments = Array.isArray(content.experiments) ? content.experiments : [];
  experiments.forEach((exp, i) => {
    const subnum = `1.${i + 2}`;
    blocks.push(p(`${subnum} ${exp.name || `실험 ${i + 1}`}`, { bold: true, size: 22 }));

    if (exp.method_summary) {
      blocks.push(p(exp.method_summary, { indent: { left: 240 } }));
    }

    // 표
    if (hasUsableTable(exp.data_table)) {
      tableCounter.value += 1;
      blocks.push(buildTable(exp.data_table.headers, exp.data_table.rows));
      blocks.push(
        p(`[표 ${tableCounter.value}] 측정 데이터`, {
          align: AlignmentType.CENTER,
          size: 18,
          spaceAfter: 80,
        }),
      );
    }

    // 차트
    if (exp.chart) {
      blocks.push(...buildChartBlock(exp.chart, figCounter));
    }

    // 분석
    if (exp.analysis) {
      blocks.push(p(exp.analysis, { indent: { left: 240 } }));
    }

    // 사진
    blocks.push(...buildPhotoBlocks(exp.photo_indices, allPhotos, figCounter, exp.name || ""));
    blocks.push(emptyP());
  });

  return blocks;
}

function buildConclusion(content) {
  const blocks = [heading("2. 결론")];
  const c = content.conclusion || {};

  // 첫 단락: 실험 목적 (마커 없이 일반 단락)
  if (c.objective_recap) {
    blocks.push(p(c.objective_recap));
    blocks.push(emptyP());
  }

  // ▶ 마커 섹션들 (PDF 양식 따라)
  const sections = [
    { marker: "▶ 결과 요약", text: c.result_summary },
    { marker: "▶ 오차 분석", text: c.error_analysis },
    { marker: "▶ 문제 인식 및 해결", text: c.problem_solving },
    { marker: "▶ 물리적 고찰", text: c.physical_meaning || c.theory_connection },
  ];

  for (const sec of sections) {
    if (!sec.text) continue;
    blocks.push(p(sec.marker, { bold: true, size: 22, spaceAfter: 60 }));
    // text가 배열이면 각 항목 별도 단락으로
    if (Array.isArray(sec.text)) {
      for (const t of sec.text) {
        blocks.push(p(String(t), { spaceAfter: 80 }));
      }
    } else {
      blocks.push(p(String(sec.text), { spaceAfter: 80 }));
    }
    blocks.push(emptyP());
  }

  return blocks;
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function generateDocx(content) {
  return fontStorage.run(
    normalizeFontFace(content.__fontFace || content.font_face),
    () =>
      highlightStorage.run(
        content.__allowHighlights !== false,
        () => generateDocxWithFont(content),
      ),
  );
}

async function generateDocxWithFont(content) {
  const allPhotos = Array.isArray(content.__photos) ? content.__photos : [];
  const figCounter = { value: 0 };
  const tableCounter = { value: 0 };

  const children = [
    ...buildHeader(content),
    ...buildResults(content, allPhotos, figCounter, tableCounter),
    ...buildConclusion(content),
  ];

  // 푸터: "고 2,3 일반물리학실험  - N -"
  // PageNumber.CURRENT는 단독 TextRun에 넣어야 함 (혼합 children은 일부 Word 버전에서 손상 인식)
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "고 2,3 일반물리학실험  - ", font: currentFont(), size: 16 }),
          new TextRun({ children: [PageNumber.CURRENT], font: currentFont(), size: 16 }),
          new TextRun({ text: " -", font: currentFont(), size: 16 }),
        ],
      }),
    ],
  });

  const doc = new Document({
    styles: {
      default: { document: { run: { font: currentFont(), size: 20 } } },
    },
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
