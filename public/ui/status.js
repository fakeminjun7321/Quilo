"use strict";

(function initStatusPage() {
  const overview = document.getElementById("statusOverview");
  const overviewTitle = document.getElementById("overviewTitle");
  const overviewChecked = document.getElementById("overviewChecked");
  const overviewMark = document.querySelector(".status-overview__mark");
  const checksRoot = document.getElementById("statusChecks");
  const refreshButton = document.getElementById("refreshStatus");
  const currentHistoryBar = document.getElementById("currentHistoryBar");
  const historyNote = document.getElementById("historyNote");
  if (!overview || !checksRoot || !refreshButton) return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const STATUS_META = Object.freeze({
    operational: { label: "정상", overview: "모든 시스템 정상 운영 중", className: "operational", mark: "m8 12 2.5 2.5L16.5 8.5" },
    degraded: { label: "성능 저하", overview: "일부 시스템 성능 저하", className: "degraded", mark: "M12 7.5v5.2m0 3.7v.1" },
    down: { label: "장애", overview: "일부 시스템 장애 발생", className: "down", mark: "m8.5 8.5 7 7m0-7-7 7" },
    unknown: { label: "확인 지연", overview: "상태 확인 지연", className: "unknown", mark: "M12 8.3v4.3m0 3.6v.1" },
  });

  const ICONS = Object.freeze({
    website: ["circle", "M3.5 12h17M12 3.5a14 14 0 0 1 0 17M12 3.5a14 14 0 0 0 0 17"],
    auth: ["path", "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6"],
    report: ["path", "M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5m-5 3h5"],
    file: ["path", "M3.5 6.5h6l2 2h9v10h-17z"],
    storage: ["path", "M3.5 6.5h6l2 2h9v10h-17z"],
    email: ["path", "M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6"],
    database: ["path", "M5 6c0-1.4 3.1-2.5 7-2.5S19 4.6 19 6s-3.1 2.5-7 2.5S5 7.4 5 6Zm0 0v6c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V6m0 6v6c0 1.4-3.1 2.5-7 2.5S5 19.4 5 18v-6"],
    default: ["path", "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm-4 8.7 2.5 2.5 5.5-6"],
  });

  function normalizeStatus(value) {
    if (value === true) return "operational";
    if (value === false) return "down";
    const status = String(value || "").trim().toLowerCase();
    if (["ok", "up", "healthy", "normal", "operational", "available", "success"].includes(status)) return "operational";
    if (["degraded", "slow", "warning", "partial", "partial_outage"].includes(status)) return "degraded";
    if (["down", "error", "failed", "failure", "outage", "unavailable", "major_outage"].includes(status)) return "down";
    return "unknown";
  }

  function deriveOverall(payload, checks) {
    const explicit = normalizeStatus(payload.overall || payload.status || payload.ok);
    if (explicit !== "unknown") return explicit;
    if (!checks.length) return "unknown";
    const statuses = checks.map((check) => normalizeStatus(check.status));
    if (statuses.includes("down")) return "down";
    if (statuses.includes("degraded")) return "degraded";
    if (statuses.every((status) => status === "operational")) return "operational";
    return "unknown";
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function formatAbsolute(value) {
    const date = parseDate(value);
    if (!date) return "확인 시각 없음";
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(date);
  }

  function formatRelative(value) {
    const date = parseDate(value);
    if (!date) return "확인 시각 없음";
    const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
    if (seconds < 10) return "방금 확인";
    if (seconds < 60) return `${seconds}초 전 확인`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}분 전 확인`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전 확인`;
    return formatAbsolute(date);
  }

  function iconFor(key) {
    const normalizedKey = String(key || "").toLowerCase();
    const iconKey = Object.keys(ICONS).find((candidate) => candidate !== "default" && normalizedKey.includes(candidate));
    const [tag, data] = ICONS[iconKey || "default"];
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (tag === "circle") {
      const circle = document.createElementNS(SVG_NS, "circle");
      circle.setAttribute("cx", "12");
      circle.setAttribute("cy", "12");
      circle.setAttribute("r", "8.5");
      svg.appendChild(circle);
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", data);
      svg.appendChild(path);
    } else {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", data);
      svg.appendChild(path);
    }
    return svg;
  }

  function chevronIcon() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.classList.add("status-check__chevron");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "m9 6 6 6-6 6");
    svg.appendChild(path);
    return svg;
  }

  function renderChecks(checks, fallbackCheckedAt) {
    checksRoot.replaceChildren();
    if (!checks.length) {
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "현재 공개된 서비스별 점검 데이터가 없습니다.";
      checksRoot.appendChild(empty);
      return;
    }

    checks.forEach((check) => {
      const status = normalizeStatus(check.status);
      const details = document.createElement("details");
      details.className = `status-check is-${STATUS_META[status].className}`;

      const summary = document.createElement("summary");
      const service = document.createElement("span");
      service.className = "status-check__service";
      const icon = document.createElement("span");
      icon.className = "status-check__service-icon";
      icon.appendChild(iconFor(check.key));
      const label = document.createElement("strong");
      label.textContent = String(check.label || check.key || "이름 없는 서비스");
      service.append(icon, label);

      const state = document.createElement("span");
      state.className = "status-check__state";
      state.textContent = STATUS_META[status].label;
      const latency = document.createElement("span");
      latency.className = "status-check__latency";
      const hasLatency = check.latencyMs !== null && check.latencyMs !== "" && Number.isFinite(Number(check.latencyMs));
      latency.textContent = hasLatency ? `${Math.max(0, Math.round(Number(check.latencyMs)))}ms` : "측정 안 됨";
      const time = document.createElement("time");
      time.className = "status-check__time";
      const checkedAt = check.checkedAt || fallbackCheckedAt;
      time.dateTime = parseDate(checkedAt)?.toISOString() || "";
      time.textContent = formatRelative(checkedAt);
      time.title = formatAbsolute(checkedAt);
      summary.append(service, state, latency, time, chevronIcon());

      const detail = document.createElement("p");
      detail.className = "status-check__detail";
      detail.textContent = String(check.detail || "이 점검에서 제공된 추가 설명이 없습니다.");
      details.append(summary, detail);
      checksRoot.appendChild(details);
    });
  }

  function renderOverview(status, checkedAt, detail) {
    const meta = STATUS_META[status];
    overview.className = `status-overview is-${meta.className}`;
    overview.setAttribute("aria-busy", "false");
    overviewTitle.textContent = meta.overview;
    overviewChecked.textContent = detail || formatRelative(checkedAt);
    overviewChecked.title = formatAbsolute(checkedAt);
    if (overviewMark) overviewMark.setAttribute("d", meta.mark);
    currentHistoryBar.className = `is-${meta.className === "operational" ? "current" : meta.className}`;
    historyNote.textContent = checkedAt
      ? `현재 상태는 ${formatAbsolute(checkedAt)}에 확인했습니다. 일별 가동률은 이 데이터만으로 추정하지 않습니다.`
      : "현재 확인 시각을 받지 못했습니다. 일별 가동률은 임의로 표시하지 않습니다.";
  }

  async function loadStatus() {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-loading");
    overview.setAttribute("aria-busy", "true");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/status", {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`상태 API 응답 오류 (${response.status})`);
      const payload = await response.json();
      const checks = Array.isArray(payload.checks) ? payload.checks.filter((item) => item && typeof item === "object") : [];
      if (!checks.length && payload.status == null && payload.overall == null && payload.ok == null) {
        throw new Error("상태 데이터 형식을 확인할 수 없습니다.");
      }
      const checkedAt = payload.checkedAt || new Date().toISOString();
      const overallStatus = deriveOverall(payload, checks);
      renderOverview(overallStatus, checkedAt);
      renderChecks(checks, checkedAt);
    } catch (error) {
      renderOverview("unknown", null, "서버에서 최신 상태를 받지 못했습니다.");
      checksRoot.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "status-empty";
      empty.textContent = "상태 확인이 지연되고 있습니다. 잠시 후 새로고침해 주세요.";
      checksRoot.appendChild(empty);
    } finally {
      clearTimeout(timeout);
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-loading");
      overview.setAttribute("aria-busy", "false");
    }
  }

  refreshButton.addEventListener("click", loadStatus);
  const autoRefresh = window.setInterval(() => {
    if (document.visibilityState === "visible") loadStatus();
  }, 60_000);
  window.addEventListener("pagehide", () => window.clearInterval(autoRefresh), { once: true });
  loadStatus();
})();
