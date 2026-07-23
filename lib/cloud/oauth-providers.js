"use strict";

const crypto = require("node:crypto");

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
const GOOGLE_DRIVE = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const GOOGLE_DOCS = "https://docs.googleapis.com/v1";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const NOTION_AUTH = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN = "https://api.notion.com/v1/oauth/token";
const NOTION_VERSION = "2026-03-11";

function configured(provider) {
  if (provider === "google") return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.CLOUD_TOKEN_SECRET);
  if (provider === "notion") return !!(process.env.NOTION_CLIENT_ID && process.env.NOTION_CLIENT_SECRET && process.env.CLOUD_TOKEN_SECRET);
  return false;
}

function encryptionKey() {
  if (!process.env.CLOUD_TOKEN_SECRET) throw new Error("CLOUD_TOKEN_SECRET가 설정되지 않았습니다.");
  return crypto.createHash("sha256").update(process.env.CLOUD_TOKEN_SECRET).digest();
}

function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptToken(value) {
  const [version, iv, tag, encrypted] = String(value || "").split(":");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("클라우드 토큰 형식이 올바르지 않습니다.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

function authorizationUrl(provider, { state, redirectUri }) {
  if (!configured(provider)) throw new Error(`${provider} OAuth가 설정되지 않았습니다.`);
  if (provider === "google") {
    return `${GOOGLE_AUTH}?${new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      scope: [
        "openid", "email", "profile",
        // Google Docs create/batchUpdate 모두 drive.file을 허용한다. 앱이 만들거나
        // 사용자가 명시적으로 선택한 파일만 다루고 전체 문서함 권한은 요청하지 않는다.
        "https://www.googleapis.com/auth/drive.file",
      ].join(" "),
    })}`;
  }
  return `${NOTION_AUTH}?${new URLSearchParams({
    client_id: process.env.NOTION_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  })}`;
}

async function exchangeCode(provider, { code, redirectUri }) {
  if (provider === "google") {
    return postForm(GOOGLE_TOKEN, {
      code, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri, grant_type: "authorization_code",
    });
  }
  const response = await fetch(NOTION_TOKEN, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  return checkedJson(response, "Notion OAuth");
}

async function postForm(url, values) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
  return checkedJson(response, "OAuth token");
}

async function googleAccessToken(refreshToken) {
  const token = await postForm(GOOGLE_TOKEN, {
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  if (!token.access_token) throw new Error("Google access token을 받지 못했습니다.");
  return token.access_token;
}

async function googleAccount(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await checkedJson(response, "Google userinfo");
  return { email: data.email || "", name: data.name || "" };
}

function escapeDriveQuery(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function googleJson(url, accessToken, options = {}, label = "Google API", fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options.body && !options.headers?.["content-type"] ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  return checkedJson(response, label);
}

async function listDriveFiles(accessToken, {
  pageSize = 50,
  folderId = "",
  foldersOnly = false,
  mimeType = "",
  query = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const limit = Number.isFinite(Number(pageSize)) ? Math.min(100, Math.max(1, Number(pageSize))) : 50;
  const clauses = ["trashed = false"];
  if (folderId) clauses.push(`'${escapeDriveQuery(folderId)}' in parents`);
  if (foldersOnly) clauses.push(`mimeType = '${GOOGLE_FOLDER_MIME}'`);
  else if (mimeType) clauses.push(`mimeType = '${escapeDriveQuery(mimeType)}'`);
  if (query) clauses.push(`name contains '${escapeDriveQuery(query)}'`);
  const params = new URLSearchParams({
    pageSize: String(limit),
    q: clauses.join(" and "),
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,iconLink,parents,appProperties,capabilities(canDownload,canEdit))",
  });
  const response = await fetchImpl(`${GOOGLE_DRIVE}/files?${params}`, { headers: { authorization: `Bearer ${accessToken}` } });
  return (await checkedJson(response, "Google Drive list")).files || [];
}

async function getDriveFile(accessToken, fileId, { fetchImpl = globalThis.fetch } = {}) {
  return googleJson(
    `${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,appProperties,capabilities(canDownload,canEdit)`,
    accessToken,
    {},
    "Google Drive metadata",
    fetchImpl,
  );
}

async function findDriveFileBySource(accessToken, sourceKey, { fetchImpl = globalThis.fetch } = {}) {
  if (!sourceKey) return null;
  const params = new URLSearchParams({
    pageSize: "10",
    q: `trashed = false and appProperties has { key='quiloSourceKey' and value='${escapeDriveQuery(sourceKey)}' }`,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,mimeType,size,modifiedTime,webViewLink,parents,appProperties)",
  });
  const data = await googleJson(`${GOOGLE_DRIVE}/files?${params}`, accessToken, {}, "Google Drive source lookup", fetchImpl);
  return Array.isArray(data.files) ? data.files[0] || null : null;
}

async function uploadDriveFile(accessToken, {
  name,
  mimeType,
  buffer,
  folderId = "",
  fileId = "",
  targetMimeType = "",
  appProperties = null,
  fetchImpl = globalThis.fetch,
}) {
  const boundary = `quilo_${crypto.randomBytes(12).toString("hex")}`;
  const metadataObject = {
    ...(name ? { name: String(name).slice(0, 255) } : {}),
    ...(!fileId && folderId ? { parents: [String(folderId)] } : {}),
    ...(targetMimeType ? { mimeType: targetMimeType } : {}),
    ...(appProperties && typeof appProperties === "object" ? { appProperties } : {}),
  };
  const metadata = Buffer.from(JSON.stringify(metadataObject), "utf8");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`), metadata,
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType || "application/octet-stream"}\r\n\r\n`),
    buffer, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const endpoint = fileId
    ? `${GOOGLE_DRIVE_UPLOAD}/files/${encodeURIComponent(fileId)}`
    : `${GOOGLE_DRIVE_UPLOAD}/files`;
  const params = new URLSearchParams({
    uploadType: "multipart",
    fields: "id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,appProperties",
  });
  const response = await fetchImpl(`${endpoint}?${params}`, {
    method: fileId ? "PATCH" : "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return checkedJson(response, fileId ? "Google Drive revision" : "Google Drive upload");
}

// Quilo가 생성한 Drive 파일을 보상 트랜잭션에서 제거한다. drive.file 스코프는
// 앱이 만든 파일에 대한 삭제를 허용하며, 이미 사라진 파일은 멱등 성공으로 본다.
async function deleteDriveFile(accessToken, fileId, { fetchImpl = globalThis.fetch } = {}) {
  if (!fileId) return false;
  const response = await fetchImpl(
    `${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    },
  );
  if (response.ok || response.status === 404) return true;
  const detail = await response.text().catch(() => "");
  throw new Error(`Google Drive delete ${response.status}: ${detail.slice(0, 300)}`);
}

async function createDriveFolder(accessToken, { name, parentId = "", fetchImpl = globalThis.fetch }) {
  return googleJson(`${GOOGLE_DRIVE}/files?fields=id,name,mimeType,webViewLink,parents`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      name: String(name || "Quilo").slice(0, 255),
      mimeType: GOOGLE_FOLDER_MIME,
      ...(parentId ? { parents: [String(parentId)] } : {}),
    }),
  }, "Google Drive folder create", fetchImpl);
}

async function ensureDriveFolder(accessToken, { name = "Quilo", parentId = "", fetchImpl = globalThis.fetch } = {}) {
  const folders = await listDriveFiles(accessToken, {
    pageSize: 100,
    folderId: parentId,
    foldersOnly: true,
    query: name,
    fetchImpl,
  });
  const existing = folders.find((folder) => folder.name === String(name));
  return existing || createDriveFolder(accessToken, { name, parentId, fetchImpl });
}

async function copyDriveFile(accessToken, fileId, { name, folderId = "", appProperties = null, fetchImpl = globalThis.fetch } = {}) {
  return googleJson(`${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}/copy?fields=id,name,mimeType,webViewLink,parents,appProperties`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      ...(name ? { name: String(name).slice(0, 255) } : {}),
      ...(folderId ? { parents: [String(folderId)] } : {}),
      ...(appProperties ? { appProperties } : {}),
    }),
  }, "Google Drive copy", fetchImpl);
}

async function downloadDriveFile(accessToken, fileId, { fetchImpl = globalThis.fetch } = {}) {
  const meta = await getDriveFile(accessToken, fileId, { fetchImpl });
  const exports = {
    [GOOGLE_DOC_MIME]: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"],
    "application/vnd.google-apps.spreadsheet": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"],
    "application/vnd.google-apps.presentation": ["application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx"],
  };
  const native = exports[meta.mimeType];
  const url = native
    ? `${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(native[0])}`
    : `${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}?alt=media`;
  const response = await fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Drive download ${response.status}: ${detail.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(String(meta.name || ""));
  return {
    buffer,
    filename: native && !hasExt ? `${meta.name}${native[1]}` : meta.name || `drive-file${native?.[1] || ""}`,
    mimeType: native?.[0] || response.headers.get("content-type") || meta.mimeType || "application/octet-stream",
    file: meta,
  };
}

async function getGoogleDoc(accessToken, documentId, { fetchImpl = globalThis.fetch } = {}) {
  return googleJson(`${GOOGLE_DOCS}/documents/${encodeURIComponent(documentId)}`, accessToken, {}, "Google Docs read", fetchImpl);
}

async function appendGoogleDocText(accessToken, documentId, text, { fetchImpl = globalThis.fetch } = {}) {
  const doc = await getGoogleDoc(accessToken, documentId, { fetchImpl });
  const content = String(text || "").slice(0, 500000);
  if (!content) return doc;
  const body = doc.body?.content || [];
  const endIndex = Math.max(1, Number(body[body.length - 1]?.endIndex) || 1);
  await googleJson(`${GOOGLE_DOCS}/documents/${encodeURIComponent(documentId)}:batchUpdate`, accessToken, {
    method: "POST",
    body: JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: `\n${content}` } }] }),
  }, "Google Docs append", fetchImpl);
  return getGoogleDoc(accessToken, documentId, { fetchImpl });
}

async function listDriveComments(accessToken, fileId, { pageSize = 100, fetchImpl = globalThis.fetch } = {}) {
  const limit = Number.isFinite(Number(pageSize)) ? Math.min(100, Math.max(1, Number(pageSize))) : 100;
  const params = new URLSearchParams({
    pageSize: String(limit),
    includeDeleted: "false",
    fields: "comments(id,content,quotedFileContent,resolved,createdTime,modifiedTime,author(displayName,photoLink,me),replies(id,content,createdTime,modifiedTime,author(displayName,me)))",
  });
  const data = await googleJson(`${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}/comments?${params}`, accessToken, {}, "Google Drive comments", fetchImpl);
  return data.comments || [];
}

async function createDriveComment(accessToken, fileId, { content, quotedText = "", fetchImpl = globalThis.fetch } = {}) {
  const quote = String(quotedText || "").trim().slice(0, 500);
  const body = quote
    ? `대상 문구: “${quote}”\n\n${String(content || "").trim()}`
    : String(content || "").trim();
  if (!body) throw new Error("댓글 내용이 필요합니다.");
  return googleJson(`${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}/comments?fields=id,content,resolved,createdTime,author(displayName,me)`, accessToken, {
    method: "POST",
    body: JSON.stringify({ content: body }),
  }, "Google Drive comment create", fetchImpl);
}

async function replyDriveComment(accessToken, fileId, commentId, {
  content = "",
  resolve = false,
  fetchImpl = globalThis.fetch,
} = {}) {
  const text = String(content || "").trim();
  if (!text && !resolve) throw new Error("답글 내용이 필요합니다.");
  return googleJson(
    `${GOOGLE_DRIVE}/files/${encodeURIComponent(fileId)}/comments/${encodeURIComponent(commentId)}/replies?fields=id,content,action,createdTime,author(displayName,me)`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        ...(text ? { content: text } : {}),
        ...(resolve ? { action: "resolve" } : {}),
      }),
    },
    "Google Drive comment reply",
    fetchImpl,
  );
}

async function revokeGoogleToken(token, { fetchImpl = globalThis.fetch } = {}) {
  if (!token) return false;
  const response = await fetchImpl(GOOGLE_REVOKE, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  return response.ok;
}

async function createGoogleDoc(accessToken, { title, text, folderId = "", fetchImpl = globalThis.fetch }) {
  const createResponse = await fetchImpl(`${GOOGLE_DOCS}/documents`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ title: String(title || "Quilo 문서").slice(0, 200) }),
  });
  const document = await checkedJson(createResponse, "Google Docs create");
  const content = String(text || "").slice(0, 500000);
  if (content) {
    const updateResponse = await fetchImpl(`${GOOGLE_DOCS}/documents/${encodeURIComponent(document.documentId)}:batchUpdate`, {
      method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content } }] }),
    });
    await checkedJson(updateResponse, "Google Docs batchUpdate");
  }
  if (folderId) {
    const params = new URLSearchParams({
      addParents: String(folderId),
      removeParents: "root",
      fields: "id,parents",
    });
    const moveResponse = await fetchImpl(`${GOOGLE_DRIVE}/files/${encodeURIComponent(document.documentId)}?${params}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    await checkedJson(moveResponse, "Google Docs folder move");
  }
  return { id: document.documentId, title: document.title, url: `https://docs.google.com/document/d/${document.documentId}/edit` };
}

async function createNotionPage(accessToken, { title, markdown }) {
  const response = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "notion-version": NOTION_VERSION },
    body: JSON.stringify({
      parent: { type: "workspace", workspace: true },
      properties: { title: { type: "title", title: [{ type: "text", text: { content: String(title || "Quilo 페이지").slice(0, 200) } }] } },
      markdown: String(markdown || "").slice(0, 500000),
    }),
  });
  const page = await checkedJson(response, "Notion page create");
  return { id: page.id, url: page.url, title: String(title || "Quilo 페이지") };
}

async function checkedJson(response, label) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  const errorDetail = data.message || data.error_description || data.error?.message || data.error || text;
  if (!response.ok) throw new Error(`${label} ${response.status}: ${String(errorDetail).slice(0, 400)}`);
  return data;
}

module.exports = {
  GOOGLE_DOC_MIME, GOOGLE_FOLDER_MIME, appendGoogleDocText, authorizationUrl, configured,
  copyDriveFile, createDriveComment, createDriveFolder, createGoogleDoc, createNotionPage,
  decryptToken, deleteDriveFile, downloadDriveFile, encryptToken, exchangeCode, findDriveFileBySource,
  getDriveFile, getGoogleDoc, googleAccessToken, googleAccount, ensureDriveFolder,
  listDriveComments, listDriveFiles, replyDriveComment, revokeGoogleToken, uploadDriveFile,
};
