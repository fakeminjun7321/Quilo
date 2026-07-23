import { installReportFormControllers } from "./forms/controller.js";
import { createCommonFormsController } from "./forms/common.js";
import { createProgressView } from "./progress-view.js";
import { createResultView } from "./result-view.js";
import { createGenerationController } from "./generation-controller.js";
import { createDraftController } from "./drafts.js";
import { createChecklistController } from "./checklist.js";
import { createConfirmationController } from "./confirmation-controller.js";
import { createJobStreamController } from "./job-stream.js";
import { createReportPreferences, initDefaultReportPreferences } from "./report-preferences.js";
import { createStudentIdBannerController } from "./student-id-banner.js";
import { createBackgroundJobsController } from "./background-jobs.js";
import { trackEvent } from "./telemetry.js";
import {
  USE_POLICY_NOTE, appendPolicyAcknowledgements, findAffordableModelOption, formatBytes,
  getFontLabel, getModelCredits, getModelLabel, getSelectedModel, getUserNotesFile,
  getUserNotesValue, userNotesSummary, validateUserNotesFile,
} from "./report-helpers.js";
import {
  getFormMakerFormat, getMathInquiryFormat, getPhysInquiryFormat, initFormatControls,
  updateChemPreFontOptions, updateChemResultFontOptions, updateFormMakerFontOptions,
  updateFreeFontOptions, updateMathInquiryFontOptions, updatePhysInquiryFontOptions,
  updatePhysResultFontOptions, updateReadingLogFontOptions,
} from "./report-formats.js";
import {
  costRangeText, estimateChemResultCost, estimateCost, estimateFreeReportCost,
  estimateGenSeconds, estimatePhysResultCost, formatDuration,
} from "./report-estimates.js";

const runtime = window.__quiloWorkspaceRuntime;
if (!runtime) throw new Error("Quilo workspace runtime is not initialized");

let currentStudentId = runtime.state.get().studentId || "";
let currentJobId = null;
let activeForm = null;
let lastSubmission = null;
let retryCount = 0;
let submitReport;
let streamJob;
let clearRetryCard = () => {};
let showGenerationError = () => {};

runtime.state.subscribe((next) => { currentStudentId = next.studentId || ""; });

const reportChecklistItems = {
  "chem-pre": { title: "화학 사전보고서", items: ["실험 매뉴얼 PDF", "보고서 날짜", "생성 버튼"] },
  "chem-result": { title: "화학 결과보고서", items: ["사전보고서 파일", "실험 데이터 또는 사진", "보고서 날짜", "생성 버튼"] },
  "phys-result": { title: "물리 결과보고서", items: [".cap 또는 엑셀/CSV/텍스트", "사진/그래프 스크린샷 선택", "학번 저장", "보고서 날짜"] },
  free: { title: "자유 보고서", items: ["작성 지시", "필요 자료", "출력 형식 확인", "생성 버튼"] },
  "phys-inquiry": { title: "물리 수행평가", items: ["탐구 주제", "필기노트/참고자료", "학번 저장", "생성 버튼"] },
  "math-inquiry": { title: "수학 수행평가", items: ["탐구 주제", "분석 방향", "학번 저장", "생성 버튼"] },
  "problem-set": { title: "문제집 메이커", items: ["문제 PDF/사진", "페이지당 문제 수", "교차검증 선택", "만들기 버튼"] },
  "vocabulary-book": { title: "단어장 메이커", items: ["영어교재·단어장·표", "PDF 페이지 범위", "묶음·어휘 수", "단어장 만들기 버튼"] },
  "form-maker": { title: "양식 메이커", items: ["양식 설명 또는 문서 사진", "출력 형식·글꼴", "만들기 버튼"] },
  "print-pdf-restore": { title: "프린트 PDF 복원", items: ["원본 페이지 사진", "페이지 순서 확인", "의미 기반 도해 복원", "300dpi 검증 PDF 생성"] },
  "reading-log": { title: "독서록", items: ["도서명", "영역·기록 구분 선택", "감상 메모(선택)", "생성 버튼"] },
};

const commonForms = createCommonFormsController({
  getModelLabel,
  formatBytes,
  setView: runtime.shell.setView,
  showTab: runtime.shell.showTab,
  setPending: runtime.router.setPending,
  navigateReport: runtime.router.writeReportUrl,
  openLogin: runtime.shell.openLogin,
  reportChecklistItems,
});
commonForms.init();
window.updateAllOptionalSummaries = commonForms.updateAllOptionalSummaries;

const reportPreferences = createReportPreferences({
  updateOptionalSummaries: commonForms.updateAllOptionalSummaries,
});
const studentIdBanners = createStudentIdBannerController({
  getStudentId: () => currentStudentId,
  showTab: runtime.shell.showTab,
});
const backgroundJobs = createBackgroundJobsController({
  onReopen(jobId) {
    currentJobId = jobId;
    streamJob?.(jobId);
    window.scrollTo({ top: 0, behavior: "smooth" });
  },
});

