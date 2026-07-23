// 문제집 메이커 (problem-set) — 콘텐츠 생성.
//
// 입력: 교재/학습지 문제 PDF·이미지 + 옵션(페이지당 문제 수, 교차검증, 이미지 생성).
// 출력: 3종 PDF(영어 문제지·한글 문제지·해설지)의 내용 JSON.
//
// 흐름:
//   1) EXTRACT — 소스에서 문제 전사(영어)+번역(한국어)+그림 식별+결측 자료 재구성.
//      · 단일 PDF + 사진 없음 + 여러 쪽이면 PDF 를 chunk_pages 쪽씩 잘라 **병렬 추출**
//        (pdf-translate 의 워커풀 패턴). 작은/이미지 소스는 기존 단일 호출.
//   2) (관리자 외) 문제 수 한도 검사.
//   3) SOLVE — 각 문제 풀이. 문제가 많으면 **배치 병렬 풀이**, 교차검증 ON 이면
//      각 배치를 3중 독립 풀이 후 RECONCILE. 적으면 기존 단일/교차검증 경로.
//   4) 비용 합산, 소스 PDF·후보 그림 버퍼를 content 에 첨부(번들러가 LaTeX 로 조판).

const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const { calcCost, calcImageCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
  getBatchImageOptions,
} = require("../../anthropic-media");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { isGptModel, callGptReport, gptConfigured } = require("../../model-call");
const { detectFigures, prepareChunks } = require("./figures");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(
  process.env.PROBLEMSET_MAX_TOKENS || process.env.MAX_TOKENS || "32000",
  10,
);
const SKILL_PATH = path.join(__dirname, "prompt.md");
const MAX_SOURCE_PDFS = 3;
const MAX_SOURCE_IMAGES = 12;
const MAX_FIG_CANDIDATES = 24; // 단일 추출(전체 PDF) 후보 상한
const CHUNK_FIG_CANDIDATES = 8; // 병렬 chunk 당 후보 상한(요청당 이미지 예산 방어)
const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;

