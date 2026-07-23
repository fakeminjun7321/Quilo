// 재조판(re-typeset) 번역: PDF(또는 스캔본 페이지 이미지)를 Claude 에게 주고
// "한국어 LaTeX 본문"을 받아 Tectonic 으로 PDF 를 만든다. 스캔본일 때는 Claude 가
// 그림 위치(%%FIG:n%% 마커)와 bbox(JSON)를 함께 알려주면, 원본 타일에서 그 영역을
// 잘라 \includegraphics 로 다시 끼워넣는다(그림 복원형 재조판).
const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("node:crypto");
const sharp = require("sharp");
const { calcCost } = require("../../pricing");
const { buildTex, compileTex } = require("./latex-pdf");
const { generateLibreOfficePdf } = require("./libreoffice-gen");
const { validateRetypesetOcrEvidence } = require("./provenance");

// 재조판 기본 모델: Sonnet(비용·속도 효율, 비전 OCR 품질도 충분). 수식 정밀이 핵심인
// 문서는 사용자가 Opus 를 직접 선택하면 그 값이 우선한다. env 로 변경 가능.
const DEFAULT_MODEL = process.env.PDF_RETYPESET_MODEL || "claude-sonnet-5";
// GPT(OpenAI) 선택 시 재조판이 대체할 Claude 모델(재조판은 Claude 네이티브 PDF/비전 입력에
// 맞춰 구현돼 있어 GPT 입력 형식과 호환되지 않는다).
const MAX_TOKENS = parseInt(process.env.PDF_RETYPESET_MAX_TOKENS || "32000", 10);
const MAX_PDF_BYTES = 25 * 1024 * 1024;

async function finalizeRetypesetRenderer(
  tectonicPdf,
  {
    renderer = "tectonic",
    signal,
    onProgress = () => {},
    libreOfficeGenerator = generateLibreOfficePdf,
  } = {},
) {
  const selected = String(renderer || "tectonic").trim().toLowerCase();
  if (!Buffer.isBuffer(tectonicPdf) || !tectonicPdf.length) {
    throw new Error("재조판 중간 PDF가 비어 있습니다.");
  }
  if (selected === "tectonic") {
    return {
      buffer: tectonicPdf,
      effectiveRenderer: "tectonic",
      docxBuffer: null,
      rendererMetadata: null,
    };
  }
  if (selected !== "libreoffice") {
    throw new Error(`지원하지 않는 재조판 출력 엔진입니다: ${selected || "없음"}`);
  }
  onProgress("📝 Tectonic 중간본을 Writer 문서 구조로 재조판 중...");
  const generated = await libreOfficeGenerator(tectonicPdf, {
    signal,
    onProgress,
  });
  if (
    !generated ||
    !Buffer.isBuffer(generated.buffer) ||
    !generated.buffer.length ||
    !Buffer.isBuffer(generated.docxBuffer) ||
    !generated.docxBuffer.length
  ) {
    throw new Error("LibreOffice 재조판 출력 계약이 불완전합니다.");
  }
  return {
    buffer: generated.buffer,
    effectiveRenderer: "libreoffice",
    docxBuffer: generated.docxBuffer,
    rendererMetadata: generated.metadata || null,
  };
}

function bindRetypesetOcrEvidence({
  pdfBuffer,
  ocrSourcePdf = pdfBuffer,
  useImages,
  imageBlocks = null,
  rawTileBuffers = null,
  expectedPageIndices = null,
  ocrEvidence = null,
  ocrRenderManifest = null,
} = {}) {
  if (ocrEvidence == null && ocrRenderManifest == null) return null;
  if (!useImages || ocrEvidence == null || ocrRenderManifest == null) {
    throw new Error(
      "Strict scan retypeset requires canonical OCR evidence and a complete raster manifest together.",
    );
  }
  return validateRetypesetOcrEvidence({
    ocrEvidence,
    ocrRenderManifest,
    sourcePdf: ocrSourcePdf,
    expectedPageIndices,
    modelInputBlocks: imageBlocks,
    rawTileBuffers,
  });
}

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

// 시스템 프롬프트는 모드(restoreOnly)에 따라 완전히 달라져야 한다. 예전에는 프롬프트가
// "produce a faithful KOREAN re-typeset / Translate ALL prose into Korean"로 하드코딩돼
// 있어서, restoreOnly(번역 없이 복원) 유저 지시 한 줄과 정면 충돌했다. 그 결과 청크마다
// 판정이 갈려(산문=한국어, 코드 밀집 교재=영어) 한 문서가 반씩 번역되는 버그가 났다.
// 이제 시스템 프롬프트 자체를 모드에 맞춰 생성해 유저 지시와 항상 일치시킨다.
const _EQ_BLOCK = [
  "CRITICAL — equations:",
  "- The source math is often CORRUPTED or hard to read (Greek letters, primes, roots, subscripts lost or turned into junk). Do NOT copy garbled math. Reconstruct each formula into its mathematically-correct canonical form and typeset it in proper LaTeX. You know the standard form of well-known equations — restore them faithfully.",
  "- Use \\[ ... \\] for display equations and $...$ for inline math. amsmath/amssymb are available.",
];
const _OUTPUT_BLOCK = (titleHint) => [
  "Output format — IMPORTANT:",
  "- Output ONE ```latex code block (the document BODY).",
  "- The FIRST three lines of that block must be metadata comments:",
  `    % TITLE: <${titleHint}>`,
  "    % AUTHOR: <author, may be empty>",
  "    % DATE: <date, may be empty>",
  "- After those, output ONLY the LaTeX BODY (what goes inside \\begin{document}…\\end{document}). Do NOT include \\documentclass, \\usepackage, the preamble, \\begin{document}, \\end{document}, \\title, \\author, \\date, or \\maketitle — those are added automatically.",
  "- These packages are ALREADY loaded — use their commands freely, but do NOT \\usepackage anything: amsmath, amssymb, graphicx, array, booktabs (\\toprule/\\midrule/\\bottomrule), multirow, enumitem (e.g. \\begin{enumerate}[label=(\\alph*)]). For tables prefer booktabs rules.",
  "- Figures: follow the figure instructions in the user message exactly (use %%FIG:n%% markers, plus a JSON list only if the user message asks for one). Do NOT invent \\includegraphics yourself.",
];

