import { loadEntitlementsSnapshot } from "./entitlements.js";

export function createConfirmationController({ balanceState, formatDateTime, findAffordableModelOption, getModelCredits }) {
  function buildCreditDeductRow(credits) {
    if (typeof credits !== "number" || !isFinite(credits)) return null;
    if (!balanceState.known || balanceState.unlimited || balanceState.isAdmin) return null;
    const bal = balanceState.credits;
    const after = bal - credits;
    if (credits <= 0) {
      return { label: "차감 크레딧", value: `무료 · 잔액 ${bal} 유지`, warn: false };
    }
    const insufficient = after < 0;
    return {
      label: "차감 크레딧",
      value: `${credits} 크레딧 · 잔액 ${bal} → ${after}${insufficient ? " (부족)" : ""}`,
      warn: insufficient,
    };
  }

  // ── 백그라운드 실행(구독자 전용) ─────────────────────────────────────────
  // _bgEligible: 실행 방식 사전 선택을 노출할지(관리자 또는 활성 구독).
  // 선택값은 확인 다이얼로그가 아니라 각 보고서 폼 안에서 직접 읽는다.
  let _bgEligible = false;
  let _bgInfo = null; // { active, admin, expiresAt }
  (async () => {
    try {
      const { subscription: d } = await loadEntitlementsSnapshot();
      if (d) {
        _bgInfo = d;
        _bgEligible = !!d.active;
        renderPremiumBadge();
        renderBackgroundOptions();
      }
    } catch (_) {
      /* 권한 조회 실패 시 토글 미노출(서버가 어차피 강제) */
    }
  })();

  function backgroundChoice(formEl) {
    if (!_bgEligible || !formEl?.querySelector) {
      return { enabled: false, notifyEmail: false };
    }
    const enabled = !!formEl.querySelector("[data-background-mode]")?.checked;
    const notifyEmail =
      enabled && !!formEl.querySelector("[data-background-notify]")?.checked;
    return { enabled, notifyEmail };
  }

  // 백그라운드 실행 여부는 생성 버튼을 누른 뒤가 아니라 보고서의 다른 옵션과
  // 함께 미리 정한다. /api/generate 를 쓰는 모든 보고서 폼에 같은 UI를 삽입한다.
  function renderBackgroundOptions() {
    if (!_bgEligible) return;
    document.querySelectorAll("form[data-report-form]").forEach((formEl) => {
      if (formEl.querySelector("[data-background-options]")) return;

      const section = document.createElement("section");
      section.className = "form-section background-options";
      section.dataset.backgroundOptions = "";

      const head = document.createElement("div");
      head.className = "form-section-head";
      const title = document.createElement("span");
      title.className = "form-section-title";
      title.textContent = "실행 방식";
      head.appendChild(title);

      const box = document.createElement("div");
      box.className = "background-choice background-choice--form";
      const row = document.createElement("label");
      row.className = "background-choice__row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.backgroundMode = "";
      checkbox.setAttribute("aria-describedby", `${formEl.id || "report"}BackgroundHelp`);
      const copy = document.createElement("span");
      copy.textContent = "🌙 백그라운드로 실행 (탭/창을 닫아도 됨)";
      row.append(checkbox, copy);

      const help = document.createElement("p");
      help.id = `${formEl.id || "report"}BackgroundHelp`;
      help.className = "background-choice__help";
      help.textContent =
        "생성 요청 후 서버가 끝까지 만들며, 완료 파일은 24시간 동안 '내 파일'에서 받을 수 있어요.";

      const mailRow = document.createElement("label");
      mailRow.className = "background-choice__mail";
      mailRow.hidden = true;
      const mailCheckbox = document.createElement("input");
      mailCheckbox.type = "checkbox";
      mailCheckbox.checked = true;
      mailCheckbox.dataset.backgroundNotify = "";
      const mailCopy = document.createElement("span");
      mailCopy.textContent = "완료되면 이메일로 알림";
      mailRow.append(mailCheckbox, mailCopy);

      checkbox.addEventListener("change", () => {
        mailRow.hidden = !checkbox.checked;
        checkbox.setAttribute("aria-expanded", checkbox.checked ? "true" : "false");
      });
      checkbox.setAttribute("aria-expanded", "false");
      box.append(row, help, mailRow);
      section.append(head, box);

      const anchor = formEl.querySelector(".policy-check, .form-actions");
      if (anchor) formEl.insertBefore(section, anchor);
      else formEl.appendChild(section);
    });
  }

  // Max(백그라운드 실행 가능) 배지 — '내 파일' 패널 상단에 표시.
  function renderPremiumBadge() {
    try {
      const list = document.getElementById("filesList");
      if (!list || !list.parentNode || !_bgInfo) return;
      let badge = document.getElementById("premiumBadge");
      if (!badge) {
        badge = document.createElement("div");
        badge.id = "premiumBadge";
        list.parentNode.insertBefore(badge, list);
      }
      if (_bgInfo.active) {
        // 활성 Max — 안내 배지.
        badge.className = "premium-badge premium-badge--active";
        let detail = "백그라운드 실행을 사용할 수 있어요.";
        if (_bgInfo.admin) {
          detail = "관리자 — 백그라운드 실행을 사용할 수 있어요.";
        } else if (_bgInfo.expiresAt) {
          try {
            const exp = new Date(_bgInfo.expiresAt);
            if (exp.getFullYear() < new Date().getFullYear() + 50) {
              detail = `백그라운드 실행 가능 · ${formatDateTime(_bgInfo.expiresAt)}까지`;
            }
          } catch (_) {}
        }
        badge.textContent = `✨ Max — ${detail}`;
        return;
      }
      // 비활성 — Max 신청 CTA.
      badge.className = "premium-badge premium-badge--inactive";
      const txt = document.createElement("span");
      txt.className = "premium-badge__copy";
      txt.textContent =
        "✨ Max으로 백그라운드 실행하기 — 제출 후 탭을 닫아도 보고서가 완성돼요.";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary compact premium-badge__action";
      btn.textContent = "Max 신청";
      btn.addEventListener("click", openPremiumRequestModal);
      // 개인 설정 '내 등급' 카드에서도 같은 신청 모달을 연다(스코프 밖 재사용).
      window.__openMaxModal = openPremiumRequestModal;
      badge.replaceChildren(txt, btn);
    } catch (_) {}
  }

  function openPremiumRequestModal() {
    const plan = (_bgInfo && _bgInfo.plan) || {};
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    // 이 모달을 연 요소를 기억해 닫을 때 포커스를 복원한다(접근성).
    const prevFocus = document.activeElement;
    const card = document.createElement("section");
    card.className = "confirm-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");

    const h = document.createElement("h2");
    h.id = "maxModalTitle";
    h.textContent = "✨ Max 신청 (백그라운드 실행)";
    card.setAttribute("aria-labelledby", h.id);

    const guide = document.createElement("div");
    guide.className = "premium-request-guide";
    const lines = [];
    if (plan.priceKrw) lines.push(`금액: ${Number(plan.priceKrw).toLocaleString()}원 / ${plan.periodDays || 30}일`);
    if (plan.bank || plan.account)
      lines.push(`입금: ${plan.bank || ""} ${plan.account || ""}${plan.holder ? ` (예금주 ${plan.holder})` : ""}`);
    if (lines.length) {
      guide.textContent = lines.join("\n");
    } else {
      guide.textContent =
        "입금 계좌 안내가 아직 설정되지 않았어요. 관리자에게 입금 방법을 문의한 뒤 신청하세요.";
    }

    const note = document.createElement("p");
    note.className = "confirm-note premium-request-note";
    note.textContent =
      "입금하신 뒤 아래에 입금자명을 적고 신청하면, 관리자가 확인 후 바로 활성화해 드려요.";

    const label = document.createElement("label");
    label.className = "premium-request-field";
    label.textContent = "입금자명";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 40;
    input.placeholder = "예: 홍길동";
    label.appendChild(input);

    const status = document.createElement("p");
    status.className = "confirm-note confirm-status";

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "닫기";
    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "primary";
    ok.textContent = "입금했어요 · 신청";
    actions.append(cancel, ok);

    const onKeydown = (e) => {
      if (e.key === "Escape") close();
    };
    const close = () => {
      document.removeEventListener("keydown", onKeydown);
      document.body.classList.remove("modal-open");
      overlay.remove();
      try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (_) {}
    };
    cancel.addEventListener("click", close);
    document.addEventListener("keydown", onKeydown);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    ok.addEventListener("click", async () => {
      ok.disabled = true;
      status.dataset.tone = "info";
      status.textContent = "신청 중...";
      try {
        const r = await fetch("/api/subscriptions/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ depositorName: input.value.trim() }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          status.dataset.tone = "danger";
          status.textContent = d.error || "신청에 실패했어요.";
          ok.disabled = false;
          return;
        }
        status.dataset.tone = "success";
        status.textContent = d.duplicate
          ? "이미 신청이 접수돼 있어요. 입금 확인 후 활성화됩니다."
          : "신청 완료! 입금 확인 후 곧 활성화됩니다.";
        ok.textContent = "신청됨";
        setTimeout(close, 1800);
      } catch (_) {
        status.dataset.tone = "danger";
        status.textContent = "신청 중 오류가 났어요.";
        ok.disabled = false;
      }
    });

    card.append(h, guide, note, label, status, actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add("modal-open");
    input.focus();
  }

  function showBackgroundToast(notifyEmail = false) {
    try {
      let t = document.getElementById("bgToast");
      if (!t) {
        t = document.createElement("div");
        t.id = "bgToast";
        t.className = "background-toast";
        document.body.appendChild(t);
      }
      t.textContent = notifyEmail
        ? "🌙 백그라운드로 실행 중 — 이 창을 닫아도 됩니다. 완료되면 '내 파일'과 이메일로 받을 수 있어요."
        : "🌙 백그라운드로 실행 중 — 이 창을 닫아도 됩니다. 완료되면 '내 파일'에서 받을 수 있어요.";
      t.hidden = false;
      clearTimeout(window.__bgToastTimer);
      window.__bgToastTimer = setTimeout(() => {
        t.hidden = true;
      }, 9000);
    } catch (_) {}
  }

  // 비용 남용 정지 안내 + 소명(해명) 제출 모달. 커뮤니티 소명(community_appeals)을
  // kind="generation" 으로 재사용 → 관리자 '소명·제재' 탭에서 검토·해제한다.
  function showSuspendedAppealModal(reason, serverMessage) {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    const dialog = document.createElement("section");
    dialog.className = "confirm-card";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const h = document.createElement("h2");
    h.textContent = "🚫 생성이 일시 정지되었습니다";

    const msg = document.createElement("p");
    msg.className = "confirm-note";
    msg.textContent =
      serverMessage ||
      "비정상적인 사용량이 감지되어 생성이 정지되었습니다. 소명(해명)을 제출하면 관리자가 검토 후 해제합니다.";

    const reasonEl = document.createElement("p");
    reasonEl.className = "hint";
    if (reason) reasonEl.textContent = "사유: " + reason;

    const ta = document.createElement("textarea");
    ta.rows = 4;
    ta.maxLength = 1500;
    ta.placeholder =
      "관리자에게 상황을 설명해 주세요 (예: 정상적인 과제 작업이었습니다 / 어떤 보고서를 만들던 중이었는지 등).";
    ta.className = "suspension-appeal-text";

    const status = document.createElement("p");
    status.className = "hint confirm-status";
    status.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = "닫기";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = "소명 제출";

    const close = () => overlay.remove();
    cancel.addEventListener("click", close);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    submit.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (text.length < 5) {
        status.dataset.tone = "danger";
        status.textContent = "해명 내용을 조금 더 자세히 적어 주세요.";
        ta.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = "제출 중…";
      try {
        const r = await fetch("/api/community/appeal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "generation",
            reason: text,
            blockedText: reason || "",
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "제출 실패");
        status.dataset.tone = "success";
        status.textContent =
          "✅ 소명이 접수되었습니다. 관리자 검토 후 해제됩니다.";
        submit.textContent = "제출됨";
        ta.disabled = true;
        cancel.textContent = "확인";
      } catch (e) {
        status.dataset.tone = "danger";
        status.textContent =
          "제출에 실패했습니다: " + (e.message || "잠시 후 다시 시도해 주세요.");
        submit.disabled = false;
        submit.textContent = "소명 제출";
      }
    });

    actions.append(cancel, submit);
    dialog.append(h, msg);
    if (reason) dialog.append(reasonEl);
    dialog.append(ta, status, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    ta.focus();
  }

  function showConfirmDialog({ title, rows, note, okLabel = "생성", credits, recovery = null, background = null }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";

      const dialog = document.createElement("section");
      dialog.className = "confirm-card";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "confirmTitle");

      const heading = document.createElement("h2");
      heading.id = "confirmTitle";
      heading.textContent = title || "보고서 생성";

      const list = document.createElement("dl");
      list.className = "confirm-list";
      // creditDd 를 보관해 모델 변경 시 '차감 크레딧' 행을 즉시 갱신한다.
      let creditDd = null;
      // 크레딧 투명성: '차감 크레딧 · 잔액 N → N' 을 1순위로 강조 표시.
      let creditRow = buildCreditDeductRow(credits);
      if (creditRow) {
        const dt = document.createElement("dt");
        dt.textContent = creditRow.label;
        dt.className = "confirm-list__credit";
        const dd = document.createElement("dd");
        dd.textContent = creditRow.value;
        dd.className = "confirm-list__credit";
        if (creditRow.warn) dd.dataset.tone = "danger";
        list.append(dt, dd);
        creditDd = dd;
      }
      const summaryRows = Array.isArray(rows) ? [...rows] : [];
      if (_bgEligible && background?.querySelector) {
        const selected = backgroundChoice(background);
        summaryRows.push([
          "실행 방식",
          selected.enabled
            ? `백그라운드 실행 · 이메일 알림 ${selected.notifyEmail ? "사용" : "사용 안 함"}`
            : "현재 창에서 실행",
        ]);
      }
      for (const [label, value] of summaryRows) {
        const dt = document.createElement("dt");
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        // 크레딧 행을 1순위로 강조했으므로, 달러/원 추정치는 보조(작게)로 낮춘다.
        if (creditRow && label === "예상 비용") {
          dt.className = "confirm-list__secondary";
          dd.className = "confirm-list__secondary";
        }
        list.append(dt, dd);
      }

      const noteEl = document.createElement("p");
      noteEl.className = "confirm-note";
      noteEl.textContent = note || "생성하시겠습니까?";

      // ── 크레딧 사전 점검(부족 시 인라인 경고 + 회복 동선) ─────────────
      // 관리자/무제한/잔액미상이면 graceful 생략. 잔액 < 선택 모델 크레딧이면
      // 빨간 경고 + 생성 버튼 비활성('크레딧 부족') + 더 저렴한 모델로 바꾸기.
      const warnBox = document.createElement("div");
      warnBox.className = "confirm-credit-warn";
      warnBox.hidden = true;
      let _selectedCredits = typeof credits === "number" ? credits : null;

      const actions = document.createElement("div");
      actions.className = "confirm-actions";
      const cancelBtn = document.createElement("button");
      cancelBtn.type = "button";
      cancelBtn.className = "secondary";
      cancelBtn.textContent = "취소";
      const okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "primary";
      okBtn.textContent = okLabel;
      actions.append(cancelBtn, okBtn);

      // 크레딧 게이트 평가 — 부족하면 OK 비활성 + 경고/회복 노출.
      function evaluateCreditGate() {
        // graceful 생략 조건.
        if (
          _selectedCredits == null ||
          !balanceState.known ||
          balanceState.unlimited ||
          balanceState.isAdmin ||
          _selectedCredits <= 0
        ) {
          warnBox.hidden = true;
          okBtn.disabled = false;
          okBtn.textContent = okLabel;
          return;
        }
        const bal = balanceState.credits;
        if (_selectedCredits <= bal) {
          warnBox.hidden = true;
          okBtn.disabled = false;
          okBtn.textContent = okLabel;
          return;
        }
        // 부족.
        warnBox.hidden = false;
        warnBox.replaceChildren();
        okBtn.disabled = true;
        okBtn.textContent = "크레딧 부족";

        const msg = document.createElement("div");
        msg.className = "confirm-credit-warn-msg";
        msg.textContent = `잔액이 부족합니다 — 필요 ${_selectedCredits} · 보유 ${bal} 크레딧`;
        warnBox.appendChild(msg);

        const wActions = document.createElement("div");
        wActions.className = "confirm-credit-warn-actions";
        // 회복: 잔액으로 감당 가능한 가장 싼 모델로 1클릭 전환.
        if (recovery && recovery.formEl && recovery.radioName) {
          const aff = findAffordableModelOption(recovery.formEl, recovery.radioName, bal);
          if (aff) {
            const swapBtn = document.createElement("button");
            swapBtn.type = "button";
            swapBtn.className = "secondary compact";
            const free = aff.credits <= 0;
            swapBtn.textContent = free
              ? "GPT-5.4 mini로 바꾸기 (일일 무료 한도 적용)"
              : `더 저렴한 모델로 바꾸기 (${aff.credits}크레딧)`;
            swapBtn.addEventListener("click", () => {
              try { aff.input.checked = true; } catch (_) {}
              // 라디오 change 리스너(글꼴 옵션 등)도 깨운다.
              try { aff.input.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
              _selectedCredits = aff.credits;
              // '차감 크레딧' 행과 게이트를 즉시 갱신.
              const newRow = buildCreditDeductRow(aff.credits);
              if (creditDd && newRow) {
                creditDd.textContent = newRow.value;
                if (newRow.warn) creditDd.dataset.tone = "danger";
                else delete creditDd.dataset.tone;
              }
              evaluateCreditGate();
            });
            wActions.appendChild(swapBtn);
          }
        }
        // 문의/충전 링크(커뮤니티 게시판) — 있으면 연결.
        const link = document.createElement("a");
        link.className = "confirm-credit-warn-link";
        link.href = "/community.html";
        link.textContent = "크레딧 문의 →";
        wActions.appendChild(link);
        warnBox.appendChild(wActions);
      }
      evaluateCreditGate();

      dialog.append(heading, list, noteEl, warnBox, actions);
      overlay.appendChild(dialog);
      // 다이얼로그를 열기 직전 포커스를 기억해 닫을 때 복원한다(접근성).
      const prevFocus = document.activeElement;
      document.body.appendChild(overlay);
      document.body.classList.add("modal-open");

      const close = (result) => {
        document.removeEventListener("keydown", onKeydown);
        document.body.classList.remove("modal-open");
        overlay.remove();
        // 열기 전 포커스로 복원.
        try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (_) {}
        resolve(result);
      };
      // 다이얼로그 안의 포커스 가능한 요소를 훑어 Tab/Shift+Tab 을 가둔다.
      const getFocusable = () =>
        Array.from(
          dialog.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      const onKeydown = (event) => {
        if (event.key === "Escape") { close(false); return; }
        if (event.key === "Tab") {
          const f = getFocusable();
          if (!f.length) return;
          const first = f[0];
          const last = f[f.length - 1];
          const active = document.activeElement;
          if (event.shiftKey) {
            if (active === first || !dialog.contains(active)) {
              event.preventDefault();
              last.focus();
            }
          } else if (active === last || !dialog.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        }
      };
      document.addEventListener("keydown", onKeydown);
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close(false);
      });
      cancelBtn.addEventListener("click", () => close(false));
      okBtn.addEventListener("click", () => { if (!okBtn.disabled) close(true); });
      // OK 가 비활성(크레딧 부족)이면 취소에 포커스를 둔다.
      (okBtn.disabled ? cancelBtn : okBtn).focus();
    });
  }


  return {
    showConfirmDialog,
    renderPremiumBadge,
    showBackgroundToast,
    showSuspendedAppealModal,
    backgroundChoice,
  };
}
