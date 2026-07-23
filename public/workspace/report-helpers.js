export const USE_POLICY_NOTE =
  "학습 보조 초안입니다. 권한 있는 파일만 업로드하고, 학교·교사 기준을 확인한 뒤 직접 검토·수정해 사용하세요. 그대로 제출하면 안 됩니다.";

const MODEL_CREDITS = {
  "claude-fable-5": 9,
  "claude-opus-4-8": 4,
  "claude-opus-4-7": 4,
  "claude-sonnet-5": 2,
  "gpt-5.5": 4,
  "gpt-5.4": 1,
  "gpt-5.4-mini": 0,
  "gemini-3.1-pro": 2,
  "gemini-2.5-flash": 1,
};

export function getModelCredits(modelId) {
  return MODEL_CREDITS[modelId] != null ? MODEL_CREDITS[modelId] : 4;
}

export function listSelectableModelOptions(form, radioName) {
  if (!form || !radioName) return [];
  const options = [];
  form.querySelectorAll(`input[name="${radioName}"]`).forEach((input) => {
    if (input.disabled) return;
    const label = input.closest("label");
    if (label && (label.hidden || getComputedStyle(label).display === "none")) return;
    options.push({ value: input.value, credits: getModelCredits(input.value), input });
  });
  return options.sort((a, b) => a.credits - b.credits);
}

export function findAffordableModelOption(form, radioName, balance) {
  return listSelectableModelOptions(form, radioName).find((option) => option.credits <= balance) || null;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

export function appendPolicyAcknowledgements(formData) {
  formData.append("copyrightAccepted", "true");
  formData.append("academicIntegrityAccepted", "true");
  formData.append("policyAcceptedAt", new Date().toISOString());
}

export function getSelectedModel() {
  const input = document.querySelector('input[name="model"]:checked') || document.querySelector('input[name="model"]');
  return input ? input.value : "claude-opus-4-8";
}

export function getModelLabel(modelId) {
  return ({
    "claude-fable-5": "Fable 5",
    "claude-opus-4-8": "Opus 4.8",
    "claude-opus-4-7": "Opus 4.7",
    "claude-sonnet-5": "Sonnet 5",
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-mini": "GPT-5.4 mini",
    "gemini-3.1-pro": "Gemini 3.1 Pro",
    "gemini-2.5-flash": "Gemini 2.5 Flash",
  })[modelId] || modelId || "Opus 4.8";
}

export function getFontLabel(fontId) {
  return ({
    "hamchorom-batang": "함초롬바탕",
    "nanum-gothic": "나눔고딕",
    "nanum-myeongjo": "나눔명조",
  })[fontId] || "맑은 고딕";
}

export function getUserNotesValue(id) {
  return (document.getElementById(id)?.value || "").trim();
}

export function getUserNotesFile(id) {
  return document.getElementById(id)?.files?.[0] || null;
}

export function validateUserNotesFile(file) {
  if (!file) return true;
  const extension = (file.name.split(".").pop() || "").toLowerCase();
  if (!["md", "txt"].includes(extension)) {
    alert("AI 참고 메모 파일은 .md 또는 .txt 형식만 업로드할 수 있습니다.");
    return false;
  }
  if (file.size > 256 * 1024) {
    alert("AI 참고 메모 파일은 최대 256KB까지만 업로드할 수 있습니다.");
    return false;
  }
  return true;
}

export function userNotesSummary(notes, file = null) {
  const parts = [];
  if (notes) parts.push(`${notes.length}자 직접 입력`);
  if (file) parts.push(`${file.name} (${formatBytes(file.size)})`);
  return parts.length ? parts.join(", ") : "없음";
}
