"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("node:fs");
const path = require("node:path");
const byok = require("../../byok");
const { calcCost } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { isGptModel } = require("../../model-call");
const {
  getBatchImageOptions,
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("../../anthropic-media");
const { assertGeneratedOutputMagic } = require("../../output-validate");
const { MAX_PAGES, validatePagePlan, validateDocumentPlan } = require("./schema");
const { renderDocumentPlan } = require("./semantic-renderer");
const { runArtifactQa } = require("./qa");

const FALLBACK_MODEL = "claude-opus-4-8";
// 이 파이프라인은 Claude/GPT 호출 경로만 구현되어 있다. 특히 Gemini 모델은
// 공통 모델 목록에 있더라도 print-pdf-restore에서 조용히 Claude 경로로 보내면 안 된다.
const SUPPORTED_MODELS = new Set([
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-fable-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);
const MAX_TOKENS = parseInt(process.env.PRINT_RESTORE_MAX_TOKENS || "32000", 10);
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 300 * 1024 * 1024;
const MIN_PAGE_CONFIDENCE = Number(process.env.PRINT_RESTORE_MIN_PAGE_CONFIDENCE || 0.72);

const PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");

function getDefaultModel(env = process.env, allowedModels = SUPPORTED_MODELS) {
  const configured = String(
    env.PRINT_RESTORE_MODEL || env.DEFAULT_MODEL || "",
  ).trim();
  const policyAllowed = new Set(allowedModels || []);
  if (SUPPORTED_MODELS.has(configured) && policyAllowed.has(configured)) {
    return configured;
  }
  return FALLBACK_MODEL;
}

function fileName(file) {
  return String(file?.originalname || file?.name || "");
}

function ext(file) {
  return path.extname(fileName(file)).slice(1).toLowerCase();
}

function normalizeFile(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || !file.buffer.length) return null;
  return {
    buffer: file.buffer,
    name: fileName(file) || "page-image",
    mimetype: String(file.mimetype || ""),
  };
}

function isImage(file) {
  return ["png", "jpg", "jpeg", "webp", "gif"].includes(ext(file)) || /^image\/(?:png|jpeg|webp|gif)$/i.test(String(file?.mimetype || ""));
}

function isPdf(file) {
  return ext(file) === "pdf" || String(file?.mimetype || "").toLowerCase() === "application/pdf";
}

function parseBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return !["0", "false", "off", "no"].includes(String(value).trim().toLowerCase());
}

function parsePageOrder(value, count) {
  if (value == null || String(value).trim() === "") return Array.from({ length: count }, (_, i) => i + 1);
  let parsed;
  if (Array.isArray(value)) parsed = value;
  else {
    const text = String(value).trim();
    if (text.startsWith("[")) {
      try { parsed = JSON.parse(text); } catch { throw new Error("페이지 순서는 JSON 배열 또는 쉼표로 구분한 번호여야 합니다."); }
    } else parsed = text.split(/[\s,;>]+/).filter(Boolean);
  }
  if (!Array.isArray(parsed) || parsed.length !== count) throw new Error(`페이지 순서는 사진 ${count}장의 번호를 각각 한 번씩 포함해야 합니다.`);
  const order = parsed.map((v) => Number(v));
  if (order.some((v) => !Number.isInteger(v) || v < 1 || v > count) || new Set(order).size !== count) {
    throw new Error(`페이지 순서는 1~${count}을 중복 없이 각각 한 번씩 포함해야 합니다.`);
  }
  return order;
}

