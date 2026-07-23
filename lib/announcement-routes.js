// 공지사항 API — server.js 를 거의 건드리지 않도록 별도 모듈.
// 마운트: app.use("/api/announcements", require("./lib/announcement-routes")({ requireAdmin }))
//
// GET /            공개: 활성 공지(상단 티커용, 최소 필드)
// GET /all         관리자: 전체(활성/비활성 포함)
// POST /           관리자: 추가
// PATCH /:id       관리자: 활성 토글
// DELETE /:id      관리자: 삭제

const express = require("express");
const ann = require("./announcements");

module.exports = function announcementRouter({ requireAdmin }) {
  const r = express.Router();

  r.get("/", async (_req, res) => {
    try {
      const { rows } = await ann.list(true);
      res.json({
        announcements: rows.map((a) => ({
          id: a.id,
          title: a.title,
          category: a.category,
          link: a.link || "",
        })),
      });
    } catch (_) {
      res.json({ announcements: [] });
    }
  });

  r.get("/all", requireAdmin, async (_req, res) => {
    try {
      const { rows, store } = await ann.list(false);
      res.json({ announcements: rows, store });
    } catch (e) {
      res.status(500).json({ error: "목록을 불러오지 못했습니다." });
    }
  });

  r.post("/", requireAdmin, async (req, res) => {
    const title = String((req.body && req.body.title) || "").trim();
    if (!title) return res.status(400).json({ error: "제목을 입력하세요." });
    try {
      const { row, store } = await ann.create({
        title,
        category: req.body && req.body.category,
        link: req.body && req.body.link,
      });
      res.json({ ok: true, row, store });
    } catch (e) {
      res.status(500).json({ error: "등록에 실패했습니다." });
    }
  });

  r.patch("/:id", requireAdmin, async (req, res) => {
    try {
      await ann.setActive(req.params.id, !!(req.body && req.body.active));
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "변경에 실패했습니다." });
    }
  });

  r.delete("/:id", requireAdmin, async (req, res) => {
    try {
      await ann.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: "삭제에 실패했습니다." });
    }
  });

  return r;
};
