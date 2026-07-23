"use strict";

const express = require("express");
const { getFeature, listFeatures } = require("../quilo-catalog");
const { hashAccessToken } = require("../external-api");

const NOAUTH = [{ type: "noauth" }];
const oauth = (...scopes) => [{ type: "oauth2", scopes }];
function tool({ name, title, description, inputSchema, scopes = [], readOnly = true, openWorld = false, destructive = false }) {
  const securitySchemes = scopes.length ? oauth(...scopes) : NOAUTH;
  return {
    name, title, description, inputSchema: { type: "object", additionalProperties: false, ...inputSchema },
    securitySchemes,
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: openWorld },
    _meta: { securitySchemes },
  };
}

const TOOLS = Object.freeze([
  tool({ name: "search", title: "Quilo 기능 검색", description: "Use this when 사용자의 목표에 맞는 Quilo 기능이나 API를 찾아야 할 때 사용합니다.", inputSchema: { properties: { query: { type: "string", description: "기능명 또는 자연어 검색어" } }, required: ["query"] } }),
  tool({ name: "fetch", title: "Quilo 기능 상세", description: "Use this when 검색 결과의 Quilo 기능 하나를 정확한 URL·상태·API 권한과 함께 읽어야 할 때 사용합니다.", inputSchema: { properties: { id: { type: "string" } }, required: ["id"] } }),
  tool({ name: "account_summary", title: "계정 요약", description: "Use this when 연결된 Quilo 계정과 크레딧을 확인해야 할 때 사용합니다.", scopes: ["account:read"], inputSchema: { properties: {} } }),
  tool({ name: "jobs_list", title: "작업 목록", description: "Use this when 최근 Quilo 생성·번역 작업의 상태를 확인해야 할 때 사용합니다.", scopes: ["jobs:read"], inputSchema: { properties: {} } }),
  tool({ name: "job_get", title: "작업 상세", description: "Use this when 특정 Quilo 작업의 상태와 진행 정보를 확인해야 할 때 사용합니다.", scopes: ["jobs:read"], inputSchema: { properties: { id: { type: "string" } }, required: ["id"] } }),
  tool({ name: "job_email", title: "결과 이메일 전송", description: "Use this when 완료된 Quilo 작업의 파일함 링크를 계정의 인증 이메일로 보내야 할 때 사용합니다.", scopes: ["jobs:write"], readOnly: false, openWorld: true, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] } }),
  tool({ name: "word_count", title: "글자수 계산", description: "Use this when 한국어 또는 영문 텍스트의 글자·단어·줄·문단 수를 정확히 계산해야 할 때 사용합니다.", scopes: ["tools:read"], inputSchema: { properties: { text: { type: "string" } }, required: ["text"] } }),
  tool({ name: "statistics", title: "기술통계", description: "Use this when 숫자 배열의 평균·중앙값·표준편차·사분위수를 계산해야 할 때 사용합니다.", scopes: ["tools:read"], inputSchema: { properties: { values: { type: "array", items: { type: "number" }, minItems: 1, maxItems: 10000 } }, required: ["values"] } }),
  tool({ name: "regression", title: "선형회귀", description: "Use this when 두 숫자 배열로 기울기·절편·상관계수·결정계수를 계산해야 할 때 사용합니다.", scopes: ["tools:read"], inputSchema: { properties: { x: { type: "array", items: { type: "number" }, minItems: 2 }, y: { type: "array", items: { type: "number" }, minItems: 2 } }, required: ["x", "y"] } }),
  tool({ name: "unit_convert", title: "단위 변환", description: "Use this when 물리·과학 단위를 결정적으로 변환해야 할 때 사용합니다.", scopes: ["tools:read"], inputSchema: { properties: { value: { type: "number" }, from: { type: "string" }, to: { type: "string" }, category: { type: "string" } }, required: ["value", "from", "to", "category"] } }),
  tool({ name: "vibe_generate", title: "Vibe 프로젝트 설계", description: "Use this when 아이디어를 Quilo Vibe 프로젝트 설계로 생성해야 할 때 사용합니다.", scopes: ["studios:write"], readOnly: false, openWorld: true, inputSchema: { properties: { idea: { type: "string" }, model: { type: "string" } }, required: ["idea"] } }),
  tool({ name: "vibe_refine", title: "Vibe 설계 수정", description: "Use this when 기존 Vibe 생성 결과를 사용자 피드백에 따라 수정해야 할 때 사용합니다.", scopes: ["studios:write"], readOnly: false, openWorld: true, inputSchema: { properties: { message: { type: "string" }, result: { type: "object", additionalProperties: true }, history: { type: "array", items: { type: "object" } }, model: { type: "string" } }, required: ["message", "result"] } }),
  tool({ name: "artifact_build", title: "창작 아티팩트 생성", description: "Use this when 웹·디자인 아티팩트를 생성하거나 대화형으로 수정해야 할 때 사용합니다.", scopes: ["studios:write"], readOnly: false, openWorld: true, inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" }, html: { type: "string" } }, required: ["prompt"] } }),
  tool({ name: "code_assist", title: "Quilo Code", description: "Use this when 코드를 생성·수정·설명·디버그해야 할 때 사용합니다.", scopes: ["studios:write"], readOnly: false, openWorld: true, inputSchema: { properties: { prompt: { type: "string" }, code: { type: "string" }, lang: { type: "string" }, model: { type: "string" } }, required: ["prompt"] } }),
  tool({ name: "community_posts", title: "커뮤니티 글", description: "Use this when Quilo 커뮤니티의 자유 글·질문·사용 팁·작업 사례를 읽어야 할 때 사용합니다.", scopes: ["community:read"], inputSchema: { properties: { category: { type: "string", description: "general, question, tip, showcase 또는 기존 feature/suggestion" } } } }),
  tool({ name: "community_comments", title: "커뮤니티 댓글", description: "Use this when 특정 Quilo 커뮤니티 글의 댓글을 읽어야 할 때 사용합니다.", scopes: ["community:read"], inputSchema: { properties: { postId: { type: "string" } }, required: ["postId"] } }),
  tool({ name: "community_vote", title: "커뮤니티 공감", description: "Use this when 사용자의 명시적 요청으로 Quilo 커뮤니티 글 공감을 전환해야 할 때 사용합니다.", scopes: ["community:write"], readOnly: false, inputSchema: { properties: { postId: { type: "string" } }, required: ["postId"] } }),
  tool({ name: "integrations_status", title: "외부 연동 상태", description: "Use this when Dropbox·Google·Notion·BYOK 연결 상태를 확인해야 할 때 사용합니다.", scopes: ["integrations:read"], inputSchema: { properties: {} } }),
  tool({ name: "google_drive_files", title: "Google Drive 파일", description: "Use this when Quilo가 접근할 수 있는 사용자의 Google Drive 파일을 찾아야 할 때 사용합니다.", scopes: ["integrations:data"], inputSchema: { properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 } } } }),
  tool({ name: "google_doc_create", title: "Google Docs 생성", description: "Use this when 사용자의 명시적 요청으로 제목과 본문을 새 Google Docs 문서로 저장해야 할 때 사용합니다.", scopes: ["integrations:write"], readOnly: false, openWorld: true, inputSchema: { properties: { title: { type: "string" }, text: { type: "string" } }, required: ["title", "text"] } }),
  tool({ name: "google_doc_append", title: "Google Docs 본문 추가", description: "Use this when 사용자의 명시적 요청으로 기존 Google Docs 문서 끝에 내용을 추가해야 할 때 사용합니다.", scopes: ["integrations:write"], readOnly: false, openWorld: true, inputSchema: { properties: { documentId: { type: "string" }, text: { type: "string" } }, required: ["documentId", "text"] } }),
  tool({ name: "google_drive_comments", title: "Google Drive 댓글", description: "Use this when Google Drive 파일에 달린 댓글과 답글을 읽어야 할 때 사용합니다.", scopes: ["integrations:data"], inputSchema: { properties: { fileId: { type: "string" } }, required: ["fileId"] } }),
  tool({ name: "google_drive_comment_create", title: "Google Drive 댓글 작성", description: "Use this when 사용자의 명시적 요청으로 Google Drive 파일에 검토 댓글을 작성해야 할 때 사용합니다.", scopes: ["integrations:write"], readOnly: false, openWorld: true, inputSchema: { properties: { fileId: { type: "string" }, content: { type: "string" }, quotedText: { type: "string" } }, required: ["fileId", "content"] } }),
  tool({ name: "notion_page_create", title: "Notion 페이지 생성", description: "Use this when 사용자의 명시적 요청으로 제목과 Markdown을 새 Notion 페이지로 저장해야 할 때 사용합니다.", scopes: ["integrations:write"], readOnly: false, openWorld: true, inputSchema: { properties: { title: { type: "string" }, markdown: { type: "string" } }, required: ["title", "markdown"] } }),
  tool({ name: "webhooks_list", title: "Webhook 목록", description: "Use this when Quilo 작업 이벤트 Webhook endpoint를 확인해야 할 때 사용합니다.", scopes: ["webhooks:read"], inputSchema: { properties: {} } }),
  tool({ name: "webhook_create", title: "Webhook 생성", description: "Use this when 사용자의 명시적 요청으로 서명된 작업 이벤트 Webhook endpoint를 생성해야 할 때 사용합니다.", scopes: ["webhooks:write"], readOnly: false, openWorld: true, inputSchema: { properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string", enum: ["job.completed", "job.failed", "job.cancelled"] } }, description: { type: "string" } }, required: ["url"] } }),
]);

function createMcpRouter({ baseUrl, supa, excludeFeatureIds = [] }) {
  const router = express.Router();
  const excluded = new Set(
    [...excludeFeatureIds].map((id) => String(id || "").trim()).filter(Boolean),
  );
  router.get("/", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "Use POST for MCP Streamable HTTP." }));
  router.delete("/", (_req, res) => res.status(405).set("Allow", "POST").end());
  router.post("/", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const messages = Array.isArray(req.body) ? req.body : [req.body];
    if (!messages[0] || typeof messages[0] !== "object") return res.status(400).json(rpcError(null, -32600, "Invalid Request"));
    const responses = [];
    for (const message of messages) {
      if (message.id == null) continue;
      responses.push(await handleMessage(req, message, baseUrl, supa, excluded));
    }
    if (!responses.length) return res.status(202).end();
    res.type("application/json").send(JSON.stringify(Array.isArray(req.body) ? responses : responses[0]));
  });
  return router;
}