// 병렬화 파라미터. 추출/풀이를 잘게 쪼개 한 wave(동시 실행)에 끝내 호출당 지연
// floor 에 가깝게 → 속도↑(퀄리티 동일, 문제별 추출·풀이는 그대로). 호출 수만 늘어남.
const CHUNK_PAGES = Math.max(
  1,
  parseInt(process.env.PROBLEMSET_CHUNK_PAGES || "3", 10) || 3,
);
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PROBLEMSET_CONCURRENCY || process.env.CONCURRENCY || "6", 10) || 6,
);
// SOLVE_BATCH = 한 번의 풀이 호출에 넣는 최대 문제 수(상한). 실제 배치 크기는
// 동시성(CONCURRENCY)에 맞춰 동적으로 줄여 한 wave 안에 끝나게 한다(아래 SOLVE).
const SOLVE_BATCH = Math.max(
  1,
  parseInt(process.env.PROBLEMSET_SOLVE_BATCH || "8", 10) || 8,
);
const SOLVE_BATCH_MIN = Math.max(
  1,
  parseInt(process.env.PROBLEMSET_SOLVE_BATCH_MIN || "2", 10) || 2,
);

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}
function isPdf(f) {
  return fileExt(f.name) === "pdf" || f.mimetype === "application/pdf";
}
function isImage(f) {
  return (
    ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExt(f.name)) ||
    String(f.mimetype || "").startsWith("image/")
  );
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 ===\n${notes}\n=== 끝 ===\n\n위 메모는 보조 맥락입니다(예: 특정 단원만, 영어 원문 유지 등). 문제 데이터를 지어내는 근거로 쓰지 마세요.`;
}

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const any = text.match(/```\s*([\s\S]*?)```/);
  if (any) return any[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return null;
}

function parsePhase(text, label) {
  const json = extractJson(text);
  if (!json) {
    throw new Error(
      `${label}: JSON 을 찾을 수 없습니다. 응답 앞부분: ${String(text).slice(0, 200)}`,
    );
  }
  try {
    return parseJsonLenient(json);
  } catch (e) {
    throw new Error(`${label}: JSON 파싱 실패 — ${e.message}`);
  }
}

// ── 비용 누적 ────────────────────────────────────────────────────────────────
const COST_NUM_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "webSearchCount",
  "inputCost",
  "outputCost",
  "cacheWriteCost",
  "cacheReadCost",
  "webSearchCost",
  "total",
];
function emptyCost(model) {
  const o = { model };
  for (const k of COST_NUM_FIELDS) o[k] = 0;
  return o;
}
function addCost(acc, c) {
  if (!c) return acc; // null(예: 실패 항목) 무시
  for (const k of COST_NUM_FIELDS) acc[k] = (acc[k] || 0) + (c[k] || 0);
  if (!acc.model && c.model) acc.model = c.model;
  return acc;
}
// calcCost 결과(또는 null) 배열을 한 번에 합산. mapLimit 결과에 바로 사용.
function mergeCosts(costs, model) {
  const acc = emptyCost(model);
  for (const c of costs || []) addCost(acc, c);
  if (!acc.model) acc.model = model;
  return acc;
}

// ── 동시 실행 제한 워커 풀 (translate.js runBatches 일반화, 입력 순서 보존) ──
async function mapLimit(items, limit, fn, { signal, onProgress = () => {}, retries = 0 } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length).fill(null);
  if (list.length === 0) return results;
  const workers = Math.max(1, Math.min(limit | 0 || 1, list.length));
  let next = 0;
  let done = 0;

  const runOne = async (i) => {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
      try {
        return await fn(list[i], i);
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt < retries) {
          attempt++;
          onProgress(`⚠ 항목 ${i + 1} 일시 실패 — 재시도 (${attempt}/${retries})`);
          continue;
        }
        onProgress(`⚠ 항목 ${i + 1} 실패 — 건너뜀: ${String(e.message).slice(0, 100)}`);
        return null;
      }
    }
  };
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
      const i = next++;
      if (i >= list.length) return;
      results[i] = await runOne(i);
      done++;
      onProgress(`  (${done}/${list.length})`);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── 제공자-인지 1회 호출(Claude 스트림 / GPT) → {text, usage, webSearchCount} ──
async function callModel(
  client,
  { system, content, model, signal, onProgress, label, usedFileApi, webSearch, maxTokens },
) {
  const cap = maxTokens || MAX_TOKENS;
  if (isGptModel(model)) {
    const gpt = await callGptReport({
      model,
      system,
      content,
      maxTokens: cap,
      signal,
      onProgress,
    });
    return { text: gpt.text, usage: gpt.usage, webSearchCount: 0 };
  }

  let webSearchCount = 0;
  let charCount = 0;
  let lastReportedChars = 0;
  const startedAt = Date.now();
  const stream = client.messages.stream(
    {
      model,
      max_tokens: cap,
      // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
      ...(/fable/i.test(model || "") ? {} : { thinking: { type: "disabled" } }),
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      ...(webSearch
        ? { tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }] }
        : {}),
      messages: [{ role: "user", content }],
    },
    (() => {
      const o = {};
      if (signal) o.signal = signal;
      if (usedFileApi) o.headers = { "anthropic-beta": FILES_BETA };
      return Object.keys(o).length ? o : undefined;
    })(),
  );

  stream.on("streamEvent", (event) => {
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "server_tool_use" && block?.name === "web_search") {
        webSearchCount++;
        onProgress(`🔍 자료 확인 웹 검색 중... (${webSearchCount}번째)`);
      } else if (block?.type === "web_search_tool_result") {
        onProgress("✓ 검색 결과 수신");
      }
    }
    if (
      event.type === "content_block_delta" &&
      event.delta?.type === "text_delta" &&
      event.delta.text
    ) {
      charCount += event.delta.text.length;
      if (charCount - lastReportedChars >= 2500) {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        onProgress(`${label || "생성"} 중... (${charCount}자, ${sec}초)`);
        lastReportedChars = charCount;
      }
    }
  });

  const finalMessage = await stream.finalMessage();
  if (finalMessage.stop_reason === "max_tokens") {
    throw new Error(
      `응답이 너무 길어 잘렸습니다(${label}). 한 번에 처리할 문제 수를 줄여 보세요.`,
    );
  }
  const text = finalMessage.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, usage: finalMessage.usage, webSearchCount };
}

// 후보 그림(검출 PNG·업로드 사진)을 vision 블록으로 변환해 content 에 덧붙인다.
async function pushCandidateImages(content, candidates, onProgress) {
  if (!candidates.length) return;
  const opts = getBatchImageOptions(candidates.length);
  content.push({
    type: "text",
    text: `=== 후보 그림 목록 (소스에서 자동으로 잘라낸 그림들) ===\n각 그림은 id(F1, F2, ... 또는 P1, P2, ... 또는 c0f1 ...)로 식별됩니다. 어떤 문제의 그림인지 판단해 figure.candidate_id 에 연결하세요.`,
  });
  let shown = 0;
  for (const c of candidates) {
    const prepared = await prepareImageForAnthropic(
      { buffer: c.buffer, name: `${c.id}.png`, mimetype: "image/png" },
      opts,
    );
    content.push({
      type: "text",
      text: `[후보 그림 ${c.id}${c.page ? ` · page ${c.page}` : ""}${c.kind ? ` · ${c.kind}` : ""}]`,
    });
    if (prepared.ok) {
      content.push(toAnthropicImageBlock(prepared));
      shown++;
    } else {
      content.push({
        type: "text",
        text: `(이 후보 그림은 표시 제외: ${prepared.reason})`,
      });
    }
  }
  if (shown) onProgress(`🖼 후보 그림 ${shown}개를 모델에 제시`);
}

const EXTRACT_INSTRUCTION = `## 지금 단계: EXTRACT

