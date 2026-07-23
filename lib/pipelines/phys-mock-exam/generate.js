// 물리 모의고사 생성 (phys-mock-exam) — 콘텐츠 생성.
//
// 입력: 기출 시험지 PDF(exam, 필수) + 교재 단원 PDF(textbook, 필수)
//        + (선택) 채점 기준 PDF(rubric) + (선택) body.userNotes(단원/난이도/문항수 지시).
// 출력: { meta, problems[] } — 시험지+답안지 PDF 와 HWPX 로 조판할 최종 JSON.
//
// 접근(단일 Node 프로세스 — 서브에이전트 대신 순차 LLM 호출로 draft→verify→reconcile 모방):
//   (1) DRAFT     — 기출 문체·교재 단원으로 N개 문제 출제.
//   (2) VERIFY    — 두 번째 호출이 각 문제를 다시 풀어 정답·난이도·배점을 검증.
//   (3) RECONCILE — 검증 결과를 병합해 최종 JSON 확정.
//
// 모델 분기: /^gpt/i 면 GPT(model-call), 아니면 Claude 스트림. PDF 첨부는 phys-result 와
//   동일하게 Files API(큰 PDF) / 인라인 base64(작은 PDF, GPT 는 항상 인라인)로 처리.

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const { calcCost, calcImageCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { isGptModel, callGptReport } = require("../../model-call");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(
  process.env.MOCKEXAM_MAX_TOKENS || process.env.MAX_TOKENS || "32000",
  10,
);
const SKILL_PATH = path.join(__dirname, "prompt.md");

// 큰 PDF 는 Files API 로 업로드(인라인 32MB 한도 회피), 작은 PDF 는 인라인 base64.
const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;
// 문항 수 기본/상한 — 사용자 메모로 조절 가능하나 폭주 방지.
const DEFAULT_COUNT = 8;
const MAX_COUNT = 25;

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}
function isPdf(f) {
  return fileExt(f && f.name) === "pdf" || (f && f.mimetype === "application/pdf");
}

// ── 입력 검증 (server.js prepareInput 계약) ─────────────────────────────────
// filesByField: fieldname -> [{ buffer, originalname, mimetype }]
function mapFiles(arr) {
  return (Array.isArray(arr) ? arr : []).map((f) => ({
    buffer: f.buffer,
    name: f.originalname || f.name || "file",
    mimetype: f.mimetype || "",
  }));
}

function prepareInput(filesByField = {}, body = {}) {
  const examFiles = mapFiles(filesByField.exam);
  const textbookFiles = mapFiles(filesByField.textbook);
  const rubricFiles = mapFiles(filesByField.rubric);

  const exam = examFiles.find(isPdf) || examFiles[0];
  const textbook = textbookFiles.find(isPdf) || textbookFiles[0];
  const rubric = rubricFiles.find(isPdf) || rubricFiles[0] || null;

  if (!exam || !exam.buffer || !exam.buffer.length) {
    throw new Error("기출 시험지 PDF(exam)를 업로드하세요.");
  }
  if (!isPdf(exam)) {
    throw new Error("기출 시험지는 PDF 파일이어야 합니다.");
  }
  if (!textbook || !textbook.buffer || !textbook.buffer.length) {
    throw new Error("교재 단원 PDF(textbook)를 업로드하세요.");
  }
  if (!isPdf(textbook)) {
    throw new Error("교재 단원은 PDF 파일이어야 합니다.");
  }
  if (rubric && !isPdf(rubric)) {
    throw new Error("채점 기준은 PDF 파일이어야 합니다.");
  }

  return {
    exam,
    textbook,
    rubric,
    userNotes: String(body.userNotes || body.notes || "").trim(),
  };
}

// ── JSON 추출/파싱 (problem-set/generate.js 방식 재사용) ────────────────────
function extractJson(text) {
  const fence = String(text || "").match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const any = String(text || "").match(/```\s*([\s\S]*?)```/);
  if (any) return any[1].trim();
  const first = String(text || "").indexOf("{");
  const last = String(text || "").lastIndexOf("}");
  if (first !== -1 && last > first) return String(text).slice(first, last + 1);
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
  if (!c) return acc;
  for (const k of COST_NUM_FIELDS) acc[k] = (acc[k] || 0) + (c[k] || 0);
  if (!acc.model && c.model) acc.model = c.model;
  return acc;
}

