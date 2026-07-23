// 학교 도입 신청 라우터.
//   - 공개(로그인 X): POST /api/school-apply            (외부 학교가 도입 신청 + 양식 파일 업로드)
//   - 관리자:         GET  /api/school-apply/admin/list  (신청 목록)
//                     GET  /api/school-apply/admin/:id    (상세 + 파일 메타)
//                     GET  /api/school-apply/admin/:id/file/:fileId (양식 파일 다운로드)
//                     POST /api/school-apply/admin/:id/status         (상태/메모 변경)
//
// 제출물은 school_applications(+_files) 에 저장되고, 새 신청마다 관리자에게 이메일 알림.
// 테이블이 없으면(마이그레이션 전) 저장은 건너뛰고 이메일 알림만으로 graceful fallback 한다.
const express = require("express");
const supa = require("./supabase");
const mailer = require("./mailer");
const rateLimit = require("./rate-limit");

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 신청 대표 이메일 수신자(환경변수 체인). 없으면 발송 스킵(로그만).
function notifyRecipient() {
  return (
    process.env.SCHOOL_APPLY_NOTIFY_EMAIL ||
    process.env.PREMIUM_NOTIFY_EMAIL ||
    process.env.FEEDBACK_EMAIL ||
    ""
  );
}

async function notifyAdmin(payload, fileCount, savedToDb) {
  const to = notifyRecipient();
  if (!to) {
    console.warn("[school-apply] 알림 이메일 미설정(SCHOOL_APPLY_NOTIFY_EMAIL) — 발송 스킵");
    return;
  }
  const rows = [
    ["학교명", payload.schoolName],
    ["학교 유형", payload.schoolType],
    ["담당자", payload.contactName],
    ["담당자 이메일", payload.contactEmail],
    ["연락처", payload.contactPhone],
    ["학생 이메일 도메인", payload.studentEmailDomain],
    ["학번 체계", payload.studentIdScheme],
    ["추가할 보고서", payload.desiredReports],
    ["도입 희망 시기", payload.desiredStart],
    ["예산/유료 의향", payload.budgetNote],
    ["첨부 파일", `${fileCount}개 (평가기준·양식·예시)`],
    ["문의", payload.message],
  ];
  const html =
    `<div style="font-family:-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#1f2937;line-height:1.6;max-width:640px;margin:0 auto;">` +
    `<h2 style="margin:0 0 4px;">🏫 새 학교 도입 신청</h2>` +
    `<p style="margin:0 0 16px;color:#64748b;font-size:13px;">${savedToDb ? "관리자 페이지 '학교 신청' 탭에서 확인/관리하세요." : "⚠ DB 미저장(마이그레이션 전) — 이 메일이 유일한 기록입니다."}</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px;">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 10px;background:#f5f6f8;border:1px solid #e5e7eb;font-weight:600;white-space:nowrap;">${esc(k)}</td>` +
          `<td style="padding:6px 10px;border:1px solid #e5e7eb;white-space:pre-wrap;">${esc(v) || "-"}</td></tr>`,
      )
      .join("") +
    `</table></div>`;
  const text = rows.map(([k, v]) => `${k}: ${v || "-"}`).join("\n");
  try {
    const r = await mailer.sendEmail({
      to,
      subject: `[Quilo] 학교 도입 신청 — ${payload.schoolName || "(학교명 미기재)"}`,
      html,
      text,
    });
    if (!r.sent && r.reason !== "not_configured") {
      console.warn("[school-apply] 알림 이메일 실패:", r.reason, r.detail || "");
    }
  } catch (e) {
    console.warn("[school-apply] 알림 이메일 예외:", e.message);
  }
}

