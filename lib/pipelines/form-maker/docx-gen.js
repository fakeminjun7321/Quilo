// form-maker — DOCX 생성 (양식 생성 / 문서 복원)
//
// JSON 스키마(prompt.md): { doc_type, title, title_size?, meta?, page?, blocks:[...] }
// blocks 원소: {type: heading|paragraph|table|figure|summary_box|spacer|pagebreak}

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
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
  PageBreak,
  BorderStyle,
  convertMillimetersToTwip,
  Math: OfficeMath,
  MathRun,
  MathFraction,
  MathRadical,
  MathSuperScript,
  MathSubScript,
  MathSubSuperScript,
  MathRoundBrackets,
  MathSquareBrackets,
} = require("docx");
const sizeOf = require("image-size");
const { parseRichText } = require("../../parser");
const { stripEquationMarkersForDocx } = require("../../latex-to-unicode");
const { detectImageType } = require("../../image-type");
const { astToDocxMath, parseEquation } = require("../../document-tools/equation-layout");

// docx 경로 수식 마커 방어: 모델이 hwpx용 {{EQ:...}}를 남겨도(모드 교차·지시 위반)
// raw 마커가 사용자 문서에 노출되지 않게 텍스트 삽입 직전에 1회 변환한다.
// (다른 docx-gen 6종과 동일한 배선 — chem-result/docx-gen.js 참고)
function docxText(text) {
  return stripEquationMarkersForDocx(String(text ?? ""));
}
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

const TABLE_WIDTH_TWIP = convertMillimetersToTwip(165);
const PHOTO_TARGET_WIDTH_PX = 200;
const PHOTO_MAX_HEIGHT_PX = 240;
const PHOTO_FALLBACK_HEIGHT_PX = 150;

// heading level → docx 글자크기(half-point) / 굵게 / 들여쓰기(twip)
const HEADING_STYLE = {
  1: { size: 30, bold: true, indent: 0, before: 280, after: 120 },
  2: { size: 26, bold: true, indent: 0, before: 200, after: 100 },
  3: { size: 22, bold: true, indent: 240, before: 140, after: 80 },
  4: { size: 22, bold: false, indent: 480, before: 100, after: 80 },
};

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};
const NUM_RE = /^\s*[-+]?[\d,]+(\.\d+)?\s*%?\s*$/;

function toAlign(value, fallback) {
  const a = String(value || "").trim().toLowerCase();
  return ALIGN[a] || fallback;
}

