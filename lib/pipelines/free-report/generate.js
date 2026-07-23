// 자유 보고서 (free-report) — 콘텐츠 생성
//
// 입력: 작성 지시(instructions) + (선택) 평가 기준 + 자료 파일(PDF/엑셀/CSV/텍스트)
//       + 본문 삽입용 사진 + 참고 링크 + 메모 + 내 글 스타일.
// 출력: prompt.md 스키마를 따르는 JSON ({ title, sections:[{heading,blocks[]}], references }).
//
// 골격은 phys-inquiry/generate.js(스트리밍 + heartbeat + Files API) 를 따르고,
// 엑셀/CSV 파싱·사진 임베드·차트 렌더(math-inquiry)·GPT 분기(chem-result)를 합쳤다.

const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const { calcCost, calcImageCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { parseToMarkdown } = require("../../excel-parser");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
  getBatchImageOptions,
} = require("../../anthropic-media");
const styleRef = require("../../style-ref");
const { deepCleanMarkers } = require("../../marker-clean");
const {
  isGptModel,
  usesOpenAiCompat,
  providerConfigured,
  callGptReport,
} = require("../../model-call");
const { renderChart } = require("../chem-result/chart-gen");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { streamWithContinuation, extractJson } = require("../../claude-stream");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "medium";

const SKILL_PATH = path.join(__dirname, "prompt.md");

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

const FORMAT_INSTRUCTIONS = {
  hwpx: `## 현재 출력 형식

**OUTPUT_FORMAT: hwpx**

- 별도 줄로 보여줄 식, 분수·적분·시그마·행렬식은 \`{ "equation": "..." }\` 블록에 넣고, 내용은 한컴 수식 스크립트 또는 LaTeX로 작성하세요. HWPX 출력 시 진짜 한글 수식 객체로 변환됩니다.
- 본문 문자열 안의 복잡한 인라인 식도 필요하면 \`{{EQ:...}}\` 로 감쌀 수 있습니다.

**한컴 수식 스크립트 문법** (LaTeX도 허용):
- 분수: \`{a} over {b}\`, 제곱근: \`sqrt {1 - v^2}\`, 첨자: \`x^2\`, \`v_{x}\`
- 적분/시그마: \`int _{0} ^{t} f dt\`, \`sum _{i=1} ^{n} x_i\`
- \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 표기는 금지입니다.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- 이중 중괄호 수식 마커(\`{{EQ:...}}\` 등)를 절대 쓰지 마세요.
- 인라인 텍스트 마커만 사용합니다: \`v_{x}\`, \`c^{2}\`, \`*v*\`, \`Δt\`, \`γ\`, \`→\`, \`×\`.
- 별도 줄 수식 블록 \`{ "equation": "..." }\` 의 내용도 위 인라인 마커로 작성하세요.`,
};

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  return text.replace(
    /핵심 강조는 `\*\*굵게\*\*`[^\n]*/,
    "핵심 강조: 관리자 전용 기능이므로 `**...**` 마커를 쓰지 마세요. 강조가 필요하면 일반 문장으로 표현하세요.",
  );
}

const STYLE_EMULATION_SECTION = `## 문체 흉내 (사용자 글 스타일 반영)

사용자가 **자기 글 샘플**(또는 문체 메모)을 제공했습니다. 보고서를 그 사람의 글처럼 들리게 쓰세요.

- 흉내 낼 것: 어조·말투(격식체/구어체), 문장 리듬과 길이, 설명 방식, 소제목 표기 습관, 강조 방식.
- **절대 가져오지 말 것**: 샘플의 \*\*주제·내용·수치·예시·문장 자체\*\*. 오직 "어떻게 쓰는가(문체)"만 흉내 내고, "무엇을 쓰는가(내용)"는 이 보고서의 지시·자료에서만 가져옵니다.
- 보고서 구조와 JSON 스키마는 그대로 유지하면서 각 본문의 **문장 스타일**만 사용자 글처럼 맞춥니다.`;

