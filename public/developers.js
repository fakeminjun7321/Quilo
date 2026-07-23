"use strict";

const state = {
  catalog: null,
  loggedIn: false,
  isAdmin: false,
  sessionState: "pending",
  connection: "chatgpt",
};
const $ = (id) => document.getElementById(id);
const CONNECTION_SCOPES = new Set(["account:read", "jobs:read", "files:read"]);

document.addEventListener("DOMContentLoaded", () => {
  $("createTokenBtn")?.addEventListener("click", createToken);
  $("copyTokenBtn")?.addEventListener("click", copyToken);
  $("catalogSearch")?.addEventListener("input", renderCatalog);
  $("catalogAccess")?.addEventListener("change", renderCatalog);
  $("refreshLogsBtn")?.addEventListener("click", loadApiRequests);
  $("tokenMode")?.addEventListener("change", updateTokenModeHelp);
  $("scopeGrid")?.addEventListener("change", updateScopeSummary);

  document.querySelectorAll(".dev-path-toggle").forEach((button) => {
    button.addEventListener("click", () => {
      const path = button.closest("[data-connection]");
      if (path) selectConnection(path.dataset.connection);
    });
  });
  document.querySelectorAll("[data-scope-preset]").forEach((button) => {
    button.addEventListener("click", () => applyScopePreset(button.dataset.scopePreset));
  });
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", () => copyElementText(button));
  });

  updateTokenModeHelp();
  updateScopeSummary();
  syncConnectionFromHash();
  window.addEventListener("hashchange", syncConnectionFromHash);
  void Promise.allSettled([loadStatus(), loadCatalog(), loadApiReference(), loadAccount()]);
});

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function selectConnection(connection) {
  const requested = ["chatgpt", "codex", "api"].includes(connection) ? connection : "chatgpt";
  state.connection = requested;
  document.querySelectorAll("[data-connection]").forEach((path) => {
    const active = path.dataset.connection === requested;
    path.classList.toggle("is-active", active);
    const toggle = path.querySelector(".dev-path-toggle");
    const panel = path.querySelector(".dev-path-panel");
    toggle?.setAttribute("aria-expanded", String(active));
    if (panel) panel.hidden = !active;
  });
}

function syncConnectionFromHash() {
  if (location.hash === "#local") selectConnection("codex");
  else if (location.hash === "#chatgpt") selectConnection("chatgpt");
}

async function loadStatus() {
  try {
    const data = await api("/api/version");
    const displayedVersion = data.releaseVersion || data.version || "";
    $("serviceDot")?.classList.add("ok");
    $("serviceStatus").textContent = `Quilo ${displayedVersion} 운영 서버 정상`;
  } catch (error) {
    $("serviceStatus").textContent = `서버 확인 실패 · ${error.message}`;
  }
}

async function loadApiReference() {
  try {
    const schema = await api("/api/openapi.json");
    const methods = new Set(["get", "post", "put", "patch", "delete"]);
    const operationCount = Object.values(schema.paths || {}).reduce((count, path) => {
      return count + Object.keys(path || {}).filter((method) => methods.has(method.toLowerCase())).length;
    }, 0);
    const pathCount = Object.keys(schema.paths || {}).length;
    $("apiReferenceSummary").textContent = `${pathCount}개 주소 · ${operationCount}개 작업`;
  } catch (error) {
    $("apiReferenceSummary").textContent = "전체 문서는 새 창에서 확인할 수 있습니다.";
  }
}

