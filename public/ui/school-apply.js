"use strict";

(function initSchoolApplication() {
  const form = document.getElementById("form");
  const submitButton = document.getElementById("btn");
  const formError = document.getElementById("err");
  const fileInput = document.getElementById("files");
  const fileList = document.getElementById("fileList");
  const fileError = document.getElementById("fileError");
  const dropzone = document.getElementById("fileDropzone");
  const progress = document.querySelector(".application-progress");
  const successPanel = document.getElementById("successPanel");
  const reviewSummary = document.getElementById("reviewSummary");
  if (!form || !submitButton || !fileInput || !dropzone || !successPanel) return;

  const panels = [...document.querySelectorAll("[data-step-panel]")];
  const indicators = [...document.querySelectorAll("[data-step-indicator]")];
  let currentStep = 1;
  let selectedFiles = [];

  function field(id) {
    return document.getElementById(id);
  }

  function setFieldError(id, message) {
    const input = field(id);
    const error = document.querySelector(`[data-error-for="${id}"]`);
    if (input) {
      if (message) {
        input.setAttribute("aria-invalid", "true");
        if (error?.id) input.setAttribute("aria-errormessage", error.id);
      } else {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-errormessage");
      }
    }
    if (error) error.textContent = message || "";
  }

  function value(id) {
    return String(field(id)?.value || "").trim();
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function validDomain(domain) {
    return /^(?=.{3,120}$)(?!-)(?:[a-z0-9-]+\.)+[a-z0-9-]{2,}$/i.test(domain);
  }

  function validateStep(step, focusFirst = true) {
    const errors = [];
    if (step === 1) {
      setFieldError("schoolName", "");
      setFieldError("contactName", "");
      setFieldError("contactEmail", "");
      if (!value("schoolName")) errors.push(["schoolName", "학교명을 입력해 주세요."]);
      if (!value("contactName")) errors.push(["contactName", "담당자 이름을 입력해 주세요."]);
      if (!validEmail(value("contactEmail"))) errors.push(["contactEmail", "담당자 이메일 형식을 확인해 주세요."]);
    }
    if (step === 2) {
      setFieldError("studentEmailDomain", "");
      const domain = value("studentEmailDomain").replace(/^@+/, "");
      if (!domain) errors.push(["studentEmailDomain", "학생 이메일 도메인을 입력해 주세요."]);
      else if (!validDomain(domain)) errors.push(["studentEmailDomain", "@ 없이 실제 학교 이메일 도메인 형식으로 입력해 주세요."]);
    }
    if (step === 3) {
      setFieldError("consent", "");
      if (!field("consent")?.checked) errors.push(["consent", "개인정보 수집·이용 동의가 필요합니다."]);
    }
    errors.forEach(([id, message]) => setFieldError(id, message));
    if (errors.length && focusFirst) field(errors[0][0])?.focus();
    return errors.length === 0;
  }

  function showStep(step, { focus = true } = {}) {
    currentStep = Math.min(3, Math.max(1, Number(step) || 1));
    panels.forEach((panel) => { panel.hidden = Number(panel.dataset.stepPanel) !== currentStep; });
    indicators.forEach((indicator) => {
      const indicatorStep = Number(indicator.dataset.stepIndicator);
      indicator.classList.toggle("is-current", indicatorStep === currentStep);
      indicator.classList.toggle("is-complete", indicatorStep < currentStep);
      if (indicatorStep === currentStep) indicator.setAttribute("aria-current", "step");
      else indicator.removeAttribute("aria-current");
    });
    if (currentStep === 3) updateReview();
    formError.textContent = "";
    if (focus) {
      const heading = document.querySelector(`[data-step-panel="${currentStep}"] h2`);
      if (heading) {
        heading.tabIndex = -1;
        heading.focus({ preventScroll: true });
      }
      if (window.matchMedia("(max-width: 760px)").matches) {
        document.querySelector(".application-form-shell")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }
  }

  function normalizeDomain() {
    const input = field("studentEmailDomain");
    if (input) input.value = input.value.trim().toLowerCase().replace(/^@+/, "");
  }

  function formatBytes(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
    return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  }

  function fileKey(file) {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function syncFileInput() {
    try {
      const transfer = new DataTransfer();
      selectedFiles.forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
    } catch (_) {
      fileError.textContent = "이 브라우저에서는 끌어놓기보다 ‘파일 선택’을 이용해 주세요.";
    }
  }

  function renderFiles() {
    fileList.replaceChildren();
    selectedFiles.forEach((file, index) => {
      const item = document.createElement("li");
      const name = document.createElement("strong");
      name.textContent = file.name;
      const size = document.createElement("span");
      size.textContent = formatBytes(file.size);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "삭제";
      remove.setAttribute("aria-label", `${file.name} 첨부에서 삭제`);
      remove.addEventListener("click", () => {
        selectedFiles.splice(index, 1);
        syncFileInput();
        renderFiles();
      });
      item.append(name, size, remove);
      fileList.appendChild(item);
    });
  }

  function addFiles(fileCollection) {
    fileError.textContent = "";
    const incoming = Array.from(fileCollection || []);
    const known = new Set(selectedFiles.map(fileKey));
    let skipped = 0;
    incoming.forEach((file) => {
      if (!known.has(fileKey(file)) && selectedFiles.length < 8) {
        selectedFiles.push(file);
        known.add(fileKey(file));
      } else if (!known.has(fileKey(file))) {
        skipped += 1;
      }
    });
    if (skipped > 0) {
      fileError.textContent = "첨부 파일은 최대 8개까지 접수됩니다.";
    }
    syncFileInput();
    renderFiles();
  }

  function summaryRow(label, content) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = content || "입력하지 않음";
    row.append(term, description);
    return row;
  }

  function updateReview() {
    reviewSummary.replaceChildren(
      summaryRow("학교", [value("schoolName"), value("schoolType")].filter(Boolean).join(" · ")),
      summaryRow("담당자", [value("contactName"), value("contactEmail"), value("contactPhone")].filter(Boolean).join(" · ")),
      summaryRow("학생 이메일", value("studentEmailDomain") ? `@${value("studentEmailDomain").replace(/^@+/, "")}` : ""),
      summaryRow("도입 희망 시기", value("desiredStart")),
      summaryRow("학교 전용 보고서", value("desiredReports")),
      summaryRow("첨부 자료", selectedFiles.length ? `${selectedFiles.length}개 · ${selectedFiles.map((file) => file.name).join(", ")}` : "첨부 없음"),
    );
  }

  document.querySelectorAll("[data-next-step]").forEach((button) => {
    button.addEventListener("click", () => {
      normalizeDomain();
      if (validateStep(currentStep)) showStep(button.dataset.nextStep);
    });
  });
  document.querySelectorAll("[data-prev-step]").forEach((button) => {
    button.addEventListener("click", () => showStep(button.dataset.prevStep));
  });
  document.querySelectorAll("[data-edit-step]").forEach((button) => {
    button.addEventListener("click", () => showStep(button.dataset.editStep));
  });

  form.addEventListener("input", (event) => {
    if (event.target?.id) setFieldError(event.target.id, "");
    formError.textContent = "";
  });
  field("studentEmailDomain")?.addEventListener("blur", normalizeDomain);

  document.querySelector("[data-file-trigger]")?.addEventListener("click", () => fileInput.click());
  ["dragenter", "dragover"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  });
  dropzone.addEventListener("drop", (event) => addFiles(event.dataTransfer?.files));
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    formError.textContent = "";
    normalizeDomain();
    const firstInvalidStep = [1, 2, 3].find((step) => !validateStep(step, false));
    if (firstInvalidStep) {
      showStep(firstInvalidStep, { focus: false });
      validateStep(firstInvalidStep, true);
      formError.textContent = "필수 입력 항목을 확인해 주세요.";
      return;
    }
    if (currentStep !== 3) {
      showStep(3);
      return;
    }

    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    const label = submitButton.querySelector("span");
    const previousLabel = label.textContent;
    label.textContent = "신청을 제출하는 중";
    try {
      const response = await fetch("/api/school-apply", {
        method: "POST",
        body: new FormData(form),
        headers: { accept: "application/json" },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) {
        throw new Error(data.error || "신청 접수에 실패했습니다. 잠시 후 다시 시도해 주세요.");
      }
      form.hidden = true;
      progress?.setAttribute("hidden", "");
      successPanel.hidden = false;
      successPanel.focus();
    } catch (error) {
      formError.textContent = error?.message || "네트워크 오류로 신청을 보내지 못했습니다. 연결을 확인해 주세요.";
      submitButton.disabled = false;
      submitButton.removeAttribute("aria-busy");
      label.textContent = previousLabel;
    }
  });

  showStep(1, { focus: false });
})();