module.exports = function schoolApplyRoutes({ requireAdmin, getSessionUser, upload, limitTotalUpload }) {
  const router = express.Router();
  const uploadFiles = upload ? upload.any() : (req, res, next) => next();
  const preUpload = limitTotalUpload || ((req, res, next) => next());

  // ── 공개: 도입 신청 제출 ──────────────────────────────────────────────────
  router.post("/", preUpload, uploadFiles, async (req, res) => {
    // app.set("trust proxy", 1)에서 계산된 req.ip만 사용한다. 원시 헤더를 직접
    // 신뢰하면 클라이언트가 값을 조작해 제출 제한을 우회할 수 있다.
    const ip = String(req.ip || "?");
    const lim = rateLimit.checkSchoolApplyLimit(ip);
    if (!lim.allowed) {
      return res.status(429).json({
        error:
          lim.reason === "global"
            ? "지금 신청이 많습니다. 잠시 후 다시 시도해 주세요."
            : "신청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
      });
    }
    const b = req.body || {};
    // 허니팟: 봇이 채우면 성공처럼 응답하되 저장/발송하지 않는다.
    if (String(b.website || "").trim()) return res.json({ ok: true });

    const payload = {
      schoolName: String(b.schoolName || "").trim(),
      schoolType: String(b.schoolType || "").trim(),
      contactName: String(b.contactName || "").trim(),
      contactEmail: String(b.contactEmail || "").trim(),
      contactPhone: String(b.contactPhone || "").trim(),
      studentEmailDomain: String(b.studentEmailDomain || "").trim().toLowerCase().replace(/^@/, ""),
      studentIdScheme: String(b.studentIdScheme || "").trim(),
      desiredReports: String(b.desiredReports || "").trim(),
      desiredStart: String(b.desiredStart || "").trim(),
      budgetNote: String(b.budgetNote || "").trim(),
      message: String(b.message || "").trim(),
    };

    // 필수값 검증
    const missing = [];
    if (!payload.schoolName) missing.push("학교명");
    if (!payload.contactName) missing.push("담당자 이름");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.contactEmail)) missing.push("담당자 이메일");
    if (!payload.studentEmailDomain) missing.push("학생 이메일 도메인");
    if (missing.length) {
      return res.status(400).json({ error: `다음 항목을 확인해 주세요: ${missing.join(", ")}` });
    }
    if (!(b.consent === "true" || b.consent === "on" || b.consent === true || b.consent === "1")) {
      return res.status(400).json({ error: "개인정보 수집·이용에 동의해 주세요." });
    }

    const files = (req.files || []).slice(0, 8).map((f) => ({
      filename: f.originalname || "file",
      mime: f.mimetype || "application/octet-stream",
      size: f.size || (f.buffer ? f.buffer.length : 0),
      dataBase64: f.buffer ? f.buffer.toString("base64") : "",
    }));

    rateLimit.recordSchoolApply(ip);

    let savedToDb = false;
    let fileCount = files.length;
    if (supa.isEnabled()) {
      try {
        const r = await supa.createSchoolApplication(payload, files);
        savedToDb = true;
        fileCount = r.fileCount;
      } catch (e) {
        if (e.message === "SCHOOL_APP_TABLE_MISSING") {
          console.warn("[school-apply] school_applications 테이블 없음 — 이메일 알림만 진행(마이그레이션 필요)");
        } else {
          console.error("[school-apply] 저장 실패:", e.message);
          // 저장 실패해도 신청자 경험을 막지 않고 이메일로 남긴다.
        }
      }
    }

    await notifyAdmin(payload, fileCount, savedToDb);
    return res.json({ ok: true });
  });

  // ── 관리자: 신청 목록 ─────────────────────────────────────────────────────
  router.get("/admin/list", requireAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || "all");
      const applications = await supa.listSchoolApplications({ status });
      res.json({ applications });
    } catch (e) {
      res.status(500).json({ error: "목록을 불러오지 못했습니다." });
    }
  });

  // ── 관리자: 신청 상세 ─────────────────────────────────────────────────────
  router.get("/admin/:id", requireAdmin, async (req, res) => {
    try {
      const application = await supa.getSchoolApplication(req.params.id);
      if (!application) return res.status(404).json({ error: "신청을 찾을 수 없습니다." });
      res.json({ application });
    } catch (e) {
      res.status(500).json({ error: "신청을 불러오지 못했습니다." });
    }
  });

  // ── 관리자: 양식 파일 다운로드 ─────────────────────────────────────────────
  router.get("/admin/:id/file/:fileId", requireAdmin, async (req, res) => {
    try {
      const f = await supa.getSchoolApplicationFile(req.params.id, req.params.fileId);
      if (!f) return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      const buf = Buffer.from(f.data_base64 || "", "base64");
      const name = encodeURIComponent(f.filename || "file");
      res.set({
        "Content-Type": f.mime || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${name}`,
        "Content-Length": buf.length,
        "X-Content-Type-Options": "nosniff",
      });
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: "파일을 내려받지 못했습니다." });
    }
  });

  // ── 관리자: 상태/메모 변경 ────────────────────────────────────────────────
  router.post("/admin/:id/status", requireAdmin, async (req, res) => {
    try {
      const admin = getSessionUser ? getSessionUser(req) : null;
      const r = await supa.decideSchoolApplication(req.params.id, {
        status: req.body.status,
        note: req.body.note,
        decidedBy: admin && admin.id ? admin.id : null,
      });
      if (!r || r.updated < 1) return res.status(404).json({ error: "신청을 찾을 수 없습니다." });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message || "변경 실패" });
    }
  });

  return router;
};