function p(text, opts = {}) {
  const runs = parseRichText(docxText(text), {
    font: currentFont(),
    size: opts.size || 22,
    bold: opts.bold,
    italic: opts.italic,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({
    alignment: opts.align,
    spacing: {
      before: opts.spaceBefore ?? 0,
      after: opts.spaceAfter ?? 120,
      line: opts.line ?? 312,
    },
    indent: opts.indent,
    children: runs,
  });
}

function emptyP() {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function clampInt(value, lo, hi, dflt) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

function cellParagraph(text, opts = {}) {
  const runs = parseRichText(docxText(text), {
    font: currentFont(),
    size: opts.size || 19,
    bold: opts.bold,
    allowHighlights: allowHighlights(),
  });
  return new Paragraph({ alignment: opts.align || AlignmentType.CENTER, children: runs });
}

// ── heading ─────────────────────────────────────────────────────────────────
function renderHeading(blk) {
  const text = String(blk.text || "").trim();
  if (!text) return [];
  const st = HEADING_STYLE[clampInt(blk.level, 1, 4, 1)];
  const requestedSize = Number(blk.font_size_pt);
  const size = Number.isFinite(requestedSize) ? clampInt(Math.round(requestedSize * 2), 16, 64, st.size) : st.size;
  return [
    new Paragraph({
      spacing: {
        before: Number.isFinite(Number(blk.space_before_pt)) ? Math.round(Number(blk.space_before_pt) * 20) : st.before,
        after: Number.isFinite(Number(blk.space_after_pt)) ? Math.round(Number(blk.space_after_pt) * 20) : st.after,
        line: 312,
      },
      indent: st.indent ? { left: st.indent } : undefined,
      keepNext: true,
      children: parseRichText(docxText(text), {
        font: currentFont(),
        size,
        bold: blk.bold !== false && st.bold,
        allowHighlights: allowHighlights(),
      }),
    }),
  ];
}

function renderEquation(blk) {
  const source = String(blk.text || blk.latex || "").trim();
  if (!source) return [];
  const children = astToDocxMath(parseEquation(source), {
    MathRun,
    MathFraction,
    MathRadical,
    MathSuperScript,
    MathSubScript,
    MathSubSuperScript,
    MathRoundBrackets,
    MathSquareBrackets,
  });
  return [new Paragraph({
    alignment: toAlign(blk.align, AlignmentType.CENTER),
    spacing: {
      before: Number.isFinite(Number(blk.space_before_pt)) ? Math.round(Number(blk.space_before_pt) * 20) : 80,
      after: Number.isFinite(Number(blk.space_after_pt)) ? Math.round(Number(blk.space_after_pt) * 20) : 80,
      line: 312,
    },
    children: [new OfficeMath({ children: children.length ? children : [new MathRun(docxText(source))] })],
  })];
}

// ── table ───────────────────────────────────────────────────────────────────
function renderTable(blk, tableWidth = TABLE_WIDTH_TWIP) {
  const out = [];
  const headers = Array.isArray(blk.headers) ? blk.headers : [];
  const rows = (Array.isArray(blk.rows) ? blk.rows : []).map((r) =>
    Array.isArray(r) ? r : r == null ? [] : [r],
  );
  const headerFill = (String(blk.header_fill || "#D9E2F3").replace("#", "")) || "D9E2F3";
  const colAligns = Array.isArray(blk.col_aligns) ? blk.col_aligns : [];
  const hasHeader = headers.length > 0;
  const rowWidth = (row) => row.reduce((sum, cell) => sum + (cell && typeof cell === "object" && !Array.isArray(cell)
    ? clampInt(cell.colspan, 1, 100, 1)
    : 1), 0);
  const colCount = Math.max(headers.length, ...rows.map(rowWidth), 1);
  const colWidth = Math.max(500, Math.floor(tableWidth / colCount));
  const columnWidths = Array.from({ length: colCount }, () => colWidth);

  if (blk.caption) {
    out.push(p(blk.caption, { size: 18, spaceAfter: 60 }));
  }

  const tableRows = [];
  if (hasHeader) {
    tableRows.push(
      new TableRow({
        tableHeader: true,
        children: Array.from({ length: colCount }, (_, i) => headers[i] ?? "").map(
          (h, i) =>
            new TableCell({
              width: { size: columnWidths[i], type: WidthType.DXA },
              shading: { type: ShadingType.CLEAR, fill: headerFill },
              margins: { top: 60, bottom: 60, left: 60, right: 60 },
              children: [cellParagraph(h, { bold: true })],
            }),
        ),
      }),
    );
  }

  const coveredByRow = new Map();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const covered = coveredByRow.get(rowIndex) || new Set();
    const cells = [];
    let ci = 0;
    for (const raw of row) {
      while (ci < colCount && covered.has(ci)) ci += 1;
      if (ci >= colCount) break;
      let text = raw;
      let align = null;
      let bold = false;
      let fill = null;
      let colspan = 1;
      let rowspan = 1;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        text = raw.text ?? "";
        align = raw.align;
        bold = !!raw.bold;
        fill = raw.fill ? String(raw.fill).replace("#", "") : null;
        colspan = clampInt(raw.colspan, 1, colCount - ci, 1);
        rowspan = clampInt(raw.rowspan, 1, 100, 1);
      }
      let a = align;
      if (!a) {
        if (colAligns[ci]) a = colAligns[ci];
        else if (NUM_RE.test(String(text))) a = "right";
        else a = "left";
      }
      cells.push(
        new TableCell({
          width: { size: colWidth * colspan, type: WidthType.DXA },
          columnSpan: colspan > 1 ? colspan : undefined,
          rowSpan: rowspan > 1 ? rowspan : undefined,
          shading: fill ? { type: ShadingType.CLEAR, fill } : undefined,
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          children: [cellParagraph(text, { bold, align: toAlign(a, AlignmentType.LEFT) })],
        }),
      );
      if (rowspan > 1) {
        for (let dr = 1; dr < rowspan; dr += 1) {
          const future = coveredByRow.get(rowIndex + dr) || new Set();
          for (let dc = 0; dc < colspan; dc += 1) future.add(ci + dc);
          coveredByRow.set(rowIndex + dr, future);
        }
      }
      ci += colspan;
    }
    // 빈 칸 채우기 (행 셀 수가 모자랄 때)
    while (ci < colCount) {
      if (covered.has(ci)) {
        ci += 1;
        continue;
      }
      cells.push(
        new TableCell({
          width: { size: colWidth, type: WidthType.DXA },
          margins: { top: 60, bottom: 60, left: 80, right: 80 },
          children: [cellParagraph("")],
        }),
      );
      ci += 1;
    }
    tableRows.push(new TableRow({ children: cells }));
  }

  if (tableRows.length) {
    out.push(
      new Table({
        rows: tableRows,
        width: { size: tableWidth, type: WidthType.DXA },
        columnWidths,
        layout: TableLayoutType.FIXED,
      }),
    );
    out.push(emptyP());
  }
  return out;
}

// ── figure ──────────────────────────────────────────────────────────────────
function photoDimensions(buffer, targetWidth, maxHeight = PHOTO_MAX_HEIGHT_PX) {
  try {
    const dim = sizeOf(buffer);
    if (dim && dim.width && dim.height) {
      const aspect = dim.height / dim.width;
      let w = targetWidth;
      let h = Math.round(w * aspect);
      if (h > maxHeight) {
        h = maxHeight;
        w = Math.round(h / aspect);
      }
      return { width: w, height: h };
    }
  } catch {
    /* fall through */
  }
  return { width: targetWidth, height: PHOTO_FALLBACK_HEIGHT_PX };
}

function renderFigure(blk, ctx, width = TABLE_WIDTH_TWIP) {
  const out = [];
  const indices = Array.isArray(blk.photo_indices) ? blk.photo_indices : [];
  const caption = String(blk.caption || "").trim();
  const selected = indices
    .map((idx) => ctx.allPhotos[idx])
    .filter((ph) => ph && Buffer.isBuffer(ph.buffer) && ph.buffer.length > 0);

  if (selected.length) {
    for (const photo of selected) {
      const fullPage = blk.full_page === true;
      const widthRatio = Number.isFinite(Number(blk.width_ratio)) ? Math.max(0.12, Math.min(1, Number(blk.width_ratio))) : 1;
      const availableWidthPx = Math.max(90, Math.round(width / 15));
      const dim = photoDimensions(
        photo.buffer,
        fullPage ? 600 : Math.max(90, Math.round(availableWidthPx * widthRatio)),
        fullPage ? 780 : PHOTO_MAX_HEIGHT_PX,
      );
      out.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 80, after: 40 },
          children: [
            new ImageRun({ data: photo.buffer, type: detectImageType(photo.buffer), transformation: dim }),
          ],
        }),
      );
    }
    if (caption) {
      ctx.figCounter.value += 1;
      const cap = caption.startsWith("그림") ? caption : `[그림 ${ctx.figCounter.value}] ${caption}`;
      out.push(p(cap, { align: AlignmentType.CENTER, size: 18, italic: true, spaceAfter: 120 }));
    }
    return out;
  }

  // placeholder — 점선 테두리 빈 상자
  const note = String(blk.note || "").trim();
  const dashed = { style: BorderStyle.DASHED, size: 6, color: "888888" };
  out.push(
    new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: width, type: WidthType.DXA },
              margins: { top: 200, bottom: 200, left: 120, right: 120 },
              borders: { top: dashed, bottom: dashed, left: dashed, right: dashed },
              children: [
                p(note || "［ 그림 · 사진 넣는 자리 ］", {
                  align: AlignmentType.CENTER,
                  size: 20,
                  italic: !!note,
                  spaceAfter: 0,
                }),
                emptyP(),
              ],
            }),
          ],
        }),
      ],
      width: { size: width, type: WidthType.DXA },
      columnWidths: [width],
      layout: TableLayoutType.FIXED,
    }),
  );
  if (caption) {
    out.push(p(caption.startsWith("그림") ? caption : `[그림] ${caption}`, {
      align: AlignmentType.CENTER,
      size: 18,
      italic: true,
      spaceAfter: 120,
    }));
  }
  return out;
}