async function loadAccount() {
  let session;
  try {
    session = window.QuiloShellAuth?.ready
      ? await window.QuiloShellAuth.ready
      : { state: "authenticated", user: await api("/api/me"), status: 200 };
  } catch (error) {
    session = error?.status === 401
      ? { state: "anonymous", user: null, status: 401 }
      : { state: "unknown", user: null, status: error?.status || 0 };
  }

  state.sessionState = session.state;
  document.body.dataset.sessionState = session.state;

  if (session.state === "authenticated") {
    const data = session.user || {};
    state.loggedIn = true;
    state.isAdmin = data.isAdmin === true;
    $("accountStatus").textContent = `${data.name || data.user || data.username || "사용자"} 계정으로 로그인됨`;
    $("loginLink").textContent = "계정 관리";
    $("loginLink").href = "/#settings";
    $("createTokenBtn").disabled = false;
    $("refreshLogsBtn").disabled = false;
    await Promise.allSettled([loadTokens(), loadApiRequests()]);
    updateCatalogSummary();
    renderCatalog();
    return;
  }

  state.loggedIn = false;
  state.isAdmin = false;
  $("createTokenBtn").disabled = true;
  $("refreshLogsBtn").disabled = true;
  if (session.state === "anonymous") {
    $("accountStatus").textContent = "로그인이 필요합니다.";
    $("loginLink").textContent = "Quilo 로그인";
    $("loginLink").href = "/login.html?next=%2Fdevelopers.html";
    $("tokenMessage").textContent = "로그인 후 토큰을 만들고 관리할 수 있습니다.";
    return;
  }

  $("accountStatus").textContent = "로그인 상태를 확인하지 못했습니다.";
  $("loginLink").textContent = "Quilo로 돌아가기";
  $("loginLink").href = "/";
  $("tokenMessage").textContent = "계정 상태 확인이 복구되면 토큰을 관리할 수 있습니다.";
}

async function loadCatalog() {
  try {
    state.catalog = await api("/api/catalog");
    updateCatalogSummary();
    renderCatalog();
  } catch (error) {
    $("catalogSummary").textContent = `카탈로그를 불러오지 못했습니다: ${error.message}`;
  }
}

function catalogFeatures() {
  if (!state.catalog?.features) return [];
  const retired = new Set(["eng-exam-prep", "korean-lit-exam", "phys-inquiry", "math-inquiry", "phys-mock-exam"]);
  return state.catalog.features.filter((item) =>
    !retired.has(item.id) && (item.audience !== "admin" || state.isAdmin));
}

function matchesCatalogAccess(item, access) {
  const paused = item.status === "paused" || item.execution === "paused";
  if (access === "all") return true;
  if (access === "paused") return paused;
  if (access === "handoff") return !paused && item.execution === "handoff";
  return !paused && ["remote", "local", "read-only"].includes(item.execution);
}

function updateCatalogSummary() {
  if (!state.catalog) return;
  const visibleFeatures = catalogFeatures();
  const modes = visibleFeatures.reduce((counts, item) => {
    counts[item.execution] = (counts[item.execution] || 0) + 1;
    return counts;
  }, {});
  $("catalogSummary").textContent = `${visibleFeatures.length}개 기능 · API ${modes.remote || 0} · 로컬 ${modes.local || 0} · 읽기 ${modes["read-only"] || 0} · 웹 연결 ${modes.handoff || 0} · 중단 ${modes.paused || 0}`;
}

function renderCatalog() {
  if (!state.catalog) return;
  const q = $("catalogSearch").value.trim().toLowerCase();
  const access = $("catalogAccess")?.value || "connected";
  const visible = catalogFeatures();
  const items = visible.filter((item) => {
    const textMatch = !q || [item.title, item.summary, item.id, item.category].join(" ").toLowerCase().includes(q);
    return textMatch && matchesCatalogAccess(item, access);
  });
  $("catalogSummary").textContent = `${items.length}개 표시 · 전체 ${visible.length}개`;
  const categories = state.catalog.categories || {};
  const html = Object.entries(categories).map(([id, category]) => {
    const features = items.filter((item) => item.category === id);
    if (!features.length) return "";
    return `<details class="category"${q ? " open" : ""}><summary><span><strong>${escapeHtml(category.title)}</strong><small>${escapeHtml(category.description)}</small></span><b>${features.length}개</b></summary><div class="feature-list">${features.map(featureRow).join("")}</div></details>`;
  }).join("");
  $("catalogBody").innerHTML = html || "<p>조건에 맞는 기능이 없습니다.</p>";
}

