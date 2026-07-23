const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const {
  calcCost,
  calcImageCost,
  formatCostLine,
} = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { parseSpreadsheet } = require("../../excel-parser");
const { extractDocxText } = require("../../docx-text");
const { buildStatsDigest } = require("../../data-stats");
const { renderChart } = require("./chart-gen");
const {
  describePreparedImage,
  getBatchImageOptions,
  prepareImageForAnthropic,
  toAnthropicImageBlock,
} = require("../../anthropic-media");
const styleRef = require("../../style-ref");
const {
  isGptModel,
  usesOpenAiCompat,
  providerConfigured,
  callGptReport,
  gptConfigured,
} = require("../../model-call");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { streamWithContinuation, extractJson } = require("../../claude-stream");

// 사용자가 폼에서 모델을 선택. 누락 시 fallback.
// 기본 Opus 4.8 (품질 우선). 환경변수로 변경 가능: DEFAULT_MODEL=claude-sonnet-5
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
// Sonnet 품질을 Opus 수준으로 끌어올리는 adaptive thinking + effort.
// 추론 기본 OFF (Sonnet thinking이 무거운 입력에서 너무 느려 타임아웃). 켜려면 ENABLE_THINKING=1. effort: low|medium|high.
const ENABLE_THINKING = process.env.ENABLE_THINKING === "1";
const THINKING_EFFORT = process.env.THINKING_EFFORT || "medium";

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
- **비울 수 있는 것은 오직 사전보고서 영역(purpose, theory, apparatus, chemicals, procedure)뿐**입니다 — 이들은 빈 배열([])로 두세요.
- **그 외에는 절대 비우지 마세요.** 측정 데이터가 있으면 data.experiments(측정표)·data.summary_table·data.charts·data.summary 를 반드시 채우고, discussion.analysis/errors/improvements·references·(default 모드) pcei 도 이 결과보고서의 본문이므로 반드시 채웁니다. 결과 표와 논의가 빈 보고서는 실패입니다.
- 결과 분석에서 사전보고서의 예상·가설·이론과 실제 실험 결과가 어떻게 맞거나 달랐는지 비교하세요.

${styleSection}

${formatSection}

## 출력 형식 (매우 중요)

**최종 출력은 반드시 단 하나의 JSON 코드 블록 (\`\`\`json ... \`\`\`)입니다.** 그 외 텍스트 일체 금지.
`;
}

// ── 응답 후처리 헬퍼 ─────────────────────────────────────────────────────────

// 렌더러가 "가. 결과 분석"·"나. 오차 분석 및 개선점" 같은 고정 소제목을 직접 출력하므로,
// 모델이 논의 항목 첫 줄에 같은 제목을 또 쓰면 문서에 소제목이 이중으로 표기된다.
// 과도 제거를 막기 위해 '가.|나.|다.|라.' 접두(선택) + 제목 문구만으로 이루어진
// 15자 이내의 행에만 적용한다. ("개선점 없음"처럼 내용이 이어지는 행은 건드리지 않음)
const DISCUSSION_TITLE_LINE_RE =
  /^(?:[가나다라]\s*\.\s*)?(?:결과\s*분석|오차\s*분석(?:\s*및\s*개선(?:점|\s*방안)?)?|개선(?:점|\s*방안|\s*사항)?|고찰)\s*[:：]?$/;

