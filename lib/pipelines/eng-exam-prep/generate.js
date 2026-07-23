// 영어 시험대비 자료 3종 세트 (eng-exam-prep) — 콘텐츠 생성.
//
// 입력: 영어 지문/학습지 1개 이상(PDF·이미지·텍스트) + 옵션(userNotes).
// 출력: 지문별로 (모의고사/개념정리/빈칸) 문항을 담은 content JSON.
//       조판(3개 PDF → ZIP)은 bundle.js 가 맡는다.
//
// 흐름:
//   1) 소스 파일을 Anthropic 형식 content 블록으로 구성(PDF=document, 이미지=vision, 텍스트=text).
//      큰 PDF 는 Files API 로 업로드(인라인 32MB 한도 우회), GPT 경로는 인라인 유지.
//   2) 모델(Claude 스트림 / GPT)을 1회 호출해 JSON 하나를 받는다.
//   3) lenient parse + 스키마 검증 → passages 배열을 만든다.
//
// problem-set/generate.js 의 호출·파싱·비용 누적 관습을 그대로 따른다.

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

const MAX_SOURCE_PDFS = 5;
const MAX_SOURCE_IMAGES = 16;
const MAX_SOURCE_TEXTS = 20;
// Files API 임계: 인라인 base64 는 ~1.33배로 부풀므로, raw 가 이보다 크면 업로드한다.
const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;

const TEXT_EXT = new Set(["txt", "md"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "webp"]);

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
  return IMAGE_EXT.has(fileExt(f.name)) || String(f.mimetype || "").startsWith("image/");
}
function isText(f) {
  return TEXT_EXT.has(fileExt(f.name)) || String(f.mimetype || "").startsWith("text/");
}

