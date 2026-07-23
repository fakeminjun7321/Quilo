"use strict";

(function initSupportAndCommunityPages() {
  const escapeHtml = (value) => String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  const loginUrl = () => `/login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`;

  async function readJson(response) {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "요청을 처리하지 못했습니다.");
    return data;
  }

  async function requestJson(url, options) {
    return readJson(await fetch(url, { credentials: "same-origin", ...options }));
  }

  function setStatus(node, message, kind = "") {
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", kind === "error");
    node.classList.toggle("is-success", kind === "success");
  }

  function initSupportPage() {
    const page = document.querySelector("[data-support-page]");
    if (!page) return;

    const form = document.getElementById("supportForm");
    const loading = document.getElementById("supportAuthLoading");
    const notice = document.getElementById("supportAuthNotice");
    const loginLink = document.getElementById("supportLoginLink");
    const status = document.getElementById("supportFormStatus");
    const submit = document.getElementById("supportSubmit");
    const message = document.getElementById("supportMessage");
    const count = document.getElementById("supportMessageCount");

    if (loginLink) loginLink.href = loginUrl();

    function fieldError(input, text) {
      const field = input.closest(".support-field");
      const error = field?.querySelector(`[data-error-for="${input.id}"]`);
      field?.classList.toggle("is-invalid", !!text);
      input.setAttribute("aria-invalid", text ? "true" : "false");
      if (error) error.textContent = text || "";
      return !text;
    }

    function validateField(input) {
      const value = input.value.trim();
      if (input.id === "supportCategory") return fieldError(input, value ? "" : "문의 유형을 선택해 주세요.");
      if (input.id === "supportInquiryTitle") return fieldError(input, value.length >= 3 ? "" : "제목을 3자 이상 입력해 주세요.");
      if (input.id === "supportContactEmail") {
        return fieldError(input, !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? "" : "이메일 형식을 확인해 주세요.");
      }
      if (input.id === "supportMessage") return fieldError(input, value.length >= 10 ? "" : "문의 내용을 10자 이상 입력해 주세요.");
      return true;
    }

    function validateForm() {
      const fields = [...form.querySelectorAll("select, input, textarea")];
      const validity = fields.map(validateField);
      const invalidIndex = validity.findIndex((valid) => !valid);
      if (invalidIndex >= 0) fields[invalidIndex].focus();
      return invalidIndex < 0;
    }

    form?.querySelectorAll("select, input, textarea").forEach((input) => {
      input.addEventListener("blur", () => validateField(input));
      input.addEventListener("input", () => {
        if (input.closest(".support-field")?.classList.contains("is-invalid")) validateField(input);
        if (input === message && count) count.textContent = String(message.value.length);
      });
      input.addEventListener("change", () => validateField(input));
    });

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      setStatus(status, "");
      if (!validateForm()) return;
      submit.disabled = true;
      submit.textContent = "접수 중…";
      try {
        await requestJson("/api/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            category: document.getElementById("supportCategory").value,
            title: document.getElementById("supportInquiryTitle").value.trim(),
            contactEmail: document.getElementById("supportContactEmail").value.trim(),
            message: message.value.trim(),
            pageUrl: location.href,
          }),
        });
        const email = document.getElementById("supportContactEmail").value;
        form.reset();
        document.getElementById("supportContactEmail").value = email;
        if (count) count.textContent = "0";
        setStatus(status, "문의가 접수되었습니다.", "success");
      } catch (error) {
        setStatus(status, error.message, "error");
      } finally {
        submit.disabled = false;
        submit.textContent = "문의 보내기";
      }
    });

    const faqSearch = document.getElementById("faqSearch");
    const faqItems = [...document.querySelectorAll(".support-faq-item")];
    const faqEmpty = document.getElementById("faqEmpty");
    const faqFilters = [...document.querySelectorAll("[data-faq-filter]")];
    let faqCategory = "";

    function applyFaqFilter() {
      const query = String(faqSearch?.value || "").trim().toLocaleLowerCase("ko-KR");
      let visible = 0;
      faqItems.forEach((item) => {
        const categoryMatch = !faqCategory || item.dataset.faqCategory === faqCategory;
        const searchMatch = !query || item.textContent.toLocaleLowerCase("ko-KR").includes(query);
        item.hidden = !(categoryMatch && searchMatch);
        if (!item.hidden) visible += 1;
      });
      if (faqEmpty) faqEmpty.hidden = visible > 0;
    }

    faqSearch?.addEventListener("input", applyFaqFilter);
    faqFilters.forEach((button) => button.addEventListener("click", () => {
      faqCategory = button.dataset.faqFilter || "";
      faqFilters.forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
      applyFaqFilter();
    }));

    const legacyRequestList = document.getElementById("supportLegacyRequests");
    Promise.allSettled([
      requestJson("/api/community/posts?category=feature"),
      requestJson("/api/community/posts?category=suggestion"),
    ]).then((results) => {
      const seen = new Set();
      const posts = results.flatMap((result) => result.status === "fulfilled" && Array.isArray(result.value.posts) ? result.value.posts : [])
        .filter((post) => ["feature", "suggestion"].includes(post.category))
        .filter((post) => {
          const id = String(post.id || "");
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      legacyRequestList?.replaceChildren();
      legacyRequestList?.setAttribute("aria-busy", "false");
      if (!legacyRequestList) return;
      if (!posts.length) {
        const empty = document.createElement("p");
        empty.className = "support-archive__empty";
        empty.textContent = "보관된 이전 요청이 없습니다.";
        legacyRequestList.append(empty);
        return;
      }
      for (const post of posts) {
        const item = document.createElement("details");
        item.className = "support-archive__item";
        const summary = document.createElement("summary");
        const label = document.createElement("span");
        label.className = "support-archive__label";
        label.textContent = post.category === "feature" ? "기능 요청" : "건의사항";
        const title = document.createElement("strong");
        title.textContent = String(post.title || "제목 없음");
        const date = document.createElement("time");
        date.textContent = formatCommunityDate(post.created_at);
        summary.append(label, title, date);
        const body = document.createElement("p");
        body.textContent = String(post.body || "");
        item.append(summary, body);
        legacyRequestList.append(item);
      }
    });

    requestJson("/api/me")
      .then((user) => {
        loading.hidden = true;
        notice.hidden = true;
        form.hidden = false;
        if (user.email) document.getElementById("supportContactEmail").value = user.email;
      })
      .catch(() => {
        loading.hidden = true;
        form.hidden = true;
        notice.hidden = false;
      });
  }

  const COMMUNITY_CATEGORIES = Object.freeze({
    general: { label: "자유", legacy: false },
    question: { label: "질문", legacy: false },
    tip: { label: "사용팁", legacy: false },
    showcase: { label: "작업공유", legacy: false },
    feature: { label: "이전 기능 요청", legacy: true },
    suggestion: { label: "이전 건의사항", legacy: true },
  });

  function communityCategory(category) {
    return COMMUNITY_CATEGORIES[category] || { label: "기타", legacy: true };
  }

  function formatCommunityDate(value, withTime = false) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const options = withTime
      ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "2-digit", day: "2-digit" };
    return new Intl.DateTimeFormat("ko-KR", options).format(date);
  }

  function initCommunityPage() {
    const page = document.querySelector("[data-community-page]");
    if (!page) return;

    const state = {
      authenticated: false,
      me: null,
      posts: [],
      category: "",
      query: "",
      storage: true,
      openId: "",
    };
    const list = document.getElementById("communityPostList");
    const listStatus = document.getElementById("communityListStatus");
    const workspace = document.querySelector(".community-workspace");
    const writePanel = document.getElementById("communityWritePanel");
    const composeToggle = document.getElementById("communityComposeToggle");
    const composeClose = document.getElementById("communityComposeClose");
    const loginLink = document.getElementById("communityLoginLink");
    const search = document.getElementById("communitySearch");
    const filters = [...document.querySelectorAll("[data-community-category]")];

    if (loginLink) loginLink.href = loginUrl();

    function syncComposeControls() {
      composeToggle.hidden = !state.authenticated;
      loginLink.hidden = state.authenticated;
      if (!state.authenticated) closeComposer();
    }

    function openComposer() {
      if (!state.authenticated) {
        location.href = loginUrl();
        return;
      }
      writePanel.hidden = false;
      workspace.classList.add("has-compose");
      composeToggle.setAttribute("aria-expanded", "true");
      document.getElementById("communityNewCategory")?.focus();
    }

    function closeComposer() {
      writePanel.hidden = true;
      workspace.classList.remove("has-compose");
      composeToggle?.setAttribute("aria-expanded", "false");
    }

    composeToggle?.setAttribute("aria-expanded", "false");
    composeToggle?.setAttribute("aria-controls", "communityWritePanel");
    composeToggle?.addEventListener("click", () => writePanel.hidden ? openComposer() : closeComposer());
    composeClose?.addEventListener("click", closeComposer);

    function filteredPosts() {
      return state.posts.filter((post) => {
        const categoryMatch = !state.category || post.category === state.category;
        const haystack = [post.title, post.body, post.author_name, communityCategory(post.category).label]
          .join(" ")
          .toLocaleLowerCase("ko-KR");
        return categoryMatch && (!state.query || haystack.includes(state.query));
      });
    }

    function postMarkup(post) {
      const category = communityCategory(post.category);
      const canDelete = !!state.me && (state.me.isAdmin || state.me.id === post.user_id);
      const id = escapeHtml(post.id);
      return `<article class="community-post" data-post-id="${id}">
        <button class="community-post__row" type="button" aria-expanded="false" aria-controls="community-detail-${id}">
          <span><span class="community-category-label${category.legacy ? " is-legacy" : ""}">${escapeHtml(category.label)}</span></span>
          <span class="community-post__title">${escapeHtml(post.title)}</span>
          <span>${escapeHtml(post.author_name || "익명")}</span>
          <span class="community-post__metric"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"></path></svg><b>${Number(post.upvotes) || 0}</b></span>
          <span class="community-post__metric"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z"></path></svg><b>${Number(post.comment_count) || 0}</b></span>
          <span>${escapeHtml(formatCommunityDate(post.created_at))}</span>
          <svg class="community-post__chevron" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        <div class="community-post__detail" id="community-detail-${id}" hidden>
          <p class="community-post__body">${escapeHtml(post.body)}</p>
          <div class="community-post__actions">
            <button type="button" data-community-vote class="${post.voted ? "is-active" : ""}">공감 <b>${Number(post.upvotes) || 0}</b></button>
            <button type="button" data-community-comments>댓글 ${Number(post.comment_count) || 0}</button>
            ${canDelete ? '<button type="button" data-community-delete class="is-danger">삭제</button>' : ""}
          </div>
          <div class="community-comments" data-community-comments-box hidden></div>
        </div>
      </article>`;
    }

    function bindPostEvents() {
      list.querySelectorAll(".community-post").forEach((article) => {
        const id = article.dataset.postId;
        const row = article.querySelector(".community-post__row");
        const detail = article.querySelector(".community-post__detail");
        row.addEventListener("click", () => {
          const willOpen = detail.hidden;
          list.querySelectorAll(".community-post.is-open").forEach((openArticle) => {
            if (openArticle === article) return;
            openArticle.classList.remove("is-open");
            openArticle.querySelector(".community-post__row")?.setAttribute("aria-expanded", "false");
            const openDetail = openArticle.querySelector(".community-post__detail");
            if (openDetail) openDetail.hidden = true;
          });
          detail.hidden = !willOpen;
          article.classList.toggle("is-open", willOpen);
          row.setAttribute("aria-expanded", willOpen ? "true" : "false");
          state.openId = willOpen ? id : "";
        });
        article.querySelector("[data-community-vote]")?.addEventListener("click", () => votePost(id, article));
        article.querySelector("[data-community-comments]")?.addEventListener("click", () => toggleComments(id, article));
        article.querySelector("[data-community-delete]")?.addEventListener("click", () => deletePost(id));
      });
    }

    function renderPosts() {
      list.setAttribute("aria-busy", "false");
      if (!state.storage) {
        list.innerHTML = '<div class="community-empty"><strong>커뮤니티 저장소가 아직 설정되지 않았습니다.</strong><span>설정이 완료되면 게시글을 확인할 수 있습니다.</span></div>';
        return;
      }
      const posts = filteredPosts();
      if (!posts.length) {
        list.innerHTML = '<div class="community-empty"><strong>조건에 맞는 게시글이 없습니다.</strong><span>다른 분류나 검색어를 확인해 주세요.</span></div>';
        return;
      }
      list.innerHTML = posts.map(postMarkup).join("");
      bindPostEvents();
      setStatus(listStatus, `${posts.length}개의 게시글`);
    }

    filters.forEach((button) => button.addEventListener("click", () => {
      state.category = button.dataset.communityCategory || "";
      filters.forEach((item) => item.setAttribute("aria-pressed", item === button ? "true" : "false"));
      renderPosts();
    }));

    search?.addEventListener("input", () => {
      state.query = search.value.trim().toLocaleLowerCase("ko-KR");
      renderPosts();
    });

    async function votePost(id, article) {
      if (!state.authenticated) {
        setStatus(listStatus, "공감하려면 로그인이 필요합니다.", "error");
        return;
      }
      try {
        const data = await requestJson(`/api/community/posts/${encodeURIComponent(id)}/vote`, { method: "POST" });
        const post = state.posts.find((item) => String(item.id) === String(id));
        if (post) {
          post.voted = !!data.voted;
          post.upvotes = Number(data.upvotes) || 0;
        }
        article.querySelectorAll("[data-community-vote] b, .community-post__row .community-post__metric b")[0].textContent = String(data.upvotes || 0);
        const voteButton = article.querySelector("[data-community-vote]");
        voteButton.querySelector("b").textContent = String(data.upvotes || 0);
        voteButton.classList.toggle("is-active", !!data.voted);
      } catch (error) {
        setStatus(listStatus, error.message, "error");
      }
    }

    async function deletePost(id) {
      if (!confirm("이 글을 삭제할까요?")) return;
      try {
        await requestJson(`/api/community/posts/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.posts = state.posts.filter((post) => String(post.id) !== String(id));
        renderPosts();
      } catch (error) {
        setStatus(listStatus, error.message, "error");
      }
    }

    function commentsMarkup(comments, postId) {
      const rows = comments.map((comment) => {
        const canDelete = !!state.me && (state.me.isAdmin || state.me.id === comment.user_id);
        return `<article class="community-comment">
          <div class="community-comment__meta"><strong>${escapeHtml(comment.author_name || "익명")}</strong><span>${escapeHtml(formatCommunityDate(comment.created_at, true))}</span>${canDelete ? `<button type="button" data-delete-comment="${escapeHtml(comment.id)}">삭제</button>` : ""}</div>
          <p>${escapeHtml(comment.body)}</p>
        </article>`;
      }).join("");
      const composer = state.authenticated
        ? `<form class="community-comment-form" data-comment-form>
            <label class="ui-sr-only" for="community-comment-${escapeHtml(postId)}">댓글 입력</label>
            <input id="community-comment-${escapeHtml(postId)}" type="text" maxlength="2000" placeholder="댓글을 입력하세요" required />
            <button type="submit">등록</button><p class="community-comment-status" role="status"></p>
          </form>`
        : `<p class="community-comment-note">댓글을 쓰려면 <a href="${loginUrl()}">로그인</a>이 필요합니다.</p>`;
      return rows + composer;
    }

    async function toggleComments(id, article) {
      const box = article.querySelector("[data-community-comments-box]");
      if (!box.hidden) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      box.innerHTML = '<div class="community-empty"><span class="support-spinner" aria-hidden="true"></span><strong>댓글을 불러오고 있습니다.</strong></div>';
      try {
        const data = await requestJson(`/api/community/posts/${encodeURIComponent(id)}/comments`);
        if (data.me) state.me = data.me;
        box.innerHTML = commentsMarkup(data.comments || [], id);
        box.querySelectorAll("[data-delete-comment]").forEach((button) => button.addEventListener("click", async () => {
          if (!confirm("댓글을 삭제할까요?")) return;
          try {
            await requestJson(`/api/community/comments/${encodeURIComponent(button.dataset.deleteComment)}`, { method: "DELETE" });
            box.hidden = true;
            await toggleComments(id, article);
          } catch (error) {
            setStatus(box.querySelector(".community-comment-status"), error.message, "error");
          }
        }));
        box.querySelector("[data-comment-form]")?.addEventListener("submit", async (event) => {
          event.preventDefault();
          const input = event.currentTarget.querySelector("input");
          const commentStatus = event.currentTarget.querySelector(".community-comment-status");
          if (!input.value.trim()) return;
          const button = event.currentTarget.querySelector("button");
          button.disabled = true;
          try {
            await requestJson(`/api/community/posts/${encodeURIComponent(id)}/comments`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: input.value.trim() }),
            });
            const post = state.posts.find((item) => String(item.id) === String(id));
            if (post) post.comment_count = Number(post.comment_count || 0) + 1;
            box.hidden = true;
            await toggleComments(id, article);
          } catch (error) {
            setStatus(commentStatus, error.message, "error");
          } finally {
            button.disabled = false;
          }
        });
      } catch (error) {
        box.innerHTML = `<p class="community-comment-note">${escapeHtml(error.message)}</p>`;
      }
    }

    const postForm = document.getElementById("communityPostForm");
    const postSubmit = document.getElementById("communityPostSubmit");
    const postStatus = document.getElementById("communityPostStatus");
    postForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const category = document.getElementById("communityNewCategory").value;
      const title = document.getElementById("communityNewTitle").value.trim();
      const body = document.getElementById("communityNewBody").value.trim();
      if (!category || !title || !body) {
        setStatus(postStatus, "분류, 제목과 내용을 모두 입력해 주세요.", "error");
        return;
      }
      postSubmit.disabled = true;
      postSubmit.textContent = "등록 중…";
      try {
        const data = await requestJson("/api/community/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, title, body }),
        });
        postForm.reset();
        if (data.post) state.posts.unshift({ ...data.post, voted: false, comment_count: 0 });
        setStatus(postStatus, "글이 등록되었습니다.", "success");
        renderPosts();
        setTimeout(closeComposer, 450);
      } catch (error) {
        setStatus(postStatus, error.message, "error");
      } finally {
        postSubmit.disabled = false;
        postSubmit.textContent = "등록";
      }
    });

    Promise.allSettled([requestJson("/api/me"), requestJson("/api/community/posts")])
      .then(([meResult, postsResult]) => {
        if (meResult.status === "fulfilled") state.authenticated = true;
        if (postsResult.status === "fulfilled") {
          state.posts = Array.isArray(postsResult.value.posts)
            ? postsResult.value.posts.filter((post) => !communityCategory(post.category).legacy)
            : [];
          state.storage = postsResult.value.storage !== false;
          if (postsResult.value.me) {
            state.me = postsResult.value.me;
            state.authenticated = true;
          }
        } else {
          state.storage = true;
          list.innerHTML = `<div class="community-empty"><strong>게시글을 불러오지 못했습니다.</strong><span>${escapeHtml(postsResult.reason.message)}</span></div>`;
          list.setAttribute("aria-busy", "false");
        }
        syncComposeControls();
        if (postsResult.status === "fulfilled") renderPosts();
      });
  }

  initSupportPage();
  initCommunityPage();
})();
