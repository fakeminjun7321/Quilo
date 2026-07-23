const STEPS = ["upload", "info", "settings", "generate"];

const step = (target, label, hint) => ({ target, label, hint });
const file = (label, selector, flowStep = "upload", options = {}) => ({
  label,
  selector,
  step: flowStep,
  kind: "file",
  required: options.required !== false,
});
const value = (label, selector, flowStep = "info", options = {}) => ({
  label,
  selector,
  step: flowStep,
  kind: "value",
  required: options.required !== false,
});
const checked = (label, selector, flowStep = "settings", options = {}) => ({
  label,
  selector,
  step: flowStep,
  kind: "checked",
  required: options.required !== false,
});
const any = (label, selectors, flowStep = "upload", options = {}) => ({
  label,
  selectors,
  step: flowStep,
  kind: "any",
  required: options.required !== false,
});

export const REPORT_WORKFLOWS = Object.freeze({
  "chem-pre": {
    title: "화학 사전보고서",
    description: "실험 매뉴얼과 기본 정보를 확인하고 학교 양식에 맞는 사전보고서 초안을 만듭니다.",
    time: "약 2–3분",
    steps: {
      upload: step("#manual", "1. 자료", "자료 업로드"),
      info: step("#date", "2. 정보", "실험 정보 입력"),
      settings: step('input[name="model"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#btn", "4. 생성", "보고서 생성"),
    },
    requirements: [
      file("실험 매뉴얼 PDF", "#manual"),
      value("보고서 날짜", "#date"),
      checked("출력 형식", 'input[name="format"]'),
      checked("AI 모델", 'input[name="model"]'),
    ],
  },
  "chem-result": {
    title: "화학 결과보고서",
    description: "사전보고서와 실험 데이터를 바탕으로 결과·분석 추가분을 작성합니다.",
    time: "약 2–4분",
    steps: {
      upload: step("#crPreReport", "1. 자료", "자료 업로드"),
      info: step("#crDate", "2. 정보", "실험 정보 입력"),
      settings: step('input[name="crModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#crBtn", "4. 생성", "보고서 생성"),
    },
    requirements: [
      file("사전보고서 파일", "#crPreReport"),
      any("실험 데이터 또는 사진", ["#crData", "#crPhotos", "#crUserNotes"], "upload", { required: false }),
      value("보고서 날짜", "#crDate"),
      checked("AI 모델", 'input[name="crModel"]'),
    ],
  },
  "phys-result": {
    title: "물리 결과보고서",
    description: "Capstone·표·사진을 분석해 실험 결과와 결론을 문서로 정리합니다.",
    time: "약 3–5분",
    steps: {
      upload: step("#prCap", "1. 자료", "자료 업로드"),
      info: step("#prDate", "2. 정보", "실험 정보 입력"),
      settings: step('input[name="prModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#prBtn", "4. 생성", "보고서 생성"),
    },
    requirements: [
      any(".cap·표·사진 중 하나", ["#prCap", "#prData", "#prPhotos"]),
      value("보고서 날짜", "#prDate"),
      checked("출력 형식", 'input[name="prFormat"]'),
      checked("AI 모델", 'input[name="prModel"]'),
    ],
  },
  "phys-inquiry": {
    title: "물리 수행평가",
    description: "탐구 주제와 필기 자료를 바탕으로 사고 과정이 드러나는 탐구 보고서를 만듭니다.",
    time: "약 3–5분",
    steps: {
      upload: step("#piTopic", "1. 자료", "탐구 자료 입력"),
      info: step("#piDate", "2. 정보", "탐구 정보 입력"),
      settings: step('input[name="piModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#piBtn", "4. 생성", "초안 생성"),
    },
    requirements: [
      value("탐구 주제", "#piTopic", "upload"),
      any("필기·참고자료·링크", ["#piNotes", "#piRefs", "#piRefLinks"]),
      value("보고서 날짜", "#piDate"),
      checked("AI 모델", 'input[name="piModel"]'),
    ],
  },
  "math-inquiry": {
    title: "수학 수행평가",
    description: "수학 탐구 주제와 분석 방향을 구조화해 수행평가 초안을 만듭니다.",
    time: "약 3–5분",
    steps: {
      upload: step("#miTopic", "1. 자료", "탐구 내용 입력"),
      info: step("#miDate", "2. 정보", "보고서 정보 입력"),
      settings: step('input[name="miModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#miBtn", "4. 생성", "초안 생성"),
    },
    requirements: [
      value("탐구 주제", "#miTopic"),
      value("보고서 날짜", "#miDate"),
      checked("출력 형식", 'input[name="miFormat"]'),
      checked("AI 모델", 'input[name="miModel"]'),
    ],
  },
  "reading-log": {
    title: "독서록",
    description: "한 권 또는 여러 권의 도서 정보를 독서활동 기록지 HWPX로 정리합니다.",
    time: "약 1–3분",
    steps: {
      upload: step("#rlTitle", "1. 자료", "도서 자료 입력"),
      info: step("#rlRecordArea", "2. 정보", "도서 정보 입력"),
      settings: step('input[name="rlModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#rlBtn", "4. 생성", "독서록 생성"),
    },
    requirements: [
      any("도서명 또는 책 목록", ["#rlTitle", "#rlExcel"]),
      value("기록 영역", "#rlRecordArea"),
      checked("출력 형식", 'input[name="rlFormat"]'),
      checked("AI 모델", 'input[name="rlModel"]'),
    ],
  },
  "problem-set": {
    title: "문제집 메이커",
    description: "교재 문제를 문제지·답안·해설지로 나누어 구성합니다.",
    time: "약 3–6분",
    steps: {
      upload: step("#psSource", "1. 자료", "문제 자료 업로드"),
      info: step("#psPerPage", "2. 정보", "문제지 정보 입력"),
      settings: step('input[name="psModel"]', "3. 선택 설정", "생성 옵션 선택"),
      generate: step("#psBtn", "4. 생성", "문제집 생성"),
    },
    requirements: [
      file("문제 PDF·사진", "#psSource"),
      value("페이지당 문제 수", "#psPerPage"),
      checked("AI 모델", 'input[name="psModel"]'),
      value("생성 버튼", "#psBtn", "generate"),
    ],
  },
  "vocabulary-book": {
    title: "단어장 메이커",
    description: "영어교재·기존 단어장·엑셀표에 실제로 나온 표현으로 새 영한 단어장을 만듭니다.",
    time: "약 1–5분",
    cost: "무료 (Pro)",
    steps: {
      upload: step("#vbSource", "1. 자료", "영어교재·단어장·표 업로드"),
      info: step("#vbPageRange", "2. 정보", "범위와 묶음 설정"),
      settings: step('input[name="vbModel"]', "3. 선택 설정", "포함 항목·모델 선택"),
      generate: step("#vbBtn", "4. 생성", "단어장 생성"),
    },
    requirements: [
      file("영어 자료 파일", "#vbSource"),
      value("묶음당 출처 수", "#vbPagesPerUnit"),
      value("묶음당 어휘 수", "#vbTermCount"),
      checked("AI 모델", 'input[name="vbModel"]'),
    ],
  },
  "form-maker": {
    title: "양식 메이커",
    description: "설명이나 문서 사진을 편집 가능한 양식으로 복원합니다.",
    time: "약 2–4분",
    steps: {
      upload: step("#fmInstructions", "1. 자료", "설명·사진 입력"),
      info: step("#fmTitle", "2. 정보", "문서 정보 입력"),
      settings: step('input[name="fmModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#fmBtn", "4. 생성", "양식 생성"),
    },
    requirements: [
      any("양식 설명 또는 사진", ["#fmInstructions", "#fmPhotos"]),
      value("문서 제목", "#fmTitle", "info", { required: false }),
      checked("출력 형식", 'input[name="fmFormat"]'),
      checked("AI 모델", 'input[name="fmModel"]'),
    ],
  },
  "print-pdf-restore": {
    title: "프린트 PDF 복원",
    description: "종이 프린트 사진을 의미가 보존된 벡터 PDF로 재구성하고 300dpi OCR·시각 QA로 검증합니다.",
    time: "페이지별 수 분",
    cost: "관리자 베타",
    steps: {
      upload: step("#pprPhotos", "1. 자료", "원본 페이지 사진 업로드"),
      info: step("#pprPageOrder", "2. 정보", "페이지 순서·복원 지시"),
      settings: step("#pprPreserveLayout", "3. 복원 원칙", "양식·도해 복원 원칙 확인"),
      generate: step("#pprBtn", "4. 생성", "검증된 벡터 PDF 생성"),
    },
    requirements: [
      file("페이지 사진", "#pprPhotos"),
      file("원본·참고 PDF", "#pprReference", "upload", { required: false }),
      value("페이지 순서", "#pprPageOrder", "info", { required: false }),
      value("복원 지시", "#pprInstructions", "info", { required: false }),
      value("출력 형식", '#printPdfRestoreForm input[name="format"]'),
    ],
  },
  "eng-exam-prep": {
    title: "영어 시험대비 3종",
    description: "영어 지문을 모의고사·개념 정리·빈칸 자료로 구성합니다.",
    time: "약 3–6분",
    steps: {
      upload: step("#engSource", "1. 자료", "영어 자료 업로드"),
      info: step("#engUserNotes", "2. 정보", "요청 사항 입력"),
      settings: step('input[name="engModel"]', "3. 선택 설정", "AI 모델 선택"),
      generate: step("#engExamBtn", "4. 생성", "자료 생성"),
    },
    requirements: [
      file("영어 지문·학습지", "#engSource"),
      value("추가 요청", "#engUserNotes", "info", { required: false }),
      checked("AI 모델", 'input[name="engModel"]'),
      value("생성 버튼", "#engExamBtn", "generate"),
    ],
  },
  "korean-lit-exam": {
    title: "국어 문학 시험",
    description: "학습지와 판서를 시험지·답안·해설 자료로 변환합니다.",
    time: "약 3–6분",
    steps: {
      upload: step("#klSource", "1. 자료", "문학 자료 업로드"),
      info: step("#klUserNotes", "2. 정보", "요청 사항 입력"),
      settings: step('input[name="klModel"]', "3. 선택 설정", "AI 모델 선택"),
      generate: step("#koreanLitBtn", "4. 생성", "시험 자료 생성"),
    },
    requirements: [
      file("학습지·판서", "#klSource"),
      file("예시 문제은행", "#klBank", "upload", { required: false }),
      checked("AI 모델", 'input[name="klModel"]'),
      value("생성 버튼", "#koreanLitBtn", "generate"),
    ],
  },
  "cap-translate": {
    title: "Capstone .cap 번역",
    description: "Capstone 파일 안의 화면 텍스트를 선택한 언어로 번역합니다.",
    time: "약 2–5분",
    steps: {
      upload: step("#capFile", "1. 자료", ".cap 파일 업로드"),
      info: step("#capTargetLang", "2. 정보", "번역 언어 선택"),
      settings: step('input[name="capModel"]', "3. 선택 설정", "AI 모델 선택"),
      generate: step("#capTranslateBtn", "4. 생성", "번역 파일 생성"),
    },
    requirements: [
      file("Capstone .cap 파일", "#capFile"),
      value("번역 언어", "#capTargetLang"),
      checked("AI 모델", 'input[name="capModel"]'),
      value("생성 버튼", "#capTranslateBtn", "generate"),
    ],
  },
  "phys-mock-exam": {
    title: "물리 모의고사",
    description: "기출과 교과서 단원을 분석해 시험지·답안 자료를 만듭니다.",
    time: "약 4–8분",
    steps: {
      upload: step("#pmExam", "1. 자료", "시험 자료 업로드"),
      info: step("#pmUserNotes", "2. 정보", "출제 요청 입력"),
      settings: step('input[name="pmModel"]', "3. 선택 설정", "AI 모델 선택"),
      generate: step("#physMockBtn", "4. 생성", "모의고사 생성"),
    },
    requirements: [
      file("기출 시험지", "#pmExam"),
      file("교과서 단원", "#pmTextbook"),
      checked("AI 모델", 'input[name="pmModel"]'),
      value("생성 버튼", "#physMockBtn", "generate"),
    ],
  },
  free: {
    title: "자유 보고서",
    description: "작성 지시와 자료를 원하는 출력 형식의 보고서로 정리합니다.",
    time: "약 2–4분",
    steps: {
      upload: step("#frInstructions", "1. 자료", "지시·자료 입력"),
      info: step("#frDate", "2. 정보", "보고서 정보 입력"),
      settings: step('input[name="frModel"]', "3. 선택 설정", "출력 옵션 선택"),
      generate: step("#frBtn", "4. 생성", "보고서 생성"),
    },
    requirements: [
      value("작성 지시", "#frInstructions"),
      value("보고서 날짜", "#frDate"),
      checked("출력 형식", 'input[name="frFormat"]'),
      checked("AI 모델", 'input[name="frModel"]'),
    ],
  },
});

export const WORKFLOW_STEPS = Object.freeze(STEPS.slice());

export function getReportWorkflow(type) {
  return REPORT_WORKFLOWS[String(type || "")] || null;
}

function nodes(form, selector) {
  if (!form || !selector) return [];
  try { return Array.from(form.querySelectorAll(selector)); }
  catch (_) { return []; }
}

function nodeHasValue(node) {
  if (!node) return false;
  if (node.type === "file") return !!node.files?.length;
  if (node.type === "checkbox" || node.type === "radio") return !!node.checked;
  if (node.tagName === "BUTTON") return true;
  return !!String(node.value || "").trim();
}

export function requirementComplete(form, requirement) {
  if (!requirement) return false;
  if (requirement.kind === "any") {
    return requirement.selectors.some((selector) => nodes(form, selector).some(nodeHasValue));
  }
  const matches = nodes(form, requirement.selector);
  if (requirement.kind === "checked") return matches.some((node) => node.checked);
  return matches.some(nodeHasValue);
}

function nodeDisplay(node) {
  if (!node) return "미입력";
  if (node.type === "file") {
    const selected = Array.from(node.files || []);
    if (!selected.length) return "미입력";
    if (selected.length === 1) return selected[0].name;
    return `${selected.length}개 파일`;
  }
  if (node.type === "radio" || node.type === "checkbox") {
    if (!node.checked) return "미선택";
    return node.closest("label")?.textContent?.replace(/\s+/g, " ").trim() || node.value;
  }
  if (node.tagName === "SELECT") return node.selectedOptions?.[0]?.textContent?.trim() || node.value || "미선택";
  if (node.tagName === "BUTTON") return "준비됨";
  const text = String(node.value || "").trim();
  return text ? (text.length > 32 ? `${text.slice(0, 32)}…` : text) : "미입력";
}

export function requirementDisplay(form, requirement) {
  if (!requirement) return "미입력";
  if (requirement.kind === "any") {
    for (const selector of requirement.selectors) {
      const node = nodes(form, selector).find(nodeHasValue);
      if (node) return nodeDisplay(node);
    }
    return "미입력";
  }
  const matches = nodes(form, requirement.selector);
  const selected = requirement.kind === "checked" ? matches.find((node) => node.checked) : matches.find(nodeHasValue);
  return nodeDisplay(selected || matches[0]);
}

export function resolveWorkflowTarget(form, workflow, flowStep) {
  const selector = workflow?.steps?.[flowStep]?.target;
  const node = nodes(form, selector)[0] || null;
  if (!node) return flowStep === "generate" ? form?.querySelector(".form-actions") || form : form;
  if (flowStep === "generate") return node.closest(".form-actions") || node;
  return node.closest(".form-section") || node.closest(".policy-check") || node;
}

export function workflowStepForElement(form, workflow, element) {
  if (!form || !workflow || !element) return "";
  for (const flowStep of STEPS) {
    const target = resolveWorkflowTarget(form, workflow, flowStep);
    if (target && (target === element || target.contains(element))) return flowStep;
  }
  return "";
}

export function selectedModelValue(form) {
  return form?.querySelector('input[type="radio"][name*="Model"]:checked, input[type="radio"][name="model"]:checked')?.value || "";
}

export function modelCostLabel(model) {
  if (/gpt-5\.4-mini/i.test(model || "")) return "하루 5건 무료 · 이후 1크레딧";
  if (!model || /flash/i.test(model)) return "무료";
  if (/sonnet/i.test(model)) return "2 크레딧";
  if (/gpt-5\.4$/i.test(model) || /gemini-3\.1/i.test(model)) return "1–2 크레딧";
  return "4 크레딧";
}