// ── summary_box ───────────────────────────────────────────────────────────────
function renderSummaryBox(blk, width = TABLE_WIDTH_TWIP) {
  const label = String(blk.label || "").trim();
  const body = asList(blk.body).filter((x) => x != null && String(x).trim() !== "");
  const children = [];
  if (label) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: parseRichText(docxText(label), {
          font: currentFont(),
          size: 24,
          bold: true,
          allowHighlights: allowHighlights(),
        }),
      }),
    );
  }
  for (const line of body) {
    children.push(p(line, { align: AlignmentType.JUSTIFIED, spaceAfter: 80 }));
  }
  if (!children.length) children.push(emptyP());
  const solid = { style: BorderStyle.SINGLE, size: 6, color: "000000" };
  return [
    new Table({
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: width, type: WidthType.DXA },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              borders: { top: solid, bottom: solid, left: solid, right: solid },
              children,
            }),
          ],
        }),
      ],
      width: { size: width, type: WidthType.DXA },
      columnWidths: [width],
      layout: TableLayoutType.FIXED,
    }),
    emptyP(),
  ];
}

// ── columns (멀티컬럼 레이아웃) ────────────────────────────────────────────────
function renderColumns(blk, ctx, width = TABLE_WIDTH_TWIP) {
  const cols = Array.isArray(blk.columns) ? blk.columns : [];
  if (!cols.length) return [];
  const n = Math.max(1, Math.min(cols.length, 4));
  const colW = Math.floor(width / n);
  const innerW = Math.max(colW - 280, 600); // 셀 좌우 여백만큼 줄여 안쪽 표/박스가 안 넘치게
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const noBorders = {
    top: none, bottom: none, left: none, right: none,
    insideHorizontal: none, insideVertical: none,
  };
  const cells = [];
  for (let i = 0; i < n; i++) {
    const raw = cols[i];
    const colBlocks = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
    let children = renderBlocks(colBlocks, ctx, innerW);
    if (!children.length) children = [emptyP()];
    cells.push(
      new TableCell({
        width: { size: colW, type: WidthType.DXA },
        borders: noBorders,
        margins: { top: 40, bottom: 40, left: 100, right: 100 },
        children,
      }),
    );
  }
  return [
    new Table({
      rows: [new TableRow({ children: cells })],
      width: { size: width, type: WidthType.DXA },
      columnWidths: Array.from({ length: n }, () => colW),
      layout: TableLayoutType.FIXED,
      borders: noBorders,
    }),
    emptyP(),
  ];
}

