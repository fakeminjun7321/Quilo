// 재조판(re-typeset) 번역: PDF(또는 스캔본 페이지 이미지)를 Claude 에게 주고
// "한국어 LaTeX 본문"을 받아 Tectonic 으로 PDF 를 만든다. 스캔본일 때는 Claude 가
// 그림 위치(%%FIG:n%% 마커)와 bbox(JSON)를 함께 알려주면, 원본 타일에서 그 영역을
// 잘라 \includegraphics 로 다시 끼워넣는다(그림 복원형 재조판).
const Anthropic = require("@anthropic-ai/sdk");
const sharp = require("sharp");
const { calcCost } = require("../../pricing");
const { buildTex, compileTex } = require("./latex-pdf");

const DEFAULT_MODEL = process.env.PDF_RETYPESET_MODEL || "claude-opus-4-8";
// GPT(OpenAI) 선택 시 재조판이 대체할 Claude 모델(재조판은 Claude 네이티브 PDF/비전 입력에
// 맞춰 구현돼 있어 GPT 입력 형식과 호환되지 않는다).
const MAX_TOKENS = parseInt(process.env.PDF_RETYPESET_MAX_TOKENS || "32000", 10);
const MAX_PDF_BYTES = 25 * 1024 * 1024;

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

const SYSTEM_PROMPT = [
  "You are an expert academic translator AND LaTeX typesetter. You receive a document (a PDF, or ordered page-image slices of a scanned document) and produce a faithful KOREAN re-typeset of it as LaTeX.",
  "",
  "CRITICAL — equations:",
  "- The source math is often CORRUPTED or hard to read (Greek letters, primes, roots, subscripts lost or turned into junk). Do NOT copy garbled math. Reconstruct each formula into its mathematically-correct canonical form and typeset it in proper LaTeX. You know the standard form of well-known equations — restore them faithfully.",
  "- Use \\[ ... \\] for display equations and $...$ for inline math. amsmath/amssymb are available.",
  "",
  "Translation:",
  "- Translate ALL prose into natural, fluent academic Korean (학술 문어체). Keep numbers, units, variable names, and proper nouns accurate.",
  "- For technical / domain-specific terms and named methods, write the Korean translation followed by the original English term in parentheses on first occurrence, e.g. 어텐션(attention), 잔차 연결(residual connection). Keep well-known acronyms (BLEU, GPU, RNN) and proper nouns as-is.",
  "- Preserve emphasis: if source text is bold or italic, reflect it with \\textbf{...} / \\textit{...}.",
  "- Preserve the document's structure: use \\section*{...} / \\subsection*{...} for headings, normal paragraphs for body. Keep the original numbering of problems/items.",
  "- Translate the whole document, in order. Do not summarize or drop content.",
  "",
  "Tables — IMPORTANT:",
  "- Reproduce every table as a real LaTeX table using \\begin{tabular}{...} ... \\end{tabular} (use \\hline for rules). Keep ALL rows and columns; translate header/cell text to Korean but keep numbers/units exact. Align numeric columns. Do NOT flatten a table into a paragraph or a list.",
  "- For wide tables, you may use a smaller font (\\small or \\footnotesize) so they fit the page width.",
  "",
  "Output format — IMPORTANT:",
  "- Output ONE ```latex code block (the document BODY).",
  "- The FIRST three lines of that block must be metadata comments:",
  "    % TITLE: <Korean title>",
  "    % AUTHOR: <author, may be empty>",
  "    % DATE: <date, may be empty>",
  "- After those, output ONLY the LaTeX BODY (what goes inside \\begin{document}…\\end{document}). Do NOT include \\documentclass, \\usepackage, the preamble, \\begin{document}, \\end{document}, \\title, \\author, \\date, or \\maketitle — those are added automatically.",
  "- Use only packages already loaded: amsmath, amssymb, graphicx. Do not \\usepackage anything.",
  "- Figures: follow the figure instructions in the user message exactly (use %%FIG:n%% markers + a JSON list). Do NOT invent \\includegraphics yourself.",
].join("\n");

