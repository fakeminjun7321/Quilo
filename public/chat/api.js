export async function loadChatCapabilities() {
  const [chatStatus, writeAssist] = await Promise.all([
    fetch("/api/chat/status")
      .then((response) => response.json())
      .catch(() => ({})),
    fetch("/api/write-assist/models")
      .then((response) => response.json())
      .catch(() => ({})),
  ]);

  return {
    helpEnabled: Boolean(chatStatus?.enabled),
    writeAssistEnabled: Boolean(writeAssist?.enabled && writeAssist?.loggedIn),
    models: (writeAssist?.models || []).map((model) => ({
      id: model.id,
      label: model.label,
    })),
  };
}

export function sendChatFeedback(payload) {
  return fetch("/api/chat/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, pageUrl: location.href }),
  }).catch(() => undefined);
}

export async function streamChatResponse(payload, onChunk) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || "오류가 발생했어요. 잠시 후 다시 시도하세요.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    accumulated += decoder.decode(result.value, { stream: true });
    onChunk?.(accumulated);
  }
  accumulated += decoder.decode();
  return accumulated;
}
