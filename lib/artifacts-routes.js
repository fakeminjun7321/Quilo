// "창작/만들기"(AI 아티팩트 빌더) API 라우터.
// 마운트: app.use(require("./lib/artifacts-routes")({ requireAdmin, requireAdminOrBeta, getSessionUser }))
// 생성·관리 = 관리자 또는 'create' 베타 테스터. 갤러리·/p 보기 = 모두 공개.
//
// - POST /api/artifacts/build  : 프롬프트(+현재 HTML) → AI 가 self-contained HTML 생성
// - GET  /api/artifacts        : 내 아티팩트 목록
// - POST /api/artifacts        : 저장/게시(upsert) → { slug, url }
// - DELETE /api/artifacts/:id  : 삭제
// - GET  /p/:slug              : 게시된 아티팩트를 **sandbox iframe** 으로 안전하게 제공
//
// 저장: Supabase 'artifacts' 테이블(없으면 메모리 fallback — 재시작 시 사라짐).
// 보안: 생성/저장/관리 전부 관리자. 게시물은 origin 격리(sandbox, no same-origin)로
//       쿠키·세션 접근을 차단해 공개 뷰어를 보호한다.

const express = require("express");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const supa = require("./supabase");

const GPT_BASE = process.env.GPT_API_BASE || "https://api.openai.com/v1";
const isGpt = (m) => /^gpt/i.test(String(m || ""));
const BUILD_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const DEFAULT_BUILD_MODEL = "claude-opus-4-8";

const SYSTEM_PROMPT = `너는 최고의 웹 아티팩트 빌더다. 사용자가 한국어로 "이런 웹페이지 / 위젯 / 작은 도구를 만들어줘"라고 하면, **완전히 self-contained 한 단일 HTML 문서 하나**를 만든다.

규칙:
- 출력은 <!DOCTYPE html> 로 시작해 </html> 로 끝나는 **완결된 HTML 문서 하나**. 모든 CSS 는 <style>, 모든 JS 는 <script> 안에 인라인.
- 번들러/빌드 필요 없는 것만. 단, 브라우저에서 바로 동작하는 CDN <script>/<link>(예: Chart.js, Tailwind Play CDN, Google Fonts)는 사용해도 된다.
- 이 HTML 은 **sandbox iframe**(allow-scripts; same-origin·쿠키 없음, 상위창 이동 불가) 안에서 돈다. 부모/사이트의 쿠키·localStorage·세션에 접근하려 하지 말 것. 외부 공개 API(CORS 허용) 호출은 가능.
- UI 는 기본 한국어. 반응형(모바일 OK), 깔끔하고 완성도 높게. 접근성·다크모드 고려하면 좋음.
- 데이터가 필요하면 그럴듯한 더미 데이터를 내장하되, 사용자가 값을 입력/조정할 수 있게.
- **출력은 HTML 코드만.** 마크다운 코드펜스(\`\`\`)나 설명 문장을 절대 넣지 말 것.`;

function stripFences(s) {
  let t = String(s || "").trim();
  // ```html ... ``` 또는 ``` ... ``` 제거
  const m = t.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (m) t = m[1].trim();
  // 앞부분에 코드펜스만 떼고 뒤에 설명이 붙는 경우 대비: 첫 <!doctype ~ 마지막 </html>
  const lo = t.toLowerCase();
  const a = lo.indexOf("<!doctype");
  const b = lo.lastIndexOf("</html>");
  if (a >= 0 && b > a) t = t.slice(a, b + "</html>".length);
  return t.trim();
}

async function callClaudeHtml({ model, prompt, currentHtml }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const userText = currentHtml
    ? `현재 HTML:\n\`\`\`html\n${currentHtml}\n\`\`\`\n\n요청(이걸 반영해 전체 HTML 을 다시 출력):\n${prompt}`
    : prompt;
  const msg = await client.messages.create({
    model,
    max_tokens: Math.min(Number(process.env.MAX_TOKENS) || 32000, 32000),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userText }],
  });
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callGptHtml({ model, prompt, currentHtml }) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("GPT_API_KEY 가 설정되지 않았습니다.");
  const userText = currentHtml
    ? `현재 HTML:\n\`\`\`html\n${currentHtml}\n\`\`\`\n\n요청(이걸 반영해 전체 HTML 을 다시 출력):\n${prompt}`
    : prompt;
  const resp = await fetch(`${GPT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
      max_completion_tokens: 32000,
      reasoning_effort: process.env.GPT_REASONING_EFFORT || "low",
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${raw.slice(0, 200)}`);
  const j = JSON.parse(raw);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

