// 백그라운드 실행 구독(background_subscriptions) 라우터.
//   - 사용자: GET  /api/subscriptions/me      (본인 백그라운드 권한 상태 — 토글 노출용)
//   - 관리자: GET  /api/subscriptions          (구독 목록)
//             POST /api/subscriptions          (부여)
//             POST /api/subscriptions/:id/revoke (회수)
//
// "백그라운드 실행"이란 보고서를 제출한 뒤 탭/창을 닫아도 서버가 끝까지 생성하고,
// '내 파일'과 완료 이메일로 받을 수 있는 기능이다. 관리자가 지정 사용자에게 기간 한정으로
// 부여하며(api_key_grants 와 동일 구조), 나중에 월 결제로 확장할 때는 결제 성공 시
// supa.createBackgroundSub({ expiresAt }) 만 호출하면 된다.
const express = require("express");
const supa = require("./supabase");
const mailer = require("./mailer");

// 입금 안내·가격(환경변수). 비어 있으면 클라가 "관리자에게 문의"로 안내.
function planInfo() {
  return {
    priceKrw: Number(process.env.PREMIUM_PRICE_KRW) || null,
    bank: process.env.PREMIUM_BANK || "",
    account: process.env.PREMIUM_ACCOUNT || "",
    holder: process.env.PREMIUM_HOLDER || "",
    periodDays: Math.max(1, Number(process.env.PREMIUM_PERIOD_DAYS) || 30),
  };
}