function buildSystemPrompt(
  outputFormat = "docx",
  { allowHighlights = true, hasStyle = false } = {},
) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const formatSection =
    FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  const styleSection = hasStyle ? `\n${STYLE_EMULATION_SECTION}\n` : "";
  return `당신은 학생을 위한 범용 "자유 보고서" 초안 작성 도우미입니다.

아래 스킬 명세의 모든 규칙(작성 지시 최우선, 평가 기준 충족, 환각 금지, JSON 스키마, 수식·차트 규칙)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

${formatSection}
${styleSection}
## 다시 강조

- 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다. JSON 외 텍스트는 무시됩니다.
- 사용자의 작성 지시를 1순위로, 평가 기준을 빠짐없이 충족하세요.
- 업로드 자료에 근거하고, 자료에 없는 수치·사실을 지어내지 마세요.${hasStyle ? "\n- 위 '문체 흉내' 지침에 따라 사용자 글 스타일로 쓰되, 샘플의 내용은 가져오지 마세요." : ""}`;
}

function buildInstructionsBlock(instructions) {
  const t = String(instructions || "").trim();
  if (!t) return "";
  return `=== 작성 지시 (가장 중요 — 이 보고서를 어떻게 쓸지에 대한 1순위 명세) ===
${t}
=== 작성 지시 끝 ===

위 지시에 따라 보고서의 종류·구성·말투·분량을 정하세요.`;
}

