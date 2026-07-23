// 수학Ⅲ 급수 탐구보고서 (수학 수행평가) — 콘텐츠 생성
//
// 입력: 주제(topic) + 사용자 메모(선택) + 내 글 스타일(선택). 필기노트·참고자료 업로드는 받지 않는다 —
//       수학 내용은 모델이 정확한 수학 지식으로 직접 구성하고, 선행연구·참고문헌은 web_search 로 실존 확인한다.
// 출력: prompt.md 스키마를 따르는 JSON (inquiry_topic / inquiry_purpose / prior_research / process / results_reflection / references)
//
// chem-pre/generate.js 와 같은 골격(스트리밍 + heartbeat + web_search + lenient JSON).

const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const { calcCost, calcImageCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const styleRef = require("../../style-ref");
const { deepCleanMarkers } = require("../../marker-clean");
const { renderChart } = require("../chem-result/chart-gen");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { isGptModel, callGptReport } = require("../../model-call");

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

- 별도 줄로 보여줄 식, 분수·적분·시그마·행렬식은 \`{ "equation": "..." }\` 블록에 넣고, 내용은 한컴 수식 스크립트로 작성하세요. HWPX 출력 시 진짜 한글 수식 객체로 변환됩니다.
- 본문 문자열 안의 복잡한 인라인 식도 필요하면 \`{{EQ:...}}\` 로 감쌀 수 있습니다.

**한컴 수식 스크립트 문법** (LaTeX 아님):
- 분수: \`{a} over {b}\`
- 제곱근: \`sqrt {1 - v^2 / c^2}\`
- 위/아래첨자: \`x^2\`, \`v_{x}\`, \`gamma\`
- 적분/시그마: \`int _{0} ^{t} f dt\`, \`sum _{i=1} ^{n} x_i\`
- 화살표: \`->\`
- \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 같은 표기는 금지입니다.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- 이중 중괄호 수식 마커(\`{{EQ:...}}\` 등)를 절대 쓰지 마세요.
- 인라인 텍스트 마커만 사용합니다: \`v_{x}\`, \`c^{2}\`, \`*v*\`, \`Δt\`, \`γ\`, \`→\`, \`×\`.
- 별도 줄 수식 블록 \`{ "equation": "..." }\` 의 내용도 위 인라인 마커로 작성하세요.`,
};

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  return String(text).replace(
    /- 핵심 강조: `\*\*\.\.\.\*\*`[^\n]*/g,
    "- 핵심 강조: 관리자 전용 기능이므로 `**...**` 마커를 쓰지 마세요. 강조가 필요하면 일반 문장으로 표현하세요.",
  );
}

const STYLE_EMULATION_SECTION = `## 문체 흉내 (사용자 글 스타일 반영)

사용자가 **자기 글 샘플**(또는 문체 메모)을 제공했습니다. 보고서를 그 사람의 글처럼 들리게 쓰세요.

- 흉내 낼 것: 어조·말투(예: 격식체/구어체), 문장 리듬과 길이, 설명 방식(직관 우선·비유 사용·"대부분은 여기서 헷갈린다"식 오개념 짚기 등), 소제목 표기 습관(예: 영어 헤더), 수식 제시 방식(단계별 \`=>\` 유도 등), 강조 방식.
- **절대 가져오지 말 것**: 샘플의 \*\*주제·내용·수식·예시·문장 자체\*\*. 샘플이 다른 주제(예: 전자기학)여도 그 내용을 이 보고서에 끌어오면 안 됩니다. **오직 "어떻게 쓰는가(문체)"만** 흉내 내고, "무엇을 쓰는가(내용)"는 이 보고서의 주제에서만 가져옵니다.
- 보고서 양식(Ⅰ~Ⅴ 구조와 절 구성)과 JSON 스키마는 그대로 유지하면서, 각 절 본문의 **문장 스타일**만 사용자 글처럼 맞춥니다.
- 단, 제출용 보고서로서 최소한의 단정함은 유지하세요(과한 비속어·의미 없는 채팅 약어는 절제).`;

function buildSystemPrompt(
  outputFormat = "docx",
  { allowHighlights = true, hasStyle = false } = {},
) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const formatSection =
    FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  const styleSection = hasStyle ? `\n${STYLE_EMULATION_SECTION}\n` : "";
  return `당신은 (영재학교)과학고등학교 학생을 위한 "수학Ⅲ 급수 탐구보고서"(수행평가) 초안 작성 도우미입니다.

아래 스킬 명세의 모든 규칙(절 구성과 채점 기준, 수학적 정확성, 환각 금지, 1인칭 탐구 문체, JSON 스키마)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

${formatSection}
${styleSection}
## 다시 강조

- 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다. JSON 외 텍스트는 무시됩니다.
- 업로드 자료 없이 주제만 주어집니다. 모든 수학 내용은 정확한 수학 지식으로 직접 구성하고, 선행연구·참고문헌은 web_search 로 실존 확인한 자료만 쓰세요. 가짜 수치·가짜 인용 금지. 표·차트의 숫자는 직접 계산해 검산한 값만.
- 채점 기준 최고 밴드를 모든 절에서 의식하세요: ① 창의적 시도·독창적 접근(스스로 만든 예시, 직접 계산한 비교, 타 분야 연결 — 기존 예시 단순 정리는 감점 밴드), ② 논리적·체계적 서술 + 표·그래프·수식의 효과적 활용(표 1+·그래프 1+ 필수, 각 자료 뒤 해석 단락), ③ 절마다 핵심이 분명한 전달.
- Ⅳ(탐구 과정 및 탐구 내용)가 가장 길어야 합니다(전체의 40~50%). **분량 목표 A4 4~8쪽**, 수식 유도는 풀버전으로. 짧은 요약본은 실패입니다.${hasStyle ? "\n- 위 '문체 흉내' 지침에 따라 사용자 글 스타일로 쓰되, 샘플의 내용은 가져오지 마세요." : ""}`;
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 / 내 의견 ===
${notes}
=== 메모 끝 ===

