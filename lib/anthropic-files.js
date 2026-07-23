// Anthropic Files API helper (raw HTTP).
//
// 설치된 SDK(@anthropic-ai/sdk 0.30.1)에는 `client.beta.files` 리소스가 없어서,
// Files API(beta files-api-2025-04-14)를 fetch 로 직접 호출한다. Node 18+ 의
// 전역 fetch/FormData/Blob 를 사용한다.
//
// 용도: 큰 PDF 를 인라인 base64 로 보내면 Anthropic "요청당 32MB" 한도에 걸린다
// (base64 는 약 1.33배로 부풀어 단일 PDF ~24MB 가 인라인 한계). Files API 로
// 업로드한 뒤 메시지에서 `source: {type:"file", file_id}` 로 참조하면 요청
// 페이로드가 작아져 그 한도를 우회한다(파일당 최대 500MB). 메시지 요청에는
// `anthropic-beta: files-api-2025-04-14` 헤더가 필요하다.

const FILES_BETA = "files-api-2025-04-14";
const API_BASE = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
const byok = require("./byok");

// Files API로 만든 file_id는 그 파일을 만든 Anthropic 계정/키의 범위에 속한다.
// 따라서 업로드와 삭제는 실제 messages 호출에 쓰는 활성 BYOK 키와 반드시 같아야 한다.
// 호출자가 작업 시작 시 해석한 키를 명시적으로 주입할 수 있게 하되, 기존 호출자는
// AsyncLocalStorage의 활성 BYOK 키(없으면 서버 키)를 그대로 사용한다.
function apiKey(explicitKey) {
  return String(explicitKey || byok.anthropicKey() || "");
}

/**
 * PDF(또는 임의 바이너리)를 Anthropic Files API 로 업로드한다.
 * @param {Buffer} buffer
 * @param {string} filename
 * @param {Object} [opts]
 * @param {string} [opts.mimeType="application/pdf"]
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutMs=180000]
 * @param {string} [opts.apiKey] messages 호출과 같은 Anthropic 키
 * @returns {Promise<string>} file_id (예: "file_...")
 */
async function uploadFileToAnthropic(buffer, filename, opts = {}) {
  const key = apiKey(opts.apiKey);
  if (!key) throw new Error("ANTHROPIC_API_KEY 미설정");
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("빈 파일 버퍼");

  const mimeType = opts.mimeType || "application/pdf";
  const form = new FormData();
  // Blob 으로 감싸 멀티파트 파일 파트를 만든다. 파일명·콘텐트타입을 명시.
  form.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    filename || "upload.pdf",
  );

  // 업로드 자체 타임아웃 + 외부 signal 둘 다 반영.
  const timeoutMs = opts.timeoutMs || 180000;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  const res = await fetch(`${API_BASE}/v1/files`, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": FILES_BETA,
      // Content-Type 은 fetch 가 FormData boundary 와 함께 자동 설정 — 직접 넣지 않음.
    },
    body: form,
    signal,
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* ignore */
    }
    throw new Error(`Files API 업로드 실패 HTTP ${res.status} ${detail}`);
  }
  const data = await res.json();
  if (!data || !data.id) {
    throw new Error("Files API 응답에 file id 없음");
  }
  return data.id;
}

/**
 * 업로드한 파일 삭제(베스트에포트 — 실패해도 무시).
 * @param {string} fileId
 * @param {{apiKey?: string}} [opts]
 */
async function deleteAnthropicFile(fileId, opts = {}) {
  const key = apiKey(opts.apiKey);
  if (!key || !fileId) return;
  try {
    await fetch(`${API_BASE}/v1/files/${encodeURIComponent(fileId)}`, {
      method: "DELETE",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": FILES_BETA,
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    /* 정리 실패는 치명적이지 않음 */
  }
}

module.exports = {
  FILES_BETA,
  uploadFileToAnthropic,
  deleteAnthropicFile,
};
