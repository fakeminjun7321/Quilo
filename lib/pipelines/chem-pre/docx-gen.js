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
  BorderStyle,
  ShadingType,
  WidthType,
  Header,
  LevelFormat,
  ExternalHyperlink,
  ImageRun,
  convertMillimetersToTwip,
} = require("docx");
const { parseRichText, stripMarkers } = require("../../parser");
const { stripEquationMarkersForDocx } = require("../../latex-to-unicode");

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

// ── Style helpers ────────────────────────────────────────────────────────────

function richP({ runs = [], align, indent, spaceAfter = 80 }) {
  return new Paragraph({
    alignment: align,
    spacing: { after: spaceAfter, line: 312 }, // ~1.3 line spacing
    indent,
    children: runs,
  });
}

function p(text, opts = {}) {
  // 모델이 docx 모드에서도 {{EQ:...}}/{{EQ-LATEX:...}} 마커를 남길 수 있어
  // 유니코드 평문으로 변환해 raw 마커가 사용자에게 노출되지 않게 한다.
  const runs = parseRichText(stripEquationMarkersForDocx(text), {
    font: currentFont(),
    size: opts.size || 22,
    bold: opts.bold,
    italic: opts.italic,
    allowHighlights: allowHighlights(),
  });
  return richP({
    runs,
    align: opts.align,
    indent: opts.indent,
    spaceAfter: opts.spaceAfter,
  });
}

function emptyP() {
  return new Paragraph({ children: [new TextRun({ text: "" })] });
}

function stripManualNumbering(text) {
  return String(text || "")
    .replace(/^\s*(?:(?:\(\s*\d{1,2}\s*\)|[①-⑳❶-❿]|\d{1,2}[.)])[\s:：-]+)+/, "")
    .trim();
}

function stripManualBullet(text) {
  return String(text || "").replace(/^\s*[-•]\s+/, "").trim();
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildHeader(content) {
  const titleEn = content.title_en || "";
  const titleKr = content.title_kr || "";
  const date = content.date || "";
  const stu = content.__studentInfo || {};
  const idName = [stu.studentId, stu.userName].filter(Boolean).join(" ");
  const blocks = [
    p("실험 보고서", { align: AlignmentType.CENTER, bold: true, size: 40, spaceAfter: 120 }),
    p(`${titleEn} (${titleKr})`, {
      align: AlignmentType.CENTER,
      bold: true,
      size: 32,
      spaceAfter: 200,
    }),
  ];

  if (idName) {
    blocks.push(p(idName, { align: AlignmentType.RIGHT, size: 22, spaceAfter: 40 }));
  }
  blocks.push(p(`날짜 : ${date}`, { align: AlignmentType.RIGHT, size: 22, spaceAfter: 200 }));
  return blocks;
}

function buildPurpose(items = []) {
  const out = [];
  out.push(p("1. 실험목표", { bold: true, size: 32, spaceAfter: 120 }));
  out.push(p("가. 실험목표", { bold: true, size: 26, spaceAfter: 80 }));
  items.forEach((it, idx) => {
    out.push(
      p(`(${idx + 1}) ${stripManualNumbering(it)}`, {
        size: 22,
        indent: { left: convertMillimetersToTwip(5) },
      }),
    );
  });
  out.push(emptyP());
  return out;
}

const KR_NUM = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하"];

// 점선 테두리 (그림 placeholder용)
const DASHED_BORDER = {
  top: { style: BorderStyle.DASHED, size: 6, color: "888888" },
  bottom: { style: BorderStyle.DASHED, size: 6, color: "888888" },
  left: { style: BorderStyle.DASHED, size: 6, color: "888888" },
  right: { style: BorderStyle.DASHED, size: 6, color: "888888" },
  insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "auto" },
  insideVertical: { style: BorderStyle.NONE, size: 0, color: "auto" },
};

