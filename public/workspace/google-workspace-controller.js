import { jsonOptions, requestJson } from "./api.js";
import { byId } from "./dom-contract.js";

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && /(^|\.)google\.com$|(^|\.)googleusercontent\.com$/.test(url.hostname)
      ? url.href
      : "";
  } catch (_) {
    return "";
  }
}

function compactDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
}

function button(label, onClick, className = "secondary compact") {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

export function createGoogleWorkspaceController({ hooks }) {
  let integration = null;
  let files = [];

  function connected() {
    return integration?.connected === true;
  }

  function setStatus(message, tone = "muted") {
    const status = byId("googleWorkspaceStatus");
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function selectedFolderId() {
    return byId("googleDriveFolder")?.value || "";
  }

  async function loadFolders() {
    const select = byId("googleDriveFolder");
    if (!select || !connected()) return;
    let previous = select.value;
    try { previous = previous || localStorage.getItem("quilo.googleDrive.folderId") || ""; } catch (_) {}
    const { folders = [] } = await requestJson("/api/cloud/google/drive/folders?limit=100");
    const root = document.createElement("option");
    root.value = "";
    root.textContent = "Quilo 기본 폴더 (자동 생성)";
    const options = folders.map((folder) => {
      const option = document.createElement("option");
      option.value = folder.id;
      option.textContent = folder.name || "이름 없는 폴더";
      return option;
    });
    select.replaceChildren(root, ...options);
    if (options.some((option) => option.value === previous)) select.value = previous;
  }

  function renderComments(file, comments) {
    const title = byId("googleCommentTarget");
    const list = byId("googleCommentsList");
    if (title) title.textContent = `${file.name || "파일"} 댓글`;
    if (byId("googleCommentFileId")) byId("googleCommentFileId").value = file.id;
    if (!list) return;
    if (!comments.length) {
      list.textContent = "아직 댓글이 없습니다.";
      return;
    }
    const rows = comments.map((comment) => {
      const row = document.createElement("article");
      row.className = "google-comment";
      const meta = document.createElement("b");
      meta.textContent = `${comment.author?.displayName || "Google 사용자"} · ${compactDate(comment.createdTime)}${comment.resolved ? " · 해결됨" : ""}`;
      const content = document.createElement("p");
      content.textContent = comment.content || "";
      row.append(meta, content);
      (comment.replies || []).forEach((reply) => {
        const replyNode = document.createElement("p");
        replyNode.className = "google-comment-reply";
        replyNode.textContent = `↳ ${reply.author?.displayName || "Google 사용자"}: ${reply.content || ""}`;
        row.append(replyNode);
      });
      if (!comment.resolved) {
        row.append(button("해결 처리", async (event) => {
          const target = event.currentTarget;
          target.disabled = true;
          try {
            await requestJson(`/api/cloud/google/drive/files/${encodeURIComponent(file.id)}/comments/${encodeURIComponent(comment.id)}/replies`, jsonOptions("POST", { resolve: true }));
            await loadComments(file);
          } catch (error) {
            setStatus(error.message, "danger");
          } finally {
            target.disabled = false;
          }
        }));
      }
      return row;
    });
    list.replaceChildren(...rows);
  }

  async function loadComments(file) {
    setStatus(`${file.name || "파일"} 댓글을 불러오는 중…`, "progress");
    const { comments = [] } = await requestJson(`/api/cloud/google/drive/files/${encodeURIComponent(file.id)}/comments`);
    renderComments(file, comments);
    byId("googleCommentsPanel")?.removeAttribute("hidden");
    setStatus(`댓글 ${comments.length}개를 불러왔습니다.`, "success");
  }

  function renderFiles() {
    const list = byId("googleDriveFiles");
    if (!list) return;
    if (!files.length) {
      list.textContent = "Quilo가 접근할 수 있는 Drive 파일이 없습니다. 파일을 업로드하거나 Google Docs를 만들어 보세요.";
      return;
    }
    const rows = files.map((file) => {
      const row = document.createElement("article");
      row.className = "google-drive-file";
      const copy = document.createElement("div");
      copy.className = "google-drive-file__copy";
      const name = document.createElement("strong");
      name.textContent = file.name || "이름 없는 파일";
      const meta = document.createElement("span");
      meta.textContent = `${file.mimeType === GOOGLE_DOC_MIME ? "Google Docs" : file.mimeType || "파일"}${file.modifiedTime ? ` · ${compactDate(file.modifiedTime)}` : ""}`;
      copy.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "google-drive-file__actions";
      const viewUrl = safeExternalUrl(file.webViewLink);
      if (viewUrl) {
        const open = document.createElement("a");
        open.className = "secondary compact";
        open.href = viewUrl;
        open.target = "_blank";
        open.rel = "noopener";
        open.textContent = "Google에서 열기";
        actions.append(open);
      }
      const download = document.createElement("a");
      download.className = "secondary compact";
      download.href = `/api/cloud/google/drive/files/${encodeURIComponent(file.id)}/download`;
      download.textContent = file.mimeType === GOOGLE_DOC_MIME ? "DOCX 받기" : "다운로드";
      actions.append(download);
      actions.append(button("Quilo로 가져오기", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        try {
          await requestJson(`/api/cloud/google/drive/files/${encodeURIComponent(file.id)}/import`, jsonOptions("POST", {}));
          setStatus("내 파일에 24시간 보관했습니다.", "success");
          await hooks.filesController?.loadFiles?.();
        } catch (error) { setStatus(error.message, "danger"); }
        finally { target.disabled = false; }
      }));
      actions.append(button("사본", async (event) => {
        const target = event.currentTarget;
        target.disabled = true;
        try {
          await requestJson(`/api/cloud/google/drive/files/${encodeURIComponent(file.id)}/copy`, jsonOptions("POST", { name: `${file.name || "Quilo 파일"} 사본`, folderId: selectedFolderId() }));
          await loadFiles();
          setStatus("Drive 사본을 만들었습니다.", "success");
        } catch (error) { setStatus(error.message, "danger"); }
        finally { target.disabled = false; }
      }));
      actions.append(button("댓글", () => loadComments(file).catch((error) => setStatus(error.message, "danger"))));
      if (file.mimeType === GOOGLE_DOC_MIME) {
        actions.append(button("본문 추가", () => {
          if (byId("googleAppendDocumentId")) byId("googleAppendDocumentId").value = file.id;
          byId("googleAppendText")?.focus();
        }));
      }
      row.append(copy, actions);
      return row;
    });
    list.replaceChildren(...rows);
  }

  async function loadFiles() {
    if (!connected()) return;
    const query = byId("googleDriveSearch")?.value.trim() || "";
    setStatus("Google Drive 파일을 불러오는 중…", "progress");
    const params = new URLSearchParams({ limit: "100" });
    if (query) params.set("q", query);
    const data = await requestJson(`/api/cloud/google/drive/files?${params}`);
    files = Array.isArray(data.files) ? data.files : [];
    renderFiles();
    setStatus(`${files.length}개 파일 · drive.file 최소 권한`, "success");
  }

  async function setIntegration(info) {
    integration = info || null;
    const panel = byId("googleWorkspace");
    if (panel) panel.hidden = !connected();
    if (!connected()) {
      files = [];
      renderFiles();
      const autoSave = byId("googleAutoSaveReports");
      if (autoSave) autoSave.checked = false;
      try { localStorage.setItem("quilo.googleDrive.autoSaveReports", "0"); } catch (_) {}
      return;
    }
    const results = await Promise.allSettled([loadFolders(), loadFiles()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) setStatus(failure.reason?.message || "Google Workspace 정보를 불러오지 못했습니다.", "danger");
  }

  function openGoogleFile(file) {
    const url = safeExternalUrl(file?.webViewLink);
    if (url) window.open(url, "_blank", "noopener");
  }

  async function saveReport(file, convertToGoogleDoc, trigger) {
    trigger.disabled = true;
    const original = trigger.textContent;
    trigger.textContent = "저장 중…";
    try {
      const data = await requestJson(`/api/cloud/google/drive/reports/${encodeURIComponent(file.id)}`, jsonOptions("POST", { convertToGoogleDoc }));
      const status = byId("googleReportStatus");
      if (status) {
        status.textContent = data.reused ? "이미 저장된 Google 파일을 열었습니다." : convertToGoogleDoc ? "Google Docs로 변환했습니다." : data.updated ? "Drive 파일을 최신 버전으로 갱신했습니다." : "Drive에 저장했습니다.";
        status.dataset.tone = "success";
      }
      openGoogleFile(data.file);
    } catch (error) {
      const status = byId("googleReportStatus");
      if (status) { status.textContent = error.message; status.dataset.tone = "danger"; }
    } finally {
      trigger.disabled = false;
      trigger.textContent = original;
    }
  }

  function decorateReportActions(file, actions) {
    if (!connected() || file.cloud || !file.id) return;
    actions.append(button("Drive 저장", (event) => saveReport(file, false, event.currentTarget)));
    if (/\.docx$/i.test(file.filename || "")) {
      actions.append(button("Google Docs", (event) => saveReport(file, true, event.currentTarget)));
    }
  }

  function init() {
    const autoSave = byId("googleAutoSaveReports");
    if (autoSave) {
      try { autoSave.checked = localStorage.getItem("quilo.googleDrive.autoSaveReports") === "1"; } catch (_) {}
      autoSave.addEventListener("change", () => {
        try { localStorage.setItem("quilo.googleDrive.autoSaveReports", autoSave.checked ? "1" : "0"); } catch (_) {}
      });
    }
    byId("googleDriveFolder")?.addEventListener("change", (event) => {
      try { localStorage.setItem("quilo.googleDrive.folderId", event.currentTarget.value || ""); } catch (_) {}
    });
    byId("googleDriveSearchForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      loadFiles().catch((error) => setStatus(error.message, "danger"));
    });
    byId("googleDriveReload")?.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message, "danger")));
    byId("googleDriveFolderForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = byId("googleDriveFolderName");
      const name = input?.value.trim() || "";
      if (!name) return;
      try {
        const { folder } = await requestJson("/api/cloud/google/drive/folders", jsonOptions("POST", { name }));
        if (input) input.value = "";
        await loadFolders();
        if (byId("googleDriveFolder")) byId("googleDriveFolder").value = folder.id;
        setStatus("새 Drive 폴더를 만들었습니다.", "success");
      } catch (error) { setStatus(error.message, "danger"); }
    });
    byId("googleDriveUploadForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = byId("googleDriveUploadFile");
      const file = input?.files?.[0];
      if (!file) return;
      const form = new FormData();
      form.append("file", file);
      form.append("folderId", selectedFolderId());
      form.append("useQuiloFolder", selectedFolderId() ? "false" : "true");
      form.append("convertToGoogleDoc", byId("googleDriveConvertDoc")?.checked ? "true" : "false");
      setStatus("Drive에 업로드하는 중…", "progress");
      try {
        const data = await requestJson("/api/cloud/google/drive/upload", { method: "POST", body: form });
        event.currentTarget.reset();
        await loadFiles();
        setStatus(data.updated ? "Drive 파일을 갱신했습니다." : "Drive 업로드를 완료했습니다.", "success");
        openGoogleFile(data.file);
      } catch (error) { setStatus(error.message, "danger"); }
    });
    byId("googleDocCreateForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = byId("googleDocTitle")?.value.trim() || "";
      const text = byId("googleDocText")?.value || "";
      if (!title || !text.trim()) return;
      setStatus("Google Docs 문서를 만드는 중…", "progress");
      try {
        const data = await requestJson("/api/cloud/google/docs", jsonOptions("POST", { title, text, folderId: selectedFolderId() }));
        event.currentTarget.reset();
        await loadFiles();
        setStatus("Google Docs 문서를 만들었습니다.", "success");
        openGoogleFile({ webViewLink: data.document.url });
      } catch (error) { setStatus(error.message, "danger"); }
    });
    byId("googleDocAppendForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const documentId = byId("googleAppendDocumentId")?.value.trim() || "";
      const text = byId("googleAppendText")?.value || "";
      if (!documentId || !text.trim()) return;
      try {
        const data = await requestJson(`/api/cloud/google/docs/${encodeURIComponent(documentId)}/append`, jsonOptions("POST", { text }));
        if (byId("googleAppendText")) byId("googleAppendText").value = "";
        setStatus("Google Docs 끝에 본문을 추가했습니다.", "success");
        openGoogleFile({ webViewLink: data.document.url });
      } catch (error) { setStatus(error.message, "danger"); }
    });
    byId("googleCommentForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const fileId = byId("googleCommentFileId")?.value || "";
      const content = byId("googleCommentText")?.value.trim() || "";
      const quotedText = byId("googleCommentQuote")?.value.trim() || "";
      if (!fileId || !content) return;
      try {
        await requestJson(`/api/cloud/google/drive/files/${encodeURIComponent(fileId)}/comments`, jsonOptions("POST", { content, quotedText }));
        if (byId("googleCommentText")) byId("googleCommentText").value = "";
        const file = files.find((item) => item.id === fileId) || { id: fileId, name: "파일" };
        await loadComments(file);
        setStatus("Google Drive 댓글을 작성했습니다.", "success");
      } catch (error) { setStatus(error.message, "danger"); }
    });
  }

  return { connected, decorateReportActions, init, loadFiles, setIntegration };
}
