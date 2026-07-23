// form-maker — 콘텐츠 생성
//
// MODE A(양식 생성): 작성 지시(promptText) → 빈 양식/서식 템플릿 JSON
// MODE B(문서 복원): 업로드 사진(photos) → 종이 문서를 보이는 그대로 재구성한 JSON
// 출력: prompt.md 스키마({ doc_type, title, meta?, blocks:[...] }).
//
// 골격은 free-report/generate.js(스트리밍 + heartbeat + GPT 분기)를 따른다.
// 양식/복원은 데이터 분석이 아니라 구조 재현이므로 차트·엑셀·웹검색은 뺀다.

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
const { deepCleanMarkers } = require("../../marker-clean");
const { isGptModel, callGptReport } = require("../../model-call");
const sharp = require("sharp");
const { editImage, imageKeyAvailable } = require("../../report-image-gen");

// 사진 속 그림을 "깔끔히 다시 그릴" 때 gpt-image 에 주는 프롬프트.
// 생성 모델이라 어차피 변형 위험이 있으므로 "그대로 재현" 을 최대한 강제한다.
const FIGURE_REDRAW_PROMPT =
  "Redraw this hand-photographed diagram as a clean, deskewed, high-contrast black-and-white line drawing on a plain white background. Reproduce EVERY line, curve, axis, arrow, shape and label EXACTLY as shown — do not add, remove, move, or reinterpret anything. Output only the cleaned diagram, no extra text.";

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "medium";
const rawFormMakerRedrawMax = parseInt(process.env.FORM_MAKER_REDRAW_MAX || "", 10);
const FORM_MAKER_REDRAW_MAX = Math.max(
  0,
  Number.isFinite(rawFormMakerRedrawMax) ? rawFormMakerRedrawMax : 2,
);

const SKILL_PATH = path.join(__dirname, "prompt.md");

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

const FORMAT_INSTRUCTIONS = {
  hwpx: `## 현재 출력 형식

**OUTPUT_FORMAT: hwpx**

- text 문자열 안의 수식은 한컴 수식 스크립트/LaTeX 를 \`{{EQ:...}}\` 로 감싸면 진짜 한글 수식 객체로 변환됩니다.
- 분수 \`{a} over {b}\`, 제곱근 \`sqrt {x}\`, 첨자 \`x^2\`, \`v_{x}\`.
- ⚠️ 수식을 \`\\( … \\)\`·\`\\[ … \\]\`·\`$ … $\`·\`$$ … $$\` 같은 **날것 LaTeX 델리미터로 쓰지 마세요.** 또한
  \`\\frac{a}{b}\`·\`\\sqrt\`·\`\\int\` 같은 LaTeX 명령을 마커 밖 본문에 그대로 두지 마세요. 별도 줄 수식은
  반드시 \`{{EQ:...}}\`(한컴 스크립트) 또는 \`{{EQ-LATEX:...}}\`(LaTeX) 마커로 감싸야 합니다.
- \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 표기는 금지입니다.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- 이중 중괄호 수식 마커(\`{{EQ:...}}\` 등)를 쓰지 마세요.
- 인라인 텍스트 마커만 사용: \`v_{x}\`, \`c^{2}\`, \`H_{2}O\`, \`*변수*\`, \`Δt\`, \`×\`.`,
};

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  return text.replace(
    /굵게 `\*\*중요\*\*`[^\n]*/,
    "강조: 관리자 전용이라 `**...**` 마커를 쓰지 마세요. 강조가 필요하면 일반 문장으로 표현하세요.",
  );
}

function buildSystemPrompt(outputFormat = "docx", { allowHighlights = true } = {}) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const formatSection = FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  return `당신은 한컴 한글(HWPX)/Word(DOCX) 문서를 만들어 주는 "양식·문서 생성기"입니다.

아래 스킬 명세의 모든 규칙(두 작업 모드, 정직성 원칙, JSON 스키마, 블록 종류, 표기 규칙)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

${formatSection}

## 다시 강조

- 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다. JSON 외 텍스트는 무시됩니다.
- 양식 모드: 사용자가 채울 내용을 지어내지 말고 자리표시자(○○○, (    ))와 안내만 넣으세요.
- 복원 모드: 사진에 실제로 보이는 것만 옮기고, 안 보이는 값은 빈칸으로 두세요. 없는 표·항목을 만들지 마세요.
  단 하나의 예외는 수식 소실 자리입니다. 원본에서 수식만 빠져 문장이 끊긴 곳(조사·쉼표 앞이 비는 곳)은
  빈 채로 전사하지 말고, 문맥상 확실한 교과 표준 수식은 수식 표기 규칙대로 복원하고, 확신이 없으면
  (수식 누락)이라고 표기하세요.`;
}