소스에서 **모든 문제**를 추출해 EXTRACT 스키마(JSON 하나)로 출력하세요.
- 각 문제의 text_en(영어 원문)·text_ko(한국어 번역)를 만들고, 수식은 LaTeX($...$)로.
- 그림 참조 문제는 후보 그림(F·P·c.. id)을 figure.candidate_id 로 연결하거나, 없으면 page+bbox 추정.
- 참조 그림/표가 소스에 없으면 표준값으로 given_data 를 재구성하고 reconstructed:true + note.
- 출력은 EXTRACT 스키마의 JSON 객체 하나뿐.`;

function extractInstructionChunk(start, end) {
  return `## 지금 단계: EXTRACT (부분 — 소스의 ${start}~${end}쪽)

위 PDF는 원본 교재의 ${start}~${end}쪽만 잘라낸 것입니다. **이 PDF 안의 문제만** 추출하세요.
- 문제 번호는 원본 표기를 그대로 쓰세요(임의로 1부터 새로 매기지 마세요).
- 맨 위 문제가 (앞 쪽에서 이어져) 문제 시작이 아닌 중간부터 보이면 그 문제에 "partial_head": true 를 넣으세요.
- 맨 아래 문제가 (다음 쪽으로 이어져) 잘려 보이면 그 문제에 "partial_tail": true 를 넣으세요. 없는 뒷부분을 지어내지 마세요.
- figure.page 를 쓸 땐 **이 PDF 기준 페이지(1부터)**로. (서버가 원본 페이지로 변환합니다.)
- 출력은 EXTRACT 스키마의 JSON 객체 하나뿐.`;
}

const SOLVE_INSTRUCTION = `## 지금 단계: SOLVE

아래 문제들을 정확히 풀어 SOLVE 스키마(JSON 하나)로 출력하세요.
- 각 문제의 풀이(식→대입→결과)와 final_answer 를 작성. 수식은 LaTeX. num 은 주어진 문제 번호 그대로.
- 그래프가 도움되면 chart, 개념 도식이 도움되면 image, 표가 필요하면 {table} 사용.
- 재구성 데이터로 푼 문제는 reconstructed:true.
- 출력은 SOLVE 스키마의 JSON 객체 하나뿐.`;

function problemBodyText(p) {
  let s = `[문제 ${p.num}]\n${p.text_en || p.text_ko || ""}`;
  if (p.given_data && Array.isArray(p.given_data.headers)) {
    const t = p.given_data;
    s += `\n주어진 데이터(${t.title || "표"}${t.note ? `; ${t.note}` : ""}):\n`;
    s += [t.headers, ...(t.rows || [])]
      .map((r) => (Array.isArray(r) ? r.join(" | ") : String(r)))
      .join("\n");
  }
  if (p.figure && p.figure.caption) s += `\n(그림: ${p.figure.caption})`;
  if (p.reconstructed) s += `\n※ 이 문제의 일부 자료는 표준값으로 재구성됨.`;
  return s;
}

function problemsForSolve(problems) {
  return problems.map(problemBodyText).join("\n\n");
}

// 배치 풀이 시 다른 배치 문제 참조("문제 3에서처럼")를 위해 전체 문제 색인(간단)을 같이 준다.
function compactIndex(allProblems) {
  return allProblems
    .map((p) => `${p.num}: ${String(p.text_en || p.text_ko || "").replace(/\s+/g, " ").slice(0, 120)}`)
    .join("\n");
}

/**
 * @param {Object} args
 * @param {Array}  args.sourceFiles   문제 소스 [{buffer,name,mimetype}] (PDF·이미지)
 * @param {number} args.perPage       문제지 한 페이지당 문제 수
 * @param {boolean} args.crossVerify  병렬 교차검증 풀이 여부
 * @param {boolean} args.allowImageGen 해설 삽화(gpt-image) 생성 허용
 * @param {number} args.maxProblems   문제 수 한도(0/falsy = 무제한; 관리자 면제는 라우트에서 0 전달)
 * @param {string} args.userNotes     보조 메모
 * @param {Function} args.onProgress  (msg)=>void
 */
async function generateReportContent({
  sourceFiles = [],
  perPage = 6,
  crossVerify = false,
  allowImageGen = false,
  maxProblems = 0,
  userNotes = "",
  date,
  onProgress = () => {},
  signal,
  model = null,
}) {
  const MODEL = model || DEFAULT_MODEL;
  const useGpt = isGptModel(MODEL);
  if (useGpt) {
    if (!gptConfigured()) {
      throw new Error("GPT_API_KEY 환경변수가 설정되지 않았습니다.");
    }
  } else if (!byok.anthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const pdfs = sourceFiles.filter(isPdf).slice(0, MAX_SOURCE_PDFS);
  const images = sourceFiles.filter(isImage).slice(0, MAX_SOURCE_IMAGES);
  if (pdfs.length === 0 && images.length === 0) {
    throw new Error("문제 소스(PDF 또는 이미지)를 한 개 이상 올리세요.");
  }

  const nPerPage = Math.max(1, Math.min(12, parseInt(perPage, 10) || 6));
  const maxProb = Math.max(0, parseInt(maxProblems, 10) || 0);
  onProgress(
    `🤖 모델: ${MODEL} | 페이지당 ${nPerPage}문제 | 교차검증 ${crossVerify ? "ON(3중)" : "OFF"}${maxProb ? ` | 한도 ${maxProb}문제` : ""}`,
  );

  const client = useGpt
    ? null
    : new Anthropic({
        apiKey: byok.anthropicKey(),
        timeout: 50 * 60 * 1000,
      });

  const skill = loadSkill();
  const baseSystem = `당신은 교재·학습지의 문제 세트를 풀이 공간이 넉넉한 문제지와 정확한 해설지로 만드는 도우미입니다.

