import {
  WORKFLOW_STEPS,
  getReportWorkflow,
  modelCostLabel,
  requirementComplete,
  requirementDisplay,
  resolveWorkflowTarget,
  selectedModelValue,
  workflowStepForElement,
} from "../report-workflow.js";

export const $ = (id) => document.getElementById(id);
export const value = (id) => ($(id)?.value || "").trim();
export const file = (id) => $(id)?.files?.[0] || null;
export const files = (id) => Array.from($(id)?.files || []);
export const selected = (name, fallback = "") =>
  document.querySelector(`input[name="${name}"]:checked`)?.value ||
  document.querySelector(`input[name="${name}"]`)?.value || fallback;

export function appendFiles(formData, field, inputFiles) {
  inputFiles.forEach((entry) => formData.append(field, entry));
}

export function appendSlashDate(formData, field, rawDate) {
  if (!rawDate) return;
  const [year, month, day] = rawDate.split("-");
  formData.append(field, `${year}/ ${month} / ${day}`);
}

export function appendPolicy(formData) {
  formData.append("copyrightAccepted", "true");
  formData.append("academicIntegrityAccepted", "true");
  formData.append("policyAcceptedAt", new Date().toISOString());
}

export function sumBytes(entries) {
  return entries.reduce((sum, entry) => sum + (entry?.size || 0), 0);
}

export function createCommonFormsController({
  getModelLabel,
  formatBytes,
  setView,
  showTab,
  setPending,
  navigateReport,
  openLogin,
  reportChecklistItems,
}) {
  const radios = Array.from(document.querySelectorAll('input[name="reportType"]'));
  const forms = Array.from(document.querySelectorAll("[data-report-form]"));
  const comingSoon = $("comingSoon");
  const workflowNav = $("reportWorkflowNav");
  const checklist = $("reportChecklist");
  const checklistTitle = $("workspaceChecklistTitle");
  let activeObserver = null;
  let manualFlowLockUntil = 0;
  let sidebarTimer = null;
  let saveTimer = null;

  const currentType = () =>
    document.querySelector('input[name="reportType"]:checked')?.value || "";
  const currentForm = () => {
    const type = currentType();
    return type ? document.querySelector(`[data-report-form="${CSS.escape(type)}"]`) : null;
  };

  function workflowFor(type = currentType()) {
    return getReportWorkflow(type);
  }

  function setNavStep(stepName) {
    if (!workflowNav) return;
    workflowNav.querySelectorAll("[data-flow-jump]").forEach((button) => {
      const active = button.dataset.flowJump === stepName;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-current", active ? "step" : "false");
    });
  }

  function renderWorkflowNav(type) {
    const workflow = workflowFor(type);
    if (!workflowNav) return;
    workflowNav.hidden = !workflow;
    if (!workflow) return;
    WORKFLOW_STEPS.forEach((stepName, index) => {
      const button = workflowNav.querySelector(`[data-flow-jump="${stepName}"]`);
      const config = workflow.steps[stepName];
      if (!button || !config) return;
      const number = button.querySelector("[data-step-number]");
      const label = button.querySelector("[data-step-label]");
      const hint = button.querySelector("[data-step-hint]");
      if (number) number.textContent = String(index + 1);
      if (label) label.textContent = config.label;
      if (hint) hint.textContent = config.hint;
    });
    setNavStep("upload");
  }

  function updateReportChecklist(type) {
    if (!checklist || !checklistTitle) return;
    const workflow = workflowFor(type);
    const fallback = reportChecklistItems?.[type];
    checklistTitle.textContent = workflow?.title || fallback?.title || "보고서 종류를 선택하세요";
    checklist.replaceChildren();
    const requirements = workflow?.requirements || (fallback?.items || []).map((label) => ({ label }));
    requirements.forEach((requirement, index) => {
      const item = document.createElement("li");
      item.dataset.requirementIndex = String(index);
      item.dataset.baseText = requirement.label;
      item.dataset.flowTarget = requirement.step || "";
      const marker = document.createElement("span");
      marker.className = "chk-ico";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "checklist-copy";
      copy.textContent = requirement.label;
      const badge = document.createElement("span");
      badge.className = "checklist-badge";
      badge.textContent = requirement.required === false ? "선택" : "필수";
      item.append(marker, copy, badge);
      checklist.append(item);
    });
    scheduleSidebarRefresh();
  }

  function updateRecentInput(form, workflow) {
    const recent = $("workspaceRecentInput");
    if (!recent) return;
    recent.replaceChildren();
    if (!form || !workflow) {
      const empty = document.createElement("p");
      empty.className = "workspace-empty-copy";
      empty.textContent = "보고서를 선택하면 입력 상태가 표시됩니다.";
      recent.append(empty);
      return;
    }
    workflow.requirements.forEach((requirement) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const valueNode = document.createElement("strong");
      label.textContent = requirement.label;
      valueNode.textContent = requirementDisplay(form, requirement);
      valueNode.dataset.complete = requirementComplete(form, requirement) ? "true" : "false";
      row.append(label, valueNode);
      recent.append(row);
    });
  }

  function updateSubmitReadiness(form, workflow) {
    if (!form || !workflow) return;
    const requirementsReady = workflow.requirements
      .filter((requirement) => requirement.required !== false && requirement.step !== "generate")
      .every((requirement) => requirementComplete(form, requirement));
    const policy = form.querySelector(".policy-check input[type='checkbox']");
    const ready = requirementsReady && (!policy || policy.checked);
    form.querySelectorAll('button[type="submit"]').forEach((button) => {
      button.disabled = !ready;
      button.dataset.ready = ready ? "true" : "false";
      button.setAttribute("aria-disabled", String(!ready));
    });
  }

  function refreshSidebarState() {
    const type = currentType();
    const form = currentForm();
    const workflow = workflowFor(type);
    if (!form || !workflow) return;
    checklist?.querySelectorAll("li[data-requirement-index]").forEach((item) => {
      const requirement = workflow.requirements[Number(item.dataset.requirementIndex)];
      const done = requirementComplete(form, requirement);
      item.classList.toggle("chk-done", done);
      item.classList.toggle("chk-todo", !done && requirement?.required !== false);
      item.classList.toggle("chk-info", !done && requirement?.required === false);
      item.setAttribute("aria-label", `${requirement?.label || "항목"}: ${done ? "완료" : requirement?.required === false ? "선택" : "필수"}`);
    });
    updateRecentInput(form, workflow);
    if ($("workspaceEstimateTime")) $("workspaceEstimateTime").textContent = workflow.time || "약 2–4분";
    if ($("workspaceEstimateCost")) {
      $("workspaceEstimateCost").textContent = workflow.cost || modelCostLabel(selectedModelValue(form));
    }
    updateSubmitReadiness(form, workflow);
  }

  function scheduleSidebarRefresh(delay = 0) {
    clearTimeout(sidebarTimer);
    sidebarTimer = setTimeout(refreshSidebarState, delay);
  }

  function noteAutosave() {
    const state = $("workspaceSaveState");
    const time = $("workspaceSaveTime");
    if (state) state.textContent = "저장 중…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (state) state.textContent = "저장됨";
      if (time) time.textContent = new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    }, 520);
  }

  function setFlowStep(form, stepName = "upload", options = {}) {
    if (!form) return;
    const workflow = workflowFor(form.dataset.reportForm);
    if (!workflow || !WORKFLOW_STEPS.includes(stepName)) return;
    form.dataset.flowStep = stepName;
    setNavStep(stepName);
    if (options.scroll) {
      // A workflow-nav click starts a smooth scroll. During that animation the
      // observer can briefly report the old section and overwrite the step the
      // user just chose. Keep the explicit choice authoritative until the
      // programmatic scroll has settled; later manual scrolling still updates it.
      manualFlowLockUntil = Date.now() + 800;
      const target = resolveWorkflowTarget(form, workflow, stepName);
      try { (target || form).scrollIntoView({ behavior: "smooth", block: "start" }); }
      catch (_) { (target || form).scrollIntoView(); }
    }
  }

  function connectActiveObserver(form) {
    activeObserver?.disconnect();
    activeObserver = null;
    const workflow = workflowFor(form?.dataset.reportForm);
    if (!form || !workflow || !("IntersectionObserver" in window)) return;
    const targets = WORKFLOW_STEPS.map((stepName) => ({
      stepName,
      node: resolveWorkflowTarget(form, workflow, stepName),
    })).filter(({ node }, index, list) => node && list.findIndex((entry) => entry.node === node) === index);
    activeObserver = new IntersectionObserver((entries) => {
      if (Date.now() < manualFlowLockUntil) return;
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!visible) return;
      const match = targets.find(({ node }) => node === visible.target);
      if (match && !form.hidden) setFlowStep(form, match.stepName);
    }, { rootMargin: "-170px 0px -62% 0px", threshold: [0, 0.08, 0.35] });
    targets.forEach(({ node, stepName }) => {
      node.dataset.workflowAnchor = stepName;
      activeObserver.observe(node);
    });
  }

  function bindFormWorkflow(form) {
    const workflow = workflowFor(form.dataset.reportForm);
    if (!workflow || form.dataset.workflowBound) return;
    form.dataset.workflowBound = "1";
    form.addEventListener("focusin", (event) => {
      const flowStep = workflowStepForElement(form, workflow, event.target);
      if (flowStep) setFlowStep(form, flowStep);
    });
    form.addEventListener("invalid", (event) => {
      const flowStep = workflowStepForElement(form, workflow, event.target) || "upload";
      setFlowStep(form, flowStep, { scroll: true });
    }, true);
    form.addEventListener("input", () => {
      noteAutosave();
      scheduleSidebarRefresh(0);
    });
    form.addEventListener("change", () => {
      noteAutosave();
      scheduleSidebarRefresh(0);
    });
    form.querySelectorAll('button[type="submit"]').forEach((button) => {
      button.addEventListener("click", () => setFlowStep(form, "generate"));
    });
    updateSubmitReadiness(form, workflow);
  }

  function updateOptionalSummary() {
    scheduleSidebarRefresh();
  }

  function updateAllOptionalSummaries() {
    scheduleSidebarRefresh();
  }

  function updateReportTypeView(options = {}) {
    const selectedType = currentType();
    const selectedWorkflow = workflowFor(selectedType);
    const reportPanel = $("reportsPanel");
    const authenticated = document.body.dataset.auth !== "out";
    reportPanel?.classList.toggle("workspace-mode", !!selectedType && authenticated);
    if (selectedType && document.body.dataset.auth === "in") setView("workspace");

    let matched = false;
    let activeForm = null;
    forms.forEach((form) => {
      const active = form.dataset.reportForm === selectedType;
      form.classList.toggle("active", active);
      form.hidden = !active;
      if (active) activeForm = form;
      matched ||= active;
    });
    if (comingSoon) comingSoon.hidden = !selectedType || matched;
    if ($("workspaceSummary")) $("workspaceSummary").hidden = !matched;
    renderWorkflowNav(selectedType);
    updateReportChecklist(selectedType);
    if ($("workspaceTitle")) $("workspaceTitle").textContent = selectedWorkflow?.title || "보고서 작업 공간";
    if ($("workspaceDescription")) {
      $("workspaceDescription").textContent = selectedWorkflow?.description || "자료를 올리고 필요한 정보를 확인하면 생성 과정과 결과를 한 화면에서 관리할 수 있습니다.";
    }
    if (!selectedType) return;
    if (activeForm) {
      setFlowStep(activeForm, "upload");
      connectActiveObserver(activeForm);
      scheduleSidebarRefresh();
    }
    if (options.scroll) {
      const target = matched ? workflowNav || activeForm : comingSoon;
      try { target?.scrollIntoView({ behavior: "smooth", block: "start" }); }
      catch (_) {}
    }
    const dateId = selectedType === "chem-result" ? "crDate" : selectedType === "phys-result" ? "prDate" : "";
    if (dateId && !$(dateId)?.value) $(dateId).value = new Date().toISOString().slice(0, 10);
  }

  function initDropzones(maxFileMb = 64) {
    document.querySelectorAll(".dropzone").forEach((zone) => {
      const input = zone.querySelector('input[type="file"]');
      if (!input || zone.dataset.dzInit) return;
      zone.dataset.dzInit = "1";
      const label = zone.querySelector("[data-dz-file]");
      const render = () => {
        const selectedFiles = Array.from(input.files || []);
        zone.classList.toggle("is-filled", !!selectedFiles.length);
        if (label) {
          label.textContent = selectedFiles.length === 1
            ? selectedFiles[0].name
            : selectedFiles.length ? `${selectedFiles.length}개 파일 선택됨` : "";
        }
        let warning = zone.nextElementSibling?.classList.contains("dropzone-warn") ? zone.nextElementSibling : null;
        const tooBig = selectedFiles.some((entry) => entry.size > maxFileMb * 1024 * 1024);
        if (tooBig && !warning) {
          warning = document.createElement("div");
          warning.className = "dropzone-warn";
          zone.after(warning);
        }
        if (warning) {
          warning.hidden = !tooBig;
          warning.textContent = tooBig
            ? `파일당 최대 ${maxFileMb}MB입니다. 선택 파일을 줄여 주세요. (${formatBytes(selectedFiles.reduce((sum, entry) => sum + entry.size, 0))})`
            : "";
        }
      };
      input.addEventListener("change", render);
      ["dragenter", "dragover"].forEach((name) => zone.addEventListener(name, () => zone.classList.add("is-dragover")));
      ["dragleave", "dragend", "drop"].forEach((name) => zone.addEventListener(name, () => zone.classList.remove("is-dragover")));
      render();
    });
  }

  function slimMemoSections() {
    document.querySelectorAll(".field.user-notes-field").forEach((field) => {
      if (field.dataset.memoSlim) return;
      field.dataset.memoSlim = "1";
      const label = field.querySelector(".field-label");
      if (label) label.textContent = label.textContent.replace(/\(선택\)\s*$/, "(선택 · 안 써도 됩니다)");
    });
  }

  function syncGenerationSummary() {
    const title = $("statusTitle")?.textContent?.trim() || "";
    const progressArea = $("progressArea");
    const state = $("workspaceGenerationState");
    if (!state) return;
    const visible = !!progressArea && !progressArea.hidden && !progressArea.classList.contains("is-source-hidden");
    if (!visible) {
      state.textContent = "준비 대기";
      state.dataset.tone = "muted";
      return;
    }
    state.textContent = title || "생성 중";
    state.dataset.tone = /완료/.test(title) ? "success" : /오류|실패|중단/.test(title) ? "danger" : "progress";
  }

  function initGenerationSummary() {
    const title = $("statusTitle");
    const progressArea = $("progressArea");
    if (title) new MutationObserver(syncGenerationSummary).observe(title, { childList: true, subtree: true });
    if (progressArea) new MutationObserver(syncGenerationSummary).observe(progressArea, { attributes: true, attributeFilter: ["hidden", "class"] });
    syncGenerationSummary();
  }

  function clearCurrentInputs() {
    const form = currentForm();
    if (!form) return;
    if (!window.confirm("현재 보고서에 입력한 내용을 모두 지울까요? 업로드한 파일 선택도 해제됩니다.")) return;
    form.reset();
    form.querySelectorAll("input, select, textarea").forEach((control) => {
      control.dispatchEvent(new Event(control.type === "file" ? "change" : "input", { bubbles: true }));
    });
    setFlowStep(form, "upload", { scroll: true });
    scheduleSidebarRefresh();
  }

  function initFilesSummary() {
    const summary = $("workspaceFilesSummary");
    const empty = document.querySelector(".workspace-file-empty");
    if (!summary || !empty) return;
    const sync = () => {
      const copy = summary.textContent || "";
      empty.hidden = /\d+\s*\/|\d+개 파일/.test(copy) && !/없/.test(copy);
    };
    new MutationObserver(sync).observe(summary, { childList: true, subtree: true });
    sync();
  }

  function init() {
    forms.forEach(bindFormWorkflow);
    updateReportChecklist("");
    workflowNav?.querySelectorAll("[data-flow-jump]").forEach((button) => {
      button.addEventListener("click", () => setFlowStep(currentForm(), button.dataset.flowJump, { scroll: true }));
    });
    $("workspaceRecentClear")?.addEventListener("click", clearCurrentInputs);
    radios.forEach((radio) => radio.addEventListener("change", () => {
      if (document.body.dataset.auth === "out") {
        setPending(radio.value);
        radio.checked = false;
        openLogin();
        return;
      }
      navigateReport?.(radio.value, "push");
      updateReportTypeView({ scroll: true });
    }));
    updateReportTypeView();
    initDropzones();
    slimMemoSections();
    initGenerationSummary();
    initFilesSummary();
    setTimeout(refreshSidebarState, 0);
  }

  return {
    init,
    setFlowStep,
    updateReportTypeView,
    updateReportChecklist,
    updateOptionalSummary,
    updateAllOptionalSummaries,
    initDropzones,
    slimMemoSections,
  };
}
