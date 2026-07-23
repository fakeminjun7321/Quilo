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
const { getReagentData } = require("../../reagent-data");
const styleRef = require("../../style-ref");
const {
  isGptModel,
  usesOpenAiCompat,
  providerConfigured,
  callGptReport,
  gptConfigured,
} = require("../../model-call");
const reportImageGen = require("../../report-image-gen");
const {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
} = require("../../anthropic-files");
const { streamWithContinuation, extractJson } = require("../../claude-stream");

// PubChem 정확값으로 시약 물성 보정/보강 (Claude 환각·계산오차 방어).
// 안전 규칙: 수화물 몰질량은 덮지 않음(PubChem은 무수물 기준), 빈 값만 채움,
// Claude가 적은 화학식/밀도는 덮지 않음(표기·맥락 보존), 출처 URL만 실제 CID로 교정.
// ENABLE_PUBCHEM=0 으로 끌 수 있음.
const PUBCHEM_ENABLED = process.env.ENABLE_PUBCHEM !== "0";

function formulaToMarkers(f) {
  return String(f).replace(/([A-Za-z)\]])(\d+)/g, "$1_{$2}");
}

async function enrichChemicalsWithPubChem(parsed, onProgress = () => {}) {
  if (!PUBCHEM_ENABLED || !parsed || !Array.isArray(parsed.chemicals)) return 0;
  let corrected = 0;
  await Promise.all(
    parsed.chemicals.map(async (chem) => {
      const query = String(chem.iupac || chem.name_en || "").trim();
      if (!query) return; // 한글명만 있으면 조회 불가 — 건너뜀
      const needPhysical =
        !String(chem.density || "").trim() || !String(chem.mp_bp || "").trim();
      let data;
      try {
        data = await getReagentData(query, { physical: needPhysical });
      } catch {
        return;
      }
      if (!data) return;
      const isHydrate = /[·•]|hydrate|수화물/i.test(
        `${chem.formula || ""} ${chem.name || ""}`,
      );
      if (data.molarMass && !isHydrate) {
        const claudeNum = parseFloat(
          String(chem.molar_mass || "").replace(/[^0-9.]/g, ""),
        );
        const pcNum = parseFloat(data.molarMass);
        if (
          Number.isFinite(pcNum) &&
          (!Number.isFinite(claudeNum) ||
            Math.abs(claudeNum - pcNum) / pcNum > 0.01)
        ) {
          chem.molar_mass = `${data.molarMass} g/mol`;
          corrected++;
        }
      }
      if (!String(chem.formula || "").trim() && data.molecularFormula) {
        chem.formula = formulaToMarkers(data.molecularFormula);
        corrected++;
      }
      if (!String(chem.density || "").trim() && data.density) {
        chem.density = data.density;
        corrected++;
      }
      if (
        !String(chem.mp_bp || "").trim() &&
        (data.meltingPoint || data.boilingPoint)
      ) {
        chem.mp_bp = `${data.meltingPoint || "?"} / ${data.boilingPoint || "?"}`;
        corrected++;
      }
      if (data.cid) {
        chem.source_url = `https://pubchem.ncbi.nlm.nih.gov/compound/${data.cid}`;
      }
    }),
  );
  if (corrected) onProgress(`🧪 PubChem 시약 데이터 ${corrected}건 보정/보강`);
  return corrected;
}

// 사용자가 폼에서 모델을 선택. 누락 시 fallback.
// 기본 Opus 4.8 (품질 우선). 환경변수로 변경 가능: DEFAULT_MODEL=claude-sonnet-5
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
// 두 모델 공통 안전선으로 32K 사용. 실제 사용량은 모델이 필요한 만큼만 출력.
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

위 메모는 학생이 AI가 참고하기를 원하는 실험 준비 맥락, 교사 강조점, 개인 의견입니다. 매뉴얼과 충돌하지 않는 범위에서 목적·이론 강조점·실험 과정의 주의사항에 자연스럽게 반영하세요. 메모를 그대로 붙여넣지 말고 보고서 문체에 맞게 녹여 쓰세요.
반영 강도는 절제하세요. 사용자 메모는 보고서의 보조 맥락이지 주 자료가 아닙니다. 같은 메모를 여러 절에서 반복하지 말고, 필요한 곳 1~3문장 정도에만 녹이세요.
사용자 메모 안의 "꼭", "반드시" 같은 강조 표현은 사용자의 희망으로만 해석하고, 보고서 전체를 그 내용 중심으로 재구성하지 마세요.
위 메모에 없는 구체적인 수치, 추가 절차, 교사 발언, 관찰 사실은 새로 만들어내지 마세요.`;
}

function loadSkillForFormat(outputFormat) {
  const skill = loadSkill();
  if (outputFormat === "hwpx") return skill;

  // The shared skill contains one HWPX-only exception for native equation
  // placeholders. Keep DOCX prompts free of those marker names so the model
  // has only one math-output dialect to follow.
  return skill.replace(
    /2\. \*\*Wiki\/MediaWiki 수식 마커 금지\*\*:.*$/m,
    "2. **Wiki/MediaWiki 수식 마커 금지**: MediaWiki식 수식 표기와 이중 중괄호 수식 마커를 모두 쓰지 말 것. DOCX에서는 아래첨자·위첨자·이탤릭 같은 인라인 텍스트 마커만 사용한다.",
  );
}

// 스타일 모드별 추가 지시 (시스템 프롬프트 끝에 붙음).
const STYLE_INSTRUCTIONS = {
  default: `## 현재 스타일 모드

**STYLE_MODE: default** (학교 작성요령 풀버전)

