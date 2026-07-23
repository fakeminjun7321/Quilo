export function createResultView({ appendLine, getLastSubmission, retryLastSubmission }) {
  function clearRetryCard() {
    const card = document.getElementById("retryCard");
    if (card) { card.hidden = true; card.replaceChildren(); }
  }

  function showGenerationError(options = {}) {
    const card = document.getElementById("retryCard");
    if (!card) return appendLine(`오류: ${options.message || "생성이 중단되었습니다."}`);
    card.replaceChildren();
    card.hidden = false;
    const inputError = options.httpStatus === 400;
    const creditError = options.httpStatus === 402 || /크레딧|credit|잔액|충전/i.test(options.message || "");
    const headline = inputError
      ? "입력을 확인해 주세요 · 빠진 항목을 채운 뒤 다시 시도하세요"
      : creditError
        ? "크레딧이 부족합니다 · 더 저렴한 모델로 바꾸거나 충전 후 다시 시도하세요"
        : "생성이 중단됐어요 · 크레딧은 차감되지 않았고 입력은 그대로예요";
    const head = document.createElement("div");
    head.className = "retry-headline";
    head.textContent = headline;
    card.append(head);
    const actions = document.createElement("div");
    actions.className = "retry-actions";
    const last = getLastSubmission();
    if (options.allowRetry !== false && last?.formData) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "primary";
      retry.textContent = "다시 생성";
      retry.addEventListener("click", () => { clearRetryCard(); retryLastSubmission(); });
      actions.append(retry);
    }
    if (creditError || inputError) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "secondary";
      back.textContent = creditError ? "모델 바꾸기" : "폼으로 이동";
      back.addEventListener("click", () => (options.scrollToForm || last?.formEl || document.getElementById("reportsPanel"))?.scrollIntoView({ behavior: "smooth", block: "start" }));
      actions.append(back);
    }
    if (creditError) {
      const link = document.createElement("a");
      link.className = "retry-link";
      link.href = "/community.html";
      link.textContent = "크레딧 문의 →";
      actions.append(link);
    }
    if (actions.childNodes.length) card.append(actions);
    const detail = String(options.detail || options.message || "").trim();
    if (detail) {
      const disclosure = document.createElement("details");
      disclosure.className = "retry-detail";
      const summary = document.createElement("summary");
      summary.textContent = "자세한 원인 보기";
      const body = document.createElement("div");
      body.className = "retry-detail-body";
      body.textContent = detail;
      disclosure.append(summary, body);
      card.append(disclosure);
    }
    (inputError && options.scrollToForm ? options.scrollToForm : card).scrollIntoView({ behavior: "smooth", block: inputError ? "start" : "nearest" });
  }

  return { clearRetryCard, showGenerationError };
}