const elements = {
  form: document.getElementById("form"),
  btn: document.getElementById("btn"),
  stopBtn: document.getElementById("stopBtn"),
  crForm: document.getElementById("chemResultForm"),
  crBtn: document.getElementById("crBtn"),
  prForm: document.getElementById("physResultForm"),
  prBtn: document.getElementById("prBtn"),
  piForm: document.getElementById("physInquiryForm"),
  piBtn: document.getElementById("piBtn"),
  miForm: document.getElementById("mathInquiryForm"),
  miBtn: document.getElementById("miBtn"),
  frForm: document.getElementById("freeForm"),
  frBtn: document.getElementById("frBtn"),
  psForm: document.getElementById("problemSetForm"),
  psBtn: document.getElementById("psBtn"),
  vbForm: document.getElementById("vocabularyBookForm"),
  vbBtn: document.getElementById("vbBtn"),
  fmForm: document.getElementById("formMakerForm"),
  fmBtn: document.getElementById("fmBtn"),
  pprForm: document.getElementById("printPdfRestoreForm"),
  pprBtn: document.getElementById("pprBtn"),
  rlForm: document.getElementById("readingLogForm"),
  rlBtn: document.getElementById("rlBtn"),
};

const formTelemetryTypes = new Map([
  [elements.form, "chem-pre"],
  [elements.crForm, "chem-result"],
  [elements.prForm, "phys-result"],
  [elements.piForm, "phys-inquiry"],
  [elements.miForm, "math-inquiry"],
  [elements.frForm, "free"],
  [elements.psForm, "problem-set"],
  [elements.vbForm, "vocabulary-book"],
  [elements.fmForm, "form-maker"],
  [elements.pprForm, "print-pdf-restore"],
  [elements.rlForm, "reading-log"],
].filter(([form]) => !!form));
const startedTelemetryForms = new WeakSet();
for (const [form, reportType] of formTelemetryTypes) {
  const markStarted = () => {
    if (startedTelemetryForms.has(form)) return;
    startedTelemetryForms.add(form);
    trackEvent("form_started", { reportType, source: "report_form" });
  };
  form.addEventListener("input", markStarted, { passive: true });
  form.addEventListener("change", markStarted, { passive: true });
}

function initializeDefaults() {
  const today = new Date().toISOString().slice(0, 10);
  document.querySelectorAll('input[type="date"]').forEach((input) => {
    if (!input.value) input.value = today;
  });
  try {
    const cached = JSON.parse(localStorage.getItem("chemPreUserDefaults") || "{}");
    if (cached.studentName && document.getElementById("studentName")) {
      document.getElementById("studentName").value = cached.studentName;
    }
  } catch (_) {}
  const recordArea = document.getElementById("rlRecordArea");
  if (recordArea) {
    const sync = () => {
      const subject = document.getElementById("rlSubjectField");
      const enrolled = document.getElementById("rlEnrolledField");
      if (subject) subject.hidden = recordArea.value !== "subject";
      if (enrolled) enrolled.hidden = recordArea.value !== "auto";
    };
    recordArea.addEventListener("change", sync);
    sync();
  }
}

function rememberSubmission(args) {
  try {
    lastSubmission = {
      formEl: args.formEl || null,
      buttonEl: args.buttonEl || null,
      formData: args.formData || null,
      busyText: args.busyText || "생성 중...",
      estimate: args.estimate || null,
    };
  } catch (_) { lastSubmission = null; }
}

function retryLastSubmission() {
  if (!lastSubmission?.formData || currentJobId) return;
  retryCount += 1;
  trackEvent("retry_clicked", { source: "generation_error" });
  submitReport({
    formEl: lastSubmission.formEl,
    buttonEl: lastSubmission.buttonEl,
    formData: lastSubmission.formData,
    busyText: lastSubmission.busyText,
    estimate: lastSubmission.estimate,
  });
}

function lockForm(form) {
  activeForm = form;
  form.querySelectorAll("input, button[type='submit']").forEach((control) => { control.disabled = true; });
  elements.stopBtn.classList.remove("is-source-hidden");
  elements.stopBtn.hidden = false;
  elements.stopBtn.disabled = false;
}

function unlockForm() {
  activeForm?.querySelectorAll("input, button[type='submit']").forEach((control) => {
    const modelRadio = control.matches?.('input[type="radio"][name="model"], input[type="radio"][name$="Model"]');
    const providerUnavailable = control.dataset.modelAvailabilityApplied === "true";
    const unavailableSubmit = control.dataset.modelProviderBlocked === "true";
    const hiddenRestrictedModel = modelRadio && !!control.closest("label")?.hidden;
    control.disabled = providerUnavailable || unavailableSubmit || hiddenRestrictedModel;
  });
  activeForm = null;
  elements.stopBtn.hidden = true;
  currentJobId = null;
}