// 요청한 문항 수 추출. 사용자 메모에서 "문항 12개" / "10문제" 류를 읽고, 없으면 기본.
function resolveCount(userNotes) {
  const m = String(userNotes || "").match(/(\d{1,2})\s*(?:문항|문제|개|problems?)/i);
  let n = m ? parseInt(m[1], 10) : DEFAULT_COUNT;
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, n));
}

// ── 제공자-인지 1회 호출(Claude 스트림 / GPT) → {text, usage} ─────────────────
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
    return { text: gpt.text, usage: gpt.usage };
  }

  let charCount = 0;
  let lastReported = 0;
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
      if (charCount - lastReported >= 2000) {
        const sec = Math.floor((Date.now() - startedAt) / 1000);
        onProgress(`${label || "생성"} 중... (${charCount}자, ${sec}초)`);
        lastReported = charCount;
      }
    }
  });

  const finalMessage = await stream.finalMessage();
  if (finalMessage.stop_reason === "max_tokens") {
    throw new Error(
      `응답이 너무 길어 잘렸습니다(${label}). 문항 수를 줄여 보세요.`,
    );
  }
  const text = finalMessage.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text, usage: finalMessage.usage };
}

// PDF 블록을 content 에 추가. 큰 PDF 는 Files API(Claude만), 작은 PDF·GPT 는 인라인.
async function pushPdf(content, file, label, { useGpt, signal, uploadedIds, state, onProgress }) {
  const buf = file.buffer;
  const tooBig = buf.length >= FILES_API_RAW_THRESHOLD;
  if (tooBig && !useGpt) {
    try {
      const fileId = await uploadFileToAnthropic(buf, file.name || `${label}.pdf`, { signal });
      content.push({ type: "document", source: { type: "file", file_id: fileId } });
      uploadedIds.push(fileId);
      state.usedFileApi = true;
      onProgress(`📤 큰 PDF 업로드(Files API): ${label} (${Math.round((buf.length / 1048576) * 10) / 10}MB)`);
      return;
    } catch (e) {
      onProgress(`⚠ Files API 실패 → 인라인 전송: ${e.message}`);
    }
  }
  content.push({
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") },
  });
}

// problems[] 를 검증/종합 호출에 넣을 컴팩트 텍스트로.
function problemsToText(problems) {
  return (Array.isArray(problems) ? problems : [])
    .map((p) => {
      let s = `[문제 ${p.no}] (${p.topic || ""}, 배점 ${p.points ?? "?"})\n${p.statement || ""}`;
      if (Array.isArray(p.choices) && p.choices.length) {
        s += `\n보기: ${p.choices.join(" / ")}`;
      }
      s += `\n정답: ${p.answer || ""}`;
      s += `\n풀이: ${p.solution || ""}`;
      s += `\n채점기준: ${p.grading || ""}`;
      return s;
    })
    .join("\n\n");
}

// 최종 problems[] 정규화 — 번호 1..N 재배열, 필드 보정.
function normalizeProblems(problems) {
  const arr = (Array.isArray(problems) ? problems : []).filter(
    (p) => p && (p.statement || p.answer),
  );
  arr.forEach((p, i) => {
    p.no = i + 1;
    if (!Array.isArray(p.choices)) {
      if (p.choices == null || p.choices === "") delete p.choices;
      else p.choices = [String(p.choices)];
    } else if (p.choices.length === 0) {
      delete p.choices;
    }
    const pts = parseInt(p.points, 10);
    p.points = Number.isFinite(pts) && pts > 0 ? pts : 5;
    if (typeof p.figure !== "string") p.figure = "none";
    p.topic = String(p.topic || "");
    p.statement = String(p.statement || "");
    p.answer = String(p.answer || "");
    p.solution = String(p.solution || "");
    p.grading = String(p.grading || "");
  });
  return arr;
}

/**
 * 물리 모의고사 콘텐츠 생성.
 *
 * @param {Object} ctx  prepareInput 결과 + { date, model, signal, outputFormat, allowImageGen, onProgress }
 * @returns {Promise<Object>} { meta, problems[] }  (+ 비탐색 __cost/__imageCost)
 */
