function setVoiceState(elements, active, message) {
  const { micButton, statusElement } = elements;
  micButton.classList.toggle("listening", active);
  micButton.setAttribute("aria-pressed", String(active));
  micButton.setAttribute("aria-label", active ? "음성 입력 중지" : "음성으로 입력");
  micButton.title = active ? "듣고 있어요. 누르면 중지합니다." : "음성으로 입력";
  statusElement.textContent = message || "";
}

export function setupVoiceInput({ micButton, inputElement, statusElement }) {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const elements = { micButton, statusElement };
  let listening = false;
  let baseValue = "";

  if (!Recognition) {
    micButton.disabled = true;
    micButton.title = "이 브라우저에서는 음성 입력을 지원하지 않습니다.";
    micButton.setAttribute("aria-label", "음성 입력을 지원하지 않는 브라우저입니다");
    return null;
  }

  const recognition = new Recognition();
  recognition.lang = "ko-KR";
  recognition.continuous = false;
  recognition.interimResults = true;

  recognition.onstart = () => {
    listening = true;
    setVoiceState(elements, true, "듣고 있어요. 말씀해 주세요.");
  };

  recognition.onresult = (event) => {
    let transcript = "";
    for (let index = 0; index < event.results.length; index += 1) {
      transcript += event.results[index][0].transcript;
    }
    const prefix = baseValue && !/\s$/.test(baseValue) ? `${baseValue} ` : baseValue;
    inputElement.value = prefix + transcript.trim();
    inputElement.dispatchEvent(new Event("input", { bubbles: true }));
  };

  recognition.onerror = (event) => {
    listening = false;
    const denied = event?.error === "not-allowed" || event?.error === "service-not-allowed";
    setVoiceState(
      elements,
      false,
      denied ? "마이크 권한이 필요합니다." : "음성을 인식하지 못했어요. 다시 눌러 주세요.",
    );
  };

  recognition.onend = () => {
    listening = false;
    setVoiceState(
      elements,
      false,
      inputElement.value.trim()
        ? "음성이 입력되었습니다. 내용을 확인한 뒤 전송하세요."
        : "음성 입력이 종료되었습니다.",
    );
    inputElement.focus();
  };

  micButton.addEventListener("click", () => {
    if (listening) {
      recognition.stop();
      return;
    }
    baseValue = inputElement.value || "";
    try {
      recognition.start();
    } catch (_) {
      listening = false;
      setVoiceState(elements, false, "음성 입력을 시작하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  });

  return recognition;
}
