// 국어(문학) 내신·모의고사 생성 (korean-lit-exam) — 콘텐츠 생성.
//
// 입력: 학습지(판서·필기 포함) PDF/이미지(field "source", 여러 개) + (선택) 문제은행 PDF
//   (field "bank", 여러 개) + (선택) userNotes.
// 출력: 시험지·답안 작성지·정답해설지 3종 PDF 의 내용 JSON(works[] + questions[]).
//
// 흐름:
//   1) 학습지/문제은행 PDF·이미지를 Anthropic 형식 content 블록으로 구성
//      (큰 PDF 는 Files API 업로드, 작은 PDF·이미지는 인라인; GPT 는 항상 인라인).
//   2) prompt.md 시스템 프롬프트로 모델 1회 호출(Claude 스트림 / GPT) → JSON 하나.
//   3) lenient parse + 스키마 검증(works/questions). work_id 정합성 보정.
//   4) content 조립(번들러가 LaTeX 로 조판).
//
// problem-set 파이프라인의 관용(LLM 호출·lenient JSON 파싱·GPT 분기·Files API)을 그대로 따른다.

const Anthropic = require("@anthropic-ai/sdk");
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
const { isGptModel, callGptReport } = require("../../model-call");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
const SKILL_PATH = path.join(__dirname, "prompt.md");

// 입력 상한(요청당 페이로드·이미지 예산 방어).
const MAX_SOURCE_PDFS = 4;
const MAX_SOURCE_IMAGES = 16;
const MAX_BANK_PDFS = 3;
// Files API 로 올릴지(인라인 base64 로 보낼지) 경계. base64 는 ~1.33배로 부풀므로
// 큰 PDF 는 업로드해 요청 페이로드를 줄인다.
const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;

const VALID_GENRES = ["현대시", "고전시가", "현대소설", "고전소설"];
const VALID_TYPES = ["단답", "서술", "표채우기", "객관식"];

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
    ["png", "jpg", "jpeg", "gif", "webp", "heic"].includes(fileExt(f.name)) ||
    String(f.mimetype || "").startsWith("image/")
  );
}

