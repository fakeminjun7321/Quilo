import { jsonOptions, requestJson } from "./api.js";
import { byId } from "./dom-contract.js";
import {
  getStoredStudentId,
  getStoredStyleNote,
  normalizeStudentId,
  storeStudentId,
  storeStyleNote,
} from "./state.js";
import { initDefaultReportPreferences } from "./report-preferences.js";
import { CONSENT_VERSION, setTelemetryConsent } from "./telemetry.js";

function setStatus(node, text, tone = "muted") {
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function applyStyleNote(note) {
  const value = note || getStoredStyleNote();
  if (value) storeStyleNote(value);
  ["settingsStyleNote", "cpStyleNote", "crStyleNote", "prStyleNote", "piStyleNote", "miStyleNote", "frStyleNote"].forEach((id) => {
    const field = byId(id);
    if (field && !field.value) field.value = value;
  });
}

function requestedReturnPath() {
  const raw = new URLSearchParams(location.search).get("next")
    || new URLSearchParams(location.search).get("returnTo")
    || "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "";
  try {
    const target = new URL(raw, location.origin);
    if (target.origin !== location.origin || ["/login", "/login.html"].includes(target.pathname)) return "";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch (_) {
    return "";
  }
}

function profileRoleLabel(user = {}) {
  const labels = [];
  if (user.isAdmin) labels.push("관리자");
  if (user.isDeveloper) labels.push("Quilo 개발자");
  if (user.isStaff) labels.push("스탭");
  return labels.length ? labels.join(" · ") : "일반 사용자";
}

function applyProfilePresentation(user = {}) {
  const name = String(user.user || user.name || "Quilo 사용자");
  const role = profileRoleLabel(user);
  if (byId("settingsUserRole")) byId("settingsUserRole").textContent = role;
  if (byId("settingsProfileName")) byId("settingsProfileName").textContent = name;
  if (byId("settingsProfileRole")) byId("settingsProfileRole").textContent = role;
  if (byId("settingsProfileBio")) byId("settingsProfileBio").value = String(user.profileBio || "");
  const avatar = byId("settingsAvatar");
  const fallback = byId("settingsAvatarFallback");
  const hasAvatar = !!user.avatarUrl;
  if (avatar) {
    avatar.hidden = !hasAvatar;
    if (hasAvatar) avatar.src = user.avatarUrl;
    else avatar.removeAttribute("src");
  }
  if (fallback) {
    fallback.hidden = hasAvatar;
    fallback.textContent = (name.trim()[0] || "Q").toUpperCase();
  }
  if (byId("settingsAvatarRemove")) byId("settingsAvatarRemove").hidden = !hasAvatar;
}

const REPORT_MODEL_RADIO_SELECTOR =
  'input[type="radio"][name="model"], input[type="radio"][name$="Model"]';
const RESTRICTION_ORIGINAL_HIDDEN = "restrictionOriginalHidden";
const RESTRICTION_ORIGINAL_DISABLED = "restrictionOriginalDisabled";
const AVAILABILITY_APPLIED = "modelAvailabilityApplied";
const AVAILABILITY_ORIGINAL_DISABLED = "availabilityOriginalDisabled";
const AVAILABILITY_ORIGINAL_TITLE = "availabilityOriginalTitle";
const AVAILABILITY_ORIGINAL_DESCRIBED_BY = "availabilityOriginalDescribedBy";
const AVAILABILITY_ORIGINAL_LABEL_TITLE = "availabilityOriginalLabelTitle";
const AVAILABILITY_ORIGINAL_LABEL_ARIA_DISABLED = "availabilityOriginalLabelAriaDisabled";
const AVAILABILITY_SUBMIT_BLOCKED = "modelProviderBlocked";
const AVAILABILITY_SUBMIT_ORIGINAL_DISABLED = "providerOriginalDisabled";
const AVAILABILITY_SUBMIT_ORIGINAL_TITLE = "providerOriginalTitle";
const RETIRED_REPORT_TYPES = new Set([
  "eng-exam-prep",
  "korean-lit-exam",
  "phys-mock-exam",
  "phys-inquiry",
  "math-inquiry",
]);
const ACCESS_FORCED_HIDDEN = "reportAccessForcedHidden";
const ACCESS_PRIOR_HIDDEN = "reportAccessPriorHidden";

function groupReportModelRadios(radios) {
  const groups = new Map();
  radios.forEach((radio) => {
    if (!groups.has(radio.name)) groups.set(radio.name, []);
    groups.get(radio.name).push(radio);
  });
  return groups;
}

function restoreReportModelAccess(radios) {
  radios.forEach((radio) => {
    const label = radio.closest("label");
    if (label && RESTRICTION_ORIGINAL_HIDDEN in label.dataset) {
      label.hidden = label.dataset[RESTRICTION_ORIGINAL_HIDDEN] === "true";
      delete label.dataset[RESTRICTION_ORIGINAL_HIDDEN];
    }
    if (RESTRICTION_ORIGINAL_DISABLED in radio.dataset) {
      radio.disabled = radio.dataset[RESTRICTION_ORIGINAL_DISABLED] === "true";
      delete radio.dataset[RESTRICTION_ORIGINAL_DISABLED];
    }
  });
}

function ensureVisibleModelSelection(groups) {
  groups.forEach((group) => {
    const selectable = group.filter((radio) => {
      const label = radio.closest("label");
      return !radio.disabled && (!label || !label.hidden);
    });
    group.forEach((radio) => {
      const label = radio.closest("label");
      if (radio.checked && (radio.disabled || label?.hidden)) radio.checked = false;
    });
    if (!selectable.some((radio) => radio.checked) && selectable[0]) {
      selectable[0].checked = true;
    }
  });
}

function applyAdminModelVisibility(isAdmin, fableDisabled = false) {
  document.querySelectorAll("label.fable-model").forEach((node) => {
    node.hidden = !isAdmin || !!fableDisabled;
  });
  document.querySelectorAll("label.beta-model").forEach((node) => {
    node.hidden = !isAdmin;
  });
  ensureVisibleModelSelection(
    groupReportModelRadios(
      Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR)),
    ),
  );
}