async function generateReportContent(ctx = {}) {
  const {
    exam,
    textbook,
    rubric = null,
    userNotes = "",
    date,
    onProgress = () => {},
    signal,
  } = ctx;
  const MODEL = ctx.model || DEFAULT_MODEL;
  const useGpt = isGptModel(MODEL);

  if (useGpt) {
    if (!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY)) {
      throw new Error("GPT_API_KEY 환경변수가 설정되지 않았습니다.");
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  if (!exam || !textbook) {
    throw new Error("기출 시험지와 교재 단원 PDF 가 모두 필요합니다.");
  }

  const count = resolveCount(userNotes);
  onProgress(`🤖 모델: ${MODEL} | 목표 문항 ${count}개${rubric ? " | 채점기준 첨부" : ""}`);

  const client = useGpt
    ? null
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 });

  const skill = loadSkill();
  const baseSystem = `당신은 특정 학교 기출 물리 시험의 문체·난이도·주제 분포를 모방해 새 모의고사를
출제하는 도우미입니다. 아래 스킬 명세의 모든 규칙(표절 금지, 계산기 없이 풀리는 깔끔한 숫자,
정답 정확성 최우선, 수식 LaTeX, 단계별 단일 JSON 출력)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========`;

  const uploadedIds = [];
  const state = { usedFileApi: false };
  let totalCost = emptyCost(MODEL);

  try {
    // ── 공통 소스 블록(기출·교재·채점기준 PDF) ────────────────────────────────
    async function buildSourceContent() {
      const c = [];
      await pushPdf(c, exam, "기출 시험지", { useGpt, signal, uploadedIds, state, onProgress });
      c.push({
        type: "text",
        text: `↑ 위 PDF 는 **기출 시험지("${exam.name}")**입니다. 이 시험의 발문 톤, 배점 표기, 문항 유형, 난이도, 주제 분포를 문체 기준으로 삼으세요. 문제를 그대로 베끼지 말고 같은 스타일로 새로 출제합니다.`,
      });
      await pushPdf(c, textbook, "교재 단원", { useGpt, signal, uploadedIds, state, onProgress });
      c.push({
        type: "text",
        text: `↑ 위 PDF 는 **교재 단원("${textbook.name}")**입니다. 출제할 물리 개념·물리량·예제·연습문제의 원천입니다. 발문은 이 단원 범위 안에서만 만드세요.`,
      });
      if (rubric) {
        await pushPdf(c, rubric, "채점 기준", { useGpt, signal, uploadedIds, state, onProgress });
        c.push({
          type: "text",
          text: `↑ 위 PDF 는 **채점 기준("${rubric.name}")**입니다. 각 문제의 grading(부분점수) 작성 시 이 기준의 배점 방식·표현을 따르세요.`,
        });
      }
      return c;
    }

    // ── 1) DRAFT ─────────────────────────────────────────────────────────────
    onProgress("✍️ 1단계: 기출 문체로 모의고사 초안 출제 중...");
    const draftContent = await buildSourceContent();
    if (userNotes) {
      draftContent.push({
        type: "text",
        text: `=== 사용자 출제 지시(보조) ===\n${userNotes}\n=== 끝 ===\n위 지시(단원/난이도/문항수)를 우선 반영하되, 데이터를 지어내는 근거로 쓰지 마세요.`,
      });
    }
    draftContent.push({
      type: "text",
      text: `## 지금 단계: DRAFT\n\n**문항 ${count}개**를 출제하세요. 시험 날짜: ${date || "(미지정)"}.\n배점 합이 합리적인 총점(~100)이 되게 하고, 모든 문제에 statement·answer·solution·grading·points 를 채우세요.\n출력은 DRAFT 스키마의 JSON 객체 하나뿐입니다.`,
    });

    const draftRes = await callModel(client, {
      system: baseSystem,
      content: draftContent,
      model: MODEL,
      signal,
      onProgress,
      label: "초안 출제",
      usedFileApi: state.usedFileApi,
    });
    totalCost = addCost(totalCost, calcCost({ usage: draftRes.usage, webSearchCount: 0, model: MODEL }));
    const draft = parsePhase(draftRes.text, "DRAFT");
    let problems = normalizeProblems(draft.problems);
    if (problems.length === 0) {
      throw new Error("초안에서 문제를 만들지 못했습니다. 다른 입력으로 다시 시도하세요.");
    }
    const meta = draft.meta && typeof draft.meta === "object" ? draft.meta : {};
    onProgress(`📋 초안 ${problems.length}문항 출제 완료`);

    // ── 2) VERIFY ────────────────────────────────────────────────────────────
    onProgress("🔬 2단계: 각 문제 독립 재풀이·검증 중...");
    const verifyContent = [
      {
        type: "text",
        text: `## 지금 단계: VERIFY\n\n아래는 검증할 모의고사 초안입니다. 각 문제를 **처음부터 직접 풀어** 정답·난이도·배점을 점검하세요.\n\n=== 초안 문제 ===\n${problemsToText(problems)}\n\n출력은 VERIFY 스키마의 JSON 객체 하나뿐입니다.`,
      },
    ];
    let checks = [];
    try {
      const verifyRes = await callModel(client, {
        system: baseSystem,
        content: verifyContent,
        model: MODEL,
        signal,
        onProgress,
        label: "검증",
      });
      totalCost = addCost(totalCost, calcCost({ usage: verifyRes.usage, webSearchCount: 0, model: MODEL }));
      const verify = parsePhase(verifyRes.text, "VERIFY");
      checks = Array.isArray(verify.checks) ? verify.checks : [];
      const flagged = checks.filter((c) => c && (c.correct === false || (Array.isArray(c.issues) && c.issues.length)));
      onProgress(`🔎 검증 완료 — 수정 필요 ${flagged.length}곳 표시`);
    } catch (e) {
      // 검증 실패는 치명적이지 않다 — 초안으로 진행하되 종합 단계를 건너뛴다.
      onProgress(`⚠ 검증 단계 실패(초안 사용): ${String(e.message).slice(0, 120)}`);
      checks = null;
    }

    // ── 3) RECONCILE ─────────────────────────────────────────────────────────
    // 검증에서 수정 필요가 하나라도 있으면 종합 호출로 최종본을 확정한다.
    const needsReconcile =
      Array.isArray(checks) &&
      checks.some((c) => c && (c.correct === false || (Array.isArray(c.issues) && c.issues.length)));
    if (needsReconcile) {
      onProgress("🧮 3단계: 검증 결과 반영해 최종본 종합 중...");
      try {
        const recContent = [
          {
            type: "text",
            text: `## 지금 단계: RECONCILE\n\n초안과 검증 결과를 종합해 **최종 모의고사**를 확정하세요. 검증이 지적한 오류(틀린 정답·깨지는 숫자·모호한 발문·배점 불일치)를 모두 고치세요.\n\n=== 초안 ===\n${problemsToText(problems)}\n\n=== 검증 결과 ===\n${JSON.stringify(checks).slice(0, 12000)}\n\n출력은 RECONCILE 스키마(meta + problems)의 JSON 객체 하나뿐입니다.`,
          },
        ];
        const recRes = await callModel(client, {
          system: baseSystem,
          content: recContent,
          model: MODEL,
          signal,
          onProgress,
          label: "최종 종합",
        });
        totalCost = addCost(totalCost, calcCost({ usage: recRes.usage, webSearchCount: 0, model: MODEL }));
        const reconciled = parsePhase(recRes.text, "RECONCILE");
        const recProblems = normalizeProblems(reconciled.problems);
        if (recProblems.length) {
          problems = recProblems;
          if (reconciled.meta && typeof reconciled.meta === "object") {
            Object.assign(meta, reconciled.meta);
          }
          onProgress(`✅ 최종 ${problems.length}문항 확정`);
        } else {
          onProgress("⚠ 종합 결과가 비어 초안을 최종본으로 사용");
        }
      } catch (e) {
        onProgress(`⚠ 종합 단계 실패(초안 사용): ${String(e.message).slice(0, 120)}`);
      }
    } else {
      onProgress("✅ 검증 통과 — 초안을 최종본으로 확정");
    }

    // ── content 조립 ──────────────────────────────────────────────────────────
    const totalPoints = problems.reduce((s, p) => s + (p.points || 0), 0);
    const content = {
      meta: {
        course: String(meta.course || ""),
        unit: String(meta.unit || ""),
        count: problems.length,
        total_points: totalPoints,
        style_notes: String(meta.style_notes || ""),
      },
      problems,
      date: date || "",
    };

    Object.defineProperty(content, "__cost", { value: totalCost, enumerable: false });
    Object.defineProperty(content, "__imageCost", {
      value: calcImageCost({ searchCount: 0, generationCount: 0 }),
      enumerable: false,
    });

    onProgress(`📋 콘텐츠: ${problems.length}문항, 총 ${totalPoints}점`);
    onProgress(formatCostLine(totalCost));
    return content;
  } finally {
    // Files API 업로드 정리(베스트에포트).
    if (uploadedIds.length) {
      await Promise.allSettled(uploadedIds.map((id) => deleteAnthropicFile(id).catch(() => {})));
    }
  }
}

const { generateBundle } = require("./bundle");

module.exports = { prepareInput, generateReportContent, generateBundle };
