const LAST_PREFS_KEY = "lastReportPrefs";

function readJsonPreference(key) {
  try { return JSON.parse(localStorage.getItem(key) || "{}") || {}; }
  catch (_) { return {}; }
}

export function createReportPreferences({ updateOptionalSummaries } = {}) {
  let pending = null;

  function saveLast(p) {
    if (!p) return;
    try {
      const clean = {};
      ["type", "model", "format", "fontFace"].forEach((key) => {
        if (p[key]) clean[key] = String(p[key]);
      });
      localStorage.setItem(LAST_PREFS_KEY, JSON.stringify(clean));
    } catch (_) { /* localStorage can be unavailable in private contexts */ }
  }

  function capture(formData) {
    try {
      pending = {
        type: formData.get("type") || "",
        model: formData.get("model") || "",
        format: formData.get("format") || "",
        fontFace: formData.get("fontFace") || "",
      };
    } catch (_) { pending = null; }
  }

  function commit() {
    if (pending) saveLast(pending);
  }

  function restoreLast() {
    const p = readJsonPreference(LAST_PREFS_KEY);
    if (!Object.keys(p).length) return;
    try {
      if (p.model) {
        document
          .querySelectorAll('input[type="radio"][name$="odel"], input[type="radio"][name="model"]')
          .forEach((radio) => {
            const name = radio.name || "";
            if (!/^model$|Model$/.test(name)) return;
            if (radio.value !== p.model || radio.disabled) return;
            const label = radio.closest("label");
            if (label && (label.hidden || getComputedStyle(label).display === "none")) return;
            radio.checked = true;
          });
      }
      if (p.format) {
        document
          .querySelectorAll('input[name="format"], input[name="crFormat"], input[name="prFormat"], input[name="frFormat"], input[name="piFormat"], input[name="miFormat"]')
          .forEach((radio) => {
            if (radio.value === p.format && !radio.disabled) radio.checked = true;
          });
      }
      if (p.fontFace) {
        ["fontFace", "crFontFace", "prFontFace", "frFontFace", "piFontFace", "miFontFace"].forEach((id) => {
          const select = document.getElementById(id);
          if (select && [...select.options].some((option) => option.value === p.fontFace && !option.disabled && !option.hidden)) {
            select.value = p.fontFace;
          }
        });
      }
      updateOptionalSummaries?.();
    } catch (_) { /* restoring a preference must never block the form */ }
  }

  return {
    capture,
    commit,
    restoreLast,
    get pending() { return pending; },
  };
}

export function initDefaultReportPreferences() {
  const modelSelect = document.getElementById("prefModelSel");
  const styleSelect = document.getElementById("prefStyleSel");
  const status = document.getElementById("prefSaveStatus");
  if (!modelSelect || !styleSelect) return { apply() {} };
  if (modelSelect.dataset.preferenceInit === "1") {
    return { apply: () => window.applyPrefsToForm?.() };
  }
  modelSelect.dataset.preferenceInit = "1";

  const get = (key) => {
    try { return localStorage.getItem(key) || ""; }
    catch (_) { return ""; }
  };
  const set = (key, value) => {
    try {
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
    } catch (_) { /* ignore storage restrictions */ }
  };
  const apply = () => {
    const model = get("prefModel");
    const style = get("prefStyle");
    if (model) {
      document
        .querySelectorAll('input[type="radio"][name="model"], input[type="radio"][name$="Model"]')
        .forEach((radio) => {
          const label = radio.closest("label");
          if (
            radio.value === model &&
            !radio.checked &&
            !radio.disabled &&
            (!label || (!label.hidden && getComputedStyle(label).display !== "none"))
          ) {
            radio.checked = true;
            radio.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
    }
    if (style) {
      document.querySelectorAll('input[name="style"]').forEach((radio) => {
        if (radio.value === style && !radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    }
  };
  const flash = (message) => {
    if (!status) return;
    status.dataset.tone = "success";
    status.textContent = message;
    window.setTimeout(() => { status.textContent = ""; }, 1800);
  };

  modelSelect.value = get("prefModel");
  styleSelect.value = get("prefStyle");
  modelSelect.addEventListener("change", () => {
    set("prefModel", modelSelect.value);
    apply();
    flash("기본 모델 저장됨");
  });
  styleSelect.addEventListener("change", () => {
    set("prefStyle", styleSelect.value);
    apply();
    flash("기본 양식 저장됨");
  });
  window.applyPrefsToForm = apply;
  apply();
  return { apply };
}