function buildSystemPrompt({ restoreOnly = false } = {}) {
  if (restoreOnly) {
    // 복원 모드: 번역 절대 금지. 원문 언어 그대로 전사 + 조판/수식 복원만.
    return [
      "You are an expert LaTeX typesetter. You receive a document (a PDF, or ordered page-image slices of a scanned document) and produce a faithful, clean re-typeset of it as LaTeX, IN THE ORIGINAL LANGUAGE OF THE DOCUMENT.",
      "",
      "ABSOLUTE RULE — do NOT translate:",
      "- Transcribe every word EXACTLY as printed. If the source is English, the output stays English; if Korean, stays Korean. NEVER translate, localize, or paraphrase any text — not headings, not captions, not body prose, not footnotes. Your job is to reproduce the document cleanly, not to change its language.",
      "- Fix only scan/OCR artifacts (skew, broken ligatures, garbled characters) and reconstruct corrupted math. Do not otherwise rewrite the wording.",
      "",
      ..._EQ_BLOCK,
      "",
      "Text & structure:",
      "- Preserve emphasis (bold/italic) with \\textbf{...} / \\textit{...}. Use \\section*{...} / \\subsection*{...} for headings. Keep original numbering of sections/problems/items.",
      "- Reproduce code listings and terminal output verbatim in \\begin{verbatim}...\\end{verbatim} (or \\texttt{...} inline), exactly as printed.",
      "- Transcribe the whole document, in order. Do not summarize or drop content.",
      "",
      "Tables — IMPORTANT:",
      "- Reproduce every table as a real LaTeX table using \\begin{tabular}{...} ... \\end{tabular} (use \\hline for rules). Keep ALL rows and columns and the original-language text exactly; keep numbers/units exact. Do NOT flatten a table into a paragraph or a list.",
      "- Do NOT wrap tables in a \\begin{table} float or use \\caption — it produces wrong auto-labels like \"Table 2:\". Use \\begin{tabular} directly, centered (\\begin{center}…\\end{center}); if the table has a caption/title, write it as a plain centered line of text.",
      "- For wide tables, you may use a smaller font (\\small or \\footnotesize) so they fit the page width.",
      "",
      ..._OUTPUT_BLOCK("original-language title"),
    ].join("\n");
  }
  // 번역 모드: 전체를 한국어로. 코드 밀집 페이지에서도 산문은 반드시 번역(핵심 보강).
  return [
    "You are an expert academic translator AND LaTeX typesetter. You receive a document (a PDF, or ordered page-image slices of a scanned document) and produce a faithful KOREAN re-typeset of it as LaTeX.",
    "",
    ..._EQ_BLOCK,
    "",
    "Translation — translate EVERYTHING, every page:",
    "- Translate ALL prose into natural, fluent academic Korean (학술 문어체). Keep numbers, units, variable names, and proper nouns accurate.",
    "- CRITICAL: translate the prose even on pages that are mostly code, terminal transcripts, or excerpted from an English textbook. Explanations, narration, section headings, figure/table captions, and footnotes MUST all be translated to Korean. The ONLY things kept literal (untranslated) are: code listings, terminal/REPL output, identifiers, filenames, commands, and mathematics. NEVER leave a paragraph of natural-language prose in the original language just because it sits next to code — if you are unsure, translate it.",
    "- Do not switch to transcription mode partway through. Every chunk of this document must come back in Korean, consistently from the first page to the last.",
    "- For technical / domain-specific terms and named methods, write the Korean translation followed by the original English term in parentheses on first occurrence, e.g. 어텐션(attention), 잔차 연결(residual connection). Keep well-known acronyms (BLEU, GPU, RNN) and proper nouns as-is.",
    "- Preserve emphasis: if source text is bold or italic, reflect it with \\textbf{...} / \\textit{...}.",
    "- Preserve the document's structure: use \\section*{...} / \\subsection*{...} for headings, normal paragraphs for body. Keep the original numbering of problems/items.",
    "- Reproduce code listings and terminal output verbatim (do NOT translate code), in \\begin{verbatim}...\\end{verbatim} or \\texttt{...}.",
    "- Translate the whole document, in order. Do not summarize or drop content.",
    "",
    "Tables — IMPORTANT:",
    "- Reproduce every table as a real LaTeX table using \\begin{tabular}{...} ... \\end{tabular} (use \\hline for rules). Keep ALL rows and columns; translate header/cell text to Korean but keep numbers/units exact. Align numeric columns. Do NOT flatten a table into a paragraph or a list.",
    "- Do NOT wrap tables in a \\begin{table} float or use \\caption — it produces wrong auto-labels like \"Table 2:\". Use \\begin{tabular} directly, centered (\\begin{center}…\\end{center}); if the table has a caption/title, write it as a plain centered line of text (e.g. 표 2.2 …).",
    "- For wide tables, you may use a smaller font (\\small or \\footnotesize) so they fit the page width.",
    "",
    ..._OUTPUT_BLOCK("Korean title"),
  ].join("\n");
}

// 비전 재조판 지시문. restoreOnly(번역 없이 복원)·chartRedraw(그래프 벡터 재생성)에
// 따라 문구가 달라져 함수로 만든다. 그림 누락 방지 문구는 항상 포함(조용한 소실 금지).
// figures 가 주어지면(디지털 PDF 정밀 추출 — 수학 폰트 깨짐 문서 등) 모델 bbox JSON 을
// 요구하지 않고, 서버가 잘라둔 그림 목록에 %%FIG:n%% 마커만 넣게 한다(위치 오류·본문
// 섞임 방지 — 스캔본은 bbox 추정 외 방법이 없어 기존 JSON 방식 유지).
function buildImageInstructions({ restoreOnly = false, chartRedraw = false, figures = null } = {}) {
  const precise = Array.isArray(figures) && figures.length > 0;
  const lines = [
    "위 이미지들은 한 문서를 위에서 아래 순서로 빈틈·겹침 없이 자른 페이지 조각입니다(1번부터 정확한 순서대로 제공).",
    "전체를 하나의 문서로 보고 다음을 수행하세요:",
    restoreOnly
      ? "1) 번역하지 마세요. 원문 언어 그대로(영어는 영어로) 본문을 한 글자도 바꾸지 말고 충실히 전사하고, 수식을 정준형 LaTeX 로 복원해 재조판하세요. 문제 번호 등 원본 번호 체계를 유지하세요."
      : "1) 모든 본문을 자연스러운 한국어 학술 문어체로 번역하세요. 코드·터미널 출력·수식만 원문 그대로 두고, 코드 옆에 있는 설명·머리말·캡션·각주까지 전부 한국어로 번역하세요(코드가 많은 페이지라도 영어 문장을 그대로 남기지 마세요). 수식은 정준형 LaTeX 로 복원해 재조판하고, 문제 번호 등 원본 번호 체계를 유지하세요.",
  ];
  if (precise) {
    lines.push(
      "2) 그림 복원 — 원본 PDF에서 정확한 좌표로 잘라낸 아래 그림들을 내가 그대로 넣습니다. 그림을 말로 설명하거나 \\includegraphics 를 직접 쓰거나 그림 좌표 JSON 을 출력하지 마세요. 각 그림이 원래 나타난 자리에 `%%FIG:n%%` 한 줄만 정확히 넣으세요(한 그림당 한 번, 목록의 모든 n 에 대해 빠짐없이).",
      "   ⚠ 위치가 매우 중요합니다. 각 그림은 아래 '바로 앞 텍스트' 앵커가 가리키는 그 문항/문단 바로 다음에 넣으세요. 특히 연습문제처럼 비슷한 그래프가 여러 개면, 앵커의 문항 번호를 보고 반드시 그 번호 문항에 맞춰 넣으세요(엉뚱한 문항에 넣지 마세요).",
      "   ⚠ 그림 안에 있는 글자(축 이름 x·y, 눈금 숫자, 곡선 라벨, 화살표, 범례, 그림 속 수식)는 본문에 옮겨 적지 마세요 — 그 글자들은 내가 넣는 그림 이미지 안에 이미 있습니다. 그림 자리에는 `%%FIG:n%%` 마커만 남기고, 캡션(그림 N.N …)만 평소 규칙대로 번역해 본문에 두세요.",
      figures
        .map(
          (f) =>
            `   - FIG ${f.n}: ${f.page}번째 이미지${f.caption ? ` · 캡션 "${String(f.caption).slice(0, 60)}"` : ""}${f.anchor ? ` · 바로 앞 텍스트 "${String(f.anchor).slice(0, 70)}"` : ""}`,
        )
        .join("\n"),
      "3) 숫자 데이터 '표(table)'는 그림이 아닙니다 — 위 목록에 없는 표는 이미지가 아니라 tabular 로 직접 조판하세요(모든 행·열 유지).",
    );
  } else {
    lines.push(
      "2) 그림·도식·그래프·표 이미지·사진은 하나도 빠뜨리지 말고, 본문에서 각 그림이 와야 할 자리에 정확히 `%%FIG:n%%` 한 줄을 넣으세요(n = 1,2,3…). 그림을 말로 설명하지 말고 마커만 넣습니다. 위치가 애매해도 마커는 반드시 넣으세요.",
      "3) ```latex 블록을 닫은 뒤, 그림 목록을 ```json 블록 하나로 출력하세요(마커를 넣은 모든 n 에 대해 빠짐없이). 형식:",
      '   [{"n":1,"image":3,"box":[x0,y0,x1,y1],"kind":"photo","caption":"그림 P9.5"}]',
      "   - image: 그 그림이 보이는 페이지 이미지 번호(내가 준 순서, 1부터).",
      "   - box: 그 이미지 안에서 그림의 위치를 0~1 비율로 [좌, 상, 우, 하]. 이미지의 왼쪽 위가 (0,0), 오른쪽 아래가 (1,1). 그림(선·도형·축·사진)만 단단히 감싸되 가장자리가 잘리지 않게 살짝만 여유를 두세요. 그림 옆/아래의 본문 문단 글자는 box 에 넣지 마세요(캡션 한 줄 정도는 포함 가능). box 가 불확실하면 넉넉하게라도 반드시 넣으세요.",
      '   - kind: "photo"(사진) | "diagram"(도식·개념도) | "plot"(축이 있는 데이터 그래프) 중 하나.',
      '   - caption: 원본 그림 번호/제목(예: 그림 P9.5). 없으면 "".',
    );
    if (chartRedraw) {
      lines.push(
        '   - chart(선택): kind 가 "plot"이고 축 눈금 숫자와 데이터 값을 확실히 읽을 수 있거나, 인접한 코드/수식이 곡선을 정의할 때만 추가하세요(벡터로 다시 그려 드립니다): {"type":"line|scatter|bar","title":"...","x_label":"...","y_label":"...","x_values":[...],"series":[{"label":"...","values":[...]}]}. 곡선형 그래프는 x_values 를 20~60개 수치로 촘촘히 샘플링하세요. 수치를 추측해야 하면 chart 를 넣지 마세요(원본 크롭이 사용됩니다). chart 가 있어도 box 는 반드시 넣으세요(재생성 실패 시 크롭 폴백).',
      );
    }
    lines.push("   그림이 하나도 없으면 빈 배열 [] 을 출력하세요.");
  }
  lines.push("위 시스템 출력 형식(메타 3줄 + 본문)도 정확히 지키세요.");
  return lines.join("\n");
}