function applyReportModelRestriction(restrictedModel) {
  const radios = Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR));
  restoreReportModelAccess(radios);
  const groups = groupReportModelRadios(radios);
  const allowedModels = new Set(
    String(restrictedModel || "")
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean),
  );
  if (!allowedModels.size) {
    ensureVisibleModelSelection(groups);
    return;
  }

  groups.forEach((group) => {
    let selectable = group.filter((radio) => {
      const label = radio.closest("label");
      return allowedModels.has(radio.value) && !radio.disabled && !label?.hidden;
    });
    // 서버도 이 보고서에서 제한 모델을 쓸 수 없으면 Sonnet(또는 첫 허용 모델)으로
    // 안전하게 폴백한다. UI 역시 선택지가 전부 사라지지 않게 같은 계약을 따른다.
    if (!selectable.length) {
      selectable = group.filter((radio) => {
        const label = radio.closest("label");
        return !radio.disabled && !label?.hidden;
      });
      const sonnet = selectable.find((radio) => radio.value === "claude-sonnet-5");
      selectable = sonnet ? [sonnet] : selectable.slice(0, 1);
    }
    const selectableSet = new Set(selectable);
    group.forEach((radio) => {
      const label = radio.closest("label");
      if (label) {
        label.dataset[RESTRICTION_ORIGINAL_HIDDEN] = String(label.hidden);
        label.hidden = !selectableSet.has(radio);
      }
      radio.dataset[RESTRICTION_ORIGINAL_DISABLED] = String(radio.disabled);
      radio.disabled = radio.disabled || !selectableSet.has(radio);
      if (!selectableSet.has(radio)) radio.checked = false;
    });
    const selected = selectable.find((radio) => radio.checked && !radio.disabled);
    if (!selected && selectable[0] && !selectable[0].disabled) selectable[0].checked = true;
  });
}

function reportModelProvider(model) {
  const value = String(model || "");
  if (/^gpt/i.test(value)) return "openai";
  if (/^gemini/i.test(value)) return "gemini";
  return "anthropic";
}

const REPORT_PROVIDER_COPY = {
  anthropic: {
    label: "Anthropic",
    title: "Anthropic 연결이 없어 현재 사용할 수 없습니다. Account Center에서 Anthropic API 키를 등록해 주세요.",
  },
  openai: {
    label: "OpenAI",
    title: "OpenAI 연결이 없어 현재 사용할 수 없습니다. Account Center에서 OpenAI API 키를 등록해 주세요.",
  },
  gemini: {
    label: "Gemini",
    title: "서버에 Gemini 연결이 없어 현재 사용할 수 없습니다. 다른 모델을 선택해 주세요.",
  },
};

