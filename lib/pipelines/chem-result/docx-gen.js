// Phase 2-2: 결과보고서 docx 생성 (단순 버전)
// - 마커 처리·이미지 삽입·정교한 표는 Phase 2-5에서 추가 예정
// - 우선 보고서 구조(헤더 + 7섹션 + PCEI)만 텍스트로 출력

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
  WidthType,
  BorderStyle,
  ShadingType,
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

// 차트 이미지 크기 (chart-gen.js의 800x500 기준 16:10 비율)
const CHART_WIDTH_PX = 480;
const CHART_HEIGHT_PX = 300;

// 실험 사진 크기
const PHOTO_TARGET_WIDTH_PX = 320;
const PHOTO_MAX_HEIGHT_PX = 360;
const PHOTO_FALLBACK_HEIGHT_PX = 240;

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

// 마커(_{}, ^{}, *italic*, **bold**, 그리스문자) 처리 단락
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
    spacing: { after: opts.spaceAfter ?? 80, line: 312 },
    indent: opts.indent,
    children: runs,
  });
}

function heading(text, level = HeadingLevel.HEADING_1, opts = {}) {
  return new Paragraph({
    heading: level,
    alignment: opts.align,
    spacing: { before: opts.before ?? 240, after: opts.after ?? 120 },
    children: [
      new TextRun({
        text: String(text ?? ""),
        font: currentFont(),
        size: opts.size || 26,
        bold: true,
      }),
    ],
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

function stripLeadingVisualLabel(text) {
  return String(text || "")
    .replace(/^\s*\[\s*(?:그림|그래프)\s*\d+\s*\]\s*/, "")
    .trim();
}

function visualCaption(label, number, ...parts) {
  const body = parts
    .map(stripLeadingVisualLabel)
    .filter(Boolean)
    .join(" — ");
  return body ? `[${label} ${number}] ${body}` : `[${label} ${number}]`;
}

// 표 (헤더 행 회색, 마커 처리 적용)
function tableCellParagraph(text, opts = {}) {
  const runs = parseRichText(String(text ?? ""), {
    font: currentFont(),
    size: 20,
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
  const headerCells = headers.map(
    (h) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "D5E8F0" },
        children: [tableCellParagraph(h, { bold: true })],
      }),
  );

  const headerRow = new TableRow({ children: headerCells, tableHeader: true });

  const dataRows = rows.map(
    (row) =>
      new TableRow({
        children: row.map(
          (cell) =>
            new TableCell({
              children: [tableCellParagraph(cell)],
            }),
        ),
      }),
  );

  return new Table({
    rows: [headerRow, ...dataRows],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

// ── 섹션 빌더들 ──────────────────────────────────────────────────────────────

function buildHeader(content) {
  const blocks = [];
  // 제목도 마커 처리 거치도록 p() 사용 (Claude가 제목에 *변수* 넣을 수 있음)
  if (content.title_kr) {
    blocks.push(
      p(content.title_kr, {
        align: AlignmentType.CENTER,
        bold: true,
        size: 32,
        spaceAfter: 60,
      }),
    );
  }
  if (content.title_en) {
    blocks.push(
      p(content.title_en, {
        align: AlignmentType.CENTER,
        italic: true,
        size: 22,
        spaceAfter: 200,
      }),
    );
  }

  const stu = content.__studentInfo || {};
  const idName = [stu.studentId, stu.userName].filter(Boolean).join(" ");
  if (idName) {
    blocks.push(p(idName, { align: AlignmentType.RIGHT, spaceAfter: 40 }));
  }

  // 헤더 정보 (날짜, 온도, 기압)
  const headerBits = [];
  if (content.date) headerBits.push(`날짜: ${content.date}`);
  if (content.conditions?.temperature)
    headerBits.push(`온도: ${content.conditions.temperature}`);
  if (content.conditions?.pressure)
    headerBits.push(`기압: ${content.conditions.pressure}`);
  if (headerBits.length) {
    blocks.push(p(headerBits.join("    "), { align: AlignmentType.CENTER }));
    blocks.push(emptyP());
  }

  return blocks;
}

function buildPurpose(content) {
  const blocks = [heading("1. 실험목표 (Purpose)")];
  blocks.push(p("가. 실험목표", { bold: true }));
  const items = Array.isArray(content.purpose) ? content.purpose : [];
  items.forEach((item, i) => {
    blocks.push(p(`(${i + 1}) ${stripManualNumbering(item)}`, { indent: { left: 360 } }));
  });
  if (items.length === 0) blocks.push(p("(데이터 부족)"));
  blocks.push(emptyP());
  return blocks;
}

function buildTheory(content) {
  const blocks = [heading("2. 이론적 배경과 원리 (Theory & Principle)")];
  const sections = Array.isArray(content.theory) ? content.theory : [];
  const ka = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"];
  sections.forEach((sec, i) => {
    blocks.push(p(`${ka[i] || "?"}. ${stripManualNumbering(sec.topic)}`, { bold: true }));
    const items = Array.isArray(sec.items) ? sec.items : [];
    items.forEach((item, j) => {
      if (typeof item === "string") {
        blocks.push(p(`(${j + 1}) ${stripManualNumbering(item)}`, { indent: { left: 360 } }));
      }
      // figure 마커 등은 Phase 2-5에서 처리
    });
    blocks.push(emptyP());
  });
  if (sections.length === 0) blocks.push(p("(이론 데이터 부족)"));
  return blocks;
}

function buildApparatusAndChemicals(content) {
  const blocks = [heading("3. 실험 기구 및 시약 (Apparatus & Chemicals)")];

  blocks.push(p("가. 실험 기구", { bold: true }));
  const apps = Array.isArray(content.apparatus) ? content.apparatus : [];
  apps.forEach((a, i) => {
    const name = stripManualNumbering(a.name);
    blocks.push(
      p(`(${i + 1}) ${name}: ${a.description || ""}`, {
        indent: { left: 360 },
      }),
    );
  });
  if (apps.length === 0) blocks.push(p("(기구 데이터 부족)"));
  blocks.push(emptyP());

  blocks.push(p("나. 시약", { bold: true }));
  const chems = Array.isArray(content.chemicals) ? content.chemicals : [];
  chems.forEach((c, i) => {
    const name = stripManualNumbering(c.iupac || c.name);
    const head = `${name}(${c.formula || ""}, ${c.molar_mass || ""})`;
    const desc = [c.properties, c.toxicity].filter(Boolean).join(" / ");
    blocks.push(p(`(${i + 1}) ${head}: ${desc}`, { indent: { left: 360 } }));
  });
  if (chems.length === 0) blocks.push(p("(시약 데이터 부족)"));
  blocks.push(emptyP());

  return blocks;
}

function buildProcedure(content) {
  const blocks = [heading("4. 실험 과정 (Procedure)")];
  const procs = Array.isArray(content.procedure) ? content.procedure : [];
  const ka = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"];
  procs.forEach((proc, i) => {
    blocks.push(p(`${ka[i] || "?"}. ${stripManualNumbering(proc.title)}`, { bold: true }));
    const steps = Array.isArray(proc.steps) ? proc.steps : [];
    steps.forEach((step, j) => {
      const text = stripManualNumbering(
        typeof step === "string" ? step : step.text || "",
      );
      blocks.push(p(`(${j + 1}) ${text}`, { indent: { left: 360 } }));
    });
    blocks.push(emptyP());
  });
  if (procs.length === 0) blocks.push(p("(실험 과정 데이터 부족)"));
  return blocks;
}

function buildPhotoBlocks(exp, allPhotos, figCounter) {
  const blocks = [];
  const indices = Array.isArray(exp.photo_indices) ? exp.photo_indices : [];
  for (const idx of indices) {
    const photo = allPhotos[idx];
    if (!photo || !Buffer.isBuffer(photo.buffer) || photo.buffer.length === 0) continue;
    const dim = getPhotoDimensions(photo.buffer);
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 40 },
        children: [
          new ImageRun({
            data: photo.buffer,
            type: detectImageType(photo.buffer),
            transformation: { width: dim.width, height: dim.height },
          }),
        ],
      }),
    );
    figCounter.value += 1;
    const captionText = visualCaption(
      "그림",
      figCounter.value,
      exp.photo_caption || exp.name,
    );
    // 마커(*var*, _{}, ^{} 등)가 raw로 남지 않게 p() 사용
    blocks.push(
      p(captionText, {
        align: AlignmentType.CENTER,
        italic: true,
        spaceAfter: 120,
      }),
    );
  }
  return blocks;
}

function buildData(content, allPhotos, figCounter) {
  const blocks = [heading("5. 실험 결과 (Data)")];
  const data = content.data || {};

  if (data.summary) {
    blocks.push(p(`개요: ${data.summary}`));
    blocks.push(emptyP());
  }

  blocks.push(p("가. 측정 데이터", { bold: true }));
  const exps = Array.isArray(data.experiments) ? data.experiments : [];
  exps.forEach((exp) => {
    blocks.push(p(`○ ${exp.name}`, { bold: true, indent: { left: 360 } }));

    if (hasUsableTable(exp.table)) {
      blocks.push(buildTable(exp.table.headers, exp.table.rows));
      blocks.push(emptyP());
    }

    const stats = Array.isArray(exp.stats) ? exp.stats : [];
    if (stats.length) {
      const statText = stats.map((s) => `${s.label}: ${s.value}`).join(", ");
      blocks.push(p(`□ ${statText}`, { indent: { left: 720 } }));
    }

    // 사진 자동 삽입 (photo_indices 기반)
    blocks.push(...buildPhotoBlocks(exp, allPhotos, figCounter));
    blocks.push(emptyP());
  });

  if (hasUsableTable(data.summary_table)) {
    blocks.push(p("○ 요약표", { bold: true, indent: { left: 360 } }));
    blocks.push(buildTable(data.summary_table.headers, data.summary_table.rows));
    blocks.push(emptyP());
  }

  blocks.push(p("나. 데이터 시각화", { bold: true }));
  const charts = Array.isArray(data.charts) ? data.charts : [];
  let chartIdx = 0;
  for (const chart of charts) {
    if (!chart.pngBuffer) {
      // 렌더 실패한 차트는 spec만 텍스트로 표시
      blocks.push(
        p(
          `[그래프 ${chartIdx + 1}] ${chart.title || "(제목 없음)"} — 렌더 실패`,
          { italic: true, indent: { left: 360 } },
        ),
      );
      chartIdx++;
      continue;
    }
    chartIdx++;
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 60 },
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
    // 캡션 — 마커 처리 위해 p() 사용
    const captionText = visualCaption(
      "그래프",
      chartIdx,
      chart.title || "",
      chart.caption || "",
    );
    blocks.push(
      p(captionText, {
        align: AlignmentType.CENTER,
        italic: true,
        spaceAfter: 120,
      }),
    );
  }
  if (charts.length === 0) {
    blocks.push(p("(차트 데이터 없음)", { italic: true }));
  }
  blocks.push(emptyP());

  if (exps.length === 0 && !data.summary) {
    blocks.push(p("(측정 데이터 없음 — 사용자 메모 또는 정성 관찰 중심 작성 필요)"));
  }

  return blocks;
}

