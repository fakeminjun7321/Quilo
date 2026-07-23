const MIC_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 0 0 3.5-3.5V6a3.5 3.5 0 1 0-7 0v6a3.5 3.5 0 0 0 3.5 3.5Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.75 11.5V12a6.25 6.25 0 0 0 12.5 0v-.5M12 18.25V22M8.5 22h7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const SEND_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-5.5 5.5M12 5l5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function resetComposer(inputElement) {
  inputElement.rows = 1;
}

function resizeComposer(inputElement) {
  inputElement.rows = 1;
  const lineHeight = Number.parseFloat(getComputedStyle(inputElement).lineHeight) || 21;
  const rows = Math.max(1, Math.min(5, Math.ceil(inputElement.scrollHeight / lineHeight) - 1));
  inputElement.rows = rows;
}

export function addUserRow(messagesElement, text) {
  const row = element("div", "qc-row me");
  row.appendChild(element("div", "qc-b", text));
  messagesElement.appendChild(row);
  messagesElement.scrollTop = messagesElement.scrollHeight;
  return row;
}

export function addAssistantRow(messagesElement) {
  const row = element("div", "qc-row ai");
  const bubble = element("div", "qc-b");
  row.appendChild(bubble);
  messagesElement.appendChild(row);
  messagesElement.scrollTop = messagesElement.scrollHeight;
  return { row, bubble };
}

export function renderSuggestionChips(chipsElement, suggestions, onSelect) {
  chipsElement.replaceChildren();
  suggestions.forEach((suggestion) => {
    const chip = element("button", "qc-chip", suggestion);
    chip.type = "button";
    chip.addEventListener("click", () => onSelect(suggestion));
    chipsElement.appendChild(chip);
  });
  chipsElement.hidden = false;
}

export function createChatView({ helpEnabled, onToggle, onSend, onLaunch }) {
  const inlineMount = helpEnabled ? document.getElementById("quiloBotMount") : null;
  const panel = element("div");
  panel.id = "qc-panel";

  const head = element("div");
  head.id = "qc-head";
  head.appendChild(element("b", null, "Quilo"));
  head.appendChild(element("span", "qc-sub", "AI assistant"));
  const closeButton = element("button", null, "×");
  closeButton.id = "qc-close";
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "닫기");
  closeButton.addEventListener("click", onToggle);
  head.appendChild(closeButton);
  panel.appendChild(head);

  const modebar = element("div");
  modebar.id = "qc-modebar";
  modebar.hidden = true;
  const modeLabel = element("span", null, "메모 작성");
  modeLabel.id = "qc-modelabel";
  modebar.appendChild(modeLabel);
  const modeActions = element("div", "qc-mode-actions");
  const modelSelect = element("select");
  modelSelect.id = "qc-model";
  modelSelect.title = "AI 모델 선택";
  modelSelect.hidden = true;
  modeActions.appendChild(modelSelect);
  const modeBack = element("button", null, "일반 대화로 돌아가기");
  modeBack.type = "button";
  modeActions.appendChild(modeBack);
  modebar.appendChild(modeActions);
  panel.appendChild(modebar);

  const messagesElement = element("div");
  messagesElement.id = "qc-msgs";
  panel.appendChild(messagesElement);

  const chipsElement = element("div");
  chipsElement.id = "qc-chips";
  panel.appendChild(chipsElement);

  const footer = element("div");
  footer.id = "qc-foot";
  const inputRow = element("div");
  inputRow.id = "qc-inrow";
  const inputElement = element("textarea");
  inputElement.id = "qc-in";
  inputElement.rows = 1;
  inputElement.placeholder = "메시지를 입력하세요…";
  let composing = false;
  inputElement.addEventListener("input", () => resizeComposer(inputElement));
  inputElement.addEventListener("compositionstart", () => { composing = true; });
  inputElement.addEventListener("compositionend", () => { composing = false; });
  inputElement.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    onSend(inputElement.value);
  });

  const micButton = element("button");
  micButton.id = "qc-mic";
  micButton.type = "button";
  micButton.setAttribute("aria-label", "음성으로 입력");
  micButton.setAttribute("aria-pressed", "false");
  micButton.title = "음성으로 입력";
  micButton.innerHTML = MIC_ICON;

  const sendButton = element("button");
  sendButton.id = "qc-send";
  sendButton.type = "button";
  sendButton.setAttribute("aria-label", "메시지 전송");
  sendButton.title = "메시지 전송";
  sendButton.innerHTML = SEND_ICON;
  sendButton.addEventListener("click", () => onSend(inputElement.value));

  if (inlineMount) inputElement.placeholder = "실험 자료를 분석해줘";
  inputRow.append(inputElement, micButton, sendButton);
  footer.appendChild(inputRow);

  const voiceStatus = element("div", "qc-sr");
  voiceStatus.id = "qc-voice-status";
  voiceStatus.setAttribute("role", "status");
  voiceStatus.setAttribute("aria-live", "polite");
  footer.appendChild(voiceStatus);

  const disclaimer = element(
    "div",
    null,
    "AI 응답은 부정확할 수 있습니다. 중요한 내용은 직접 확인하세요.",
  );
  disclaimer.id = "qc-disc";
  footer.appendChild(disclaimer);
  panel.appendChild(footer);

  if (inlineMount) {
    panel.classList.add("qc-inline", "open", "qc-idle");
    inlineMount.replaceChildren(panel);
  } else {
    document.body.appendChild(panel);
  }

  let launchButton = null;
  if (helpEnabled && !inlineMount) {
    launchButton = element("button", null, "💬");
    launchButton.id = "qc-launch";
    launchButton.type = "button";
    if (inlineMount) launchButton.classList.add("qc-home-launch");
    launchButton.setAttribute("aria-label", "Quilo AI 열기");
    launchButton.addEventListener("click", onLaunch);
    document.body.appendChild(launchButton);
  }

  return {
    panel,
    inlineMount,
    launchButton,
    modebar,
    modeLabel,
    modeActions,
    modeBack,
    modelSelect,
    messagesElement,
    chipsElement,
    inputElement,
    sendButton,
    micButton,
    voiceStatus,
  };
}