function restoreReportModelAvailability(radios) {
  const forms = new Set(radios.map((radio) => radio.closest("form")).filter(Boolean));
  forms.forEach((form) => {
    form.querySelectorAll('[data-model-provider-blocked="true"]').forEach((button) => {
      button.disabled = button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_DISABLED] === "true";
      const title = button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_TITLE] || "";
      if (title) button.title = title;
      else button.removeAttribute("title");
      delete button.dataset[AVAILABILITY_SUBMIT_BLOCKED];
      delete button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_DISABLED];
      delete button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_TITLE];
    });
  });
  radios.forEach((radio) => {
    if (radio.dataset[AVAILABILITY_APPLIED] !== "true") return;
    const label = radio.closest("label");
    radio.disabled = radio.dataset[AVAILABILITY_ORIGINAL_DISABLED] === "true";
    const radioTitle = radio.dataset[AVAILABILITY_ORIGINAL_TITLE] || "";
    if (radioTitle) radio.title = radioTitle;
    else radio.removeAttribute("title");
    const describedBy = radio.dataset[AVAILABILITY_ORIGINAL_DESCRIBED_BY] || "";
    if (describedBy) radio.setAttribute("aria-describedby", describedBy);
    else radio.removeAttribute("aria-describedby");
    if (label) {
      const labelTitle = label.dataset[AVAILABILITY_ORIGINAL_LABEL_TITLE] || "";
      if (labelTitle) label.title = labelTitle;
      else label.removeAttribute("title");
      const ariaDisabled = label.dataset[AVAILABILITY_ORIGINAL_LABEL_ARIA_DISABLED] || "";
      if (ariaDisabled) label.setAttribute("aria-disabled", ariaDisabled);
      else label.removeAttribute("aria-disabled");
      label.classList.remove("is-provider-unavailable");
      delete label.dataset.modelProviderAvailability;
      label.querySelector('[data-model-provider-note="true"]')?.remove();
    }
    delete radio.dataset[AVAILABILITY_APPLIED];
    delete radio.dataset[AVAILABILITY_ORIGINAL_DISABLED];
    delete radio.dataset[AVAILABILITY_ORIGINAL_TITLE];
    delete radio.dataset[AVAILABILITY_ORIGINAL_DESCRIBED_BY];
    delete radio.dataset[AVAILABILITY_ORIGINAL_LABEL_TITLE];
    delete radio.dataset[AVAILABILITY_ORIGINAL_LABEL_ARIA_DISABLED];
  });
}

function applyReportModelProviderAvailability(modelProviders) {
  if (!modelProviders || typeof modelProviders !== "object") return;
  const radios = Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR));
  radios.forEach((radio, index) => {
    const provider = reportModelProvider(radio.value);
    // Only an explicit false disables a provider. This keeps older/partial API
    // responses backward-compatible instead of guessing that a key is absent.
    if (modelProviders[provider] !== false) return;
    const label = radio.closest("label");
    const copy = REPORT_PROVIDER_COPY[provider];
    radio.dataset[AVAILABILITY_APPLIED] = "true";
    radio.dataset[AVAILABILITY_ORIGINAL_DISABLED] = String(radio.disabled);
    radio.dataset[AVAILABILITY_ORIGINAL_TITLE] = radio.getAttribute("title") || "";
    radio.dataset[AVAILABILITY_ORIGINAL_DESCRIBED_BY] = radio.getAttribute("aria-describedby") || "";
    radio.disabled = true;
    radio.checked = false;
    radio.title = copy.title;
    if (!label) return;
    radio.dataset[AVAILABILITY_ORIGINAL_LABEL_TITLE] = label.getAttribute("title") || "";
    radio.dataset[AVAILABILITY_ORIGINAL_LABEL_ARIA_DISABLED] = label.getAttribute("aria-disabled") || "";
    label.classList.add("is-provider-unavailable");
    label.dataset.modelProviderAvailability = "unavailable";
    label.setAttribute("aria-disabled", "true");
    label.title = copy.title;
    const note = document.createElement("span");
    note.id = `model-provider-note-${radio.name}-${index}`;
    note.className = "model-unavailable-note";
    note.dataset.modelProviderNote = "true";
    note.textContent = `현재 사용 불가 · ${copy.label} 연결 필요`;
    label.append(note);
    const originalDescription = radio.dataset[AVAILABILITY_ORIGINAL_DESCRIBED_BY];
    radio.setAttribute(
      "aria-describedby",
      [originalDescription, note.id].filter(Boolean).join(" "),
    );
  });
  ensureVisibleModelSelection(groupReportModelRadios(radios));
  groupReportModelRadios(radios).forEach((group) => {
    const form = group[0]?.closest("form");
    if (!form) return;
    const hasSelectableModel = group.some((radio) => {
      const label = radio.closest("label");
      return !radio.disabled && !label?.hidden;
    });
    if (hasSelectableModel) return;
    form.querySelectorAll('button[type="submit"], input[type="submit"]').forEach((button) => {
      button.dataset[AVAILABILITY_SUBMIT_BLOCKED] = "true";
      button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_DISABLED] = String(button.disabled);
      button.dataset[AVAILABILITY_SUBMIT_ORIGINAL_TITLE] = button.getAttribute("title") || "";
      button.disabled = true;
      button.title = "현재 연결된 AI 제공자가 없습니다. 모델 연결 상태를 확인해 주세요.";
    });
  });
}

