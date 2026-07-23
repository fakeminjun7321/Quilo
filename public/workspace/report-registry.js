export const CORE_REPORTS = Object.freeze({
  "chem-pre": { title: "화학 사전보고서", formId: "form" },
  "chem-result": { title: "화학 결과보고서", formId: "chemResultForm" },
  "phys-result": { title: "물리 결과보고서", formId: "physResultForm" },
  free: { title: "자유 보고서", formId: "freeForm" },
  "reading-log": { title: "독서록", formId: "readingLogForm" },
});

// 전용 reportType 라디오가 없는 하위 모드용 별칭: base 라디오를 선택한 뒤 모드 라디오를 켠다.
// 이 모듈은 data 전용으로 유지한다(최상위 DOM 접근 금지 — Node 계약 테스트가 import 한다).
export const REPORT_ALIASES = Object.freeze({
  "reading-log-bulk": Object.freeze({
    base: "reading-log",
    mode: Object.freeze({ name: "rlMode", value: "bulk" }),
  }),
});

export const RETIRED_REPORT_TYPES = Object.freeze([
  "eng-exam-prep",
  "korean-lit-exam",
  "phys-inquiry",
  "math-inquiry",
  "phys-mock-exam",
]);

export function isRetiredReport(type) {
  return RETIRED_REPORT_TYPES.includes(String(type || ""));
}

export function reportExists(type) {
  return !!document.querySelector(`input[name="reportType"][value="${CSS.escape(String(type || ""))}"]`);
}
