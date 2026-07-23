"use strict";

(function secureVocabularyViewer() {
  const canvas = document.querySelector("[data-page-canvas]");
  const paper = document.querySelector("[data-paper]");
  const status = document.querySelector("[data-viewer-status]");
  const pageInput = document.querySelector("[data-page-input]");
  const pageCountEl = document.querySelector("[data-page-count]");
  const zoomOutput = document.querySelector("[data-zoom-output]");
  const expiry = document.querySelector("[data-session-expiry]");
  const shield = document.querySelector("[data-privacy-shield]");
  const state = { token: "", page: 1, pageCount: 290, zoom: 1, loading: false, requestId: 0 };

  function setStatus(message, tone = "") {
    status.textContent = message;
    status.dataset.tone = tone;
    status.hidden = !message;
  }

  function clampPage(value) {
    return Math.max(1, Math.min(state.pageCount, Number.parseInt(value, 10) || 1));
  }

  function applyZoom() {
    paper.style.transform = `scale(${state.zoom})`;
    paper.style.marginBottom = `${Math.max(0, paper.offsetHeight * (state.zoom - 1))}px`;
    zoomOutput.value = `${Math.round(state.zoom * 100)}%`;
    zoomOutput.textContent = zoomOutput.value;
  }

  async function beginSession() {
    const response = await fetch("/api/examples/vocabulary/session", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json", "x-quilo-viewer": "secure-vocabulary" },
    });
    if (response.status === 401) {
      location.assign(`/login.html?next=${encodeURIComponent(location.pathname)}`);
      return false;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "읽기 세션을 시작하지 못했습니다.");
    state.token = data.session;
    state.pageCount = data.example.pageCount;
    pageCountEl.textContent = String(state.pageCount);
    const remaining = Math.max(1, Math.round((new Date(data.expiresAt).getTime() - Date.now()) / 60_000));
    expiry.textContent = `${remaining}분 뒤 만료 · 만료 시 다시 확인합니다.`;
    return true;
  }

  async function renderPage(page) {
    if (!state.token || state.loading) return;
    state.loading = true;
    const requestId = ++state.requestId;
    const target = clampPage(page);
    paper.hidden = true;
    setStatus(`${target}페이지를 안전하게 불러오는 중…`);
    try {
      const response = await fetch(`/api/examples/vocabulary/page/${target}`, {
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          accept: "image/jpeg",
          "x-quilo-viewer": "secure-vocabulary",
          "x-vocabulary-viewer-session": state.token,
        },
      });
      if (response.status === 401) {
        state.token = "";
        if (await beginSession()) return renderPage(target);
        return;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "페이지를 불러오지 못했습니다.");
      }
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);
      if (requestId !== state.requestId) return bitmap.close();
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      state.page = target;
      pageInput.value = String(target);
      canvas.setAttribute("aria-label", `단어장 예시 ${target}페이지`);
      setStatus("");
      paper.hidden = false;
      applyZoom();
    } catch (error) {
      setStatus(error.message || "페이지를 불러오지 못했습니다.", "danger");
    } finally {
      state.loading = false;
    }
  }

  document.querySelectorAll("[data-page-action]").forEach((button) => {
    button.addEventListener("click", () => renderPage(state.page + (button.dataset.pageAction === "next" ? 1 : -1)));
  });
  document.querySelectorAll("[data-zoom-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.dataset.zoomAction === "in" ? 0.1 : -0.1;
      state.zoom = Math.max(0.7, Math.min(1.6, Math.round((state.zoom + direction) * 10) / 10));
      applyZoom();
    });
  });
  pageInput.addEventListener("change", () => renderPage(pageInput.value));
  pageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); renderPage(pageInput.value); }
  });

  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("copy", (event) => event.preventDefault());
  document.addEventListener("dragstart", (event) => event.preventDefault());
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && ["p", "s", "u", "c"].includes(event.key.toLowerCase())) {
      event.preventDefault();
    }
  });
  window.addEventListener("beforeprint", (event) => event.preventDefault());
  function updateShield() {
    shield.hidden = document.visibilityState === "visible" && document.hasFocus();
  }
  document.addEventListener("visibilitychange", updateShield);
  window.addEventListener("blur", updateShield);
  window.addEventListener("focus", updateShield);

  beginSession()
    .then((ok) => ok && renderPage(1))
    .catch((error) => setStatus(error.message || "읽기 세션을 시작하지 못했습니다.", "danger"));
})();