function parseLatexOutput(text) {
  // 첫 ```latex ... ``` 코드블록 추출(없으면 전체에서 json 블록만 제거)
  const m = text.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i);
  let block = (m ? m[1] : text).trim();
  const meta = { title: "", author: "", date: "" };
  const lines = block.split("\n");
  const rest = [];
  for (const line of lines) {
    // 본문에 새어 들어온 잔여 코드펜스(```latex / ```)는 제거 — 그대로 두면 PDF 에 literal 노출.
    if (/^\s*```/.test(line)) continue;
    const mt = line.match(/^\s*%\s*(TITLE|AUTHOR|DATE)\s*:\s*(.*)$/i);
    if (mt && !rest.length) {
      meta[mt[1].toLowerCase()] = mt[2].trim();
    } else {
      rest.push(line);
    }
  }
  return { ...meta, body: rest.join("\n").trim() };
}

// Claude 출력에서 그림 목록 JSON 블록을 파싱. 실패하면 빈 배열.
function parseFiguresJson(text) {
  // ```json ... ``` 우선, 없으면 본문 뒤쪽의 [ ... ] 배열 시도
  let raw = null;
  const j = text.match(/```json\s*([\s\S]*?)```/i);
  if (j) raw = j[1];
  else {
    // latex 블록 이후 마지막 대괄호 배열
    const after = text.split(/```/).pop();
    const a = after && after.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (a) raw = a[0];
  }
  if (!raw) return [];
  try {
    // 후행 콤마 같은 사소한 JSON 오류는 관용 파싱(그림이 통째로 사라지지 않게).
    const arr = JSON.parse(raw.trim().replace(/,\s*([}\]])/g, "$1"));
    if (!Array.isArray(arr)) return [];
    // 유효하지 않은 엔트리도 버리지 않는다. cropFigures가 expected/failed manifest에
    // 남겨 호출부를 실패시켜야 하며, 여기서 filter하면 잘못된 bbox가 조용히 사라진다.
    return arr.map((raw) => {
      const f = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return {
        n: parseInt(f.n, 10),
        image: parseInt(f.image, 10),
        box: Array.isArray(f.box) ? f.box.map(Number) : null,
        caption: String(f.caption || "").trim(),
        kind: String(f.kind || "").trim().toLowerCase(),
        chart:
          f.chart && typeof f.chart === "object" && !Array.isArray(f.chart)
            ? f.chart
            : null,
      };
    });
  } catch {
    return [];
  }
}