async function handleMessage(req, message, baseUrl, supa, excluded) {
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message.id ?? null, -32600, "Invalid Request");
  if (message.method === "initialize") return rpcResult(message.id, { protocolVersion: supportedProtocol(message.params?.protocolVersion), capabilities: { tools: { listChanged: false } }, serverInfo: { name: "Quilo", title: "Quilo AI Workspace", version: "1.0.0" }, instructions: "Quilo의 전체 기능은 search/fetch로 찾고, 사용자별 읽기·쓰기 기능은 OAuth 연결 후 사용하세요." });
  if (message.method === "ping") return rpcResult(message.id, {});
  if (message.method === "tools/list") return rpcResult(message.id, { tools: TOOLS });
  if (message.method !== "tools/call") return rpcError(message.id, -32601, "Method not found");
  const spec = TOOLS.find((item) => item.name === message.params?.name);
  if (!spec) return rpcError(message.id, -32602, "Unknown tool");
  try {
    if (spec.securitySchemes?.[0]?.type === "oauth2") await validateMcpBearer(req, baseUrl(req), supa);
    const data = await callTool(
      req,
      spec.name,
      message.params?.arguments || {},
      baseUrl,
      excluded,
    );
    return rpcResult(message.id, successResult(data));
  } catch (error) {
    if (error.status === 401) return rpcResult(message.id, authResult(req, spec, baseUrl));
    return rpcResult(message.id, { isError: true, content: [{ type: "text", text: error.message || "Quilo tool call failed." }], structuredContent: { error: error.body || error.message } });
  }
}