function buildDiscussion(content) {
  const blocks = [heading("6. 논의 및 결론 (Discussion & Conclusion)")];
  const d = content.discussion || {};

  blocks.push(p("가. 결과 분석", { bold: true }));
  (d.analysis || []).forEach((a, i) => {
    blocks.push(p(`(${i + 1}) ${stripManualNumbering(a)}`, { indent: { left: 360 } }));
  });
  blocks.push(emptyP());

  blocks.push(p("나. 오차 분석 및 개선점", { bold: true }));
  (d.errors || []).forEach((e, i) => {
    blocks.push(p(`(${i + 1}) [오차] ${stripManualNumbering(e)}`, { indent: { left: 360 } }));
  });
  (d.improvements || []).forEach((imp, i) => {
    blocks.push(p(`(${i + 1}) [개선] ${stripManualNumbering(imp)}`, { indent: { left: 360 } }));
  });
  blocks.push(emptyP());

  return blocks;
}

function buildReferences(content) {
  const blocks = [heading("7. 참고 문헌 (References)")];
  const refs = Array.isArray(content.references) ? content.references : [];
  refs.forEach((r) => {
    blocks.push(p(`- ${refToString(r)}`));
  });
  if (refs.length === 0) blocks.push(p("(참고문헌 미작성)"));
  blocks.push(emptyP());
  return blocks;
}