module.exports = function subscriptionRoutes({
  requireAuth,
  requireAdmin,
  getSessionUser,
}) {
  const router = express.Router();

  // 본인 백그라운드 권한 상태(토글 노출·배지용) + 입금 안내(plan). 항상 200.
  router.get("/me", requireAuth, async (req, res) => {
    const u = getSessionUser(req);
    const plan = planInfo();
    if (!u || !u.id) return res.json({ active: false, admin: false, plan });
    if (u.isAdmin) return res.json({ active: true, admin: true, plan });
    if (!supa.isEnabled())
      return res.json({ active: false, admin: false, plan });
    try {
      const s = await supa.getActiveBackgroundSub(u.id);
      if (!s) return res.json({ active: false, admin: false, plan });
      return res.json({
        active: true,
        admin: false,
        expiresAt: s.expires_at,
        note: s.note || "",
        plan,
      });
    } catch (_) {
      return res.json({ active: false, admin: false, plan });
    }
  });

  // 사용자: Max 입금 신청. body = { depositorName? }
  // 입금 후 신청 → 관리자가 입금 확인하고 승인하면 즉시 Max 활성.
  router.post("/request", requireAuth, async (req, res) => {
    const u = getSessionUser(req);
    if (!u || !u.id)
      return res.status(401).json({ error: "로그인이 필요합니다." });
    if (!supa.isEnabled())
      return res.status(503).json({ error: "아직 준비되지 않았습니다." });
    try {
      if (u.isAdmin || (await supa.getActiveBackgroundSub(u.id))) {
        return res
          .status(409)
          .json({ error: "이미 Max가 활성화되어 있습니다." });
      }
    } catch (_) {}
    try {
      const depositorName = String(req.body.depositorName || "")
        .trim()
        .slice(0, 80);
      const reqRow = await supa.createPremiumRequest({
        userId: u.id,
        depositorName,
        periodDays: planInfo().periodDays,
      });
      const to =
        process.env.PREMIUM_NOTIFY_EMAIL ||
        process.env.FEEDBACK_EMAIL_TO ||
        process.env.ADMIN_EMAIL;
      if (to) {
        mailer
          .sendEmail({
            to,
            subject: `[Quilo] Max 입금 신청 — ${u.name || u.id}`,
            text: `사용자 ${u.name || u.id} 가 Max(백그라운드 실행)를 신청했습니다.\n입금자명: ${depositorName || "(미입력)"}\n\n관리자 페이지 → 🌙 백그라운드 탭 '입금 신청 대기'에서 입금 확인 후 승인하세요.`,
          })
          .catch(() => {});
      }
      res.json({ ok: true, duplicate: !!reqRow.duplicate });
    } catch (e) {
      res
        .status(e.code === "PREMIUM_REQ_TABLE_MISSING" ? 400 : 500)
        .json({ error: e.message });
    }
  });

  // 관리자: Max 입금 신청 목록(기본 대기중).
  router.get("/requests", requireAdmin, async (req, res) => {
    try {
      const requests = await supa.listPremiumRequests({
        status: req.query.status || "pending",
      });
      res.json({ requests });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 관리자: 입금 신청 승인 → 즉시 Max 부여(활성이면 만료일에서 연장).
  // body = { days?, permanent? } (없으면 신청 period_days)
  router.post("/requests/:id/approve", requireAdmin, async (req, res) => {
    const admin = getSessionUser(req);
    try {
      const reqRow = await supa.getPremiumRequest(req.params.id);
      if (!reqRow)
        return res.status(404).json({ error: "신청을 찾을 수 없습니다." });
      if (reqRow.status !== "pending")
        return res.status(409).json({ error: "이미 처리된 신청입니다." });

      const permanent =
        req.body.permanent === true || String(req.body.permanent) === "true";
      let baseMs = Date.now();
      try {
        const active = await supa.getActiveBackgroundSub(reqRow.user_id);
        if (active && new Date(active.expires_at).getTime() > baseMs) {
          baseMs = new Date(active.expires_at).getTime(); // 활성이면 연장
        }
      } catch (_) {}
      let expiresAt;
      if (permanent) {
        expiresAt = new Date(
          Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
        ).toISOString();
      } else {
        const days = Math.max(
          1,
          Math.min(366, Number(req.body.days) || reqRow.period_days || 30),
        );
        expiresAt = new Date(baseMs + days * 24 * 60 * 60 * 1000).toISOString();
      }

      // L1: 상태 전이를 '게이트'로 선행한다. pending→approved 를 원자적으로 시도하고,
      // 실제로 한 행을 바꾼 경우에만 구독·크레딧을 지급한다. 두 관리자가 동시에(또는
      // 더블클릭으로) 승인해도 부수효과는 한 번만 실행된다(이중 grant 방지).
      const decision = await supa.decidePremiumRequest(reqRow.id, {
        status: "approved",
        decidedBy: admin && admin.id ? admin.id : null,
      });
      if (!decision || decision.updated < 1) {
        return res.status(409).json({ error: "이미 처리된 신청입니다." });
      }

      await supa.createBackgroundSub({
        userId: reqRow.user_id,
        grantedBy: admin && admin.id ? admin.id : null,
        expiresAt,
        note:
          req.body.note ||
          `입금 승인${reqRow.depositor_name ? ` (${reqRow.depositor_name})` : ""}`,
      });

      // Max 포함 크레딧 지급 (2026-07-02 결정: 기본 10, env PREMIUM_INCLUDED_CREDITS).
      // 지급 실패해도 승인은 유지(관리자가 수동 보전 가능).
      const included = Math.max(
        0,
        parseInt(process.env.PREMIUM_INCLUDED_CREDITS || "10", 10),
      );
      if (included > 0) {
        try {
          await supa.addCredits(reqRow.user_id, included);
        } catch (e) {
          console.warn("[premium] 포함 크레딧 지급 실패:", e.message);
        }
      }

      // 사용자에게 활성화 알림(이메일 있으면).
      try {
        const target = await supa.findUserById(reqRow.user_id);
        if (target && target.email) {
          const base = (
            process.env.PUBLIC_BASE_URL ||
            process.env.APP_BASE_URL ||
            "https://quilolab.com"
          ).replace(/\/+$/, "");
          mailer
            .sendEmail({
              to: target.email,
              subject: "[Quilo] Max가 활성화되었습니다 ✨",
              text: `Max가 활성화되어 이제 보고서를 백그라운드로 실행할 수 있습니다(제출 후 탭을 닫아도 됩니다).${included > 0 ? `\n포함 크레딧 ${included}개가 지급되었습니다.` : ""}\n${base}`,
            })
            .catch(() => {});
        }
      } catch (_) {}

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 관리자: 입금 신청 거절.
  router.post("/requests/:id/reject", requireAdmin, async (req, res) => {
    const admin = getSessionUser(req);
    try {
      await supa.decidePremiumRequest(req.params.id, {
        status: "rejected",
        decidedBy: admin && admin.id ? admin.id : null,
      });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 관리자: 구독 목록. ?active=1 이면 활성만.
  router.get("/", requireAdmin, async (req, res) => {
    try {
      const activeOnly = String(req.query.active || "") === "1";
      const subs = await supa.listBackgroundSubs({ activeOnly });
      res.json({ subs });
    } catch (e) {
      res
        .status(e.code === "BG_SUB_TABLE_MISSING" ? 400 : 500)
        .json({ error: e.message });
    }
  });

  // 관리자: 구독 부여. body = { name | userId, days?, hours?, expiresAt?, note? }
  router.post("/", requireAdmin, async (req, res) => {
    const admin = getSessionUser(req);
    try {
      let userId = String(req.body.userId || "").trim();
      const name = String(req.body.name || "").trim();
      if (!userId && name) {
        const target = await supa.findUserByName(name);
        if (!target) {
          return res
            .status(404)
            .json({ error: `사용자 '${name}'를 찾을 수 없습니다.` });
        }
        userId = target.id;
      }
      if (!userId) {
        return res.status(400).json({ error: "대상 사용자를 지정하세요." });
      }

      let expiresAt = req.body.expiresAt;
      const permanent =
        req.body.permanent === true || String(req.body.permanent) === "true";
      if (!expiresAt && permanent) {
        // 무기한(결제 도입 전 단계의 'Max 지정'). 100년 후 만료 = 사실상 영구.
        // 해제는 '회수'(revoke)로 한다. 게이트는 expires_at>now 만 보므로 그대로 동작.
        expiresAt = new Date(
          Date.now() + 100 * 365 * 24 * 60 * 60 * 1000,
        ).toISOString();
      }
      if (!expiresAt) {
        const days = Math.max(0, Math.min(366, Number(req.body.days) || 0));
        const hours = Math.max(0, Math.min(24 * 366, Number(req.body.hours) || 0));
        const ms = (days * 24 + hours) * 60 * 60 * 1000;
        if (ms <= 0) {
          return res
            .status(400)
            .json({ error: "구독 기간(일/시간)을 1 이상으로 지정하세요." });
        }
        expiresAt = new Date(Date.now() + ms).toISOString();
      }

      const sub = await supa.createBackgroundSub({
        userId,
        grantedBy: admin && admin.id ? admin.id : null,
        expiresAt,
        note: req.body.note || "",
      });
      res.json({ ok: true, sub });
    } catch (e) {
      res
        .status(e.code === "BG_SUB_TABLE_MISSING" ? 400 : 500)
        .json({ error: e.message });
    }
  });

  // 관리자: 구독 회수(즉시 만료).
  router.post("/:id/revoke", requireAdmin, async (req, res) => {
    try {
      await supa.revokeBackgroundSub(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