function stripLeadingSectionTitleLine(item) {
  const text = String(item);
  const nlIdx = text.indexOf("\n");
  const rawFirst = nlIdx === -1 ? text : text.slice(0, nlIdx);
  // 제목 판정은 굵게 마커·markdown 헤더 기호를 벗긴 형태로, 제거는 원본 행 단위로.
  const probe = rawFirst
    .trim()
    .replace(/^#{1,4}\s*/, "")
    .replace(/^\*\*(.*)\*\*$/s, "$1")
    .trim();
  if (!probe || probe.length > 15 || !DISCUSSION_TITLE_LINE_RE.test(probe)) {
    return text;
  }
  return nlIdx === -1 ? "" : text.slice(nlIdx + 1).replace(/^\s+/, "");
}

// 결과 본문 완결성 가드 (테스트를 위해 분리).
// '빈 껍데기'(valid JSON이지만 내용 없음) 보고서면 오류 메시지를, 정상이면 null을 반환.
// - 측정 데이터 파일이 있으면: 표·차트·논의가 모두 비어야 실패 (기존 규칙 유지).
// - 사진만 있는 정성 실험이면: 표·차트가 없는 것이 정상일 수 있으므로,
//   서술 섹션(data.summary + discussion) 총 글자 수 하한으로만 판정한다.
//   서술까지 없는 진짜 빈 보고서는 여전히 실패로 본다 (날조 우회 방지).
const QUALITATIVE_MIN_NARRATIVE_CHARS = 300;

function emptyReportError(parsed, { hasData, hasPhotos }) {
  if (!hasData && hasPhotos) {
    const narrativeChars = [
      parsed?.data?.summary,
      ...(Array.isArray(parsed?.discussion?.analysis) ? parsed.discussion.analysis : []),
      ...(Array.isArray(parsed?.discussion?.errors) ? parsed.discussion.errors : []),
      ...(Array.isArray(parsed?.discussion?.improvements) ? parsed.discussion.improvements : []),
    ]
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .join("").length;
    if (narrativeChars < QUALITATIVE_MIN_NARRATIVE_CHARS) {
      return "정성 관찰 서술이 거의 없는 빈 결과보고서가 생성되었습니다. 잠시 후 다시 시도해 주세요.";
    }
    return null;
  }
  if (hasData) {
    const expArr = Array.isArray(parsed?.data?.experiments) ? parsed.data.experiments : [];
    const anyExpRows = expArr.some((e) => e?.table?.rows?.length || e?.rows?.length);
    const summaryRows = parsed?.data?.summary_table?.rows?.length;
    const noTables = !anyExpRows && !summaryRows;
    const noCharts = !(parsed?.data?.charts?.length);
    const noDiscussion = !(parsed?.discussion?.analysis?.length);
    if (noTables && noCharts && noDiscussion) {
      return "결과 표·차트·논의가 모두 비어 있는 빈 결과보고서가 생성되었습니다. 잠시 후 다시 시도해 주세요.";
    }
  }
  return null;
}

// 차트 spec의 series에 실제로 그릴 값(values/data/points)이 하나라도 있는지.
// 차트 렌더 재실패를 fatal로 볼지(값이 있는데 못 그림) 드롭으로 볼지(그릴 값이
// 없음) 판정하는 기준(DEF-009). x_values만 있고 series 값이 전부 빈 spec은
// 렌더 대상이 아니므로 fatal이 아니다.
function chartSeriesHasValues(ch) {
  const series = Array.isArray(ch && ch.series) ? ch.series : [];
  return series.some((s) => {
    const vals = s && (s.values || s.data || s.points);
    return (
      Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0
    );
  });
}

// 업로드 원본(구조화 엑셀/CSV) 표에서 line 차트 spec 1개를 만든다.
// 모델이 charts를 아예 비워 보낸 경우의 backfill 전용 - 값은 원본 표에서 읽은
// 실측값 그대로(다운샘플만) 사용하고, 원본에 없는 값은 만들지 않는다.
const CHART_BACKFILL_MAX_POINTS = 60;
const CHART_BACKFILL_MAX_SERIES = 3;

function asChartNumber(value) {
  const s = String(value == null ? "" : value).trim().replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// 다운샘플: 균등 간격으로 최대 maxPoints개만 남기고, 마지막 점은 원본 마지막 행으로 유지.
function downsampleRows(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  if (out[out.length - 1] !== rows[rows.length - 1]) {
    out[out.length - 1] = rows[rows.length - 1];
  }
  return out;
}

function buildChartSpecFromTables(tables) {
  if (!Array.isArray(tables)) return null;
  for (const table of tables) {
    const headers = Array.isArray(table?.headers) ? table.headers : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    if (headers.length < 2 || rows.length < 3) continue;

    // 열별 숫자 판정: 비어있지 않은 값이 3개 이상이고 그중 80% 이상이 숫자면 수치 열.
    const numericCols = [];
    for (let c = 0; c < headers.length; c++) {
      const nonEmpty = rows
        .map((r) => String(r?.[c] == null ? "" : r[c]).trim())
        .filter((v) => v !== "");
      const numeric = nonEmpty.filter((v) => asChartNumber(v) != null);
      if (numeric.length >= 3 && numeric.length / nonEmpty.length >= 0.8) {
        numericCols.push(c);
      }
    }
    if (numericCols.length === 0) continue;

    // x축: 수치 열이 2개 이상이면 첫 수치 열(시계열 x), 아니면 첫 열을 카테고리 라벨로.
    let xCol;
    let yCols;
    if (numericCols.length >= 2) {
      xCol = numericCols[0];
      yCols = numericCols.slice(1, 1 + CHART_BACKFILL_MAX_SERIES);
    } else if (numericCols[0] !== 0) {
      xCol = 0;
      yCols = [numericCols[0]];
    } else {
      continue; // 수치 열이 첫 열 하나뿐이면 y로 쓸 계열이 없음
    }
    const xIsNumeric = numericCols.includes(xCol);

    // x가 유효하고 선택한 y가 전부 숫자인 행만 사용. 부족하면 첫 y 계열만으로 재시도.
    const usableWith = (cols) => {
      const usable = rows.filter((r) => {
        const xOk = xIsNumeric
          ? asChartNumber(r?.[xCol]) != null
          : String(r?.[xCol] == null ? "" : r[xCol]).trim() !== "";
        return xOk && cols.every((c) => asChartNumber(r?.[c]) != null);
      });
      return usable.length >= 3 ? usable : null;
    };
    let usable = usableWith(yCols);
    if (!usable && yCols.length > 1) {
      yCols = [yCols[0]];
      usable = usableWith(yCols);
    }
    if (!usable) continue;

    const sampled = downsampleRows(usable, CHART_BACKFILL_MAX_POINTS);
    const xHeader = String(headers[xCol] || "").trim() || "X";
    const yHeader = String(headers[yCols[0]] || "").trim() || "Y";
    return {
      title: `${yHeader} vs ${xHeader}`,
      type: "line",
      x_label: xHeader,
      y_label: yCols.length > 1 ? "측정값" : yHeader,
      x_values: sampled.map((r) =>
        xIsNumeric ? asChartNumber(r[xCol]) : String(r[xCol]).trim(),
      ),
      series: yCols.map((c) => ({
        label: String(headers[c] || `Series ${c + 1}`).trim(),
        values: sampled.map((r) => asChartNumber(r[c])),
      })),
      caption: `업로드 데이터(${String(table?.sheetName || "표")})에서 서버가 자동 생성한 그래프${
        usable.length > sampled.length
          ? ` (원본 ${usable.length}행 중 ${sampled.length}점 표시)`
          : ""
      }`,
    };
  }
  return null;
}

// ── 미참조 업로드 사진 자동 배치 (DEF-036) ──────────────────────────────────
// 렌더러(docx-gen.js·hwpx-gen.py)는 data.experiments[].photo_indices 로 참조된
// 사진만 문서에 싣는다. 모델(특히 GPT-mini)이 업로드 사진을 photo_indices 어디에도
// 넣지 않으면 사진이 통째로 빠지므로, 참조 인덱스를 전수 수집해 빠진 사진을
// "5. 실험 결과"의 마지막 실험 항목 뒤에 덧붙인다. 새 필드를 만들지 않고 기존
// photo_indices 계약만 사용하며, 사진 원본·캡션 내용은 지어내지 않는다.

// parsed JSON 전체를 재귀 순회하며 photo_indices 배열의 정수 인덱스를 모은다.
// (숫자 문자열 "0"도 렌더러가 인덱스로 해석하므로 함께 수집)
function collectReferencedPhotoIndices(value, out = new Set()) {
  if (value == null || typeof value !== "object" || Buffer.isBuffer(value)) {
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectReferencedPhotoIndices(v, out);
    return out;
  }
  for (const [key, v] of Object.entries(value)) {
    if (key === "photo_indices" && Array.isArray(v)) {
      for (const idx of v) {
        const n = Number(idx);
        if (Number.isInteger(n)) out.add(n);
      }
    } else {
      collectReferencedPhotoIndices(v, out);
    }
  }
  return out;
}

// 미참조 사진 인덱스를 마지막 실험의 photo_indices 끝에 추가하고 배치 수를 반환.
// - 렌더 불가 사진(vision 전처리 제외로 buffer 가 null)은 배치 대상이 아니다.
// - 실험 항목이 하나도 없으면 사진 전용 항목 하나를 만들어 결과 섹션 끝에 둔다.
// - 전부 참조된 경우 콘텐츠를 일절 변경하지 않는다.
function placeUnreferencedPhotos(parsed, photos) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const total = Array.isArray(photos) ? photos.length : 0;
  if (!total) return 0;
  const referenced = collectReferencedPhotoIndices(parsed);
  const missing = [];
  for (let i = 0; i < total; i++) {
    const photo = photos[i];
    if (!photo || !Buffer.isBuffer(photo.buffer) || photo.buffer.length === 0) {
      continue; // 렌더러도 싣지 못하는 사진(제외됨)은 건너뜀
    }
    if (!referenced.has(i)) missing.push(i);
  }
  if (!missing.length) return 0;
  if (parsed.data == null) parsed.data = {};
  if (typeof parsed.data !== "object" || Array.isArray(parsed.data)) return 0;
  if (!Array.isArray(parsed.data.experiments)) parsed.data.experiments = [];
  const exps = parsed.data.experiments;
  let target = exps.length ? exps[exps.length - 1] : null;
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    target = { name: "실험 사진" };
    exps.push(target);
  }
  if (!Array.isArray(target.photo_indices)) target.photo_indices = [];
  target.photo_indices.push(...missing);
  return missing.length;
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
  styleRefs = [],
  styleNote = "",
  onProgress = () => {},
  signal,
  model = null,
  style = "default",
  outputFormat = "docx",
  allowHighlights = true,
}) {
  if (!preReportBuffer) {
    throw new Error("사전보고서 파일이 필요합니다.");
  }

  const MODEL = model || DEFAULT_MODEL;
  const USE_GPT = usesOpenAiCompat(MODEL);
  if (USE_GPT) {
    if (!providerConfigured(MODEL)) {
      throw new Error(`${MODEL} 제공자 API 키가 서버에 설정되지 않았습니다.`);
    }
  } else if (!byok.anthropicKey()) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }

  const STYLE = style === "minimal" ? "minimal" : "default";
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  const hasStyleRef = styleRef.hasStyle({ styleRefs, styleNote });
  onProgress(`🤖 모델: ${MODEL} | 스타일: ${STYLE}${hasStyleRef ? " | 내 문체 반영" : ""}`);

  const client = byok.anthropicKey()
    ? new Anthropic({ apiKey: byok.anthropicKey(), timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ })
    : null;
  const system =
    buildSystemPrompt(STYLE, OUTPUT_FORMAT, { allowHighlights }) +
    (hasStyleRef ? "\n\n" + styleRef.STYLE_SYSTEM_SECTION : "");

  // ── 사용자 메시지 구성 ─────────────────────────────────────────────────────
  const content = [];
  const attachmentSummary = [];

  // 큰 PDF(사전보고서·매뉴얼·데이터)를 인라인 base64 로 보내면 Anthropic "요청당 32MB"
  // 한도(base64 약 1.33배 부풀음 → 단일 PDF ~24MB 인라인 한계)에 걸린다. 여러 PDF 가
  // 누적되면 더 쉽게 초과한다. 임계 초과 PDF 는 Claude 경로에서 Files API(file_id)로
  // 업로드해 우회하고, 인라인은 누적 예산으로 추적해 합산이 한도를 넘지 않게 한다.
  // GPT 경로는 Files API file_id 를 못 쓰므로(model-call.js 는 base64 만 변환) 항상 인라인.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024; // 단일 PDF 가 이보다 크면 Files API
  const INLINE_B64_BUDGET = 18 * 1024 * 1024; // 인라인 base64 누적 상한(여유분 둔 ~24MB 보수치)
  let inlineB64Used = 0;
  let usedFileApi = false;
  let inlineOversizePdf = false; // GPT 경로에서 큰 PDF 를 인라인으로 보낼 수밖에 없었던 경우 추적
  const uploadedFileIds = [];
  // file_id는 키/계정 범위이므로 업로드와 finally 삭제에 같은 키를 고정한다.
  const filesApiKey = !USE_GPT ? byok.anthropicKey() : "";

  // PDF 한 개를 content 에 추가한다. 임계 초과 + Claude 경로면 Files API(file_id),
  // 아니면 인라인 base64. 인라인 누적 예산을 갱신한다.
  // label: 진행 로그/요약에 쓸 설명(예: "사전보고서").
  async function pushPdfBlock(buffer, name, { label = "PDF" } = {}) {
    const b64Len = Math.ceil(buffer.length / 3) * 4;
    const mb = Math.round((buffer.length / 1048576) * 10) / 10;
    const tooBigInline =
      buffer.length >= FILES_API_RAW_THRESHOLD ||
      inlineB64Used + b64Len > INLINE_B64_BUDGET;
    if (!USE_GPT && tooBigInline) {
      try {
        const fileId = await uploadFileToAnthropic(
          buffer,
          name || `${label}.pdf`,
          { signal, apiKey: filesApiKey },
        );
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        onProgress(`📤 큰 ${label} PDF 업로드(Files API): ${name || ""} (${mb}MB)`);
        return;
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
      }
    }
    // GPT 경로에서 큰 PDF 는 인라인밖에 못 쓴다 — 한도 초과 위험을 사용자에게 알릴 수 있게 표시.
    if (USE_GPT && tooBigInline) inlineOversizePdf = true;
    content.push({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: buffer.toString("base64"),
      },
    });
    inlineB64Used += b64Len;
  }

  const dataExt = dataBuffer ? (dataName.split(".").pop() || "").toLowerCase() : "";
  const dataIsImage = ["png", "jpg", "jpeg"].includes(dataExt);
  const imageOptions = getBatchImageOptions(photos.length + (dataIsImage ? 1 : 0));

  // 사전보고서 - PDF는 document 블록으로, docx는 본문 텍스트를 추출해 text 블록으로.
  const preExt = (preReportName.split(".").pop() || "").toLowerCase();
  if (preExt === "pdf") {
    await pushPdfBlock(preReportBuffer, preReportName, { label: "사전보고서" });
    attachmentSummary.push(`사전보고서 PDF (${Math.round(preReportBuffer.length / 1024)}KB)`);
  } else if (preExt === "docx") {
    // 프롬프트 비대 방지용 추출 텍스트 상한. 초과분은 앞부분만 유지하고 생략 표기.
    const PRE_TEXT_MAX_CHARS = 40000;
    let preText = "";
    try {
      preText = await extractDocxText(preReportBuffer);
    } catch (e) {
      onProgress(`⚠️ 사전보고서 docx 텍스트 추출 실패: ${e.message}`);
    }
    if (preText.trim()) {
      const totalChars = preText.length;
      const truncated = totalChars > PRE_TEXT_MAX_CHARS;
      if (truncated) {
        preText = preText.slice(0, PRE_TEXT_MAX_CHARS) + "\n[이하 생략]";
      }
      content.push({
        type: "text",
        text: `=== 사전보고서 (docx 추출 텍스트) ===\n${preText}\n=== 사전보고서 끝 ===`,
      });
      attachmentSummary.push(
        `사전보고서 docx (본문 ${totalChars}자 추출${truncated ? `, ${PRE_TEXT_MAX_CHARS}자 이후 생략` : ""})`,
      );
    } else {
      // 추출 실패 또는 본문 없음(이미지 전용 docx 등) - 기존처럼 빈 사전보고서로 graceful fallback.
      attachmentSummary.push(
        `사전보고서 docx (${Math.round(preReportBuffer.length / 1024)}KB) - 텍스트 추출 실패, 빈 사전보고서로 처리`,
      );
    }
  } else {
    attachmentSummary.push(
      `사전보고서 ${preExt} (${Math.round(preReportBuffer.length / 1024)}KB) - 텍스트 추출 미지원, 빈 사전보고서로 처리`,
    );
  }

  if (OUTPUT_FORMAT === "docx" || OUTPUT_FORMAT === "hwpx") {
    onProgress("📎 출력 문서는 사전보고서 뒤에 붙일 결과 추가 작성분만 생성합니다.");
  }

  // 매뉴얼 (선택)
  if (manualBuffer) {
    await pushPdfBlock(manualBuffer, "manual.pdf", { label: "매뉴얼" });
    attachmentSummary.push(`매뉴얼 PDF (${Math.round(manualBuffer.length / 1024)}KB)`);
  }

  // 실험 데이터 - 이미지면 image 블록, PDF면 document 블록, 엑셀/CSV는 markdown 자동 파싱.
  // 구조화 표는 차트 backfill(모델이 charts를 비워 보낸 경우)용으로 따로 보관한다.
  let structuredDataTables = null;
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
      await pushPdfBlock(dataBuffer, dataName, { label: "데이터" });
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
        // Markdown 입력과 코드 계산용 표를 같은 workbook/시트 파싱에서 만든다.
        const parsed = parseSpreadsheet(dataBuffer, dataExt);
        // 평균·표준편차는 코드로 직접 계산해 주입 (LLM 산수 오차 방어).
        let statsDigest = "";
        structuredDataTables = parsed.tables;
        try {
          statsDigest = buildStatsDigest(structuredDataTables);
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

  if (hasStyleRef) {
    content.push(...(await styleRef.buildStyleBlocks({ styleRefs, styleNote })));
    attachmentSummary.push("내 문체 참고");
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
  // GPT 경로는 Files API 우회를 못 써서 큰 PDF 가 인라인으로만 전송된다 — 요청 한도 초과 위험을 미리 알림.
  if (USE_GPT && inlineOversizePdf) {
    onProgress(
      "⚠ GPT 모델은 큰 PDF 우회 업로드를 지원하지 않아 PDF가 인라인으로 전송됩니다. PDF가 매우 크면 실패할 수 있으니, 실패 시 Claude 모델로 다시 시도하거나 PDF를 줄여 주세요.",
    );
  }

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
        ? `모델이 첨부 파일 분석 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    if (usesOpenAiCompat(MODEL)) {
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
      // 끊김(Premature close)·길이(max_tokens) 복구 포함 스트리밍(공용 헬퍼).
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
        enableThinking: ENABLE_THINKING,
        thinkingEffort: THINKING_EFFORT,
        onProgress,
        startedAt,
      });
      finalText = result.text;
      firstTokenSeen = true;
      cost = calcCost({
        usage: result.usage,
        webSearchCount: result.webSearchCount,
        model: MODEL,
      });
    }
  } finally {
    clearInterval(heartbeat);
    // Files API 로 올린 임시 파일 정리(베스트에포트 — 실패 무시).
    if (uploadedFileIds.length) {
      await Promise.all(
        uploadedFileIds.map((id) =>
          deleteAnthropicFile(id, { apiKey: filesApiKey }),
        ),
      );
    }
  }

  charCount = (finalText || "").length;
  onProgress(`✓ 응답 완료 (총 ${charCount}자, ${elapsed()}초) — JSON 파싱 중`);
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

  // 논의 항목 선두의 중복 소제목 행 제거 - 렌더러의 고정 소제목과 이중 표기 방지.
  if (parsed.discussion && typeof parsed.discussion === "object") {
    let removedTitleLines = 0;
    for (const key of ["analysis", "errors", "improvements"]) {
      const arr = parsed.discussion[key];
      if (!Array.isArray(arr)) continue;
      const cleaned = [];
      for (const item of arr) {
        if (typeof item !== "string") {
          cleaned.push(item);
          continue;
        }
        const stripped = stripLeadingSectionTitleLine(item);
        if (stripped !== item) {
          removedTitleLines++;
          if (!stripped.trim()) continue; // 제목 행 하나뿐이던 항목은 통째로 제거
        }
        cleaned.push(stripped);
      }
      parsed.discussion[key] = cleaned;
    }
    if (removedTitleLines) {
      onProgress(`🧹 섹션 제목과 중복된 소제목 행 ${removedTitleLines}개 제거`);
    }
  }

  // 결과 본문 완결성 가드: '빈 껍데기'(valid JSON이지만 내용 없음) 보고서를 조용히
  // 내보내지 않는다. 사진만 있는 정성 실험은 표·차트 없이도 서술 총량으로 판정.
  {
    const guardError = emptyReportError(parsed, {
      hasData: !!dataBuffer,
      hasPhotos: Array.isArray(photos) && photos.length > 0,
    });
    if (guardError) throw new Error(guardError);
  }

  const stats = [];
  if (parsed.theory) stats.push(`이론 ${parsed.theory.length}개`);
  if (parsed.chemicals) stats.push(`시약 ${parsed.chemicals.length}개`);
  if (parsed.procedure) stats.push(`과정 ${parsed.procedure.length}개`);
  if (parsed.data?.experiments) stats.push(`측정 실험 ${parsed.data.experiments.length}개`);
  if (stats.length > 0) onProgress(`📋 콘텐츠 구조: ${stats.join(", ")}`);

  // pcei 누락 감지 - default 모드에서만 경고 (minimal은 pcei: {} 빈 객체가 정상 스펙).
  // 렌더러는 빈 pcei도 "(미작성)" placeholder로 섹션을 출력하므로 사용자에게 미리 알린다.
  if (STYLE === "default") {
    const pceiObj = parsed.pcei && typeof parsed.pcei === "object" ? parsed.pcei : {};
    const pceiFilled = Object.values(pceiObj).some(
      (v) => String(v == null ? "" : v).trim() !== "",
    );
    if (!pceiFilled) {
      onProgress("⚠️ PCEI 섹션이 생성되지 않았습니다");
    }
  }

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
  // 빈 데이터 차트(x_values·series 값이 전부 빔)는 제외 — 빈 그래프 방지.
  if (Array.isArray(parsed.data?.charts)) {
    const chartHasData = (ch) => {
      if (!ch || typeof ch !== "object") return false;
      const xs = Array.isArray(ch.x_values) ? ch.x_values.filter((v) => v !== "" && v != null) : [];
      const series = Array.isArray(ch.series) ? ch.series : [];
      const seriesHasVals = series.some((s) => {
        const vals = s && (s.values || s.data || s.points);
        return Array.isArray(vals) && vals.filter((v) => v !== "" && v != null).length > 0;
      });
      return xs.length > 0 || seriesHasVals;
    };
    const before = parsed.data.charts.length;
    parsed.data.charts = parsed.data.charts.filter(chartHasData);
    const dropped = before - parsed.data.charts.length;
    if (dropped) onProgress(`⚠️ 데이터 없는 빈 차트 ${dropped}개 제외`);
  }

  // 차트 backfill: 모델이 charts를 아예 비워 보냈는데(GPT에서 잦음) 업로드 원본에
  // 수치 계열 표가 있으면, 서버가 원본 값 그대로 line 차트 1개를 만들어 보충한다.
  if (!(parsed.data?.charts?.length) && structuredDataTables) {
    const backfillSpec = buildChartSpecFromTables(structuredDataTables);
    if (backfillSpec) {
      if (parsed.data == null) parsed.data = {};
      if (typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
        if (!Array.isArray(parsed.data.charts)) parsed.data.charts = [];
        parsed.data.charts.push(backfillSpec);
        onProgress(`📊 업로드 데이터 기반 차트 자동 생성: ${backfillSpec.title}`);
      }
    }
  }

  // 콘텐츠 구조 검증(DEF-010) - 파싱·sanitize·차트 정리까지 끝난 최종 콘텐츠 기준.
  // hard 결함은 차트 PNG 렌더 같은 비용이 드는 후속 작업 전에 즉시 실패시킨다.
  require("../../output-sanitize").assertContentSchema("chem-result", parsed, {
    format: OUTPUT_FORMAT,
    onProgress,
  });

  // 미참조 업로드 사진 자동 배치(DEF-036). photo_indices 에 한 번도 참조되지 않은
  // 사진이 문서에서 통째로 빠지는 문제(GPT-mini 재현) 방어. 스키마 검증 뒤에 두어
  // 기존 실패/경고 판정은 그대로 유지하고, 통과한 콘텐츠에만 배치를 보충한다.
  {
    const placedPhotoCount = placeUnreferencedPhotos(parsed, photos);
    if (placedPhotoCount) {
      onProgress(`📷 미참조 업로드 사진 ${placedPhotoCount}장 자동 배치`);
    }
  }

  const charts = Array.isArray(parsed.data?.charts) ? parsed.data.charts : [];
  if (charts.length > 0) {
    onProgress(`📊 차트 ${charts.length}개 렌더링 중...`);
    let renderedCount = 0;
    for (const chart of charts) {
      let buf = await renderChart(chart);
      if (!buf) {
        // renderChart는 실패 시 null 반환 - 무음 스킵하지 않고 알린 뒤 1회 재시도한다.
        onProgress(
          `⚠️ 차트 렌더 실패: ${(chart && chart.title) || "(제목 없음)"} (1회 재시도)`,
        );
        buf = await renderChart(chart);
      }
      if (buf) {
        // pngBuffer를 chart spec에 attach (docx-gen.js가 사용)
        // non-enumerable로 두면 다른 곳에서 JSON.stringify 시 영향 없음
        Object.defineProperty(chart, "pngBuffer", {
          value: buf,
          enumerable: false,
          writable: false,
        });
        renderedCount++;
      } else if (chartSeriesHasValues(chart)) {
        // 유효 데이터가 있는 차트의 렌더 실패는 fatal(DEF-009) - 그래프 빠진 보고서를
        // 조용히 내보내지 않는다.
        throw new Error(
          `차트 렌더링 실패: ${(chart && chart.title) || "(제목 없음)"} - 잠시 후 다시 시도해 주세요.`,
        );
      } else {
        // 값 없는 spec(축 라벨만 있는 등)은 기존대로 렌더 제외 + 경고.
        onProgress(
          `⚠️ 차트 렌더 재실패(그릴 값 없음, 제외): ${(chart && chart.title) || "(제목 없음)"}`,
        );
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

// (JSON 추출은 lib/claude-stream.js 의 extractJson 사용 — 위에서 import.)

module.exports = {
  generateReportContent,
  // 테스트용 내부 노출 (phys-result의 _classifyPhysicsTable 관례와 동일)
  _emptyReportError: emptyReportError,
  _stripLeadingSectionTitleLine: stripLeadingSectionTitleLine,
  _buildChartSpecFromTables: buildChartSpecFromTables,
  _collectReferencedPhotoIndices: collectReferencedPhotoIndices,
  _placeUnreferencedPhotos: placeUnreferencedPhotos,
};