function buildPCEI(content) {
  const blocks = [heading("추가 작성 (PCEI)")];
  const pcei = content.pcei || {};
  const labels = {
    perception: "Perception (관찰)",
    curiosity: "Curiosity (의문점)",
    exploration: "Exploration (탐구)",
    insight: "Insight (통찰)",
  };
  const ka = ["가", "나", "다", "라"];
  Object.entries(labels).forEach(([key, label], i) => {
    blocks.push(p(`${ka[i]}. ${label}`, { bold: true }));
    blocks.push(
      p(pcei[key] || "(미작성)", { indent: { left: 360 } }),
    );
    blocks.push(emptyP());
  });
  return blocks;
}

// ── Minimal 스타일 빌더들 ────────────────────────────────────────────────────
// 잘 만든 학생 보고서 스타일.
// 표지·목차·가나다 헤더·PCEI 모두 없이 7~9페이지 핵심만.

function buildMinimalHeader(content) {
  const blocks = [];
  // 영문 제목을 큼지막하게 (학생 보고서는 영문 제목이 메인)
  if (content.title_en) {
    blocks.push(
      p(content.title_en, {
        align: AlignmentType.CENTER,
        bold: true,
        size: 32,
        spaceAfter: 60,
      }),
    );
  } else if (content.title_kr) {
    blocks.push(
      p(content.title_kr, {
        align: AlignmentType.CENTER,
        bold: true,
        size: 32,
        spaceAfter: 60,
      }),
    );
  }

  // "학번 이름 | 날짜" 한 줄 (오른쪽 정렬)
  const stu = content.__studentInfo || {};
  const idName = [stu.studentId, stu.userName].filter(Boolean).join(" ");
  const headerBits = [];
  if (idName) headerBits.push(idName);
  if (content.date) headerBits.push(content.date);
  if (headerBits.length) {
    blocks.push(
      p(headerBits.join(" | "), {
        align: AlignmentType.RIGHT,
        spaceAfter: 200,
      }),
    );
  }
  return blocks;
}

