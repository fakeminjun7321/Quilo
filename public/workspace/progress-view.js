const STEP_ORDER = ["upload", "analysis", "document", "ready"];

export function createProgressView({ onClearRetry } = {}) {
  const progressArea = document.getElementById("progressArea");
  const progress = document.getElementById("progress");
  const result = document.getElementById("resultArea");
  const title = document.getElementById("statusTitle");
  let timer = null;
  let startedAt = 0;
  let estimate = null;
  let lastProgressAt = 0;

  function formatClock(seconds) {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
  }

  function normalizeEstimate(value) {
    if (Number.isFinite(value) && value > 0) return { lo: value, hi: value };
    if (!value || typeof value !== "object") return null;
    const lo = Number(value.lo);
    const hi = Number(value.hi);
    const safeLo = Number.isFinite(lo) && lo > 0 ? lo : null;
    const safeHi = Number.isFinite(hi) && hi > 0 ? hi : null;
    if (safeLo == null && safeHi == null) return null;
    return {
      lo: safeLo ?? safeHi,
      hi: Math.max(safeHi ?? safeLo, safeLo ?? safeHi),
    };
  }

  function etaPhrase(value) {
    const range = normalizeEstimate(value);
    if (!range) return "";
    const format = (seconds) => seconds < 90 ? `${Math.round(seconds)}초` : `${Math.round(seconds / 60)}분`;
    if (Math.abs(range.hi - range.lo) < 8) return `예상 ${format(range.hi)}`;
    return `예상 ${format(range.lo)}~${format(range.hi)}`;
  }

  function renderTimer() {
    const node = document.getElementById("genTimer");
    if (!node) return;
    const elapsed = (Date.now() - startedAt) / 1000;
    const eta = etaPhrase(estimate);
    const high = estimate?.hi || 0;
    const stalled = (Date.now() - (lastProgressAt || startedAt)) / 1000;
    const tail = high && elapsed > high + 8 ? " · 거의 다 됐어요" : stalled > 18 ? " · 계속 처리 중…" : "";
    node.textContent = `${eta ? `${eta} · ` : ""}경과 ${formatClock(elapsed)}${tail}`;
  }

  function startTimer(value) {
    stopTimer();
    startedAt = Date.now();
    lastProgressAt = startedAt;
    estimate = normalizeEstimate(value);
    const node = document.getElementById("genTimer");
    if (node) node.hidden = false;
    renderTimer();
    timer = setInterval(renderTimer, 1000);
  }

  function stopTimer(options = {}) {
    if (timer) clearInterval(timer);
    timer = null;
    const node = document.getElementById("genTimer");
    if (node && options.hide !== false) node.hidden = true;
  }

  function noteProgress() { lastProgressAt = Date.now(); }

  function resetSteps() {
    document.querySelectorAll("[data-progress-step]").forEach((node) => node.classList.remove("is-active", "is-done", "is-error"));
  }

  function setStep(step, state = "active") {
    const index = STEP_ORDER.indexOf(step);
    if (index < 0) return;
    document.querySelectorAll("[data-progress-step]").forEach((node) => {
      const current = STEP_ORDER.indexOf(node.dataset.progressStep);
      node.classList.toggle("is-done", state !== "error" && current >= 0 && current < index);
      node.classList.toggle("is-active", state !== "error" && current === index);
      node.classList.toggle("is-error", state === "error" && current === index);
    });
  }

  function inferStep(text) {
    const value = String(text || "").replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
    if (/오류|실패|중단|취소/.test(value)) return { step: "document", state: "error" };
    if (/^(?:완료|다운로드 (?:파일 )?준비 완료|파일 준비 완료)[.!…]*$/.test(value)) return { step: "ready", state: "active" };
    if (/AI|분석|모델|응답|JSON|파싱|보정|자료.*(?:읽|확인)|데이터.*(?:읽|확인)/i.test(value)) return { step: "analysis", state: "active" };
    if (/문서.*(?:생성|작성|빌드)|(?:DOCX|HWPX|PDF|ZIP).*?(?:생성|빌드|렌더|조판)|차트|그래프.*(?:생성|렌더)|파일.*(?:빌드|조판)/i.test(value)) return { step: "document", state: "active" };
    if (/업로드|첨부|입력.*(?:확인|검증)|파일.*(?:확인|검증|전송)/.test(value)) return { step: "upload", state: "active" };
    return null;
  }

  function conciseStatus(text, inferred) {
    const value = String(text || "");
    if (/재시도|재연결|연결.*복구|연결.*확인/.test(value)) return "연결 상태를 확인하며 계속 처리하고 있습니다.";
    if (/오류|실패/.test(value)) return "생성 중 문제가 발생했습니다. 아래 안내를 확인해 주세요.";
    if (/중단|취소|중지/.test(value)) return "생성을 중지하고 있습니다.";
    if (inferred?.step === "ready") return "다운로드 파일을 준비했습니다.";
    if (inferred?.step === "document") return "보고서 파일을 만들고 있습니다.";
    if (inferred?.step === "analysis") return "AI가 업로드한 자료를 분석하고 있습니다.";
    if (inferred?.step === "upload") return "업로드한 자료를 확인하고 있습니다.";
    return "요청을 안전하게 처리하고 있습니다.";
  }

  function begin(nextTitle, nextEstimate) {
    progressArea.hidden = false;
    progressArea.classList.remove("is-source-hidden");
    progress.replaceChildren();
    result.replaceChildren();
    onClearRetry?.();
    title.textContent = nextTitle || "생성 중...";
    const latest = document.getElementById("progressLatest");
    if (latest) latest.textContent = "생성을 시작합니다…";
    resetSteps();
    setStep("upload");
    startTimer(nextEstimate);
    progressArea.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function append(text) {
    const line = typeof text === "string" ? text : JSON.stringify(text);
    progress.append(document.createTextNode(`${line}\n`));
    progress.scrollTop = progress.scrollHeight;
    const latest = document.getElementById("progressLatest");
    const next = inferStep(line);
    if (latest && line.trim()) latest.textContent = conciseStatus(line, next);
    if (line.trim()) noteProgress();
    if (next) setStep(next.step, next.state);
  }

  return {
    begin,
    append,
    resetSteps,
    setStep,
    inferStep,
    startTimer,
    stopTimer,
    noteProgress,
  };
}