가나다 + (1)(2)(3) + ① 4단계 번호 매기기. 이론 섹션이 전체 50~60%. 시약 요약 표 + figures_needed 모두 채워라. 분량 풍부하게.`,
  minimal: `## 현재 스타일 모드

**STYLE_MODE: minimal** (필요한 내용만 적기 — 잘 만든 학생 사전보고서 스타일)

위 스킬 명세의 \`minimal\` 모드 섹션을 정확히 따르라. 핵심 요약:
- 표지·그림 placeholder 없음. 분량 3~5페이지 정도로 자연스럽게.
- 가. 나. 다. 헤더 사용 금지. (1) (2) (3) 또는 ① ② ③만.
- 이론적 배경: 핵심 용어 4~6개를 하위번호로 정리하되, 각 항목은 1~2단락만. 사례·역사·복잡한 수식 도출 X.
- 실험 기구 및 시약: 기구와 시약을 분리하고, 시약 물성 데이터(\`formula\`, \`molar_mass\`, \`mp_bp\`, \`density\`, \`properties\`, \`toxicity\`)를 채움.
- \`chemicals_summary_table\`: 간단 모드에서는 \`[]\`로 둔다. \`figures_needed\`: \`[]\`.
- \`references\`: 1~3개 (없으면 \`[]\`).
- 분량을 default보다 30~50% 짧게.
- JSON 문자열 앞에 \`①\`, \`(1)\`, \`1.\` 같은 번호를 직접 쓰지 마라. 렌더러가 번호를 붙인다.
- 실험 과정은 각 단계가 독립 문장이어야 한다. \`②의 플라스크\`, \`⑥의 용액\`, \`위의 플라스크\`, \`앞서 만든 용액\`처럼 앞 단계 번호나 생략형 지시어로 시작하지 마라.
- aspirin 합성에서는 일반 Fischer esterification 설명을 길게 쓰지 말고, acetic anhydride를 쓰는 산 촉매 O-acetylation 중심으로 설명하라.`,
};

const FORMAT_INSTRUCTIONS = {
  hwpx: `## 현재 출력 형식

**OUTPUT_FORMAT: hwpx**

- 복잡한 수식, 분수식, 독립 반응식은 반드시 한컴 수식 마커로 작성하세요: \`{{EQ:...}}\` 또는 번호가 필요한 경우 \`{{EQN:...}}\`.
- 이 마커는 최종 HWPX에서 한글 수식 편집기 객체로 변환되는 내부 표기입니다. \`{{MATH:...}}\`, \`{{FORMULA:...}}\`, \`[[수식]]\` 같은 wiki식 표기는 금지입니다.
- 수식만 따로 보여줄 줄은 배열의 독립 문자열 하나로 두고, 앞에 \`(1)\`, \`①\`, \`②\` 같은 번호를 직접 쓰지 마세요. 렌더러가 문단 번호와 수식 줄을 정리합니다.
- 화학 반응식도 독립 줄이면 \`{{EQ:2H_{2} + O_{2} -> 2H_{2}O}}\`처럼 수식 마커를 사용하세요.
- 작용기 괄호는 아래첨자가 아닙니다. 예: \`C_{6}H_{4}(OH)(COOH)\`, \`C_{6}H_{4}(OCOCH_{3})(COOH)\`처럼 쓰고 \`(COOH)_{...}\`로 만들지 마세요.`,
  docx: `## 현재 출력 형식

**OUTPUT_FORMAT: docx**

- 이중 중괄호로 감싼 수식 마커를 출력하지 마세요.
- docx에서는 본문 인라인 표기만 사용합니다: \`H_{2}O\`, \`10^{-3}\`, \`*PV* = *nRT*\`, \`→\`, \`×\`.`,
};

const DOCX_FORMULA_INSTRUCTIONS = `## 화학식·수식 마커 규칙 (DOCX)

JSON 안의 모든 텍스트 필드에서 다음 인라인 마커만 사용하세요:

- 아래첨자: \`_{내용}\` — \`H_{2}O\`, \`CO_{2}\`, \`P_{1}V_{1}\`
- 위첨자: \`^{내용}\` — \`Ca^{2+}\`, \`10^{-3}\`, \`m^{3}\`
- 이탤릭: \`*내용*\` — 변수·상수: \`*PV* = *nRT*\`
- 핵심 하이라이트: \`**내용**\` — 결론·핵심 해석 등 필요한 문장에만 사용, 한 섹션당 0~2개로 제한, 최종 문서에서는 민트색 하이라이트+굵게 표시
- 그리스문자: 유니코드 직접 (\`α\`, \`Δ\`, \`π\`, \`ρ\`, \`μ\`)
- 반응식·계산식은 일반 문장 안에서 \`H_{2}O\`, \`→\`, \`×\`, \`/\` 등을 사용해 자연스럽게 표기하고, 이중 중괄호 수식 마커는 절대 쓰지 마세요.`;