function resetForm() {
  unlockForm();
  progressView.stopTimer();
  const labels = new Map([
    [elements.btn, "사전보고서 생성"],
    [elements.crBtn, "결과보고서 생성"],
    [elements.prBtn, "물리 결과보고서 생성"],
    [elements.piBtn, "물리 수행평가 초안 생성"],
    [elements.miBtn, "수학 수행평가 초안 생성"],
    [elements.psBtn, "문제지·해설지 만들기"],
    [elements.vbBtn, "단어장 만들기"],
    [elements.frBtn, "자유 보고서 생성"],
    [elements.fmBtn, "양식 만들기"],
    [elements.pprBtn, "벡터 PDF 복원"],
  ]);
  labels.forEach((label, button) => { if (button) button.textContent = label; });
  elements.stopBtn.textContent = "중지";
  const spinner = document.getElementById("genSpinner");
  if (spinner) spinner.hidden = true;
}

const confirmationController = createConfirmationController({
  balanceState: runtime.account.balanceState,
  formatDateTime(value) {
    if (!value) return "-";
    return new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  },
  findAffordableModelOption,
  getModelCredits,
});

const progressView = createProgressView({ onClearRetry: () => clearRetryCard() });
const resultView = createResultView({
  appendLine: progressView.append,
  getLastSubmission: () => lastSubmission,
  retryLastSubmission,
});
clearRetryCard = resultView.clearRetryCard;
showGenerationError = resultView.showGenerationError;

const jobStreamController = createJobStreamController({
  runtime: {
    set currentEs(_) {},
    set retryCount(value) { retryCount = value; },
    get pendingPrefs() { return reportPreferences.pending; },
  },
  appendLine: progressView.append,
  setProgressStep: progressView.setStep,
  stopGenTimer: progressView.stopTimer,
  clearRetryCard,
  resetForm,
  showGenErrorCard: showGenerationError,
  commitLastGenPrefs: reportPreferences.commit,
  loadBalance: runtime.account.loadBalance,
  loadFiles: runtime.files.loadFiles,
});
streamJob = jobStreamController.streamJob;

const generationController = createGenerationController({
  lockForm,
  backgroundChoice: confirmationController.backgroundChoice,
  capturePreferences: reportPreferences.capture,
  rememberSubmission,
  clearRetryCard,
  beginProgress: progressView.begin,
  setCurrentJob(jobId) { currentJobId = jobId; },
  streamJob,
  showBackgroundToast: confirmationController.showBackgroundToast,
  stopTimer: progressView.stopTimer,
  resetForm,
  showSuspendedAppeal: confirmationController.showSuspendedAppealModal,
  showError: showGenerationError,
});
submitReport = generationController.submitReport;

installReportFormControllers({
  runtime: {
    get currentJobId() { return currentJobId; },
    get studentId() { return currentStudentId; },
    get isAdmin() { return runtime.state.get().user?.isAdmin === true; },
  },
  elements,
  getSelectedModel,
  getModelLabel,
  getFontLabel,
  updateChemPreFontOptions,
  updateChemResultFontOptions,
  updatePhysResultFontOptions,
  updatePhysInquiryFontOptions,
  updateMathInquiryFontOptions,
  updateReadingLogFontOptions,
  updateFreeFontOptions,
  updateFormMakerFontOptions,
  getPhysInquiryFormat,
  getMathInquiryFormat,
  getFormMakerFormat,
  validateUserNotesFile,
  getUserNotesValue,
  getUserNotesFile,
  estimateCost,
  estimateChemResultCost,
  estimatePhysResultCost,
  estimateFreeReportCost,
  estimateGenSeconds,
  showConfirmDialog: confirmationController.showConfirmDialog,
  getModelCredits,
  userNotesSummary,
  costRangeText,
  formatDuration,
  submitReport,
  showTab: runtime.shell.showTab,
  appendPolicyAcknowledgements,
  usePolicyNote: USE_POLICY_NOTE,
});

elements.stopBtn.addEventListener("click", async () => {
  if (!currentJobId) return;
  const confirmed = await confirmationController.showConfirmDialog({
    title: "작업 중지",
    rows: [["상태", "진행 중인 작업을 중단합니다."]],
    note: "이미 사용된 토큰 비용은 발생할 수 있습니다.",
    okLabel: "중지",
  });
  if (!confirmed) return;
  trackEvent("abort_clicked", { source: "generation_progress" });
  elements.stopBtn.disabled = true;
  elements.stopBtn.textContent = "중지 중...";
  try { await fetch(`/api/jobs/${currentJobId}/abort`, { method: "POST" }); } catch (_) {}
});

runtime.registerHooks({
  selectReport(_type, options = {}) {
    runtime.shell.showTab("reports");
    commonForms.updateReportTypeView({ scroll: !!options.scroll });
  },
  studentIdChanged: studentIdBanners.update,
  renderPremiumBadge: confirmationController.renderPremiumBadge,
  renderBackgroundJobs: backgroundJobs.render,
  confirmFileDelete(file) {
    return confirmationController.showConfirmDialog({
      title: "파일 삭제",
      rows: [["파일", file.filename || "보고서"]],
      note: "파일함에서 바로 삭제합니다.",
      okLabel: "삭제",
    });
  },
});

initializeDefaults();
initFormatControls();
createDraftController().init();
createChecklistController({
  getStudentId: () => currentStudentId,
  setFlowStep: commonForms.setFlowStep,
  showTab: runtime.shell.showTab,
}).init();
studentIdBanners.update();
reportPreferences.restoreLast();
initDefaultReportPreferences();
