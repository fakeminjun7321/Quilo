// API 키 위임(grant) 라우터.
//   - 사용자: 본인 위임 상태 조회            GET  /api/grants/me
//   - 관리자: 위임 목록/생성/회수            GET  /api/grants
//                                           POST /api/grants
//                                           POST /api/grants/:id/revoke
//
// "위임"이란 관리자가 지정한 사용자에게 일정 기간 동안 "관리자 키"로 무료 사용할 권한을
// 주는 것이다. 개인 API 키를 저장하지 않으며, 효과는 위임 기간 동안 그 사용자의 보고서
// 생성 + 파일 챗봇이 크레딧 차감 없이 서버 키로 실행되는 것이다.
const express = require("express");
const supa = require("./supabase");

module.exports = function grantRoutes({ requireAuth, requireAdmin, getSessionUser }) {
  const router = express.Router();

  // 본인 위임 상태(배지·안내용). 항상 200 — 실패해도 active:false 로 graceful.
  router.get("/me", requireAuth, async (req, res) => {
    const u = getSessionUser(req);
    if (!u || !u.id || !supa.isEnabled()) return res.json({ active: false });
    try {
      const g = await supa.getActiveGrant(u.id);
      if (!g) return res.json({ active: false });
      return res.json({
        active: true,
        expiresAt: g.expires_at,
        note: g.note || "",
      });
    } catch (_) {
      return res.json({ active: false });
    }
  });

  // 관리자: 위임 목록. ?active=1 이면 활성만.
  router.get("/", requireAdmin, async (req, res) => {
    try {
      const activeOnly = String(req.query.active || "") === "1";
      const grants = await supa.listGrants({ activeOnly });
      res.json({ grants });
    } catch (e) {
      res
        .status(e.code === "GRANT_TABLE_MISSING" ? 400 : 500)
        .json({ error: e.message });
    }
  });

  // 관리자: 위임 생성. body = { name | userId, days?, hours?, expiresAt?, note? }
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
      if (!expiresAt) {
        const days = Math.max(0, Math.min(365, Number(req.body.days) || 0));
        const hours = Math.max(0, Math.min(24 * 365, Number(req.body.hours) || 0));
        const ms = (days * 24 + hours) * 60 * 60 * 1000;
        if (ms <= 0) {
          return res
            .status(400)
            .json({ error: "위임 기간(일/시간)을 1 이상으로 지정하세요." });
        }
        expiresAt = new Date(Date.now() + ms).toISOString();
      }

      const grant = await supa.createGrant({
        userId,
        grantedBy: admin && admin.id ? admin.id : null,
        expiresAt,
        note: req.body.note || "",
      });
      res.json({ ok: true, grant });
    } catch (e) {
      res
        .status(e.code === "GRANT_TABLE_MISSING" ? 400 : 500)
        .json({ error: e.message });
    }
  });

  // 관리자: 위임 회수(즉시 만료).
  router.post("/:id/revoke", requireAdmin, async (req, res) => {
    try {
      await supa.revokeGrant(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