const HWPX_FORMULA_INSTRUCTIONS = `## 화학식·수식 마커 규칙 (HWPX)

JSON 안의 모든 텍스트 필드에서 다음 마커를 사용하세요:

- 아래첨자: \`_{내용}\` — \`H_{2}O\`, \`CO_{2}\`, \`P_{1}V_{1}\`
- 위첨자: \`^{내용}\` — \`Ca^{2+}\`, \`10^{-3}\`, \`m^{3}\`
- 이탤릭: \`*내용*\` — 변수·상수: \`*PV* = *nRT*\`
- 핵심 하이라이트: \`**내용**\` — 결론·핵심 해석 등 필요한 문장에만 사용, 한 섹션당 0~2개로 제한, 최종 문서에서는 민트색 하이라이트+굵게 표시
- 그리스문자: 유니코드 직접 (\`α\`, \`Δ\`, \`π\`, \`ρ\`, \`μ\`)

### 큰 수식·복잡한 식·화학반응식: \`{{EQ:...}}\` 또는 \`{{EQN:...}}\` 사용

분수·적분·시그마·행렬·반응식 등 인라인 마커로 표현이 어렵거나 한 줄짜리로 보여주고 싶은 식은 한컴 수식 스크립트로 \`{{EQ:...}}\` 안에 넣으세요. HWPX 출력 시 진짜 한글 수식 객체로 변환됩니다.

**한컴 수식 스크립트 문법** (LaTeX 아님):
- 분수: \`{a+b} over {c+d}\`
- 제곱근: \`sqrt {b^2 - 4ac}\`, n제곱근: \`root 3 of {x}\`
- 위첨자/아래첨자: \`x^2\`, \`a_i\`, \`P_{air}\`
- 적분: \`int _{0} ^{1} f(x) dx\`
- 시그마: \`sum _{k=1} ^{n} k^2\`
- 행렬: \`pmatrix { 1 & 2 # 3 & 4 }\`
- 화학반응식: \`2H_{2} + O_{2} -> 2H_{2}O\` (\`->\` 화살표). 아래첨자는 반드시 \`_{2}\`처럼 중괄호로 감쌉니다.
- 촉매/반응조건이 있는 화살표: \`A BUILDREL -> {H_{2}SO_{4}} B\` 처럼 조건을 화살표 위에 올립니다. \`A ->[H_{2}SO_{4}] B\`도 변환되지만, 가능하면 \`BUILDREL\` 문법을 직접 쓰세요.

**언제 어떤 마커를 쓸지**:
- 본문 변수 한두 개 (\`*PV* = *nRT*\`) → 인라인 마커
- 별도 줄에 보여줄 수식, 분수·적분·행렬·반응식 → \`{{EQ:...}}\`
- 본문에서 참조할 중요 수식 → \`{{EQN:...}}\` (자동 번호)
- \`{{EQ:...}}\` 안에서는 인라인 마커(\`*\`, \`**\`)를 쓰지 않습니다.`;

const STEP_REF_MARKER = String.raw`(?:[①-⑳❶-❿]|\(\s*\d{1,2}\s*\)|\d{1,2}[.)])`;

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

function normalizeProcedureStepText(text) {
  let out = String(text || "").trim();
  if (!out) return out;

  // Minimal reports often became awkward when Claude wrote "③의 플라스크".
  // Renderers add their own step number, so keep the object and remove only
  // the stale cross-reference marker.
  const leadingStepRef = new RegExp(`^\\s*${STEP_REF_MARKER}\\s*의\\s+`);
  const embeddedFlaskRef = new RegExp(`${STEP_REF_MARKER}\\s*의\\s+플라스크`, "g");
  const embeddedSolutionRef = new RegExp(`${STEP_REF_MARKER}\\s*의\\s+(용액|시료|결정|혼합물)`, "g");

  out = out
    .replace(leadingStepRef, "")
    .replace(embeddedFlaskRef, "플라스크")
    .replace(embeddedSolutionRef, "$1")
    .replace(/^\s*(?:위의|앞의|앞선|이전|앞서 만든)\s+/, "")
    .replace(/\s*(?:위의|앞의|앞선|이전|앞서 만든)\s+플라스크/g, " 플라스크")
    .replace(
      /평형을\s*(?:정반응|생성물|ester|에스터)\s*쪽으로\s*(?:충분히\s*)?(?:밀어준다|민다|이동시킨다)/g,
      "반응을 완결 쪽으로 유도한다",
    );

  return out.trim();
}

function normalizeAspirinChemical(chemical) {
  if (!chemical || typeof chemical !== "object") return chemical;

  const label = [
    chemical.name,
    chemical.iupac,
    chemical.formula,
  ].join(" ");
  if (!/aspirin|acetylsalicylic|C_?\{?9\}?H_?\{?8\}?O_?\{?4\}?|C9H8O4/i.test(label)) {
    return chemical;
  }

  const fixed = { ...chemical };
  if (fixed.properties) {
    fixed.properties = String(fixed.properties)
      .replace(
        /ethanol[·,\s]*뜨거운\s*물에\s*(?:잘\s*)?녹(?:음|는다)/g,
        "뜨거운 ethanol에는 잘 녹고 물에는 잘 녹지 않음",
      )
      .replace(
        /뜨거운\s*물에\s*(?:잘\s*)?녹(?:음|는다)/g,
        "물에는 잘 녹지 않음",
      );
  }
  return fixed;
}

function normalizeChemPreContent(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;

  if (Array.isArray(parsed.chemicals)) {
    parsed.chemicals = parsed.chemicals.map(normalizeAspirinChemical);
  }

  if (!Array.isArray(parsed.procedure)) return parsed;

  parsed.procedure.forEach((section) => {
    if (!section || !Array.isArray(section.steps)) return;
    section.steps = section.steps.map((step) => {
      if (typeof step === "string") {
        return normalizeProcedureStepText(step);
      }
      if (step && typeof step === "object") {
        return {
          ...step,
          text: normalizeProcedureStepText(step.text),
        };
      }
      return step;
    });
  });

  return parsed;
}