function featureRow(item) {
  const label = { active: "운영 중", pro: "Pro", max: "Max", beta: "Beta", paused: "준비 중" }[item.status] || item.status;
  const execution = { remote: "API로 실행", local: "내 컴퓨터에서 실행", "read-only": "조회 전용", handoff: "Quilo 웹에서 열기", paused: "준비 중" }[item.execution] || item.execution;
  const audience = { public: "모두", member: "회원", pro: "Pro", max: "Max", admin: "관리자" }[item.audience] || item.audience;
  const paused = item.status === "paused" || item.execution === "paused";
  const content = `<strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.summary)}</p><span class="feature-meta">${escapeHtml(execution)} · ${escapeHtml(audience)}</span><span class="badge ${escapeAttr(item.status)}">${escapeHtml(label)}</span>`;
  if (paused) return `<div class="feature feature--paused" aria-disabled="true">${content}</div>`;
  return `<a class="feature" href="${escapeAttr(item.path)}">${content}</a>`;
}

function scopeInputs() {
  return [...document.querySelectorAll("#scopeGrid input[type='checkbox']")];
}

function applyScopePreset(preset) {
  scopeInputs().forEach((input) => {
    input.checked = preset === "connection" ? CONNECTION_SCOPES.has(input.value) : false;
  });
  updateScopeSummary();
}

function updateScopeSummary() {
  const inputs = scopeInputs();
  const selected = inputs.filter((input) => input.checked);
  const writes = selected.filter((input) => !input.value.endsWith(":read") && input.value !== "integrations:data");
  $("scopeCount").textContent = `${inputs.length}개 권한`;
  if (!selected.length) $("scopeSelectionSummary").textContent = "선택된 권한이 없습니다.";
  else if (writes.length) $("scopeSelectionSummary").textContent = `${selected.length}개 선택 · 쓰기 권한 ${writes.length}개 포함`;
  else $("scopeSelectionSummary").textContent = `읽기 권한 ${selected.length}개가 선택되었습니다.`;
}

function updateTokenModeHelp() {
  const live = $("tokenMode")?.value === "live";
  $("tokenModeHelp").textContent = live
    ? "Live에서는 허용한 작업이 실제 실행되며 기존 플랜·크레딧·사용 한도 규칙이 적용됩니다."
    : "Test에서는 읽기·계산은 실제로 확인하고, 쓰기 작업은 저장·생성·과금 없이 시뮬레이션합니다.";
}

async function loadTokens() {
  try {
    const data = await api("/api/integrations/tokens");
    const scopeTotal = Array.isArray(data.scopeDefinitions) ? data.scopeDefinitions.length : scopeInputs().length;
    $("scopeCount").textContent = `${scopeTotal}개 권한`;
    renderTokens(data.tokens || []);
  } catch (error) {
    $("tokenMessage").textContent = error.message;
  }
}

async function createToken() {
  if (!state.loggedIn) return;
  const scopes = scopeInputs().filter((input) => input.checked).map((input) => input.value);
  if (!scopes.length) {
    $("tokenMessage").textContent = "연결에 필요한 권한을 한 개 이상 선택해 주세요.";
    document.querySelector(".scope-disclosure")?.setAttribute("open", "");
    return;
  }
  $("createTokenBtn").disabled = true;
  $("createTokenBtn").setAttribute("aria-busy", "true");
  $("tokenMessage").textContent = "토큰 생성 중…";
  try {
    const data = await api("/api/integrations/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: $("tokenName").value.trim(),
        expiresInDays: Number($("tokenDays").value),
        mode: $("tokenMode").value,
        scopes,
      }),
    });
    $("tokenSecret").hidden = false;
    $("tokenValue").textContent = data.token;
    $("tokenMessage").textContent = "토큰을 만들었습니다. 이 페이지를 떠나기 전에 복사하세요.";
    await loadTokens();
  } catch (error) {
    $("tokenMessage").textContent = error.message;
  } finally {
    $("createTokenBtn").disabled = false;
    $("createTokenBtn").removeAttribute("aria-busy");
  }
}