function escapeLatex(s) {
  return String(s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// 그림 캡션용 escape: 모델이 캡션에 넣은 $...$ 인라인 수식은 살리고 나머지만 escape.
// 전부 escape 하면 PDF 에 "$y=x^2$" 가 문자 그대로 보인다(실제 발생 사례).
function escapeLatexCaption(s) {
  return String(s)
    .split(/(\$[^$\n]{1,200}\$)/g)
    .map((p) => (/^\$[^$\n]+\$$/.test(p) ? p : escapeLatex(p)))
    .join("");
}

const clamp01 = (v) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

// 스캔 그래프 벡터 재생성 — chem-result 차트 렌더러 재사용(lazy require: canvas 의존을
// 통번역이 안 쓰는 프로세스에선 로드하지 않기 위함).
async function renderScanChart(spec) {
  const { renderChart } = require("../chem-result/chart-gen");
  return renderChart(spec);
}

// figures + 원본 타일 버퍼 →
// {assets:[{name,buffer}], replace:{n: latex}, meta, redrawn,
//  manifest:{expected_ids,attempted_ids,emitted_ids,failed_ids,failures,complete}}.
// sharp 로 bbox 영역을 잘라 PNG 에셋으로 만든다. chartRedraw 면 모델이 수치를 확신해
// chart 스펙을 준 그래프만 벡터로 다시 그린다(실패·미제공 시 크롭 폴백).
async function cropFigures(figures, tiles, { chartRedraw = false } = {}) {
  const assets = [];
  const replace = {};
  const meta = {};
  let redrawn = 0;
  const expectedIds = [];
  const attemptedIds = [];
  const emittedIds = [];
  const failedIds = [];
  const failures = [];
  const seenIds = new Set();
  const fail = (id, reason) => {
    failedIds.push(id);
    failures.push({ id, reason });
  };
  for (let index = 0; index < (figures || []).length; index += 1) {
    const f = figures[index];
    const validN = Number.isInteger(f && f.n) && f.n > 0;
    const id = validN ? f.n : `entry-${index + 1}`;
    expectedIds.push(id);
    attemptedIds.push(id);
    if (!validN) {
      fail(id, "invalid_figure_id");
      continue;
    }
    if (seenIds.has(id)) {
      fail(id, "duplicate_figure_id");
      continue;
    }
    seenIds.add(id);
    if (!Number.isInteger(f.image) || f.image <= 0) {
      fail(id, "invalid_source_tile_id");
      continue;
    }
    const tile = Array.isArray(tiles) ? tiles[f.image - 1] : null;
    if (!tile) {
      fail(id, "missing_source_tile");
      continue;
    }
    if (!Array.isArray(f.box) || f.box.length !== 4) {
      fail(id, "invalid_crop_box");
      continue;
    }
    const box = f.box.map(Number);
    if (box.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) {
      fail(id, "invalid_crop_box");
      continue;
    }
    let [x0, y0, x1, y1] = box;
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) {
      fail(id, "crop_box_too_small");
      continue;
    }
    let imageMeta;
    try {
      imageMeta = await sharp(tile).metadata();
    } catch (error) {
      fail(
        id,
        `invalid_source_tile:${String(error && error.message ? error.message : error).slice(0, 160)}`,
      );
      continue;
    }
    const W = imageMeta.width || 0;
    const H = imageMeta.height || 0;
    if (!W || !H) {
      fail(id, "invalid_source_tile_dimensions");
      continue;
    }
    // chart 재생성도 occurrence의 원본 tile/box가 유효한 경우에만 허용한다. 그래야
    // 재생성 실패 시 crop 폴백이 가능하고 잘못된 모델 JSON을 성공으로 위장하지 않는다.
    if (chartRedraw && f.chart) {
      try {
        const png = await renderScanChart(f.chart);
        if (png && png.length > 500) {
          const name = `fig-${f.n}.png`;
          assets.push({ name, buffer: png });
          const cap = escapeLatexCaption(f.caption);
          replace[f.n] =
            `\\begin{center}\n\\includegraphics[width=0.7\\linewidth,height=0.4\\textheight,keepaspectratio]{${name}}` +
            (cap ? `\\\\\n{\\small ${cap}}` : "") +
            `\n\\end{center}`;
          meta[f.n] = { num: figureRefNumber(f.caption) };
          redrawn += 1;
          emittedIds.push(id);
          continue;
        }
      } catch {
        /* 렌더 실패 → 아래 원본 크롭 폴백 */
      }
    }
    // 가장자리 잘림 방지용 여백(box 의 1.5%, 최대 0.03) — bbox 가 약간 빡빡해도 안전.
    const padX = Math.min(0.03, (x1 - x0) * 0.015);
    const padY = Math.min(0.03, (y1 - y0) * 0.015);
    x0 = clamp01(x0 - padX);
    y0 = clamp01(y0 - padY);
    x1 = clamp01(x1 + padX);
    y1 = clamp01(y1 + padY);
    try {
      // imageMeta로 이름을 분리한다. 예전 const meta shadow 때문에 아래 meta[f.n]이
      // 외부 배치 메타가 아니라 sharp metadata 객체에 기록되어 앵커 복원이 깨졌다.
      const left = Math.max(0, Math.round(x0 * W));
      const top = Math.max(0, Math.round(y0 * H));
      const width = Math.min(W - left, Math.round((x1 - x0) * W));
      const height = Math.min(H - top, Math.round((y1 - y0) * H));
      if (width < 8 || height < 8) {
        fail(id, "crop_pixels_too_small");
        continue;
      }
      let buf = await sharp(tile)
        .extract({ left, top, width, height })
        .toBuffer();
      // 스캔 크롭 화질 보정(고전 보정 — AI 재생성 아님): 밝은 배경(도표·그래프·문서)은
      // 배경 화이트닝(normalise)+샤픈으로 누런 스캔 색을 걷어내고, 어두운 사진은
      // 톤을 건드리지 않고 살짝만 샤픈(과보정 방지).
      try {
        const st = await sharp(buf).stats();
        const ch = st.channels.slice(0, 3);
        const mean = ch.reduce((a, c) => a + c.mean, 0) / Math.max(1, ch.length);
        buf =
          mean >= 140
            ? await sharp(buf).normalise().sharpen({ sigma: 0.8 }).png().toBuffer()
            : await sharp(buf).sharpen({ sigma: 0.5 }).png().toBuffer();
      } catch {
        buf = await sharp(buf).png().toBuffer();
      }
      const name = `fig-${f.n}.png`;
      assets.push({ name, buffer: buf });
      const cap = escapeLatexCaption(f.caption);
      replace[f.n] =
        `\\begin{center}\n\\includegraphics[width=0.7\\linewidth,height=0.4\\textheight,keepaspectratio]{${name}}` +
        (cap ? `\\\\\n{\\small ${cap}}` : "") +
        `\n\\end{center}`;
      meta[f.n] = { num: figureRefNumber(f.caption) };
      emittedIds.push(id);
    } catch (error) {
      fail(id, `crop_failed:${String(error && error.message ? error.message : error).slice(0, 160)}`);
    }
  }
  return {
    assets,
    replace,
    meta,
    redrawn,
    manifest: {
      complete:
        failedIds.length === 0 && emittedIds.length === expectedIds.length,
      expected_ids: expectedIds,
      attempted_ids: attemptedIds,
      emitted_ids: emittedIds,
      failed_ids: failedIds,
      failures,
    },
  };
}

function assertCompleteCropManifest(result) {
  const manifest = result && result.manifest;
  const hasRequiredArrays = [
    "expected_ids",
    "attempted_ids",
    "emitted_ids",
    "failed_ids",
  ].every((key) => Array.isArray(manifest && manifest[key]));
  const expected = Array.isArray(manifest && manifest.expected_ids)
    ? manifest.expected_ids.map(String)
    : [];
  const attempted = Array.isArray(manifest && manifest.attempted_ids)
    ? new Set(manifest.attempted_ids.map(String))
    : new Set();
  const emitted = Array.isArray(manifest && manifest.emitted_ids)
    ? new Set(manifest.emitted_ids.map(String))
    : new Set();
  const failed = Array.isArray(manifest && manifest.failed_ids)
    ? manifest.failed_ids.map(String)
    : [];
  const notAttempted = expected.filter((id) => !attempted.has(id));
  const unresolved = expected.filter(
    (id) => !emitted.has(id) && !failed.includes(id),
  );
  const expectedSet = new Set(expected);
  const unexpectedEmitted = [...emitted].filter((id) => !expectedSet.has(id));
  if (
    !manifest ||
    !hasRequiredArrays ||
    manifest.complete !== true ||
    failed.length ||
    notAttempted.length ||
    unresolved.length ||
    unexpectedEmitted.length ||
    emitted.size !== expected.length
  ) {
    const details = Array.isArray(manifest && manifest.failures)
      ? manifest.failures.map((f) => `${f.id}:${f.reason}`).join(", ")
      : "manifest 없음";
    const error = new Error(
      `스캔 그림 복원 불완전 — 누락 그림을 숨기지 않고 중단합니다 (${details || "원인 미상"}).`,
    );
    error.code = "PDF_FIGURE_CROP_INCOMPLETE";
    error.figureManifest = manifest
      ? {
          ...manifest,
          not_attempted_ids: notAttempted,
          unresolved_ids: unresolved,
          unexpected_emitted_ids: unexpectedEmitted,
        }
      : null;
    throw error;
  }
  return result;
}

// 본문의 %%FIG:n%% 마커를 그림(또는 빈 문자열)로 치환. 같은 n 이 여러 번 나오면
// **첫 번째만** 그림으로 치환하고 나머지는 제거한다 — 모델이 (그림을 참조하는 문장 +
// 실제 그림 자리 양쪽에) 같은 마커를 두 번 써서 같은 그림이 중복 삽입되던 것을 막는다.
function injectFigures(body, replace) {
  const used = new Set();
  return body.replace(/%%FIG:(\d+)%%/g, (_m, n) => {
    if (used.has(n)) return ""; // 이미 한 번 넣은 그림 → 중복 마커 제거
    used.add(n);
    return replace[n] || "";
  });
}

// 캡션에서 그림 번호를 뽑는다("FIGURE 2.4"→"2.4", "그림 P9.5"→"P9.5", "Fig. 3"→"3").
// 뒤에 붙은 소문자(2.4a)는 떼어 기본 번호로 — 본문 참조가 '그림 2.4'인 경우가 많다.
function figureRefNumber(caption) {
  const s = String(caption || "");
  const m = s.match(/(?:FIG(?:URE)?|그림|Figure|Fig\.?|Table|표|SCHEME|Scheme)\.?\s*([A-Z]?\.?\d+(?:\.\d+)?)/i);
  if (!m) return null;
  return m[1].replace(/[a-z]$/i, "").replace(/^\./, "");
}

// LaTeX 특수문자를 정규식용으로 이스케이프.
function _reEsc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 마커 치환 + 모델이 본문에 마커를 빠뜨린 그림 보충. 잘라낸 그림이 조용히 사라지지 않게 하되,
// 말미에 몰아 쌓지 않고 '본문의 그림 번호 참조 자리'에 넣는다(그림 판(plate)이 많은 물리
// 교재처럼 그림이 텍스트보다 많아 모델이 마커를 놓치는 경우 대비). meta[n]={num} 로 번호를 준다.
function injectFiguresWithFallback(body, replace, meta = {}) {
  const present = new Set();
  String(body).replace(/%%FIG:(\d+)%%/g, (m, n) => {
    present.add(String(parseInt(n, 10)));
    return m;
  });
  let out = injectFigures(body, replace);
  const missing = Object.keys(replace).filter(
    (n) => !present.has(String(parseInt(n, 10))),
  );
  let appended = 0;
  let anchored = 0;
  for (const n of missing) {
    const num = meta[n] && meta[n].num;
    let placed = false;
    if (num) {
      // 본문에서 '그림 2.4' / 'Figure 2.4' 참조가 있는 문단 뒤에 삽입(이미 그림이 붙지
      // 않은 첫 참조). 문단(빈 줄 구분) 단위라 문장 중간을 깨지 않는다.
      const ref = new RegExp(
        `(?:그림|Figure|Fig\\.?|FIG(?:URE)?)\\s*${_reEsc(num)}(?![0-9.])`,
        "i",
      );
      const paras = out.split(/\n{2,}/);
      for (let i = 0; i < paras.length; i++) {
        if (ref.test(paras[i]) && !paras[i].includes(replace[n])) {
          paras[i] = paras[i] + "\n\n" + replace[n];
          out = paras.join("\n\n");
          placed = true;
          anchored++;
          break;
        }
      }
    }
    if (!placed) {
      out += `\n\n${replace[n]}`;
      appended++;
    }
  }
  return { body: out, appended, anchored };
}

// 모델이 \end{...} 를 빠뜨려 환경이 안 닫힌 LaTeX 를 결정적으로 보정한다(특히 mini 가
// \begin{enumerate}... 를 닫지 않아 '\begin{...} ended by \end{document}' 로 컴파일이
// 통째 깨지는 사례 방지). 닫히지 않은 환경은 본문 끝에 역순으로 \end{...} 를 채워 넣는다.
// verbatim 류는 재조판 본문에 거의 안 나오므로 단순 스캔으로 충분하다.
function balanceLatexEnvs(body) {
  // 주석(% ...) 안의 begin/end 토큰은 세지 않도록 스캔용 사본에서 제거(오탐 방지 — 본문엔
  // % TITLE 같은 주석이 섞일 수 있다). 카운트만 사본으로 하고 \end 보충은 원본에 한다.
  const scan = body
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && line[i - 1] !== "\\") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
  const re = /\\(begin|end)\s*\{([^}]+)\}/g;
  const stack = [];
  let m;
  while ((m = re.exec(scan))) {
    if (m[1] === "begin") {
      stack.push(m[2]);
    } else {
      const idx = stack.lastIndexOf(m[2]);
      if (idx !== -1) stack.splice(idx, 1); // 매칭 begin 제거(중첩 어긋나도 best-effort)
      // 매칭 begin 이 없는 고아 \end 는 그대로 둔다(드묾).
    }
  }
  if (!stack.length) return body;
  let out = body;
  for (let i = stack.length - 1; i >= 0; i--) out += `\n\\end{${stack[i]}}`;
  return out;
}