위 메모는 학생이 강조하고 싶은 맥락·관점(탐구 동기, 다루길 원하는 방향, 직접 해 본 것 등)입니다. 보고서에 자연스럽게 녹이되 보조로만 반영하세요. 메모에 없는 구체적 사건·인용은 새로 만들지 마세요.`;
}

/**
 * @param {Object} args
 * @param {string} args.topic               급수 탐구 주제(필수)
 * @param {string} args.userNotes           참고 메모(선택)
 * @param {Array}  args.styleRefs           내 글 스타일 참고 파일 [{buffer,name,mimetype}] — 문체만 흉내
 * @param {string} args.styleNote           원하는 문체 한 줄 메모(선택)
 * @param {Function} args.onProgress        (msg)=>void
 * @returns {Promise<Object>}               파싱된 보고서 JSON
 */
async function generateReportContent({
  topic = "",
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
  const USE_GPT = isGptModel(MODEL); // GPT(OpenAI) 경로는 단일 호출, Claude 는 설계→병렬.
  if (!USE_GPT && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  const topicText = String(topic || "").trim();
  if (!topicText) throw new Error("탐구 주제(topic)가 비어 있습니다.");
  const styleNoteText = String(styleNote || "").trim().slice(0, 1500);
  const hasStyle =
    (Array.isArray(styleRefs) && styleRefs.length > 0) || !!styleNoteText;

  onProgress(`🤖 모델: ${MODEL}${USE_GPT ? " (GPT)" : ""} | 출력: ${OUTPUT_FORMAT}${hasStyle ? " | 내 문체 반영" : ""}`);

  const client = USE_GPT
    ? null
    : new Anthropic({ apiKey: byok.anthropicKey(), timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ });
  const system = buildSystemPrompt(OUTPUT_FORMAT, { allowHighlights, hasStyle });

  const content = [];
  const attachmentSummary = [];

  // 큰 PDF 는 인라인 base64(요청당 32MB 한도)로 못 보내므로 Files API 로 업로드해
  // file_id 로 참조한다. 작은 PDF 는 그대로 인라인. usedFileApi 면 메시지에 files
  // beta 헤더를 붙이고, 끝나면 업로드 파일을 정리한다. (phys-inquiry/generate.js 와
  // 동일한 우회 방식 — math-inquiry 는 Claude/Fable 전용이라 분기가 더 단순하다.)
  //
  // math-inquiry 는 자체 PDF 입력 필드는 없지만, "내 글 스타일 참고"(styleRefs)로
  // 올린 PDF 가 styleRef.buildStyleBlocks 에서 인라인 base64 로 들어온다. 큰 스타일
  // PDF 가 32MB 한도를 넘기지 않도록, 그 블록들을 Files API 참조로 오프로드한다.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024; // ≥4.5MB raw PDF → Files API
  const INLINE_B64_BUDGET = 18 * 1024 * 1024; // 누적 인라인 base64 상한(32MB 요청 한도 여유)
  let inlineB64Used = 0;
  let usedFileApi = false;
  const uploadedFileIds = [];

  async function pushPdfBlock(f, { cacheControl = false } = {}) {
    const b64Len = Math.ceil(f.buffer.length / 3) * 4;
    const tooBigInline =
      f.buffer.length >= FILES_API_RAW_THRESHOLD ||
      inlineB64Used + b64Len > INLINE_B64_BUDGET;
    if (tooBigInline) {
      try {
        const fileId = await uploadFileToAnthropic(f.buffer, f.name, { signal });
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        onProgress(
          `📤 큰 PDF 파일 업로드(Files API): ${f.name} (${Math.round((f.buffer.length / 1048576) * 10) / 10}MB)`,
        );
        return;
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
        // 인라인으로 폴백(요청이 32MB 를 넘으면 Anthropic 이 413 으로 막을 수 있음)
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

  // styleRef.buildStyleBlocks 가 만든 블록 배열에서, 큰 base64 PDF document 블록을
  // 찾아 Files API 참조(file_id)로 바꿔 큰 스타일 PDF 의 인라인 한도 초과를 막는다.
  // 공유 모듈(style-ref.js)을 건드리지 않고 결과 블록만 후처리한다. 작은 PDF·
  // 텍스트·이미지 블록은 그대로 둔다.
  async function offloadLargePdfBlocks(blocks) {
    const out = [];
    for (const block of blocks) {
      const src = block && block.type === "document" ? block.source : null;
      const isInlinePdf =
        src &&
        src.type === "base64" &&
        src.media_type === "application/pdf" &&
        typeof src.data === "string";
      if (!isInlinePdf) {
        // PDF 가 아닌 블록(텍스트/이미지) 은 누적 인라인 예산에 큰 영향이 없으므로 통과.
        out.push(block);
        continue;
      }
      const b64Len = src.data.length;
      const rawLen = Math.floor((b64Len * 3) / 4); // 대략적 원본 바이트 수
      const tooBigInline =
        rawLen >= FILES_API_RAW_THRESHOLD ||
        inlineB64Used + b64Len > INLINE_B64_BUDGET;
      if (tooBigInline) {
        try {
          const buf = Buffer.from(src.data, "base64");
          const fileId = await uploadFileToAnthropic(buf, "style-ref.pdf", {
            signal,
          });
          out.push({
            type: "document",
            source: { type: "file", file_id: fileId },
          });
          uploadedFileIds.push(fileId);
          usedFileApi = true;
          onProgress(
            `📤 큰 스타일 PDF 업로드(Files API): ${Math.round((rawLen / 1048576) * 10) / 10}MB`,
          );
          continue;
        } catch (e) {
          onProgress(`⚠ 스타일 PDF Files API 업로드 실패 → 인라인 시도: ${e.message}`);
          // 인라인으로 폴백
        }
      }
      inlineB64Used += b64Len;
      out.push(block);
    }
    return out;
  }

  // 1) 주제 (최우선 맥락)
  content.push({
    type: "text",
    text: `=== 학생이 선택한 급수 탐구 주제 ===
