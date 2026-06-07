// PDF 통번역 오케스트레이션.
//   1) translate_pdf.py 로 번역 대상 문단 추출
//   2) Claude 로 문단을 묶음 단위 번역 (한국어)
//   3) translate_pdf.py 로 번역문을 원본 레이아웃에 삽입
// 그림·도표·벡터 그래픽은 건드리지 않으므로 그대로 보존된다.
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { calcCost } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const tool = require("./pdf-tool");

// 본문 글꼴: Pretendard(고가독성) 있으면 우선, 없으면 NanumGothic.
const FONT_DIR = path.join(__dirname, "../../fonts");
const FONT_PATH = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"))
  ? path.join(FONT_DIR, "Pretendard-Regular.ttf")
  : path.join(FONT_DIR, "NanumGothic-Regular.ttf");

// 번역 기본 모델: 문서 번역엔 Sonnet 으로 충분하고 빠르다(비용↓). 환경변수로 변경 가능.
const DEFAULT_MODEL = process.env.PDF_TRANSLATE_MODEL || "claude-sonnet-4-6";
// 페이지 상한 — 비용/시간 폭주 방지(관리자 테스트 기본 80쪽).
const MAX_PAGES = parseInt(process.env.PDF_TRANSLATE_MAX_PAGES || "80", 10);
// 한 번의 요청에 묶을 대략적 글자 수. 키울수록 API 호출(왕복) 수가 줄어 빨라진다.
// (병목은 모델 API 왕복이므로 가장 직접적인 코드레벨 속도 레버. JSON 강제 출력 +
// 누락 재시도가 있어 묶음을 키워도 안전.) env 로 더 키울 수 있다.
const BATCH_CHARS = parseInt(process.env.PDF_TRANSLATE_BATCH_CHARS || "4500", 10);
// 묶음 동시 번역 수(상한). 작은 PDF 는 min(CONCURRENCY, 묶음수)만 띄운다(아래 runBatches).
// 큰 문서일수록 동시성이 속도를 좌우 — 12 로 상향(rate limit 여유 내). env 로 조절.
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PDF_TRANSLATE_CONCURRENCY || "12", 10),
);

const SYSTEM_PROMPT = [
  "You are a professional translator specializing in academic and technical/scientific documents",
  "(lab manuals, papers, textbooks). Translate each given text segment into natural, fluent Korean (한국어).",
  "",
  "Rules:",
  "- The input may contain <sub>...</sub> and <sup>...</sup> tags marking subscripts/superscripts in formulas (e.g. H<sub>2</sub><sup>+</sup>, ψ<sub>el</sub>, σ<sub>g</sub>1s, r<sub>AB</sub>). PRESERVE these tags EXACTLY — keep them around the very same characters, do not remove, move, reorder, translate, or alter them, and do not add new ones. They are markup, not content.",
  "- Translate faithfully. Do NOT summarize, add, drop, or merge content.",
  "- Translate the segment EXACTLY as given. If a segment appears to end mid-sentence (no final period), translate ONLY the text provided — do NOT continue, complete, guess, or invent the rest of the sentence.",
  "- Always translate the natural-language (prose) parts, even when the segment also contains equations, symbols, chemical/electron configurations, or formulas. Return a segment unchanged ONLY if it is ENTIRELY symbols/numbers/formula with no translatable words (and never return English prose untranslated).",
  "- Preserve exactly: numbers, units, math/chemical formulas, variable names, equation symbols, code, URLs, citations,",
  "  and proper nouns that are conventionally left untranslated.",
  "- Use accurate Korean scientific/technical terminology.",
  "- For technical / domain-specific terms and named methods, write the Korean translation followed by the original English term in parentheses on first occurrence, e.g. 어텐션(attention), 잔차 연결(residual connection), 계층 정규화(layer normalization). Do this consistently for non-obvious terms. Keep well-known acronyms (BLEU, GPU, RNN, CNN) and proper nouns (제품·논문·사람 이름) as-is.",
  "- EXCEPTION: in short segments that are clearly a heading, section title, or table column header / cell (few words, no full sentence), do NOT add the parenthetical English gloss — give only the concise Korean so it fits the layout.",
  "- Keep the translation concise; do not pad. Avoid adding words that are not in the source.",
  "- Output literal characters directly (<, >, &, ≤, ≥, /). NEVER use HTML entities such as &gt; &lt; &amp; in the output.",
  "- Translate each id independently.",
  "- If a segment is already Korean, return it unchanged.",
  '- Output MUST be a single JSON object and nothing else: {"t": {"<id>": "<korean>", ...}} including every id given.',
].join("\n");