function slugify(s) {
  const base = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\- ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return base || "page";
}

// ── 저장소: Supabase 'artifacts' 테이블, 없으면 메모리 ────────────────────────
const mem = new Map(); // slug -> record
let tableOk = null; // null=미확인, true/false

async function sb() {
  if (!supa.isEnabled()) return null;
  try {
    return supa.getClient();
  } catch {
    return null;
  }
}

async function storeUpsert(rec) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { error } = await c.from("artifacts").upsert(rec, { onConflict: "slug" });
      if (error) throw error;
      tableOk = true;
      return rec;
    } catch (e) {
      tableOk = false; // 테이블 없음 등 → 메모리 fallback
    }
  }
  mem.set(rec.slug, rec);
  return rec;
}

// 관리 목록: 관리자는 전체, 베타 사용자는 본인(owner) 것만.
async function storeList({ owner, isAdmin }) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      let q = c.from("artifacts").select("id,slug,title,is_public,updated_at,owner").order("updated_at", { ascending: false }).limit(300);
      if (!isAdmin) q = q.eq("owner", owner);
      const { data, error } = await q;
      if (error) throw error;
      tableOk = true;
      return data || [];
    } catch {
      tableOk = false;
    }
  }
  return [...mem.values()]
    .filter((r) => isAdmin || r.owner === owner)
    .map((r) => ({ id: r.id, slug: r.slug, title: r.title, is_public: r.is_public, updated_at: r.updated_at, owner: r.owner }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

// 공개 갤러리: 공개(is_public) 아티팩트만, 모두에게.
async function storeGallery() {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c
        .from("artifacts")
        .select("slug,title,updated_at,owner")
        .eq("is_public", true)
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      tableOk = true;
      return data || [];
    } catch {
      tableOk = false;
    }
  }
  return [...mem.values()]
    .filter((r) => r.is_public)
    .map((r) => ({ slug: r.slug, title: r.title, updated_at: r.updated_at, owner: r.owner }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function storeGet(slug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c.from("artifacts").select("*").eq("slug", slug).maybeSingle();
      if (error) throw error;
      tableOk = true;
      if (data) return data;
    } catch {
      tableOk = false;
    }
  }
  return mem.get(slug) || null;
}

async function storeDelete(idOrSlug) {
  const c = await sb();
  if (c && tableOk) {
    try {
      await c.from("artifacts").delete().or(`id.eq.${idOrSlug},slug.eq.${idOrSlug}`);
    } catch {
      /* ignore */
    }
  }
  for (const [slug, r] of mem) if (r.id === idOrSlug || slug === idOrSlug) mem.delete(slug);
}

function escapeForSrcdoc(html) {
  return String(html || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = function artifactsRouter({ requireAdmin, requireAdminOrBeta, getSessionUser }) {
  const r = express.Router();
  // 생성·관리는 관리자 또는 'create' 베타 테스터만. 보기(갤러리·/p)는 모두 공개.
  const gate = requireAdminOrBeta ? requireAdminOrBeta("create") : requireAdmin;

  // 공개 갤러리 — 로그인 불필요(비베타·비로그인도 만든 것 구경 가능)
  r.get("/api/artifacts/gallery", async (req, res) => {
    try {
      res.json({ items: await storeGallery() });
    } catch (e) {
      res.status(500).json({ error: "갤러리를 불러오지 못했습니다." });
    }
  });

  r.get("/api/artifacts/models", gate, (req, res) => {
    res.json({ models: BUILD_MODELS, default: DEFAULT_BUILD_MODEL });
  });

  // 생성/수정 — 프롬프트 → HTML
  r.post("/api/artifacts/build", gate, async (req, res) => {
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "무엇을 만들지 설명해 주세요." });
    let model = String(req.body.model || DEFAULT_BUILD_MODEL);
    if (!BUILD_MODELS.includes(model)) model = DEFAULT_BUILD_MODEL;
    const currentHtml = req.body.currentHtml ? String(req.body.currentHtml).slice(0, 200000) : "";
    if (isGpt(model) && !(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY))
      return res.status(503).json({ error: "GPT 키가 없습니다(GPT_API_KEY)." });
    if (!isGpt(model) && !process.env.ANTHROPIC_API_KEY)
      return res.status(503).json({ error: "ANTHROPIC_API_KEY 가 없습니다." });
    try {
      const raw = isGpt(model)
        ? await callGptHtml({ model, prompt, currentHtml })
        : await callClaudeHtml({ model, prompt, currentHtml });
      const html = stripFences(raw);
      if (!html || !/<\/html>/i.test(html))
        return res.status(502).json({ error: "AI가 완결된 HTML을 만들지 못했습니다. 다시 시도해 주세요." });
      res.json({ html, model });
    } catch (e) {
      console.error("[artifacts] build:", e.message);
      res.status(500).json({ error: e.message || "생성 실패" });
    }
  });

  // 목록(내가 관리할 것) — 관리자=전체, 베타=본인 것
  r.get("/api/artifacts", gate, async (req, res) => {
    try {
      const u = getSessionUser(req) || {};
      res.json({ artifacts: await storeList({ owner: u.name || "admin", isAdmin: !!u.isAdmin }), persistent: tableOk === true });
    } catch (e) {
      res.status(500).json({ error: "목록을 불러오지 못했습니다." });
    }
  });

  // 저장/게시 (upsert)
  r.post("/api/artifacts", gate, async (req, res) => {
    const title = String(req.body.title || "").trim() || "제목 없음";
    const html = String(req.body.html || "");
    if (!/<\/html>/i.test(html)) return res.status(400).json({ error: "저장할 HTML이 비어 있거나 완결되지 않았습니다." });
    let slug = slugify(req.body.slug || title);
    const owner = getSessionUser(req)?.name || "admin";
    // 새 slug면 충돌 시 숫자 suffix
    const existing = await storeGet(slug);
    if (existing && String(req.body.slug || "") !== slug && !req.body.overwrite) {
      slug = `${slug}-${Math.floor(Date.now() / 1000) % 100000}`;
    }
    const prev = await storeGet(slug);
    const rec = {
      id: (prev && prev.id) || crypto.randomUUID(),
      slug,
      title,
      html,
      is_public: req.body.isPublic !== false,
      owner,
      created_at: (prev && prev.created_at) || nowIso(),
      updated_at: nowIso(),
    };
    try {
      await storeUpsert(rec);
      res.json({ ok: true, slug, url: `/p/${encodeURIComponent(slug)}`, persistent: tableOk === true });
    } catch (e) {
      res.status(500).json({ error: e.message || "저장 실패" });
    }
  });

  // 편집용 원본 HTML 가져오기(관리자)
  r.get("/api/artifacts/:slug/raw", gate, async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).json({ error: "없음" });
    res.json({ slug: rec.slug, title: rec.title, html: rec.html, is_public: rec.is_public });
  });

  r.delete("/api/artifacts/:id", gate, async (req, res) => {
    await storeDelete(req.params.id);
    res.json({ ok: true });
  });

  // 게시 페이지 — sandbox iframe 으로 격리 제공
  r.get("/p/:slug", async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).type("html").send("<h1>404</h1><p>없는 페이지입니다.</p>");
    if (!rec.is_public) {
      const u = getSessionUser(req);
      if (!u || !u.isAdmin) return res.status(403).type("html").send("<h1>403</h1><p>비공개 페이지입니다.</p>");
    }
    const title = String(rec.title || "아티팩트").replace(/[<>&"]/g, "");
    res.type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" srcdoc="${escapeForSrcdoc(rec.html)}"></iframe>
</body></html>`);
  });

  return r;
};