// 텍스트 파일 디코딩: UTF-8 우선, 깨지면 EUC-KR 시도(phys-result 관습).
function decodeText(buf) {
  try {
    const utf8 = buf.toString("utf8");
    // U+FFFD(대체문자)가 많으면 잘못된 인코딩으로 보고 EUC-KR 재시도.
    const bad = (utf8.match(/�/g) || []).length;
    if (bad > 2) {
      try {
        return new TextDecoder("euc-kr").decode(buf);
      } catch {
        return utf8;
      }
    }
    return utf8;
  } catch {
    return "";
  }
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 ===\n${notes}\n=== 끝 ===\n\n위 메모는 보조 맥락입니다(예: 특정 단원만, 난이도). 지문/문항 데이터를 지어내는 근거로 쓰지 마세요.`;
}

// ── lenient JSON 파싱 (problem-set 패턴) ─────────────────────────────────────
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

// ── 제공자-인지 1회 호출(Claude 스트림 / GPT) → {text, usage, webSearchCount} ──
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
      jsonObject: true,
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
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
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
      `응답이 너무 길어 잘렸습니다(${label}). 지문 수를 줄이거나 파일을 나눠 다시 시도하세요.`,
    );
  }
  const text = finalMessage.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, usage: finalMessage.usage, webSearchCount: 0 };
}

// 소스 이미지를 vision 블록으로 변환해 content 에 덧붙인다.
async function pushSourceImages(content, images, onProgress) {
  if (!images.length) return;
  const opts = getBatchImageOptions(images.length);
  let shown = 0;
  for (const img of images) {
    const prepared = await prepareImageForAnthropic(
      { buffer: img.buffer, name: img.name || "img.png", mimetype: img.mimetype },
      opts,
    );
    content.push({ type: "text", text: `[지문 이미지: ${img.name || "image"}]` });
    if (prepared.ok) {
      content.push(toAnthropicImageBlock(prepared));
      shown++;
    } else {
      content.push({ type: "text", text: `(이 이미지는 표시 제외: ${prepared.reason})` });
    }
  }
  if (shown) onProgress(`🖼 지문 이미지 ${shown}장을 모델에 제시`);
}

const INSTRUCTION = `## 지금 단계: 3종 세트 생성

위 소스의 **모든 영어 지문**을 읽고, 각 지문마다 (모의고사: 단답형+서술형 / 개념정리 / 빈칸학습지)
문항을 만들어 출력 스키마(JSON 하나)로 출력하세요.
- 지문이 여러 개면 passages[] 에 지문 수만큼 빠짐없이 넣으세요.
- 문항·선택지·본문은 영어, 해설(explanation)·영작 과제 한국어 문장은 한국어로.
- 빈칸(cloze.blanked_text)의 번호 빈칸 개수와 answers 길이를 일치시키세요.
- 지문이 실하면 세 영역 합쳐 지문당 15문항 이상을 목표로 하세요.
- 출력은 스키마의 JSON 객체 하나뿐(앞뒤 설명 금지).`;

/**
 * @param {Object} ctx
 * @param {Array}  ctx.sourceFiles  [{buffer,name,mimetype}] — PDF·이미지·텍스트
 * @param {string} ctx.userNotes    보조 메모
 * @param {string} ctx.date
 * @param {string} ctx.model
 * @param {AbortSignal} [ctx.signal]
 * @param {Function} ctx.onProgress (msg)=>void
 */
async function generateReportContent({
  sourceFiles = [],
  userNotes = "",
  date,
  model = null,
  signal,
  onProgress = () => {},
} = {}) {
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
  const texts = sourceFiles.filter(isText).slice(0, MAX_SOURCE_TEXTS);
  if (pdfs.length === 0 && images.length === 0 && texts.length === 0) {
    throw new Error("영어 지문 소스(PDF·이미지·텍스트)를 한 개 이상 올리세요.");
  }

  onProgress(
    `🤖 모델: ${MODEL} | 소스 PDF ${pdfs.length} · 이미지 ${images.length} · 텍스트 ${texts.length}`,
  );

  const client = useGpt
    ? null
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 });

  const skill = loadSkill();
  const baseSystem = `당신은 영어 지문/학습지로 내신 대비 자료 3종 세트(모의고사·개념정리·빈칸학습지)의 내용을 만드는 도우미입니다.

아래 스킬 명세의 모든 규칙(환각 금지, 모든 지문 반영, 영어 문항 / 한국어 해설, 빈칸 번호·정답 일치, 단일 JSON 출력)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========`;

  // ── content 블록 구성 ────────────────────────────────────────────────────
  const content = [];
  const uploadedIds = [];
  const state = { usedFileApi: false };

  // PDF: 큰 건 Files API 업로드(Claude 만), 작은 건 인라인. GPT 는 항상 인라인.
  for (const f of pdfs) {
    const tooBig = f.buffer.length >= FILES_API_RAW_THRESHOLD;
    if (tooBig && !useGpt) {
      try {
        const fileId = await uploadFileToAnthropic(f.buffer, f.name, { signal });
        content.push({ type: "document", source: { type: "file", file_id: fileId } });
        uploadedIds.push(fileId);
        state.usedFileApi = true;
        onProgress(`📤 큰 PDF 업로드(Files API): ${f.name}`);
      } catch (e) {
        onProgress(`⚠ Files API 실패 → 인라인 전송: ${e.message}`);
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: f.buffer.toString("base64"),
          },
        });
      }
    } else {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: f.buffer.toString("base64"),
        },
      });
    }
    content.push({ type: "text", text: `↑ 위 PDF 는 영어 지문 소스("${f.name}")입니다.` });
  }

  // 이미지 지문.
  await pushSourceImages(content, images, onProgress);

  // 텍스트 지문.
  for (const t of texts) {
    const body = decodeText(t.buffer).trim();
    if (!body) continue;
    content.push({
      type: "text",
      text: `=== 영어 지문 텍스트 (${t.name || "text"}) ===\n${body}\n=== 끝 ===`,
    });
  }

  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) content.push({ type: "text", text: notesBlock });
  content.push({ type: "text", text: INSTRUCTION });

  // ── 모델 호출 ────────────────────────────────────────────────────────────
  let totalCost;
  let parsed;
  try {
    onProgress("✍️ 지문 분석·3종 문항 생성 중...");
    const r = await callModel(client, {
      system: baseSystem,
      content,
      model: MODEL,
      signal,
      onProgress,
      label: "문항 생성",
      usedFileApi: state.usedFileApi,
    });
    totalCost = calcCost({ usage: r.usage, webSearchCount: r.webSearchCount, model: MODEL });
    parsed = parsePhase(r.text, "3종 세트");
  } finally {
    if (uploadedIds.length) {
      await Promise.allSettled(
        uploadedIds.map((id) => deleteAnthropicFile(id).catch(() => {})),
      );
    }
  }

  // ── 스키마 정규화·검증 ───────────────────────────────────────────────────
  const passages = normalizePassages(parsed.passages);
  if (passages.length === 0) {
    throw new Error("소스에서 영어 지문을 찾지 못했습니다. 다른 파일을 시도해 보세요.");
  }
  const itemCount = passages.reduce((n, p) => n + countItems(p), 0);
  onProgress(`📋 지문 ${passages.length}개 · 문항 ${itemCount}개 생성 완료`);

  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.filter((x) => typeof x === "string").slice(0, 6)
    : [];

  const content_out = {
    title: String(parsed.title || "영어 시험대비 자료").slice(0, 200),
    passages,
    notes,
    date: date || "",
  };

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
  Object.defineProperty(content_out, "__cost", { value: totalCost, enumerable: false });
  Object.defineProperty(content_out, "__imageCost", { value: imageCost, enumerable: false });

  onProgress(formatCostLine(totalCost));
  return content_out;
}

// ── 정규화 헬퍼 ──────────────────────────────────────────────────────────────
function asString(s) {
  return typeof s === "string" ? s : s == null ? "" : String(s);
}
function asQAArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((it) => {
      if (!it || typeof it !== "object") return null;
      const q = asString(it.q).trim();
      if (!q) return null;
      return {
        q,
        a: asString(it.a).trim(),
        explanation: asString(it.explanation).trim(),
      };
    })
    .filter(Boolean);
}

function normalizePassages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  raw.forEach((p, i) => {
    if (!p || typeof p !== "object") return;
    const exam = p.exam && typeof p.exam === "object" ? p.exam : {};
    const cloze = p.cloze && typeof p.cloze === "object" ? p.cloze : {};
    const blanked = asString(cloze.blanked_text).trim();
    const passage = {
      id: asString(p.id).trim() || `P${i + 1}`,
      title: asString(p.title).trim() || `지문 ${i + 1}`,
      exam: {
        short: asQAArray(exam.short),
        essay: asQAArray(exam.essay),
      },
      concept: asQAArray(p.concept),
      cloze: {
        blanked_text: blanked,
        answers: Array.isArray(cloze.answers)
          ? cloze.answers.map((x) => asString(x)).filter((x) => x.length)
          : [],
        translation_task: Array.isArray(cloze.translation_task)
          ? cloze.translation_task
              .map((t) =>
                t && typeof t === "object"
                  ? { ko: asString(t.ko).trim(), en: asString(t.en).trim() }
                  : null,
              )
              .filter((t) => t && (t.ko || t.en))
          : [],
      },
    };
    // 최소 한 영역이라도 내용이 있어야 채택(완전 빈 지문 방어).
    if (countItems(passage) > 0 || passage.cloze.blanked_text) out.push(passage);
  });
  return out;
}

function countItems(p) {
  return (
    (p.exam?.short?.length || 0) +
    (p.exam?.essay?.length || 0) +
    (p.concept?.length || 0) +
    (p.cloze?.translation_task?.length || 0) +
    (p.cloze?.blanked_text ? 1 : 0)
  );
}

// ── 모듈 계약 ────────────────────────────────────────────────────────────────
// server.js 의 PIPELINES 항목에서 쓰는 prepareInput.
// filesByField: fieldname -> [{buffer, originalname, mimetype}]
function prepareInput(filesByField, body) {
  const source = (filesByField && filesByField.source) || [];
  if (source.length === 0) {
    throw new Error("영어 지문 파일(PDF·이미지·텍스트)을 한 개 이상 올리세요.");
  }
  const ALLOWED = new Set(["pdf", "png", "jpg", "jpeg", "webp", "txt", "md"]);
  for (const f of source) {
    const ext = (String(f.originalname || "").split(".").pop() || "").toLowerCase();
    if (!ALLOWED.has(ext)) {
      throw new Error(
        `지문 파일은 PDF·이미지(.png/.jpg/.jpeg/.webp)·텍스트(.txt/.md)만 가능합니다. (${f.originalname})`,
      );
    }
  }
  const sourceFiles = source.map((f) => ({
    buffer: f.buffer,
    name: f.originalname,
    mimetype: f.mimetype,
  }));
  return {
    sourceFiles,
    userNotes: String((body && body.userNotes) || "").trim(),
    studentId: String((body && body.studentId) || "").trim().slice(0, 20),
  };
}

module.exports = {
  prepareInput,
  generateReportContent,
  // 번들러(조판→ZIP)는 분리.
  generateBundle: require("./bundle").generateBundle,
};
