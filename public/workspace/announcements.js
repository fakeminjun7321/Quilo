const DISMISSED_PREFIX = "quiloDismissedAnnouncement:";

function safeUrl(link) {
  const raw = String(link == null ? "" : link).trim();
  if (!raw) return "";
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  try {
    const url = new URL(raw, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch (_) {
    return "";
  }
}

function announcementKey(item) {
  return String(item?.id || `${item?.category || ""}:${item?.title || ""}`);
}

function wasDismissed(key) {
  try { return localStorage.getItem(`${DISMISSED_PREFIX}${key}`) === "1"; }
  catch (_) { return false; }
}

function rememberDismissed(key) {
  try { localStorage.setItem(`${DISMISSED_PREFIX}${key}`, "1"); }
  catch (_) {}
}

function formatDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date).replace(/\.\s*/g, ".").replace(/\.$/, "");
}

function createAnnouncement(item, total) {
  const fragment = document.createDocumentFragment();
  const title = document.createElement("strong");
  title.className = "ui-announcement__title";
  title.textContent = String(item.title || "Quilo 새 소식");
  fragment.appendChild(title);

  if (total > 1) {
    const count = document.createElement("span");
    count.className = "ui-announcement__count";
    count.textContent = `공지 ${total}개`;
    fragment.appendChild(count);
  }

  const href = safeUrl(item.link);
  if (href) {
    const link = document.createElement("a");
    link.className = "ui-announcement__more";
    link.href = href;
    link.textContent = "자세히 보기";
    link.insertAdjacentHTML("beforeend", '<span aria-hidden="true">→</span>');
    const target = new URL(href, window.location.origin);
    if (target.origin !== window.location.origin) {
      link.target = "_blank";
      link.rel = "noopener";
    }
    fragment.appendChild(link);
  }
  return fragment;
}

export async function loadAnnouncements() {
  const ticker = document.getElementById("annTicker");
  const track = document.getElementById("annTrack");
  const category = document.getElementById("annCategory");
  const date = document.getElementById("annDate");
  const dismiss = document.getElementById("annDismiss");
  if (!ticker || !track) return;

  try {
    const response = await fetch("/api/announcements", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("announcement request failed");
    const data = await response.json();
    const list = Array.isArray(data.announcements)
      ? data.announcements.filter((item) => String(item?.title || "").trim())
      : [];
    if (!list.length) {
      ticker.dataset.state = "empty";
      ticker.setAttribute("aria-busy", "false");
      ticker.hidden = true;
      return;
    }

    const primary = list[0];
    const key = announcementKey(primary);
    if (wasDismissed(key)) {
      ticker.dataset.state = "dismissed";
      ticker.setAttribute("aria-busy", "false");
      ticker.hidden = true;
      return;
    }

    if (category) category.textContent = String(primary.category || "공지");
    if (date) {
      date.textContent = formatDate(primary.created_at);
      date.dateTime = String(primary.created_at || "");
      date.hidden = !date.textContent;
    }
    track.replaceChildren(createAnnouncement(primary, list.length));
    dismiss?.addEventListener("click", () => {
      rememberDismissed(key);
      ticker.dataset.state = "dismissed";
      ticker.hidden = true;
    }, { once: true });
    ticker.dataset.state = "ready";
    ticker.setAttribute("aria-busy", "false");
    ticker.hidden = false;
  } catch (_) {
    ticker.dataset.state = "empty";
    ticker.setAttribute("aria-busy", "false");
    ticker.hidden = true;
  }
}
