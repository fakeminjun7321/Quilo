// 랩(기술 공개) API — server.js 를 거의 건드리지 않도록 별도 모듈.
// 마운트: app.use("/api/lab", require("./lib/lab-routes")())
//
// 공개 읽기(로그인 불필요). 코드 파일은 lab-content.json 의 files[] 에 명시된
// 화이트리스트 경로만 제공한다(경로 조작·비밀키 노출 차단 + 방어적 스크럽).

const express = require("express");
const fs = require("fs");
const path = require("path");

const ENTRIES = require("./lab-content.json");
const ROOT = path.resolve(__dirname, "..");

// 다운로드/열람 허용 파일 = 모든 엔트리 files[].path 의 합집합(엄격 화이트리스트).
const WHITELIST = new Set();
for (const e of ENTRIES) for (const f of e.files || []) WHITELIST.add(f.path);

const ALLOWED_EXT = new Set([
  ".js", ".py", ".md", ".sql", ".json", ".css", ".html", ".txt",
]);

// 화이트리스트 + 경로조작 + 확장자 검증을 모두 통과한 절대경로만 반환.
function resolveSafe(rel) {
  if (!WHITELIST.has(rel)) return null;
  if (!ALLOWED_EXT.has(path.extname(rel))) return null;
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  try {
    if (!fs.statSync(abs).isFile()) return null;
  } catch {
    return null;
  }
  return abs;
}

// 만에 하나라도 키/토큰 비슷한 문자열이 섞여 나가지 않게 방어적으로 가린다.
function scrubSecrets(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***REDACTED***")
    .replace(/xox[baprs]-[A-Za-z0-9-]{8,}/g, "***REDACTED***")
    .replace(
      /((?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*[:=]\s*["'])([^"']{10,})(["'])/gi,
      "$1***REDACTED***$3",
    );
}

module.exports = function labRouter() {
  const r = express.Router();

  // 목록: 제목·메타만(본문/코드 없음) — '일단 제목만'
  r.get("/entries", (_req, res) => {
    res.json({
      entries: ENTRIES.map((e) => ({
        id: e.id,
        date: e.date,
        tag: e.tag,
        title: e.title,
        summary: e.summary,
        fileCount: (e.files || []).length,
      })),
    });
  });

  // 상세: 제목을 누르면 받는 본문 + 첨부 코드 파일 목록(메타)
  r.get("/entry/:id", (req, res) => {
    const e = ENTRIES.find((x) => x.id === req.params.id);
    if (!e) return res.status(404).json({ error: "없는 항목입니다." });
    const files = (e.files || []).map((f) => {
      let size = 0;
      const abs = resolveSafe(f.path);
      try {
        if (abs) size = fs.statSync(abs).size;
      } catch {
        /* size 0 */
      }
      return { path: f.path, label: f.label, size, available: !!abs };
    });
    res.json({
      id: e.id,
      date: e.date,
      tag: e.tag,
      title: e.title,
      summary: e.summary,
      body_markdown: e.body_markdown,
      files,
    });
  });

  // 코드 파일 열람/다운로드(화이트리스트 한정)
  r.get("/file", (req, res) => {
    const rel = String(req.query.path || "");
    const abs = resolveSafe(rel);
    if (!abs) return res.status(404).json({ error: "허용되지 않은 파일입니다." });
    let text;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      return res.status(500).json({ error: "파일을 읽지 못했습니다." });
    }
    text = scrubSecrets(text);
    const name = path.basename(rel);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (String(req.query.download) === "1") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(name)}"`,
      );
      res.setHeader("Content-Type", "application/octet-stream");
    } else {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.send(text);
  });

  return r;
};