const IMAGE_INSTRUCTIONS = [
  "위 이미지들은 한 문서를 위에서 아래 순서로 자른 페이지 조각입니다(1번부터 순서대로 제공; 경계가 약간 겹칠 수 있으니 중복된 문장은 한 번만 쓰세요).",
  "전체를 하나의 문서로 보고 다음을 수행하세요:",
  "1) 모든 본문을 자연스러운 한국어 학술 문어체로 번역하고, 수식을 정준형 LaTeX 로 복원해 재조판하세요. 문제 번호 등 원본 번호 체계를 유지하세요.",
  "2) 그림·도식·그래프·표 이미지가 있으면, 본문에서 그 그림이 와야 할 자리에 정확히 `%%FIG:n%%` 한 줄을 넣으세요(n = 1,2,3…). 그림을 말로 설명하지 말고 마커만 넣습니다.",
  "3) ```latex 블록을 닫은 뒤, 그림 목록을 ```json 블록 하나로 출력하세요. 형식:",
  '   [{"n":1,"image":3,"box":[x0,y0,x1,y1],"caption":"그림 P9.5"}]',
  "   - image: 그 그림이 보이는 페이지 이미지 번호(내가 준 순서, 1부터).",
  "   - box: 그 이미지 안에서 그림의 위치를 0~1 비율로 [좌, 상, 우, 하]. 이미지의 왼쪽 위가 (0,0), 오른쪽 아래가 (1,1). 그림(선·도형·축·사진)만 단단히 감싸되 가장자리가 잘리지 않게 살짝만 여유를 두세요. 그림 옆/아래의 본문 문단 글자는 box 에 넣지 마세요(캡션 한 줄 정도는 포함 가능).",
  "   - caption: 원본 그림 번호/제목(예: 그림 P9.5). 없으면 \"\".",
  "   그림이 하나도 없으면 빈 배열 [] 을 출력하세요.",
  "위 시스템 출력 형식(메타 3줄 + 본문)도 정확히 지키세요.",
].join("\n");