async function copyToken() {
  const value = $("tokenValue").textContent;
  if (!value) return;
  const copied = await copyText(value);
  if (copied) {
    const original = $("copyTokenBtn").textContent;
    $("copyTokenBtn").textContent = "복사됨";
    setTimeout(() => { $("copyTokenBtn").textContent = original; }, 1200);
  } else {
    $("tokenMessage").textContent = "자동 복사에 실패했습니다. 토큰을 직접 선택해 복사해 주세요.";
  }
}

async function copyElementText(button) {
  const target = $(button.dataset.copyTarget);
  if (!target) return;
  const value = target.textContent.trim();
  if (!value) return;
  const original = button.textContent;
  const copied = await copyText(value);
  button.textContent = copied ? "복사됨" : "복사 실패";
  setTimeout(() => { button.textContent = original; }, 1200);
}

async function copyText(value) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(value);
    return true;
  } catch (_) {
    return false;
  }
}

function renderTokens(tokens) {
  if (!tokens.length) {
    $("tokenList").innerHTML = "<p class='dev-muted'>아직 발급한 토큰이 없습니다.</p>";
    return;
  }
  $("tokenList").innerHTML = tokens.map((token) => `<div class="token-row"><div><b>${escapeHtml(token.name)}</b> <span class="badge ${token.mode === "test" ? "beta" : "active"}">${token.mode === "test" ? "TEST" : "LIVE"}</span> <small>quilo_${escapeHtml(token.mode || "live")}_${escapeHtml(token.prefix)}_…</small><br /><small>${escapeHtml((token.scopes || []).join(" · "))} · ${formatDate(token.expiresAt)} 만료${token.revokedAt ? " · 폐기됨" : ""}</small></div>${token.revokedAt ? "" : `<button type="button" data-revoke="${escapeAttr(token.id)}">폐기</button>`}</div>`).join("");
  document.querySelectorAll("[data-revoke]").forEach((button) => button.addEventListener("click", () => revokeToken(button.dataset.revoke)));
}

async function loadApiRequests() {
  if (!state.loggedIn) return;
  const button = $("refreshLogsBtn");
  if (button?.getAttribute("aria-busy") === "true") return;
  const original = button?.textContent || "새로고침";
  if (button) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "불러오는 중…";
  }
  try {
    const data = await api("/api/integrations/api-requests?limit=50");
    const rows = data.requests || [];
    $("apiLogBody").innerHTML = rows.length ? rows.map((item) => {
      const ok = Number(item.status) < 400;
      return `<tr><td>${escapeHtml(formatDateTime(item.createdAt))}</td><td><b>${escapeHtml(item.method)}</b> <code>${escapeHtml(item.path)}</code><br /><small>${escapeHtml(item.scope)}</small></td><td class="${ok ? "status-ok" : "status-error"}">${escapeHtml(item.status)}</td><td>${escapeHtml(item.durationMs)} ms</td><td>${escapeHtml(item.errorCode || "-")}</td><td><code>${escapeHtml(item.requestId)}</code></td></tr>`;
    }).join("") : "<tr><td colspan='6' class='dev-muted'>아직 기록된 API 요청이 없습니다.</td></tr>";
  } catch (error) {
    $("apiLogBody").innerHTML = `<tr><td colspan="6" class="status-error">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = original;
    }
  }
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

async function revokeToken(id) {
  if (!confirm("이 토큰을 즉시 폐기할까요?")) return;
  try {
    await api(`/api/integrations/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    await loadTokens();
  } catch (error) {
    $("tokenMessage").textContent = error.message;
  }
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
