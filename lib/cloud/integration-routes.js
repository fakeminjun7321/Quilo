"use strict";

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");
const providers = require("./oauth-providers");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function cleanId(value, label = "파일") {
  const id = String(value || "").trim();
  if (!id || id.length > 300 || /[\/\s]/.test(id)) throw Object.assign(new Error(`${label} ID가 올바르지 않습니다.`), { status: 400 });
  return id;
}

function sendCloudError(res, error, fallbackStatus = 502) {
  const message = error?.message || "클라우드 요청에 실패했습니다.";
  const status = Number(error?.status) || (/연결이 없습니다/.test(message) ? 409 : fallbackStatus);
  return res.status(status).json({ error: message });
}

function createCloudIntegrationRouter({
  requireAuth,
  getSessionUser,
  supa,
  baseUrl,
  isHiddenFile = () => false,
}) {
  const router = express.Router();
  const redirectUri = (req, provider) => `${baseUrl(req)}/api/cloud/${provider}/callback`;
  const connection = async (req, provider) => {
    const user = getSessionUser(req);
    if (!user?.id) throw new Error("로그인이 필요합니다.");
    const row = await supa.getCloudConnection(user.id, provider);
    if (!row?.refresh_token) throw new Error(`${provider} 연결이 없습니다.`);
    return { user, row };
  };
  const googleContext = async (req) => {
    const { row, user } = await connection(req, "google");
    const accessToken = await providers.googleAccessToken(providers.decryptToken(row.refresh_token));
    return { accessToken, row, user };
  };
  const googleFolder = async (accessToken, requested, useQuiloFolder = true) => {
    if (requested) return cleanId(requested, "폴더");
    if (!useQuiloFolder) return "";
    return (await providers.ensureDriveFolder(accessToken, { name: "Quilo" })).id;
  };

  router.get("/providers/status", requireAuth, async (req, res) => {
    const user = getSessionUser(req);
    const status = {};
    for (const provider of ["dropbox", "google", "notion"]) {
      let row = null;
      try { row = user?.id ? await supa.getCloudConnection(user.id, provider) : null; } catch {}
      status[provider] = {
        configured: provider === "dropbox" ? !!(process.env.DROPBOX_APP_KEY && process.env.CLOUD_TOKEN_SECRET) : providers.configured(provider),
        connected: !!row,
        accountEmail: row?.account_email || null,
        accountName: row?.account_name || null,
        connectedAt: row?.connected_at || null,
        connectUrl: provider === "dropbox" ? "/api/cloud/dropbox/connect" : `/api/cloud/${provider}/connect`,
        reconnectUrl: provider === "dropbox" ? "/api/cloud/dropbox/connect" : `/api/cloud/${provider}/connect?reconnect=1`,
        disconnectUrl: `/api/cloud/${provider}/disconnect`,
      };
    }
    res.json({ integrations: status });
  });

  for (const provider of ["google", "notion"]) {
    router.get(`/${provider}/connect`, requireAuth, (req, res) => {
      if (!providers.configured(provider)) return res.status(503).json({ error: `${provider} OAuth 환경변수가 설정되지 않았습니다.` });
      const state = crypto.randomBytes(24).toString("hex");
      req.session.cloudOAuth ||= {};
      req.session.cloudOAuth[provider] = { state, createdAt: Date.now(), reconnect: truthy(req.query.reconnect) };
      res.redirect(providers.authorizationUrl(provider, { state, redirectUri: redirectUri(req, provider) }));
    });
    router.get(`/${provider}/callback`, requireAuth, async (req, res) => {
      const saved = req.session.cloudOAuth?.[provider];
      if (req.session.cloudOAuth) delete req.session.cloudOAuth[provider];
      if (!saved || Date.now() - saved.createdAt > 10 * 60 * 1000 || String(req.query.state || "") !== saved.state || !req.query.code) {
        return res.redirect("/?cloud=error");
      }
      try {
        const token = await providers.exchangeCode(provider, { code: String(req.query.code), redirectUri: redirectUri(req, provider) });
        const user = getSessionUser(req);
        const previous = await supa.getCloudConnection(user.id, provider).catch(() => null);
        const credential = provider === "google" ? token.refresh_token : token.access_token;
        const encryptedCredential = credential ? providers.encryptToken(credential) : previous?.refresh_token;
        if (!encryptedCredential) throw new Error("OAuth 장기 토큰을 받지 못했습니다.");
        let email = "";
        let name = "";
        if (provider === "google") {
          const account = await providers.googleAccount(token.access_token);
          email = account.email;
          name = account.name;
        } else {
          email = token.owner?.user?.person?.email || "";
          name = token.workspace_name || token.owner?.user?.name || "";
        }
        await supa.saveCloudConnection(user.id, provider, { refreshToken: encryptedCredential, accountEmail: email, accountName: name });
        res.redirect(`/?cloud=${provider}-${saved.reconnect ? "reconnected" : "connected"}#integrations`);
      } catch (error) {
        console.error(`[cloud] ${provider} callback:`, error.message);
        res.redirect("/?cloud=error");
      }
    });
  }

  router.post("/:provider/disconnect", requireAuth, async (req, res) => {
    const provider = String(req.params.provider || "");
    if (!["dropbox", "google", "notion"].includes(provider)) return res.status(400).json({ error: "지원하지 않는 provider입니다." });
    const user = getSessionUser(req);
    let revoked = false;
    try {
      const row = await supa.getCloudConnection(user.id, provider);
      if (provider === "google" && row?.refresh_token) {
        try { revoked = await providers.revokeGoogleToken(providers.decryptToken(row.refresh_token)); }
        catch (error) { console.warn("[cloud] Google token revoke:", error.message); }
      }
      await supa.deleteCloudConnection(user.id, provider);
      res.json({ ok: true, revoked, reconnectUrl: provider === "dropbox" ? "/api/cloud/dropbox/connect" : `/api/cloud/${provider}/connect?reconnect=1` });
    } catch (error) {
      sendCloudError(res, error, 500);
    }
  });

  router.get("/google/drive/files", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const files = await providers.listDriveFiles(accessToken, {
        pageSize: req.query.limit,
        folderId: req.query.folderId ? cleanId(req.query.folderId, "폴더") : "",
        foldersOnly: truthy(req.query.foldersOnly),
        mimeType: String(req.query.mimeType || "").slice(0, 160),
        query: String(req.query.q || "").slice(0, 120),
      });
      res.json({ files: files.filter((file) => !isHiddenFile(file)) });
    } catch (error) { sendCloudError(res, error); }
  });

  router.get("/google/drive/folders", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const folders = await providers.listDriveFiles(accessToken, {
        pageSize: req.query.limit || 100,
        folderId: req.query.parentId ? cleanId(req.query.parentId, "상위 폴더") : "",
        foldersOnly: true,
        query: String(req.query.q || "").slice(0, 120),
      });
      res.json({ folders });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/folders", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const name = String(req.body?.name || "").trim().slice(0, 255);
      if (!name) return res.status(400).json({ error: "폴더 이름이 필요합니다." });
      const folder = await providers.createDriveFolder(accessToken, {
        name,
        parentId: req.body?.parentId ? cleanId(req.body.parentId, "상위 폴더") : "",
      });
      res.status(201).json({ folder });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/upload", requireAuth, upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "업로드할 파일이 필요합니다." });
    try {
      const { accessToken } = await googleContext(req);
      const convertToGoogleDoc = truthy(req.body.convertToGoogleDoc);
      if (convertToGoogleDoc && !(/\.docx$/i.test(req.file.originalname || "") || req.file.mimetype === DOCX_MIME)) {
        return res.status(400).json({ error: "Google Docs 변환은 DOCX 파일만 지원합니다." });
      }
      const folderId = await googleFolder(accessToken, req.body.folderId, String(req.body.useQuiloFolder || "true") !== "false");
      const sourceKey = String(req.body.sourceKey || "").trim().slice(0, 120);
      const existing = sourceKey && !convertToGoogleDoc
        ? await providers.findDriveFileBySource(accessToken, sourceKey)
        : null;
      const file = await providers.uploadDriveFile(accessToken, {
        name: convertToGoogleDoc ? String(req.file.originalname || "Quilo 문서").replace(/\.docx$/i, "") : req.file.originalname,
        mimeType: req.file.mimetype || "application/octet-stream",
        buffer: req.file.buffer,
        folderId,
        fileId: existing?.id || "",
        targetMimeType: convertToGoogleDoc ? providers.GOOGLE_DOC_MIME : "",
        appProperties: sourceKey ? { quiloSourceKey: sourceKey, quiloOrigin: "upload" } : { quiloOrigin: "upload" },
      });
      res.status(existing ? 200 : 201).json({ file, updated: !!existing });
    } catch (error) { sendCloudError(res, error); }
  });

  router.get("/google/drive/files/:fileId/download", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const fileId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, fileId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      const downloaded = await providers.downloadDriveFile(accessToken, fileId);
      res.set({
        "Content-Type": downloaded.mimeType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(downloaded.filename)}`,
        "Content-Length": String(downloaded.buffer.length),
        "Cache-Control": "private, no-store",
      });
      res.send(downloaded.buffer);
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/files/:fileId/import", requireAuth, async (req, res) => {
    try {
      if (!supa.isEnabled?.()) return res.status(503).json({ error: "Quilo 파일함이 설정되지 않았습니다." });
      const { accessToken, user } = await googleContext(req);
      const sourceId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, sourceId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      const downloaded = await providers.downloadDriveFile(accessToken, sourceId);
      const saved = await supa.saveReportFile({
        userId: user.id,
        jobId: `drive-${crypto.createHash("sha256").update(sourceId).digest("hex").slice(0, 20)}`,
        reportType: "google-drive-import",
        filename: downloaded.filename,
        mimeType: downloaded.mimeType,
        buffer: downloaded.buffer,
        meta: { source: "google-drive", googleFileId: sourceId },
      });
      res.status(201).json({ file: saved });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/files/:fileId/copy", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const sourceId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, sourceId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      const folderId = await googleFolder(accessToken, req.body?.folderId, false);
      const file = await providers.copyDriveFile(accessToken, sourceId, {
        name: String(req.body?.name || "").trim().slice(0, 255),
        folderId,
        appProperties: { quiloOrigin: "copy" },
      });
      res.status(201).json({ file });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/reports/:fileId", requireAuth, async (req, res) => {
    try {
      if (!supa.isEnabled?.()) return res.status(503).json({ error: "Quilo 파일함이 설정되지 않았습니다." });
      const { accessToken, user } = await googleContext(req);
      const saved = await supa.downloadReportFile(user.id, cleanId(req.params.fileId, "Quilo 파일"));
      if (!saved) return res.status(404).json({ error: "파일이 없거나 만료되었습니다." });
      if (isHiddenFile({
        name: saved.row.filename,
        appProperties: { quiloReportType: saved.row.report_type },
      })) {
        return res.status(404).json({ error: "파일이 없거나 만료되었습니다." });
      }
      const convertToGoogleDoc = truthy(req.body?.convertToGoogleDoc);
      const isDocx = /\.docx$/i.test(saved.row.filename || "") || saved.row.mime_type === DOCX_MIME;
      if (convertToGoogleDoc && !isDocx) return res.status(400).json({ error: "DOCX 보고서만 Google Docs로 변환할 수 있습니다." });
      const folderId = await googleFolder(accessToken, req.body?.folderId, true);
      const sourceKey = `report:${req.params.fileId}:${convertToGoogleDoc ? "gdoc" : "file"}`;
      const existing = await providers.findDriveFileBySource(accessToken, sourceKey);
      if (existing && convertToGoogleDoc) {
        return res.json({ file: existing, updated: false, reused: true });
      }
      const file = await providers.uploadDriveFile(accessToken, {
        name: convertToGoogleDoc ? String(saved.row.filename || "Quilo 보고서").replace(/\.docx$/i, "") : saved.row.filename,
        mimeType: saved.row.mime_type || "application/octet-stream",
        buffer: saved.buffer,
        folderId,
        fileId: existing?.id || "",
        targetMimeType: convertToGoogleDoc ? providers.GOOGLE_DOC_MIME : "",
        appProperties: { quiloSourceKey: sourceKey, quiloOrigin: "report" },
      });
      res.status(existing ? 200 : 201).json({ file, updated: !!existing });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/docs", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const folderId = await googleFolder(accessToken, req.body?.folderId, true);
      res.status(201).json({ document: await providers.createGoogleDoc(accessToken, { ...(req.body || {}), folderId }) });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/docs/:documentId/append", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const documentId = cleanId(req.params.documentId, "문서");
      const text = String(req.body?.text || "").trim();
      if (!text) return res.status(400).json({ error: "추가할 본문이 필요합니다." });
      const document = await providers.appendGoogleDocText(accessToken, documentId, text);
      res.json({ document: { id: document.documentId, title: document.title, url: `https://docs.google.com/document/d/${document.documentId}/edit` } });
    } catch (error) { sendCloudError(res, error); }
  });

  router.get("/google/drive/files/:fileId/comments", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const fileId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, fileId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      res.json({ comments: await providers.listDriveComments(accessToken, fileId, { pageSize: req.query.limit }) });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/files/:fileId/comments", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const fileId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, fileId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      const comment = await providers.createDriveComment(accessToken, fileId, {
        content: String(req.body?.content || "").slice(0, 5000),
        quotedText: String(req.body?.quotedText || "").slice(0, 500),
      });
      res.status(201).json({ comment });
    } catch (error) { sendCloudError(res, error); }
  });

  router.post("/google/drive/files/:fileId/comments/:commentId/replies", requireAuth, async (req, res) => {
    try {
      const { accessToken } = await googleContext(req);
      const fileId = cleanId(req.params.fileId);
      const metadata = await providers.getDriveFile(accessToken, fileId);
      if (isHiddenFile(metadata)) {
        return res.status(404).json({ error: "파일을 찾을 수 없습니다." });
      }
      const reply = await providers.replyDriveComment(
        accessToken,
        fileId,
        cleanId(req.params.commentId, "댓글"),
        { content: String(req.body?.content || "").slice(0, 5000), resolve: truthy(req.body?.resolve) },
      );
      res.status(201).json({ reply });
    } catch (error) { sendCloudError(res, error); }
  });
  router.post("/notion/pages", requireAuth, async (req, res) => {
    try {
      const { row } = await connection(req, "notion");
      res.status(201).json({ page: await providers.createNotionPage(providers.decryptToken(row.refresh_token), req.body || {}) });
    } catch (error) { res.status(502).json({ error: error.message }); }
  });
  return router;
}

module.exports = { createCloudIntegrationRouter };
