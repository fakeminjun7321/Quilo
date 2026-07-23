"use strict";

(function initChangelog() {
  const timeline = document.getElementById("releaseTimeline");
  const indexRoot = document.getElementById("releaseIndex");
  const searchInput = document.getElementById("releaseSearch");
  const filterButtons = [...document.querySelectorAll("[data-release-filter]")];
  const resultCount = document.getElementById("releaseResultCount");
  const currentRelease = document.getElementById("currentRelease");
  const currentReleaseSide = document.getElementById("currentReleaseSide");
  const currentReleaseDate = document.getElementById("currentReleaseDate");
  const currentCommit = document.getElementById("currentCommit");
  const currentBranch = document.getElementById("currentBranch");
  const toggleAll = document.getElementById("toggleAllReleases");
  if (!timeline || !indexRoot || !searchInput || !toggleAll) return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  let releases = [];
  let activeFilter = "all";

  function humanizeReleaseText(value, { title = false } = {}) {
    let text = String(value || "")
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .replace(/대폭/g, "크게")
      .replace(/전면 점검[·ㆍ]개선/g, "전체 점검과 개선")
      .replace(/전면 개선/g, "전반 개선")
      .replace(/대개편/g, "개편")
      .replace(/근본 수정/g, "원인 수정")
      .replace(/비용 폭주 차단/g, "과도한 비용 사용 제한")
      .replace(/자동 검증기/g, "자동 검증 추가")
      .replace(/정밀화/g, "정확도 개선")
      .replace(/완벽하게/g, "안정적으로")
      .replace(/완벽한/g, "안정적인")
      .replace(/\s+[—–]\s+/g, title ? ": " : ". ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (title) {
      text = text
        .replace(/^[\u2190-\u2BFF∑]+\s*/u, "")
        .replace(/\s*\+\s*/g, ", ")
        .replace(/\s*→\s*/g, "에서 ")
        .replace(/\s{2,}/g, " ")
        .trim();
    }
    return text;
  }

  function formatVersion(value) {
    const version = String(value || "").trim().replace(/^v/i, "");
    return version ? `v${version}` : "버전 확인 지연";
  }

  function parseDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatDate(value, compact = false) {
    const date = parseDate(value);
    if (!date) return String(value || "날짜 미상");
    return new Intl.DateTimeFormat("ko-KR", compact
      ? { year: "numeric", month: "2-digit", day: "2-digit" }
      : { year: "numeric", month: "long", day: "numeric" }).format(date);
  }

  function categoryFor(type) {
    const normalized = String(type || "").replaceAll(" ", "");
    if (/신규|새기능|기능추가/.test(normalized)) return "feature";
    if (/버그|오류|수정|복구/.test(normalized)) return "fix";
    return "improvement";
  }

  function categoryLabel(category, originalType) {
    if (originalType) return String(originalType);
    if (category === "feature") return "새 기능";
    if (category === "fix") return "수정";
    return "개선";
  }

  function slugFor(note, index) {
    if (note.version) return `v-${String(note.version).replace(/[^a-z0-9.-]+/gi, "-").replace(/^-|-$/g, "")}`;
    const date = String(note.date || "release").replace(/[^0-9a-z]+/gi, "-").replace(/^-|-$/g, "");
    return `release-${date || "unknown"}-${index + 1}`;
  }

  function appendRichText(target, value) {
    const text = humanizeReleaseText(value);
    const chunks = text.split("**");
    chunks.forEach((chunk, index) => {
      if (!chunk) return;
      if (index % 2 === 1) {
        const strong = document.createElement("strong");
        strong.textContent = chunk;
        target.appendChild(strong);
      } else {
        target.appendChild(document.createTextNode(chunk));
      }
    });
  }

  function copyIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const back = document.createElementNS(SVG_NS, "path");
    back.setAttribute("d", "M8 7V4h9v12h-3");
    const front = document.createElementNS(SVG_NS, "path");
    front.setAttribute("d", "M5 8h9v12H5z");
    svg.append(back, front);
    return svg;
  }

  async function copyReleaseLink(button, id) {
    const url = new URL(window.location.href);
    url.hash = id;
    try {
      await navigator.clipboard.writeText(url.href);
      const label = button.querySelector("span");
      label.textContent = "복사됨";
      window.setTimeout(() => { label.textContent = "링크 복사"; }, 1600);
    } catch (_) {
      window.location.hash = id;
      const label = button.querySelector("span");
      label.textContent = "주소창에서 복사하세요";
    }
  }

  function createReleaseArticle(note, index, currentVersion) {
    const category = categoryFor(note.type);
    const id = slugFor(note, index);
    const article = document.createElement("article");
    article.className = `release-entry is-${category}`;
    article.id = id;
    article.dataset.category = category;
    article.dataset.search = [note.title, note.type, note.date, ...(Array.isArray(note.items) ? note.items : [])]
      .join(" ")
      .replaceAll("**", "")
      .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
      .toLocaleLowerCase("ko-KR");

    const head = document.createElement("header");
    head.className = "release-entry__head";
    const headingBlock = document.createElement("div");
    const meta = document.createElement("div");
    meta.className = "release-entry__meta";
    const releaseLabel = document.createElement("span");
    releaseLabel.className = "release-entry__type";
    releaseLabel.textContent = categoryLabel(category, note.type);
    const date = document.createElement("time");
    date.dateTime = parseDate(note.date)?.toISOString().slice(0, 10) || "";
    date.textContent = formatDate(note.date);
    const version = document.createElement("span");
    version.className = "release-entry__version";
    version.textContent = note.version ? formatVersion(note.version) : index === 0 ? currentVersion : "";
    meta.append(releaseLabel, date);
    if (version.textContent) meta.appendChild(version);
    const title = document.createElement("h2");
    title.textContent = humanizeReleaseText(note.title || "업데이트", { title: true });
    headingBlock.append(meta, title);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "release-copy-link";
    copy.setAttribute("aria-label", `${title.textContent} 업데이트 링크 복사`);
    const copyLabel = document.createElement("span");
    copyLabel.textContent = "링크 복사";
    copy.append(copyIcon(), copyLabel);
    copy.addEventListener("click", () => copyReleaseLink(copy, id));
    head.append(headingBlock, copy);

    const details = document.createElement("details");
    details.className = "release-details";
    details.open = index === 0;
    const summary = document.createElement("summary");
    summary.textContent = details.open ? "변경 내용 접기" : "변경 내용 보기";
    details.addEventListener("toggle", () => {
      summary.textContent = details.open ? "변경 내용 접기" : "변경 내용 보기";
      syncToggleAllState();
    });
    const body = document.createElement("div");
    body.className = "release-details__body";
    const list = document.createElement("ul");
    const items = Array.isArray(note.items) ? note.items : [];
    items.forEach((item) => {
      const li = document.createElement("li");
      appendRichText(li, item);
      list.appendChild(li);
    });
    if (!items.length) {
      const li = document.createElement("li");
      li.textContent = "이 릴리스에 공개된 상세 변경 내용이 없습니다.";
      list.appendChild(li);
    }
    body.appendChild(list);
    details.append(summary, body);
    article.append(head, details);
    return article;
  }

  function createIndexItem(note, index, articleId, currentVersion) {
    const li = document.createElement("li");
    if (index === 0) li.classList.add("is-current");
    const link = document.createElement("a");
    link.href = `#${articleId}`;
    if (index === 0) link.classList.add("is-current");
    const title = document.createElement("span");
    title.textContent = note.version ? formatVersion(note.version) : index === 0 ? currentVersion : humanizeReleaseText(note.title || "업데이트", { title: true });
    const time = document.createElement("time");
    time.dateTime = parseDate(note.date)?.toISOString().slice(0, 10) || "";
    time.textContent = formatDate(note.date, true);
    link.append(title, time);
    li.appendChild(link);
    return li;
  }

  function syncToggleAllState() {
    const visibleDetails = [...timeline.querySelectorAll(".release-entry:not([hidden]) .release-details")];
    const allOpen = visibleDetails.length > 0 && visibleDetails.every((details) => details.open);
    toggleAll.setAttribute("aria-expanded", String(allOpen));
    toggleAll.textContent = allOpen ? "모두 접기" : "모두 펼치기";
  }

  function applyFilters() {
    const query = searchInput.value.trim().toLocaleLowerCase("ko-KR");
    let visibleCount = 0;
    releases.forEach(({ article, indexItem }) => {
      const categoryMatches = activeFilter === "all" || article.dataset.category === activeFilter;
      const searchMatches = !query || article.dataset.search.includes(query);
      const visible = categoryMatches && searchMatches;
      article.hidden = !visible;
      indexItem.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    resultCount.textContent = visibleCount
      ? `${visibleCount}개의 업데이트를 표시하고 있습니다.`
      : "조건에 맞는 업데이트가 없습니다.";
    syncToggleAllState();
  }

  function render(info) {
    const notes = Array.isArray(info.patchNotes) ? info.patchNotes.filter((note) => note && typeof note === "object") : [];
    const version = formatVersion(info.releaseVersion || info.version);
    currentRelease.textContent = version;
    currentReleaseSide.textContent = version;
    currentCommit.textContent = info.shortCommit || "미확인";
    currentCommit.title = info.commit || "";
    currentBranch.textContent = info.branch || "미확인";
    if (notes[0]?.date) {
      currentReleaseDate.textContent = formatDate(notes[0].date);
      currentReleaseDate.dateTime = parseDate(notes[0].date)?.toISOString().slice(0, 10) || "";
    }

    timeline.replaceChildren();
    indexRoot.replaceChildren();
    releases = [];
    if (!notes.length) {
      const empty = document.createElement("p");
      empty.className = "release-empty";
      empty.textContent = "현재 공개된 업데이트 내역이 없습니다.";
      timeline.appendChild(empty);
      resultCount.textContent = "표시할 업데이트가 없습니다.";
      return;
    }

    notes.forEach((note, index) => {
      const article = createReleaseArticle(note, index, version);
      const indexItem = createIndexItem(note, index, article.id, version);
      timeline.appendChild(article);
      indexRoot.appendChild(indexItem);
      releases.push({ article, indexItem });
    });
    timeline.setAttribute("aria-busy", "false");
    applyFilters();

    if (window.location.hash) {
      const target = document.getElementById(window.location.hash.slice(1));
      if (target?.classList.contains("release-entry")) {
        target.querySelector(".release-details").open = true;
        requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
    }
  }

  async function loadVersion() {
    try {
      const response = await fetch("/api/version?includeNotes=1", { cache: "no-store", headers: { accept: "application/json" } });
      if (!response.ok) throw new Error("업데이트 정보를 불러오지 못했습니다.");
      render(await response.json());
    } catch (_) {
      timeline.replaceChildren();
      timeline.setAttribute("aria-busy", "false");
      const error = document.createElement("p");
      error.className = "release-empty";
      error.textContent = "업데이트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      timeline.appendChild(error);
      indexRoot.replaceChildren();
      const item = document.createElement("li");
      item.className = "is-loading";
      item.textContent = "릴리스 목록 확인 지연";
      indexRoot.appendChild(item);
      resultCount.textContent = "업데이트 확인이 지연되고 있습니다.";
      currentRelease.textContent = "확인 지연";
      currentReleaseSide.textContent = "확인 지연";
    }
  }

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.releaseFilter || "all";
      filterButtons.forEach((candidate) => {
        const active = candidate === button;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      applyFilters();
    });
  });
  searchInput.addEventListener("input", applyFilters);
  toggleAll.addEventListener("click", () => {
    const visibleDetails = [...timeline.querySelectorAll(".release-entry:not([hidden]) .release-details")];
    const shouldOpen = !visibleDetails.length || !visibleDetails.every((details) => details.open);
    visibleDetails.forEach((details) => { details.open = shouldOpen; });
    syncToggleAllState();
  });
  loadVersion();
})();