// 텍스트 PDF 재조판용 그림 안내문. 서버가 원본에서 잘라낸 그림 목록을 주고,
// Claude 가 본문 흐름의 제자리에 %%FIG:n%% 마커만 넣게 한다(그림 자체는 서버가 주입).
function buildFigureInstr(figs) {
  if (!figs || !figs.length) return null;
  const list = figs
    .map(
      (f) =>
        `  - FIG ${f.n}: ${f.page}쪽${f.caption ? ` · 캡션 "${String(f.caption).slice(0, 60)}"` : ""}${f.anchor ? ` · 바로 앞 텍스트 "${String(f.anchor).slice(0, 70)}"` : ""}`,
    )
    .join("\n");
  return [
    "",
    "그림 복원 — 중요:",
    "이 문서에는 아래 그림/도식/그래프가 있습니다. 원본 그림을 내가 그대로 잘라 넣을 것이므로, 그림을 말로 설명하거나 \\includegraphics 를 직접 쓰지 마세요.",
    list,
    "각 그림이 원래 문서에서 나타난 자리에, 본문 흐름에 맞춰 그 위치에 `%%FIG:n%%` 한 줄을 정확히 넣으세요(n 은 위 FIG 번호). 마커는 한 그림당 한 번만.",
    "⚠ 위치가 중요합니다: 각 그림은 위 목록의 '바로 앞 텍스트' 앵커가 가리키는 문항/문단 바로 다음에 넣으세요. 연습문제처럼 비슷한 그래프가 여러 개일 때는 앵커의 문항 번호에 정확히 맞춰(엉뚱한 문항 금지) 넣으세요.",
    "⚠ 그림 안의 글자(축 이름 x·y, 눈금 숫자, 곡선 라벨, 화살표, 그림 속 수식)는 본문에 옮겨 적지 마세요 — 그림 이미지 안에 이미 있습니다. 그림의 캡션 문구만 평소처럼 한국어로 번역해 본문에 두고, %%FIG:n%% 마커는 그 자리에 남기세요.",
  ].join("\n");
}

// 서버가 잘라낸 그림 버퍼 → { assets:[{name,buffer}], replace:{n: latex} }.
// 캡션은 본문에서 Claude 가 이미 번역하므로 여기선 이미지만 넣는다(중복 방지).
function figuresToAssets(figs) {
  const assets = [];
  const replace = {};
  const meta = {};
  const seenIds = new Set();
  for (const f of figs || []) {
    if (!f || !Number.isInteger(Number(f.n)) || Number(f.n) <= 0 || !f.buffer) {
      const error = new Error("그림 occurrence에 유효한 n/buffer가 없어 재조판을 중단합니다.");
      error.code = "PDF_FIGURE_ASSET_INCOMPLETE";
      throw error;
    }
    const id = Number(f.n);
    if (seenIds.has(id)) {
      const error = new Error(`중복 그림 occurrence ID(${id})를 감지해 재조판을 중단합니다.`);
      error.code = "PDF_FIGURE_ASSET_INCOMPLETE";
      throw error;
    }
    seenIds.add(id);
    // 픽셀이 같아도 서로 다른 페이지/위치의 정상 occurrence일 수 있다. 각 n마다 고유
    // asset을 만들어 배치 의미를 보존한다(파일 hash는 occurrence 식별자가 아니다).
    const name = `fig-${id}.png`;
    assets.push({ name, buffer: f.buffer });
    replace[f.n] =
      `\\begin{center}\n\\includegraphics[width=0.78\\linewidth,height=0.42\\textheight,keepaspectratio]{${name}}\n\\end{center}`;
    meta[f.n] = { num: figureRefNumber(f.caption) };
  }
  return { assets, replace, meta };
}

// 중복 %%FIG:n%% 마커는 injectFigures가 occurrence ID 단위로 이미 제거한다. 최종 LaTeX에서
// filename만 보고 지우면 같은 픽셀이 합법적으로 여러 위치에 나온 경우 두 번째 occurrence가
// 사라진다. provenance가 없는 이 단계에서는 본문을 변경하지 않는다.
function dedupFigureImages(body) {
  return String(body);
}

// Tectonic 로그에서 'Undefined control sequence' 로 보고된 매크로 이름을 뽑는다(보수적:
// 각 에러 컨텍스트 창의 마지막 \토큰 = 문제 매크로). 정의 안 된 매크로만 대상이므로 제거해도
// 내용 손실이 없다(어차피 렌더 안 됨).
function extractUndefinedMacros(log) {
  const out = new Set();
  const lines = String(log || "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/Undefined control sequence/.test(lines[i])) continue;
    // 다음 몇 줄(컨텍스트: <recently read> ... 및 'l.N ...' 소스 줄)에서 마지막 \토큰을
    // 문제 매크로로 본다. 'l.N' 줄의 마지막 \매크로가 가장 신뢰도 높다(에러 지점 토큰).
    let last = null;
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      const m = lines[j].match(/\\[a-zA-Z@]+/g);
      if (m && m.length) last = m[m.length - 1];
      if (/^\s*l\.\d/.test(lines[j]) && last) break;
    }
    if (last) out.add(last.slice(1));
  }
  return [...out];
}

// 미정의 매크로를 본문에서 제거(인자 {..} 는 그대로 두어 텍스트는 보존). 모델 왕복 없이
// 컴파일 오류의 흔한 원인을 결정적으로 잡는다. 컴파일 성공 시에만 채택되므로(호출부 루프)
// 잘못 잡아도 다음 단계의 모델 수리가 백업한다.
function repairUndefinedMacros(body, log) {
  const names = extractUndefinedMacros(log);
  if (!names.length) return body;
  let out = body;
  for (const n of names) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("\\\\" + esc + "(?![a-zA-Z@])\\s*", "g"), "");
  }
  return out;
}