function buildMinimalPurpose(content) {
  const blocks = [heading("1. 실험 목표")];
  const items = Array.isArray(content.purpose) ? content.purpose : [];
  // minimal에선 보통 1~2개를 한 단락으로 흘림
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

function buildMinimalTheory(content) {
  const blocks = [heading("2. 이론적 배경")];
  const sections = Array.isArray(content.theory) ? content.theory : [];
  // (1) 용어\n  정의 1~2단락 패턴
  sections.forEach((sec, i) => {
    blocks.push(
      p(`(${i + 1}) ${stripManualNumbering(sec.topic)}`, {
        bold: true,
        spaceAfter: 40,
      }),
    );
    const items = Array.isArray(sec.items) ? sec.items : [];
    items.forEach((item) => {
      if (typeof item === "string") {
        blocks.push(p(item, { indent: { left: 240, firstLine: 200 } }));
      }
    });
    blocks.push(emptyP());
  });
  if (sections.length === 0) blocks.push(p("(이론 데이터 부족)"));
  return blocks;
}

function buildMinimalApparatus(content) {
  const blocks = [heading("3. 실험 기구 및 시약")];

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
    const suffix = details.length ? `: ${details.join(" / ")}` : "";
    blocks.push(p(`${head}${suffix}`, { indent: { left: 240 } }));
  });
  if (chems.length === 0) blocks.push(p("(시약 데이터 부족)"));

  blocks.push(emptyP());
  return blocks;
}

