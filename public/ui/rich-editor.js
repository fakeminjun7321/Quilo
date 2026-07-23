"use strict";

(function initRichEditor() {
  const Q = window.QuiloEditorial;
  if (!Q || document.body?.dataset.editorialPage !== "write") return;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const LOCAL_PREFIX = "quilo.editorial.draft.v2.";
  const MAX_ATTACHMENT_SIZE = 8 * 1024 * 1024;
  const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
  const params = new URLSearchParams(location.search);
  const requestedId = params.get("id") || "";
  const requestedKind = params.get("kind") === "resource" ? "resource" : "developer";
  const allowedExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "pdf", "zip", "docx", "xlsx", "pptx", "hwpx", "xls", "hwp", "txt", "md", "csv"]);

  const editor = $("#editorBody");
  const title = $("#editorTitle");
  const summary = $("#editorSummary");
  const kindSelect = $("#kindSelect");
  const categorySelect = $("#categorySelect");
  const tags = $("#tagInput");
  const slug = $("#slugInput");
  const saveState = $("#saveState");
  const shell = $("#editorShell");
  const denied = $("#editorDenied");
  const uploadStatus = $("#uploadStatus");
  const attachmentList = $("#attachmentList");
  let session = null;
  let postId = requestedId;
  let postSlug = "";
  let postStatus = "draft";
  let attachments = [];
  let coverUrl = "";
  let remoteUpdatedAt = 0;
  let dirty = false;
  let slugTouched = false;
  let localTimer = null;
  let localSavedAt = 0;
  let savedRange = null;
  let uploadInFlight = 0;

  const categories = {
    developer: ["Quilo 활용", "개발", "보고서 작성", "새 소식"],
    resource: ["화학", "물리", "보고서 양식", "학습 자료", "도구", "기타"],
  };

  function setSaveState(text, state = "") {
    saveState.className = `ed-save-state${state ? ` is-${state}` : ""}`;
    $("span", saveState).textContent = text;
  }

  function canWrite(kind) {
    return kind === "resource"
      ? Boolean(session?.capabilities?.writeResources)
      : Boolean(session?.capabilities?.writeDeveloperNotes);
  }

  function localKey() {
    return `${LOCAL_PREFIX}${postId || `new.${kindSelect.value || requestedKind}`}`;
  }

  function slugify(value) {
    return String(value || "").normalize("NFKC").toLocaleLowerCase("ko-KR")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 100);
  }

  function tagsArray() {
    const seen = new Set();
    return tags.value.split(",").map((tag) => tag.trim().replace(/^#+/, "")).filter((tag) => {
      const key = tag.toLocaleLowerCase("ko-KR");
      if (!tag || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 8);
  }

  function currentPayload(status = postStatus) {
    return {
      kind: kindSelect.value,
      title: title.value.trim(),
      slug: slug.value.trim(),
      excerpt: summary.value.trim(),
      richHtml: Q.sanitizeHtml(editor.innerHTML),
      coverImage: coverUrl || null,
      category: categorySelect.value,
      tags: tagsArray(),
      status,
    };
  }

  function localSnapshot() {
    return {
      version: 2,
      savedAt: Date.now(),
      postId,
      ...currentPayload(postStatus),
      attachments: attachments.map((file) => file.raw || file),
    };
  }

  function saveLocal() {
    clearTimeout(localTimer);
    localTimer = setTimeout(() => {
      try {
        const snapshot = localSnapshot();
        localStorage.setItem(localKey(), JSON.stringify(snapshot));
        localSavedAt = snapshot.savedAt;
        if (dirty) setSaveState("로컬에 자동 저장됨", "saved");
      } catch (_) { setSaveState("자동 저장 공간이 부족합니다", "error"); }
    }, 700);
  }

  function markDirty() {
    dirty = true;
    setSaveState("저장되지 않은 변경", "saving");
    saveLocal();
    updateCount();
  }

  function removeLocal() {
    try {
      localStorage.removeItem(localKey());
      localStorage.removeItem(`${LOCAL_PREFIX}new.${kindSelect.value}`);
    } catch (_) { /* no-op */ }
  }

  function readLocal(key = localKey()) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && value.version === 2 ? value : null;
    } catch (_) { return null; }
  }

  function applySnapshot(data, { fromRemote = false } = {}) {
    if (!data) return;
    const normalized = data.raw ? data : Q.normalizePost(data.post || data);
    const raw = normalized.raw ? normalized : data;
    const kind = normalized.kind || raw.kind || requestedKind;
    updateKind(kind, false);
    title.value = normalized.title === "제목 없음" ? "" : (normalized.title || raw.title || "");
    summary.value = normalized.summary ?? raw.excerpt ?? "";
    slug.value = normalized.slug || raw.slug || "";
    slugTouched = Boolean(slug.value);
    const category = normalized.category || raw.category || categories[kind][0];
    if ([...categorySelect.options].some((option) => option.value === category)) categorySelect.value = category;
    const tagValues = normalized.tags?.length ? normalized.tags : (Array.isArray(raw.tags) ? raw.tags : []);
    tags.value = tagValues.join(", ");
    const html = normalized.richHtml ?? raw.richHtml ?? raw.rich_html ?? "";
    editor.innerHTML = Q.sanitizeHtml(html) || "<p><br></p>";
    coverUrl = normalized.coverUrl ?? raw.coverImage ?? raw.cover_image ?? "";
    postStatus = normalized.status || raw.status || "draft";
    postSlug = normalized.slug || raw.slug || "";
    const fileRows = data.attachments || normalized.attachments || raw.attachments || [];
    attachments = fileRows.map(Q.normalizeAttachment);
    renderCover();
    renderAttachments();
    updateCount();
    if (!fromRemote) markDirty();
  }

  function updateKind(kind, mark = true) {
    const safeKind = kind === "resource" ? "resource" : "developer";
    kindSelect.value = safeKind;
    $("#editorKindLabel").textContent = safeKind === "resource" ? "자료실" : "개발 노트";
    $("#leaveEditor").href = safeKind === "resource" ? "/resources.html" : "/developer-notes.html";
    categorySelect.replaceChildren();
    for (const category of categories[safeKind]) {
      const option = document.createElement("option"); option.value = category; option.textContent = category; categorySelect.append(option);
    }
    if (mark) markDirty();
  }

  function updateCount() {
    const text = editor.innerText.replace(/\u200b/g, "").trim();
    const chars = Array.from(text).length;
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    $("#wordCount").textContent = `${chars.toLocaleString("ko-KR")}자 · ${words.toLocaleString("ko-KR")}단어`;
  }

  function renderCover() {
    const root = $("#coverEditor");
    const button = $("#coverButton");
    const figure = $("figure", root);
    if (coverUrl) {
      $("img", figure).src = Q.safeUrl(coverUrl, { image: true });
      button.hidden = true;
      figure.hidden = false;
    } else {
      button.hidden = false;
      figure.hidden = true;
      $("img", figure).removeAttribute("src");
    }
  }

  function renderAttachments() {
    attachmentList.replaceChildren();
    if (!attachments.length) {
      const empty = document.createElement("p"); empty.textContent = "첨부된 파일이 없습니다."; attachmentList.append(empty); return;
    }
    for (const file of attachments) {
      const row = document.createElement("div"); row.className = "ed-editor-attachment";
      const copy = document.createElement("div");
      const name = document.createElement("span"); name.textContent = file.filename;
      const size = document.createElement("small"); size.textContent = Q.formatBytes(file.size);
      copy.append(name, size);
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "삭제"; remove.setAttribute("aria-label", `${file.filename} 삭제`);
      remove.addEventListener("click", () => deleteAttachment(file, remove));
      row.append(copy, remove); attachmentList.append(row);
    }
  }

  async function deleteAttachment(file, button) {
    if (!file.id || !confirm(`'${file.filename}' 파일을 삭제할까요?`)) return;
    button.disabled = true;
    try {
      await Q.api(`/attachments/${encodeURIComponent(file.id)}`, { method: "DELETE" });
      attachments = attachments.filter((item) => item.id !== file.id);
      if (coverUrl && (coverUrl === file.inlineUrl || coverUrl.includes(`/attachments/${file.id}/`))) coverUrl = "";
      $$('img', editor).forEach((image) => {
        if (image.src === new URL(file.inlineUrl || "/", location.origin).href || image.src.includes(`/attachments/${file.id}/`)) image.closest("figure")?.remove() || image.remove();
      });
      renderAttachments(); renderCover(); markDirty();
      await saveToServer("draft", { silent: true });
      Q.showToast("첨부 파일을 삭제했습니다.");
    } catch (error) { Q.showToast(error.message, true); button.disabled = false; }
  }

  function validateForSave(status) {
    if (!title.value.trim()) { title.focus(); throw new Error("제목을 입력하세요."); }
    if (!canWrite(kindSelect.value)) throw new Error(kindSelect.value === "resource" ? "자료실 글쓰기 권한이 없습니다." : "개발 노트 글쓰기 권한이 없습니다.");
    if (status === "published" && !editor.innerText.replace(/\u200b/g, "").trim() && !$('img', editor)) { editor.focus(); throw new Error("발행할 본문 내용을 입력하세요."); }
    if (tagsArray().length > 8) throw new Error("태그는 8개까지 입력할 수 있습니다.");
  }

  async function saveToServer(status = "draft", { silent = false } = {}) {
    validateForSave(status);
    setSaveState(status === "published" ? "발행 중" : "저장 중", "saving");
    $("#saveDraftButton").disabled = true;
    $("#publishButton").disabled = true;
    try {
      const previousKey = localKey();
      const payload = currentPayload(status);
      const result = postId
        ? await Q.api(`/posts/${encodeURIComponent(postId)}`, { method: "PATCH", body: payload })
        : await Q.api("/posts", { method: "POST", body: payload });
      const post = Q.normalizePost(result?.post || result?.data?.post || result?.data || result);
      if (!post.id) throw new Error("저장된 글 정보를 확인하지 못했습니다.");
      postId = post.id;
      postSlug = post.slug;
      postStatus = post.status || status;
      remoteUpdatedAt = Date.now();
      dirty = false;
      try {
        localStorage.removeItem(previousKey);
        localStorage.removeItem(`${LOCAL_PREFIX}new.${kindSelect.value}`);
      } catch (_) { /* no-op */ }
      const nextUrl = new URL(location.href);
      nextUrl.search = `?id=${encodeURIComponent(postId)}`;
      history.replaceState({}, "", nextUrl);
      setSaveState(status === "published" ? "발행됨" : "저장됨", "saved");
      if (!silent) Q.showToast(status === "published" ? "글을 발행했습니다." : "초안을 저장했습니다.");
      if (status === "published") {
        removeLocal();
        setTimeout(() => { location.href = `/article.html?slug=${encodeURIComponent(postSlug)}`; }, 420);
      }
      return post;
    } catch (error) {
      setSaveState("저장 실패", "error");
      if (!silent) Q.showToast(error.message, true);
      throw error;
    } finally {
      $("#saveDraftButton").disabled = false;
      $("#publishButton").disabled = false;
    }
  }

  async function ensureDraft() {
    if (postId) return postId;
    if (!title.value.trim()) { title.focus(); throw new Error("파일을 첨부하기 전에 제목을 입력해 주세요."); }
    await saveToServer("draft", { silent: true });
    return postId;
  }

  function uploadFile(file, onProgress) {
    return new Promise(async (resolve, reject) => {
      try { await ensureDraft(); } catch (error) { reject(error); return; }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${Q.API_ROOT}/posts/${encodeURIComponent(postId)}/attachments`);
      xhr.withCredentials = true;
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) onProgress?.(Math.round(event.loaded / event.total * 100));
      });
      xhr.addEventListener("load", () => {
        let payload = null;
        try { payload = JSON.parse(xhr.responseText || "null"); } catch (_) { /* no-op */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(Q.normalizeAttachment(payload?.attachment || payload?.data?.attachment || payload));
        else reject(new Error(payload?.error || payload?.message || `업로드하지 못했습니다. (${xhr.status})`));
      });
      xhr.addEventListener("error", () => reject(new Error("네트워크 문제로 파일을 업로드하지 못했습니다.")));
      xhr.addEventListener("abort", () => reject(new Error("파일 업로드가 취소되었습니다.")));
      const data = new FormData(); data.append("file", file); xhr.send(data);
    });
  }

  function validateFile(file, imageOnly = false) {
    if (!file || !file.name) return "파일을 읽을 수 없습니다.";
    if (file.size > MAX_ATTACHMENT_SIZE) return "첨부 파일은 8MB 이하여야 합니다.";
    const extension = file.name.split(".").pop().toLowerCase();
    if (!allowedExtensions.has(extension)) return "지원하지 않는 파일 형식입니다.";
    if (imageOnly && !IMAGE_TYPES.has(file.type)) return "JPG, PNG, GIF, WebP 이미지만 사용할 수 있습니다.";
    return "";
  }

  async function uploadFiles(files, mode) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const isImageMode = mode === "image" || mode === "cover";
    for (const file of list) {
      const problem = validateFile(file, isImageMode);
      if (problem) { Q.showToast(`${file.name}: ${problem}`, true); continue; }
      uploadInFlight += 1;
      uploadStatus.textContent = `${file.name} 업로드 준비 중…`;
      const progressRoot = $(".ed-cover-progress");
      if (mode === "cover") progressRoot.hidden = false;
      try {
        const attachment = await uploadFile(file, (percent) => {
          uploadStatus.textContent = `${file.name} 업로드 ${percent}%`;
          if (mode === "cover") $("span", progressRoot).style.width = `${percent}%`;
        });
        attachments.push(attachment);
        renderAttachments();
        if (mode === "cover") {
          coverUrl = attachment.inlineUrl;
          renderCover(); markDirty();
        } else if (mode === "image") {
          insertImageAttachment(attachment);
        } else {
          markDirty();
        }
        await saveToServer("draft", { silent: true });
        Q.showToast(`${file.name} 파일을 첨부했습니다.`);
      } catch (error) { Q.showToast(error.message, true); }
      finally {
        uploadInFlight -= 1;
        uploadStatus.textContent = "";
        if (mode === "cover") { progressRoot.hidden = true; $("span", progressRoot).style.width = "0"; }
      }
    }
  }

  function saveSelection() {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
  }

  function restoreSelection() {
    const selection = window.getSelection();
    selection.removeAllRanges();
    if (savedRange && document.contains(savedRange.commonAncestorContainer)) selection.addRange(savedRange);
    else { const range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); selection.addRange(range); }
    editor.focus();
  }

  function insertNode(node) {
    restoreSelection();
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    range.deleteContents(); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range); saveSelection(); markDirty();
  }

  function insertImageAttachment(file) {
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = file.inlineUrl;
    image.alt = file.filename.replace(/\.[^.]+$/, "");
    const caption = document.createElement("figcaption");
    caption.textContent = file.filename;
    figure.append(image, caption);
    insertNode(figure);
  }

  function exec(command, value = null) {
    restoreSelection();
    document.execCommand("styleWithCSS", false, true);
    document.execCommand(command, false, value);
    saveSelection(); markDirty(); updateToolbarState();
  }

  function applyInlineStyle(property, value) {
    restoreSelection();
    const selection = window.getSelection();
    if (!selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const span = document.createElement("span");
    span.style.setProperty(property, value);
    if (range.collapsed) {
      span.textContent = "\u200b";
      range.insertNode(span);
      range.setStart(span.firstChild, 1); range.collapse(true);
    } else {
      span.append(range.extractContents());
      range.insertNode(span); range.selectNodeContents(span);
    }
    selection.removeAllRanges(); selection.addRange(range); saveSelection(); markDirty();
  }

  function insertLink() {
    saveSelection();
    const selected = window.getSelection()?.toString() || "";
    const raw = prompt(selected ? "연결할 주소를 입력하세요." : "링크 주소를 입력하세요. 선택한 텍스트가 없으면 주소가 본문에 표시됩니다.", "https://");
    if (!raw) return;
    const href = Q.safeUrl(raw);
    if (!href) { Q.showToast("HTTPS 또는 Quilo 내부 주소를 입력하세요.", true); return; }
    restoreSelection();
    if (selected) exec("createLink", href);
    else {
      const anchor = document.createElement("a"); anchor.href = href; anchor.target = "_blank"; anchor.rel = "noopener noreferrer nofollow"; anchor.textContent = raw; insertNode(anchor);
    }
  }

  function insertTable(rows, cols) {
    const table = document.createElement("table");
    const body = document.createElement("tbody");
    for (let row = 0; row < rows; row += 1) {
      const tr = document.createElement("tr");
      for (let col = 0; col < cols; col += 1) {
        const cell = document.createElement(row === 0 ? "th" : "td");
        cell.textContent = row === 0 ? `제목 ${col + 1}` : "내용";
        tr.append(cell);
      }
      body.append(tr);
    }
    table.append(body); insertNode(table);
  }

  function updateToolbarState() {
    for (const button of $$('[data-command]', $("#editorToolbar"))) {
      const command = button.dataset.command;
      if (["bold", "italic", "underline", "strikeThrough", "insertUnorderedList", "insertOrderedList", "justifyCenter", "justifyRight"].includes(command)) {
        try { button.classList.toggle("is-active", document.queryCommandState(command)); } catch (_) { /* no-op */ }
      }
    }
  }

  function setupToolbar() {
    document.execCommand("defaultParagraphSeparator", false, "p");
    document.execCommand("styleWithCSS", false, true);
    $$('[data-command]', $("#editorToolbar")).forEach((button) => button.addEventListener("mousedown", (event) => event.preventDefault()));
    $$('[data-command]', $("#editorToolbar")).forEach((button) => button.addEventListener("click", () => exec(button.dataset.command)));
    $("[data-format-block]").addEventListener("change", (event) => exec("formatBlock", event.target.value));
    $("[data-font-name]").addEventListener("change", (event) => applyInlineStyle("font-family", event.target.value === "inherit" ? "sans-serif" : event.target.value));
    const fontSizeMap = { "2": "14px", "3": "16px", "4": "18px", "5": "24px", "6": "28px" };
    $("[data-font-size]").addEventListener("change", (event) => applyInlineStyle("font-size", fontSizeMap[event.target.value] || "16px"));
    $("[data-fore-color]").addEventListener("input", (event) => applyInlineStyle("color", event.target.value));
    $("[data-back-color]").addEventListener("input", (event) => applyInlineStyle("background-color", event.target.value));
    $$('[data-block]').forEach((button) => button.addEventListener("click", () => exec("formatBlock", button.dataset.block)));
    $("[data-create-link]").addEventListener("click", insertLink);
    $("[data-insert-hr]").addEventListener("click", () => exec("insertHorizontalRule"));
    $("[data-insert-table]").addEventListener("click", () => { saveSelection(); $("#tableDialog").showModal(); });
    $("#insertTableConfirm").addEventListener("click", (event) => {
      event.preventDefault();
      const rows = Math.min(20, Math.max(1, Number($("#tableRows").value) || 3));
      const cols = Math.min(10, Math.max(1, Number($("#tableCols").value) || 3));
      $("#tableDialog").close(); insertTable(rows, cols);
    });
    $("[data-close-table]").addEventListener("click", () => $("#tableDialog").close());
    setupEmoji();
    $$('[data-upload-image]').forEach((button) => button.addEventListener("click", () => { saveSelection(); $("#inlineImageFile").click(); }));
    $$('[data-upload-file]').forEach((button) => button.addEventListener("click", () => $("#attachmentFile").click()));
  }

  function setupEmoji() {
    const popover = $("#emojiPopover");
    const trigger = $("[data-emoji]");
    const emojis = ["👍","😀","✅","✨","🔥","❤️","🙌","⭐","👀","🤔","😄","😭","😎","💡","🧪","📊","🧠","📝","📌","🔎","⚙️","🚀","🎯","🧩","📚","🔬","📐","💻","🛠️","📎","⬆️","🎉"];
    for (const emoji of emojis) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = emoji; button.setAttribute("aria-label", `${emoji} 삽입`);
      button.addEventListener("click", () => { exec("insertText", emoji); popover.hidden = true; }); popover.append(button);
    }
    trigger.addEventListener("click", () => {
      saveSelection();
      const rect = trigger.getBoundingClientRect();
      popover.style.left = `${Math.min(rect.left, innerWidth - 310)}px`;
      popover.style.top = `${Math.min(rect.bottom + 7, innerHeight - 180)}px`;
      popover.hidden = !popover.hidden;
    });
    document.addEventListener("pointerdown", (event) => { if (!popover.hidden && !popover.contains(event.target) && event.target !== trigger) popover.hidden = true; });
  }

  function setupPasteAndDrop() {
    editor.addEventListener("paste", (event) => {
      event.preventDefault();
      const html = event.clipboardData?.getData("text/html");
      const text = event.clipboardData?.getData("text/plain") || "";
      if (html) exec("insertHTML", Q.sanitizeHtml(html));
      else exec("insertText", text);
    });
    editor.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
    editor.addEventListener("drop", (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files.length) return;
      event.preventDefault();
      const point = document.caretRangeFromPoint?.(event.clientX, event.clientY);
      if (point) savedRange = point;
      const images = files.filter((file) => IMAGE_TYPES.has(file.type));
      const other = files.filter((file) => !IMAGE_TYPES.has(file.type));
      if (images.length) uploadFiles(images, "image");
      if (other.length) uploadFiles(other, "file");
    });
    const cover = $("#coverEditor");
    cover.addEventListener("dragover", (event) => { event.preventDefault(); cover.classList.add("is-dragging"); });
    cover.addEventListener("dragleave", () => cover.classList.remove("is-dragging"));
    cover.addEventListener("drop", (event) => { event.preventDefault(); cover.classList.remove("is-dragging"); const file = Array.from(event.dataTransfer?.files || []).find((item) => IMAGE_TYPES.has(item.type)); if (file) uploadFiles([file], "cover"); });
  }

  function setupPreview() {
    const dialog = $("#previewDialog");
    $("#previewButton").addEventListener("click", () => {
      $("[data-preview-category]", dialog).textContent = categorySelect.value;
      $("[data-preview-title]", dialog).textContent = title.value.trim() || "제목 없음";
      $("[data-preview-summary]", dialog).textContent = summary.value.trim();
      const body = $("[data-preview-body]", dialog); body.replaceChildren(Q.sanitizeToFragment(editor.innerHTML));
      dialog.showModal();
    });
    $("[data-close-dialog]", dialog).addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }

  function setupRecovery(remote) {
    const local = readLocal();
    if (!local || !local.title && !String(local.richHtml || "").replace(/<[^>]+>/g, "").trim()) return;
    if (remote && local.savedAt <= remoteUpdatedAt) return;
    const notice = $("#recoveryNotice");
    notice.hidden = false;
    $("#recoveryTime").textContent = `${new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(local.savedAt))}에 자동 저장됨`;
    $("[data-recover]", notice).addEventListener("click", () => { applySnapshot(local); notice.hidden = true; Q.showToast("작성 중이던 내용을 복구했습니다."); });
    $("[data-dismiss-recovery]", notice).addEventListener("click", () => { try { localStorage.removeItem(localKey()); } catch (_) {} notice.hidden = true; });
  }

  async function loadExisting() {
    if (!postId) return null;
    const payload = await Q.api(`/me/posts/${encodeURIComponent(postId)}`);
    const post = Q.normalizePost(payload?.post || payload?.data?.post || payload);
    post.attachments = (payload?.attachments || payload?.data?.attachments || []).map(Q.normalizeAttachment);
    if (!canWrite(post.kind)) throw new Error("이 글을 수정할 권한이 없습니다.");
    applySnapshot(post, { fromRemote: true });
    remoteUpdatedAt = new Date(post.updatedAt || post.raw.updated_at || post.publishedAt || 0).getTime();
    $("#editorDangerZone").hidden = false;
    setSaveState(post.status === "published" ? "발행된 글" : "저장된 초안", "saved");
    return post;
  }

  function setupEvents() {
    [title, summary, tags, slug, categorySelect].forEach((field) => field.addEventListener("input", markDirty));
    title.addEventListener("input", () => { if (!slugTouched) slug.value = slugify(title.value); });
    slug.addEventListener("input", () => { slugTouched = true; slug.value = slugify(slug.value); });
    editor.addEventListener("input", markDirty);
    editor.addEventListener("keyup", saveSelection);
    editor.addEventListener("mouseup", saveSelection);
    document.addEventListener("selectionchange", () => { if (editor.contains(document.getSelection()?.anchorNode)) { saveSelection(); updateToolbarState(); } });
    kindSelect.addEventListener("change", () => {
      if (!canWrite(kindSelect.value)) { kindSelect.value = kindSelect.value === "resource" ? "developer" : "resource"; Q.showToast("선택한 공간의 글쓰기 권한이 없습니다.", true); return; }
      updateKind(kindSelect.value);
    });
    $("#saveDraftButton").addEventListener("click", () => saveToServer("draft").catch(() => null));
    $("#publishButton").addEventListener("click", () => {
      if (!confirm("이 글을 모두에게 공개할까요?")) return;
      saveToServer("published").catch(() => null);
    });
    $("#deletePostButton").addEventListener("click", async () => {
      if (!postId || !confirm("이 글과 첨부 파일을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
      try { await Q.api(`/posts/${encodeURIComponent(postId)}`, { method: "DELETE" }); removeLocal(); location.href = kindSelect.value === "resource" ? "/resources.html" : "/developer-notes.html"; }
      catch (error) { Q.showToast(error.message, true); }
    });
    $("#coverButton").addEventListener("click", () => $("#coverFile").click());
    $("[data-change-cover]").addEventListener("click", () => $("#coverFile").click());
    $("[data-remove-cover]").addEventListener("click", () => { coverUrl = ""; renderCover(); markDirty(); });
    $("#coverFile").addEventListener("change", (event) => { uploadFiles(event.target.files, "cover"); event.target.value = ""; });
    $("#inlineImageFile").addEventListener("change", (event) => { uploadFiles(event.target.files, "image"); event.target.value = ""; });
    $("#attachmentFile").addEventListener("change", (event) => { uploadFiles(event.target.files, "file"); event.target.value = ""; });
    $("[data-editor-more]").addEventListener("click", (event) => { const menu = $("[data-editor-menu]"); menu.hidden = !menu.hidden; event.currentTarget.setAttribute("aria-expanded", String(!menu.hidden)); });
    $("#discardLocal").addEventListener("click", () => { if (confirm("이 브라우저에 자동 저장된 내용을 삭제할까요?")) { removeLocal(); Q.showToast("로컬 임시 저장을 삭제했습니다."); } });
    $("#leaveEditor").addEventListener("click", (event) => { if (dirty && !confirm("저장되지 않은 변경이 있습니다. 나갈까요?")) event.preventDefault(); });
    window.addEventListener("beforeunload", (event) => { if (dirty && !uploadInFlight) { event.preventDefault(); event.returnValue = ""; } });
    document.addEventListener("keydown", (event) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "s") { event.preventDefault(); saveToServer("draft").catch(() => null); }
      if (mod && event.key.toLowerCase() === "k" && editor.contains(document.activeElement)) { event.preventDefault(); insertLink(); }
      if (event.key === "Escape") $("#emojiPopover").hidden = true;
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    session = await Q.session;
    if (!session) { denied.hidden = false; return; }
    kindSelect.options[0].disabled = !canWrite("developer");
    kindSelect.options[1].disabled = !canWrite("resource");
    if (!requestedId && !canWrite(requestedKind)) {
      const alternative = canWrite("developer") ? "developer" : canWrite("resource") ? "resource" : "";
      if (!alternative) { denied.hidden = false; return; }
      updateKind(alternative, false);
    } else updateKind(requestedKind, false);
    shell.hidden = false;
    setupToolbar(); setupPasteAndDrop(); setupPreview(); setupEvents();
    try {
      const remote = await loadExisting();
      if (requestedId) setupRecovery(remote);
    } catch (error) {
      shell.hidden = true; denied.hidden = false;
      $("p", denied).textContent = error.message;
      return;
    }
    if (!requestedId) {
      editor.innerHTML = "<p><br></p>";
      categorySelect.value = categories[kindSelect.value][0];
      setupRecovery(null);
      setSaveState("새 글");
      title.focus();
    }
    updateCount(); renderCover(); renderAttachments();
  });
})();
