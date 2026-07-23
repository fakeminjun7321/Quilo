import { isRetiredReport } from "./report-registry.js";

const TYPE_LABELS = {
  "chem-pre": "화학 사전보고서",
  "chem-result": "화학 결과보고서",
  "phys-result": "물리 결과보고서",
  "phys-inquiry": "물리 수행평가",
  "math-inquiry": "수학 수행평가",
  free: "자유 보고서",
  "reading-log": "독서록",
  "reading-log-bulk": "독서록 대량 생성",
  "problem-set": "문제집 메이커",
  "vocabulary-book": "단어장 메이커",
  "form-maker": "양식 메이커",
  "print-pdf-restore": "프린트 PDF 복원",
  "eng-exam-prep": "영어 시험대비 세트",
  "korean-lit-exam": "국어 문학 시험 세트",
  "phys-mock-exam": "물리 모의고사",
  "cap-translate": "Capstone 번역",
  "pdf-translate": "PDF 통번역",
};
const STATUS_LABELS = { running: "⏳ 진행 중", interrupted: "⚠ 중단됨", error: "❌ 실패" };

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function createBackgroundJobsController({ onReopen }) {
  async function render() {
    const filesList = document.getElementById("filesList");
    if (!filesList?.parentNode) return;
    let data = { jobs: [] };
    try {
      const response = await fetch("/api/me/jobs");
      if (response.ok) data = await response.json();
    } catch (_) { return; }
    const jobs = (data.jobs || []).filter((job) =>
      !isRetiredReport(job.reportType) && ["running", "interrupted", "error"].includes(job.status));
    let block = document.getElementById("bgJobsBlock");
    if (!block) {
      block = document.createElement("div");
      block.id = "bgJobsBlock";
      block.className = "background-jobs";
      filesList.parentNode.insertBefore(block, filesList);
    }
    if (!jobs.length) { block.replaceChildren(); return; }
    const title = document.createElement("div");
    title.className = "background-jobs__title";
    title.textContent = "🌙 백그라운드 작업";
    const rows = jobs.map((job) => {
      const row = document.createElement("div");
      row.className = "background-job";
      const state = document.createElement("b");
      state.className = "background-job__state";
      state.textContent = STATUS_LABELS[job.status] || job.status;
      const meta = document.createElement("span");
      meta.className = "background-job__meta";
      meta.textContent = `${TYPE_LABELS[job.reportType] || job.reportType || "보고서"} · ${formatDateTime(job.createdAt)}`;
      row.append(state, meta);
      if (job.status === "running") {
        const action = document.createElement("a");
        action.href = "#";
        action.className = "background-job__action";
        action.textContent = "진행 보기";
        action.addEventListener("click", (event) => {
          event.preventDefault();
          onReopen?.(String(job.id || ""));
        });
        row.appendChild(action);
      } else {
        const error = document.createElement("span");
        error.className = "background-job__error";
        error.textContent = String(job.error || "");
        row.appendChild(error);
      }
      return row;
    });
    block.replaceChildren(title, ...rows);
  }
  return { render };
}