// 그림이 첨부되지 않은 경우의 placeholder - 점선 박스 + 검색 링크
function buildFigurePlaceholderBox(fig) {
  const caption = fig.caption || "";
  const description = fig.description || "";
  const searchQuery = fig.search_query || caption || "";
  const searchUrl = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(searchQuery)}`;

  const captionLine = `[그림 ${fig.number}] ${caption}${description ? " - " + description : ""}`;

  const cellChildren = [
    p(captionLine, {
      align: AlignmentType.CENTER,
      italic: true,
      size: 20,
      spaceAfter: 80,
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 40, line: 312 },
      children: [
        new TextRun({
          text: "🔎 Google 이미지 검색: ",
          font: currentFont(),
          size: 18,
        }),
        new ExternalHyperlink({
          link: searchUrl,
          children: [
            new TextRun({
              text: `"${searchQuery}"`,
              font: currentFont(),
              size: 18,
              color: "0563C1",
              underline: {},
            }),
          ],
        }),
      ],
    }),
  ];

  const cell = new TableCell({
    children: cellChildren,
    margins: { top: 200, bottom: 200, left: 240, right: 240 },
  });

  const row = new TableRow({ children: [cell] });

  return [
    new Table({
      rows: [row],
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: DASHED_BORDER,
    }),
    emptyP(),
  ];
}

// 그림 1장 분량의 paragraph 묶음 - 점선 박스 placeholder + 구글 검색 링크
function buildFigureBlock(fig) {
  return buildFigurePlaceholderBox(fig);
}

// PNG IHDR 에서 width/height(big-endian) 추출. 실패 시 정사각 가정.
function pngSize(buf) {
  if (
    Buffer.isBuffer(buf) &&
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50
  ) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  return { width: 1024, height: 1024 };
}

// AI 생성 개념도/삽화(content.__figures) → 가운데 정렬 이미지 + 캡션.
// __figures 가 없으면 빈 배열(기존 동작 그대로).
function buildGeneratedFigures(content) {
  const figs = Array.isArray(content.__figures) ? content.__figures : [];
  if (figs.length === 0) return [];
  const out = [];
  for (const fig of figs) {
    if (!fig || !Buffer.isBuffer(fig.buffer) || fig.buffer.length === 0) continue;
    const dim = pngSize(fig.buffer);
    const W = 360; // 표시 너비(px)
    const H = Math.max(1, Math.round(W * (dim.height / dim.width)));
    out.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 40 },
        children: [
          new ImageRun({
            data: fig.buffer,
            type: "png",
            transformation: { width: W, height: H },
          }),
        ],
      }),
    );
    out.push(
      p(fig.caption || "개념 설명 그림 (AI 생성 개념도)", {
        align: AlignmentType.CENTER,
        italic: true,
        size: 20,
        spaceAfter: 120,
      }),
    );
  }
  return out;
}

function buildTheory(theory = [], figuresNeeded = [], insertedSet = null) {
  const out = [];
  out.push(p("2. 이론적 배경과 원리", { bold: true, size: 32, spaceAfter: 120 }));

  const findFig = (n) =>
    (figuresNeeded || []).find((f) => Number(f.number) === Number(n));

  theory.forEach((section, sIdx) => {
    const krLetter = KR_NUM[sIdx] || `${sIdx + 1}`;
    out.push(
      p(`${krLetter}. ${stripManualNumbering(section.topic)}`, {
        bold: true,
        size: 26,
        spaceAfter: 80,
      }),
    );

    const items = section.items || section.paragraphs || [];
    let textCounter = 0;
    items.forEach((item) => {
      // 그림 마커: { "figure": N } 객체
      if (item && typeof item === "object" && typeof item.figure === "number") {
        const fig = findFig(item.figure);
        if (fig) {
          out.push(...buildFigureBlock(fig));
          if (insertedSet) insertedSet.add(Number(fig.number));
        } else {
          // figures_needed에 매칭되는 항목이 없으면 placeholder
          out.push(
            p(`[그림 ${item.figure}] (메타데이터 없음)`, {
              align: AlignmentType.CENTER,
              italic: true,
              size: 20,
              spaceAfter: 120,
            }),
          );
        }
      } else if (typeof item === "string") {
        textCounter++;
        out.push(
          p(`(${textCounter}) ${stripManualNumbering(item)}`, {
            size: 22,
            indent: { left: convertMillimetersToTwip(5) },
            spaceAfter: 100,
          }),
        );
      }
    });

    // 구식 schema 호환: section.figures 배열이 있으면 섹션 끝에 인라인 삽입
    (section.figures || []).forEach((figRef) => {
      const fullFig = findFig(figRef.number) || figRef;
      out.push(...buildFigureBlock(fullFig));
      if (insertedSet) insertedSet.add(Number(fullFig.number));
    });
  });
  out.push(emptyP());
  return out;
}

// ── Tables ───────────────────────────────────────────────────────────────────

const FULL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  left: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  right: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
  insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "000000" },
};

function tableCell(text, { bold = false, shaded = false, align = AlignmentType.CENTER } = {}) {
  const runs = parseRichText(stripEquationMarkersForDocx(text), {
    font: currentFont(),
    size: 20,
    bold,
    allowHighlights: allowHighlights(),
  });
  return new TableCell({
    children: [
      new Paragraph({
        alignment: align,
        spacing: { before: 40, after: 40 },
        children: runs,
      }),
    ],
    shading: shaded
      ? { type: ShadingType.CLEAR, color: "auto", fill: "D9E2F3" }
      : undefined,
    margins: { top: 80, bottom: 80, left: 100, right: 100 },
  });
}

function buildChemicalsSummaryTable(rows = []) {
  const headers = ["시약", "화학식", "몰질량(g/mol)", "녹는점/끓는점", "주요 특성"];
  const headerRow = new TableRow({
    children: headers.map((h) =>
      tableCell(h, { bold: true, shaded: true, align: AlignmentType.CENTER }),
    ),
    tableHeader: true,
  });
  const dataRows = rows.map(
    (r) =>
      new TableRow({
        children: [
          tableCell(r.name || ""),
          tableCell(r.formula || ""),
          tableCell(r.molar_mass || "", { align: AlignmentType.CENTER }),
          tableCell(r.mp_bp || "", { align: AlignmentType.CENTER }),
          tableCell(r.properties || ""),
        ],
      }),
  );
  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: FULL_BORDER,
  });
}

// ── Apparatus & Chemicals ────────────────────────────────────────────────────

// 기구·시약 영문 병기 중복 방지 (DEF-035): name_en 핵심 토큰(공백 제거,
// 소문자화)이 이미 name 안에 들어 있으면 괄호 병기를 생략한다.
// 예: name '뷰렛(Buret)' + name_en 'Buret' 은 '(Buret)' 를 다시 붙이지 않는다.
// hwpx 생성기와 동일 기준.
function shouldAppendEnName(name, nameEn) {
  const core = String(nameEn || "").replace(/\s+/g, "").toLowerCase();
  if (!core) return false;
  const base = String(name || "").replace(/\s+/g, "").toLowerCase();
  return !base.includes(core);
}

function buildApparatusAndChemicals(content) {
  const out = [];
  out.push(p("3. 실험 기구 및 시약", { bold: true, size: 32, spaceAfter: 120 }));
  const refIndex = referenceIndex(content);

  // 가. 실험 기구
  out.push(p("가. 실험 기구", { bold: true, size: 26, spaceAfter: 80 }));
  (content.apparatus || []).forEach((ap, idx) => {
    const name = stripManualNumbering(ap.name);
    const enName = shouldAppendEnName(name, ap.name_en)
      ? ` (${ap.name_en})`
      : "";
    out.push(
      p(`(${idx + 1}) **${name}**${enName}: ${ap.description || ""}`, {
        size: 22,
        indent: { left: convertMillimetersToTwip(5) },
        spaceAfter: 80,
      }),
    );
  });
  out.push(emptyP());

  // 나. 시약
  out.push(p("나. 시약", { bold: true, size: 26, spaceAfter: 80 }));
  (content.chemicals || []).forEach((ch, idx) => {
    const sourceUrl = String(ch.source_url || "").trim();
    const refMarker = sourceUrl && refIndex.has(sourceUrl)
      ? ` [${refIndex.get(sourceUrl)}]`
      : "";
    const name = stripManualNumbering(ch.name);
    const head = `(${idx + 1}) **${name}** (${ch.iupac || ""}, ${ch.formula || ""})${refMarker}`;
    out.push(
      p(head, {
        size: 22,
        indent: { left: convertMillimetersToTwip(5) },
        spaceAfter: 40,
      }),
    );
    // 시약 속성을 한 줄에 슬래시(`/`)로 이어 붙이면 GPT 요약 같은 인상을
    // 준다는 베타테스터 피드백. 각 속성을 별도 줄로 분리해 학생이 작성한
    // 정상 보고서처럼 보이도록 한다.
    const lines = [
      ch.molar_mass ? `· 몰질량: ${ch.molar_mass}` : "",
      ch.mp_bp ? `· 녹는점/끓는점: ${ch.mp_bp}` : "",
      ch.density ? `· 밀도: ${ch.density}` : "",
      ch.properties ? `· 주요 특성: ${ch.properties}` : "",
      ch.toxicity ? `· 독성/취급: ${ch.toxicity}` : "",
    ].filter(Boolean);
    lines.forEach((line, i) => {
      out.push(
        p(line, {
          size: 22,
          indent: { left: convertMillimetersToTwip(10) },
          spaceAfter: i === lines.length - 1 ? 100 : 20,
        }),
      );
    });
  });

  // 시약 요약 표
  if ((content.chemicals_summary_table || []).length > 0) {
    out.push(emptyP());
    out.push(p("[표 1] 시약 요약", { bold: true, size: 22, spaceAfter: 80 }));
    out.push(buildChemicalsSummaryTable(content.chemicals_summary_table));
    out.push(emptyP());
  }

  return out;
}

// ── Procedure ────────────────────────────────────────────────────────────────

function buildProcedure(procedure = []) {
  const out = [];
  out.push(p("4. 실험 과정", { bold: true, size: 32, spaceAfter: 120 }));
  procedure.forEach((sec, sIdx) => {
    const krLetter = KR_NUM[sIdx] || `${sIdx + 1}`;
    out.push(
      p(`${krLetter}. ${stripManualNumbering(sec.title)}`, { bold: true, size: 26, spaceAfter: 80 }),
    );
    (sec.steps || []).forEach((step, stIdx) => {
      // step may be a string or { text, notes: [...] }
      if (typeof step === "string") {
        out.push(
          p(`(${stIdx + 1}) ${stripManualNumbering(step)}`, {
            size: 22,
            indent: { left: convertMillimetersToTwip(5) },
            spaceAfter: 80,
          }),
        );
      } else if (step && typeof step === "object") {
        out.push(
          p(`(${stIdx + 1}) ${stripManualNumbering(step.text)}`, {
            size: 22,
            indent: { left: convertMillimetersToTwip(5) },
            spaceAfter: 60,
          }),
        );
        (step.notes || []).forEach((note) => {
          out.push(
            p(`- ${stripManualNumbering(stripManualBullet(note))}`, {
              size: 22,
              indent: { left: convertMillimetersToTwip(10) },
              spaceAfter: 40,
            }),
          );
        });
      }
    });
    out.push(emptyP());
  });
  return out;
}

// ── Top-level builder ────────────────────────────────────────────────────────

// ── Minimal 스타일 빌더들 ───────────────────────────────────────────────────
// 사전보고서용 minimal 스타일 (잘 만든 학생 보고서 스타일을 사전보고서에 맞춤).
// "잘 만든 학생 사전보고서" 패턴: 표지·시약 표·그림 placeholder·가나다 헤더 모두 없음.
// 4~7페이지, 자연스러운 학생 보고서 스타일.

function buildMinimalHeader(content) {
  const titleEn = content.title_en || "";
  const titleKr = content.title_kr || "";
  const stu = content.__studentInfo || {};
  const idName = [stu.studentId, stu.userName].filter(Boolean).join(" ");
  const blocks = [];

  // 영문 제목 큼지막하게, 한글은 괄호로
  const titleLine = titleEn
    ? (titleKr ? `${titleEn} (${titleKr})` : titleEn)
    : (titleKr || "");
  if (titleLine) {
    blocks.push(
      p(titleLine, {
        align: AlignmentType.CENTER,
        bold: true,
        size: 32,
        spaceAfter: 60,
      }),
    );
  }

  // "학번 이름 | 날짜" 한 줄
  const headerBits = [];
  if (idName) headerBits.push(idName);
  if (content.date) headerBits.push(content.date);
  if (headerBits.length) {
    blocks.push(
      p(headerBits.join(" | "), {
        align: AlignmentType.RIGHT,
        size: 22,
        spaceAfter: 200,
      }),
    );
  }
  return blocks;
}

function buildMinimalPurpose(items = []) {
  const blocks = [
    p("1. 실험 목표", { bold: true, size: 28, spaceAfter: 80 }),
  ];
  if (items.length === 0) {
    blocks.push(p("(데이터 부족)"));
  } else if (items.length === 1) {
    blocks.push(p(items[0], { indent: { firstLine: 200 } }));
  } else {
    blocks.push(p(items.join(" "), { indent: { firstLine: 200 } }));
  }
  blocks.push(emptyP());
  return blocks;
}

function buildMinimalTheory(theory = []) {
  const blocks = [
    p("2. 이론적 배경", { bold: true, size: 28, spaceAfter: 80 }),
  ];
  theory.forEach((sec, i) => {
    blocks.push(
      p(`(${i + 1}) ${stripManualNumbering(sec.topic)}`, { bold: true, spaceAfter: 40 }),
    );
    const items = Array.isArray(sec.items) ? sec.items : [];
    items.forEach((item) => {
      // figure 마커는 minimal에선 무시
      if (typeof item === "string") {
        blocks.push(p(item, { indent: { left: 240, firstLine: 200 } }));
      }
    });
    blocks.push(emptyP());
  });
  if (theory.length === 0) blocks.push(p("(이론 데이터 부족)"));
  return blocks;
}

function buildMinimalApparatus(content) {
  const blocks = [
    p("3. 실험 기구 및 시약", { bold: true, size: 28, spaceAfter: 80 }),
  ];

  blocks.push(p("(1) 실험 기구", { bold: true, spaceAfter: 40 }));
  const apps = Array.isArray(content.apparatus) ? content.apparatus : [];
  apps.forEach((a) => {
    const detail = a.description ? `: ${a.description}` : "";
    const name = stripManualNumbering(a.name);
    blocks.push(p(`${name}${detail}`, { indent: { left: 240 } }));
  });
  if (apps.length === 0) blocks.push(p("(기구 데이터 부족)"));

  blocks.push(emptyP());
  blocks.push(p("(2) 시약", { bold: true, spaceAfter: 40 }));
  const chems = Array.isArray(content.chemicals) ? content.chemicals : [];
  chems.forEach((c) => {
    const headParts = [c.formula, c.molar_mass].filter(Boolean).join(", ");
    const name = stripManualNumbering(c.name || c.iupac);
    const head = headParts ? `${name} (${headParts})` : name;
    const details = [
      c.mp_bp ? `녹는점/끓는점: ${c.mp_bp}` : "",
      c.density ? `밀도: ${c.density}` : "",
      c.properties ? `주요 특성: ${c.properties}` : "",
      c.toxicity ? `독성/취급: ${c.toxicity}` : "",
    ].filter(Boolean);
    blocks.push(p(head, { indent: { left: 240 }, bold: true, spaceAfter: 20 }));
    details.forEach((detail) => {
      blocks.push(p(`- ${detail}`, { indent: { left: 480 }, size: 20, spaceAfter: 20 }));
    });
  });
  if (chems.length === 0) blocks.push(p("(시약 데이터 부족)"));

  blocks.push(emptyP());
  return blocks;
}

function buildMinimalProcedure(procedure = []) {
  const blocks = [
    p("4. 실험 과정", { bold: true, size: 28, spaceAfter: 80 }),
  ];
  procedure.forEach((proc, i) => {
    if (procedure.length > 1) {
      blocks.push(
        p(`(${i + 1}) ${stripManualNumbering(proc.title)}`, { bold: true, spaceAfter: 40 }),
      );
    }
    const steps = Array.isArray(proc.steps) ? proc.steps : [];
    const circled = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
    steps.forEach((step, j) => {
      const text = stripManualNumbering(
        typeof step === "string" ? step : step.text || "",
      );
      const marker = circled[j] || `(${j + 1})`;
      blocks.push(
        p(`${marker} ${text}`, {
          indent: { left: procedure.length > 1 ? 240 : 0 },
        }),
      );
      // notes는 들여써서 표기
      if (typeof step === "object" && Array.isArray(step.notes)) {
        step.notes.forEach((note) => {
          blocks.push(
            p(`- ${stripManualNumbering(stripManualBullet(note))}`, {
              indent: { left: 480 },
              size: 20,
            }),
          );
        });
      }
    });
    blocks.push(emptyP());
  });
  if (procedure.length === 0) blocks.push(p("(실험 과정 데이터 부족)"));
  return blocks;
}

// Claude가 references를 문자열 대신 객체로 응답한 경우 안전하게 한 줄 문자열로 변환.
// 객체면 흔한 필드(저자/연도/제목/출판사 등)를 합쳐 문자열로, 마지막 fallback은 JSON.
function refToString(r) {
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const parts = [
      r.author || r.authors,
      r.year || r.date,
      r.title,
      r.journal,
      r.publisher,
      r.url,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(", ");
    return JSON.stringify(r);
  }
  return String(r ?? "");
}

function referenceLabelForUrl(content, url) {
  for (const ref of content.references || []) {
    if (ref && typeof ref === "object" && String(ref.url || "").trim() === url) {
      return String(ref.label || ref.title || url).trim();
    }
  }
  for (const ch of content.chemicals || []) {
    if (String(ch.source_url || "").trim() === url) {
      return String(ch.name || ch.iupac || url).trim();
    }
  }
  return url;
}

function collectReferenceEntries(content) {
  const entries = [];
  const seenUrls = new Set();
  const seenText = new Set();

  const addUrl = (url, label) => {
    const normalizedUrl = String(url || "").trim();
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    entries.push({
      label: String(label || normalizedUrl).trim(),
      url: normalizedUrl,
    });
  };

  for (const ch of content.chemicals || []) {
    const url = String(ch.source_url || "").trim();
    if (url) addUrl(url, ch.name || ch.iupac || url);
  }

  for (const ref of content.references || []) {
    if (ref && typeof ref === "object") {
      const url = String(ref.url || "").trim();
      if (url) {
        addUrl(url, ref.label || ref.title || referenceLabelForUrl(content, url));
        continue;
      }
    }

    const text = refToString(ref).trim();
    if (!text || seenText.has(text) || seenUrls.has(text)) continue;
    seenText.add(text);
    entries.push({ text });
  }

  return entries.map((entry) => {
    if (!entry.url) return entry;
    return {
      ...entry,
      label: referenceLabelForUrl(content, entry.url) || entry.label || entry.url,
    };
  });
}

function referenceIndex(content) {
  const index = new Map();
  collectReferenceEntries(content).forEach((entry, idx) => {
    if (entry.url) index.set(entry.url, idx + 1);
  });
  return index;
}

function referenceParagraph(entry, idx) {
  if (!entry.url) {
    return p(`[${idx}] ${entry.text}`, {
      size: 20,
      indent: { left: convertMillimetersToTwip(5) },
    });
  }

  return new Paragraph({
    spacing: { after: 80, line: 312 },
    indent: { left: convertMillimetersToTwip(5) },
    children: [
      new TextRun({
        text: `[${idx}] ${entry.label}: `,
        font: currentFont(),
        size: 20,
      }),
      new ExternalHyperlink({
        link: entry.url,
        children: [
          new TextRun({
            text: entry.url,
            font: currentFont(),
            size: 20,
            color: "0563C1",
            underline: {},
          }),
        ],
      }),
    ],
  });
}

function buildReferences(content) {
  const entries = collectReferenceEntries(content);
  if (entries.length === 0) return [];

  const blocks = [
    p("참고문헌", {
      bold: true,
      size: 32,
      spaceAfter: 120,
    }),
  ];
  entries.forEach((entry, idx) => {
    blocks.push(referenceParagraph(entry, idx + 1));
  });
  blocks.push(emptyP());
  return blocks;
}

function buildMinimalReferences(refs = []) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return [];
  }
  const blocks = [
    p("5. 참고 문헌", { bold: true, size: 28, spaceAfter: 80 }),
  ];
  refs.forEach((r) => {
    blocks.push(p(refToString(r)));
  });
  return blocks;
}

function buildMinimalChildren(content) {
  return [
    ...buildMinimalHeader(content),
    ...buildMinimalPurpose(content.purpose || []),
    ...buildMinimalTheory(content.theory || []),
    ...buildGeneratedFigures(content),
    ...buildMinimalApparatus(content),
    ...buildMinimalProcedure(content.procedure || []),
    ...buildMinimalReferences(content.references || []),
  ];
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function generateDocx(content) {
  return fontStorage.run(
    resolveFontFace(content),
    () =>
      highlightStorage.run(
        content.__allowHighlights !== false,
        () => generateDocxWithFont(content),
      ),
  );
}

async function generateDocxWithFont(content) {
  const isMinimal = content.__style === "minimal";
  const sectionChildren = isMinimal
    ? buildMinimalChildren(content)
    : [
        ...buildHeader(content),
        ...buildPurpose(content.purpose || []),
        ...buildTheory(content.theory || [], content.figures_needed || []),
        ...buildGeneratedFigures(content),
        ...buildApparatusAndChemicals(content),
        ...buildProcedure(content.procedure || []),
        ...buildReferences(content),
      ];

  // NOTE: data_table은 docx 출력에서 제외 (나중에 별도 엑셀 추출용으로만 사용)

  const doc = new Document({
    creator: "Chem Pre-Lab Generator",
    title: content.title_kr || "사전보고서",
    styles: {
      default: {
        document: {
          run: { font: currentFont(), size: 22 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25),
              right: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(25),
            },
          },
        },
        // 푸터(바닥글) 미사용 - 사용자 요청으로 페이지 번호 포함 바닥글 줄을 넣지 않는다.
        footers: undefined,
        children: sectionChildren,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateDocx, _shouldAppendEnName: shouldAppendEnName };
