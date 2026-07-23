// 랩(기술 공개) API — server.js 를 거의 건드리지 않도록 별도 모듈.
// 마운트: app.use("/api/lab", require("./lib/lab-routes")())
//
// 공개 읽기(로그인 불필요). 코드 파일은 lab-content.json 의 files[] 에 명시된
// 화이트리스트 경로만 제공한다(경로 조작·비밀키 노출 차단 + 방어적 스크럽).

const express = require("express");
const fs = require("fs");
const path = require("path");

const DEVELOPMENT_HISTORY = require("./development-history.json");
const LEGACY_ENTRIES = require("./lab-content.json");
// 최신 제품 연대기를 앞에 두고, 기존 커뮤니티 Lab 26편은 읽기 전용
// 기술 아카이브로 그대로 이어 붙인다. /api/lab 계약을 유지하므로 DB가
// 비어 있어도 개발 노트에서 전체 기록을 읽을 수 있다.
const ENTRIES = Object.freeze([...DEVELOPMENT_HISTORY, ...LEGACY_ENTRIES]);
const ROOT = path.resolve(__dirname, "..");
const RETIRED_REFERENCES = [
  "phys-inquiry",
  "math-inquiry",
  "eng-exam-prep",
  "korean-lit-exam",
  "phys-mock-exam",
  "물리 수행평가",
  "수학 수행평가",
  "영어 시험대비",
  "국어 문학 시험",
  "물리 모의고사",
];
function containsRetiredReference(value) {
  const text = String(value || "").toLowerCase();
  return RETIRED_REFERENCES.some((term) => text.includes(term.toLowerCase()));
}
function isRetiredLabEntry(entry) {
  return containsRetiredReference(JSON.stringify(entry || {}));
}
const PUBLIC_ENTRIES = Object.freeze(ENTRIES.filter((entry) => !isRetiredLabEntry(entry)));

// 다운로드/열람 허용 파일 = 모든 엔트리 files[].path 의 합집합(엄격 화이트리스트).
const WHITELIST = new Set();
for (const e of PUBLIC_ENTRIES) for (const f of e.files || []) WHITELIST.add(f.path);

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

  // 랩 글은 배포(글 추가) 즉시 반영돼야 한다. 응답에 Cache-Control 이 없으면 브라우저가
  // 옛 목록(예: 글 추가 전 19편)을 캐시에서 그대로 보여줄 수 있으므로 캐시를 끈다.
  // 작고(수~수십 KB) 가끔 호출되는 JSON·텍스트라 no-store 비용은 무시할 만하다.
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // 목록: 제목·메타만(본문/코드 없음) — '일단 제목만'
  r.get("/entries", (_req, res) => {
    res.json({
      entries: PUBLIC_ENTRIES.map((e) => ({
        id: e.id,
        date: e.date,
        tag: e.tag,
        title: e.title,
        summary: e.summary,
        archiveKind: e.archive_kind || "lab",
        coverImage: e.cover_image || null,
        fileCount: (e.files || []).length,
      })),
    });
  });

  // 상세: 제목을 누르면 받는 본문 + 첨부 코드 파일 목록(메타)
  r.get("/entry/:id", (req, res) => {
    const e = PUBLIC_ENTRIES.find((x) => x.id === req.params.id);
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
      archiveKind: e.archive_kind || "lab",
      coverImage: e.cover_image || null,
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
    if (containsRetiredReference(text)) {
      return res.status(404).json({ error: "허용되지 않은 파일입니다." });
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

module.exports.containsRetiredReference = containsRetiredReference;
module.exports.isRetiredLabEntry = isRetiredLabEntry;
module.exports.publicEntries = PUBLIC_ENTRIES;
