import { loadChatCapabilities, sendChatFeedback, streamChatResponse } from "./api.js";
import { setupVoiceInput } from "./voice.js";
import {
  addAssistantRow,
  addUserRow,
  createChatView,
  element,
  renderSuggestionChips,
  resetComposer,
} from "./view.js";

const HELP_GREETING =
  "안녕하세요! Quilo 사용을 도와드리는 AI예요. 보고서 작성·기능·크레딧 등 궁금한 걸 물어보세요.";
const HELP_SUGGESTIONS = [
  "사전보고서랑 결과보고서 차이가 뭐야?",
  "HWPX 파일이 안 열려요",
  "크레딧은 어떻게 충전해요?",
];
const HOME_IDLE_SUGGESTIONS = ["보고서", "탐구·리서치", "데이터 분석", "API 플랫폼", "앱"];
const MEMO_GREETING =
  "실험 내용을 알려주시면 보고서에 넣을 'AI 참고 메모' 초안을 만들어드려요. 무엇을 측정했고, 어떤 결과·경향이었나요? 특이사항이 있었나요?";
const MEMO_SUGGESTIONS = [
  "오늘 한 실험을 설명할게",
  "측정값이 이론값과 달랐어",
  "실험 중 특이사항이 있었어",
];
const STYLE_GREETING =
  "내 글 '문체'를 정리해드려요. 평소 어떻게 쓰는지(말투·설명 방식·소제목·수식 표기 등)를 알려주시거나, 예전에 쓴 글을 붙여넣어 주세요. '스타일 메모'로 정리해드릴게요.";
const STYLE_SUGGESTIONS = [
  "영어 소제목 + 구어체로 직관 먼저 쓰는 스타일이야",
  "예전에 쓴 글을 붙여넣을게",
  "사람들이 헷갈리는 지점을 짚는 편이야",
];
const DEFAULT_PLACEHOLDER = "메시지를 입력하세요…";
const INLINE_PLACEHOLDER = "Quilo 기능과 사용법을 물어보세요";
const CHAT_STORAGE_KEY = "quiloChat:v2";
const CHAT_STORAGE_TTL_MS = 2 * 60 * 60 * 1000;

let initializationPromise;

function reportTypeFromTarget(id) {
  const target = String(id || "");
  if (target.startsWith("pre")) return "chem-pre";
  if (target.startsWith("cr")) return "chem-result";
  if (target.startsWith("pr")) return "phys-result";
  if (target.startsWith("pi")) return "phys-inquiry";
  if (target.startsWith("mi")) return "math-inquiry";
  return "";
}

function extractMemo(text = "") {
  for (const marker of ["메모 초안", "스타일 메모"]) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    const extracted = text
      .slice(index)
      .replace(/^(메모\s*초안|스타일\s*메모)\s*[:：]?\s*/, "")
      .trim();
    return extracted || text.trim();
  }
  return text.trim();
}

