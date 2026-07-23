// Dropbox 클라우드 저장 연동 (PKCE — App secret 불필요).
//
// 생성된 보고서를 사용자의 Dropbox(App folder)에 영구 저장하기 위한 헬퍼.
//  - OAuth2 Authorization Code + PKCE + token_access_type=offline → refresh token 확보.
//  - refresh token 은 CLOUD_TOKEN_SECRET 으로 AES-256-GCM 암호화해 저장(서버 호출부에서).
//  - access token 은 단명(≈4h)이라 업로드 직전 refresh 로 매번 새로 발급.
//
// 필요한 환경변수:
//   DROPBOX_APP_KEY      (공개값, 클라이언트 id)
//   CLOUD_TOKEN_SECRET   (refresh token 암호화 키 — 아무 랜덤 32자+)
//   (App secret 은 PKCE 라 불필요)

const crypto = require("crypto");

const APP_KEY = process.env.DROPBOX_APP_KEY || "";
const TOKEN_SECRET = process.env.CLOUD_TOKEN_SECRET || "";

const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const RPC = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

// 연동 가능 여부(앱 키가 있어야 함). 토큰 암호화는 CLOUD_TOKEN_SECRET 도 필요.
function isConfigured() {
  return !!APP_KEY;
}
function canStoreTokens() {
  return !!TOKEN_SECRET;
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
function base64url(buf) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function makePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

// 인증 시작 URL. state(CSRF) 와 code_challenge 는 호출부가 세션에 보관.
function getAuthUrl({ challenge, state, redirectUri }) {
  const p = new URLSearchParams({
    client_id: APP_KEY,
    response_type: "code",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline", // refresh token 발급
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

async function postForm(url, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Dropbox ${r.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Dropbox 응답 파싱 실패: ${text.slice(0, 200)}`);
  }
}

// code → { access_token, refresh_token, account_id, expires_in, ... }
async function exchangeCode({ code, verifier, redirectUri }) {
  return postForm(TOKEN_URL, {
    code,
    grant_type: "authorization_code",
    client_id: APP_KEY,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  });
}

// refresh_token → { access_token, expires_in }
async function refreshAccessToken(refreshToken) {
  return postForm(TOKEN_URL, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: APP_KEY,
  });
}

// RPC(JSON) 호출. arg 가 null 이면 본문/Content-Type 없이 보낸다(get_current_account 등).
async function rpc(path, accessToken, arg) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  let body;
  if (arg !== null && arg !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(arg);
  }
  const r = await fetch(`${RPC}${path}`, { method: "POST", headers, body });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dropbox ${path} ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Dropbox ${path} 응답 파싱 실패: ${text.slice(0, 200)}`);
  }
}

// { email, name } — 연결 표시용.
async function getAccountInfo(accessToken) {
  const j = await rpc("/2/users/get_current_account", accessToken, null);
  return {
    email: j.email || "",
    name: (j.name && (j.name.display_name || j.name.given_name)) || "",
  };
}

// Dropbox-API-Arg 헤더는 HTTP 헤더 값이라 ASCII(0~255)만 허용된다. 한글 등
// 비-ASCII 가 들어가면 fetch 가 "Cannot convert argument to a ByteString ..."로
// 실패한다. Dropbox 는 JSON 안의 비-ASCII 를 \uXXXX 로 이스케이프하는 것을 허용하므로
// (그래도 서버가 올바르게 디코딩한다), JSON 문자열을 순수 ASCII 로 만든다.
function dropboxApiArg(obj) {
  return JSON.stringify(obj).replace(
    /[^\x00-\x7f]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

// 파일 업로드(App folder 루트 기준 path, 예: "/2026 화학결과보고서.docx").
// → 파일 메타데이터 { id, name, path_display, ... }
async function uploadFile({ accessToken, path, buffer }) {
  const r = await fetch(`${CONTENT}/2/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": dropboxApiArg({
        path,
        mode: "add",
        autorename: true,
        mute: false,
        strict_conflict: false,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: buffer,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Dropbox upload ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// 업로드 이후 생성 취소·정산 실패가 발생했을 때 orphan 파일을 남기지 않기 위한
// 보상 삭제. Dropbox id 또는 path를 받을 수 있고, 이미 삭제된 대상은 멱등 성공이다.
async function deleteFile({ accessToken, path }) {
  if (!path) return false;
  const r = await fetch(`${RPC}/2/files/delete_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path: String(path) }),
  });
  const text = await r.text();
  if (r.ok) return true;
  // Dropbox nests several unrelated failures below path_lookup. Only the exact
  // not_found variant proves the artifact is already absent; permission,
  // restricted-content, malformed-path, and conflict variants must keep the
  // cleanup retry handle alive.
  if (r.status === 409 && /path_lookup\/not_found(?:\/|"|\s|$)/i.test(text)) return true;
  throw new Error(`Dropbox delete ${r.status}: ${text.slice(0, 300)}`);
}

// App folder 목록 → [{ name, path_lower, size, client_modified, id }]
async function listFolder({ accessToken, path = "" }) {
  const j = await rpc("/2/files/list_folder", accessToken, {
    path, // "" = app folder 루트
    recursive: false,
    include_deleted: false,
    limit: 200,
  });
  return (j.entries || []).filter((e) => e[".tag"] === "file");
}

// 임시 다운로드 링크(4시간 유효) → "내 파일"에서 바로 받기용.
async function getTemporaryLink({ accessToken, path }) {
  const j = await rpc("/2/files/get_temporary_link", accessToken, { path });
  return j.link || "";
}

// 영구 공유 링크(Dropbox 웹에서 파일 바로 열기). sharing.read/write 스코프 필요.
// 이미 있으면 재사용, 없으면 생성. 권한 없으면 throw(상위에서 안내).
async function getSharedLink({ accessToken, path }) {
  // 기존 공유 링크 재사용(sharing.read)
  try {
    const j = await rpc("/2/sharing/list_shared_links", accessToken, {
      path,
      direct_only: true,
    });
    if (j.links && j.links[0] && j.links[0].url) return j.links[0].url;
  } catch (_) {
    /* 없거나 권한 없음 → 아래 생성 시도 */
  }
  // 새로 생성(sharing.write)
  const r = await fetch(`${RPC}/2/sharing/create_shared_link_with_settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  const text = await r.text();
  if (r.ok) {
    try {
      return JSON.parse(text).url || null;
    } catch {
      return null;
    }
  }
  // 이미 공유 링크가 있으면 에러 본문에 기존 링크가 담겨온다.
  try {
    const j = JSON.parse(text);
    const u =
      j &&
      j.error &&
      j.error.shared_link_already_exists &&
      j.error.shared_link_already_exists.metadata &&
      j.error.shared_link_already_exists.metadata.url;
    if (u) return u;
  } catch {
    /* fallthrough */
  }
  throw new Error(`Dropbox shared link ${r.status}: ${text.slice(0, 200)}`);
}

// ── refresh token 암호화(AES-256-GCM) ────────────────────────────────────────
const ALGO = "aes-256-gcm";
function aesKey() {
  if (!TOKEN_SECRET) throw new Error("CLOUD_TOKEN_SECRET 환경변수가 설정되지 않았습니다.");
  return crypto.createHash("sha256").update(String(TOKEN_SECRET)).digest();
}
function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, aesKey(), iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}
function decryptToken(blob) {
  const parts = String(blob).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("잘못된 토큰 형식");
  }
  const [, ivb, tagb, encb] = parts;
  const d = crypto.createDecipheriv(ALGO, aesKey(), Buffer.from(ivb, "base64"));
  d.setAuthTag(Buffer.from(tagb, "base64"));
  return Buffer.concat([
    d.update(Buffer.from(encb, "base64")),
    d.final(),
  ]).toString("utf8");
}

module.exports = {
  isConfigured,
  canStoreTokens,
  makePkce,
  getAuthUrl,
  exchangeCode,
  refreshAccessToken,
  getAccountInfo,
  uploadFile,
  deleteFile,
  listFolder,
  getTemporaryLink,
  getSharedLink,
  encryptToken,
  decryptToken,
  APP_KEY,
};