// ── block dispatch ────────────────────────────────────────────────────────────
function renderBlocks(blocks, ctx, width = TABLE_WIDTH_TWIP) {
  const out = [];
  for (const blk of asList(blocks)) {
    if (typeof blk === "string") {
      if (blk.trim()) out.push(p(blk, { align: AlignmentType.JUSTIFIED }));
      continue;
    }
    if (!blk || typeof blk !== "object") continue;
    // type 은 데이터 — 혹시 표기 정리로 `summary_{box}` 처럼 첨자 마커가 끼어도 무시.
    const bt = String(blk.type || "").replace(/[{}*]/g, "").trim().toLowerCase();
    if (bt === "heading") out.push(...renderHeading(blk));
    else if (bt === "paragraph") {
      const text = String(blk.text || "");
      if (text.trim()) {
        out.push(
          p(text, {
            align: toAlign(blk.align, AlignmentType.JUSTIFIED),
            indent: blk.hanging ? { left: 240, hanging: 240 } : undefined,
            size: Number.isFinite(Number(blk.font_size_pt)) ? clampInt(Math.round(Number(blk.font_size_pt) * 2), 16, 48, 22) : 22,
            bold: !!blk.bold,
            italic: !!blk.italic,
            spaceBefore: Number.isFinite(Number(blk.space_before_pt)) ? Math.round(Number(blk.space_before_pt) * 20) : 0,
            spaceAfter: Number.isFinite(Number(blk.space_after_pt)) ? Math.round(Number(blk.space_after_pt) * 20) : 120,
          }),
        );
      }
    } else if (bt === "table") out.push(...renderTable(blk, width));
    else if (bt === "figure") out.push(...renderFigure(blk, ctx, width));
    else if (bt === "equation") out.push(...renderEquation(blk));
    else if (bt === "summary_box") out.push(...renderSummaryBox(blk, width));
    else if (bt === "columns") out.push(...renderColumns(blk, ctx, width));
    else if (bt === "spacer") {
      for (let i = 0; i < clampInt(blk.lines, 1, 6, 1); i++) out.push(emptyP());
    } else if (bt === "pagebreak") {
      out.push(new Paragraph({ children: [new PageBreak()] }));
    } else {
      const text = String(blk.text || "");
      if (text.trim()) out.push(p(text, { align: AlignmentType.JUSTIFIED }));
    }
  }
  return out;
}