function buildBatches(blocks, maxChars = BATCH_CHARS) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const b of blocks) {
    cur.push(b);
    curChars += (b.text || "").length;
    if (curChars >= maxChars) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

// 모델 제공자 추상화. GPT(OpenAI) 면 chat/completions(OpenAI 호환, fetch), 그 외는
// Claude(Anthropic SDK). 반환을 {text, usage} 로 통일하고 usage 는 Anthropic 형식
// (input/output/cache_read/cache_creation)으로 맞춰 calcCost 가 그대로 쓰게 한다.
function makeCaller(model) {
  if (isGptModel(model)) {
    const base = process.env.GPT_API_BASE || "https://api.openai.com/v1";
    const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!key) {
      throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
    }
    return async ({ system, user, maxTokens, signal }) => {
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // gpt-5.x 계열은 max_completion_tokens 사용. JSON 강제로 펜스/설명 누락 방지.
          max_completion_tokens: Math.min(maxTokens, 32000),
          response_format: { type: "json_object" },
        }),
        signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 200)}`);
      }
      // 빈/비-JSON 응답이면 "Unexpected end of JSON input" 대신 분명한 메시지로.
      const rawBody = await resp.text();
      let j;
      try {
        j = JSON.parse(rawBody);
      } catch {
        throw new Error(
          `OpenAI 응답을 해석할 수 없습니다(status ${resp.status}, ${rawBody.length}바이트)${rawBody ? ": " + rawBody.slice(0, 160) : " — 빈 응답"}`,
        );
      }
      const text = j.choices?.[0]?.message?.content || "";
      const u = j.usage || {};
      const cached = u.prompt_tokens_details?.cached_tokens || 0;
      return {
        text,
        usage: {
          input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
          output_tokens: u.completion_tokens || 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0, // OpenAI 는 캐시 write 비용 없음
        },
      };
    };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return async ({ system, user, maxTokens, signal }) => {
    const message = await client.messages.create(
      {
        model,
        max_tokens: Math.min(maxTokens, 32000),
        system: [
          // 정적 시스템 프롬프트 → 5분 ephemeral 캐시로 묶음 간 입력 비용 절감.
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: user }],
      },
      signal ? { signal } : undefined,
    );
    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { text, usage: message.usage };
  };
}

async function translateBatch(caller, blocks, signal) {
  const items = blocks.map((b) => ({ id: b.id, text: b.text }));
  const user =
    "Translate the following segments to Korean. Return only the JSON object described.\n\n" +
    JSON.stringify(items, null, 0);

  // 출력이 잘리면 JSON 파싱 실패로 묶음 전체가 누락된다. 입력 길이에 맞춰 출력 한도를
  // 키운다(실제 출력 토큰만 과금되므로 비용 영향 없음).
  const inputChars = items.reduce((s, it) => s + (it.text || "").length, 0);
  const maxTokens = Math.min(32000, Math.max(8000, Math.ceil(inputChars * 2.5)));

  const { text, usage } = await caller({
    system: SYSTEM_PROMPT,
    user,
    maxTokens,
    signal,
  });

  // {"t":{id:ko}} 가 정상. 모델이 {id:ko} 를 바로 주면 그것도 받되, 배열 등 예상 외
  // 형태는 무시. 펜스/앞뒤 설명이 붙어도 JSON 범위만 추출(누락 주원인 방어).
  let map = {};
  try {
    const parsed = parseJsonLenient(extractJsonText(text));
    if (isPlainObject(parsed) && isPlainObject(parsed.t)) map = parsed.t;
    else if (isPlainObject(parsed)) map = parsed;
  } catch {
    map = {};
  }
  return { map, usage };
}

// 모델 응답에서 JSON 만 뽑는다: ```json 펜스 → 펜스 내부, 아니면 첫 '{'~마지막 '}'.
function extractJsonText(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first !== -1 && last > first) return body.slice(first, last + 1).trim();
  return body.trim();
}

/**
 * PDF 를 한국어로 통번역한다.
 * @returns {Promise<{buffer:Buffer, cost:Object, pageCount:number, scanned:boolean,
 *                    blockCount:number, missing:number, stats:{replaced:number, shrunk:number}}>}
 */