${topicText}
=== 주제 끝 ===

이 주제를 보고서의 중심으로 삼으세요.`,
  });

  // 2) 사용자 메모
  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("사용자 메모");
  }

  // 3) 내 글 스타일 참고 (문체만 흉내, 내용은 절대 가져오지 않음).
  //    공통 lib/style-ref.js 의 buildStyleBlocks 로 PDF/이미지/텍스트/.hwpx 를
  //    4개 보고서와 동일하게 처리한다(.hwpx 본문 텍스트 추출 포함).
  if (hasStyle) {
    const styleBlocks = await styleRef.buildStyleBlocks({
      styleRefs,
      styleNote: styleNoteText,
    });
    // 큰 스타일 PDF 는 Files API 로 오프로드(32MB 인라인 한도 우회). 단 GPT 경로는
    // Anthropic Files API file_id 를 못 쓰므로(toOpenAiContent 가 무시) 항상 인라인.
    content.push(...(USE_GPT ? styleBlocks : await offloadLargePdfBlocks(styleBlocks)));
    attachmentSummary.push("내 문체 참고");
  }

  // 공통 사용자 컨텍스트(주제 + 메모 + 문체). 설계/본문 콜 모두 이걸 앞에 깔고
  // 콜별 지시 텍스트만 덧붙인다.
  const sharedContent = content;
  const styleNote2 = hasStyle
    ? "\n- 문장 스타일은 '내 글 스타일 참고'의 문체만 흉내 내고, 그 샘플의 내용·수식·예시는 절대 가져오지 않는다."
    : "";

  // 콜별 지시 — (1)설계 plan, (2)Ⅰ~Ⅲ, (3)Ⅳ~Ⅴ. 시스템 프롬프트(스킬 전체)는
  // 세 콜이 공유하므로 블록 형식·수식 마커 규칙은 거기서 가져온다.
  const planInstruction = `위 주제${notesBlock ? "와 메모" : ""}로 "수학Ⅲ 급수 탐구보고서"를 쓰기 위한 **설계(plan)** 를 만든다. 본문 전체가 아니라 아래 형식의 설계 JSON 하나만 출력한다.

이 설계를 받아 다른 작성자가 Ⅰ~Ⅴ 본문을 일관되게 채운다. 따라서 본문에서 쓸 **구체적 내용을 여기서 확정**한다 — 특히 Ⅳ(탐구 과정)에서 쓸 실제 표 데이터·그래프 데이터·핵심 계산·발견을 직접 계산해 숫자로 정한다.

규칙:
- 선행연구·참고문헌은 web_search 로 실제 존재를 확인한 자료만(없으면 []). 가짜 인용·존재하지 않는 문헌 금지.
- 표·그래프·계산의 모든 숫자는 네가 직접 계산해 검산한 실제 값.${styleNote2}

보고서 날짜: ${date || "(미지정)"}

