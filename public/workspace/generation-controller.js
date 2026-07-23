import { summarizeGenerationForm, trackEvent } from "./telemetry.js";

export function createGenerationController(deps) {
  async function submitReport({ formEl, buttonEl, formData, busyText = "생성 중...", estimate = null }) {
    const telemetry = summarizeGenerationForm(formData);
    trackEvent("generation_submitted", telemetry);
    deps.lockForm(formEl);
    if (buttonEl) buttonEl.textContent = busyText;
    try {
      const background = deps.backgroundChoice(formEl);
      if (formData) {
        try {
          if (localStorage.getItem("quilo.googleDrive.autoSaveReports") === "1") {
            formData.set("saveToGoogleDrive", "true");
            const folderId = localStorage.getItem("quilo.googleDrive.folderId") || "";
            if (folderId) formData.set("googleDriveFolderId", folderId);
            else formData.delete("googleDriveFolderId");
          } else {
            formData.delete("saveToGoogleDrive");
            formData.delete("googleDriveFolderId");
          }
        } catch (_) {}
        if (background.enabled) {
          formData.set("backgroundMode", "true");
          if (background.notifyEmail) formData.set("notifyEmail", "true");
          else formData.delete("notifyEmail");
        } else {
          formData.delete("backgroundMode");
          formData.delete("notifyEmail");
        }
      }
    } catch (_) {}
    deps.capturePreferences(formData);
    deps.rememberSubmission({ formEl, buttonEl, formData, busyText, estimate });
    deps.clearRetryCard();
    deps.beginProgress("생성 중...", estimate);
    try {
      const response = await fetch("/api/generate", { method: "POST", body: formData });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.error || `요청 실패 (HTTP ${response.status})`);
        error.httpStatus = response.status;
        error.suspended = !!data.suspended;
        error.suspendReason = data.reason || "";
        throw error;
      }
      const background = formData.get("backgroundMode") === "true";
      trackEvent("generation_accepted", telemetry);
      deps.setCurrentJob(data.jobId, background);
      deps.streamJob(data.jobId);
      if (background) deps.showBackgroundToast(formData.get("notifyEmail") === "true");
    } catch (error) {
      if (error?.suspended) {
        deps.stopTimer();
        deps.resetForm();
        deps.showSuspendedAppeal(error.suspendReason || "", error.message || "");
        return;
      }
      const status = error?.httpStatus || 0;
      trackEvent("generation_rejected", {
        ...telemetry,
        httpStatus: status || 500,
        failureCode: status ? `http_${status}` : "network_error",
      });
      const inputError = status === 400;
      const creditError = status === 402 || /크레딧|credit|잔액|충전/i.test(error?.message || "");
      deps.showError({
        message: error?.message,
        detail: error?.message,
        phase: "submit",
        httpStatus: status,
        allowRetry: !inputError && !creditError,
        scrollToForm: inputError ? formEl : null,
      });
      deps.stopTimer();
      deps.resetForm();
    }
  }

  return { submitReport };
}