function createChatController() {
  let messages = [];
  let busy = false;
  let openedOnce = false;
  let currentMode = "help";
  let memoTarget = null;
  let memoReportType = "";
  let helpEnabled = false;
  let writeAssistEnabled = false;
  let models = [];
  let selectedModel = null;
  let view = null;

  const isAssist = () => currentMode === "memo" || currentMode === "style";
  const isHomeInlineIdle = () =>
    Boolean(
      currentMode === "help" &&
        view?.panel.classList.contains("qc-inline") &&
        view.panel.classList.contains("qc-idle"),
    );

  function pageContext() {
    try {
      return `${document.title || "Quilo"} (${location.pathname})`;
    } catch (_) {
      return "";
    }
  }

  function saveConversation() {
    try {
      sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        m: messages,
        mode: currentMode,
        savedAt: Date.now(),
        surface: view?.inlineMount ? "home" : "floating",
      }));
      sessionStorage.removeItem("quiloChat");
    } catch (_) {}
  }

  function loadConversation() {
    try {
      sessionStorage.removeItem("quiloChat");
      const saved = JSON.parse(sessionStorage.getItem(CHAT_STORAGE_KEY) || "null");
      if (!saved || !Array.isArray(saved.m)) return false;
      if (!saved.savedAt || Date.now() - Number(saved.savedAt) > CHAT_STORAGE_TTL_MS) {
        sessionStorage.removeItem(CHAT_STORAGE_KEY);
        return false;
      }
      const currentSurface = view?.inlineMount ? "home" : "floating";
      if (saved.surface && saved.surface !== currentSurface) return false;
      messages = saved.m;
      if (["help", "memo", "style"].includes(saved.mode)) currentMode = saved.mode;
      return true;
    } catch (_) {
      return false;
    }
  }

  function updateModebar() {
    if (!view) return;
    view.modebar.hidden = !isAssist();
    view.modeLabel.textContent = currentMode === "style" ? "글 스타일 정리" : "메모 작성";
    view.modelSelect.hidden = !(writeAssistEnabled && models.length);
  }

  function addFeedbackBar(row, snapshot, question, answer, isError, memoMode) {
    const bar = element("div", "qc-bar");
    if (!isError) {
      if (memoMode) {
        const copy = element("button", "prim", "📋 복사");
        copy.type = "button";
        copy.addEventListener("click", () => {
          try {
            navigator.clipboard.writeText(extractMemo(answer));
            copy.textContent = "복사됨!";
            setTimeout(() => { copy.textContent = "📋 복사"; }, 1200);
          } catch (_) {}
        });
        bar.appendChild(copy);

        if (memoTarget) {
          const insert = element("button", "prim", "↧ 입력칸에 넣기");
          insert.type = "button";
          insert.addEventListener("click", () => {
            const target = document.getElementById(memoTarget);
            if (!target) return;
            target.value = extractMemo(answer);
            target.dispatchEvent(new Event("input", { bubbles: true }));
            row.appendChild(element("div", "qc-note", "입력칸에 넣었어요 ✓"));
          });
          bar.appendChild(insert);
        }
      } else {
        const up = element("button", null, "👍");
        const down = element("button", null, "👎");
        up.type = down.type = "button";
        up.title = "도움이 됐어요";
        down.title = "별로예요";
        up.setAttribute("aria-label", "도움이 됐어요");
        down.setAttribute("aria-label", "별로예요");
        up.addEventListener("click", () => {
          up.classList.add("on");
          down.classList.remove("on");
          sendChatFeedback({ rating: "up", question, answer });
        });
        down.addEventListener("click", () => {
          down.classList.add("on");
          up.classList.remove("on");
          sendChatFeedback({ rating: "down", question, answer });
        });
        bar.append(up, down);
      }
    }

    const regenerateButton = element("button", null, "↻");
    regenerateButton.type = "button";
    regenerateButton.title = "다시 시도";
    regenerateButton.setAttribute("aria-label", "다시 시도");
    regenerateButton.addEventListener("click", () => {
      if (!busy) regenerate(row, snapshot);
    });
    bar.appendChild(regenerateButton);

    if (isError) {
      row.appendChild(bar);
      return;
    }

    const opinionButton = element("button", null, "✎");
    opinionButton.type = "button";
    opinionButton.title = "의견 보내기";
    opinionButton.setAttribute("aria-label", "의견 보내기");
    bar.appendChild(opinionButton);
    row.appendChild(bar);

    const feedback = element("div", "qc-fb");
    const textarea = element("textarea");
    textarea.rows = 2;
    textarea.placeholder = "버그·개선 의견을 적어주세요";
    const actions = element("div", "frow");
    const cancel = element("button", null, "취소");
    const submit = element("button", "send", "보내기");
    cancel.type = submit.type = "button";
    cancel.addEventListener("click", () => feedback.classList.remove("open"));
    submit.addEventListener("click", () => {
      const comment = textarea.value.trim();
      if (!comment) return;
      sendChatFeedback({ rating: "comment", comment, question, answer });
      feedback.classList.remove("open");
      opinionButton.hidden = true;
      row.appendChild(element("div", "qc-note", "의견을 보냈어요."));
    });
    opinionButton.addEventListener("click", () => {
      feedback.classList.toggle("open");
      if (feedback.classList.contains("open")) textarea.focus();
    });
    actions.append(cancel, submit);
    feedback.append(textarea, actions);
    row.appendChild(feedback);
  }

  function restoreConversation() {
    view.messagesElement.replaceChildren();
    view.chipsElement.hidden = true;
    updateModebar();
    const memoMode = isAssist();
    messages.forEach((message, index) => {
      if (message.role === "user") {
        addUserRow(view.messagesElement, message.content);
        return;
      }
      const assistant = addAssistantRow(view.messagesElement);
      assistant.bubble.textContent = message.content;
      addFeedbackBar(
        assistant.row,
        messages.slice(0, index),
        messages[index - 1]?.content || "",
        message.content,
        false,
        memoMode,
      );
    });
    view.messagesElement.scrollTop = view.messagesElement.scrollHeight;
  }

  function regenerate(row, snapshot) {
    messages = snapshot.slice();
    let node = row;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      node = next;
    }
    streamAssistant();
  }

  async function streamAssistant() {
    busy = true;
    view.sendButton.disabled = true;
    const snapshot = messages.slice();
    const question = snapshot.at(-1)?.content || "";
    const memoMode = isAssist();
    const assistant = addAssistantRow(view.messagesElement);
    assistant.bubble.textContent = "…";

    const payload = {
      messages: snapshot.slice(-8),
      mode: memoMode ? "memo" : currentMode,
      context: pageContext(),
    };
    if (currentMode === "memo" && memoReportType) payload.reportType = memoReportType;
    if (memoMode) {
      payload.assistKind = currentMode === "style" ? "style" : "memo";
      if (writeAssistEnabled && selectedModel) payload.model = selectedModel;
    }

    try {
      const answer = await streamChatResponse(payload, (partial) => {
        assistant.bubble.textContent = partial;
        view.messagesElement.scrollTop = view.messagesElement.scrollHeight;
      });
      if (!answer.trim()) {
        assistant.bubble.textContent = "(응답이 없습니다. 다시 시도해 주세요.)";
        addFeedbackBar(assistant.row, snapshot, question, "", true, memoMode);
      } else {
        assistant.bubble.textContent = answer;
        messages.push({ role: "assistant", content: answer });
        addFeedbackBar(assistant.row, snapshot, question, answer, false, memoMode);
        saveConversation();
      }
    } catch (error) {
      assistant.bubble.classList.add("err");
      assistant.bubble.textContent = error.message || "오류가 발생했어요.";
      addFeedbackBar(assistant.row, snapshot, question, "", true, memoMode);
    } finally {
      busy = false;
      view.sendButton.disabled = false;
      view.inputElement.focus();
      view.messagesElement.scrollTop = view.messagesElement.scrollHeight;
    }
  }

  function send(text) {
    const content = String(text || "").trim();
    if (!content || busy || !view) return;
    const wasInlineIdle =
      view.panel.classList.contains("qc-inline") && view.panel.classList.contains("qc-idle");
    if (wasInlineIdle) {
      view.messagesElement.replaceChildren();
      view.inputElement.placeholder = INLINE_PLACEHOLDER;
    }
    view.panel.classList.remove("qc-idle");
    view.chipsElement.hidden = true;
    addUserRow(view.messagesElement, content);
    messages.push({ role: "user", content });
    saveConversation();
    view.inputElement.value = "";
    resetComposer(view.inputElement);
    streamAssistant();
  }

  function showIntro() {
    view.messagesElement.replaceChildren();
    const greeting =
      currentMode === "style" ? STYLE_GREETING : currentMode === "memo" ? MEMO_GREETING : HELP_GREETING;
    const suggestions = isHomeInlineIdle()
      ? HOME_IDLE_SUGGESTIONS
      : currentMode === "style"
        ? STYLE_SUGGESTIONS
        : currentMode === "memo"
          ? MEMO_SUGGESTIONS
          : HELP_SUGGESTIONS;
    addAssistantRow(view.messagesElement).bubble.textContent = greeting;
    renderSuggestionChips(view.chipsElement, suggestions, send);
  }

  function setMode(mode) {
    if (busy || !view) return;
    currentMode = mode;
    if (mode === "help") memoTarget = null;
    updateModebar();
    messages = [];
    showIntro();
    saveConversation();
  }

  function switchToFloating() {
    if (!view?.panel.classList.contains("qc-inline")) return;
    const wasInlineIdle = view.panel.classList.contains("qc-idle");
    view.panel.classList.remove("qc-inline", "qc-idle", "open");
    view.inputElement.placeholder = DEFAULT_PLACEHOLDER;
    if (wasInlineIdle && currentMode === "help" && !messages.length) showIntro();
    document.body.appendChild(view.panel);
  }

  function toggle() {
    if (!view) return;
    const opening = !view.panel.classList.contains("open");
    view.panel.classList.toggle("open");
    if (opening && !openedOnce) {
      openedOnce = true;
      if (messages.length) restoreConversation();
      else showIntro();
    }
    if (opening) setTimeout(() => view.inputElement.focus(), 50);
  }

  function populateModels() {
    view.modelSelect.replaceChildren();
    models.forEach((model) => {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      view.modelSelect.appendChild(option);
    });
    let saved = null;
    try {
      saved = localStorage.getItem("quiloWaModel");
    } catch (_) {}
    if (saved && models.some((model) => model.id === saved)) selectedModel = saved;
    else selectedModel = models[0]?.id || null;
    if (selectedModel) view.modelSelect.value = selectedModel;
    view.modelSelect.addEventListener("change", () => {
      selectedModel = view.modelSelect.value;
      try {
        localStorage.setItem("quiloWaModel", selectedModel);
      } catch (_) {}
    });
  }

  function start(capabilities) {
    helpEnabled = capabilities.helpEnabled;
    writeAssistEnabled = capabilities.writeAssistEnabled;
    models = capabilities.models;
    if (!helpEnabled && !writeAssistEnabled) return;

    view = createChatView({
      helpEnabled,
      onToggle: toggle,
      onSend: send,
      onLaunch: () => {
        switchToFloating();
        toggle();
      },
    });
    view.modeBack.addEventListener("click", () => {
      if (helpEnabled) setMode("help");
      else toggle();
    });
    setupVoiceInput({
      micButton: view.micButton,
      inputElement: view.inputElement,
      statusElement: view.voiceStatus,
    });
    loadConversation();
    populateModels();
    updateModebar();

    if (view.inlineMount) {
      openedOnce = true;
      if (messages.length) {
        view.panel.classList.remove("qc-idle");
        view.inputElement.placeholder = currentMode === "help" ? INLINE_PLACEHOLDER : DEFAULT_PLACEHOLDER;
        restoreConversation();
      } else {
        showIntro();
      }
    }

    document.querySelectorAll(".qc-memo-btn, .qc-style-btn").forEach((button) => {
      button.classList.add("qc-enabled");
    });
  }

  function openMemo(targetId, kind) {
    if (!view) return;
    switchToFloating();
    memoTarget = targetId || null;
    memoReportType = kind === "style" ? "" : reportTypeFromTarget(targetId);
    openedOnce = true;
    view.panel.classList.add("open");
    setMode(kind === "style" ? "style" : "memo");
    setTimeout(() => view?.inputElement.focus(), 60);
  }

  return { start, openMemo };
}

export function initChatWidget() {
  if (initializationPromise) return initializationPromise;
  const controller = createChatController();
  window.Quilo = window.Quilo || {};
  window.Quilo.openMemo = (targetId, kind) => controller.openMemo(targetId, kind);
  window.Quilo.openStyle = (targetId) => controller.openMemo(targetId, "style");

  initializationPromise = loadChatCapabilities()
    .then((capabilities) => {
      const start = () => controller.start(capabilities);
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start, { once: true });
      } else {
        start();
      }
    })
    .catch(() => undefined);
  return initializationPromise;
}