출력(이 JSON 하나만, \`\`\`json 코드블록):
\`\`\`json
{
  "title": "주제를 다듬은 제목",
  "references": [{"label": "저자, 제목, 출처/연도", "url": "실제 URL"}],
  "outline": {
    "inquiry_topic": "Ⅰ에서 다룰 핵심 요지(2~3문장)",
    "inquiry_purpose": "Ⅱ 동기·목표 요지",
    "theory_points": ["Ⅲ.1 이론적 배경에서 전개할 개념·정리(핵심 수식 포함) 항목들"],
    "prior_research_points": ["Ⅲ.2 선행연구에서 다룰 내용(references 와 연결)"],
    "reflection_points": ["Ⅴ 결과 정리·반성에서 짚을 점"]
  },
  "exploration_data": {
    "key_calculations": ["Ⅳ에서 수행할 구체적 계산/예시를 순서대로(예: 'a=1,r=0.5 등비급수 부분합 S_1..S_8 계산')"],
    "tables": [{"caption": "...", "headers": ["n", "S_n"], "rows": [["1", "1"], ["2", "1.5"]]}],
    "charts": [{"title": "...", "type": "line", "labels": ["1", "2"], "datasets": [{"label": "S_n", "data": [1, 1.5]}]}],
    "key_findings": ["Ⅳ에서 도출되는 핵심 발견(수치와 함께)"]
  }
}
\`\`\`
설계는 간결하게(본문 산문은 쓰지 않는다). 단 표·그래프·계산의 숫자는 실제로 채운다. tables·charts 는 최소 1개씩.`;

  const introInstruction = (planJson) => `아래는 이 보고서의 확정된 설계(plan)다:
=== PLAN ===
${planJson}
=== /PLAN ===

이 설계에 맞춰 보고서의 **Ⅰ·Ⅱ·Ⅲ 부분만** 작성한다. 출력은 아래 JSON 하나(\`\`\`json 코드블록):
\`\`\`json
{
  "inquiry_topic": ["..."],
  "inquiry_purpose": ["..."],
  "prior_research": { "theory": ["..."], "analysis": ["..."] }
}
\`\`\`
- outline.inquiry_topic/inquiry_purpose, theory_points, prior_research_points, references 를 근거로 충실히 전개한다(이론은 수식 풀버전). 본문 블록 형식·수식 마커는 스킬 명세를 따른다.
- title/process/results_reflection/references 는 여기서 쓰지 않는다(다른 작성자 담당).
- web_search 하지 않는다(참고문헌은 설계에 이미 있다).${styleNote2}`;

  const coreInstruction = (planJson) => `아래는 이 보고서의 확정된 설계(plan)다:
=== PLAN ===
${planJson}
=== /PLAN ===

이 설계에 맞춰 보고서의 **Ⅳ·Ⅴ 부분만** 작성한다. 출력은 아래 JSON 하나(\`\`\`json 코드블록):
\`\`\`json
{
  "process": ["..."],
  "results_reflection": ["..."]
}
\`\`\`
- Ⅳ(process)는 설계의 exploration_data 를 **그대로 사용**한다: key_calculations 를 단계별 풀버전으로 서술하고, tables/charts 를 본문에 {"table": {...}} / {"chart": {...}} 블록으로 넣되 **설계의 숫자를 그대로** 쓴다(새 숫자 지어내지 말 것). 각 표·그래프 뒤에 해석 단락. Ⅳ는 보고서의 핵심(전체의 40~50%)이니 가장 길고 충실하게(풀버전 수식 유도).
- Ⅴ(results_reflection)는 설계의 key_findings·reflection_points 를 바탕으로, Ⅳ에서 나온 **그 수치·결과를 그대로 인용**해 정리·반성한다(Ⅳ와 숫자가 어긋나면 안 된다).
- title/inquiry_topic/inquiry_purpose/prior_research/references 는 쓰지 않는다.
- web_search 하지 않는다. 본문 블록 형식·수식 마커는 스킬 명세를 따른다.${styleNote2}`;

  onProgress(
    `📎 입력: 주제${attachmentSummary.length ? " + " + attachmentSummary.join(", ") : "만"} — 설계→병렬 본문 방식으로 생성`,
  );

  // ── 설계 → 병렬 섹션 → 조립 ────────────────────────────────────────────────
  // 한 연결을 ~150~200초 이상 열어두면 Render 등 호스팅 환경에서 끊긴다
  // (Premature close; 로컬 직결은 정상이라 네트워크 경로의 연결 수명 컷오프로 추정).
  // 그래서 짧은 콜 여러 개로 나눠 한 콜이 벽에 닿기 전에 끝나게 한다: 설계 1콜
  // (web_search 로 선행연구·참고문헌·Ⅳ 데이터 확정) → 본문 2콜 병렬([Ⅰ·Ⅱ·Ⅲ],
  // [Ⅳ·Ⅴ]) → 조립. 각 콜엔 끊김 안전망(user-message 이어쓰기)이 있지만 짧아 거의 안 걸린다.
  const startedAt = Date.now();
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);
  let charCount = 0;
  let cost = null;
  let usageAgg = null;
  let webSearchTotal = 0;

  const addUsage = (u) => {
    if (!u) return;
    usageAgg = usageAgg || {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    usageAgg.input_tokens += u.input_tokens || 0;
    usageAgg.output_tokens += u.output_tokens || 0;
    usageAgg.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    usageAgg.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  };

  // 일시적(연결) 오류만 이어쓰기/재시도 대상. 사용자 중단·타임아웃(signal.aborted)은 제외.
  const isTransientStreamError = (e) =>
    !(signal && signal.aborted) &&
    /premature close|econnreset|socket hang up|\bterminated\b|other side closed|und_err|fetch failed|network error|epipe|enotfound|eai_again/i.test(
      String((e && e.message) || e || ""),
    );

  const reqOptions = (() => {
    // Files API 로 업로드한 PDF 를 참조하면 files beta 헤더가 필요하다.
    const o = {};
    if (signal) o.signal = signal;
    if (usedFileApi) o.headers = { "anthropic-beta": FILES_BETA };
    return Object.keys(o).length ? o : undefined;
  })();
  const systemBlock = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];

  // 이어쓰기 지시 — Opus 4.8 은 assistant prefill(마지막 메시지를 assistant 로 두기)을
  // 지원하지 않아 400 이 나므로, 부분 응답을 assistant 히스토리로 넣고 마지막은 user 지시로 끝낸다.
  const CONT_INSTRUCTION =
    "직전 너의 응답이 길이 제한으로 중간에 잘렸다. 잘린 바로 그 지점부터 곧바로 이어서, 남은 부분만 출력하라. 이미 출력한 내용을 절대 다시 반복하지 말고, 인사·설명·새 코드펜스(```) 없이 잘린 위치에 그대로 이어 붙여 JSON 을 끝까지 완성하라.";
  // 이어쓰기 구간(seg>1)이 펜스를 다시 열면 앞 펜스만 제거(최종 extractJson 이 전역으로 또 정리).
  const stripContLead = (txt) => txt.replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, "");

  // 한 논리적 생성을 스트리밍으로 끝까지 받아 전체 텍스트를 반환. 콜이 짧아 거의 안
  // 걸리지만, 끊기거나 max_tokens 로 잘리면 user-message 이어쓰기로 마저 받는다.
  async function streamWithContinuation(initialUserContent, { label, tools }) {
    const MAX_SEGMENTS = 5;
    let fullText = "";
    let emptyDrops = 0; // 같은 콜에서 '텍스트 0자' 끊김 연속 횟수(진전 있으면 리셋)
    for (let seg = 1; seg <= MAX_SEGMENTS; seg++) {
      const messages = fullText
        ? [
            { role: "user", content: initialUserContent },
            // assistant content 끝 공백은 API 거부를 피하려 보낼 때만 제거한다. fullText
            // 자체는 안 건드려, 숫자 경계가 공백 없이 합쳐져 조용히 손상되는 일을 막는다.
            { role: "assistant", content: fullText.replace(/\s+$/, "") },
            { role: "user", content: CONT_INSTRUCTION },
          ]
        : [{ role: "user", content: initialUserContent }];

      let segText = "";
      let lastReportedChars = charCount;
      let lastEventAt = Date.now();
      let firstTokenSeen = fullText.length > 0;
      let searchInFlight = false;
      let lastUsage = null; // 끊긴 구간도 토큰을 집계할 수 있게 증분 usage 보관

      const heartbeat = setInterval(() => {
        if ((Date.now() - lastEventAt) / 1000 >= 12) {
          onProgress(
            `⏳ [${label}] ${firstTokenSeen ? `작성 중... (${charCount}자, ${elapsed()}초)` : `구상 중... (${elapsed()}초)`}`,
          );
          lastEventAt = Date.now();
        }
      }, 5000);

      const params = { model: MODEL, max_tokens: MAX_TOKENS, system: systemBlock, messages };
      if (ENABLE_THINKING) {
        params.thinking = { type: "adaptive" };
        params.output_config = { effort: THINKING_EFFORT };
      } else if (!/fable/i.test(MODEL || "")) {
        // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
        params.thinking = { type: "disabled" };
      }
      if (tools) params.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }];

      try {
        const stream = client.messages.stream(params, reqOptions);
        stream.on("streamEvent", (event) => {
          lastEventAt = Date.now();
          // 증분 usage 보관(끊겨도 직전 usage 로 집계 가능 — 과소집계 방지).
          if (event.type === "message_start" && event.message?.usage) lastUsage = event.message.usage;
          if (event.type === "message_delta" && event.usage) lastUsage = { ...(lastUsage || {}), ...event.usage };
          if (event.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "text") {
              if (!firstTokenSeen) {
                onProgress(`✍️ [${label}] 작성 ${seg > 1 ? "이어서 " : ""}시작 (${elapsed()}초)`);
                firstTokenSeen = true;
              }
            } else if (block?.type === "server_tool_use" && block?.name === "web_search") {
              webSearchTotal++;
              searchInFlight = true;
              onProgress(`🔍 [${label}] 선행연구 웹 검색 중... (${webSearchTotal}번째, ${elapsed()}초)`);
            } else if (block?.type === "web_search_tool_result") {
              searchInFlight = false;
              onProgress(`✓ [${label}] 검색 결과 수신`);
            }
          }
          if (
            event.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            event.delta.text
          ) {
            segText += event.delta.text;
            charCount += event.delta.text.length;
            if (charCount - lastReportedChars >= 1500) {
              onProgress(`✍️ [${label}] 작성 중... (${charCount}자, ${elapsed()}초)`);
              lastReportedChars = charCount;
            }
          }
          if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
            onProgress(`⚠ [${label}] 토큰 한도 — 이어서 생성`);
          }
        });

        const finalMessage = await stream.finalMessage();
        addUsage(finalMessage.usage);
        fullText += seg > 1 ? stripContLead(segText) : segText;
        // max_tokens 로 잘렸어도 JSON 이 이미 완성됐으면(드물게 trailing 토큰에서 잘림) 종료.
        if (finalMessage.stop_reason === "max_tokens" && seg < MAX_SEGMENTS && !looksCompleteJson(fullText)) continue;
        return fullText; // 정상 종료(또는 구간 소진)
      } catch (e) {
        if (signal && signal.aborted) throw e; // 사용자 중단·타임아웃은 재시도 안 함
        if (!isTransientStreamError(e)) throw e; // 진짜 오류는 그대로
        const cause = (e && e.cause && (e.cause.code || e.cause.message)) || e.name || "?";
        onProgress(`🔧 [${label}] 끊김 진단: seg${seg} @${elapsed()}초 ${charCount}자 | 검색중=${searchInFlight} | cause=${cause}`);
        console.error(
          `[math-inquiry ${label}] drop seg${seg} @${elapsed()}s chars=${charCount} search=${searchInFlight} cause=${cause} :: ${String(e.message || e).slice(0, 120)}`,
        );
        if (lastUsage) addUsage(lastUsage); // 끊긴 구간 토큰도 집계
        if (segText.length > 0) {
          fullText += seg > 1 ? stripContLead(segText) : segText;
          emptyDrops = 0; // 진전 있으면 빈끊김 카운터 리셋
          // 끊겼지만 이미 완전한 JSON 을 다 받았으면 이어쓰기 불필요(모델이 객체를 다
          // 쓴 직후 연결만 끊긴 흔한 경우 — 계속하면 중복 객체로 파싱이 깨진다).
          if (looksCompleteJson(fullText)) return fullText;
          if (seg >= MAX_SEGMENTS) return fullText;
          onProgress(`🔁 [${label}] 받은 내용에서 이어서 생성 (${seg}/${MAX_SEGMENTS})`);
          continue;
        }
        emptyDrops++;
        if (emptyDrops > 2 || seg >= MAX_SEGMENTS) throw e;
        onProgress(`🔁 [${label}] 연결 끊김(응답 전) — 재시도 (${emptyDrops}/2)`);
        seg--; // 빈 끊김은 구간으로 세지 않음
        continue;
      } finally {
        clearInterval(heartbeat);
      }
    }
    return fullText;
  }

  const parseCall = (text, label) => {
    const j = extractJson(text);
    if (!j) throw new Error(`[${label}] JSON 을 찾지 못했습니다. 응답 앞부분: ${String(text).slice(0, 200)}`);
    try {
      return parseJsonLenient(j);
    } catch (e) {
      throw new Error(`[${label}] JSON 파싱 실패: ${e.message}`);
    }
  };

  const hasBlocks = (v) => (Array.isArray(v) ? v.length > 0 : !!v);

  // 한 청크(설계/섹션)를 생성+파싱+검증하고, 끊김 소진·파싱 실패·필수필드 누락이면
  // 1회 재생성한다(짧은 콜이라 재시도 저렴). 병렬 중 하나가 실패해 전체가 무너지는 것을
  // 막는다. 사용자 중단·타임아웃(signal.aborted)은 즉시 전파.
  async function generateChunk(label, makeContent, { tools, validate } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const text = await streamWithContinuation(makeContent(), {
          label: attempt > 1 ? `${label}·재생성` : label,
          tools,
        });
        const obj = parseCall(text, label);
        if (validate && !validate(obj)) throw new Error(`[${label}] 필수 필드 누락/형식 불일치`);
        return obj;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        lastErr = e;
        if (attempt < 2) onProgress(`⚠ [${label}] 실패 — 재생성 (${String(e.message || e).slice(0, 80)})`);
      }
    }
    throw lastErr;
  }

  let parsed;
  if (USE_GPT) {
    // GPT: 스트림 연결 벽·web_search 가 없으므로(OpenAI chat) 전체 보고서 JSON 을
    // 단일 호출로 한 번에 생성한다. callGptReport 가 429/5xx·길이초과 재시도를 내장.
    const gptInstruction = `위 주제${notesBlock ? "와 메모" : ""}로 "수학Ⅲ 급수 탐구보고서" 전체를 JSON 하나로 생성하라.

보고서 날짜: ${date || "(미지정)"}

스킬 명세의 JSON 스키마(title, inquiry_topic, inquiry_purpose, prior_research{theory, analysis}, process, results_reflection, references)와 본문 블록 형식·수식 마커 규칙을 정확히 따른다. Ⅳ(process)는 표 1개 이상 + 그래프 1개 이상 + 풀버전 수식 유도로 가장 길게(전체의 40~50%). 표·그래프의 모든 숫자는 직접 계산해 검산한 실제 값.
web_search 도구가 없으니 모든 수학 내용은 네 정확한 수학 지식으로 직접 구성하고, 참고문헌(references)은 실제로 존재하는 교재·문헌만 적되 불확실하면 비운다([]). 존재하지 않는 문헌·가짜 인용 금지.${hasStyle ? "\n문장 스타일은 '내 글 스타일 참고'의 문체만 흉내 내고 그 샘플의 내용은 가져오지 않는다." : ""}
출력은 단 하나의 JSON 객체.`;
    try {
      onProgress(`🤖 [GPT] ${MODEL} — 전체 보고서 생성 중 (단일 호출)`);
      const { text, usage } = await callGptReport({
        model: MODEL,
        system,
        content: [...sharedContent, { type: "text", text: gptInstruction }],
        maxTokens: MAX_TOKENS,
        jsonObject: true,
        signal,
        onProgress,
      });
      charCount = (text || "").length;
      parsed = parseCall(text, "GPT");
      cost = calcCost({ usage, webSearchCount: 0, model: MODEL });
    } finally {
      if (uploadedFileIds.length) {
        await Promise.all(uploadedFileIds.map((id) => deleteAnthropicFile(id)));
      }
    }
  } else {
  try {
    // 1) 설계(plan) — web_search 로 선행연구·참고문헌 + Ⅳ 데이터 확정
    onProgress(`🧭 [설계] 선행연구·참고문헌·Ⅳ 데이터 결정 중 (web_search)`);
    const plan = await generateChunk(
      "설계",
      () => [...sharedContent, { type: "text", text: planInstruction }],
      { tools: true, validate: (p) => p && (p.outline || p.exploration_data || p.references) },
    );
    const ed = (plan && plan.exploration_data) || {};
    onProgress(
      `✓ [설계] 완료 (${elapsed()}초) — 참고문헌 ${(plan.references || []).length} · 표 ${(ed.tables || []).length} · 그래프 ${(ed.charts || []).length}`,
    );

    // 2) 병렬 본문 — [Ⅰ·Ⅱ·Ⅲ] 와 [Ⅳ·Ⅴ] 를 같은 설계로 동시에 작성
    onProgress(`✍️ 본문 병렬 작성 — [Ⅰ·Ⅱ·Ⅲ] · [Ⅳ·Ⅴ] 동시 진행`);
    const planJson = JSON.stringify(plan);
    const [intro, core] = await Promise.all([
      generateChunk(
        "Ⅰ-Ⅲ",
        () => [...sharedContent, { type: "text", text: introInstruction(planJson) }],
        { tools: false, validate: (o) => o && (hasBlocks(o.inquiry_topic) || hasBlocks(o.inquiry_purpose) || o.prior_research) },
      ),
      generateChunk(
        "Ⅳ-Ⅴ",
        () => [...sharedContent, { type: "text", text: coreInstruction(planJson) }],
        { tools: false, validate: (o) => o && hasBlocks(o.process) },
      ),
    ]);

    // 3) 조립
    const pr = intro.prior_research && typeof intro.prior_research === "object" ? intro.prior_research : {};
    parsed = {
      title: plan.title || topicText,
      inquiry_topic: intro.inquiry_topic || [],
      inquiry_purpose: intro.inquiry_purpose || [],
      prior_research: { theory: pr.theory || [], analysis: pr.analysis || [] },
      process: core.process || [],
      results_reflection: core.results_reflection || [],
      references: plan.references || [],
    };
    cost = calcCost({ usage: usageAgg, webSearchCount: webSearchTotal, model: MODEL });
  } finally {
    // 업로드한 PDF 정리(베스트에포트).
    if (uploadedFileIds.length) {
      await Promise.all(uploadedFileIds.map((id) => deleteAnthropicFile(id)));
    }
  }
  }

  onProgress(`✓ 생성 완료 (총 ${charCount}자, ${elapsed()}초) — 조립·후처리 중`);
  onProgress(formatCostLine(cost));

  parsed = require("../../output-sanitize").sanitize(parsed, {
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
    allowHighlights,
  });

  // 모델이 종종 ① 복잡한 수식 구절을 *...*로 감싸 별표가 raw로 노출되고
  // ② p_i 같은 비중괄호 첨자를 써 변환이 안 된다 — 둘 다 결정적으로 정리.
  const markerFixes = { count: 0 };
  deepCleanMarkers(parsed, markerFixes);
  if (markerFixes.count) onProgress(`🧹 표기 정리: 별표/첨자 ${markerFixes.count}곳`);

  if (!parsed.title) parsed.title = topicText || "급수 탐구보고서";
  if (date) parsed.date = date;

  const sectionCount = [
    parsed.inquiry_topic,
    parsed.inquiry_purpose,
    parsed.prior_research,
    parsed.process,
    parsed.results_reflection,
  ].filter(Boolean).length;
  onProgress(`📋 구조: Ⅰ~Ⅴ 중 ${sectionCount}개 절, 참고문헌 ${(parsed.references || []).length}개`);

  // 프롬프트는 차트를 { labels, datasets:[{label, data}] } 스키마로 내지만,
  // 공용 렌더러(chem-result/chart-gen · svg-chart-gen)는 { x_values, series:[{label, values}] }
  // 를 읽는다. 키가 안 맞으면 축만 있고 데이터가 빈 PNG가 나온다. 렌더 전에
  // 결정적으로 렌더러 스키마로 어댑트한다(원래 type/title/축/reference_line 등은 보존).
  const adaptChartSpec = (ch) => {
    if (!ch || typeof ch !== "object") return ch;
    const hasRendererShape =
      Array.isArray(ch.x_values) || Array.isArray(ch.series);
    const hasModelShape =
      Array.isArray(ch.labels) || Array.isArray(ch.datasets);
    if (hasRendererShape || !hasModelShape) return ch; // 이미 맞거나 어댑트 대상 아님
    const adapted = { ...ch };
    if (Array.isArray(ch.labels)) adapted.x_values = ch.labels;
    if (Array.isArray(ch.datasets)) {
      adapted.series = ch.datasets.map((d) => {
        if (!d || typeof d !== "object") return { label: "", values: [] };
        const s = { ...d, label: d.label };
        // scatter 는 points 를 그대로 두고, 일반 계열은 data → values 로 옮긴다.
        if (Array.isArray(d.data) && !Array.isArray(d.points)) {
          s.values = d.data;
        }
        return s;
      });
    }
    return adapted;
  };

  // 데이터 없는 빈 차트 블록은 본문에서 통째로 제거 — 축만 있는 빈 그래프 PNG가
  // 보고서에 들어가는 것을 방지(chem-result와 동일 정책). 게이트와 렌더러가
  // 같은 판단을 하도록, 어댑트한 렌더러 스키마(series[].values / points) 기준으로 본다.
  const hasPlottable = (data) =>
    Array.isArray(data) &&
    data.some((v) => {
      if (v == null || v === "") return false;
      if (Array.isArray(v))
        return Number.isFinite(Number(v[1])) || Number.isFinite(Number(v[0]));
      if (typeof v === "object")
        return Number.isFinite(Number(v.y ?? v[1])) || Number.isFinite(Number(v.x ?? v[0]));
      return Number.isFinite(Number(v));
    });
  const chartHasData = (ch) => {
    const spec = adaptChartSpec(ch);
    const series = Array.isArray(spec?.series) ? spec.series : [];
    return series.some((s) => hasPlottable(s?.values) || hasPlottable(s?.points));
  };
  let droppedEmptyCharts = 0;
  (function pruneEmptyCharts(node) {
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) {
        const item = node[i];
        if (
          item && typeof item === "object" && !Array.isArray(item) &&
          item.chart && typeof item.chart === "object" && !chartHasData(item.chart)
        ) {
          node.splice(i, 1);
          droppedEmptyCharts++;
        } else {
          pruneEmptyCharts(item);
        }
      }
      return;
    }
    if (node && typeof node === "object") Object.values(node).forEach(pruneEmptyCharts);
  })(parsed);
  if (droppedEmptyCharts)
    onProgress(`⚠️ 데이터 없는 빈 차트 ${droppedEmptyCharts}개 제외`);

  // 차트 블록 → PNG 렌더 (표·그래프 자료 활용 평가요소)
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
      try {
        // 렌더러는 x_values/series 스키마를 읽으므로 어댑트한 spec 으로 렌더하고,
        // pngBuffer 는 다운스트림(docx-gen/hwpx-gen)이 참조하는 원본 chart 에 붙인다.
        const buf = await renderChart(adaptChartSpec(chart));
        if (buf) {
          Object.defineProperty(chart, "pngBuffer", { value: buf, enumerable: false });
          rendered++;
        }
      } catch (e) {
        onProgress(`⚠ 차트 렌더 실패(생략): ${e.message}`);
      }
    }
    if (rendered) onProgress(`📈 그래프 ${rendered}개 렌더 완료`);
  }

  const imageCost = calcImageCost({ searchCount: 0, generationCount: 0 });
  Object.defineProperty(parsed, "__cost", {
    value: cost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__imageCost", {
    value: imageCost,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(parsed, "__style", {
    value: "default",
    enumerable: false,
    writable: false,
  });

  return parsed;
}

function extractJson(text) {
  // 코드펜스를 모두 제거한 뒤, 문자열/이스케이프를 고려해 '깊이 0 으로 처음 닫히는'
  // 완전한 객체만 잘라낸다. 끊김 이어쓰기로 뒤에 중복 객체·군더더기가 붙어도(모델이
  // 객체를 다 쓴 뒤 또 출력하는 경우) 첫 완전 JSON 만 취해 "Unexpected non-whitespace
  // character after JSON" 파싱 실패를 피한다. 끝까지 안 닫히면(진짜 미완성) last '}' 폴백.
  const t = String(text || "").replace(/```+[ \t]*(?:json)?/gi, " ");
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
  }
  const last = t.lastIndexOf("}");
  return last > start ? t.slice(start, last + 1) : null;
}

// 지금까지 받은 텍스트가 이미 파싱 가능한 완전 JSON 인지(끊겨도 완성됐으면 이어쓰기 불필요).
function looksCompleteJson(text) {
  const j = extractJson(text);
  if (!j) return false;
  try {
    parseJsonLenient(j);
    return true;
  } catch {
    return false;
  }
}

module.exports = { generateReportContent };