export function createAccountController({ state, router, hooks }) {
  const balanceState = { known: false, credits: 0, unlimited: false, isAdmin: false };

  function applyAnalyticsState(user = {}) {
    const version = String(user.analyticsConsentVersion || "");
    const policyVersion = String(user.analyticsPolicyVersion || CONSENT_VERSION);
    const granted = !!user.analyticsConsent && version === policyVersion;
    const decided = version === policyVersion;
    const toggle = byId("analyticsConsentToggle");
    if (toggle) toggle.checked = granted;
    const notice = byId("analyticsConsentNotice");
    if (notice) notice.hidden = decided;
    setTelemetryConsent(granted, version, policyVersion);
  }

  async function saveAnalyticsConsent(granted) {
    const toggle = byId("analyticsConsentToggle");
    const accept = byId("analyticsConsentAccept");
    const decline = byId("analyticsConsentDecline");
    [toggle, accept, decline].forEach((node) => { if (node) node.disabled = true; });
    setStatus(byId("analyticsConsentStatus"), "저장 중...");
    try {
      const data = await requestJson(
        "/api/me/analytics-consent",
        jsonOptions("PATCH", { granted: !!granted }),
      );
      const current = {
        ...(state.get().user || {}),
        analyticsConsent: !!data.granted,
        analyticsConsentVersion: data.version,
        analyticsPolicyVersion: data.version,
      };
      state.set({ user: current });
      applyAnalyticsState(current);
      setStatus(
        byId("analyticsConsentStatus"),
        data.granted ? "선택형 이용 분석에 동의했습니다." : "선택형 이용 분석을 사용하지 않습니다.",
        "success",
      );
    } catch (error) {
      if (toggle) toggle.checked = !granted;
      setStatus(byId("analyticsConsentStatus"), error.message, "danger");
    } finally {
      [toggle, accept, decline].forEach((node) => { if (node) node.disabled = false; });
    }
  }

  function setStudentId(value) {
    const studentId = normalizeStudentId(value);
    state.set({ studentId });
    if (byId("settingsStudentId")) byId("settingsStudentId").textContent = studentId || "미설정";
    if (byId("settingsStudentIdInput")) byId("settingsStudentIdInput").value = studentId;
    hooks.studentIdChanged?.(studentId);
  }

  function applyReportAccess(blocked, isAdmin = false) {
    const denied = new Set(Array.isArray(blocked) ? blocked : []);
    document.querySelectorAll('input[name="reportType"]').forEach((radio) => {
      const label = radio.closest("label");
      if (!label) return;
      // 이전 로그인/권한 갱신에서 이 함수가 숨긴 상태만 먼저 되돌린다. HTML의
      // 초기 hidden 또는 entitlement 로더가 정한 현재 상태는 그대로 보존한다.
      if (label.dataset[ACCESS_FORCED_HIDDEN] === "true") {
        label.hidden = label.dataset[ACCESS_PRIOR_HIDDEN] === "true";
      }
      delete label.dataset[ACCESS_FORCED_HIDDEN];
      delete label.dataset[ACCESS_PRIOR_HIDDEN];
      const adminOnly = radio.value === "print-pdf-restore";
      const accessDenied =
        RETIRED_REPORT_TYPES.has(radio.value) ||
        denied.has(radio.value) ||
        (adminOnly && !isAdmin);
      label.dataset.reportAccessDenied = String(accessDenied);
      if (accessDenied) {
        label.dataset[ACCESS_PRIOR_HIDDEN] = String(label.hidden);
        label.dataset[ACCESS_FORCED_HIDDEN] = "true";
        label.hidden = true;
      }
      if (label.hidden && radio.checked) radio.checked = false;
    });
  }

  function applyVerification(user) {
    const eligible = !user || user.isAdmin || !!user.reportEligible;
    state.set({ reportEligible: eligible });
    document.body.dataset.reportEligible = eligible ? "yes" : "no";
    const banner = byId("verifyBanner");
    if (!banner) return;
    banner.hidden = eligible;
    if (eligible) return;
    if (byId("verifyEmailLabel")) byId("verifyEmailLabel").textContent = "학교 이메일";
    if (byId("verifyEmailInput") && !byId("verifyEmailInput").value) byId("verifyEmailInput").placeholder = "student@school.edu";
    const waitingApproval = !!user.emailVerified;
    if (byId("verifyTitle")) byId("verifyTitle").textContent = waitingApproval ? "2단계 · 관리자 승인 대기 중" : "1단계 · 학교 이메일 인증";
    if (byId("verifyEmailForm")) byId("verifyEmailForm").hidden = waitingApproval;
    if (byId("verifyMsg")) {
      byId("verifyMsg").textContent = waitingApproval
        ? "학교 이메일 인증이 완료되었습니다. 관리자 승인을 기다려 주세요."
        : user.pendingEmail
          ? `${user.pendingEmail}로 인증 메일을 보냈습니다. 메일의 인증 링크를 눌러 주세요.`
          : "학교·대학 등 교육기관 이메일을 입력하면 인증 링크를 보내드립니다. 개인 메일은 사용할 수 없습니다.";
    }
  }

  async function loadBalance() {
    try {
      const data = await requestJson("/api/me/balance");
      Object.assign(balanceState, {
        known: true,
        credits: Math.max(0, Math.trunc(Number(data.credits) || 0)),
        unlimited: !!data.unlimited || !!data.isAdmin,
        isAdmin: !!data.isAdmin,
      });
      const modelRadios = Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR));
      // Layer model state deterministically: clear the prior provider layer,
      // recalculate the account restriction, then apply current provider state.
      restoreReportModelAvailability(modelRadios);
      applyReportModelRestriction(data.restrictedModel);
      applyReportModelProviderAvailability(data.modelProviders);
      if (data.isAdmin) return;
      const credits = balanceState.credits;
      const box = byId("balanceBox");
      if (byId("balCredits")) byId("balCredits").textContent = data.unlimited ? "무제한 (Pro)" : `${credits} 크레딧`;
      if (byId("balConvert")) byId("balConvert").textContent = data.unlimited
        ? ""
        : `기본(Opus)으로 약 ${Math.floor(credits / 4)}건 · GPT-5.4 mini는 하루 5건 무료 · 이후 1크레딧`;
      box?.classList.toggle("is-low", !data.unlimited && credits < 4);
      if (box) box.hidden = false;
      document.querySelector(".report-toolbar")?.classList.add("has-balance");
    } catch (_) {}
  }

  async function loadUsage() {
    const credits = byId("usageCredits");
    if (!credits) return;
    const card = byId("usageCard");
    const recent = byId("usageRecent");
    card?.setAttribute("aria-busy", "true");
    if (recent) {
      recent.dataset.state = "loading";
      const loading = document.createElement("p");
      loading.className = "account-state-copy";
      loading.textContent = "사용 내역을 불러오는 중입니다.";
      recent.replaceChildren(loading);
    }
    try {
      const data = await requestJson("/api/me/usage");
      const unlimited = data.isAdmin || data.unlimited;
      credits.textContent = unlimited ? "무제한" : `${data.credits ?? 0}`;
      const generated = Math.max(0, Number(data.genCount) || 0);
      const limit = Math.max(1, Number(data.genLimit) || 5);
      if (byId("usageGen")) byId("usageGen").textContent = unlimited ? `${generated}회` : `${generated} / ${limit}`;
      if (byId("usageGenLabel")) byId("usageGenLabel").textContent = unlimited ? "이번 시간 · 제한 없음" : "생성";
      const restriction = byId("usageRestriction");
      if (restriction) restriction.hidden = !data.restrictedModel;
      if (byId("usageRestrict")) byId("usageRestrict").textContent = data.restrictedModel || "-";
      const meter = byId("usageMeter");
      if (meter) {
        meter.hidden = unlimited;
        meter.max = limit;
        meter.value = Math.min(limit, generated);
      }
      if (!recent) return;
      const rows = Array.isArray(data.recent) ? data.recent : [];
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "account-state-copy";
        empty.textContent = "최근 생성 기록이 없습니다.";
        recent.dataset.state = "empty";
        recent.replaceChildren(empty);
        return;
      }
      const table = document.createElement("table");
      table.className = "account-usage-table";
      const head = document.createElement("thead");
      const headRow = document.createElement("tr");
      ["날짜", "작업", "모델", "크레딧"].forEach((label) => {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = label;
        headRow.appendChild(cell);
      });
      head.appendChild(headRow);
      const body = document.createElement("tbody");
      rows.forEach((entry) => {
        const row = document.createElement("tr");
        const values = [
          entry.date ? new Date(entry.date).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }) : "-",
          entry.label || "생성",
          entry.model || "-",
          entry.credits == null ? "Pro·무료" : entry.credits ? `${entry.credits}크레딧` : "무료",
        ];
        values.forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
        body.append(row);
      });
      table.append(head, body);
      recent.dataset.state = "ready";
      recent.replaceChildren(table);
    } catch (_) {
      if (recent) {
        const error = document.createElement("p");
        error.className = "account-state-copy";
        error.dataset.tone = "danger";
        error.textContent = "사용 내역을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
        recent.dataset.state = "error";
        recent.replaceChildren(error);
      }
    } finally {
      card?.setAttribute("aria-busy", "false");
    }
  }

  function bindAccountNavigation() {
    const panel = byId("settingsPanel");
    if (!panel) return;
    const links = Array.from(panel.querySelectorAll("[data-account-nav]"));
    const sections = Array.from(panel.querySelectorAll("[data-account-section]"));
    const activate = (name) => links.forEach((link) => {
      const active = link.dataset.accountNav === name;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
    links.forEach((link) => link.addEventListener("click", (event) => {
      event.preventDefault();
      const target = panel.querySelector(link.getAttribute("href"));
      if (!target) return;
      activate(link.dataset.accountNav);
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.dataset.accountSection) activate(visible.target.dataset.accountSection);
    }, { rootMargin: "-20% 0px -65% 0px", threshold: [0, .1, .35] });
    sections.forEach((section) => observer.observe(section));
  }

  function applyAuth(loggedIn, user = null) {
    state.set({ auth: loggedIn ? "in" : "out", user });
    document.body.dataset.auth = loggedIn ? "in" : "out";
    if (byId("loginDd")) byId("loginDd").hidden = loggedIn;
    if (byId("acctDd")) byId("acctDd").hidden = !loggedIn;
    if (!loggedIn) {
      setTelemetryConsent(false, "");
      if (byId("analyticsConsentNotice")) byId("analyticsConsentNotice").hidden = true;
      const modelRadios = Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR));
      restoreReportModelAvailability(modelRadios);
      restoreReportModelAccess(modelRadios);
      applyAdminModelVisibility(false);
      applyReportAccess([], false);
      applyVerification(null);
      const requested = router.requestedReport();
      if (requested) { router.setPending(requested); hooks.shell?.openLogin(); }
      hooks.shell?.setView("landing");
      return;
    }
    if (byId("accountMenuName")) byId("accountMenuName").textContent = user.user;
    if (byId("settingsUserName")) byId("settingsUserName").textContent = user.user;
    applyProfilePresentation(user);
    applyAnalyticsState(user);
    setStudentId(user.studentId || getStoredStudentId());
    applyStyleNote(user.styleNote);
    ["piWhoPreview", "miWhoPreview", "frWhoPreview"].forEach((id) => {
      const node = byId(id);
      if (node) node.textContent = state.get().studentId ? `${state.get().studentId} ${user.user}` : `${user.user} (학번 미설정)`;
    });
    if (byId("adminLink")) byId("adminLink").hidden = !user.isAdmin;
    hooks.shell?.loadEntitlements?.();
    const modelRadios = Array.from(document.querySelectorAll(REPORT_MODEL_RADIO_SELECTOR));
    restoreReportModelAvailability(modelRadios);
    restoreReportModelAccess(modelRadios);
    applyAdminModelVisibility(user.isAdmin === true, user.fableDisabled === true);
    window.applyPrefsToForm?.();
    applyReportAccess(user.isAdmin ? [] : user.blockedReportTypes, user.isAdmin === true);
    applyVerification(user);
    loadBalance();
    hooks.filesController?.loadFiles();
    hooks.filesController?.loadCloudStatus();
    const selected = router.consumePending({ scroll: true });
    if (!selected) {
      const requested = router.requestedReport();
      if (!requested || !router.select(requested)) hooks.shell?.setView("landing");
    }
    if (hooks.requestedAccountTab) hooks.shell?.showTab(hooks.requestedAccountTab);
  }

  function bindForms() {
    document.addEventListener("quilo:model-providers-changed", () => {
      void loadBalance();
    });
    byId("analyticsConsentToggle")?.addEventListener("change", (event) => {
      void saveAnalyticsConsent(!!event.currentTarget.checked);
    });
    byId("analyticsConsentAccept")?.addEventListener("click", () => {
      void saveAnalyticsConsent(true);
    });
    byId("analyticsConsentDecline")?.addEventListener("click", () => {
      void saveAnalyticsConsent(false);
    });
    byId("settingsAvatarInput")?.addEventListener("change", async (event) => {
      const input = event.currentTarget;
      const file = input.files?.[0];
      if (!file) return;
      if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
        setStatus(byId("settingsAvatarStatus"), "JPG·PNG·WebP·GIF 파일을 5MB 이하로 선택하세요.", "danger");
        input.value = "";
        return;
      }
      const preview = URL.createObjectURL(file);
      const avatar = byId("settingsAvatar");
      if (avatar) { avatar.src = preview; avatar.hidden = false; }
      if (byId("settingsAvatarFallback")) byId("settingsAvatarFallback").hidden = true;
      setStatus(byId("settingsAvatarStatus"), "사진을 최적화해 저장하는 중입니다.");
      const form = new FormData();
      form.append("avatar", file, file.name);
      try {
        const response = await fetch("/api/editorial/me/avatar", { method: "POST", body: form });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "프로필 사진을 저장하지 못했습니다.");
        const savedUrl = data.profile?.avatarUrl;
        if (avatar && savedUrl) avatar.src = savedUrl;
        if (savedUrl) state.set({ user: { ...(state.get().user || {}), avatarUrl: savedUrl } });
        if (byId("settingsAvatarRemove")) byId("settingsAvatarRemove").hidden = !savedUrl;
        setStatus(byId("settingsAvatarStatus"), "프로필 사진을 저장했습니다.", "success");
      } catch (error) {
        applyProfilePresentation(state.get().user || {});
        setStatus(byId("settingsAvatarStatus"), error.message, "danger");
      } finally {
        URL.revokeObjectURL(preview);
        input.value = "";
      }
    });
    byId("settingsAvatarRemove")?.addEventListener("click", async () => {
      try {
        const data = await requestJson(
          "/api/editorial/me/profile",
          jsonOptions("PATCH", { avatarUrl: null }),
        );
        const current = { ...(state.get().user || {}), avatarUrl: data.profile?.avatarUrl || null };
        state.set({ user: current });
        applyProfilePresentation(current);
        setStatus(byId("settingsAvatarStatus"), "프로필 사진을 삭제했습니다.", "success");
      } catch (error) {
        setStatus(byId("settingsAvatarStatus"), error.message, "danger");
      }
    });
    byId("settingsProfileBioForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const profileBio = byId("settingsProfileBio")?.value.trim() || "";
      try {
        const data = await requestJson(
          "/api/editorial/me/profile",
          jsonOptions("PATCH", { profileBio }),
        );
        const current = { ...(state.get().user || {}), profileBio: data.profile?.profileBio ?? profileBio };
        state.set({ user: current });
        setStatus(byId("settingsProfileBioStatus"), "소개를 저장했습니다.", "success");
      } catch (error) {
        setStatus(byId("settingsProfileBioStatus"), error.message, "danger");
      }
    });
    byId("verifyEmailForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = byId("verifyEmailInput")?.value.trim();
      if (!email) return;
      const button = byId("verifyEmailBtn");
      const status = byId("verifyStatus");
      if (button) button.disabled = true;
      try {
        await requestJson("/api/verify-email/request", jsonOptions("POST", { email }));
        if (status) { status.hidden = false; setStatus(status, `${email}로 인증 메일을 보냈습니다.`, "success"); }
      } catch (error) {
        if (status) { status.hidden = false; setStatus(status, error.message, "danger"); }
      } finally { if (button) button.disabled = false; }
    });
    byId("loginForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const error = byId("li_err");
      const button = byId("li_btn");
      const remember = byId("li_remember")?.checked !== false;
      const username = byId("li_username").value;
      if (error) error.hidden = true;
      button.disabled = true;
      button.textContent = "로그인 중...";
      try {
        const data = await requestJson("/api/login", jsonOptions("POST", { username, password: byId("li_password").value, remember }));
        window.QuiloStoragePrivacy?.protect?.(data.id);
        try { remember ? localStorage.setItem("lastUsername", username) : localStorage.removeItem("lastUsername"); } catch (_) {}
        window.QuiloShellAuth?.notify?.("login");
        if (data.redirect && String(data.redirect).startsWith("/oauth/authorize?")) location.assign(data.redirect);
        else if (requestedReturnPath()) location.assign(requestedReturnPath());
        else location.reload();
      } catch (exception) {
        if (error) { error.hidden = false; error.textContent = exception.message; }
        button.disabled = false;
        button.textContent = "로그인";
      }
    });
    byId("logout")?.addEventListener("click", async (event) => {
      event.preventDefault();
      let response;
      try {
        response = await fetch("/api/logout", { method: "POST" });
      } catch (_) {
        return;
      }
      if (!response.ok) return;
      window.QuiloStoragePrivacy?.signOut?.();
      window.QuiloShellAuth?.notify?.("logout");
      location.href = "/";
    });
    byId("profileForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const studentId = normalizeStudentId(byId("settingsStudentIdInput").value);
      byId("profileBtn").disabled = true;
      setStatus(byId("profileStatus"), "저장 중...");
      try {
        const data = await requestJson("/api/me/profile", jsonOptions("PATCH", { studentId }));
        setStudentId(data.studentId || studentId);
        storeStudentId(data.studentId || studentId);
        setStatus(byId("profileStatus"), "저장 완료", "success");
      } catch (_) {
        setStudentId(studentId); storeStudentId(studentId);
        setStatus(byId("profileStatus"), "이 브라우저에 저장됨", "warning");
      } finally { byId("profileBtn").disabled = false; }
    });
    byId("styleSaveBtn")?.addEventListener("click", async () => {
      const note = byId("settingsStyleNote")?.value.trim() || "";
      storeStyleNote(note); applyStyleNote(note);
      try {
        await requestJson("/api/me/profile", jsonOptions("PATCH", { studentId: state.get().studentId, styleNote: note }));
        setStatus(byId("styleSaveStatus"), "저장 완료", "success");
      } catch (_) { setStatus(byId("styleSaveStatus"), "이 브라우저에 저장됨", "warning"); }
    });
    byId("pwForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const currentPassword = byId("currentPw").value;
      const newPassword = byId("newPw").value;
      if (newPassword !== byId("confirmPw").value) return setStatus(byId("pwStatus"), "새 비밀번호가 일치하지 않습니다.", "danger");
      try {
        await requestJson("/api/me/password", jsonOptions("POST", { currentPassword, newPassword }));
        setStatus(byId("pwStatus"), "변경 완료", "success");
        byId("pwForm").reset();
      } catch (error) { setStatus(byId("pwStatus"), error.message, "danger"); }
    });
    byId("feedbackForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const payload = {
        category: byId("feedbackCategory").value,
        title: byId("feedbackTitle").value.trim(),
        message: byId("feedbackMessage").value.trim(),
        contactEmail: byId("feedbackContactEmail").value.trim(),
        pageUrl: location.href,
      };
      try {
        await requestJson("/api/feedback", jsonOptions("POST", payload));
        setStatus(byId("feedbackStatus"), "접수 완료", "success");
        byId("feedbackForm").reset();
      } catch (error) { setStatus(byId("feedbackStatus"), error.message, "danger"); }
    });
  }

  async function init() {
    bindForms();
    bindAccountNavigation();
    initDefaultReportPreferences();
    const applyShellSession = (shellSession) => {
      if (shellSession?.state === "authenticated") applyAuth(true, shellSession.user);
      else if (shellSession?.state === "anonymous") applyAuth(false);
      // unknown은 로그아웃이 아니다. 네트워크/서버가 회복될 때까지 현재 화면과
      // 마지막으로 확인된 사용자 상태를 그대로 유지한다.
    };
    document.addEventListener("quilo:auth-state", (event) => applyShellSession(event.detail));
    try {
      const saved = localStorage.getItem("lastUsername");
      if (saved && byId("li_username") && !byId("li_username").value) byId("li_username").value = saved;
    } catch (_) {}
    let shellSession;
    try {
      shellSession = window.QuiloShellAuth?.ready
        ? await window.QuiloShellAuth.ready
        : { state: "authenticated", user: await requestJson("/api/me") };
    } catch (_) {
      shellSession = { state: "unknown", user: null };
    }
    applyShellSession(shellSession);
    if (shellSession.state === "anonymous" && new URLSearchParams(location.search).get("login") === "1") {
      hooks.shell?.openLogin();
    }
  }

  return { init, applyAuth, loadBalance, loadUsage, balanceState, setStudentId };
}
