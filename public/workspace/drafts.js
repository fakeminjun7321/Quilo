const PREFIX = "quiloDraft:v1:";
const FIELDS = Object.freeze({
  "chem-pre": ["preUserNotes", "cpStyleNote"],
  "chem-result": ["crUserNotes", "crStyleNote"],
  "phys-result": ["prUserNotes", "prStyleNote"],
  free: ["frInstructions", "frGrading", "frTitle", "frRefLinks", "frUserNotes", "frStyleNote"],
  "phys-inquiry": ["piTopic", "piRefLinks", "piUserNotes", "piStyleNote"],
  "math-inquiry": ["miTopic", "miUserNotes", "miStyleNote"],
  "problem-set": ["psUserNotes"],
  "form-maker": ["fmInstructions", "fmUserNotes"],
});

export function createDraftController() {
  const timers = new Map();
  const key = (type) => `${PREFIX}${type}`;
  const currentType = () => document.querySelector('input[name="reportType"]:checked')?.value || "";

  function collect(type) {
    const values = {};
    (FIELDS[type] || []).forEach((id) => {
      const node = document.getElementById(id);
      if (node?.value.trim()) values[id] = node.value;
    });
    return values;
  }

  function save(type) {
    const values = collect(type);
    try {
      if (Object.keys(values).length) localStorage.setItem(key(type), JSON.stringify({ savedAt: Date.now(), values }));
      else localStorage.removeItem(key(type));
    } catch (_) {}
  }

  function read(type) {
    try { return JSON.parse(localStorage.getItem(key(type)) || "null"); }
    catch (_) { return null; }
  }

  function clear(type) {
    try { localStorage.removeItem(key(type)); } catch (_) {}
    document.querySelector(`[data-draft-banner="${CSS.escape(type)}"]`)?.remove();
  }

  function restore(type) {
    const draft = read(type);
    if (!draft?.values) return;
    Object.entries(draft.values).forEach(([id, text]) => {
      const field = document.getElementById(id);
      if (field && !field.value.trim()) {
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    clear(type);
  }

  function ensureBanner(type) {
    const draft = read(type);
    const form = document.querySelector(`[data-report-form="${CSS.escape(type)}"]`);
    if (!draft?.values || !form || form.querySelector("[data-draft-banner]")) return;
    const banner = document.createElement("div");
    banner.className = "draft-banner";
    banner.dataset.draftBanner = type;
    const copy = document.createElement("span");
    copy.textContent = "이전에 작성하던 내용이 있습니다.";
    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.className = "secondary compact";
    restoreButton.textContent = "불러오기";
    restoreButton.addEventListener("click", () => restore(type));
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "link-button";
    discardButton.textContent = "삭제";
    discardButton.addEventListener("click", () => clear(type));
    banner.append(copy, restoreButton, discardButton);
    form.prepend(banner);
  }

  function init() {
    document.querySelectorAll("[data-report-form]").forEach((form) => {
      const type = form.dataset.reportForm;
      (FIELDS[type] || []).forEach((id) => {
        document.getElementById(id)?.addEventListener("input", () => {
          clearTimeout(timers.get(type));
          timers.set(type, setTimeout(() => save(type), 450));
        });
      });
    });
    document.querySelectorAll('input[name="reportType"]').forEach((radio) => radio.addEventListener("change", () => ensureBanner(radio.value)));
    window.addEventListener("beforeunload", (event) => {
      const type = currentType();
      if (!type || !Object.keys(collect(type)).length) return;
      event.preventDefault();
      event.returnValue = "";
    });
    const status = document.getElementById("statusTitle");
    if (status) new MutationObserver(() => { if (status.textContent.trim() === "완료") clear(currentType()); }).observe(status, { childList: true, subtree: true });
    const type = currentType();
    if (type) ensureBanner(type);
  }

  return { init, clear, restore, ensureBanner };
}