아래 스킬 명세의 모든 규칙(환각 금지, 수식 LaTeX, 재구성 자료 표시, 단계별 출력)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========`;

  const sourcePdf = pdfs[0] ? pdfs[0].buffer : null;
  const candById = new Map(); // id -> {id,page,kind,buffer,w,h}
  const notesBlock = buildUserNotesBlock(userNotes);

  // 단일 호출용 PDF 블록 빌더(Files API 임계 초과면 업로드).
  async function pushPdf(content, f, uploadedIds, state) {
    const tooBig = f.buffer.length >= FILES_API_RAW_THRESHOLD;
    if (tooBig && !useGpt) {
      try {
        const fileId = await uploadFileToAnthropic(f.buffer, f.name, { signal });
        content.push({ type: "document", source: { type: "file", file_id: fileId } });
        uploadedIds.push(fileId);
        state.usedFileApi = true;
        onProgress(`📤 큰 PDF 업로드(Files API): ${f.name}`);
        return;
      } catch (e) {
        onProgress(`⚠ Files API 실패 → 인라인 전송: ${e.message}`);
      }
    }
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",        data: f.buffer.toString("base64"),
      },
    });
  }

  let totalCost = emptyCost(MODEL);
  let extract;

  // 병렬 가능 조건: PDF 1개 + 사진 없음 + 여러 쪽.
  const canParallel = pdfs.length === 1 && images.length === 0;
  let prepared = null;
  if (canParallel) {
    try {
      onProgress("🔎 소스 PDF 분할·그림 후보 추출 중...");
      prepared = await prepareChunks(sourcePdf, {
        signal,
        chunkPages: CHUNK_PAGES,
        maxCandidates: CHUNK_FIG_CANDIDATES,
      });
    } catch (e) {
      onProgress(`⚠ PDF 분할 실패 → 단일 추출로 진행: ${e.message}`);
      prepared = null;
    }
  }

  const goParallel = !!prepared && prepared.pageCount > CHUNK_PAGES && prepared.chunks.length > 1;

  if (goParallel) {
    // ── 병렬 EXTRACT ───────────────────────────────────────────────────────
    onProgress(`✍️ ${prepared.pageCount}쪽을 ${prepared.chunks.length}개 구간으로 나눠 병렬 추출 중...`);
    const extractChunk = async (ch) => {
      const content = [];
      const buf = ch.pdfBuffer;
      const tooBig = buf.length >= FILES_API_RAW_THRESHOLD;
      let usedFileApi = false;
      const chunkUploaded = [];
      try {
        if (tooBig && !useGpt) {
          try {
            const fileId = await uploadFileToAnthropic(buf, `chunk${ch.index}.pdf`, { signal });
            content.push({ type: "document", source: { type: "file", file_id: fileId } });
            chunkUploaded.push(fileId);
            usedFileApi = true;
          } catch {
            content.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: ch.pdfB64 },
            });
          }
        } else {
          content.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: ch.pdfB64 },
          });
        }
        content.push({
          type: "text",
          text: `↑ 이 PDF는 원본 소스의 ${ch.start}~${ch.end}쪽입니다(이 범위 문제만 추출).`,
        });
        await pushCandidateImages(content, ch.candidates, onProgress);
        if (notesBlock) content.push({ type: "text", text: notesBlock });
        content.push({ type: "text", text: extractInstructionChunk(ch.start, ch.end) });
        const r = await callModel(client, {
          system: baseSystem,
          content,
          model: MODEL,
          signal,
          onProgress,
          label: `추출 ${ch.start}-${ch.end}쪽`,
          usedFileApi,
          webSearch: false,
        });
        const cost = calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL });
        const parsed = parsePhase(r.text, `EXTRACT ${ch.index}`);
        return { index: ch.index, start: ch.start, parsed, cost, candidates: ch.candidates };
      } finally {
        if (chunkUploaded.length) {
          // 정리는 절대 본 오류를 가리지 않게(특히 abort 시 delete 요청도 취소될 수 있음).
          await Promise.allSettled(
            chunkUploaded.map((id) => deleteAnthropicFile(id).catch(() => {})),
          );
        }
      }
    };

    const results = await mapLimit(prepared.chunks, CONCURRENCY, extractChunk, {
      signal,
      onProgress,
      retries: 1,
    });

    // 후보 버퍼 맵(네임스페이스 id) — 모든 chunk 후보 + (없지만) 사진.
    for (const r of results) {
      if (!r) continue;
      for (const c of r.candidates) {
        candById.set(c.id, { id: c.id, page: c.globalPage, kind: c.kind, buffer: c.buffer, w: c.w, h: c.h });
      }
    }

    // 문제 병합: chunk 순서로, 경계 봉합(partial_head/tail) + 그림 page 전역 변환 + num 중복 제거.
    const problems = [];
    const byNum = new Map();
    let prevTailIdx = null;
    let failedChunks = 0;
    for (const r of results) {
      if (!r || !r.parsed || !Array.isArray(r.parsed.problems)) {
        failedChunks++;
        prevTailIdx = null;
        continue;
      }
      totalCost = addCost(totalCost, r.cost);
      const ps = r.parsed.problems;
      ps.forEach((p, i) => {
        // 그림 page(로컬) → 전역. candidate_id 유무와 무관하게 항상 변환한다
        // (candidate_id 가 dangling 이면 번들러가 page 크롭으로 폴백하므로 — 안 그러면
        //  chunk-로컬 page 가 전체 PDF 에 그대로 적용돼 엉뚱한 쪽이 잘린다).
        if (p.figure && Number.isFinite(p.figure.page)) {
          p.figure.page = r.start + (p.figure.page - 1);
        }
        const isHead = i === 0 && p.partial_head;
        if (isHead && prevTailIdx != null) {
          const prev = problems[prevTailIdx];
          if ((p.text_en || "").length > (prev.text_en || "").length) prev.text_en = p.text_en;
          if ((p.text_ko || "").length > (prev.text_ko || "").length) prev.text_ko = p.text_ko;
          if (!prev.figure && p.figure) prev.figure = p.figure;
          return;
        }
        const key = String(p.num);
        if (byNum.has(key)) {
          const ex = problems[byNum.get(key)];
          if ((p.text_en || "").length > (ex.text_en || "").length) Object.assign(ex, p);
          return;
        }
        byNum.set(key, problems.length);
        problems.push(p);
      });
      const last = ps[ps.length - 1];
      prevTailIdx = last && last.partial_tail ? byNum.get(String(last.num)) ?? null : null;
    }

    const firstNonEmpty = results.find((r) => r && r.parsed && r.parsed.problems?.length);
    extract = {
      title: firstNonEmpty?.parsed.title || "Problem Set",
      subject: firstNonEmpty?.parsed.subject || "general",
      source_lang: firstNonEmpty?.parsed.source_lang || "en",
      problems,
      __failedChunks: failedChunks,
    };
    onProgress(`📋 문제 ${problems.length}개 추출(병렬 ${prepared.chunks.length}구간${failedChunks ? `, ${failedChunks}구간 실패` : ""})`);
  } else {
    // ── 단일 EXTRACT (작은/이미지/여러 PDF 소스) ────────────────────────────
    if (sourcePdf) {
      try {
        onProgress("🔎 소스 PDF에서 그림 후보 추출 중...");
        const det = await detectFigures(sourcePdf, { signal, maxCandidates: MAX_FIG_CANDIDATES });
        for (const c of det.candidates) candById.set(c.id, c);
        onProgress(`🔎 그림 후보 ${det.candidates.length}개 검출 (소스 ${det.pageCount}쪽)`);
      } catch (e) {
        onProgress(`⚠ 그림 후보 검출 건너뜀: ${e.message}`);
      }
    }
    images.forEach((img, i) => {
      candById.set(`P${i + 1}`, { id: `P${i + 1}`, page: null, kind: "photo", buffer: img.buffer, w: 0, h: 0 });
    });
    // 후보 제시: 사진(사용자 업로드) 우선, 그 다음 검출 그림. 상한 적용.
    const all = Array.from(candById.values());
    const photos = all.filter((c) => c.kind === "photo");
    const figs = all.filter((c) => c.kind !== "photo");
    const shown = [...photos, ...figs].slice(0, MAX_FIG_CANDIDATES);

    const uploadedIds = [];
    const state = { usedFileApi: false };
    const exContent = [];
    for (const f of pdfs) {
      await pushPdf(exContent, f, uploadedIds, state);
      exContent.push({ type: "text", text: `↑ 위 PDF는 문제 소스("${f.name}")입니다. 여기 있는 문제만 추출하세요.` });
    }
    await pushCandidateImages(exContent, shown, onProgress);
    if (notesBlock) exContent.push({ type: "text", text: notesBlock });
    exContent.push({ type: "text", text: EXTRACT_INSTRUCTION });

    onProgress("✍️ 문제 추출·번역 중...");
    try {
      const r = await callModel(client, {
        system: baseSystem,
        content: exContent,
        model: MODEL,
        signal,
        onProgress,
        label: "문제 추출",
        usedFileApi: state.usedFileApi,
        webSearch: !useGpt,
      });
      totalCost = addCost(totalCost, calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL }));
      extract = parsePhase(r.text, "EXTRACT");
    } finally {
      if (uploadedIds.length) {
        await Promise.allSettled(
          uploadedIds.map((id) => deleteAnthropicFile(id).catch(() => {})),
        );
      }
    }
    onProgress(`📋 문제 ${(extract.problems || []).length}개 추출 완료`);
  }

  const problems = Array.isArray(extract.problems) ? extract.problems : [];
  if (problems.length === 0) {
    throw new Error("소스에서 문제를 찾지 못했습니다. 다른 파일을 시도해 보세요.");
  }
  // 안정적 인덱스 — 해설 정렬·자산 매핑에 사용.
  problems.forEach((p, i) => {
    p._idx = i;
  });

  // ── 2) 문제 수 한도 (관리자는 maxProb=0 으로 들어와 면제) ─────────────────
  if (maxProb > 0 && problems.length > maxProb) {
    throw new Error(
      `이 파일에서 문제가 ${problems.length}개 추출되어 한 번에 만들 수 있는 한도(${maxProb}개)를 초과했습니다. 파일을 나누거나 범위를 줄여 다시 시도하세요.`,
    );
  }

  // ── 3) SOLVE ────────────────────────────────────────────────────────────
  const fullIndex = compactIndex(problems);

  async function buildSolveContent(batchProblems, variantNote, withCrossRefIndex) {
    const c = [];
    let head = `다음은 풀어야 할 문제 ${batchProblems.length}개입니다.`;
    if (withCrossRefIndex) {
      head += `\n\n(참고용 전체 문제 색인 — 다른 문제를 참조할 때만 사용, 여기 있는 문제만 풀지 말 것):\n${fullIndex}\n`;
    }
    if (variantNote) head += `\n${variantNote}`;
    c.push({ type: "text", text: `${head}\n\n${problemsForSolve(batchProblems)}` });
    const withFig = batchProblems
      .filter((p) => p.figure && p.figure.candidate_id && candById.has(p.figure.candidate_id))
      .slice(0, 10);
    if (withFig.length) {
      const opts = getBatchImageOptions(withFig.length);
      for (const p of withFig) {
        const cand = candById.get(p.figure.candidate_id);
        const prep = await prepareImageForAnthropic({ buffer: cand.buffer, name: "fig.png", mimetype: "image/png" }, opts);
        c.push({ type: "text", text: `[문제 ${p.num}의 그림]` });
        if (prep.ok) c.push(toAnthropicImageBlock(prep));
      }
    }
    c.push({ type: "text", text: SOLVE_INSTRUCTION });
    return c;
  }

  function solveMaxTokens(batchProblems) {
    const chars = problemsForSolve(batchProblems).length;
    return Math.min(32000, Math.max(8000, Math.ceil(chars * 2.5)));
  }

  // 한 배치 1회 풀이 → {answers, cost}. answers 는 _idx 부여된 해설 배열.
  async function solveBatchOnce(batchProblems, variantNote, withCrossRef) {
    const content = await buildSolveContent(batchProblems, variantNote, withCrossRef);
    const r = await callModel(client, {
      system: baseSystem,
      content,
      model: MODEL,
      signal,
      onProgress,
      label: "해설 작성",
      webSearch: false,
      maxTokens: solveMaxTokens(batchProblems),
    });
    const cost = calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL });
    const parsed = parsePhase(r.text, "SOLVE");
    const answers = Array.isArray(parsed.answer_key) ? parsed.answer_key : [];
    // 위치 기준으로 batch 문제에 매핑(개수 일치 시). 불일치면 num 으로 보조 매핑.
    if (answers.length === batchProblems.length) {
      answers.forEach((a, k) => {
        a._idx = batchProblems[k]._idx;
      });
    } else {
      const byNum = new Map(batchProblems.map((p) => [String(p.num), p._idx]));
      answers.forEach((a, k) => {
        a._idx = byNum.has(String(a.num)) ? byNum.get(String(a.num)) : (batchProblems[k]?._idx ?? -1);
      });
    }
    return { answers, notes: Array.isArray(parsed.notes) ? parsed.notes : [], cost };
  }

  const reconcileVariants = [
    "독립 풀이 시도 1 — 정석대로 신중히.",
    "독립 풀이 시도 2 — 다른 접근/검산도 고려.",
    "독립 풀이 시도 3 — 단위·자릿수까지 재확인.",
  ];

  async function reconcileBatch(batchProblems, passes) {
    const recContent = [
      {
        type: "text",
        text:
          `같은 문제 묶음에 대한 ${passes.length}개의 독립 풀이입니다. 각 문제마다 비교해 가장 정확한 최종 해설로 합치고, 정답이 갈리면 uncertain:true 로 표시하세요.\n\n` +
          `=== 문제 ===\n${problemsForSolve(batchProblems)}\n\n` +
          passes.map((p, i) => `=== 풀이 세트 ${i + 1} ===\n${JSON.stringify(p.answers)}`).join("\n\n") +
          `\n\n## 지금 단계: RECONCILE\nSOLVE 스키마(answer_key)로 최종 해설 하나를 출력하세요. num 은 문제 번호 그대로.`,
      },
    ];
    const r = await callModel(client, {
      system: baseSystem,
      content: recContent,
      model: MODEL,
      signal,
      onProgress,
      label: "교차검증 종합",
      webSearch: false,
      maxTokens: solveMaxTokens(batchProblems),
    });
    const cost = calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL });
    const parsed = parsePhase(r.text, "RECONCILE");
    const answers = Array.isArray(parsed.answer_key) ? parsed.answer_key : [];
    if (answers.length === batchProblems.length) {
      answers.forEach((a, k) => {
        a._idx = batchProblems[k]._idx;
      });
    } else {
      const byNum = new Map(batchProblems.map((p) => [String(p.num), p._idx]));
      answers.forEach((a, k) => {
        a._idx = byNum.has(String(a.num)) ? byNum.get(String(a.num)) : (batchProblems[k]?._idx ?? -1);
      });
    }
    return { answers, notes: Array.isArray(parsed.notes) ? parsed.notes : [], cost };
  }

  let answerKey = [];
  const solveNotes = [];
  // 배치 크기를 동적으로 결정 — 모든 배치가 한 wave(동시 실행)에 들어가도록 잘게 쪼개
  // 병렬성을 최대화한다. cross-verify 는 배치마다 3패스를 띄우므로 동시에 돌릴 수 있는
  // 배치 수가 1/3 → 배치를 더 크게 잡아 wave 수를 줄인다. (상한 SOLVE_BATCH, 하한 MIN)
  const solveSlots = crossVerify ? Math.max(1, Math.floor(CONCURRENCY / 3)) : CONCURRENCY;
  const solveBatchSize = Math.min(
    SOLVE_BATCH,
    Math.max(SOLVE_BATCH_MIN, Math.ceil(problems.length / solveSlots)),
  );
  const batches = chunk(problems, solveBatchSize);

  if (batches.length <= 1) {
    // 한 배치 — 단일/교차검증 단일 경로(검증됨).
    if (crossVerify) {
      onProgress("🧮 병렬 교차검증: 3중 독립 풀이 중...");
      const passes = await Promise.all(
        reconcileVariants.map((v) => solveBatchOnce(problems, v, false)),
      );
      passes.forEach((p) => (totalCost = addCost(totalCost, p.cost)));
      onProgress("🔬 교차검증 결과 종합(RECONCILE) 중...");
      const rec = await reconcileBatch(problems, passes);
      totalCost = addCost(totalCost, rec.cost);
      answerKey = rec.answers;
      solveNotes.push(...rec.notes);
    } else {
      const one = await solveBatchOnce(problems, null, false);
      totalCost = addCost(totalCost, one.cost);
      answerKey = one.answers;
      solveNotes.push(...one.notes);
    }
  } else {
    // 많은 문제 — 배치 병렬.
    onProgress(`🧮 문제 ${problems.length}개를 ${batches.length}배치로 ${crossVerify ? "교차검증 " : ""}병렬 풀이 중...`);
    if (crossVerify) {
      // Phase A: 3×배치 시도(평탄화 풀) → Phase B: 배치별 RECONCILE.
      const tasks = [];
      batches.forEach((b, bi) => {
        reconcileVariants.forEach((v, ai) => tasks.push({ bi, ai, batch: b, variant: v }));
      });
      const attempts = await mapLimit(
        tasks,
        CONCURRENCY,
        (t) => solveBatchOnce(t.batch, t.variant, true),
        { signal, onProgress, retries: 1 },
      );
      const byBatch = batches.map(() => []);
      attempts.forEach((a, i) => {
        if (a) byBatch[tasks[i].bi].push(a);
      });
      attempts.forEach((a) => (totalCost = addCost(totalCost, a && a.cost)));
      onProgress("🔬 배치별 교차검증 종합 중...");
      const recs = await mapLimit(
        batches,
        CONCURRENCY,
        async (b, bi) => {
          const passes = byBatch[bi];
          if (passes.length >= 2) return reconcileBatch(b, passes);
          if (passes.length === 1) return passes[0]; // 1개만 성공 → 그대로(단일 풀이)
          return solveBatchOnce(b, null, true); // 전부 실패 → 단일 재풀이
        },
        { signal, onProgress, retries: 1 },
      );
      recs.forEach((rc, bi) => {
        if (rc) {
          totalCost = addCost(totalCost, rc.cost);
          answerKey.push(...rc.answers);
          solveNotes.push(...rc.notes);
        } else {
          solveNotes.push(`배치 ${bi + 1}(${batches[bi].length}문제) 풀이 실패 — 해설 일부 누락.`);
        }
      });
    } else {
      const batchResults = await mapLimit(
        batches,
        CONCURRENCY,
        (b) => solveBatchOnce(b, null, true),
        { signal, onProgress, retries: 1 },
      );
      batchResults.forEach((br, bi) => {
        if (br) {
          totalCost = addCost(totalCost, br.cost);
          answerKey.push(...br.answers);
          solveNotes.push(...br.notes);
        } else {
          solveNotes.push(`배치 ${bi + 1}(${batches[bi].length}문제) 풀이 실패 — 해설 일부 누락.`);
        }
      });
    }
  }

  // 해설을 문제 순서(_idx)대로 정렬.
  answerKey = answerKey
    .filter((a) => a && Number.isFinite(a._idx) && a._idx >= 0)
    .sort((a, b) => a._idx - b._idx);
  if (answerKey.length === 0) {
    throw new Error("해설을 생성하지 못했습니다. 잠시 후 다시 시도하세요.");
  }
  onProgress(`✅ 해설 ${answerKey.length}개 작성 완료`);

  // 메모리 절약: 실제로 문제에 연결된 후보 그림 버퍼만 남긴다(모델엔 chunk당 ~8개씩
  // 보여주지만 대부분 미사용). 큰 문서에서 미사용 PNG 버퍼가 쌓이는 걸 막는다.
  {
    const usedCandIds = new Set();
    for (const p of problems) {
      if (p.figure && p.figure.candidate_id) usedCandIds.add(String(p.figure.candidate_id));
    }
    for (const id of [...candById.keys()]) {
      if (!usedCandIds.has(String(id))) candById.delete(id);
    }
  }

  // ── 4) content 조립 ─────────────────────────────────────────────────────
  const reconstructedCount = problems.filter((p) => p.reconstructed).length;
  const uncertainCount = answerKey.filter((a) => a.uncertain).length;
  const notes = solveNotes.slice(0, 6);
  if (extract.__failedChunks) {
    notes.unshift(`${extract.__failedChunks}개 구간 추출이 실패해 일부 페이지 문제가 누락됐을 수 있습니다.`);
  }
  if (answerKey.length !== problems.length) {
    notes.unshift(`문제 ${problems.length}개 중 해설 ${answerKey.length}개 — 일부 문제의 해설이 누락됐을 수 있습니다.`);
  }
  if (reconstructedCount) {
    notes.unshift(`원본 그림/표가 없어 표준값으로 재구성한 자료가 ${reconstructedCount}곳 있습니다(문제지·해설지에 '재구성됨'으로 표시).`);
  }
  if (crossVerify && uncertainCount) {
    notes.unshift(`교차검증에서 정답이 갈린 문제 ${uncertainCount}개를 '재확인 필요'로 표시했습니다.`);
  }

  const content = {
    title: String(extract.title || "Problem Set").slice(0, 200),
    subject: extract.subject || "general",
    source_lang: extract.source_lang || "en",
    per_page: nPerPage,
    cross_verify: !!crossVerify,
    problems,
    answer_key: answerKey,
    notes,
    date: date || "",
    data_warnings: notes,
  };

  // 콘텐츠 구조 검증(DEF-010) - EXTRACT/SOLVE 파싱·조립 완료 지점. 문제·해설 결손 같은
  // hard 결함은 번들 조판 전에 즉시 실패시킨다. 출력이 PDF ZIP 이므로 {{EQ:}} 계열
  // 수식 마커 잔존도 이 타입에선 hard 로 판정되도록 format=zip 을 전달한다.
  require("../../output-sanitize").assertContentSchema("problem-set", content, {
    format: "zip",
    onProgress,
  });

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
  Object.defineProperty(content, "__cost", { value: totalCost, enumerable: false });
  Object.defineProperty(content, "__imageCost", { value: imageCost, enumerable: false });
  Object.defineProperty(content, "__sourcePdf", { value: sourcePdf, enumerable: false });
  Object.defineProperty(content, "__candidates", { value: candById, enumerable: false });
  Object.defineProperty(content, "__allowImageGen", { value: !!allowImageGen, enumerable: false });

  onProgress(formatCostLine(totalCost));
  return content;
}

module.exports = { generateReportContent };