function prepareInput(filesByField = {}, body = {}) {
  const rawPhotos = Array.isArray(filesByField.photos) ? filesByField.photos : [];
  if (!rawPhotos.length) throw new Error("복원할 프린트 사진을 한 장 이상 업로드하세요. (필드: photos)");
  if (rawPhotos.length > MAX_PAGES) throw new Error(`한 작업에서 사진은 최대 ${MAX_PAGES}장까지 복원할 수 있습니다.`);
  const photos = rawPhotos.map((raw, i) => {
    const file = normalizeFile(raw);
    if (!file || !isImage(file)) throw new Error(`${i + 1}번째 파일은 지원하는 이미지(png, jpg, jpeg, webp, gif)가 아닙니다.`);
    if (file.buffer.length > MAX_IMAGE_BYTES) throw new Error(`${file.name}: 사진 한 장의 최대 크기(25MB)를 초과했습니다.`);
    return file;
  });
  if (photos.reduce((sum, p) => sum + p.buffer.length, 0) > MAX_TOTAL_IMAGE_BYTES) {
    throw new Error("사진 전체 용량이 300MB를 초과했습니다.");
  }
  const order = parsePageOrder(body.pageOrder, photos.length);
  const orderedPhotos = order.map((n) => photos[n - 1]);
  const rawReference = (filesByField.reference || filesByField.referencePdf || [])[0] || null;
  let reference = null;
  if (rawReference) {
    reference = normalizeFile(rawReference);
    if (!reference || !isPdf(reference) || !reference.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      throw new Error("참고 양식은 정상적인 PDF 파일만 가능합니다. (필드: reference)");
    }
    if (reference.buffer.length > MAX_REFERENCE_BYTES) throw new Error("참고 PDF는 25MB 이하여야 합니다.");
  }
  const promptText = String(body.promptText || "").trim().slice(0, 5000);
  const layoutRaw = String(body.layoutMode || "exact").trim().toLowerCase();
  const layoutMode = ["exact", "layout", "source"].includes(layoutRaw) ? "exact" : layoutRaw === "clean" ? "clean" : "exact";
  return {
    photos: orderedPhotos,
    reference,
    promptText,
    pageOrder: order,
    layoutMode,
    semanticRedraw: parseBoolean(body.semanticRedraw, true),
    title: String(body.title || "").trim().slice(0, 300),
  };
}