// ── 산·염기 명칭 lint (DEF-034) ─────────────────────────────────────────────
// R1 신규 생성에서 '강산인 염산과 강산인 수산화나트륨'처럼 물질과 산·염기
// 분류가 모순되는 오기가 관측됐다. 아래 대표 물질 화이트리스트에 한해,
// 분류 명칭만('...산인' <-> '...염기인') 바로잡는다. 물질명 자체는 절대
// 바꾸지 않으며, 목록 밖 물질은 건드리지 않는다(오교정 방지).
const ACID_BASE_BASE_NAMES = [
  "수산화나트륨",
  "수산화칼륨",
  "수산화칼슘",
  "암모니아",
  "NaOH",
  "KOH",
  "Ca(OH)_{2}",
  "NH_{3}",
];
const ACID_BASE_ACID_NAMES = [
  "염산",
  "황산",
  "질산",
  "아세트산",
  "HCl",
  "H_{2}SO_{4}",
  "HNO_{3}",
  "CH_{3}COOH",
];

const ACID_BASE_LINT_RULES = (() => {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = (names) =>
    names
      .slice()
      .sort((a, b) => b.length - a.length)
      .map(escapeRe)
      .join("|");
  // 매치한 물질명 바로 뒤가 화학식 연장(영숫자)이거나 짝염기·염 파생어
  // ('아세트산 이온', '아세트산나트륨' 등)로 이어지면 산·염기성이 달라지는
  // 다른 화학종이므로 교정하지 않는다.
  const guard =
    "(?![A-Za-z0-9])(?!\\s*(?:음?이온|염|나트륨|칼륨|칼슘|리튬|암모늄|마그네슘|바륨))";
  const bases = alt(ACID_BASE_BASE_NAMES);
  const acids = alt(ACID_BASE_ACID_NAMES);
  return [
    {
      // '강산인 수산화나트륨' -> '강염기인 수산화나트륨' (물질명 불변)
      re: new RegExp(
        `(강|약)((?:한\\s*)?)산(성?)인(\\s*)(${bases})${guard}`,
        "g",
      ),
      swapTo: "염기",
    },
    {
      // '강염기인 염산' -> '강산인 염산' (물질명 불변)
      re: new RegExp(
        `(강|약)((?:한\\s*)?)염기(성?)인(\\s*)(${acids})${guard}`,
        "g",
      ),
      swapTo: "산",
    },
  ];
})();

function lintAcidBaseText(text) {
  let count = 0;
  let out = String(text);
  for (const rule of ACID_BASE_LINT_RULES) {
    out = out.replace(rule.re, (m, g1, g2, g3, g4, g5) => {
      count += 1;
      return `${g1}${g2}${rule.swapTo}${g3}인${g4}${g5}`;
    });
  }
  return { text: out, count };
}

// parsed JSON 전체의 문자열 필드를 순회하며 명칭 불일치를 교정. 교정 수 반환.
function lintAcidBaseNaming(node) {
  let count = 0;
  const walk = (value) => {
    if (typeof value === "string") {
      const res = lintAcidBaseText(value);
      count += res.count;
      return res.text;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        value[key] = walk(value[key]);
      }
      return value;
    }
    return value;
  };
  walk(node);
  return count;
}