function buildMinimalProcedure(content) {
  const blocks = [heading("4. 실험 과정")];
  const procs = Array.isArray(content.procedure) ? content.procedure : [];
  // 마침표 + 괄호 안 하위 분류 = "(1) 단계명" 형태로
  procs.forEach((proc, i) => {
    if (procs.length > 1) {
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
          indent: { left: procs.length > 1 ? 240 : 0 },
        }),
      );
    });
    blocks.push(emptyP());
  });
  if (procs.length === 0) blocks.push(p("(실험 과정 데이터 부족)"));
  return blocks;
}

function buildMinimalData(content, allPhotos, figCounter) {
  const blocks = [heading("5. 실험 결과")];
  const data = content.data || {};

  if (data.summary) {
    blocks.push(p(data.summary, { indent: { firstLine: 200 } }));
    blocks.push(emptyP());
  }

  const exps = Array.isArray(data.experiments) ? data.experiments : [];
  exps.forEach((exp) => {
    if (exps.length > 1) {
      blocks.push(p(exp.name, { bold: true, spaceAfter: 40 }));
    }

    if (hasUsableTable(exp.table)) {
      blocks.push(buildTable(exp.table.headers, exp.table.rows));
      blocks.push(emptyP());
    }

    const stats = Array.isArray(exp.stats) ? exp.stats : [];
    if (stats.length) {
      const statText = stats.map((s) => `${s.label}: ${s.value}`).join(", ");
      blocks.push(p(statText, { indent: { left: 240 } }));
    }

    blocks.push(...buildPhotoBlocks(exp, allPhotos, figCounter));
    blocks.push(emptyP());
  });

  if (hasUsableTable(data.summary_table)) {
    blocks.push(buildTable(data.summary_table.headers, data.summary_table.rows));
    blocks.push(emptyP());
  }

  // 차트 — 본문 흐름에 그대로 삽입
  const charts = Array.isArray(data.charts) ? data.charts : [];
  let chartIdx = 0;
  for (const chart of charts) {
    if (!chart.pngBuffer) {
      chartIdx++;
      blocks.push(
        p(
          `[그래프 ${chartIdx}] ${chart.title || "(제목 없음)"} — 렌더 실패`,
          { italic: true },
        ),
      );
      continue;
    }
    chartIdx++;
    blocks.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 60 },
        children: [
          new ImageRun({
            data: chart.pngBuffer,
            type: "png",
            transformation: {
              width: CHART_WIDTH_PX,
              height: CHART_HEIGHT_PX,
            },
          }),
        ],
      }),
    );
    const captionText = visualCaption(
      "그래프",
      chartIdx,
      chart.title || "",
      chart.caption || "",
    );
    blocks.push(
      p(captionText, {
        align: AlignmentType.CENTER,
        italic: true,
        spaceAfter: 120,
      }),
    );
  }

  if (exps.length === 0 && !data.summary) {
    blocks.push(p("(측정 데이터 없음 — 사용자 메모 또는 정성 관찰 중심 작성 필요)"));
  }
  return blocks;
}