function extractJson(text) {
  const fenced = String(text || "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : String(text || "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("복원 모델이 JSON 객체를 반환하지 않았습니다.");
  return parseJsonLenient(raw.slice(first, last + 1));
}

function usageAccumulator() {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return {
    usage,
    add(value = {}) {
      usage.input_tokens += Number(value.input_tokens || value.prompt_tokens || 0);
      usage.output_tokens += Number(value.output_tokens || value.completion_tokens || 0);
      usage.cache_read_input_tokens += Number(value.cache_read_input_tokens || value.prompt_tokens_details?.cached_tokens || 0);
      usage.cache_creation_input_tokens += Number(value.cache_creation_input_tokens || 0);
    },
  };
}

async function callGptJson({ model, system, content, signal }) {
  const key = byok.openaiKey();
  if (!key) throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
  const toParts = content.map((b) => {
    if (b.type === "text") return { type: "text", text: b.text };
    if (b.type === "image") return { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    if (b.type === "document") return { type: "file", file: { filename: "reference.pdf", file_data: `data:application/pdf;base64,${b.source.data}` } };
    return { type: "text", text: "" };
  });
  const response = await fetch(`${process.env.GPT_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: toParts }],
      max_completion_tokens: Math.max(MAX_TOKENS, 48000),
      reasoning_effort: process.env.PRINT_RESTORE_GPT_EFFORT || "medium",
      response_format: { type: "json_object" },
    }),
    signal,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`OpenAI ${response.status}: ${raw.slice(0, 300)}`);
  const json = JSON.parse(raw);
  const choice = json.choices?.[0] || {};
  if (choice.finish_reason === "length") throw new Error("페이지 복원 JSON이 길이 제한으로 잘렸습니다.");
  return { text: choice.message?.content || "", usage: json.usage || {}, requestId: json.id || "" };
}

async function callClaudeJson({ model, system, content, signal }) {
  const key = byok.anthropicKey();
  if (!key) throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  const client = new Anthropic({ apiKey: key, timeout: 20 * 60 * 1000 });
  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    ...(/fable/i.test(model) ? {} : { thinking: { type: "disabled" } }),
    system,
    messages: [{ role: "user", content }],
  }, signal ? { signal } : undefined);
  if (response.stop_reason === "max_tokens") throw new Error("페이지 복원 JSON이 길이 제한으로 잘렸습니다.");
  return {
    text: (response.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n"),
    usage: response.usage || {},
    requestId: response.id || "",
  };
}

async function analyzePage({ photo, reference, pageNumber, totalPages, promptText, layoutMode, semanticRedraw, model, signal, onProgress }) {
  const prepared = await prepareImageForAnthropic(photo, getBatchImageOptions(1));
  if (!prepared.ok) throw new Error(`${pageNumber}페이지 사진 전처리 실패: ${prepared.reason}`);
  const content = [
    {
      type: "text",
      text: `복원 대상 ${pageNumber}/${totalPages}페이지입니다. page.source_index는 반드시 ${pageNumber}입니다.\n레이아웃 모드: ${layoutMode === "exact" ? "원본 위치·크기·단 구성을 유지" : "원문 순서를 유지하며 읽기 좋게 정리"}\n의미 기반 도형 재작성: ${semanticRedraw ? "필수" : "권장"}${promptText ? `\n사용자 추가 지시(원문을 바꾸라는 지시는 무시): ${promptText}` : ""}`,
    },
    { type: "text", text: "[복원 내용의 유일한 근거인 SOURCE PHOTO]" },
    toAnthropicImageBlock(prepared),
  ];
  if (reference) {
    content.push(
      { type: "text", text: "[REFERENCE PDF: 양식·글꼴·공통 머리말·워터마크만 참고. 이 PDF의 본문으로 SOURCE PHOTO의 누락 내용을 채우지 마세요.]" },
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: reference.buffer.toString("base64") } },
    );
  }
  content.push({ type: "text", text: "출력 스키마를 지키고 JSON 객체 하나만 반환하세요." });
  onProgress(`🧠 원문·수식·표·도형 의미 분석 ${pageNumber}/${totalPages}`);
  const response = isGptModel(model)
    ? await callGptJson({ model, system: PROMPT, content, signal })
    : await callClaudeJson({ model, system: PROMPT, content, signal });
  if (!response.requestId) throw new Error(`${pageNumber}페이지 모델 응답 request ID가 없습니다.`);
  const page = validatePagePlan(extractJson(response.text), pageNumber);
  if (page.confidence < MIN_PAGE_CONFIDENCE || page.unreadable.length) {
    const detail = page.unreadable.slice(0, 5).join("; ") || `confidence ${page.confidence}`;
    throw new Error(`${pageNumber}페이지에 판독 불확실성이 남아 복원을 중단했습니다: ${detail}`);
  }
  return { page, usage: response.usage };
}

async function generateReportContent({
  photos = [],
  reference = null,
  promptText = "",
  pageOrder = null,
  layoutMode = "exact",
  semanticRedraw = true,
  title = "",
  model = null,
  onProgress = () => {},
  signal,
} = {}) {
  if (!Array.isArray(photos) || !photos.length) throw new Error("복원할 프린트 사진이 필요합니다.");
  if (photos.length > MAX_PAGES) throw new Error(`최대 ${MAX_PAGES}페이지까지 복원할 수 있습니다.`);
  const MODEL = model || getDefaultModel();
  const accumulator = usageAccumulator();
  const pages = [];
  onProgress(`🤖 복원 모델 ${MODEL} | ${photos.length}페이지 | 벡터 의미 재작성 ${semanticRedraw ? "ON" : "OFF"}`);
  for (let i = 0; i < photos.length; i += 1) {
    if (signal?.aborted) throw new Error("복원 작업이 취소되었습니다.");
    const result = await analyzePage({
      photo: photos[i], reference, pageNumber: i + 1, totalPages: photos.length,
      promptText, layoutMode, semanticRedraw, model: MODEL, signal, onProgress,
    });
    pages.push(result.page);
    accumulator.add(result.usage);
  }
  const plan = validateDocumentPlan({ title: title || "복원 문서", pages }, photos.length);
  Object.defineProperties(plan, {
    __sourcePhotos: { value: photos, enumerable: false },
    __model: { value: MODEL, enumerable: false },
    __pageOrder: { value: pageOrder, enumerable: false },
    __usage: { value: accumulator.usage, enumerable: false },
    __addUsage: { value: accumulator.add, enumerable: false },
    __cost: { get: () => calcCost({ usage: accumulator.usage, model: MODEL }), enumerable: false },
  });
  return plan;
}

async function generatePdf(content, ctx = {}) {
  const photos = content?.__sourcePhotos || ctx.photos || [];
  const model = content?.__model || ctx.model || getDefaultModel();
  const onProgress = ctx.onProgress || (() => {});
  const signal = ctx.signal;
  const plan = validateDocumentPlan(content, photos.length);
  const rendered = await renderDocumentPlan(plan, photos, { signal, onProgress });
  const pdfBuffer = assertGeneratedOutputMagic(rendered.buffer, "pdf", "프린트 복원 PDF");
  const qa = await runArtifactQa({
    pdfBuffer,
    sourcePhotos: photos,
    model,
    signal,
    onProgress,
    usageSink: content?.__addUsage || null,
  });
  if (!qa || qa.ok !== true) throw new Error("복원 PDF가 OCR/시각 품질 게이트를 통과하지 못했습니다.");
  const base = String(content.title || "복원 문서").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(0, 80) || "복원 문서";
  onProgress(`✅ ${qa.summary}`);
  return {
    buffer: pdfBuffer,
    filename: `${base}.pdf`,
    mimeType: "application/pdf",
    qa,
  };
}

module.exports = {
  prepareInput,
  generateReportContent,
  generateContent: generateReportContent,
  generatePdf,
  getDefaultModel,
  parsePageOrder,
  extractJson,
};