function buildSystemPrompt(
  style = "default",
  outputFormat = "docx",
  { allowHighlights = true } = {},
) {
  const skill = applyHighlightPolicy(
    loadSkillForFormat(outputFormat),
    allowHighlights,
  );
  const styleSection = STYLE_INSTRUCTIONS[style] || STYLE_INSTRUCTIONS.default;
  const formatSection =
    FORMAT_INSTRUCTIONS[outputFormat] || FORMAT_INSTRUCTIONS.docx;
  const formulaSection = applyHighlightPolicy(
    outputFormat === "hwpx" ? HWPX_FORMULA_INSTRUCTIONS : DOCX_FORMULA_INSTRUCTIONS,
    allowHighlights,
  );
  return `당신은 (영재학교)과학고등학교 학생을 위한 화학실험 사전보고서 자동 생성 도우미입니다.

아래는 사전보고서 작성에 따라야 할 스킬 명세입니다. 모든 규칙(번호 체계, 분량, 이론 깊이, 시약 데이터, 그림 처리)을 정확히 따르세요.

=========== SKILL SPEC START ===========
${skill}
=========== SKILL SPEC END ===========

## 작업 절차

1. 첨부된 PDF(실험 매뉴얼)을 분석합니다 — Purpose, Theory & Principle 키워드, Apparatus, Chemicals, Procedure.
2. Theory & Principle 키워드 각각에 대해 (영재학교)과학고 2학년 일반화학 수준의 이론을 전개합니다 (수식·반응식 포함).
3. 각 시약의 화학식·IUPAC명을 확보합니다. \`default\` 모드에선 추가로 정확한 물성 데이터(몰질량, 녹는점/끓는점, 밀도, 독성)도 포함.
   - 확신이 없는 데이터는 web_search 도구로 PubChem/NIST 등을 검색하여 확인하세요.
4. 매뉴얼의 실험 과정에 "왜 그렇게 하는지" 이유와 원리를 덧붙여 풀어 씁니다.
5. \`default\` 모드에선 그림이 필요한 경우 figures_needed 배열에 상세 설명과 함께 나열합니다 (\`minimal\`에선 \`[]\`).

${styleSection}

${formatSection}

## 이어쓰기 인수인계 (\`ai_handoff\`) — 다른 AI로 이어 편집용

출력 JSON 최상위에 \`ai_handoff\` 문자열 하나를 넣으세요. 사용자가 이 보고서를 **다른 AI(ChatGPT·Claude 등)에 붙여넣어 이어서 편집**할 때 그대로 쓸 **한국어 안내 프롬프트**입니다(한 덩어리 문자열, 줄바꿈 \`\\n\` 허용). 순서대로 담습니다:
1. 보고서 개요 — 실험 종류·제목 한 줄.
2. 현재 작성 상태 — 목적/이론/기구/시약/실험과정 중 무엇을 매뉴얼 어디서 채웠는지 + 핵심 이론·시약 요약.
3. 반드시 지킬 것(주의) — 매뉴얼·물성 자료에 근거하고 없는 값을 지어내지 말 것, 사전보고서 구조·번호체계 유지, 수식 마커·단위 표기, 사용자 문체 유지, LLM 흔적(태그·슬래시 나열 등) 금지 등 이 보고서 유형의 핵심 규칙.
4. 다듬을 포인트 — 검토·보강하면 좋을 점 2~4개(구체적으로).
5. 이어서 편집 지시문 — "아래 보고서를 이어서 다듬어줘. 위 규칙을 지키고 ~는 유지, ~는 보강해줘." 형태의 바로 쓸 수 있는 한 문단.

이 내용은 \`ai_handoff\` 필드에만 넣고 **보고서 본문에는 넣지 않습니다.** 새 사실·데이터는 만들지 않습니다.

## 출력 형식 (매우 중요)

**최종 출력은 반드시 단 하나의 JSON 코드 블록 (\`\`\`json ... \`\`\`)입니다.** 그 외의 설명·인사·마크다운 본문은 일체 출력하지 마세요. JSON 외 텍스트는 무시됩니다.

JSON 스키마:

\`\`\`json
{
  "title_kr": "한글 실험 제목",
  "title_en": "English experiment title",
  "ai_handoff": "다른 AI로 이어 편집할 안내 프롬프트 (위 '이어쓰기 인수인계' 규칙대로 한 문자열로)",
  "purpose": [
    "구체적으로 확장된 실험 목표 1",
    "구체적으로 확장된 실험 목표 2"
  ],
  "theory": [
    {
      "topic": "이론 주제명 (예: 이상기체 상태방정식)",
      "items": [
        "첫 번째 단락 — 수식·반응식 포함, 최소 2~5문장",
        "두 번째 단락",
        { "figure": 1 },
        "그림 다음에 이어지는 설명 단락"
      ]
    }
  ],
  "apparatus": [
    {
      "name": "기구명",
      "name_en": "English name",
      "description": "용도 + 원리/주의사항"
    }
  ],
  "chemicals": [
    {
      "name": "시약명",
      "iupac": "영문 IUPAC명 (PubChem 조회·물성 검증용 — 예: ethanol, acetic acid). 반드시 영문으로.",
      "formula": "화학식 (마커 사용: H_{2}O, CO_{2}, Ca^{2+})",
      "molar_mass": "18.02 g/mol",
      "mp_bp": "0°C / 100°C",
      "density": "1.00 g/mL (선택)",
      "properties": "주요 물리/화학적 특성",
      "toxicity": "독성·취급 주의사항",
      "source_url": "https://pubchem.ncbi.nlm.nih.gov/compound/962 (출처 URL — PubChem 우선, NIST/ChemSpider도 가능. 시약마다 1개)"
    }
  ],
  "chemicals_summary_table": [
    {
      "name": "시약명",
      "formula": "화학식",
      "molar_mass": "몰질량",
      "mp_bp": "녹는점/끓는점",
      "properties": "주요 특성"
    }
  ],
  "procedure": [
    {
      "title": "실험 A: 제목",
      "steps": [
        { "text": "절차 설명 — 이유·원리 포함", "notes": ["세부 주의사항 1"] },
        "또는 단순 문자열 절차"
      ]
    }
  ],
  "data_table": [
    { "item": "공기의 분자량 (MW_{air})", "value": "28.96 g/mol" },
    { "item": "기체상수 (R)", "value": "0.08206 L·atm/(mol·K)" }
  ],
  "figures_needed": [
    {
      "number": 1,
      "caption": "CO_{2} 상평형도",
      "description": "CO_{2}의 온도-압력 상평형도. 삼중점(-56.6°C, 5.11 atm)과 임계점(31.1°C, 72.8 atm) 표시.",
      "search_query": "CO2 phase diagram triple point critical point"
    }
  ],
  "references": [
    {"label": "PubChem - Water (CID 962)", "url": "https://pubchem.ncbi.nlm.nih.gov/compound/962"},
    {"label": "NIST WebBook - Carbon dioxide", "url": "https://webbook.nist.gov/cgi/cbook.cgi?ID=C124389"}
  ]
}
\`\`\`

${formulaSection}

## 분량 가이드

- 이론 섹션이 보고서 전체의 50~60%를 차지하도록 키워드별로 충분히 전개
- 각 이론 키워드는 최소 3~5개의 items
- 시약은 매뉴얼에 나온 모든 시약을 포함
- 실험 과정은 매뉴얼의 모든 단계를 포함하되 이유/원리 추가

## 데이터 정확성

- 물리 상수 (R, N_A, h 등)는 정확한 값
- 시약 물성은 PubChem/NIST 기준
- 확신이 없으면 web_search 도구를 적극 사용

## 화학 정확성 가드 — aspirin 합성처럼 산 촉매 acylation 실험

다음 내용은 aspirin 합성·정제 실험에서 특히 자주 틀리는 부분입니다. 해당 실험이면 반드시 지키세요.

- Salicylic acid에서 반응하는 친핵체는 **페놀성 -OH의 산소**입니다. Carboxyl -OH처럼 모호하게 쓰지 마세요.
- 황산은 주된 역할이 산 촉매입니다. Acetic anhydride 반응에서 황산이 부산물 acetic acid나 물을 흡수해 평형을 민다는 식으로 설명하지 마세요.
- 산 촉매 조건에서 이탈기는 단순한 "acetate 음이온"이 아니라 proton transfer 후 acetic acid 형태로 빠지는 것으로 설명하세요.
- Acetic acid 대신 acetic anhydride를 쓰는 이유는 hydroxide/water 계열보다 acetate/acetic acid 경로가 더 좋은 이탈기 조건을 만들고 acylation 반응성이 크기 때문입니다. pK_a 비교를 쓰면 AcOH 약 4.76, H_{2}O 약 15.7로 정리하세요.
- 재결정 설명은 ethanol이 aspirin을 가열 시 잘 녹이고 물은 poor solvent로 작용한다는 점, 서서히 식히면 순도가 좋아지고 ice bath는 최종 회수율을 높인다는 점을 구분하세요.
- Aspirin 물성에서 "뜨거운 물에 잘 녹는다"처럼 쓰지 마세요. 뜨거운 ethanol에는 잘 녹고, 물은 재결정에서 poor solvent로 쓰인다고 정리하세요.
- Acetic anhydride 끓는점은 139.8°C로 통일하고, "Le Chatelier의 원리"라고 표기하세요.
- Salicylic acid의 phenolic -OH와 carboxyl group 사이 분자내 수소결합을 언급하면 반응성 설명이 더 정확합니다.

## 참고문헌 (references) — 시약 출처 자동 표기 ⭐

각 시약(\`chemicals[]\`)의 \`source_url\`은 그 시약의 물성 데이터 출처입니다 (PubChem 우선, NIST/ChemSpider도 OK). 시약마다 1개 URL.

문서 끝 \`references\` 배열에는 보고서 전체에서 인용한 출처를 모읍니다.

- \`label\`: 사람이 읽을 수 있는 이름 (예: "PubChem - Sodium hydroxide (CID 14798)")
- \`url\`: 클릭 가능한 URL (PubChem CID 페이지, NIST WebBook 등)

각 시약의 \`source_url\`을 \`references\`에도 함께 넣으면, 보고서에는 시약 옆 \`[1]\` 같은 번호 + 마지막에 출처 목록이 표시됩니다. 항목이 없으면 references는 \`[]\` 빈 배열로.

## 그림 (figures_needed) — 학교 평가 기준 준수 ⭐

**(영재학교)과학고 화실 보고서 작성 요령에 따르면, 사전보고서에서 사진/그림은 "기구 중 특별한 것"에만 첨부한다.** 그 외엔 학교가 요구하지 않는다.

### 그림 추가 기준 (이 기준에 해당하지 않으면 절대 추가 금지)

**O 추가**:
1. **특수 분석기기**: UV-Vis 분광계, GC, HPLC, NMR, AA, IR, MS, 회전증발기, 적외선 분광기 등 평소 보지 못하는 장비
2. **복잡한 실험 setup**: 분별증류 장치, 환류 장치, soxhlet 추출기, 가스 포집 setup, 계면 중합 setup 등 — 글로만 묘사하면 학생이 이해 못 할 정도로 복잡한 경우
3. (드물게) 메커니즘이 매우 복잡하고 시각화 없이는 학습이 불가능한 경우 — 단, 학생이 이미 알 수 있는 단순 메커니즘은 제외

**X 추가 금지**:
- 일반 유리기구: 비커, 삼각플라스크, 시험관, 매스실린더, 피펫, 뷰렛, 시계접시, 깔때기, 거름종이 등
- 표준 화학 반응식 (텍스트로 충분히 설명되면 그림 불필요)
- 단순 화합물 구조 (이름·화학식만으로 충분)
- 보편적 개념의 모식도 (PV=nRT 그래프, 일반적인 평형 곡선 등)

**기본값은 figures_needed = []**. 단순 실험(적정, 결정화, 단순 합성 등)은 거의 모두 빈 배열.
복잡한 실험이라도 figures_needed는 보통 **0~2개를 넘지 않는다**.

각 항목의 \`search_query\`는 영어 키워드 4~8개로, 구글 이미지 검색에 바로 쓸 수 있게 작성 (예: "rotary evaporator setup", "interfacial polycondensation nylon rope apparatus").

### 그림 본문 배치 (필수, 절대 규칙)

**figures_needed 배열의 모든 그림은 반드시 theory 섹션의 \`items\` 배열 안에 \`{ "figure": N }\` 마커로 인라인 배치되어야 한다.** 마커가 없는 그림은 보고서에서 자동으로 누락된다 (별도의 "필요한 그림 목록" 섹션은 존재하지 않는다).

배치 방법: 그림이 들어갈 위치에 \`{ "figure": N }\` 객체를 \`items\`에 끼워넣는다 (N은 figures_needed의 number와 일치). 그림 앞뒤로 그림과 연결된 설명 텍스트가 자연스럽게 흐르도록 단락을 배치한다.

**검증 체크리스트** (출력 전 반드시 확인):
- figures_needed에 number=1, 2, 3이 있다면 → theory의 어느 섹션이든 items 안에 \`{ "figure": 1 }\`, \`{ "figure": 2 }\`, \`{ "figure": 3 }\`이 모두 등장해야 함.
- 어떤 그림도 inline 배치 안 됐는데 figures_needed에 들어있으면 → 그 그림은 figures_needed에서 제거하거나 inline 마커 추가.

예시:
\`\`\`json
"items": [
  "이상기체 상태방정식 *PV* = *nRT* 는 이상기체의 거동을 기술한다.",
  "여기서 P는 압력, V는 부피, T는 절대온도이다.",
  { "figure": 1 },
  "그림 1과 같이 분자 간 충돌이 무작위로 일어나며, 분자 부피와 인력은 무시된다."
]
\`\`\`

→ figures_needed[0].number == 1 이고, 본문에는 단락 사이에 그림이 인라인으로 들어간다.
`;
}

