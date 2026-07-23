import { requestJson } from "./api.js";
import { byId } from "./dom-contract.js";
import { createGoogleWorkspaceController } from "./google-workspace-controller.js";
import { trackEvent } from "./telemetry.js";

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

export function createFilesController({ hooks }) {
  const googleWorkspace = createGoogleWorkspaceController({ hooks });

  function applyFileFilter() {
    const input = byId("filesFilter");
    const list = byId("filesList");
    const empty = byId("filesFilterEmpty");
    if (!input || !list) return;
    const query = input.value.trim().toLowerCase();
    let visible = 0;
    list.querySelectorAll(".file-item").forEach((item) => {
      const match = !query || (item.dataset.fileSearch || "").includes(query);
      item.hidden = !match;
      if (match) visible += 1;
    });
    if (empty) empty.hidden = !query || visible > 0;
  }

  async function loadCloudStatus() {
    const card = byId("cloudCard");
    const status = byId("cloudStatus");
    const actions = byId("cloudActions");
    if (!card || !status || !actions) return;
    try {
      const { integrations = {} } = await requestJson("/api/cloud/providers/status");
      try { await googleWorkspace.setIntegration(integrations.google || null); }
      catch (_) { /* 연결 카드는 유지하고 Google 작업 영역에 오류를 표시한다. */ }
      const entries = [
        ["dropbox", "Dropbox", "보고서 영구 보관"],
        ["google", "Google Drive·Docs", "파일 업로드·문서 생성"],
        ["notion", "Notion", "Markdown 페이지 생성"],
      ].filter(([key]) => integrations[key]?.configured);
      card.hidden = !entries.length;
      if (!entries.length) return;
      status.textContent = entries.some(([key]) => integrations[key].connected)
        ? "연결된 서비스는 계정 단위로 안전하게 저장됩니다."
        : "아직 연결된 외부 서비스가 없습니다.";
      const rows = entries.map(([key, label, purpose]) => {
        const info = integrations[key];
        const row = document.createElement("div");
        row.className = "cloud-provider-row";
        const copy = document.createElement("div");
        const title = document.createElement("b");
        title.textContent = `${info.connected ? "✓" : "○"} ${label}`;
        const detail = document.createElement("div");
        detail.className = "hint";
        detail.textContent = info.connected
          ? `${info.accountEmail || info.accountName || "연결됨"} · ${purpose}`
          : purpose;
        copy.append(title, detail);
        let action;
        if (info.connected) {
          action = document.createElement("div");
          action.className = "cloud-provider-actions";
          const reconnect = document.createElement("a");
          reconnect.className = "secondary compact";
          reconnect.href = info.reconnectUrl || `${info.connectUrl}?reconnect=1`;
          reconnect.textContent = "재연결";
          const disconnect = document.createElement("button");
          disconnect.className = "secondary compact danger-outline";
          disconnect.type = "button";
          disconnect.textContent = "연결 해제";
          disconnect.addEventListener("click", async () => {
            if (!confirm(`${label} 연결을 해제할까요?`)) return;
            disconnect.disabled = true;
            try {
              await requestJson(info.disconnectUrl || `/api/cloud/${key}/disconnect`, { method: "POST" });
              await loadCloudStatus();
              if (key === "dropbox") await loadFiles();
            } catch (error) {
              status.textContent = error.message || "연결 해제에 실패했습니다.";
              status.dataset.tone = "danger";
            } finally {
              disconnect.disabled = false;
            }
          });
          action.append(reconnect, disconnect);
        } else {
          action = document.createElement("a");
          action.className = "btn btn-primary";
          action.textContent = "연결";
          action.href = /electron|quilo/i.test(navigator.userAgent || "")
            ? `https://quilolab.com${info.connectUrl}`
            : info.connectUrl;
          if (/electron|quilo/i.test(navigator.userAgent || "")) {
            action.target = "_blank";
            action.rel = "noopener";
            action.textContent = "웹에서 연결";
          }
        }
        row.append(copy, action);
        return row;
      });
      actions.replaceChildren(...rows);
    } catch (_) {
      card.hidden = true;
    }
  }

  async function loadFiles() {
    const status = byId("filesStatus");
    const list = byId("filesList");
    const summary = byId("workspaceFilesSummary");
    if (!status || !list) return;
    hooks.renderPremiumBadge?.();
    hooks.renderBackgroundJobs?.();
    status.textContent = "불러오는 중...";
    if (summary) summary.textContent = "최근 파일 확인 중...";
    list.replaceChildren();
    try {
      const data = await requestJson("/api/me/files");
      if (!googleWorkspace.connected()) {
        try {
          const { integrations = {} } = await requestJson("/api/cloud/providers/status");
          await googleWorkspace.setIntegration(integrations.google || null);
        } catch (_) {}
      }
      if (!data.storage) {
        status.textContent = "파일 저장소가 아직 설정되지 않았습니다.";
        if (summary) summary.textContent = status.textContent;
        return;
      }
      const cloud = data.cloud === "dropbox";
      const files = Array.isArray(data.files) ? data.files : [];
      const max = data.maxFilesPerUser || 3;
      if (!files.length) {
        status.textContent = cloud ? "Dropbox에 보관된 보고서가 없습니다." : `보관 중인 파일이 없습니다. 최대 ${max}개까지 저장됩니다.`;
        if (summary) summary.textContent = "최근 생성 파일이 없습니다.";
        return;
      }
      status.textContent = cloud ? `${files.length}개 · Dropbox에 영구 저장` : `${files.length}/${max}개 보관 중`;
      if (summary) summary.textContent = cloud ? `${files.length}개 파일 · Dropbox 저장` : `${files.length}/${max}개 파일 · 24시간 보관`;
      files.forEach((file) => {
        const item = document.createElement("div");
        item.className = "file-item";
        item.dataset.fileSearch = [file.filename, file.created_at, file.expires_at].filter(Boolean).join(" ").toLowerCase();
        const meta = document.createElement("div");
        meta.className = "file-meta";
        const name = document.createElement("strong");
        name.textContent = file.filename || "보고서";
        const detail = document.createElement("span");
        detail.textContent = cloud
          ? `${formatBytes(file.size_bytes)} · ${formatDateTime(file.created_at)} 생성 · Dropbox`
          : `${formatBytes(file.size_bytes)} · ${formatDateTime(file.created_at)} 생성 · ${formatDateTime(file.expires_at)} 만료`;
        meta.append(name, detail);
        const actions = document.createElement("div");
        actions.className = "file-actions";
        const download = document.createElement("a");
        download.href = cloud ? file.download_url || "#" : `/api/me/files/${file.id}/download`;
        download.textContent = cloud && !file.download_url ? "링크 없음" : "다운로드";
        if (cloud) { download.target = "_blank"; download.rel = "noopener"; }
        else download.download = file.filename || "";
        download.addEventListener("click", () => {
          trackEvent("download_clicked", { source: cloud ? "dropbox_files" : "saved_files" });
        });
        if (!cloud) {
          const preview = document.createElement("a");
          preview.href = `/api/me/files/${file.id}/preview`;
          preview.textContent = "미리보기";
          preview.target = "_blank";
          preview.rel = "noopener";
          preview.addEventListener("click", () => {
            trackEvent("preview_clicked", { source: "saved_files" });
          });
          actions.append(preview);
        }
        actions.append(download);
        if (!cloud) {
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "secondary compact";
          remove.textContent = "삭제";
          remove.addEventListener("click", async () => {
            const allowed = hooks.confirmFileDelete
              ? await hooks.confirmFileDelete(file)
              : confirm(`${file.filename || "보고서"} 파일을 삭제할까요?`);
            if (!allowed) return;
            await requestJson(`/api/me/files/${file.id}`, { method: "DELETE" });
            await loadFiles();
          });
          actions.append(remove);
        }
        googleWorkspace.decorateReportActions(file, actions);
        item.append(meta, actions);
        list.append(item);
      });
      applyFileFilter();
    } catch (error) {
      status.textContent = error.message || "파일 목록을 불러오지 못했습니다.";
      if (summary) summary.textContent = "파일함을 불러오지 못했습니다.";
    }
  }

  function init() {
    byId("filesFilter")?.addEventListener("input", applyFileFilter);
    googleWorkspace.init();
  }

  return { init, loadFiles, loadCloudStatus, applyFileFilter };
}
