"use strict";

const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { pythonBin } = require("./pipelines/vocabulary-book/extract");

const EXAMPLE = Object.freeze({
  id: "serway-physics-ch22-44",
  title: "Serway Physics Vocabulary",
  subtitle: "Chapter 22-44 · English-Korean Vocabulary Book",
  pageCount: 290,
  byteLength: 4347614,
  sha256: "59d00cc5291ba65fc69e323b2894cbde29f4d74e873e56c19243bd0ab231f074",
  bucket: process.env.SECURE_EXAMPLE_BUCKET || "secure-examples",
  objectPath: "vocabulary/serway10-ch22-44-vocabulary-book.pdf",
});
const SESSION_TTL_MS = 15 * 60 * 1000;
const PAGE_LIMIT_PER_MINUTE = 45;
const RENDER_SCRIPT = path.join(__dirname, "secure-vocabulary-render.py");
const MAX_RENDER_BYTES = 7 * 1024 * 1024;

function userKey(user) {
  return String(user?.id || user?.username || user?.name || "");
}

function sourceDigest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function validateSourcePdf(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new Error("예시 PDF 데이터가 없습니다.");
  if (buffer.length !== EXAMPLE.byteLength) throw new Error("예시 PDF 크기가 등록값과 다릅니다.");
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") throw new Error("예시 파일이 PDF가 아닙니다.");
  if (sourceDigest(buffer) !== EXAMPLE.sha256) throw new Error("예시 PDF 무결성 검증에 실패했습니다.");
  return true;
}

function secureViewerHeaders(res, { content = false } = {}) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), display-capture=(), usb=(), payment=()",
    "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  });
  if (!content) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; media-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  }
}

function createSessionRegistry({ secret, now = () => Date.now(), ttlMs = SESSION_TTL_MS } = {}) {
  const key = String(secret || "secure-example-session");
  const sessions = new Map();

  function prune() {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(token);
    }
  }

  function issue(user) {
    prune();
    const owner = userKey(user);
    if (!owner) throw new Error("로그인 사용자를 확인할 수 없습니다.");
    for (const [token, session] of sessions) {
      if (session.owner === owner) sessions.delete(token);
    }
    const createdAt = now();
    const token = crypto.randomBytes(32).toString("base64url");
    const viewerCode = crypto.createHmac("sha256", key).update(`vocabulary-viewer:${owner}`).digest("hex").slice(0, 10).toUpperCase();
    const session = {
      token,
      owner,
      viewerCode,
      createdAt,
      expiresAt: createdAt + ttlMs,
      hits: [],
    };
    sessions.set(token, session);
    return { ...session, hits: undefined };
  }

  function verify(token, user) {
    prune();
    const session = sessions.get(String(token || ""));
    if (!session) return null;
    if (!userKey(user) || session.owner !== userKey(user)) return null;
    return session;
  }

  function consume(session) {
    const timestamp = now();
    session.hits = session.hits.filter((hit) => timestamp - hit < 60_000);
    if (session.hits.length >= PAGE_LIMIT_PER_MINUTE) return false;
    session.hits.push(timestamp);
    return true;
  }

  return { issue, verify, consume, prune };
}

function storageClient(supa) {
  const client = supa?.getClient?.();
  if (!client) throw new Error("비공개 예시 저장소가 설정되지 않았습니다.");
  return client;
}