function parseLatexOutput(text) {
  // 첫 ```latex ... ``` 코드블록 추출(없으면 전체에서 json 블록만 제거)
  const m = text.match(/```(?:latex|tex)?\s*([\s\S]*?)```/i);
  let block = (m ? m[1] : text).trim();
  const meta = { title: "", author: "", date: "" };
  const lines = block.split("\n");
  const rest = [];
  for (const line of lines) {
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
    const arr = JSON.parse(raw.trim());
    if (!Array.isArray(arr)) return [];
    return arr
      .map((f) => ({
        n: parseInt(f.n, 10),
        image: parseInt(f.image, 10),
        box: Array.isArray(f.box) ? f.box.map(Number) : null,
        caption: String(f.caption || "").trim(),
      }))
      .filter(
        (f) =>
          Number.isFinite(f.n) &&
          Number.isFinite(f.image) &&
          f.box &&
          f.box.length === 4 &&
          f.box.every((v) => Number.isFinite(v)),
      );
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

const clamp01 = (v) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;
};

// figures + 원본 타일 버퍼 → {assets:[{name,buffer}], replace:{n: latex}}.
// sharp 로 bbox 영역을 잘라 PNG 에셋으로 만든다.
async function cropFigures(figures, tiles) {
  const assets = [];
  const replace = {};
  for (const f of figures) {
    const tile = tiles[f.image - 1];
    if (!tile) continue;
    const box = f.box.map(clamp01);
    if (box.some((v) => v === null)) continue;
    let [x0, y0, x1, y1] = box;
    if (x1 - x0 < 0.02 || y1 - y0 < 0.02) continue; // 너무 작음
    // 가장자리 잘림 방지용 여백(box 의 1.5%, 최대 0.03) — bbox 가 약간 빡빡해도 안전.
    const padX = Math.min(0.03, (x1 - x0) * 0.015);
    const padY = Math.min(0.03, (y1 - y0) * 0.015);
    x0 = clamp01(x0 - padX);
    y0 = clamp01(y0 - padY);
    x1 = clamp01(x1 + padX);
    y1 = clamp01(y1 + padY);
    try {
      const meta = await sharp(tile).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      if (!W || !H) continue;
      const left = Math.max(0, Math.round(x0 * W));
      const top = Math.max(0, Math.round(y0 * H));
      const width = Math.min(W - left, Math.round((x1 - x0) * W));
      const height = Math.min(H - top, Math.round((y1 - y0) * H));
      if (width < 8 || height < 8) continue;
      const buf = await sharp(tile)
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      const name = `fig-${f.n}.png`;
      assets.push({ name, buffer: buf });
      const cap = escapeLatex(f.caption);
      replace[f.n] =
        `\\begin{center}\n\\includegraphics[width=0.7\\linewidth,height=0.4\\textheight,keepaspectratio]{${name}}` +
        (cap ? `\\\\\n{\\small ${cap}}` : "") +
        `\n\\end{center}`;
    } catch {
      /* 이 그림만 건너뜀 */
    }
  }
  return { assets, replace };
}

// 본문의 %%FIG:n%% 마커를 그림(또는 빈 문자열)로 치환.
function injectFigures(body, replace) {
  return body.replace(/%%FIG:(\d+)%%/g, (_m, n) => replace[n] || "");
}

// 텍스트 PDF 재조판용 그림 안내문. 서버가 원본에서 잘라낸 그림 목록을 주고,
// Claude 가 본문 흐름의 제자리에 %%FIG:n%% 마커만 넣게 한다(그림 자체는 서버가 주입).
function buildFigureInstr(figs) {
  if (!figs || !figs.length) return null;
  const list = figs
    .map(
      (f) =>
        `  - FIG ${f.n}: ${f.page}쪽${f.caption ? ` · 캡션 "${String(f.caption).slice(0, 80)}"` : ""}`,
    )
    .join("\n");
  return [
    "",
    "그림 복원 — 중요:",
    "이 문서에는 아래 그림/도식/그래프가 있습니다. 원본 그림을 내가 그대로 잘라 넣을 것이므로, 그림을 말로 설명하거나 \\includegraphics 를 직접 쓰지 마세요.",
    list,
    "각 그림이 원래 문서에서 나타난 자리(보통 해당 캡션 근처)에, 본문 흐름에 맞춰 그 위치에 `%%FIG:n%%` 한 줄을 정확히 넣으세요(n 은 위 FIG 번호). 그림의 캡션 문구는 평소처럼 한국어로 번역해 본문에 두되, %%FIG:n%% 마커는 반드시 그 자리에 남기세요. 마커는 한 그림당 한 번만.",
  ].join("\n");
}

// 서버가 잘라낸 그림 버퍼 → { assets:[{name,buffer}], replace:{n: latex} }.
// 캡션은 본문에서 Claude 가 이미 번역하므로 여기선 이미지만 넣는다(중복 방지).
function figuresToAssets(figs) {
  const assets = [];
  const replace = {};
  for (const f of figs || []) {
    if (!f || !f.buffer) continue;
    const name = `fig-${f.n}.png`;
    assets.push({ name, buffer: f.buffer });
    replace[f.n] =
      `\\begin{center}\n\\includegraphics[width=0.78\\linewidth,height=0.42\\textheight,keepaspectratio]{${name}}\n\\end{center}`;
  }
  return { assets, replace };
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
  model = null,
  onProgress = () => {},
  signal,
}) {
  const useImages = Array.isArray(imageBlocks) && imageBlocks.length > 0;
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
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  onProgress(`🤖 재조판 번역 모델: ${MODEL}`);

  // 2단 원문이면 읽기 순서를 명확히 지시(좌단 전체 → 우단). Claude 가 좌우를
  // 번갈아 읽어 문장이 섞이는 것을 방지한다.
  const COL_INSTR = twoColumn
    ? "\n이 문서는 2단(two-column) 레이아웃입니다. 각 페이지에서 왼쪽 단을 위에서 아래까지 모두 읽은 다음 오른쪽 단으로 넘어가세요. 좌우 단을 번갈아 읽지 마세요. 출력도 2단으로 조판되므로 칸 폭이 좁습니다 — 긴 수식은 \\begin{align}…\\end{align} 등으로 여러 줄로 나눠 칸을 넘치지 않게 하세요."
    : "";
  const TEXT_INSTR =
    "이 PDF 문서를 한국어로 충실히 번역하고, 수식을 정준형으로 복원해 LaTeX 본문으로 재조판하세요. 위 출력 형식을 정확히 지키세요." +
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

  // 한 입력(userContent) → 모델 → { text, usage, truncated }. 제공자별 분기.
  const callModel = async (userContent) => {
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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: toOpenAiContent(userContent) },
          ],
          max_completion_tokens: MAX_TOKENS,
        }),
        signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 200)}`);
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
      return {
        truncated: choice.finish_reason === "length",
        text: (choice.message && choice.message.content) || "",
      };
    }
    const message = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userContent }],
      },
      signal ? { signal } : undefined,
    );
    addUsage(message.usage);
    return {
      truncated: message.stop_reason === "max_tokens",
      text: (message.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    };
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
            parts[i] = { parsed: parseLatexOutput(r.text), figs: cf };
          } catch (e) {
            if (signal?.aborted) throw e;
            lastErr = e;
          }
        }
        if (parts[i] == null) {
          throw new Error(
            `구간 ${i + 1}/${pdfChunks.length} 번역 실패: ${lastErr ? lastErr.message : "알 수 없음"}`,
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
    body = parts
      .map((p) => {
        if (!p || !p.parsed) return "";
        const { assets: fa, replace } = figuresToAssets(p.figs);
        fa.forEach((a) => assets.push(a));
        return injectFigures(p.parsed.body, replace);
      })
      .filter((b) => b && b.trim())
      .join("\n\n");
    figureCount = assets.length;
    if (figureCount) onProgress(`🖼️ 원본 그림 ${figureCount}개 복원해 삽입`);
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
    const userContent = useImages
      ? [...imageBlocks, { type: "text", text: IMAGE_INSTRUCTIONS }]
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
    // 그림 복원: 스캔본은 Claude bbox 로 타일에서 자르고, 텍스트 PDF 는 서버가
    // 미리 잘라낸 그림을 %%FIG:n%% 마커 자리에 주입한다.
    if (useImages && Array.isArray(tiles) && tiles.length) {
      const scannedFigs = parseFiguresJson(r.text);
      if (scannedFigs.length) {
        const cropped = await cropFigures(scannedFigs, tiles);
        assets = cropped.assets;
        figureCount = assets.length;
        body = injectFigures(body, cropped.replace);
        if (figureCount) onProgress(`🖼️ 원본 그림 ${figureCount}개 복원해 삽입`);
      }
    } else if (useFigures) {
      const { assets: fa, replace } = figuresToAssets(figures);
      assets = fa;
      figureCount = fa.length;
      body = injectFigures(body, replace);
      if (figureCount) onProgress(`🖼️ 원본 그림 ${figureCount}개 복원해 삽입`);
    }
    body = injectFigures(body, {}); // 남은 마커 제거(raw 노출 방지)
  }

  // 컴파일 실패(미정의 명령·math mode 누락 등) 시 에러를 모델에 주고 LaTeX 본문을
  // 고쳐 받아 재컴파일한다(최대 N회). Claude·GPT 공통. 그래도 실패하면 상위(server)에서
  // 빠른 번역으로 폴백한다.
  const repairLatex = async (badBody, errMsg) => {
    const prompt =
      "다음 LaTeX 본문이 컴파일 에러로 PDF 생성에 실패했습니다. 에러를 해결한 LaTeX 본문을 다시 주세요.\n" +
      "규칙: (1) 표준 패키지/명령만 사용(amsmath·amssymb·graphicx 등). 정의되지 않은 매크로는 표준 명령으로 바꾸거나 일반 텍스트로 풀어쓰세요. " +
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
    const tex = buildTex({ body: curBody, title, author, date, twoColumn });
    try {
      buffer = await compileTex(tex, { signal, onProgress, assets });
      break;
    } catch (e) {
      lastErr = e;
      if (signal && signal.aborted) throw e;
      if (attempt >= MAX_REPAIR) break;
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

  const cost = calcCost({ usage: usageSum, model: MODEL });
  onProgress(`✓ 재조판 완료 (${Math.round(buffer.length / 1024)}KB)`);
  return { buffer, cost, model: MODEL, figures: figureCount };
}

module.exports = {
  retypesetPdf,
  parseLatexOutput,
  parseFiguresJson,
  cropFigures,
  injectFigures,
  buildFigureInstr,
  figuresToAssets,
  DEFAULT_MODEL,
};