function buildInstructionsBlock(promptText, mode) {
  const t = String(promptText || "").trim();
  if (mode === "reconstruct") {
    return `=== 작업: 문서 복원 (MODE B) ===
사용자가 올린 사진 속 종이 문서를 보이는 그대로 디지털 문서로 복원하세요.${
      t ? `\n\n사용자 추가 지시:\n${t}` : ""
    }`;
  }
  return `=== 작업: 양식 생성 (MODE A) — 가장 중요 ===
${t}

위 지시에 맞는 한글 양식(빈 서식 템플릿)을 만드세요. 섹션·표·자리표시자를 충분히 갖추되,
사용자가 채울 실제 내용은 지어내지 마세요.`;
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 ===
${notes}
=== 메모 끝 ===

위 메모는 보조 맥락입니다. 메모에 없는 항목을 새로 지어내지 마세요.`;
}

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}

function isImage(file) {
  return (
    ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExt(file.name)) ||
    String(file.mimetype || "").startsWith("image/")
  );
}

/**
 * @param {Object} args
 * @param {string}  args.promptText   작성 지시(양식 모드 필수, 복원 모드 선택)
 * @param {Array}   args.photos       복원/삽입용 사진 [{buffer,name,mimetype}]
 * @param {string}  args.title        제목 힌트(선택)
 * @param {string}  args.userNotes
 * @param {string}  args.date
 * @param {Function} args.onProgress
 * @param {AbortSignal} args.signal
 * @param {string}  args.model
 * @param {string}  args.outputFormat "docx" | "hwpx"
 * @param {boolean} args.allowHighlights
 * @returns {Promise<Object>}         파싱된 문서 JSON ( + non-enumerable __* )
 */
async function generateReportContent({
  promptText = "",
  photos = [],
  title = "",
  userNotes = "",
  date,
  onProgress = () => {},
  signal,
  model = null,
  outputFormat = "docx",
  allowHighlights = true,
  figureRedraw = false,
  layoutMode = "auto",
}) {
  const MODEL = model || DEFAULT_MODEL;
  // 원문 2단 레이아웃 vs 정리본. 사용자 요청값(layout/clean/auto)을 보존했다가,
  // auto 면 파싱 후 '원본이 2단이었는지'(columns 블록 유무)로 자동 결정한다(아래).
  const LAYOUT_REQ = String(layoutMode || "auto").toLowerCase();
  const USE_GPT = isGptModel(MODEL);
  if (USE_GPT) {
    const { gptConfigured } = require("../../model-call");
    if (!gptConfigured()) {
      throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
    }
  } else if (!byok.anthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";

  const allPhotos = (Array.isArray(photos) ? photos : []).filter(
    (p) => p && Buffer.isBuffer(p.buffer) && p.buffer.length > 0 && isImage(p),
  );
  const promptTrim = String(promptText || "").trim();
  const mode = allPhotos.length > 0 && !promptTrim ? "reconstruct"
    : allPhotos.length > 0 ? "reconstruct" : "instruct";
  if (mode === "instruct" && !promptTrim) {
    throw new Error("양식 설명(작성 지시) 또는 복원할 문서 사진이 필요합니다.");
  }

  onProgress(
    `🤖 모델: ${MODEL} | 출력: ${OUTPUT_FORMAT} | 모드: ${mode === "reconstruct" ? "문서 복원" : "양식 생성"}`,
  );

  const client =
    !USE_GPT && byok.anthropicKey()
      ? new Anthropic({ apiKey: byok.anthropicKey(), timeout: 50 * 60 * 1000 })
      : null;
  const system = buildSystemPrompt(OUTPUT_FORMAT, { allowHighlights });

  const content = [];
  const attachmentSummary = [];

  // 1) 작업 지시 (모드별)
  content.push({ type: "text", text: buildInstructionsBlock(promptTrim, mode) });
  attachmentSummary.push(mode === "reconstruct" ? "문서 복원" : "양식 생성");

  // 2) 제목 힌트
  const titleText = String(title || "").trim();
  if (titleText) {
    content.push({
      type: "text",
      text: `=== 사용자가 정한 제목 ===\n${titleText}\n(이 제목을 title 로 쓰되, 더 적절하면 다듬어도 됩니다.)`,
    });
  }

  // 3) 사진 (vision) — 복원 모드의 원본 / 양식에 넣을 사진
  let visionImageCount = 0;
  if (allPhotos.length > 0) {
    const imageOptions = getBatchImageOptions(allPhotos.length);
    content.push({
      type: "text",
      text: `=== 첨부 사진 ${allPhotos.length}장 (index 0 부터) ===
${
  mode === "reconstruct"
    ? "이 사진들은 복원할 종이 문서입니다. 보이는 제목·항목·번호·표의 모든 칸과 글자·빈칸을 빠짐없이 옮기세요. 흐리거나 잘려서 안 보이는 부분은 추측하지 말고 빈칸으로 두세요.\n단, 전사 원칙의 예외가 하나 있습니다: 원본이 인쇄될 때 수식 객체만 빠져 문장이 끊긴 자리(예: \"참값이 , 측정값이 라면\", \"~며 의 형태로\"처럼 조사·쉼표 앞이 비는 곳)는 결손 문장 그대로 옮기지 마세요. 문맥상 확실한 교과 표준 수식(십진 표기 a×10^n, 백분율 오차식, 불확실도식 등)은 수식 표기 규칙대로 복원하고, 확신이 없으면 그 자리에 (수식 누락)이라고 표기하세요."
    : "본문에 넣을 사진은 figure 블록의 photo_indices 로 지정하세요. 보이지 않는 값은 추정하지 마세요."
}`,
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
          text: `⚠️ 이 사진은 vision 입력에서 제외(이유: ${prepared.reason}).`,
        });
      }
    }
    attachmentSummary.push(`사진 ${allPhotos.length}장`);
  }

  // 4) 사용자 메모
  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("메모");
  }

  // 5) 최종 지시
  content.push({
    type: "text",
    text: `위 내용을 바탕으로 문서를 JSON으로 생성하세요. 문서 날짜: ${date || "(미지정)"}
스킬 명세의 JSON 스키마와 표기 규칙을 정확히 따르세요.
최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };
  onProgress(
    `📎 입력: ${attachmentSummary.join(", ")} — ${USE_GPT ? "GPT" : "Claude"}에게 전송`,
  );

  // ── Stream + heartbeat ──────────────────────────────────────────────────────
  const startedAt = Date.now();
  let charCount = 0;
  let lastReportedChars = 0;
  let lastEventAt = Date.now();
  let textBlocksStarted = 0;
  let firstTokenSeen = false;
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);

  const heartbeat = setInterval(() => {
    const sinceLast = (Date.now() - lastEventAt) / 1000;
    if (sinceLast >= 12) {
      const note = !firstTokenSeen
        ? `분석 중... (${elapsed()}초 경과)`
        : `문서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
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
      const stream = client.messages.stream(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          ...(ENABLE_THINKING
            ? { thinking: { type: "adaptive" }, output_config: { effort: THINKING_EFFORT } }
            // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
            : /fable/i.test(MODEL || "") ? {} : { thinking: { type: "disabled" } }),
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [userMessage],
        },
        (() => {
          const o = {};
          if (signal) o.signal = signal;
          return Object.keys(o).length ? o : undefined;
        })(),
      );

      stream.on("streamEvent", (event) => {
        lastEventAt = Date.now();
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "text") {
            textBlocksStarted++;
            if (textBlocksStarted === 1) {
              onProgress(`✍️ 문서 작성 시작 (${elapsed()}초)`);
              firstTokenSeen = true;
            }
          } else if (block?.type === "thinking") {
            if (!firstTokenSeen) onProgress(`🤔 추론 중... (${elapsed()}초)`);
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          charCount += event.delta.text.length;
          if (charCount - lastReportedChars >= 1500) {
            onProgress(`문서 작성 중... (${charCount}자, ${elapsed()}초)`);
            lastReportedChars = charCount;
          }
        }
      });

      const finalMessage = await stream.finalMessage();
      if (finalMessage.stop_reason === "max_tokens") {
        throw new Error("응답이 너무 길어 잘렸습니다. MAX_TOKENS를 늘려야 합니다.");
      }
      finalText = finalMessage.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      cost = calcCost({ usage: finalMessage.usage, webSearchCount: 0, model: MODEL });
    }
  } finally {
    clearInterval(heartbeat);
  }

  onProgress(`✓ 응답 완료 (${charCount || finalText.length}자, ${elapsed()}초) — JSON 파싱 중`);
  onProgress(formatCostLine(cost));

  const json = extractJson(finalText);
  if (!json) {
    throw new Error("JSON 코드 블록을 찾을 수 없습니다. 응답 앞부분: " + finalText.slice(0, 300));
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
  if (markerFixes.count) onProgress(`🧹 표기 정리 ${markerFixes.count}곳`);

  // 일부 모델(특히 gpt-5.4-mini)은 수식을 `\( … \)`·`\[ … \]`·`$$…$$`·`\frac{a}{b}` 같은
  // 날것 LaTeX 로 쓴다. HWPX 는 수식 후처리 검증에서 raw LaTeX 잔류를 fatal 로 막으므로
  // 렌더가 통째로 죽는다(라이브 실측: gpt-5.4-mini 렌더 크래시). 모델 무관 안전망 —
  // hwpx 면 델리미터를 {{EQ-LATEX:…}} 로 감싸 진짜 수식 객체로, 그 외 잔류 LaTeX 는 읽을 수
  // 있는 텍스트로 정리(검증 통과 보장). docx 면 마커 없이 인라인 텍스트로만 정리.
  const latexFix = { count: 0 };
  normalizeModelLatex(parsed, OUTPUT_FORMAT === "hwpx", latexFix);
  if (latexFix.count) onProgress(`🧮 날것 LaTeX ${latexFix.count}곳 정리(수식 변환)`);

  // deepCleanMarkers 는 prose 표기 정리용이라 구조 필드 값의 `_box` 를 첨자 `_{box}` 로
  // 바꿔버릴 수 있다(예: type "summary_box" → "summary_{box}"). 블록 type 은 데이터이므로 되돌린다.
  // ⚠ columns 안의 하위 블록(중첩 summary_box 등)도 같은 손상을 입으므로 재귀로 되돌린다.
  const KNOWN_BLOCK_TYPES = [
    "heading", "paragraph", "table", "figure", "summary_box", "columns", "spacer", "pagebreak",
  ];
  function normalizeBlockType(b) {
    if (!b || typeof b !== "object" || typeof b.type !== "string") return null;
    const norm = b.type.replace(/[{}*_\s]/g, "").toLowerCase();
    const match = KNOWN_BLOCK_TYPES.find((t) => t.replace(/_/g, "") === norm);
    if (match && b.type !== match) b.type = match;
    return match || b.type;
  }
  function normalizeBlockTypesDeep(blocks) {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      const t = normalizeBlockType(b);
      if (t === "columns" && b && Array.isArray(b.columns)) {
        for (const col of b.columns) {
          if (Array.isArray(col)) normalizeBlockTypesDeep(col);
          else normalizeBlockTypesDeep([col]);
        }
      }
    }
  }
  if (Array.isArray(parsed.blocks)) normalizeBlockTypesDeep(parsed.blocks);

  if (!parsed.title) parsed.title = titleText || "문서";
  if (!Array.isArray(parsed.blocks)) parsed.blocks = [];
  if (date) parsed.date = date;

  // 서버측 안전망(MODE B 한정, DEF-029): 원본 종이가 인쇄될 때 수식 객체만 빠진 문서를
  // "보이는 대로" 전사하면 조사·쉼표 앞 명사가 빈 결손 문장이 그대로 남는다
  // (라이브 실측: "참값이 , 측정값이 라면 백분율 오차는 로"). 결손 특유 패턴을 세어
  // 경고를 내고, 교과 표준식으로 확실한 3형(십진 표기 a×10^n / 백분율 오차식 /
  // 표준편차꼴 불확실도식)만 문맥 키워드 기반으로 복원한다. 키워드가 불명확한 자리는
  // 지어내지 않고 "(수식 누락)"만 표기한다(prompt.md 절대 원칙의 예외 규칙과 동일).
  if (mode === "reconstruct") {
    const eqLoss = { suspected: 0, restored: 0, marked: 0 };
    restoreLostEquations(parsed, { hwpx: OUTPUT_FORMAT === "hwpx", stats: eqLoss });
    if (eqLoss.suspected) {
      onProgress(`⚠️ 원본 수식 소실 의심 ${eqLoss.suspected}곳, 복원 표기 확인 필요`);
      if (eqLoss.restored) onProgress(`🧮 교과 표준 수식 ${eqLoss.restored}곳 복원`);
      if (eqLoss.marked) onProgress(`🏷 (수식 누락) 표기 ${eqLoss.marked}곳`);
    }
  }

  // 서버측 안전망(MODE B 한정): 모델이 columns 를 남발하거나 머리말/쪽번호/저작권을 본문
  // 블록으로 재현하면 빈 페이지·군더더기가 생긴다(라이브 실측: ~11쪽 중 절반이 빈 장).
  // ① 키 큰 columns → 전체폭 순차 블록으로 linearize, ② 페이지 furniture 단락 제거.
  // resolveFigureCrops 보다 먼저 — crop.photo / photo_indices 는 allPhotos 의 절대 인덱스라
  // 블록을 이동/제거해도 무효화되지 않는다(figure 객체 자체는 보존하므로 안전).
  // 양식(MODE A)은 짧은 2단 폼·안내 furniture 가 정상이므로 건드리지 않는다.
  // 레이아웃 모드 확정: auto 면 '원본이 2단이었나'(columns 블록 유무)로 결정한다.
  // 원본 2단 시험지 → 2단 복원(기본), 1단 문서 → 정리본. 명시 요청(layout/clean)은 존중.
  const hasColumns = mode === "reconstruct" && blocksHaveColumns(parsed.blocks);
  let LAYOUT_MODE;
  if (LAYOUT_REQ === "layout") LAYOUT_MODE = "layout";
  else if (LAYOUT_REQ === "clean") LAYOUT_MODE = "clean";
  else LAYOUT_MODE = hasColumns ? "layout" : "clean"; // auto
  if (mode === "reconstruct") {
    const layoutStats = { flattened: 0, dropped: 0 };
    // layout(2단)이면 columns 를 보존해 진짜 좌우 2단으로 렌더한다(과대한 단만 flatten).
    // clean 이면 전체폭으로 linearize(키 큰 단 모두 flatten). furniture 는 두 경우 모두 제거.
    parsed.blocks = sanitizeLayout(parsed.blocks, {
      runningHeader: String(parsed.title || "").trim(),
      stats: layoutStats,
      keepColumns: LAYOUT_MODE === "layout",
    });
    if (LAYOUT_MODE === "layout") onProgress("📐 원문 2단 레이아웃 유지");
    if (layoutStats.flattened) onProgress(`🧱 키 큰 단(columns) ${layoutStats.flattened}개를 전체폭으로 펼침`);
    if (layoutStats.dropped) onProgress(`🧹 머리말·쪽번호·저작권 군더더기 ${layoutStats.dropped}곳 제거`);
  } else {
    LAYOUT_MODE = "clean";
  }

  // 콘텐츠 구조 검증(DEF-010) - 파싱·sanitize·레이아웃 정리까지 끝난 최종 콘텐츠 기준.
  // hard 결함(블록 전무, 수식 마커 잔존 등)은 그림 크롭/AI 재생성 전에 즉시 실패시킨다.
  require("../../output-sanitize").assertContentSchema("form-maker", parsed, {
    format: OUTPUT_FORMAT,
    onProgress,
  });

  // MODE B: figure 의 crop(원본 사진 영역)을 잘라 실제 그림으로 임베드(+ 옵트인 AI 재생성).
  // allPhotos 에 잘라낸 버퍼를 추가하므로 __photos 첨부보다 먼저 수행.
  let cropStats = { cropped: 0, redrawn: 0 };
  if (allPhotos.length > 0) {
    cropStats = await resolveFigureCrops(parsed, allPhotos, {
      allowRedraw: figureRedraw,
      maxRedraw: FORM_MAKER_REDRAW_MAX,
      signal,
      onProgress,
    });
  }

  if (allPhotos.length > 0) {
    Object.defineProperty(parsed, "__photos", {
      value: allPhotos.map((p) => ({ buffer: p.buffer, name: p.name, mimetype: p.mimetype })),
      enumerable: false,
    });
  }

  const blockCount = Array.isArray(parsed.blocks) ? parsed.blocks.length : 0;
  onProgress(`📋 구조: 블록 ${blockCount}개 (${mode === "reconstruct" ? "복원" : "양식"})`);

  Object.defineProperty(parsed, "__cost", { value: cost, enumerable: false });
  Object.defineProperty(parsed, "__imageCost", {
    value: calcImageCost({ searchCount: 0, generationCount: cropStats.redrawn || 0 }),
    enumerable: false,
  });
  Object.defineProperty(parsed, "__imageEdits", {
    value: cropStats.redrawn || 0,
    enumerable: false,
  });
  Object.defineProperty(parsed, "__style", { value: "default", enumerable: false });
  Object.defineProperty(parsed, "__layoutMode", { value: LAYOUT_MODE, enumerable: false });
  return parsed;
}

// ── 날것 LaTeX 안전망 (모델 무관) ────────────────────────────────────────────
// 마커 밖에 남은 raw LaTeX 를 읽을 수 있는 텍스트로 정리(HWPX 수식 검증 통과 보장).
function cleanResidualLatex(s) {
  let out = s;
  out = out.replace(/\\d?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "($1)/($2)");
  out = out.replace(/\\sqrt\s*\{([^{}]*)\}/g, "√($1)");
  out = out.replace(/\\(left|right|big|Big|,|;|!|quad|qquad|displaystyle|;)/g, "");
  out = out.replace(/\\times/g, "×").replace(/\\cdot/g, "·").replace(/\\div/g, "÷")
    .replace(/\\theta/g, "θ").replace(/\\Delta/g, "Δ").replace(/\\delta/g, "δ")
    .replace(/\\mu/g, "μ").replace(/\\pi/g, "π").replace(/\\alpha/g, "α").replace(/\\beta/g, "β")
    .replace(/\\approx/g, "≈").replace(/\\leq/g, "≤").replace(/\\geq/g, "≥").replace(/\\propto/g, "∝")
    .replace(/\\infty/g, "∞").replace(/\\rightarrow/g, "→").replace(/\\Rightarrow/g, "⇒");
  out = out.replace(/\\[()[\]]/g, "");        // \( \) \[ \]
  // 짝지어진 수식 델리미터만 벗긴다 — 통화($5, $1,200)·단독 $ 는 보존.
  out = out.replace(/\$\$([\s\S]*?)\$\$/g, "$1");
  out = out.replace(/\$([^$\n]*[\\{_^][^$\n]*)\$/g, "$1");
  // 수식 검증이 fatal 로 보는 구조 명령(_LATEX_RESIDUE_RE)만 제거 — 잘린 인자 잔재 방지.
  // 미지의 \word(파일경로 \Users, 정규식 \d, 줄바꿈 \\ 등)와 단독 $ 는 보존해 prose 손상 방지.
  out = out.replace(/\\(?:frac|sqrt|left|right|begin|end|sum|lim|int|text|ce)\b/g, "");
  return out;
}

function fixLatexInStr(s, toMarkers, stats) {
  if (typeof s !== "string" || !s) return s;
  // 진짜 수식 신호일 때만 정리 패스에 진입 — 통화($5)·파일경로(\Users)·정규식(\d)은 건드리지 않음.
  const hasLatex =
    s.includes("\\(") || s.includes("\\[") ||
    /\$\$/.test(s) || /\$[^$\n]*[\\{_^][^$\n]*\$/.test(s) ||
    /\\(?:frac|sqrt|left|right|begin|end|sum|lim|int|text|ce|times|cdot|div|theta|Delta|delta|mu|pi|alpha|beta|approx|leq|geq|propto|infty|rightarrow|Rightarrow|displaystyle|quad|qquad)\b/.test(s);
  if (!hasLatex) return s;
  let out = s;
  if (toMarkers) {
    out = out
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `{{EQ-LATEX:${m.trim()}}}`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => `{{EQ-LATEX:${m.trim()}}}`)
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => `{{EQ-LATEX:${m.trim()}}}`)
      .replace(/\$([^$\n]*[\\{_^][^$\n]*)\$/g, (_, m) => `{{EQ-LATEX:${m.trim()}}}`);
  }
  // {{EQ…}} 마커는 보존하고, 마커 밖(짝수 인덱스)만 잔류 LaTeX 정리.
  const parts = out.split(/(\{\{EQN?(?:-LATEX)?:[\s\S]*?\}\})/);
  for (let i = 0; i < parts.length; i += 2) parts[i] = cleanResidualLatex(parts[i]);
  out = parts.join("");
  if (out !== s && stats) stats.count++;
  return out;
}

function normalizeModelLatex(node, toMarkers, stats) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string") node[i] = fixLatexInStr(node[i], toMarkers, stats);
      else normalizeModelLatex(node[i], toMarkers, stats);
    }
    return;
  }
  if (node && typeof node === "object") {
    // prose 가 아닌 데이터 키는 LaTeX 정리에서 제외(URL·핸드오프·구조 필드).
    const SKIP_KEYS = new Set(["url", "ai_handoff", "type", "crop", "photo_indices"]);
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) {
        if (node[k] && typeof node[k] === "object") normalizeModelLatex(node[k], toMarkers, stats);
        continue;
      }
      if (typeof node[k] === "string") node[k] = fixLatexInStr(node[k], toMarkers, stats);
      else normalizeModelLatex(node[k], toMarkers, stats);
    }
  }
}

// ── 수식 소실 복원 안전망 (server-side, MODE B 전용, DEF-029) ─────────────────
// 원본 종이 문서가 인쇄·복사 단계에서 수식 객체를 잃으면, 사진에는
// "참값이 , 측정값이 라면 백분율 오차는 로" 처럼 조사·쉼표 앞이 빈 결손 문장만
// 남는다. 모델이 이것을 그대로 전사해도 여기서 감지·복원한다.
//
// 원칙(데이터 날조 금지와의 경계):
//   1) 결손 특유 패턴(조사 앞 명사 부재)을 세어 경고만으로도 사용자에게 알린다.
//   2) 교과 표준식이라 복원이 정당한 3형(십진 표기 a×10^n / 백분율 오차식 /
//      표준편차꼴 불확실도식)만, 해당 문장에 문맥 키워드(십진법·백분율 오차·
//      불확실도)가 있을 때에 한해 복원한다.
//   3) 그 외 결손 자리는 절대 지어내지 않고 "(수식 누락)"만 표기한다.
//
// 마커 표기: hwpx 는 {{EQ:한컴 스크립트}} (이후 pre._postprocess_equations 가
// 실제 수식 객체로 변환), docx 는 인라인 표기(a×10^{n} 등, parseRichText 가
// 위·아래첨자로 렌더). 스크립트 안에서 닫는 중괄호는 전부 공백으로 분리해
// `}}` 가 마커 종결 이외에 등장하지 않게 한다(비탐욕 정규식 파서 보호).

// 결손 특유 패턴: 한국어에서 조사(이/가/은/는/을/를)·관형격 '의' 앞에 와야 할
// 명사(수식)가 비어 문장이 끊긴 꼴만 좁게 잡는다. 각 패턴은 캡처 1개($1)+전방탐색.
const LOST_EQ_PATTERNS = [
  /([가-힣])\s+(?=,(?:\s|$))/g, // "참값이 , 측정값이" (값 없이 공백+쉼표)
  /([가-힣])\s+(?=의\s+형태)/g, // "나타내며 의 형태로"
  /([이가])\s+(?=라면(?:[\s.,)]|$))/g, // "측정값이 라면"
  /([을를])\s+(?=라\s+하면)/g, // "측정값을 라 하면"
  /([은는])\s+(?=(?:으로|로)(?:[\s.,)]|$))/g, // "오차는 로", "불확실도는 으로"
  /([을를])\s+(?=번(?:[\s.,)]|$))/g, // "실험을 번 진행"
];

function countLostEquationSites(s) {
  let n = 0;
  for (const re of LOST_EQ_PATTERNS) {
    const m = String(s).match(re);
    if (m) n += m.length;
  }
  return n;
}

// 교과 표준 3형 복원: 키워드가 있는 문장 안의 특정 결손 자리만 채운다.
function restoreEquationFormsInStr(s, hwpx, stats) {
  let out = s;
  const apply = (re, repl) => {
    const before = out;
    out = out.replace(re, repl);
    if (out !== before && stats) stats.restored++;
  };

  // ① 십진(과학적) 표기 a×10^n: "…나타내며 의 형태" 앞 결손.
  if (/십진법|과학적\s*표기/.test(out)) {
    apply(
      /([가-힣])\s+(의\s+형태)/,
      hwpx ? "$1 {{EQ:a times 10^{n} }}$2" : "$1 a×10^{n}$2",
    );
  }

  // ② 백분율 오차식: 참값 x_0, 측정값 x, |x-x_0|/x_0×100%.
  if (/백분율\s*오차/.test(out)) {
    apply(/참값이\s+(?=,)/, "참값이 x_{0}");
    apply(/측정값이\s+(?=라면)/, "측정값이 x");
    apply(
      /(오차는)\s+(?=로(?:[\s.,)]|$))/,
      hwpx
        ? "$1 {{EQ:{left | x - x_{0} right |} over {x_{0} } times 100 }}%"
        : "$1 |x-x_{0}|/x_{0}×100%",
    );
  }

  // ③ 표준편차꼴 불확실도식: 측정값 x_1..x_N, sqrt(Σ(x_i-x̄)²/(N-1)).
  if (/불확실도/.test(out)) {
    apply(/실험을\s+(?=번(?:[\s.,)]|$))/, "실험을 N");
    apply(/측정값을\s+(?=라\s+하면)/, "측정값을 x_{1}, x_{2}, …, x_{N}");
    apply(
      /(불확실도는)\s+(?=으로(?:[\s.,)]|$))/,
      hwpx
        ? "$1 {{EQ:sqrt { {sum _{i=1} ^{N} ( x_{i} - bar {x} )^{2} } over {N-1} } }}"
        : "$1 √(Σ(x_{i}-x̄)^{2}/(N-1))",
    );
  }
  return out;
}

function fixLostEquationsInStr(s, hwpx, stats) {
  if (typeof s !== "string" || !s) return s;
  const suspected = countLostEquationSites(s);
  if (!suspected) return s;
  if (stats) stats.suspected += suspected;
  let out = restoreEquationFormsInStr(s, hwpx, stats);
  // 남은 결손 자리(키워드 불명확)는 지어내지 않고 "(수식 누락)"만 표기.
  for (const re of LOST_EQ_PATTERNS) {
    const remain = (out.match(re) || []).length;
    if (!remain) continue;
    out = out.replace(re, "$1 (수식 누락)");
    if (stats) stats.marked += remain;
  }
  return out;
}

// parsed JSON 전체를 순회하며 prose 문자열에만 적용(구조 필드는 제외).
function restoreLostEquations(node, { hwpx = true, stats = null } = {}) {
  const st = stats || { suspected: 0, restored: 0, marked: 0 };
  const SKIP_KEYS = new Set(["url", "ai_handoff", "type", "crop", "photo_indices"]);
  (function walk(n) {
    if (Array.isArray(n)) {
      for (let i = 0; i < n.length; i++) {
        if (typeof n[i] === "string") n[i] = fixLostEquationsInStr(n[i], hwpx, st);
        else walk(n[i]);
      }
      return;
    }
    if (n && typeof n === "object") {
      for (const k of Object.keys(n)) {
        if (SKIP_KEYS.has(k)) {
          if (n[k] && typeof n[k] === "object") walk(n[k]);
          continue;
        }
        if (typeof n[k] === "string") n[k] = fixLostEquationsInStr(n[k], hwpx, st);
        else walk(n[k]);
      }
    }
  })(node);
  return st;
}

// ── 레이아웃 안전망 (server-side, MODE B 전용) ───────────────────────────────
// 모델이 misbehave 해도 출력이 깔끔하도록 columns 펼침 + 페이지 furniture 제거.

const KNOWN_BLOCK_TYPES_LAYOUT = [
  "heading", "paragraph", "table", "figure", "summary_box", "columns", "spacer", "pagebreak",
];

function blockType(b) {
  if (!b || typeof b !== "object") return "";
  return String(b.type || "").replace(/[{}*_\s]/g, "").toLowerCase();
}

// 한 단(column)을 블록 배열로 정규화 (단일 블록/문자열/null 허용).
function colToBlocks(col) {
  if (Array.isArray(col)) return col;
  if (col === null || col === undefined) return [];
  return [col];
}

// blocks[] 어딘가에 columns 블록이 있나(=원본이 2단이었다는 신호). auto 모드의 2단 자동 선택용.
function blocksHaveColumns(blocks) {
  if (!Array.isArray(blocks)) return false;
  return blocks.some((b) => blockType(b) === "columns");
}

// layout(2단) 모드에서 flatten 해야 하는 단: '표'(다행 표는 단 안에서 페이지를 못 넘어
// 잘림/빈장)·중첩 columns 를 품은 단만. 짧은 문제 텍스트+그림+답란 단은 블록이 여러 개여도
// (실측 ~11블록≈15줄) 한 페이지 안에 들어가므로 보존해 진짜 좌우 2단으로 렌더한다.
function columnTooBigForLayout(blocks) {
  const real = blocks.filter((b) => (typeof b === "string" ? b.trim().length > 0 : b && typeof b === "object"));
  return real.some((b) => {
    const t = blockType(b);
    return t === "table" || t === "columns";
  });
}

// "키 큰(tall)" 단 판정: figure/table/summary_box/columns 를 품거나, 하위 블록이 2개 초과.
// (이런 단은 표 한 행이 페이지를 넘으면 통째로 다음 장으로 밀려 빈 페이지를 만든다.)
function columnIsTall(blocks) {
  const real = blocks.filter((b) => {
    if (typeof b === "string") return b.trim().length > 0;
    return b && typeof b === "object";
  });
  if (real.length > 2) return true;
  for (const b of real) {
    const t = blockType(b);
    if (t === "figure" || t === "table" || t === "summarybox" || t === "columns") return true;
  }
  return false;
}

// 페이지 furniture(쪽번호 / 저작권·꼬리말 / 머리말 재현) 단락이면 true.
// 보수적으로 — paragraph 텍스트가 "명백히" furniture 일 때만 제거한다.
function isFurnitureParagraph(b, runningHeader) {
  if (!b || typeof b !== "object") return false;
  if (blockType(b) !== "paragraph") return false;
  const text = String(b.text || "").trim();
  if (!text) return false;
  // ① 쪽번호: "9 / 10", "10/10", "- 3 -", "3 쪽"
  if (/^\d{1,4}\s*\/\s*\d{1,4}$/.test(text)) return true;
  if (/^[-–—]\s*\d{1,4}\s*[-–—]$/.test(text)) return true;
  if (/^\d{1,3}\s*(쪽|페이지|page)$/i.test(text)) return true;
  // ② 저작권 고지 꼬리말 — 명백한 고지 마커(ⓒ·무단전재 등)만. 'bare 저작권'은
  //    '저작권을 논하시오' 같은 정당한 문제와 구별 안 돼 제거하지 않는다(오탐 방지).
  if (text.length <= 120 && /ⓒ|©|copyright|무단\s*전재|무단\s*복제/i.test(text)) return true;
  // ③ 머리말 재현: 매 쪽 반복되는 시험 머리말 줄(쪽 상단). 짧은 단락에 한해:
  if (text.length <= 140) {
    const norm = (s) => s.replace(/\s+/g, " ").replace(/[“”"'()[\]]/g, "").trim().toLowerCase();
    // (a) runningHeader(문서 제목)를 통째로 포함하는 짧은 줄(머리말은 제목+학교/일시 부속)
    if (runningHeader && norm(runningHeader).length >= 6 && norm(text).includes(norm(runningHeader))) return true;
    // (b) '[일시/교시] … 중간/기말/모의 시험·고사 …' 시험 머리말 꼴(날짜·교시 대괄호로 시작)
    if (/^\[\s*\d{4}\s*년[^\]]*\]/.test(text) && /(중간|기말|모의|학기|시험|고사)/.test(text)) return true;
  }
  return false;
}

// blocks[] 를 재귀적으로 정리해 새 배열을 반환.
//  - tall columns → 자식 블록을 읽기 순서대로 이어붙여 전체폭 순차 블록으로 펼침
//  - short text-only columns → 그대로 둠(좌우 분할 의도 보존)
//  - furniture 단락 → 제거
function sanitizeLayout(blocks, { runningHeader = "", stats = { flattened: 0, dropped: 0 }, keepColumns = false } = {}) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    if (typeof b === "string") { out.push(b); continue; }
    if (!b || typeof b !== "object") continue;

    if (isFurnitureParagraph(b, runningHeader)) {
      stats.dropped++;
      continue;
    }

    if (blockType(b) === "columns" && Array.isArray(b.columns)) {
      const cleanedCols = b.columns.map((col) =>
        sanitizeLayout(colToBlocks(col), { runningHeader, stats, keepColumns }),
      );
      // clean: 키 큰 단 모두 flatten(전체폭 linearize). layout(2단): 단을 보존하되
      // 표/중첩컬럼/과대 단(페이지 넘침 위험)만 flatten.
      const mustFlatten = keepColumns
        ? cleanedCols.some((col) => columnTooBigForLayout(col))
        : cleanedCols.some((col) => columnIsTall(col));
      if (mustFlatten) {
        stats.flattened++;
        for (const col of cleanedCols) for (const child of col) out.push(child);
      } else {
        b.columns = cleanedCols;
        out.push(b);
      }
      continue;
    }

    out.push(b);
  }
  return out;
}

function extractJson(text) {
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const anyFence = text.match(/```\s*([\s\S]*?)```/);
  if (anyFence) return anyFence[1].trim();
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) return text.slice(first, last + 1);
  return null;
}

// MODE B: figure.crop(원본 사진의 그림 영역)을 sharp 로 잘라 실제 이미지로 임베드.
// allowRedraw 면 잘라낸 그림을 gpt-image 로 깔끔히 재생성(옵트인 · 원본과 달라질 수 있음).
// 잘라낸/재생성 버퍼는 allPhotos 에 추가하고 figure.photo_indices 로 연결 → 기존 임베드 경로 재사용.
async function resolveFigureCrops(
  parsed,
  allPhotos,
  { allowRedraw = false, maxRedraw = FORM_MAKER_REDRAW_MAX, signal, onProgress = () => {} } = {},
) {
  const figures = [];
  (function collect(node) {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== "object") return;
    const t = String(node.type || "").replace(/[{}*]/g, "").toLowerCase();
    if (t === "figure" && node.crop && typeof node.crop === "object") figures.push(node);
    else Object.values(node).forEach(collect);
  })(parsed);
  if (!figures.length) return { cropped: 0, redrawn: 0 };

  const wantRedraw = allowRedraw && imageKeyAvailable();
  let cropped = 0;
  let redrawn = 0;
  for (const fig of figures) {
    const crop = fig.crop || {};
    const pIdx = Number(crop.photo);
    const src = Number.isInteger(pIdx) ? allPhotos[pIdx] : null;
    if (!src || !Buffer.isBuffer(src.buffer) || !src.buffer.length) continue;
    try {
      const meta = await sharp(src.buffer).metadata();
      const W = meta.width || 0;
      const H = meta.height || 0;
      if (!W || !H) continue;
      let box = Array.isArray(crop.box) ? crop.box.map(Number) : [0, 0, 1, 1];
      if (box.length !== 4 || box.some((v) => !isFinite(v))) box = [0, 0, 1, 1];
      if (box.some((v) => v > 1.5)) box = box.map((v) => v / 100); // 0~100(%) 입력 보정
      let [l, t, r, b] = box.map((v) => Math.max(0, Math.min(1, v)));
      if (r <= l || b <= t) { l = 0; t = 0; r = 1; b = 1; }
      const left = Math.floor(l * W);
      const top = Math.floor(t * H);
      const width = Math.min(W - left, Math.max(8, Math.round((r - l) * W)));
      const height = Math.min(H - top, Math.max(8, Math.round((b - t) * H)));
      let pipe = sharp(src.buffer).extract({ left, top, width, height });
      const rot = Number(crop.rotate);
      if (isFinite(rot) && Math.abs(rot) > 0.5 && Math.abs(rot) <= 45) {
        pipe = pipe.rotate(rot, { background: "#ffffff" }); // 기울기 보정(일반 회전, 생성 아님)
      }
      let buf = await pipe.sharpen().normalize().png().toBuffer();
      const cm = await sharp(buf).metadata();
      if ((cm.width || 0) < 700) {
        buf = await sharp(buf).resize({ width: Math.min(1400, (cm.width || 700) * 2) }).png().toBuffer();
      }
      cropped++;
      if (wantRedraw && redrawn < maxRedraw) {
        try {
          buf = await editImage(buf, FIGURE_REDRAW_PROMPT, { signal });
          redrawn++;
        } catch (e) {
          onProgress(`⚠ 그림 AI 재생성 실패 — 원본 크롭 사용 (${String(e.message).slice(0, 60)})`);
        }
      } else if (wantRedraw && redrawn >= maxRedraw) {
        onProgress(`ℹ 그림 AI 재생성 한도(${maxRedraw}개) 초과 — 나머지는 원본 크롭 사용`);
      }
      const newIdx = allPhotos.length;
      allPhotos.push({ buffer: buf, name: `figure_${newIdx}.png`, mimetype: "image/png" });
      fig.photo_indices = [newIdx];
      delete fig.crop;
    } catch (e) {
      onProgress(`⚠ 그림 크롭 실패 — 자리표시자 유지 (${String(e.message).slice(0, 60)})`);
    }
  }
  if (cropped) {
    onProgress(`🖼 사진 속 그림 ${cropped}개 잘라 삽입${redrawn ? ` (AI 재생성 ${redrawn}개)` : ""}`);
  }
  return { cropped, redrawn };
}

module.exports = {
  generateReportContent,
  resolveFigureCrops,
  sanitizeLayout,
  normalizeModelLatex,
  restoreLostEquations,
};