async function translatePdf({
  pdfBuffer,
  model = null,
  onProgress = () => {},
  signal,
}) {
  const MODEL = model || DEFAULT_MODEL;
  const caller = makeCaller(MODEL); // 키 누락이면 여기서 즉시 실패(GPT/Claude 자동 분기)

  const base = path.join(
    os.tmpdir(),
    `pdftr-${crypto.randomBytes(8).toString("hex")}`,
  );
  const inPath = `${base}.pdf`;
  const outPath = `${base}.ko.pdf`;
  fs.writeFileSync(inPath, pdfBuffer);

  try {
    onProgress(`🤖 번역 모델: ${MODEL}`);
    onProgress("📄 PDF 분석 중 (텍스트 추출)...");
    const { page_count, scanned, blocks, fig_regions, fitz } =
      await tool.extractBlocks(inPath, { signal });
    // 진단: 서버에서 그림 영역이 실제로 감지되는지 + PDF 엔진 버전(로컬과 동작 비교용)
    onProgress(
      `🔍 그림 영역 ${fig_regions ?? "?"}개 감지 · PDF엔진 ${fitz ?? "?"}`,
    );

    if (page_count > MAX_PAGES) {
      throw new Error(
        `페이지가 너무 많습니다 (${page_count}쪽 > 상한 ${MAX_PAGES}쪽). 파일을 나눠서 시도하세요.`,
      );
    }
    if (!blocks.length) {
      if (scanned) {
        throw new Error(
          "추출 가능한 텍스트가 없습니다. 스캔본(글자가 이미지인 PDF)으로 보입니다 — 현재 버전은 텍스트 레이어가 있는 PDF만 지원합니다(OCR 미지원).",
        );
      }
      throw new Error("번역할 텍스트를 찾지 못했습니다.");
    }
    if (scanned) {
      onProgress(
        "⚠ 텍스트가 매우 적습니다 — 일부가 스캔 이미지일 수 있어 그 부분은 번역되지 않습니다.",
      );
    }
    onProgress(`✓ ${page_count}쪽, 번역 대상 ${blocks.length}개 문단`);

    const batches = buildBatches(blocks);
    const translations = {};
    const usageSum = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };

    const mergeResult = (map, usage) => {
      for (const [k, v] of Object.entries(map || {})) {
        if (typeof v === "string" && v.trim()) translations[String(k)] = v;
      }
      if (usage) {
        usageSum.input_tokens += usage.input_tokens || 0;
        usageSum.output_tokens += usage.output_tokens || 0;
        usageSum.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
        usageSum.cache_creation_input_tokens +=
          usage.cache_creation_input_tokens || 0;
      }
    };

    // 묶음을 동시에 번역(기본 5개). 순차로 하면 페이지 많을 때 타임아웃 난다.
    const runBatches = async (batchList, label) => {
      let next = 0;
      let done = 0;
      const total = batchList.length;
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
          const i = next++;
          if (i >= total) return;
          try {
            const { map, usage } = await translateBatch(
              caller,
              batchList[i],
              signal,
            );
            mergeResult(map, usage);
          } catch (e) {
            // 중단은 전체 전파. 그 외(일시적 API 오류 등)는 이 묶음만 건너뛰고
            // 계속 — 누락 문단은 뒤의 재시도 패스가 다시 시도한다(다른 워커가
            // 계속 돌아 청구·진행이 멈추지 않게).
            if (signal?.aborted) throw e;
            onProgress(`⚠ 묶음 ${i + 1} 실패 — 누락분 재시도에서 다시 시도`);
          }
          done += 1;
          onProgress(`${label} (${done}/${total} 묶음)`);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker()),
      );
    };

    await runBatches(batches, "🌐 번역 중...");

    // 누락 문단 재시도 — 점점 작은 묶음으로 여러 번(파싱 실패가 묶음 전체를 날리지
    // 않도록), 마지막엔 문단당 1개씩. 결과물에 원문(영어)이 남지 않도록.
    let missingBlocks = blocks.filter((b) => !translations[String(b.id)]);
    // 점점 작은 묶음 → 문단당 1개로 여러 번. 큰 배치에서 모델이 일부 id 를 누락하거나
    // 일시적 API 오류로 빠지는 문단을, 끝에 per-block 으로 3회까지 다시 시도해 잡는다
    // (결과물에 영어 원문이 남지 않도록 — 미번역 문단 주원인).
    for (const size of [1500, 600, 1, 1, 1]) {
      if (!missingBlocks.length) break;
      onProgress(`🔁 누락 ${missingBlocks.length}개 문단 재번역 시도...`);
      await runBatches(buildBatches(missingBlocks, size), "🔁 재시도");
      missingBlocks = blocks.filter((b) => !translations[String(b.id)]);
    }

    if (Object.keys(translations).length === 0) {
      throw new Error(
        "번역 결과를 받지 못했습니다(모델 응답 파싱 실패). 잠시 후 다시 시도하세요.",
      );
    }

    const missing = missingBlocks.length;
    if (missing) {
      onProgress(`⚠ ${missing}개 문단은 번역 실패로 원문 유지`);
    }

    onProgress("🖋 번역문을 원본 레이아웃에 삽입 중...");
    const stats = await tool.renderTranslated(
      inPath,
      outPath,
      FONT_PATH,
      translations,
      { signal },
    );
    const buffer = fs.readFileSync(outPath);
    onProgress(
      `✓ 레이아웃 삽입 완료 (교체 ${stats.replaced}곳${stats.shrunk ? `, 자동 축소 ${stats.shrunk}곳` : ""})`,
    );

    const cost = calcCost({ usage: usageSum, model: MODEL });

    return {
      buffer,
      cost,
      pageCount: page_count,
      scanned: !!scanned,
      blockCount: blocks.length,
      missing,
      stats,
    };
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

module.exports = {
  translatePdf,
  DEFAULT_MODEL,
  MAX_PAGES,
  makeCaller,
  isGptModel,
  translateBatch,
};