function buildMinimalDiscussion(content) {
  const blocks = [];
  const d = content.discussion || {};
  const analysis = Array.isArray(d.analysis) ? d.analysis : [];
  const errors = Array.isArray(d.errors) ? d.errors : [];
  const improvements = Array.isArray(d.improvements) ? d.improvements : [];

  // minimal 스타일은 (a) 결론만, (b) 결론+논의 분리, 두 패턴 모두 가능.
  // analysis가 있으면 결론 섹션. errors/improvements가 충분히 있으면 별도 논의 섹션 추가.
  const hasDiscussion = errors.length > 0 || improvements.length > 0;

  blocks.push(heading("6. 결론"));
  if (analysis.length === 0 && !hasDiscussion) {
    blocks.push(p("(논의 데이터 부족)"));
  } else if (analysis.length > 0) {
    analysis.forEach((a) => {
      blocks.push(p(stripManualNumbering(a), { indent: { firstLine: 200 } }));
    });
  } else {
    // analysis 없으면 errors/improvements를 결론 본문으로
    [...errors, ...improvements].forEach((t) => {
      blocks.push(p(stripManualNumbering(t), { indent: { firstLine: 200 } }));
    });
  }
  blocks.push(emptyP());

  // 별도 논의 섹션 — analysis와 errors가 모두 있을 때만 분리
  if (analysis.length > 0 && hasDiscussion) {
    blocks.push(heading("7. 논의"));
    errors.forEach((e) => {
      blocks.push(p(stripManualNumbering(e), { indent: { firstLine: 200 } }));
    });
    improvements.forEach((imp) => {
      blocks.push(p(stripManualNumbering(imp), { indent: { firstLine: 200 } }));
    });
    blocks.push(emptyP());
  }
  return blocks;
}

// Claude가 references를 문자열 대신 객체로 응답한 경우 안전하게 한 줄 문자열로 변환.
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

function buildMinimalReferences(content) {
  // 결론+논의 분리됐으면 8번, 아니면 7번
  const d = content.discussion || {};
  const hasDiscussion =
    Array.isArray(d.analysis) && d.analysis.length > 0 &&
    ((Array.isArray(d.errors) && d.errors.length > 0) ||
      (Array.isArray(d.improvements) && d.improvements.length > 0));
  const num = hasDiscussion ? 8 : 7;
  const blocks = [heading(`${num}. 참고 문헌`)];
  const refs = Array.isArray(content.references) ? content.references : [];
  refs.forEach((r) => {
    blocks.push(p(refToString(r)));
  });
  if (refs.length === 0) blocks.push(p("(참고문헌 미작성)"));
  return blocks;
}

function buildMinimalChildren(content) {
  return fontStorage.run(
    normalizeFontFace(content.__fontFace || content.font_face),
    () => buildMinimalChildrenWithFont(content),
  );
}

function buildMinimalChildrenWithFont(content) {
  const allPhotos = Array.isArray(content.__photos) ? content.__photos : [];
  const figCounter = { value: 0 };
  return [
    ...buildMinimalHeader(content),
    ...buildMinimalPurpose(content),
    ...buildMinimalTheory(content),
    ...buildMinimalApparatus(content),
    ...buildMinimalProcedure(content),
    ...buildMinimalData(content, allPhotos, figCounter),
    ...buildMinimalDiscussion(content),
    ...buildMinimalReferences(content),
  ];
}

function buildAppendOnlyChildren(content) {
  const allPhotos = Array.isArray(content.__photos) ? content.__photos : [];
  const figCounter = { value: 0 };
  return [
    ...buildData(content, allPhotos, figCounter),
    ...buildDiscussion(content),
    ...buildReferences(content),
    ...buildPCEI(content),
  ];
}

function buildMinimalAppendOnlyChildren(content) {
  const allPhotos = Array.isArray(content.__photos) ? content.__photos : [];
  const figCounter = { value: 0 };
  return [
    ...buildMinimalData(content, allPhotos, figCounter),
    ...buildMinimalDiscussion(content),
    ...buildMinimalReferences(content),
  ];
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
  // chem-result는 사전보고서 PDF 뒤에 붙일 추가 작성분만 출력한다.
  const isMinimal = content.__style === "minimal";
  const children = isMinimal
    ? buildMinimalAppendOnlyChildren(content)
    : buildAppendOnlyChildren(content);

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: currentFont(), size: 22 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(25),
              right: convertMillimetersToTwip(25),
            },
          },
        },
        children,
      },
    ],
  });

  return await Packer.toBuffer(doc);
}

module.exports = {
  generateDocx,
  // phys-result에서 같은 minimal 스타일을 재사용하기 위해 export.
  // chem-result minimal과 phys-result minimal은 동일한 JSON 스키마를 사용.
  buildMinimalChildren,
};
