import { loadEntitlementsSnapshot } from "./entitlements.js";

/* Account Center extensions: personal provider keys and subscription tier. */
(function initByok() {
  const byId = (id) => document.getElementById(id);
  const card = byId("byokCard");
  const status = byId("byokStatus");
  const message = byId("byokMsg");
  if (!card || !status) return;

  const providerUi = {
    anthropic: {
      input: byId("byokAnthropicInput"),
      save: byId("byokSaveAnthropic"),
      remove: byId("byokDelAnthropic"),
      status: byId("byokAnthropicStatus"),
    },
    openai: {
      input: byId("byokOpenaiInput"),
      save: byId("byokSaveOpenai"),
      remove: byId("byokDelOpenai"),
      status: byId("byokOpenaiStatus"),
    },
  };

  function note(text, tone = "muted") {
    if (!message) return;
    message.textContent = text;
    message.dataset.tone = tone;
  }

  function setProviderState(provider, key) {
    const ui = providerUi[provider];
    if (!ui) return;
    const connected = !!key;
    if (ui.status) {
      ui.status.textContent = connected ? `등록됨 · …${key.hint || ""}` : "미등록";
      ui.status.dataset.connected = String(connected);
    }
    if (ui.remove) ui.remove.disabled = !connected;
  }

  async function refresh() {
    card.setAttribute("aria-busy", "true");
    status.dataset.state = "loading";
    status.textContent = "연결 상태 확인 중…";
    try {
      const response = await fetch("/api/me/api-keys");
      if (response.status === 401) {
        status.dataset.state = "empty";
        status.textContent = "로그인 후 등록할 수 있습니다.";
        setProviderState("anthropic", null);
        setProviderState("openai", null);
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "연결 상태를 불러오지 못했습니다.");
      const keys = Array.isArray(data.keys) ? data.keys : [];
      const anthropic = keys.find((key) => key.provider === "anthropic") || null;
      const openai = keys.find((key) => key.provider === "openai") || null;
      setProviderState("anthropic", anthropic);
      setProviderState("openai", openai);
      const connected = Number(!!anthropic) + Number(!!openai);
      status.dataset.state = connected ? "ready" : "empty";
      status.textContent = connected ? `${connected}개 연결됨` : "연결된 API 없음";
    } catch (error) {
      status.dataset.state = "error";
      status.textContent = error.message || "연결 상태를 불러오지 못했습니다.";
      setProviderState("anthropic", null);
      setProviderState("openai", null);
    } finally {
      card.setAttribute("aria-busy", "false");
    }
  }

  async function save(provider) {
    const ui = providerUi[provider];
    const key = (ui?.input?.value || "").trim();
    if (!key) { note("API 키를 입력하세요.", "danger"); ui?.input?.focus(); return; }
    if (ui.save) { ui.save.disabled = true; ui.save.textContent = "등록 중…"; }
    note("키를 안전하게 등록하는 중입니다.");
    try {
      const response = await fetch("/api/me/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "저장에 실패했습니다.");
      ui.input.value = "";
      note("등록했습니다. 이 제공자의 생성은 내 API 키로 실행됩니다.", "success");
      await refresh();
      document.dispatchEvent(new CustomEvent("quilo:model-providers-changed"));
    } catch (error) {
      note(error.message || "저장 중 오류가 발생했습니다.", "danger");
    } finally {
      if (ui.save) { ui.save.disabled = false; ui.save.textContent = "등록"; }
    }
  }

  async function remove(provider) {
    const ui = providerUi[provider];
    let removed = false;
    if (ui?.remove) { ui.remove.disabled = true; ui.remove.textContent = "삭제 중…"; }
    note("연결을 삭제하는 중입니다.");
    try {
      const response = await fetch(`/api/me/api-keys/${provider}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "삭제에 실패했습니다.");
      removed = true;
      note("연결을 삭제했습니다. 이후 생성은 서버 키와 크레딧을 사용합니다.", "success");
      await refresh();
      document.dispatchEvent(new CustomEvent("quilo:model-providers-changed"));
    } catch (error) {
      note(error.message || "삭제 중 오류가 발생했습니다.", "danger");
    } finally {
      if (ui?.remove) {
        ui.remove.textContent = "삭제";
        if (!removed) ui.remove.disabled = false;
      }
    }
  }

  providerUi.anthropic.save?.addEventListener("click", () => save("anthropic"));
  providerUi.anthropic.remove?.addEventListener("click", () => remove("anthropic"));
  providerUi.openai.save?.addEventListener("click", () => save("openai"));
  providerUi.openai.remove?.addEventListener("click", () => remove("openai"));
  refresh();
})();

(function initTierStatus() {
  const status = document.getElementById("tierStatus");
  const upsell = document.getElementById("maxUpsell");
  const planInfo = document.getElementById("maxPlanInfo");
  const requestButton = document.getElementById("maxRequestBtn");
  if (!status) return;

  status.dataset.state = "loading";
  loadEntitlementsSnapshot().then(({ subscription, beta }) => {
    if (!subscription && !beta) {
      status.dataset.state = "error";
      status.textContent = "확인할 수 없음";
      if (upsell) upsell.hidden = true;
      return;
    }
    const features = Array.isArray(beta?.features) ? beta.features : [];
    let tier = "free";
    let label = "Free";
    let detail = "크레딧으로 보고서 생성";
    if (subscription?.admin || beta?.admin === true) {
      tier = "admin";
      label = "Admin";
      detail = "모든 기능 사용 가능";
    } else if (subscription?.active) {
      tier = "max";
      label = "Max";
      detail = subscription.expiresAt
        ? `${new Date(subscription.expiresAt).toLocaleDateString("ko-KR")}까지`
        : "백그라운드 실행 포함";
    } else if (beta?.tier === "pro" || (!beta?.tier && features.length)) {
      tier = "pro";
      label = "Pro";
      detail = "고급 학습 기능 사용 가능";
    }
    status.dataset.state = "ready";
    status.dataset.tier = tier;
    status.textContent = detail ? `${label} · ${detail}` : label;
    const triggerMeta = document.getElementById("accountTriggerMeta");
    const menuMeta = document.getElementById("accountMenuMeta");
    if (triggerMeta) triggerMeta.textContent = label;
    if (menuMeta) menuMeta.textContent = `${label} plan`;

    if (!upsell) return;
    const canUpgrade = tier === "free" || tier === "pro";
    upsell.hidden = !canUpgrade;
    if (!canUpgrade) return;
    const plan = subscription?.plan || {};
    const price = plan.priceKrw ? `${Number(plan.priceKrw).toLocaleString()}원` : "가격은 관리자 문의";
    const period = plan.periodDays || 30;
    if (planInfo) {
      const bank = plan.bank ? ` · 입금 ${plan.bank} ${plan.account || ""}${plan.holder ? ` (${plan.holder})` : ""}` : "";
      planInfo.textContent = `Max ${period}일 · ${price} · 백그라운드 실행과 PDF 통번역${bank}`;
    }
  });

  requestButton?.addEventListener("click", () => {
    if (typeof window.__openMaxModal === "function") window.__openMaxModal();
    else alert("신청 창을 열 수 없습니다. 새로고침 후 다시 시도하거나 관리자에게 문의하세요.");
  });
})();