/**
 * PDF(또는 스캔본 타일) → 재조판 한국어 PDF(Buffer).
 * @param {Buffer[]} [tiles] 스캔본 원본 PNG 타일 버퍼(imageBlocks 와 같은 순서) — 그림 복원용.
 * @returns {Promise<{buffer:Buffer, cost:Object, model:string, figures:number}>}
 */
async function retypesetPdf({
  pdfBuffer,
  pdfChunks = null,
  imageBlocks = null,
  tiles = null,
  figures = null,
  twoColumn = false,
  pageNumbers = true,
  ocrHint = null, // strict provider OCR canonical pages를 축약한 참고 힌트 — 판독 기준은 항상 이미지
  ocrEvidence = null,
  ocrRenderManifest = null,
  ocrSourcePdf = pdfBuffer,
  ocrEvidencePageIndices = null,
  restoreOnly = false, // true = 번역 없이 원문 그대로 재조판(스캔 복원 모드)
  chartRedraw = false, // true = 수치가 확실한 그래프를 chart-gen 으로 벡터 재생성
  model = null,
  renderer = "tectonic",
  cpuGate = null, // (fn)=>Promise 형태의 CPU 세마포어 — Tectonic 컴파일을 1CPU 환경에서 직렬화
  onProgress = () => {},
  signal,
}) {
  const useImages = Array.isArray(imageBlocks) && imageBlocks.length > 0;
  const ocrBinding = bindRetypesetOcrEvidence({
    pdfBuffer,
    ocrSourcePdf,
    useImages,
    imageBlocks,
    rawTileBuffers: tiles,
    expectedPageIndices: ocrEvidencePageIndices,
    ocrEvidence,
    ocrRenderManifest,
  });
  const useChunks =
    !useImages && Array.isArray(pdfChunks) && pdfChunks.length > 1;
  // 텍스트 PDF 재조판에서 원본 그림을 복원할지(서버가 잘라낸 그림이 있을 때).
  const useFigures = !useImages && Array.isArray(figures) && figures.length > 0;
  if (!useImages && !useChunks && pdfBuffer.length > MAX_PDF_BYTES) {
    throw new Error("PDF 가 너무 큽니다(25MB 초과).");
  }
  // 재조판은 Claude(Anthropic)·GPT(OpenAI) 모두 네이티브로 지원한다.
  //  - Claude: document/image 블록(Anthropic SDK).
  //  - GPT: OpenAI chat/completions 의 file(file_data)·image_url 블록으로 변환해 호출.
  const MODEL = model || DEFAULT_MODEL;
  const useGpt = isGptModel(MODEL);
  if (useGpt) {
    if (!process.env.GPT_API_KEY && !process.env.OPENAI_API_KEY) {
      throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const client = useGpt
    ? null
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ });
  onProgress(`🤖 재조판 번역 모델: ${MODEL}`);

  // 2단 원문이면 읽기 순서를 명확히 지시(좌단 전체 → 우단). Claude 가 좌우를
  // 번갈아 읽어 문장이 섞이는 것을 방지한다.
  const COL_INSTR = twoColumn
    ? "\n이 문서는 2단(two-column) 레이아웃입니다. 각 페이지에서 왼쪽 단을 위에서 아래까지 모두 읽은 다음 오른쪽 단으로 넘어가세요. 좌우 단을 번갈아 읽지 마세요. 출력도 2단으로 조판되므로 칸 폭이 좁습니다 — 긴 수식은 \\begin{align}…\\end{align} 등으로 여러 줄로 나눠 칸을 넘치지 않게 하세요."
    : "";
  const TEXT_INSTR =
    (restoreOnly
      ? "이 PDF 문서를 번역하지 말고 원문 언어 그대로 충실히 전사하되, 수식을 정준형으로 복원해 LaTeX 본문으로 재조판하세요. 위 출력 형식을 정확히 지키세요."
      : "이 PDF 문서를 한국어로 충실히 번역하고, 수식을 정준형으로 복원해 LaTeX 본문으로 재조판하세요. 위 출력 형식을 정확히 지키세요.") +
    COL_INSTR;
  const docBlock = (buf) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: buf.toString("base64"),
    },
  });

  const usageSum = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const translationRequestIds = [];
  const rememberRequestId = (value) => {
    const id = String(value || "").trim();
    if (!id) throw new Error("재조판 모델 응답에 request ID가 없습니다.");
    translationRequestIds.push(id);
  };
  const addUsage = (u) => {
    if (!u) return;
    usageSum.input_tokens += u.input_tokens || 0;
    usageSum.output_tokens += u.output_tokens || 0;
    usageSum.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageSum.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };
  // Anthropic content 블록 → OpenAI chat/completions content 파트로 변환.
  //  document(base64 pdf) → file(file_data), image(base64) → image_url, text → text.
  const toOpenAiContent = (blocks) =>
    (blocks || []).map((b) => {
      if (b.type === "text") return { type: "text", text: b.text };
      if (b.type === "document" && b.source && b.source.type === "base64") {
        return {
          type: "file",
          file: {
            filename: "doc.pdf",
            file_data: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        };
      }
      if (b.type === "image" && b.source && b.source.type === "base64") {
        return {
          type: "image_url",
          image_url: {
            url: `data:${b.source.media_type};base64,${b.source.data}`,
          },
        };
      }
      return { type: "text", text: "" };
    });

  // 모드(번역/복원)에 맞는 시스템 프롬프트를 한 번 만든다 — 유저 지시와 항상 일치.
  const systemPrompt = buildSystemPrompt({ restoreOnly });

  // 한 입력(userContent) → 모델 → { text, usage, truncated }. 제공자별 분기.
  const callModelOnce = async (userContent) => {
    if (useGpt) {
      const baseUrl = process.env.GPT_API_BASE || "https://api.openai.com/v1";
      const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: toOpenAiContent(userContent) },
          ],
          max_completion_tokens: MAX_TOKENS,
        }),
        signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        const err = new Error(`OpenAI ${resp.status}: ${t.slice(0, 200)}`);
        err.status = resp.status;
        const ra = Number(resp.headers.get("retry-after"));
        if (ra > 0) err.retryAfterMs = ra * 1000;
        throw err;
      }
      const raw = await resp.text();
      let j;
      try {
        j = JSON.parse(raw);
      } catch {
        throw new Error(
          `OpenAI 응답을 해석할 수 없습니다(status ${resp.status}, ${raw.length}바이트)${raw ? ": " + raw.slice(0, 160) : " — 빈 응답"}`,
        );
      }
      const u = j.usage || {};
      const cached = u.prompt_tokens_details?.cached_tokens || 0;
      addUsage({
        input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
        output_tokens: u.completion_tokens || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      });
      const choice = (j.choices && j.choices[0]) || {};
      rememberRequestId(j.id);
      return {
        truncated: choice.finish_reason === "length",
        text: (choice.message && choice.message.content) || "",
      };
    }
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
        ...(/fable/i.test(MODEL || "") ? {} : { thinking: { type: "disabled" } }),
        system: [
          { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userContent }],
      },
      signal ? { signal } : undefined,
    );
    addUsage(message.usage);
    rememberRequestId(message.id);
    return {
      truncated: message.stop_reason === "max_tokens",
      text: (message.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    };
  };

  // 레이트리밋(429/overloaded/529) 시 지수 백오프 + Retry-After 존중으로 재시도.
  // 구간 동시성을 올리면 429 가 늘 수 있으므로(폴백=원문 미번역 페이지로 조용한 품질 저하)
  // 즉시 재시도 대신 물러섰다가 다시 친다. 동시 다발 백오프 충돌 방지용 jitter 포함.
  const RL_RETRIES = Math.max(
    0,
    parseInt(process.env.PDF_RETYPESET_RATELIMIT_RETRIES || "4", 10),
  );
  const callModel = async (userContent) => {
    let delay = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        return await callModelOnce(userContent);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        const status = e && (e.status || e.statusCode);
        const msg = String((e && e.message) || "");
        const isRl =
          status === 429 ||
          status === 529 ||
          /\b429\b|\b529\b|rate.?limit|overloaded/i.test(msg);
        if (!isRl || attempt >= RL_RETRIES) throw e;
        const wait =
          (e && e.retryAfterMs) ||
          Math.min(delay, 30000) + Math.floor(Math.random() * 500);
        delay *= 2;
        onProgress(
          `⏳ 레이트리밋 — ${Math.round(wait / 1000)}초 후 재시도 (${attempt + 1}/${RL_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };

  let body = "";
  let title = "";
  let author = "";
  let date = "";
  let assets = [];
  let figureCount = 0;

  if (useChunks) {
    // 페이지 구간을 동시에 번역한 뒤 본문을 순서대로 이어붙인다(Opus 품질 유지, 속도↑).
    onProgress(`⚡ ${pdfChunks.length}개 구간으로 나눠 병렬 번역 중...`);
    // 재조판 구간은 묶음당 Opus 32k 토큰까지라, in-place(10)보다 낮은 6을 상한으로
    // 둔다(동시 출력 토큰 폭주 = 레이트리밋 방지). 효율 상한: 실제로는 아래
    // Math.min(CONC, 구간수)만 띄워 작은 문서는 더 적게 돈다.
    const CONC = Math.max(
      1,
      parseInt(process.env.PDF_RETYPESET_CONCURRENCY || "6", 10),
    );
    const parts = new Array(pdfChunks.length).fill(null);
    let idx = 0;
    let done = 0;
    const worker = async () => {
      for (;;) {
        if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
        const i = idx++;
        if (i >= pdfChunks.length) return;
        const chunk = pdfChunks[i];
        // chunk 은 {buffer,start,end}(서버) 또는 raw Buffer 둘 다 허용.
        // 주의: Node Buffer 도 .buffer(ArrayBuffer)를 가지므로 isBuffer 로 먼저 구분.
        const chunkBuf = Buffer.isBuffer(chunk) ? chunk : chunk.buffer;
        // 이 구간(페이지 범위)에 속한 그림만 골라 마커를 넣게 한다.
        const cf =
          useFigures && chunk && chunk.start
            ? figures.filter((f) => f.page >= chunk.start && f.page <= chunk.end)
            : [];
        const fInstr = cf.length ? buildFigureInstr(cf) : null;
        const instr = fInstr ? `${TEXT_INSTR}\n${fInstr}` : TEXT_INSTR;
        let lastErr = null;
        for (let attempt = 0; attempt < 2 && parts[i] == null; attempt++) {
          try {
            const r = await callModel([
              docBlock(chunkBuf),
              { type: "text", text: instr },
            ]);
            // 단일 호출 경로와 동일하게 잘림(truncated)을 검사한다. 잘린 출력은
            // balanceLatexEnvs 가 \end{} 만 채울 뿐 문장 중간 절단을 복원하지 못해
            // 합쳐진 PDF 에서 이 구간 꼬리가 조용히 사라진다 → 재시도, 그래도 잘리면
            // parts[i] 를 채우지 않아 아래에서 명확히 실패시킨다(조용한 유실 금지).
            if (r.truncated) {
              lastErr = new Error(
                `구간 ${i + 1}/${pdfChunks.length}의 LaTeX 출력이 잘렸습니다`,
              );
              continue;
            }
            parts[i] = { parsed: parseLatexOutput(r.text), figs: cf };
          } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e;
          }
        }
        if (parts[i] == null) {
          throw new Error(
            `구간 ${i + 1}/${pdfChunks.length} 번역 실패: ${lastErr ? lastErr.message : "알 수 없음"}. 문서가 너무 길어 LaTeX 출력이 잘렸을 수 있습니다.`,
          );
        }
        done += 1;
        onProgress(`⚡ 병렬 번역 (${done}/${pdfChunks.length} 구간 완료)`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONC, pdfChunks.length) }, () => worker()),
    );
    const meta =
      parts.find((p) => p && p.parsed && (p.parsed.title || p.parsed.author || p.parsed.date)) ||
      parts[0] ||
      {};
    const m0 = meta.parsed || {};
    title = m0.title || "";
    author = m0.author || "";
    date = m0.date || "";
    let appendedFigs = 0;
    body = parts
      .map((p) => {
        if (!p || !p.parsed) return "";
        const { assets: fa, replace, meta } = figuresToAssets(p.figs);
        fa.forEach((a) => assets.push(a));
        const inj = injectFiguresWithFallback(p.parsed.body, replace, meta);
        appendedFigs += inj.appended;
        return inj.body;
      })
      .filter((b) => b && b.trim())
      .join("\n\n");
    figureCount = assets.length;
    if (figureCount)
      onProgress(
        `🖼️ 원본 그림 ${figureCount}개 복원해 삽입` +
          (appendedFigs ? ` (마커 누락 ${appendedFigs}개는 해당 구간 끝에 보충)` : ""),
      );
    body = injectFigures(body, {}); // 남은 마커 제거
    if (!body || body.length < 20) {
      throw new Error("재조판 본문을 받지 못했습니다.");
    }
  } else {
    // 단일 호출 — 스캔본 이미지(그림 복원 포함) 또는 작은 텍스트 PDF.
    onProgress(
      useImages
        ? `🔎 스캔본 OCR: 고해상도 페이지 이미지 ${imageBlocks.length}장을 읽는 중...`
        : "📖 문서를 읽고 한국어로 재조판(수식 복원) 중...",
    );
    const textInstr = useFigures
      ? `${TEXT_INSTR}\n${buildFigureInstr(figures)}`
      : TEXT_INSTR;
    // Strict provider OCR의 canonical page text만 참고 힌트로 첨부한다. 숨은 OCR층
    // 원문은 포함하지 않는다. 판독·번역 기준은 여전히 실제 페이지 이미지다.
    const hintBlocks =
      useImages && ocrHint
        ? [
            {
              type: "text",
              text:
                "[참고: strict OCR source evidence에서 추출한 canonical 페이지 텍스트]\n" +
                "독립 OCR의 보조 판독 결과이므로 오인식 가능성이 있습니다. " +
                "판독·번역의 기준은 반드시 위 페이지 이미지이며, 이 텍스트가 이미지와 다르면 이미지를 따르세요. " +
                "고유명사·전문용어·숫자·코드 철자 확인 보조로만 사용하세요.\n---\n" +
                ocrHint,
            },
          ]
        : [];
    // 비전 + 정밀 그림(디지털 PDF): 모델 bbox 대신 서버 크롭 그림 목록으로 지시.
    const visionFigures =
      useImages && Array.isArray(figures) && figures.length > 0;
    const userContent = useImages
      ? [
          ...imageBlocks,
          ...hintBlocks,
          {
            type: "text",
            text: buildImageInstructions({
              restoreOnly,
              chartRedraw,
              figures: visionFigures ? figures : null,
            }),
          },
        ]
      : [docBlock(pdfBuffer), { type: "text", text: textInstr }];
    const r = await callModel(userContent);
    if (r.truncated) {
      throw new Error(
        "문서가 너무 길어 LaTeX 출력이 잘렸습니다. 더 짧은 PDF로 나눠 시도하세요.",
      );
    }
    const parsed = parseLatexOutput(r.text);
    body = parsed.body;
    title = parsed.title;
    author = parsed.author;
    date = parsed.date;
    if (!body || body.length < 20) {
      throw new Error("재조판 LaTeX 본문을 받지 못했습니다.");
    }
    // 그림 복원: 정밀 그림(디지털 PDF 비전)·텍스트 PDF 는 서버가 미리 잘라낸 그림을
    // %%FIG:n%% 마커 자리에 주입하고, 스캔본은 Claude bbox 로 타일에서 자른다.
    if (visionFigures) {
      const { assets: fa, replace, meta } = figuresToAssets(figures);
      assets = fa;
      figureCount = fa.length;
      const inj = injectFiguresWithFallback(body, replace, meta);
      body = inj.body;
      if (figureCount)
        onProgress(
          `🖼️ 원본 그림 ${figureCount}개 정밀 복원해 삽입` +
            (inj.anchored ? ` (마커 누락 ${inj.anchored}개는 본문 참조 위치에 배치)` : "") +
            (inj.appended ? ` (참조 못 찾은 ${inj.appended}개는 본문 말미에 보충)` : ""),
        );
    } else if (useImages && Array.isArray(tiles) && tiles.length) {
      const scannedFigs = parseFiguresJson(r.text);
      if (scannedFigs.length) {
        const cropped = await cropFigures(scannedFigs, tiles, { chartRedraw });
        assertCompleteCropManifest(cropped);
        assets = cropped.assets;
        figureCount = assets.length;
        const inj = injectFiguresWithFallback(body, cropped.replace, cropped.meta);
        body = inj.body;
        if (figureCount)
          onProgress(
            `🖼️ 원본 그림 ${figureCount}개 복원해 삽입` +
              (inj.anchored ? ` (누락 ${inj.anchored}개는 본문 참조 위치에 배치)` : "") +
              (inj.appended ? ` (참조 못 찾은 ${inj.appended}개는 본문 말미에 보충)` : "") +
              (cropped.redrawn ? ` · 📈 그래프 ${cropped.redrawn}개 벡터 재생성` : ""),
          );
      }
    } else if (useFigures) {
      const { assets: fa, replace, meta } = figuresToAssets(figures);
      assets = fa;
      figureCount = fa.length;
      const inj = injectFiguresWithFallback(body, replace, meta);
      body = inj.body;
      if (figureCount)
        onProgress(
          `🖼️ 원본 그림 ${figureCount}개 복원해 삽입` +
            (inj.anchored ? ` (마커 누락 ${inj.anchored}개는 본문 참조 위치에 배치)` : "") +
            (inj.appended ? ` (참조 못 찾은 ${inj.appended}개는 본문 말미에 보충)` : ""),
        );
    }
    body = injectFigures(body, {}); // 남은 마커 제거(raw 노출 방지)
  }

  // 같은 그림이 본문에 두 번 이상 렌더되면 첫 번째만 남긴다(중복 삽입 최종 방어).
  body = dedupFigureImages(body);

  // 컴파일 실패(미정의 명령·math mode 누락 등) 시 에러를 모델에 주고 LaTeX 본문을
  // 고쳐 받아 재컴파일한다(최대 N회). Claude·GPT 공통. 그래도 실패하면 상위(server)에서
  // 빠른 번역으로 폴백한다.
  const repairLatex = async (badBody, errMsg) => {
    const prompt =
      "다음 LaTeX 본문이 컴파일 에러로 PDF 생성에 실패했습니다. 에러를 해결한 LaTeX 본문을 다시 주세요.\n" +
      "규칙: (1) 이미 로드된 패키지의 명령만 사용(amsmath·amssymb·graphicx·array·booktabs·multirow·enumitem). \\usepackage 는 쓰지 말고, 정의되지 않은 매크로는 표준 명령으로 바꾸거나 일반 텍스트로 풀어쓰세요. " +
      "(2) 위첨자·아래첨자·\\frac 등 수식 기호는 반드시 $...$ 또는 수식 환경 안에 두세요(Missing $ 방지). " +
      "(3) 번역·내용은 그대로 두고 조판 오류만 고치세요. (4) \\includegraphics 줄은 그대로 유지하세요. " +
      "(5) documentclass·preamble·\\begin{document} 없이 본문만, ```latex 코드블록 하나로만 출력하세요.\n\n" +
      "[컴파일 에러]\n" +
      String(errMsg || "").slice(0, 800) +
      "\n\n[LaTeX 본문]\n" +
      badBody;
    const r = await callModel([{ type: "text", text: prompt }]);
    const fixed = parseLatexOutput(r.text).body;
    if (!fixed || fixed.length < 20) throw new Error("수리 결과가 비었습니다.");
    return fixed;
  };

  onProgress("📐 LaTeX → PDF 컴파일 중...");
  const MAX_REPAIR = parseInt(process.env.PDF_RETYPESET_REPAIR_TRIES || "2", 10);
  let buffer;
  let curBody = body;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_REPAIR; attempt++) {
    // 컴파일 전 환경 균형을 결정적으로 보정(모델이 빠뜨린 \end 자동 보충).
    // Strict OCR source truth already contains any printed page numbers.  An
    // automatically generated LaTeX footer would introduce new numeric
    // invariants and break both semantic binding and deterministic postflight.
    const tex = buildTex({
      body: balanceLatexEnvs(curBody),
      title,
      author,
      date,
      twoColumn,
      pageNumbers: ocrBinding ? false : pageNumbers,
    });
    try {
      // 1CPU 환경에서 동시 구간이 많아지면 Tectonic 들이 CPU·메모리를 경합 → cpuGate 로 직렬화.
      buffer = await (cpuGate
        ? cpuGate(() => compileTex(tex, { signal, onProgress, assets }))
        : compileTex(tex, { signal, onProgress, assets }));
      break;
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
      if (attempt >= MAX_REPAIR) break;
      // 1) 결정적 보정 우선: 로그에 미정의로 보고된 매크로만 제거 → 모델 왕복 없이 재컴파일.
      const det = repairUndefinedMacros(curBody, e.texLog || e.message);
      if (det && det !== curBody) {
        onProgress("🛠 미정의 매크로 결정적 보정 후 재시도...");
        curBody = det;
        continue;
      }
      // 2) 그래도 안 되면 모델에 본문을 주고 수리받는다(비싼 왕복).
      onProgress(
        `🛠 LaTeX 컴파일 오류 — 자동 수리 후 재시도 (${attempt + 1}/${MAX_REPAIR})...`,
      );
      try {
        curBody = await repairLatex(curBody, e.message);
      } catch (re) {
        break;
      }
    }
  }
  if (!buffer) {
    console.error(
      "[retypeset] tectonic compile failed:",
      lastErr && lastErr.message,
    );
    throw new Error(
      `재조판 PDF 생성 실패: ${lastErr ? lastErr.message : "알 수 없음"}`,
    );
  }

  const rendered = await finalizeRetypesetRenderer(buffer, {
    renderer,
    signal,
    onProgress,
  });
  buffer = rendered.buffer;

  const cost = calcCost({ usage: usageSum, model: MODEL });
  if (!translationRequestIds.length) {
    throw new Error("재조판 번역 request provenance가 비어 있습니다.");
  }
  const translationRequestId = `batch-${crypto
    .createHash("sha256")
    .update(JSON.stringify(translationRequestIds), "utf8")
    .digest("hex")}`;
  onProgress(`✓ 재조판 완료 (${Math.round(buffer.length / 1024)}KB)`);
  return {
    buffer,
    cost,
    model: MODEL,
    translationProvider: useGpt ? "openai" : "anthropic",
    translationRequestId,
    figures: figureCount,
    effectiveRenderer: rendered.effectiveRenderer,
    ...(rendered.docxBuffer ? { docxBuffer: rendered.docxBuffer } : {}),
    ...(rendered.rendererMetadata
      ? { rendererMetadata: rendered.rendererMetadata }
      : {}),
    ...(ocrBinding
      ? {
          ocrEvidence: ocrBinding.evidence,
          ocrRenderManifest: ocrBinding.renderManifest,
          ocrEvidenceSubset: ocrBinding.subset,
        }
      : {}),
  };
}

module.exports = {
  retypesetPdf,
  parseLatexOutput,
  parseFiguresJson,
  cropFigures,
  injectFigures,
  balanceLatexEnvs,
  repairUndefinedMacros,
  extractUndefinedMacros,
  buildFigureInstr,
  figuresToAssets,
  dedupFigureImages,
  assertCompleteCropManifest,
  bindRetypesetOcrEvidence,
  finalizeRetypesetRenderer,
  DEFAULT_MODEL,
};