function buildGradingBlock(gradingCriteria) {
  const t = String(gradingCriteria || "").trim();
  if (!t) return "";
  return `=== 평가 기준 / 채점 루브릭 ===
${t}
=== 평가 기준 끝 ===

위 채점 항목이 보고서 어딘가에서 빠짐없이 드러나도록 내용을 배치하세요(평가표 문구를 그대로 베끼지 말고 자연스러운 문장으로 녹임).`;
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 / 의견 ===
${notes}
=== 메모 끝 ===

위 메모는 학생이 강조하고 싶은 맥락입니다. 보조로만 반영하고, 메모에 없는 구체적 수치·사건은 새로 만들지 마세요.`;
}

function buildRefLinksBlock(refLinks) {
  const links = String(refLinks || "").trim();
  if (!links) return "";
  return `=== 사용자가 제공한 참고 링크 ===
${links}
=== 링크 끝 ===

위 링크는 학생이 참고한 자료입니다. 내용을 추측해 지어내지 말고 참고문헌(references)에 정리하세요. 확인이 필요하면 web_search 도구로 검증할 수 있습니다.`;
}

function parseTextFile(buffer) {
  const MAX_CHARS = 60000;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const utf8 = buf.toString("utf8");
  let raw = utf8;
  try {
    const eucKr = new TextDecoder("euc-kr").decode(buf);
    const badUtf8 = (utf8.match(/�/g) || []).length;
    const badEucKr = (eucKr.match(/�/g) || []).length;
    if (badEucKr < badUtf8) raw = eucKr;
  } catch {
    /* keep utf-8 */
  }
  const cleaned = raw.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return "";
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) : cleaned;
}

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}

function isPdf(file) {
  return fileExt(file.name) === "pdf" || file.mimetype === "application/pdf";
}

function isImage(file) {
  return (
    ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExt(file.name)) ||
    String(file.mimetype || "").startsWith("image/")
  );
}

// 차트 스펙에 실제 데이터가 있는지 (빈 그래프 방지).
function chartHasData(ch) {
  if (!ch || typeof ch !== "object") return false;
  const xs = Array.isArray(ch.x_values)
    ? ch.x_values.filter((v) => v !== "" && v != null)
    : [];
  const series = Array.isArray(ch.series) ? ch.series : [];
  const seriesHasVals = series.some((s) => {
    const vals = s && (s.values || s.data || s.points);
    return Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0;
  });
  return xs.length > 0 || seriesHasVals;
}

/**
 * @param {Object} args
 * @param {string} args.title              보고서 제목(선택)
 * @param {string} args.instructions       작성 지시(필수)
 * @param {string} args.gradingCriteria    평가 기준(선택)
 * @param {Array}  args.files              자료 파일 [{buffer,name,mimetype}] (PDF/엑셀/CSV/텍스트)
 * @param {Array}  args.photos             본문 삽입용 사진 [{buffer,name,mimetype}]
 * @param {string} args.refLinks           참고 링크
 * @param {string} args.userNotes          참고 메모
 * @param {Array}  args.styleRefs          내 글 스타일 참고 파일 — 문체만 흉내
 * @param {string} args.styleNote          원하는 문체 한 줄 메모(선택)
 * @returns {Promise<Object>}              파싱된 보고서 JSON
 */
async function generateReportContent({
  title = "",
  instructions = "",
  gradingCriteria = "",
  files = [],
  photos = [],
  refLinks = "",
  userNotes = "",
  styleRefs = [],
  styleNote = "",
  date,
  onProgress = () => {},
  signal,
  model = null,
  outputFormat = "docx",
  allowHighlights = true,
}) {
  const MODEL = model || DEFAULT_MODEL;
  const USE_GPT = usesOpenAiCompat(MODEL);
  if (USE_GPT) {
    if (!providerConfigured(MODEL)) {
      throw new Error(`${MODEL} 제공자 API 키가 서버에 설정되지 않았습니다.`);
    }
  } else if (!byok.anthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  const instructionsText = String(instructions || "").trim();
  if (!instructionsText) throw new Error("작성 지시(instructions)가 비어 있습니다.");
  const styleNoteText = String(styleNote || "").trim().slice(0, 1500);
  const hasStyle =
    (Array.isArray(styleRefs) && styleRefs.length > 0) || !!styleNoteText;

  onProgress(`🤖 모델: ${MODEL} | 출력: ${OUTPUT_FORMAT}${hasStyle ? " | 내 문체 반영" : ""}`);

  const client =
    !USE_GPT && byok.anthropicKey()
      ? new Anthropic({ apiKey: byok.anthropicKey(), timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃보다 길게 */ })
      : null;
  const system = buildSystemPrompt(OUTPUT_FORMAT, { allowHighlights, hasStyle });

  const content = [];
  const attachmentSummary = [];

  // 큰 PDF 는 인라인 base64(요청 한도)로 못 보내므로 Files API(Claude) 로 업로드한다.
  // GPT 경로는 Files API file_id 를 못 쓰므로 항상 인라인.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;
  const INLINE_B64_BUDGET = 18 * 1024 * 1024;
  let inlineB64Used = 0;
  let usedFileApi = false;
  const uploadedFileIds = [];

  async function pushPdfBlock(f, { cacheControl = false } = {}) {
    const b64Len = Math.ceil(f.buffer.length / 3) * 4;
    const tooBigInline =
      f.buffer.length >= FILES_API_RAW_THRESHOLD ||
      inlineB64Used + b64Len > INLINE_B64_BUDGET;
    if (!USE_GPT && tooBigInline) {
      try {
        const fileId = await uploadFileToAnthropic(f.buffer, f.name, { signal });
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        onProgress(
          `📤 큰 PDF 업로드(Files API): ${f.name} (${Math.round((f.buffer.length / 1048576) * 10) / 10}MB)`,
        );
        return;
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
      }
    }
    const block = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: f.buffer.toString("base64"),
      },
    };
    if (cacheControl) block.cache_control = { type: "ephemeral" };
    content.push(block);
    inlineB64Used += b64Len;
  }

  // 1) 작성 지시 (최우선)
  content.push({ type: "text", text: buildInstructionsBlock(instructionsText) });

  // 2) 평가 기준
  const gradingBlock = buildGradingBlock(gradingCriteria);
  if (gradingBlock) {
    content.push({ type: "text", text: gradingBlock });
    attachmentSummary.push("평가 기준");
  }

  // 3) 제목 힌트
  const titleText = String(title || "").trim();
  if (titleText) {
    content.push({
      type: "text",
      text: `=== 사용자가 정한 보고서 제목 ===\n${titleText}\n(이 제목을 title 로 쓰세요. 더 적절하면 다듬어도 됩니다.)`,
    });
  }

  // 4) 자료 파일 — PDF / 엑셀·CSV / 텍스트 (이미지가 섞여 들어오면 사진으로 취급)
  const extraPhotos = [];
  for (const f of files) {
    if (!f || !f.buffer) continue;
    if (isPdf(f)) {
      await pushPdfBlock(f, { cacheControl: true });
      content.push({
        type: "text",
        text: `↑ 위 PDF는 자료("${f.name}")입니다. 보고서 내용의 근거로 활용하세요.`,
      });
      attachmentSummary.push(`자료 PDF ${f.name} (${Math.round(f.buffer.length / 1024)}KB)`);
    } else if (["xlsx", "xls", "csv"].includes(fileExt(f.name))) {
      try {
        const parsed = parseToMarkdown(f.buffer, fileExt(f.name));
        content.push({
          type: "text",
          text: `=== 자료 데이터 (${f.name}, 자동 파싱) ===\n\n${parsed.text}\n\n=== 데이터 끝 ===\n\n표의 수치를 보고서 표·그래프·분석에 정확히 반영하세요. 없는 값은 만들지 마세요.`,
        });
        attachmentSummary.push(`자료 ${fileExt(f.name)} (${parsed.sheetCount || 1}시트, ${parsed.totalRows || 0}행)`);
      } catch (e) {
        // 사용자가 근거 자료로 올린 스프레드시트를 조용히 빼고 보고서를 만들면
        // 데이터가 누락된 결과가 정상처럼 보인다. 안전/구조 검증 실패는 명확히
        // 중단해 파일을 줄이거나 정상 형식으로 다시 저장하도록 안내한다.
        throw new Error(`자료 데이터 파싱 실패(${f.name}): ${e.message}`);
      }
    } else if (["txt", "md", "tsv"].includes(fileExt(f.name))) {
      const t = parseTextFile(f.buffer);
      if (t) {
        content.push({
          type: "text",
          text: `=== 자료 텍스트 (${f.name}) ===\n${t}\n=== 끝 ===`,
        });
        attachmentSummary.push(`자료 텍스트 ${f.name}`);
      }
    } else if (isImage(f)) {
      extraPhotos.push(f);
    }
  }

  // 5) 사진(본문 삽입 후보 + vision). photos 필드 + files 에 섞여온 이미지.
  const allPhotos = [...(Array.isArray(photos) ? photos : []), ...extraPhotos].filter(
    (p) => p && Buffer.isBuffer(p.buffer) && p.buffer.length > 0,
  );
  let visionImageCount = 0;
  if (allPhotos.length > 0) {
    const imageOptions = getBatchImageOptions(allPhotos.length);
    content.push({
      type: "text",
      text: `=== 첨부 사진 ${allPhotos.length}장 (아래 순서대로 index 0 부터) ===
본문에 넣을 사진은 image 블록의 photo_indices 로 지정하세요. 사진 속 수치·축·단위를 읽되, 보이지 않는 값은 추정하지 마세요.`,
    });
    for (const [i, img] of allPhotos.entries()) {
      const prepared = await prepareImageForAnthropic(img, imageOptions);
      content.push({ type: "text", text: `[사진 index ${i}] ${img.name || ""}` });
      if (prepared.ok) {
        content.push(toAnthropicImageBlock(prepared));
        visionImageCount++;
      } else {
        content.push({
          type: "text",
          text: `⚠️ 이 사진은 vision 입력에서 제외(이유: ${prepared.reason}). 본문 삽입은 가능하지만 내용은 읽지 못합니다.`,
        });
      }
    }
    attachmentSummary.push(`사진 ${allPhotos.length}장`);
  }

  // 6) 참고 링크
  const linksBlock = buildRefLinksBlock(refLinks);
  if (linksBlock) {
    content.push({ type: "text", text: linksBlock });
    attachmentSummary.push("참고 링크");
  }

  // 7) 사용자 메모
  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("사용자 메모");
  }

  // 8) 내 글 스타일 참고 (문체만)
  if (hasStyle) {
    content.push(
      ...(await styleRef.buildStyleBlocks({ styleRefs, styleNote: styleNoteText })),
    );
    attachmentSummary.push("내 문체 참고");
  }

  // 9) 최종 지시
  content.push({
    type: "text",
    text: `위 작성 지시·평가 기준·자료를 바탕으로 "자유 보고서" 콘텐츠를 JSON으로 생성하세요.

보고서 날짜: ${date || "(미지정)"}

스킬 명세의 JSON 스키마와 수식·차트 규칙을 정확히 따르세요. 사실 확인이 필요하면 web_search 도구를 쓸 수 있습니다.${hasStyle ? "\n문장 스타일은 위 '내 글 스타일 참고'의 문체를 흉내 내되, 샘플 내용은 가져오지 마세요." : ""}
최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };

  onProgress(
    `📎 입력: ${attachmentSummary.length ? attachmentSummary.join(", ") : "작성 지시만"} — ${USE_GPT ? "GPT" : "Claude"}에게 전송`,
  );

  // ── Stream + heartbeat ──────────────────────────────────────────────────────
  const startedAt = Date.now();
  let charCount = 0;
  let lastReportedChars = 0;
  let lastEventAt = Date.now();
  let webSearchCount = 0;
  let textBlocksStarted = 0;
  let firstTokenSeen = false;
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);

  const heartbeat = setInterval(() => {
    const sinceLast = (Date.now() - lastEventAt) / 1000;
    if (sinceLast >= 12) {
      const note = !firstTokenSeen
        ? `자료 분석 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    if (USE_GPT) {
      const gpt = await callGptReport({
        model: MODEL,
        system,
        content,
        maxTokens: MAX_TOKENS,
        signal,
        onProgress,
      });
      finalText = gpt.text;
      firstTokenSeen = true;
      cost = calcCost({ usage: gpt.usage, webSearchCount: 0, model: MODEL });
    } else {
      // 끊김(Premature close)·길이(max_tokens) 복구 포함 스트리밍(공용 헬퍼, web_search 사용).
      // 외부 heartbeat 는 헬퍼 자체 heartbeat 가 대신하므로 멈춘다.
      clearInterval(heartbeat);
      const result = await streamWithContinuation({
        client,
        model: MODEL,
        maxTokens: MAX_TOKENS,
        system,
        userContent: userMessage,
        signal,
        betaHeaders: usedFileApi ? FILES_BETA : null,
        useWebSearch: true,
        enableThinking: ENABLE_THINKING,
        thinkingEffort: THINKING_EFFORT,
        onProgress,
        startedAt,
      });
      finalText = result.text;
      firstTokenSeen = true;
      webSearchCount = result.webSearchCount;
      cost = calcCost({ usage: result.usage, webSearchCount, model: MODEL });
    }
  } finally {
    clearInterval(heartbeat);
    if (uploadedFileIds.length) {
      await Promise.all(uploadedFileIds.map((id) => deleteAnthropicFile(id)));
    }
  }

  onProgress(`✓ 응답 완료 (총 ${charCount || finalText.length}자, ${elapsed()}초) — JSON 파싱 중`);
  onProgress(formatCostLine(cost));

  const json = extractJson(finalText);
  if (!json) {
    throw new Error(
      "JSON 코드 블록을 찾을 수 없습니다. 응답 앞부분: " + finalText.slice(0, 300),
    );
  }
  let parsed;
  try {
    parsed = parseJsonLenient(json);
  } catch (e) {
    throw new Error("JSON 파싱 실패: " + e.message);
  }

  parsed = require("../../output-sanitize").sanitize(parsed, {
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
    allowHighlights,
  });

  const markerFixes = { count: 0 };
  deepCleanMarkers(parsed, markerFixes);
  if (markerFixes.count) onProgress(`🧹 표기 정리: 별표/첨자 ${markerFixes.count}곳`);

  if (!parsed.title) parsed.title = titleText || "보고서";
  if (!Array.isArray(parsed.sections)) parsed.sections = [];
  if (date) parsed.date = date;

  // 사진을 parsed 에 attach (docx/hwpx 렌더러가 photo_indices 로 매칭)
  if (allPhotos.length > 0) {
    Object.defineProperty(parsed, "__photos", {
      value: allPhotos.map((p) => ({
        buffer: p.buffer,
        name: p.name,
        mimetype: p.mimetype,
      })),
      enumerable: false,
    });
  }

  // 빈 차트 제거 + 차트 PNG 렌더 (sections[].blocks[] 안의 {chart} 를 재귀 수집)
  let droppedCharts = 0;
  (function pruneEmptyCharts(node) {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (
          item && typeof item === "object" && !Array.isArray(item) &&
          item.chart && typeof item.chart === "object" && !chartHasData(item.chart)
        ) {
          node.splice(i, 1);
          droppedCharts++;
        } else {
          pruneEmptyCharts(item);
        }
      }
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(pruneEmptyCharts);
  })(parsed);
  if (droppedCharts) onProgress(`⚠️ 데이터 없는 빈 차트 ${droppedCharts}개 제외`);

  // 콘텐츠 구조 검증(DEF-010) - 파싱·sanitize·빈 차트 정리까지 끝난 최종 콘텐츠 기준.
  // hard 결함(제목·섹션 결손, 수식 마커 잔존 등)은 차트 렌더 전에 즉시 실패시킨다.
  require("../../output-sanitize").assertContentSchema("free", parsed, {
    format: OUTPUT_FORMAT,
    onProgress,
  });

  // 차트 spec의 series에 실제로 그릴 값이 있는지 - 렌더 재실패를 fatal로 볼지
  // 판정(DEF-009). x_values만 있고 series 값이 빈 spec은 fatal 대상이 아니다.
  const chartSeriesHasValues = (ch) => {
    const series = Array.isArray(ch && ch.series) ? ch.series : [];
    return series.some((s) => {
      const vals = s && (s.values || s.data || s.points);
      return (
        Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0
      );
    });
  };

  const chartBlocks = [];
  (function collect(node) {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      if (node.chart && typeof node.chart === "object") chartBlocks.push(node.chart);
      else Object.values(node).forEach(collect);
    }
  })(parsed);
  if (chartBlocks.length) {
    let rendered = 0;
    for (const chart of chartBlocks) {
      const tryRender = async () => {
        try {
          return await renderChart(chart);
        } catch (e) {
          onProgress(`⚠ 차트 렌더 오류: ${String(e && e.message).slice(0, 200)}`);
          return null;
        }
      };
      let buf = await tryRender();
      if (!buf) {
        // 렌더 실패를 무음 스킵하지 않는다. 알린 뒤 1회 재시도.
        onProgress(`⚠ 차트 렌더 실패: ${chart.title || "(제목 없음)"} (1회 재시도)`);
        buf = await tryRender();
      }
      if (buf) {
        Object.defineProperty(chart, "pngBuffer", { value: buf, enumerable: false });
        rendered++;
      } else if (chartSeriesHasValues(chart)) {
        // 유효 데이터가 있는 차트의 렌더 실패는 fatal(DEF-009) - 그래프 빠진
        // 보고서를 조용히 내보내지 않는다.
        throw new Error(
          `차트 렌더링 실패: ${chart.title || "(제목 없음)"} - 잠시 후 다시 시도해 주세요.`,
        );
      } else {
        // 값 없는 spec은 기존대로 렌더 제외 + 경고.
        onProgress(`⚠ 차트 렌더 재실패(그릴 값 없음, 제외): ${chart.title || "(제목 없음)"}`);
      }
    }
    if (rendered) onProgress(`📈 그래프 ${rendered}개 렌더 완료`);
  }

  const sectionCount = Array.isArray(parsed.sections) ? parsed.sections.length : 0;
  onProgress(
    `📋 구조: 섹션 ${sectionCount}개, 그래프 ${chartBlocks.length}개, 참고문헌 ${(parsed.references || []).length}개`,
  );

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
  Object.defineProperty(parsed, "__cost", { value: cost, enumerable: false });
  Object.defineProperty(parsed, "__imageCost", { value: imageCost, enumerable: false });
  Object.defineProperty(parsed, "__style", { value: "default", enumerable: false });

  return parsed;
}

// (JSON 추출은 lib/claude-stream.js 의 extractJson 사용 — 위에서 import.)

module.exports = { generateReportContent };
