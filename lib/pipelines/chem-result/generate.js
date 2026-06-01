const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const path = require("path");
const {
  calcCost,
  calcImageCost,
  formatCostLine,
} = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { parseToMarkdown, parseToTables } = require("../../excel-parser");
const { buildStatsDigest } = require("../../data-stats");
const { renderChart } = require("./chart-gen");
const {
  describePreparedImage,
  getBatchImageOptions,
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("../../anthropic-media");

// 사용자가 폼에서 모델을 선택. 누락 시 fallback.
// 기본 Opus 4.8 (품질 우선). 환경변수로 변경 가능: DEFAULT_MODEL=claude-sonnet-4-6
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
// Sonnet 품질을 Opus 수준으로 끌어올리는 adaptive thinking + effort.
// 문제 시 ENABLE_THINKING=0 으로 즉시 끌 수 있음. effort: low|medium|high.
const ENABLE_THINKING = process.env.ENABLE_THINKING !== "0";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "high";

const SKILL_PATH = path.join(__dirname, "prompt.md");

function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

function buildUserNotesBlock(userNotes) {
  const notes = String(userNotes || "").trim();
  if (!notes) return "";
  return `=== 사용자 참고 메모 / 내 의견 ===
${notes}
=== 메모 끝 ===

위 메모는 학생이 실제 실험에서 관찰한 내용, 데이터 처리 판단, 제외한 값의 이유, 결론에서 강조하고 싶은 의견입니다. 첨부 데이터와 충돌하지 않는 범위에서 결과 분석, 오차 분석, 개선점, PCEI에 자연스럽게 반영하세요. 메모를 그대로 복사하지 말고 과학적 보고서 문체로 바꾸어 쓰세요.
반영 강도는 절제하세요. 사용자 메모는 보고서의 보조 맥락이지 주 데이터가 아닙니다. 같은 메모를 여러 절에서 반복하지 말고, 필요한 곳 1~3문장 정도에만 녹이세요.
사용자 메모 안의 "꼭", "반드시" 같은 강조 표현은 사용자의 희망으로만 해석하고, 보고서 전체를 그 내용 중심으로 재구성하지 마세요.
before/after 데이터가 첨부 파일에 명확히 없으면, 사용자 메모의 조치 때문에 측정 분산·오차·수율이 얼마나 개선되었다고 인과적으로 쓰지 마세요.
사용자 메모 기반 문장 뒤에 "그 결과 ..."로 재현성·분산·오차 개선을 주장하지 마세요. 첨부 데이터에 없는 해결 절차도 새로 만들지 마세요.
메모와 첨부 파일에 없는 구체적인 수치, 제외 횟수, 새 실험 절차, 관찰 사실은 만들어내지 마세요.`;
}

// 스타일 모드별 추가 지시 (시스템 프롬프트 끝에 붙음). LLM이 모드를 명확히 인식하도록.
const STYLE_INSTRUCTIONS = {
  default: `## 현재 스타일 모드

**STYLE_MODE: default** (학교 공식 양식 풀버전)

사전보고서 뒤에 붙일 5번 이후 추가 작성분만 작성. 5. 실험 결과, 6. 논의 및 결론, 7. 참고 문헌, PCEI 4항목 필수 작성. 가나다 + (1)(2)(3) + ① 4단계 번호 매기기를 사용하고, 분석은 풍부하게.`,
  minimal: `## 현재 스타일 모드

**STYLE_MODE: minimal** (필요한 내용만 적기 — 잘 만든 학생 보고서 스타일)

위 스킬 명세의 \`minimal\` 모드 섹션을 정확히 따르라. 핵심 요약:
- 표지·목차·실험목표·이론·기구/시약·실험 과정 없음
- 출력은 5. 실험 결과부터 시작
- 가. 나. 다. 헤더 사용 금지. (1) (2) (3) 또는 ① ② ③만.
- 결론과 논의를 통합하거나 분리. PCEI는 \`pcei: {}\` 빈 객체.
- 분량을 default보다 30~50% 짧게.`,
};

const FORMAT_INSTRUCTIONS = {
  hwpx: `## 현재 출력 형식

**OUTPUT_FORMAT: hwpx**

- 복잡한 수식, 계산식, 독립 반응식은 반드시 한컴 수식 마커로 작성하세요: \`{{EQ:...}}\` 또는 번호가 필요한 경우 \`{{EQN:...}}\`.
- 이 마커는 최종 HWPX에서 한글 수식 편집기 객체로 변환되는 내부 표기입니다. \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 같은 wiki식 표기는 금지입니다.
- 수식만 따로 보여줄 줄은 배열의 독립 문자열 하나로 두고, 앞에 \`(1)\`, \`①\`, \`②\` 같은 번호를 직접 쓰지 마세요. 렌더러가 문단 번호와 수식 줄을 정리합니다.
- 화학 반응식도 독립 줄이면 \`{{EQ:2H_2 + O_2 -> 2H_2 O}}\`처럼 수식 마커를 사용하세요.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- \`{{EQ:...}}\`, \`{{EQN:...}}\`, \`{{MATH:...}}\` 같은 중괄호 수식 마커를 출력하지 마세요.
- docx에서는 본문 인라인 표기만 사용합니다: \`H_{2}O\`, \`10^{-3}\`, \`*PV* = *nRT*\`, \`→\`, \`×\`.`,
};

function applyHighlightPolicy(text, allowHighlights) {
  if (allowHighlights) return text;
  const plainLine =
    "- 핵심 하이라이트: 관리자 전용 기능이므로 `**내용**` 마커를 사용하지 마세요. 강조가 필요하면 일반 문장으로 자연스럽게 표현하세요.";
  const boldLine =
    "- **핵심 하이라이트**: 관리자 전용 기능이므로 `**내용**` 마커를 사용하지 마세요. 강조가 필요하면 일반 문장으로 자연스럽게 표현하세요.";
  return String(text)
    .replace(/- 핵심 하이라이트: `\*\*내용\*\*`[^\n]*/g, plainLine)
    .replace(/- \*\*핵심 하이라이트\*\*: `\*\*내용\*\*`[^\n]*/g, boldLine);
}

function buildSystemPrompt(
  style = "default",
  outputFormat = "docx",
  { allowHighlights = true } = {},
) {
  const skill = applyHighlightPolicy(loadSkill(), allowHighlights);
  const styleSection = STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.default;
  const formatSection =
    FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  return `당신은 (영재학교)과학고등학교 학생을 위한 화학실험 결과보고서 자동 생성 도우미입니다.

아래는 결과보고서 작성에 따라야 할 스킬 명세입니다. 모든 규칙(번호 체계, 데이터 처리, JSON 출력)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

## 작업 절차

1. 첨부된 사전보고서(PDF/docx)에서 실험 목표·이론·기구/시약·과정 추출.
2. 첨부된 실험 데이터(엑셀·CSV·텍스트·사진)에서 측정값 파악. 사진/스크린샷이면 vision으로 읽기.
3. 통계 자동 계산 (평균·표준편차·백분율 오차).
4. 매뉴얼이 있으면 함께 참조해 보완.
5. 결과 분석·오차 분석·개선점·PCEI 작성 (default 모드만).
6. JSON 출력.

## 출력 범위

이 결과물은 이미 작성된 사전보고서 PDF 뒤에 붙일 **추가 작성분**입니다.

- 사전보고서에 이미 들어 있는 실험목표, 이론적 배경, 실험 기구 및 시약, 실험 과정은 최종 문서 본문에 다시 쓰지 않습니다.
- 최종 렌더링 대상은 "5. 실험 결과", "6. 논의 및 결론", "7. 참고 문헌", "추가 작성 (PCEI)"입니다.
- JSON 스키마 호환을 위해 title_kr, title_en, date, conditions, data, discussion, references, pcei를 채우세요.
- purpose, theory, apparatus, chemicals, procedure는 사전보고서 분석에만 사용하고, 가능하면 빈 배열([])로 두세요.
- 결과 분석에서 사전보고서의 예상·가설·이론과 실제 실험 결과가 어떻게 맞거나 달랐는지 비교하세요.

${styleSection}

${formatSection}

## 출력 형식 (매우 중요)

**최종 출력은 반드시 단 하나의 JSON 코드 블록 (\`\`\`json ... \`\`\`)입니다.** 그 외 텍스트 일체 금지.
`;
}

/**
 * Generate result report content.
 *
 * @param {Object} args
 * @param {Buffer} args.preReportBuffer  사전보고서 PDF/docx (필수)
 * @param {string} args.preReportName    파일명 (확장자 판별용)
 * @param {Buffer|null} args.dataBuffer  실험 데이터 (엑셀/csv/txt/이미지)
 * @param {string} args.dataName         파일명
 * @param {Array<{buffer: Buffer, name: string, mimetype: string}>} args.photos  실험 사진 배열
 * @param {Buffer|null} args.manualBuffer  매뉴얼 PDF (선택)
 * @param {string} args.date            날짜 YYYY/MM/DD
 * @param {string} args.temperature     실험 온도 (예: "22.5")
 * @param {string} args.pressure        기압 (예: "1013.2")
 * @param {string} args.userNotes       사용자 참고 메모/의견
 * @param {Function} args.onProgress
 * @param {AbortSignal} args.signal
 * @param {string|null} args.model
 * @param {string} args.style  "default" | "minimal" — 보고서 스타일 모드
 */
async function generateReportContent({
  preReportBuffer,
  preReportName = "",
  dataBuffer = null,
  dataName = "",
  photos = [],
  manualBuffer = null,
  date,
  temperature = "",
  pressure = "",
  userNotes = "",
  onProgress = () => {},
  signal,
  model = null,
  style = "default",
  outputFormat = "docx",
  allowHighlights = true,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  if (!preReportBuffer) {
    throw new Error("사전보고서 파일이 필요합니다.");
  }

  const MODEL = model || DEFAULT_MODEL;
  const STYLE = style === "minimal" ? "minimal" : "default";
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  onProgress(`🤖 모델: ${MODEL} | 스타일: ${STYLE}`);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const system = buildSystemPrompt(STYLE, OUTPUT_FORMAT, { allowHighlights });

  // ── 사용자 메시지 구성 ─────────────────────────────────────────────────────
  const content = [];
  const attachmentSummary = [];
  const dataExt = dataBuffer ? (dataName.split(".").pop() || "").toLowerCase() : "";
  const dataIsImage = ["png", "jpg", "jpeg"].includes(dataExt);
  const imageOptions = getBatchImageOptions(photos.length + (dataIsImage ? 1 : 0));

  // 사전보고서 — PDF만 documents 블록으로 (docx는 Phase 2-3에서 텍스트 추출 추가)
  const preExt = (preReportName.split(".").pop() || "").toLowerCase();
  if (preExt === "pdf") {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: preReportBuffer.toString("base64"),
      },
    });
    attachmentSummary.push(`사전보고서 PDF (${Math.round(preReportBuffer.length / 1024)}KB)`);
  } else {
    // .docx는 일단 안내만 — Phase 2-3에서 텍스트 추출 추가 예정
    attachmentSummary.push(
      `사전보고서 ${preExt} (${Math.round(preReportBuffer.length / 1024)}KB) — 텍스트 추출 미구현, 빈 사전보고서로 처리`,
    );
  }

  if (OUTPUT_FORMAT === "docx" || OUTPUT_FORMAT === "hwpx") {
    onProgress("📎 출력 문서는 사전보고서 뒤에 붙일 결과 추가 작성분만 생성합니다.");
  }

  // 매뉴얼 (선택)
  if (manualBuffer) {
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: manualBuffer.toString("base64"),
      },
    });
    attachmentSummary.push(`매뉴얼 PDF (${Math.round(manualBuffer.length / 1024)}KB)`);
  }

  // 실험 데이터 — 이미지면 image 블록, PDF면 document 블록, 엑셀/CSV는 Phase 2-3
  if (dataBuffer) {
    if (dataIsImage) {
      const prepared = await prepareImageForAnthropic({
        buffer: dataBuffer,
        name: dataName,
      }, imageOptions);
      if (prepared.ok) {
        content.push(toAnthropicImageBlock(prepared));
        attachmentSummary.push(`데이터 사진 ${describePreparedImage(prepared)}`);
        if (prepared.compressed) {
          onProgress(`🖼️ 큰 데이터 이미지 자동 축소 후 Claude에 전송: ${dataName}`);
        }
      } else {
        content.push({
          type: "text",
          text: `=== 실험 데이터 이미지 (${dataName}) ===
이 이미지는 Claude vision 입력에서 제외되었습니다. 이유: ${prepared.reason}
이미지 자료가 보고서 작성에 필수라면 해상도를 낮춘 png/jpg로 다시 업로드해야 합니다.`,
        });
        attachmentSummary.push(`데이터 사진 ${describePreparedImage(prepared)}`);
      }
    } else if (dataExt === "pdf") {
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: dataBuffer.toString("base64"),
        },
      });
      attachmentSummary.push(`데이터 PDF (${Math.round(dataBuffer.length / 1024)}KB)`);
    } else if (dataExt === "txt") {
      // 일반 텍스트는 그대로 첨부
      const text = dataBuffer.toString("utf8").slice(0, 50000);
      content.push({
        type: "text",
        text: `=== 실험 데이터 (${dataName}) ===\n${text}\n=== 데이터 끝 ===`,
      });
      attachmentSummary.push(`데이터 ${dataExt} (텍스트 ${text.length}자)`);
    } else if (["xlsx", "xls", "csv"].includes(dataExt)) {
      // 엑셀/CSV는 markdown table로 자동 변환해서 첨부
      try {
        const parsed = parseToMarkdown(dataBuffer, dataExt);
        // 평균·표준편차는 코드로 직접 계산해 주입 (LLM 산수 오차 방어).
        let statsDigest = "";
        try {
          statsDigest = buildStatsDigest(parseToTables(dataBuffer, dataExt).tables);
        } catch {
          /* 통계 생략 — 데이터 블록은 그대로 전달 */
        }
        content.push({
          type: "text",
          text: `=== 실험 데이터 (${dataName}, 자동 파싱됨) ===

${parsed.text}

=== 데이터 끝 ===

${
  statsDigest
    ? "평균·표준편차는 아래 '코드 계산 통계값'을 그대로 사용하세요. 백분율 오차는 그 평균을 기준으로 계산하고, 스킬 명세의 유효숫자 규칙을 따르세요."
    : "위 데이터를 바탕으로 평균·표준편차·백분율 오차를 직접 계산하여 결과 섹션에 정확히 기록하세요. (스킬 명세의 유효숫자 규칙 준수)"
}`,
        });
        if (statsDigest) {
          content.push({ type: "text", text: statsDigest });
          attachmentSummary.push("📊 통계 코드 계산값 주입");
        }
        attachmentSummary.push(
          `데이터 ${dataExt} (${parsed.sheetCount}개 시트, ${parsed.totalRows}행 자동 파싱)`,
        );
      } catch (e) {
        attachmentSummary.push(`데이터 ${dataExt} — 파싱 실패: ${e.message}`);
      }
    } else {
      attachmentSummary.push(
        `데이터 ${dataExt} — 지원하지 않는 형식, 무시됨`,
      );
    }
  }

  // 실험 사진들
  let compressedImageCount = 0;
  let skippedImageCount = 0;
  for (const photo of photos) {
    const prepared = await prepareImageForAnthropic(photo, imageOptions);
    if (prepared.ok) {
      // 문서 삽입용 사진도 AI 전송용 축소본으로 교체해 메모리와 파일 크기를 줄인다.
      photo.buffer = prepared.buffer;
      photo.mimetype = prepared.mediaType;
      photo.name = prepared.name;
      content.push(toAnthropicImageBlock(prepared));
      if (prepared.compressed) compressedImageCount++;
    } else {
      photo.buffer = null;
      skippedImageCount++;
      content.push({
        type: "text",
        text: `=== 실험 사진 (${photo.name}) ===
이 이미지는 Claude vision 입력에서 제외되었습니다. 이유: ${prepared.reason}`,
      });
    }
  }
  if (photos.length > 0) {
    const status = [
      `${photos.length - skippedImageCount}장 전송`,
      compressedImageCount ? `${compressedImageCount}장 자동 축소` : "",
      skippedImageCount ? `${skippedImageCount}장 제외` : "",
    ]
      .filter(Boolean)
      .join(", ");
    attachmentSummary.push(`실험 사진 ${photos.length}장 (${status})`);
    if (compressedImageCount) {
      onProgress(`🖼️ 큰 실험 사진 ${compressedImageCount}장 자동 축소 후 Claude에 전송`);
    }
  }

  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
    attachmentSummary.push("사용자 참고 메모");
  }

  // 마지막에 텍스트 지시
  content.push({
    type: "text",
    text: `위 첨부 파일을 바탕으로 결과보고서 콘텐츠를 JSON으로 생성하세요.

**헤더 정보:**
- 실험 날짜: ${date || "(미지정)"}
- 실험 온도: ${temperature ? temperature + "°C" : "(미입력)"}
- 기압: ${pressure ? pressure + " hPa" : "(미입력)"}

**첨부 파일 요약:**
${attachmentSummary.map((s) => "- " + s).join("\n")}

스킬 명세에 정의된 JSON 스키마를 정확히 따르세요. 데이터가 부족하면 \`data.summary\`에 그 사실을 명시하세요.

최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };

  onProgress(`📤 첨부: ${attachmentSummary.join(", ")}`);

  // ── Stream + heartbeat (chem-pre와 동일 패턴) ────────────────────────────
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
        ? `Claude가 첨부 파일 분석 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    const stream = client.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Sonnet이 Opus 수준 품질을 내도록 adaptive thinking + effort 적용.
        ...(ENABLE_THINKING
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: THINKING_EFFORT },
            }
          : {}),
        system: [
          {
            type: "text",
            text: system,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [userMessage],
      },
      signal ? { signal } : undefined,
    );

    stream.on("streamEvent", (event) => {
      lastEventAt = Date.now();

      if (event.type === "content_block_start") {
        const block = event.content_block;
        if (block?.type === "text") {
          textBlocksStarted++;
          if (textBlocksStarted === 1) {
            onProgress(`✍️ 보고서 작성 시작 (${elapsed()}초)`);
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
          onProgress(`보고서 작성 중... (${charCount}자, ${elapsed()}초)`);
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

    cost = calcCost({
      usage: finalMessage.usage,
      webSearchCount: 0,
      model: MODEL,
    });
  } finally {
    clearInterval(heartbeat);
  }

  onProgress(`✓ Claude 응답 완료 (총 ${charCount}자, ${elapsed()}초) — JSON 파싱 중`);
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
  // Claude 출력에 섞일 수 있는 비정상 마크업 제거.
  parsed = require("../../output-sanitize").sanitize(parsed, {
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
    allowHighlights,
  });

  const stats = [];
  if (parsed.theory) stats.push(`이론 ${parsed.theory.length}개`);
  if (parsed.chemicals) stats.push(`시약 ${parsed.chemicals.length}개`);
  if (parsed.procedure) stats.push(`과정 ${parsed.procedure.length}개`);
  if (parsed.data?.experiments) stats.push(`측정 실험 ${parsed.data.experiments.length}개`);
  if (stats.length > 0) onProgress(`📋 콘텐츠 구조: ${stats.join(", ")}`);

  if (date) parsed.date = date;
  parsed.conditions = parsed.conditions || {};
  if (temperature) parsed.conditions.temperature = temperature + "°C";
  if (pressure) parsed.conditions.pressure = pressure + " hPa";

  // 사진 buffer를 docx-gen.js가 photo_indices로 매칭할 수 있게 attach
  // non-enumerable이라 JSON 직렬화/로깅에 영향 없음
  if (photos.length > 0) {
    Object.defineProperty(parsed, "__photos", {
      value: photos.map((p) => ({
        buffer: p.buffer,
        name: p.name,
        mimetype: p.mimetype,
      })),
      enumerable: false,
      writable: false,
    });
  }

  // 차트 렌더링 (chartjs-node-canvas → PNG buffer)
  const charts = Array.isArray(parsed.data?.charts) ? parsed.data.charts : [];
  if (charts.length > 0) {
    onProgress(`📊 차트 ${charts.length}개 렌더링 중...`);
    let renderedCount = 0;
    for (const chart of charts) {
      const buf = await renderChart(chart);
      if (buf) {
        // pngBuffer를 chart spec에 attach (docx-gen.js가 사용)
        // non-enumerable로 두면 다른 곳에서 JSON.stringify 시 영향 없음
        Object.defineProperty(chart, "pngBuffer", {
          value: buf,
          enumerable: false,
          writable: false,
        });
        renderedCount++;
      }
    }
    onProgress(`✓ 차트 ${renderedCount}/${charts.length}개 PNG 생성 완료`);
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
  // docx-gen이 minimal vs default 분기에 사용
  Object.defineProperty(parsed, "__style", {
    value: STYLE,
    enumerable: false,
    writable: false,
  });

  return parsed;
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

module.exports = { generateReportContent };