// ── 표지 ─────────────────────────────────────────────────────────────────────
function buildTitle(content) {
  const out = [];
  if (content.__hideTitle === true) return out;
  let size = 36;
  const ts = parseInt(content.title_size, 10);
  if (!Number.isNaN(ts)) size = Math.max(16, Math.min(80, ts * 2));
  out.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 200 },
      children: parseRichText(docxText(content.title || "문서"), {
        font: currentFont(),
        size,
        bold: true,
        allowHighlights: allowHighlights(),
      }),
    }),
  );
  const meta = content.meta;
  if (meta && typeof meta === "object") {
    if (meta.field) out.push(p(meta.field, { align: AlignmentType.RIGHT, spaceAfter: 60 }));
    for (const author of asList(meta.authors)) {
      if (String(author).trim()) out.push(p(String(author), { align: AlignmentType.RIGHT, spaceAfter: 40 }));
    }
    if (meta.advisor) out.push(p(meta.advisor, { align: AlignmentType.RIGHT, spaceAfter: 200 }));
    if (Array.isArray(meta.keywords) && meta.keywords.length) {
      out.push(p("연구 핵심 키워드: " + meta.keywords.filter((k) => String(k).trim()).join(", "), { spaceAfter: 160 }));
    }
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
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
  const children = [...buildTitle(content), ...renderBlocks(content.blocks, ctx)];

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

  // 원문 2단 레이아웃 모드: docx 도 2단 구역으로(보조 포맷). 한글(HWPX)이 우선.
  const twoCol = String(content.__layoutMode || "").toLowerCase() === "layout";
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
          ...(twoCol ? { column: { count: 2, space: convertMillimetersToTwip(8) } } : {}),
        },
        footers: { default: footer },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateDocx };
