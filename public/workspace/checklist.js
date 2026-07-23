function hasFile(id) { return !!document.getElementById(id)?.files?.length; }
function hasText(id) { return !!document.getElementById(id)?.value.trim(); }

export function createChecklistController({ getStudentId, setFlowStep, showTab }) {
  const currentType = () => document.querySelector('input[name="reportType"]:checked')?.value || "";

  function status(type, text) {
    if (type === "chem-pre") {
      if (/매뉴얼/.test(text)) return [hasFile("manual"), "upload"];
      if (/날짜/.test(text)) return [hasText("date"), "info"];
    }
    if (type === "chem-result") {
      if (/사전보고서/.test(text)) return [hasFile("crPreReport"), "upload"];
      if (/데이터 또는 사진/.test(text)) return [hasFile("crData") || hasFile("crPhotos") || hasText("crUserNotes"), "upload"];
      if (/날짜/.test(text)) return [hasText("crDate"), "info"];
    }
    if (type === "phys-result") {
      if (/\.cap|엑셀|CSV|텍스트/.test(text)) return [hasFile("prCap") || hasFile("prData") || hasFile("prPhotos"), "upload"];
      if (/사진|그래프/.test(text)) return [hasFile("prPhotos"), "upload", true];
      if (/학번/.test(text)) return [!!getStudentId(), "studentId"];
      if (/날짜/.test(text)) return [hasText("prDate"), "info"];
    }
    if (type === "free") {
      if (/작성 지시/.test(text)) return [hasText("frInstructions"), "upload"];
      if (/필요 자료/.test(text)) return [hasFile("frFiles") || hasFile("frPhotos") || hasText("frRefLinks"), "upload", true];
    }
    return [null, ""];
  }

  function jump(type, target) {
    if (target === "studentId") {
      showTab("settings");
      document.getElementById("settingsStudentIdInput")?.focus();
      return;
    }
    const form = document.querySelector(`[data-report-form="${CSS.escape(type)}"]`);
    if (form && target) setFlowStep(form, target, { scroll: true });
  }

  function decorate() {
    const type = currentType();
    const list = document.getElementById("reportChecklist");
    if (!type || !list) return;
    list.querySelectorAll("li").forEach((item) => {
      const text = item.dataset.baseText || item.textContent;
      item.dataset.baseText = text;
      const [done, target, optional] = status(type, text);
      item.classList.remove("chk-done", "chk-todo", "chk-info");
      item.classList.add(done === true ? "chk-done" : done === false ? "chk-todo" : "chk-info");
      let icon = item.querySelector(".chk-ico");
      if (!icon) { icon = document.createElement("span"); icon.className = "chk-ico"; icon.setAttribute("aria-hidden", "true"); item.prepend(icon); }
      icon.textContent = done === true ? "✓" : done === false ? optional ? "○" : "•" : "·";
      if (target && !item.dataset.checklistBound) {
        item.dataset.checklistBound = "1";
        item.classList.add("checklist-action");
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        item.addEventListener("click", () => jump(type, target));
        item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(type, target); } });
      }
    });
  }

  function init() {
    document.querySelectorAll("[data-report-form]").forEach((form) => {
      form.addEventListener("input", decorate);
      form.addEventListener("change", decorate);
    });
    document.querySelectorAll('input[name="reportType"]').forEach((radio) => radio.addEventListener("change", () => setTimeout(decorate, 0)));
    const list = document.getElementById("reportChecklist");
    if (list) new MutationObserver(() => queueMicrotask(decorate)).observe(list, { childList: true });
    decorate();
  }

  return { init, decorate };
}