// multipart 필드 배열 [{buffer,originalname,mimetype}] → [{buffer,name,mimetype}].
function normalizeFiles(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter((f) => f && f.buffer && f.buffer.length)
    .map((f) => ({
      buffer: f.buffer,
      name: f.originalname || f.name || "file",
      mimetype: f.mimetype || "",
    }));
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 ===\n${notes}\n=== 끝 ===\n\n위 메모는 보조 맥락입니다(예: 특정 작품만, 객관식 비중↑, 특정 선생님 스타일 등). 지문·해석을 지어내는 근거로 쓰지 마세요.`;
}

// ── lenient JSON 추출/파싱 (problem-set 방식) ────────────────────────────────
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

// ── 제공자-인지 1회 호출 → {text, usage} ─────────────────────────────────────
async function callModel(
  client,
  { system, content, model, signal, onProgress, label, usedFileApi, maxTokens },
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
      `응답이 너무 길어 잘렸습니다(${label}). 학습지 분량을 줄이거나 다시 시도하세요.`,
    );
  }
  const text = finalMessage.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, usage: finalMessage.usage, webSearchCount: 0 };
}

// 큰 PDF 는 Files API 업로드, 작으면(또는 GPT) 인라인 base64.
async function pushPdf(content, f, uploadedIds, state, { useGpt, signal, onProgress }) {
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
      media_type: "application/pdf",
      filename: f.name,
      data: f.buffer.toString("base64"),
    },
  });
}

// 이미지(학습지 사진·판서 사진)를 vision 블록으로 변환해 content 에 덧붙인다.
async function pushImages(content, images, onProgress) {
  if (!images.length) return;
  const opts = getBatchImageOptions(images.length);
  let shown = 0;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const prepared = await prepareImageForAnthropic(
      { buffer: img.buffer, name: img.name || `img${i + 1}.png`, mimetype: img.mimetype },
      opts,
    );
    content.push({ type: "text", text: `[학습지/판서 이미지 ${i + 1}: ${img.name || ""}]` });
    if (prepared.ok) {
      content.push(toAnthropicImageBlock(prepared));
      shown++;
    } else {
      content.push({ type: "text", text: `(이 이미지는 표시 제외: ${prepared.reason})` });
    }
  }
  if (shown) onProgress(`🖼 학습지/판서 이미지 ${shown}개를 모델에 제시`);
}

const GENERATE_INSTRUCTION = `## 지금 단계: 문제 생성

위 학습지(판서·필기 포함)${""} 를 1순위 근거로, 국어(문학) 내신·모의고사 문제 세트를 출력 스키마(JSON 하나)로 만드세요.
- 학습지에서 강조한 해석·표현법·정서·시점·주제를 그대로 출제 근거로 삼으세요(일반론을 지어내지 마세요).
- 지문 발췌(passage_excerpt)는 원문 그대로(시는 행/연, 소설은 문단을 \\n 로 보존).
- 단답·서술·표채우기·객관식(5지선다)을 고루, 충분히(작품당 3~6문항, 전체 12문항 이상 권장).
- 문제은행/외부(미수업) 지문은 수업 작품과 〈보기〉·비교 형태로 연계하고 taught:false 로 표시하세요.
- 정답(answer)·해설(explanation)을 정확히. 객관식 해설은 오답 근거도.
- 출력은 스키마의 JSON 객체 하나뿐(앞뒤 설명 금지).`;

// ── 스키마 검증·정규화 ───────────────────────────────────────────────────────
function sanitizeContent(parsed) {
  const works = Array.isArray(parsed.works) ? parsed.works : [];
  const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  if (!works.length) {
    throw new Error("작품(works)을 찾지 못했습니다. 학습지/지문이 인식되지 않았을 수 있습니다.");
  }
  if (!questions.length) {
    throw new Error("문항(questions)이 생성되지 않았습니다. 다시 시도하세요.");
  }

  // work id 정규화(없거나 중복이면 부여) + 유효 id 집합.
  const seenIds = new Set();
  works.forEach((w, i) => {
    let id = String(w.id || "").trim();
    if (!id || seenIds.has(id)) id = `w${i + 1}`;
    while (seenIds.has(id)) id = `${id}_`;
    w.id = id;
    seenIds.add(id);
    if (!VALID_GENRES.includes(w.genre)) w.genre = w.genre || "현대시";
    w.title = String(w.title || `작품 ${i + 1}`);
    w.passage_excerpt = String(w.passage_excerpt || "");
    w.taught = w.taught !== false; // 기본 true
  });
  const idSet = new Set(works.map((w) => w.id));
  const firstId = works[0].id;

  // 문항 정규화. work_id 가 유효하지 않으면 첫 작품으로 폴백(고아 문항 방지).
  const clean = [];
  questions.forEach((q) => {
    if (!q || typeof q !== "object") return;
    const type = VALID_TYPES.includes(q.type) ? q.type : "단답";
    const work_id = idSet.has(q.work_id) ? q.work_id : firstId;
    const out = {
      no: Number.isFinite(q.no) ? q.no : clean.length + 1,
      work_id,
      type,
      prompt: String(q.prompt || ""),
      answer: q.answer == null ? "" : String(q.answer),
      explanation: q.explanation == null ? "" : String(q.explanation),
    };
    if (type === "객관식" && Array.isArray(q.choices)) {
      out.choices = q.choices.map((c) => String(c));
    }
    if (type === "표채우기" && q.table && Array.isArray(q.table.headers)) {
      out.table = {
        headers: q.table.headers.map((h) => String(h)),
        rows: Array.isArray(q.table.rows)
          ? q.table.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c)) : [String(r)]))
          : [],
      };
    }
    if (!out.prompt.trim()) return; // 발문 없는 문항 폐기
    clean.push(out);
  });
  if (!clean.length) {
    throw new Error("유효한 문항을 만들지 못했습니다(발문 누락). 다시 시도하세요.");
  }
  // 번호 1..N 으로 재부여(출력 순서 보장).
  clean.forEach((q, i) => {
    q.no = i + 1;
  });

  return {
    title: String(parsed.title || "국어 문학 내신·모의고사").slice(0, 200),
    works,
    questions: clean,
  };
}

/**
 * server.js PIPELINES[...].prepareInput(filesByField, body) — 동기. 잘못된 입력은 throw.
 * @param {Object} filesByField fieldname -> [{buffer, originalname, mimetype}]
 * @param {Object} body         폼 값(date, userNotes 등)
 * @returns {Object} pipelineInput
 */
function prepareInput(filesByField = {}, body = {}) {
  const source = normalizeFiles(filesByField.source);
  const bank = normalizeFiles(filesByField.bank);
  if (source.length === 0) {
    throw new Error("학습지(판서·필기 포함) PDF 또는 이미지를 한 개 이상 올리세요. (필드: source)");
  }
  // source 는 PDF/이미지여야 함.
  const badSource = source.find((f) => !isPdf(f) && !isImage(f));
  if (badSource) {
    throw new Error(`학습지 파일 형식이 올바르지 않습니다: ${badSource.name} (PDF·이미지만 허용)`);
  }
  const badBank = bank.find((f) => !isPdf(f));
  if (badBank) {
    throw new Error(`문제은행은 PDF 만 허용합니다: ${badBank.name}`);
  }
  return {
    sourceFiles: source,
    bankFiles: bank,
    userNotes: String(body.userNotes || ""),
  };
}

/**
 * server.js PIPELINES[...].generateContent(ctx) — 구조화 content 반환.
 * ctx = { ...pipelineInput, date, model, signal, outputFormat, allowImageGen, onProgress }
 */
async function generateReportContent(ctx = {}) {
  const {
    sourceFiles = [],
    bankFiles = [],
    userNotes = "",
    date,
    onProgress = () => {},
    signal,
    model = null,
  } = ctx;

  const MODEL = model || DEFAULT_MODEL;
  const useGpt = isGptModel(MODEL);
  if (useGpt) {
    if (!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY)) {
      throw new Error("GPT_API_KEY 환경변수가 설정되지 않았습니다.");
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const pdfs = sourceFiles.filter(isPdf).slice(0, MAX_SOURCE_PDFS);
  const images = sourceFiles.filter(isImage).slice(0, MAX_SOURCE_IMAGES);
  const banks = (bankFiles || []).filter(isPdf).slice(0, MAX_BANK_PDFS);
  if (pdfs.length === 0 && images.length === 0) {
    throw new Error("학습지(PDF 또는 이미지)를 한 개 이상 올리세요.");
  }

  onProgress(
    `🤖 모델: ${MODEL} | 학습지 PDF ${pdfs.length} · 이미지 ${images.length}${banks.length ? ` · 문제은행 ${banks.length}` : ""}`,
  );

  const client = useGpt
    ? null
    : new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        timeout: 50 * 60 * 1000,
      });

  const skill = loadSkill();
  const system = `당신은 한국 고등학교 국어(문학) 교사를 돕는 출제 도우미입니다. 학습지(판서·필기)를 핵심 근거로 현대시·고전시가·현대소설·고전소설의 내신/모의고사 문제와 정확한 정답·해설을 만듭니다.

아래 스킬 명세의 모든 규칙(학습지 1순위, 지문 날조 금지, 외부 지문 연계, 유형 배분, 출력 스키마)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========`;

  // ── content 구성 ──────────────────────────────────────────────────────────
  const uploadedIds = [];
  const state = { usedFileApi: false };
  const content = [];
  let totalCost = null;

  try {
    for (const f of pdfs) {
      await pushPdf(content, f, uploadedIds, state, { useGpt, signal, onProgress });
      content.push({
        type: "text",
        text: `↑ 위 PDF 는 수업 학습지("${f.name}")입니다. 여기 필기·판서·정리된 해석을 출제의 1순위 근거로 삼으세요.`,
      });
    }
    await pushImages(content, images, onProgress);
    if (images.length) {
      content.push({
        type: "text",
        text: "↑ 위 이미지들은 학습지/판서 사진입니다. 손글씨 필기·형광펜 강조·화살표로 표시된 해석을 빠짐없이 출제 근거로 반영하세요.",
      });
    }
    for (const b of banks) {
      await pushPdf(content, b, uploadedIds, state, { useGpt, signal, onProgress });
      content.push({
        type: "text",
        text: `↑ 위 PDF 는 예시 문제은행("${b.name}")입니다. 출제 유형·난이도·문항 구성을 참고하고, 외부(미수업) 지문은 수업 작품과 〈보기〉·비교로 연계하세요.`,
      });
    }
    const notesBlock = buildUserNotesBlock(userNotes);
    if (notesBlock) content.push({ type: "text", text: notesBlock });
    content.push({ type: "text", text: GENERATE_INSTRUCTION });

    onProgress("✍️ 학습지 분석·문항 생성 중...");
    const r = await callModel(client, {
      system,
      content,
      model: MODEL,
      signal,
      onProgress,
      label: "문항 생성",
      usedFileApi: state.usedFileApi,
    });
    totalCost = calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL });

    const parsed = parsePhase(r.text, "문항 생성");
    const result = sanitizeContent(parsed);

    onProgress(`📋 작품 ${result.works.length}개 · 문항 ${result.questions.length}개 생성 완료`);

    const content_out = {
      title: result.title,
      works: result.works,
      questions: result.questions,
      date: date || "",
    };
    const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
    Object.defineProperty(content_out, "__cost", { value: totalCost, enumerable: false });
    Object.defineProperty(content_out, "__imageCost", { value: imageCost, enumerable: false });
    if (totalCost) onProgress(formatCostLine(totalCost));
    return content_out;
  } finally {
    if (uploadedIds.length) {
      await Promise.allSettled(
        uploadedIds.map((id) => deleteAnthropicFile(id).catch(() => {})),
      );
    }
  }
}

module.exports = {
  prepareInput,
  generateReportContent,
  generateBundle: require("./bundle").generateBundle,
};