async function validateMcpBearer(req, audience, supa) {
  const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error("Quilo OAuth 연결이 필요합니다."), { status: 401 });
  const db = supa?.getClient?.();
  if (!db) throw Object.assign(new Error("OAuth 저장소를 사용할 수 없습니다."), { status: 401 });
  const now = new Date().toISOString();
  const { data, error } = await db.from("user_access_tokens")
    .select("id, audience, expires_at, revoked_at")
    .eq("token_hash", hashAccessToken(match[1])).eq("audience", audience)
    .is("revoked_at", null).gt("expires_at", now).maybeSingle();
  if (error || !data) throw Object.assign(new Error("MCP용 OAuth 토큰이 유효하지 않습니다."), { status: 401 });
}

async function callTool(req, name, args, baseUrl, excluded = new Set()) {
  if (name === "search") {
    const features = listFeatures({ query: String(args.query || "").slice(0, 200) })
      .filter((feature) => !excluded.has(feature.id))
      .slice(0, 20);
    return { results: features.map((feature) => ({ id: feature.id, title: feature.title, url: `${baseUrl(req)}${feature.path}`, text: feature.summary, metadata: { category: feature.category, status: feature.status, execution: feature.execution, api: feature.api } })) };
  }
  if (name === "fetch") {
    const id = String(args.id || "");
    if (excluded.has(id)) {
      throw Object.assign(new Error("Quilo 기능을 찾을 수 없습니다."), { status: 404 });
    }
    const feature = getFeature(id);
    if (!feature) throw Object.assign(new Error("Quilo 기능을 찾을 수 없습니다."), { status: 404 });
    return { id: feature.id, title: feature.title, text: `${feature.summary}\n상태: ${feature.status}\n실행: ${feature.execution}`, url: `${baseUrl(req)}${feature.path}`, metadata: feature };
  }
  const encoded = (value) => encodeURIComponent(String(value || ""));
  const calls = {
    account_summary: ["GET", "/api/v1/account"], jobs_list: ["GET", "/api/v1/jobs"],
    job_get: ["GET", `/api/v1/jobs/${encoded(args.id)}`], job_email: ["POST", `/api/v1/jobs/${encoded(args.id)}/email`, {}],
    word_count: ["POST", "/api/v1/tools/word-count", { text: args.text }],
    statistics: ["POST", "/api/v1/tools/statistics", { values: args.values }],
    regression: ["POST", "/api/v1/tools/regression", { x: args.x, y: args.y }],
    unit_convert: ["POST", "/api/v1/tools/units/convert", { value: args.value, from: args.from, to: args.to, category: args.category }],
    vibe_generate: ["POST", "/api/v1/studios/vibe/generate", args], vibe_refine: ["POST", "/api/v1/studios/vibe/refine", args],
    artifact_build: ["POST", "/api/v1/studios/artifacts/build", args], code_assist: ["POST", "/api/v1/studios/code/assist", args],
    community_posts: ["GET", `/api/v1/community/posts${args.category ? `?category=${encoded(args.category)}` : ""}`],
    community_comments: ["GET", `/api/v1/community/posts/${encoded(args.postId)}/comments`],
    community_vote: ["POST", `/api/v1/community/posts/${encoded(args.postId)}/vote`, {}],
    integrations_status: ["GET", "/api/v1/integrations"],
    google_drive_files: ["GET", `/api/v1/integrations/google-drive/files?limit=${encoded(args.limit || 50)}${args.query ? `&q=${encoded(args.query)}` : ""}`],
    google_doc_create: ["POST", "/api/v1/integrations/google-docs", { title: args.title, text: args.text }],
    google_doc_append: ["POST", `/api/v1/integrations/google-docs/${encoded(args.documentId)}/append`, { text: args.text }],
    google_drive_comments: ["GET", `/api/v1/integrations/google-drive/files/${encoded(args.fileId)}/comments`],
    google_drive_comment_create: ["POST", `/api/v1/integrations/google-drive/files/${encoded(args.fileId)}/comments`, { content: args.content, quotedText: args.quotedText }],
    notion_page_create: ["POST", "/api/v1/integrations/notion/pages", { title: args.title, markdown: args.markdown }],
    webhooks_list: ["GET", "/api/v1/webhooks"], webhook_create: ["POST", "/api/v1/webhooks", { url: args.url, events: args.events, description: args.description }],
  };
  const call = calls[name];
  if (!call) throw Object.assign(new Error("지원하지 않는 MCP 도구입니다."), { status: 400 });
  return apiJson(req, baseUrl(req), ...call);
}

async function apiJson(req, origin, method, pathname, body) {
  const headers = { accept: "application/json" };
  const authorization = req.get("authorization");
  if (authorization) headers.authorization = authorization;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${origin}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let parsed = {};
  try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { error: raw.slice(0, 1000) }; }
  if (!response.ok) {
    const error = new Error(typeof parsed.error === "string" ? parsed.error : parsed.error?.message || `Quilo API ${response.status}`);
    error.status = response.status; error.body = parsed; throw error;
  }
  return parsed;
}
function authResult(req, spec, baseUrl) {
  const scopes = spec.securitySchemes?.[0]?.scopes || [];
  const metadata = `${baseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
  const challenge = `Bearer resource_metadata="${metadata}", scope="${scopes.join(" ")}"`;
  return { isError: true, content: [{ type: "text", text: "이 기능을 사용하려면 Quilo 계정을 연결하세요." }], _meta: { "mcp/www_authenticate": [challenge] } };
}
function successResult(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data }; }
function supportedProtocol(requested) { return ["2025-11-25", "2025-06-18", "2025-03-26"].includes(requested) ? requested : "2025-06-18"; }
function rpcResult(id, result) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message } }; }

module.exports = { TOOLS, createMcpRouter };
