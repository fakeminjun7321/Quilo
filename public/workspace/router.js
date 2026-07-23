import { REPORT_ALIASES, isRetiredReport } from "./report-registry.js";

const PENDING_REPORT_KEY = "pendingReportType";

export function createRouter({ state, hooks }) {
  function writeReportUrl(type, mode = "push") {
    const reportType = String(type || "");
    if (!reportType || isRetiredReport(reportType)) return;
    state.set({ reportType });
    const target = new URL("/", location.origin);
    target.searchParams.set("report", reportType);
    const next = `${target.pathname}${target.search}`;
    const current = `${location.pathname}${location.search}${location.hash}`;
    if (current === next || mode === false || mode === "none") return;
    try {
      history[mode === "replace" ? "replaceState" : "pushState"]({}, "", next);
    } catch (_) {}
  }

  function setPending(type) {
    try {
      if (type && !isRetiredReport(type)) sessionStorage.setItem(PENDING_REPORT_KEY, String(type));
      else sessionStorage.removeItem(PENDING_REPORT_KEY);
    } catch (_) {}
  }

  function takePending() {
    let type = "";
    try {
      type = sessionStorage.getItem(PENDING_REPORT_KEY) || "";
      if (type) sessionStorage.removeItem(PENDING_REPORT_KEY);
    } catch (_) {}
    return type;
  }

  function select(type, options = {}) {
    const key = String(type || "");
    if (isRetiredReport(key)) return false;
    const alias = Object.prototype.hasOwnProperty.call(REPORT_ALIASES, key) ? REPORT_ALIASES[key] : null;
    const radio = document.querySelector(`input[name="reportType"][value="${CSS.escape(alias ? alias.base : key)}"]`);
    if (!radio || radio.disabled || radio.closest("label")?.hidden) return false;
    radio.checked = true;
    // 별칭 선택은 URL·state에 별칭 id를 남겨 새로고침해도 하위 모드가 복원되게 한다.
    writeReportUrl(alias ? key : radio.value, options.history ?? "push");
    if (alias?.mode) {
      const form = document.querySelector(`form[data-report-form="${CSS.escape(radio.value)}"]`);
      const modeRadio = (form || document).querySelector(
        `input[name="${CSS.escape(alias.mode.name)}"][value="${CSS.escape(alias.mode.value)}"]`,
      );
      if (modeRadio && !modeRadio.disabled) {
        modeRadio.checked = true;
        // 폼 런타임 설치 전엔 설치 시점 초기화(rlSetMode)가 checked 상태를 읽고,
        // 설치 후엔 change 리스너가 즉시 반응한다. 모드 라디오가 없으면 base 단일 모드로 연다.
        modeRadio.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (hooks.selectReport) hooks.selectReport(radio.value, options);
    else hooks.ensureReportRuntime?.().then(() => hooks.selectReport?.(radio.value, options));
    return true;
  }

  function consumePending(options = {}) {
    if (state.get().auth !== "in") return false;
    const type = takePending();
    return type ? select(type, options) : false;
  }

  function requestedReport() {
    try {
      const type = new URLSearchParams(location.search).get("report") || "";
      return isRetiredReport(type) ? "" : type;
    }
    catch (_) { return ""; }
  }

  return { setPending, takePending, consumePending, requestedReport, select, writeReportUrl };
}