let sourcePathPromise = null;
async function privateSourcePath(supa) {
  if (sourcePathPromise) return sourcePathPromise;
  sourcePathPromise = (async () => {
    const localDevPath = process.env.SECURE_EXAMPLE_LOCAL_PDF;
    if (process.env.NODE_ENV !== "production" && localDevPath) {
      const localBuffer = await fs.promises.readFile(localDevPath);
      validateSourcePdf(localBuffer);
      return localDevPath;
    }
    const client = storageClient(supa);
    const { data, error } = await client.storage.from(EXAMPLE.bucket).download(EXAMPLE.objectPath);
    if (error || !data) throw new Error(`비공개 예시 PDF를 불러오지 못했습니다: ${error?.message || "not found"}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    validateSourcePdf(buffer);
    const dir = path.join(os.tmpdir(), "quilo-secure-examples");
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(dir, `${EXAMPLE.sha256}.pdf`);
    await fs.promises.writeFile(filePath, buffer, { mode: 0o600 });
    return filePath;
  })().catch((error) => {
    sourcePathPromise = null;
    throw error;
  });
  return sourcePathPromise;
}

function renderPage(filePath, pageNumber, watermark) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin(),
      [RENDER_SCRIPT, filePath, "--page", String(pageNumber), "--watermark", watermark],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_RENDER_BYTES) {
        child.kill("SIGKILL");
        return finish(new Error("예시 페이지 이미지가 제한을 초과했습니다."));
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.subarray(0, 3).toString("hex") !== "ffd8ff") {
        return finish(new Error(stderr.trim() || "예시 페이지 렌더링에 실패했습니다."));
      }
      return finish(null, output);
    });
  });
}

function createPageCache(maxEntries = 24) {
  const values = new Map();
  return {
    async get(key, loader) {
      if (values.has(key)) {
        const value = values.get(key);
        values.delete(key);
        values.set(key, value);
        return value;
      }
      const value = Promise.resolve().then(loader);
      values.set(key, value);
      try {
        const resolved = await value;
        values.set(key, resolved);
        while (values.size > maxEntries) values.delete(values.keys().next().value);
        return resolved;
      } catch (error) {
        values.delete(key);
        throw error;
      }
    },
  };
}

function createRenderScheduler({ maxConcurrent = 2, maxQueued = 10 } = {}) {
  let active = 0;
  const queue = [];

  function drain() {
    while (active < maxConcurrent && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    run(task) {
      if (active >= maxConcurrent && queue.length >= maxQueued) {
        return Promise.reject(new Error("예시 페이지 요청이 많습니다. 잠시 후 다시 시도하세요."));
      }
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    },
  };
}

function createSecureVocabularyExampleRouter({ requireAuth, getSessionUser, supa, sessionSecret, rootDir }) {
  const router = express.Router();
  const registry = createSessionRegistry({ secret: sessionSecret });
  const pageCache = createPageCache();
  const renderScheduler = createRenderScheduler();

  router.get("/examples/vocabulary/serway-physics", requireAuth, (req, res) => {
    secureViewerHeaders(res);
    res.sendFile(path.join(rootDir, "views", "secure-vocabulary-example.html"));
  });

  router.post("/api/examples/vocabulary/session", requireAuth, (req, res) => {
    secureViewerHeaders(res, { content: true });
    if (req.get("x-quilo-viewer") !== "secure-vocabulary") {
      return res.status(400).json({ error: "잘못된 뷰어 요청입니다." });
    }
    try {
      const session = registry.issue(getSessionUser(req));
      return res.json({
        example: { id: EXAMPLE.id, title: EXAMPLE.title, subtitle: EXAMPLE.subtitle, pageCount: EXAMPLE.pageCount },
        session: session.token,
        expiresAt: new Date(session.expiresAt).toISOString(),
      });
    } catch (error) {
      return res.status(503).json({ error: error.message });
    }
  });

  router.get("/api/examples/vocabulary/page/:page", requireAuth, async (req, res) => {
    secureViewerHeaders(res, { content: true });
    if (req.get("x-quilo-viewer") !== "secure-vocabulary") {
      return res.status(400).json({ error: "잘못된 뷰어 요청입니다." });
    }
    const session = registry.verify(req.get("x-vocabulary-viewer-session"), getSessionUser(req));
    if (!session) return res.status(401).json({ error: "읽기 세션이 만료되었습니다. 페이지를 새로고침하세요." });
    if (!registry.consume(session)) return res.status(429).json({ error: "페이지 요청이 너무 빠릅니다. 잠시 후 다시 시도하세요." });
    const pageNumber = Number.parseInt(req.params.page, 10);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > EXAMPLE.pageCount) {
      return res.status(404).json({ error: "페이지를 찾을 수 없습니다." });
    }
    try {
      const filePath = await privateSourcePath(supa);
      const started = new Date(session.createdAt).toISOString().slice(0, 16).replace("T", " ");
      const watermark = `READ ONLY | QL-${session.viewerCode} | ${started}Z`;
      const cacheKey = `${session.viewerCode}:${session.createdAt}:${pageNumber}`;
      const image = await pageCache.get(cacheKey, () =>
        renderScheduler.run(() => renderPage(filePath, pageNumber, watermark)),
      );
      res.set({
        "Content-Type": "image/jpeg",
        "Content-Length": image.length,
        "Content-Disposition": "inline",
      });
      return res.send(image);
    } catch (error) {
      console.error("[secure-vocabulary-example] page render:", error.message);
      return res.status(503).json({ error: "예시 페이지를 준비하지 못했습니다. 잠시 후 다시 시도하세요." });
    }
  });

  return router;
}

module.exports = {
  EXAMPLE,
  SESSION_TTL_MS,
  sourceDigest,
  validateSourcePdf,
  secureViewerHeaders,
  createSessionRegistry,
  createSecureVocabularyExampleRouter,
};