/**
 * Generate report content from a manual PDF.
 *
 * @param {Object} args
 * @param {Buffer} args.pdfBuffer  Manual PDF as Buffer
 * @param {string} args.date       Experiment date (YYYY/MM/DD)
 * @param {string} args.userNotes  사용자 참고 메모/의견
 * @param {Function} args.onProgress  (msg) => void  status callback
 * @returns {Promise<Object>}      Parsed report JSON
 */
async function generateReportContent({
  pdfBuffer,
  date,
  userNotes = "",
  onProgress = () => {},
  signal,
  model = null,
  style = "default",
  styleRefs = [],
  styleNote = "",
  outputFormat = "docx",
  allowHighlights = true,
  allowImageGen = false,
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

  const STYLE = style === "minimal" ? "minimal" : "default";
  const OUTPUT_FORMAT = outputFormat === "hwpx" ? "hwpx" : "docx";
  const hasStyleRef = styleRef.hasStyle({ styleRefs, styleNote });
  onProgress(`🤖 모델: ${MODEL} | 스타일: ${STYLE}${hasStyleRef ? " | 내 문체 반영" : ""}`);

  const client = byok.anthropicKey()
    ? new Anthropic({ apiKey: byok.anthropicKey(), timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ })
    : null;
  const system =
    buildSystemPrompt(STYLE, OUTPUT_FORMAT, { allowHighlights }) +
    (hasStyleRef ? "\n\n" + styleRef.STYLE_SYSTEM_SECTION : "") +
    (reportImageGen.allowsImageGen({ allowImageGen })
      ? "\n\n" + reportImageGen.IMAGE_SYSTEM_SECTION
      : "");

  // 큰 매뉴얼 PDF 는 인라인 base64(~1.33배 팽창)로 보내면 Anthropic "요청당 32MB"
  // 한도에 걸려 생성이 실패한다. raw ≥4.5MB 면 Claude 경로에서 Files API 로
  // 업로드해 `source:{type:"file",file_id}` 로 참조한다(요청 페이로드가 작아짐).
  // GPT 경로(USE_GPT)는 file_id 를 못 쓰므로 항상 인라인 유지.
  const FILES_API_RAW_THRESHOLD = 4.5 * 1024 * 1024;
  let usedFileApi = false;
  const uploadedFileIds = [];
  // file_id는 키/계정 범위이므로 업로드와 finally 삭제에 같은 키를 고정한다.
  const filesApiKey = !USE_GPT ? byok.anthropicKey() : "";

  const content = [];
  {
    const tooBigInline = pdfBuffer.length >= FILES_API_RAW_THRESHOLD;
    let pushedFileBlock = false;
    if (!USE_GPT && tooBigInline) {
      try {
        const fileId = await uploadFileToAnthropic(pdfBuffer, "manual.pdf", {
          signal,
          apiKey: filesApiKey,
        });
        content.push({
          type: "document",
          source: { type: "file", file_id: fileId },
        });
        uploadedFileIds.push(fileId);
        usedFileApi = true;
        pushedFileBlock = true;
        onProgress(
          `📤 큰 PDF 업로드(Files API): ${Math.round((pdfBuffer.length / 1048576) * 10) / 10}MB — 요청 한도 우회`,
        );
      } catch (e) {
        onProgress(`⚠ Files API 업로드 실패 → 인라인 전송 시도: ${e.message}`);
      }
    }
    if (!pushedFileBlock) {
      // 작은 PDF(또는 Files API 실패 폴백, GPT 경로)은 기존처럼 인라인 base64.
      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: pdfBuffer.toString("base64"),
        },
        // 같은 매뉴얼로 재생성할 때 입력 비용 절감 (5분 ephemeral 캐시).
        cache_control: { type: "ephemeral" },
      });
      if (USE_GPT && tooBigInline) {
        onProgress(
          `⚠ GPT 모델은 큰 PDF(${Math.round((pdfBuffer.length / 1048576) * 10) / 10}MB)를 인라인으로만 전송합니다. 요청 한도 초과로 실패하면 Claude 모델(Opus/Sonnet)을 선택하면 큰 PDF 우회 업로드가 가능합니다.`,
        );
      }
    }
  }
  const notesBlock = buildUserNotesBlock(userNotes);
  if (notesBlock) {
    content.push({ type: "text", text: notesBlock });
  }
  if (hasStyleRef) {
    content.push(...(await styleRef.buildStyleBlocks({ styleRefs, styleNote })));
  }
  content.push({
    type: "text",
    text: `첨부된 실험 매뉴얼 PDF를 바탕으로 사전보고서 콘텐츠를 JSON으로 생성하세요.

실험 예정일: ${date || "(미지정)"}

위에서 명시한 JSON 스키마와 마커 규칙을 정확히 따르세요. 시약의 정확한 물성 데이터가 확신이 없으면 web_search 도구를 적극적으로 사용하세요.

최종 출력은 단 하나의 \`\`\`json ... \`\`\` 코드 블록입니다.`,
  });

  const userMessage = { role: "user", content };

  const pdfSizeKB = Math.round(pdfBuffer.length / 1024);
  onProgress(
    `PDF 수신 (${pdfSizeKB}KB)${notesBlock ? ", 사용자 메모 포함" : ""} — 모델에게 전송`,
  );

  // ── Stream + heartbeat ────────────────────────────────────────────────────
  const startedAt = Date.now();
  let charCount = 0;
  let lastReportedChars = 0;
  let lastEventAt = Date.now();
  let webSearchCount = 0;
  let textBlocksStarted = 0;
  let firstTokenSeen = false;

  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);

  // Heartbeat: every 5s, if nothing else has fired in last 12s, emit a tick
  const heartbeat = setInterval(() => {
    const sinceLast = (Date.now() - lastEventAt) / 1000;
    if (sinceLast >= 12) {
      const note = !firstTokenSeen
        ? `모델이 PDF 분석 중... (${elapsed()}초 경과)`
        : `보고서 작성 중... (${charCount}자, ${elapsed()}초 경과)`;
      onProgress("⏳ " + note);
      lastEventAt = Date.now();
    }
  }, 5000);

  let finalText;
  let cost = null;
  try {
    if (usesOpenAiCompat(MODEL)) {
      // GPT/Gemini(OpenAI 호환) 경로 — Anthropic 블록을 변환해 단일 호출(web_search 미사용, 모델 지식).
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
      // ── Cost calculation ──
      cost = calcCost({
        usage: result.usage,
        webSearchCount,
        model: MODEL,
      });
    }
  } finally {
    clearInterval(heartbeat);
    // 업로드한 PDF 는 best-effort 삭제 (실패해도 무시).
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
      "JSON 코드 블록을 찾을 수 없습니다. 응답 앞부분: " +
        finalText.slice(0, 300),
    );
  }

  let parsed;
  try {
    parsed = parseJsonLenient(json);
  } catch (e) {
    throw new Error("JSON 파싱 실패: " + e.message);
  }
  // AI 개념도 원본 figures — sanitize 가 영문 prompt 를 건드리기 전에 보관.
  const rawFigures = Array.isArray(parsed.figures) ? parsed.figures : [];
  // Claude 출력에 섞일 수 있는 비정상 마크업 제거 (HTML 인용·wiki 수식·한글
  // angle-bracket 헤더 등). docx-gen 들어가기 전 단계에서 한 번 정제.
  parsed = require("../../output-sanitize").sanitize(parsed, {
    preserveEquationPlaceholders: OUTPUT_FORMAT === "hwpx",
    allowHighlights,
  });
  parsed = normalizeChemPreContent(parsed);

  // 산·염기 분류 명칭 오기('강산인 수산화나트륨' 등) 보수적 자동 교정 (DEF-034).
  const acidBaseFixes = lintAcidBaseNaming(parsed);
  if (acidBaseFixes > 0) {
    onProgress(`🧪 산염기 명칭 자동 교정 ${acidBaseFixes}곳`);
  }

  // 콘텐츠 구조 검증(DEF-010) - 파싱·sanitize 완료 지점. hard 결함(제목·이론·과정 결손,
  // 위키식 수식 마커 등)은 PubChem/이미지 생성 같은 후속 작업 전에 즉시 실패시킨다.
  require("../../output-sanitize").assertContentSchema("chem-pre", parsed, {
    format: OUTPUT_FORMAT,
    onProgress,
  });

  // 시약 물성을 PubChem(코드)으로 검증·보강 — Claude 환각/계산오차 방어.
  try {
    await enrichChemicalsWithPubChem(parsed, onProgress);
  } catch (e) {
    onProgress("⚠ PubChem 보정 건너뜀: " + (e?.message || e));
  }

  // AI 개념도/삽화 생성 (사용자 허용 + 키 존재 시) — 실제 PNG 버퍼를 __figures 로 첨부.
  let genFigureCount = 0;
  if (reportImageGen.allowsImageGen({ allowImageGen })) {
    try {
      const figs = await reportImageGen.renderFigures(rawFigures, { onProgress });
      if (figs.length) {
        Object.defineProperty(parsed, "__figures", {
          value: figs,
          enumerable: false,
          writable: false,
        });
        genFigureCount = figs.length;
      }
    } catch (e) {
      onProgress("⚠ AI 이미지 생성 건너뜀: " + (e?.message || e));
    }
  }

  // Quick content stats for the user
  const stats = [];
  if (parsed.theory) stats.push(`이론 ${parsed.theory.length}개 섹션`);
  if (parsed.chemicals) stats.push(`시약 ${parsed.chemicals.length}개`);
  if (parsed.procedure) stats.push(`실험 과정 ${parsed.procedure.length}개`);
  if (stats.length > 0) onProgress(`📋 콘텐츠 구조: ${stats.join(", ")}`);

  // Inject the date the user picked (override if Claude guessed)
  if (date) parsed.date = date;

  // figures_needed(학생이 직접 찾을 참고그림)는 docx 점선 박스 placeholder로 렌더.
  // AI 개념도(genFigureCount)는 위에서 실제 생성·첨부됨 — 비용 회계에 반영.
  const imageCost = calcImageCost({
    searchCount: 0,
    generationCount: genFigureCount,
  });
  const figCount = Array.isArray(parsed.figures_needed)
    ? parsed.figures_needed.length
    : 0;
  if (figCount > 0) {
    onProgress(
      `📷 그림 ${figCount}장 — 자동 첨부 비활성화. 보고서 안 점선 박스의 검색 링크로 직접 채워넣으세요.`,
    );
  }

  // Attach metadata (docx generator ignores keys it doesn't know)
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
  // docx/hwpx generator가 minimal vs default 분기에 사용
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
  _normalizeChemPreContent: normalizeChemPreContent,
  _enrichChemicalsWithPubChem: enrichChemicalsWithPubChem,
  _lintAcidBaseText: lintAcidBaseText,
  _lintAcidBaseNaming: lintAcidBaseNaming,
};
