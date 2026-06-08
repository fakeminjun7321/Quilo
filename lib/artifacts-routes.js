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
const DEFAULT_BUILD_MODEL = "auto";
// 바이브 코딩: 비용 최소화 사다리 — 싼 모델부터 시도, 결과가 부실하면 자동 상향.
const AUTO_LADDER = ["gpt-5.4-mini", "claude-sonnet-4-6", "claude-opus-4-8"];
const hasClaude = () => !!process.env.ANTHROPIC_API_KEY;
const hasGpt = () => !!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY);
const keyFor = (m) => (isGpt(m) ? hasGpt() : hasClaude());

function htmlLooksComplete(html) {
  if (!html) return false;
  const h = stripFences(html);
  if (!/<\/html>/i.test(h) || h.length < 500) return false;
  // 닫힘 균형(대략): <script>/<style> 개폐 수 일치
  const open = (h.match(/<script\b/gi) || []).length;
  const close = (h.match(/<\/script>/gi) || []).length;
  return open === close;
}

async function callOne(model, prompt, currentHtml) {
  return isGpt(model)
    ? callGptHtml({ model, prompt, currentHtml })
    : callClaudeHtml({ model, prompt, currentHtml });
}

// model==="auto" 면 사다리로 가장 싼 모델부터, 충분히 완결되면 채택.
async function buildResolved(model, prompt, currentHtml) {
  if (model && model !== "auto" && BUILD_MODELS.includes(model)) {
    const html = stripFences(await callOne(model, prompt, currentHtml));
    return { html, model, auto: false };
  }
  const ladder = AUTO_LADDER.filter(keyFor);
  if (!ladder.length) throw new Error("사용 가능한 AI 키가 없습니다.");
  let last = "";
  for (let i = 0; i < ladder.length; i++) {
    const m = ladder[i];
    try {
      const html = stripFences(await callOne(m, prompt, currentHtml));
      last = html || last;
      // 마지막 단계이거나 결과가 충분히 완결되면 채택
      if (htmlLooksComplete(html) || i === ladder.length - 1) {
        return { html, model: m, auto: true };
      }
    } catch (e) {
      if (i === ladder.length - 1) throw e; // 마지막까지 실패면 에러
    }
  }
  return { html: last, model: ladder[ladder.length - 1], auto: true };
}

const SYSTEM_PROMPT = `너는 최고의 웹 아티팩트 빌더다. 사용자가 한국어로 "이런 웹페이지 / 위젯 / 작은 도구를 만들어줘"라고 하면, **완전히 self-contained 한 단일 HTML 문서 하나**를 만든다.

규칙:
- 출력은 <!DOCTYPE html> 로 시작해 </html> 로 끝나는 **완결된 HTML 문서 하나**. 모든 CSS 는 <style>, 모든 JS 는 <script> 안에 인라인.
- 번들러/빌드 필요 없는 것만. 단, 브라우저에서 바로 동작하는 CDN <script>/<link>(예: Chart.js, Tailwind Play CDN, Google Fonts)는 사용해도 된다.
- 이 HTML 은 **sandbox iframe**(allow-scripts; same-origin·쿠키 없음, 상위창 이동 불가) 안에서 돈다. 부모/사이트의 쿠키·localStorage·세션에 접근하려 하지 말 것. 외부 공개 API(CORS 허용) 호출은 가능.
- UI 는 기본 한국어. 반응형(모바일 OK), 깔끔하고 완성도 높게. 접근성·다크모드 고려하면 좋음.
- 데이터가 필요하면 그럴듯한 더미 데이터를 내장하되, 사용자가 값을 입력/조정할 수 있게.

**공유 데이터 저장(QuiloDB) — 방문자끼리 공유되는 데이터가 필요할 때 사용:**
이 페이지가 게시되면 \`window.QuiloDB\` 가 자동 주입된다(별도 로드 불필요). 모든 방문자가 공유하는 저장소다(예: 방명록, 투표/설문 집계, 랭킹, 공용 메모). 모두 async:
- \`await QuiloDB.set(key, value)\` — 값 저장(JSON 가능, 8KB 이하)
- \`await QuiloDB.get(key)\` — 값 읽기(없으면 undefined)
- \`await QuiloDB.all()\` — {키:값} 전체
- \`await QuiloDB.push(listKey, item)\` — 리스트에 항목 추가(방명록·로그용, 최대 1000개)
규칙: 방문자 공유가 필요하면 QuiloDB 를, '이 브라우저에만' 저장이면 localStorage 를 쓴다. QuiloDB 호출은 try/catch 로 감싸고 실패해도 UI 가 깨지지 않게. 초기 로드시 QuiloDB.all() 로 기존 데이터를 그려라.

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

// OpenAI gpt-image-1 로 이미지 생성 → base64 png.
async function genImageB64(prompt, size) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("이미지 생성 키(GPT_API_KEY)가 없습니다.");
  const resp = await fetch(`${GPT_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: size || "1024x1024", quality: "medium" }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`이미지 생성 ${resp.status}: ${raw.slice(0, 160)}`);
  const j = JSON.parse(raw);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("이미지 응답이 비었습니다.");
  return b64;
}

// 미디어 저장: Supabase Storage 'artifact-media'(공개) → 공개 URL. 없으면 data URL.
const MEDIA_BUCKET = process.env.ARTIFACT_MEDIA_BUCKET || "artifact-media";
let mediaBucketOk = null;
async function uploadMedia(buffer, ext, contentType) {
  const c = await sb();
  if (c) {
    try {
      if (mediaBucketOk === null) {
        const { error: ge } = await c.storage.getBucket(MEDIA_BUCKET);
        if (ge) await c.storage.createBucket(MEDIA_BUCKET, { public: true });
        mediaBucketOk = true;
      }
      const path = `img/${crypto.randomUUID()}.${ext}`;
      const { error } = await c.storage.from(MEDIA_BUCKET).upload(path, buffer, { contentType, upsert: false });
      if (error) throw error;
      const { data } = c.storage.from(MEDIA_BUCKET).getPublicUrl(path);
      if (data && data.publicUrl) return data.publicUrl;
    } catch (e) {
      mediaBucketOk = false; // 스토리지 불가 → data URL fallback
    }
  }
  return `data:${contentType};base64,${buffer.toString("base64")}`;
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
        .select("slug,title,updated_at,owner,category,likes")
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
    .map((r) => ({ slug: r.slug, title: r.title, updated_at: r.updated_at, owner: r.owner, category: r.category || "", likes: r.likes || 0 }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

async function storeLike(slug) {
  const c = await sb();
  if (c && tableOk) {
    try {
      const cur = await storeGet(slug);
      if (!cur) return 0;
      const likes = (cur.likes || 0) + 1;
      await c.from("artifacts").update({ likes }).eq("slug", slug);
      return likes;
    } catch {
      /* memory */
    }
  }
  const r = mem.get(slug);
  if (!r) return 0;
  r.likes = (r.likes || 0) + 1;
  return r.likes;
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

// ── 아티팩트용 공유 KV 저장소 (인터랙티브 앱: 투표·방명록·랭킹·상태) ──────────
// Supabase 'artifact_kv'(slug,k,v) + 메모리 fallback. 캡으로 남용 방지.
const KV_MAX_VAL = 8 * 1024; // 값(JSON) 최대 8KB
const KV_MAX_KEYS = 300; // slug 당 키 수
const KV_MAX_LIST = 1000; // push 리스트 길이
const memKv = new Map(); // slug -> Map(k -> v)

function memKvOf(slug) {
  if (!memKv.has(slug)) memKv.set(slug, new Map());
  return memKv.get(slug);
}
async function kvAll(slug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c.from("artifact_kv").select("k,v").eq("slug", slug).limit(KV_MAX_KEYS);
      if (error) throw error;
      const o = {};
      for (const row of data || []) o[row.k] = row.v;
      return o;
    } catch {
      /* fall through to memory */
    }
  }
  return Object.fromEntries(memKvOf(slug));
}
async function kvGet(slug, k) {
  const all = await kvAll(slug);
  return all[k];
}
async function kvSet(slug, k, v) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { error } = await c.from("artifact_kv").upsert({ slug, k, v, updated_at: nowIso() }, { onConflict: "slug,k" });
      if (error) throw error;
      return;
    } catch {
      /* memory */
    }
  }
  const m = memKvOf(slug);
  if (!m.has(k) && m.size >= KV_MAX_KEYS) throw new Error("저장 키 수 한도 초과");
  m.set(k, v);
}
async function kvPush(slug, k, item) {
  const cur = (await kvGet(slug, k)) || [];
  const arr = Array.isArray(cur) ? cur : [];
  arr.push(item);
  while (arr.length > KV_MAX_LIST) arr.shift();
  await kvSet(slug, k, arr);
  return arr.length;
}

// 간단 IP 레이트리밋(쓰기): 분당 N회
const kvRate = new Map();
function kvWriteAllowed(ip) {
  const now = Date.now();
  const win = 60000, lim = 80;
  const rec = kvRate.get(ip) || { t: now, n: 0 };
  if (now - rec.t > win) { rec.t = now; rec.n = 0; }
  rec.n++; kvRate.set(ip, rec);
  return rec.n <= lim;
}

function escapeForSrcdoc(html) {
  return String(html || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// 게시 페이지의 sandbox iframe 안에 주입할 QuiloDB 헬퍼(절대 URL 로 KV 호출).
function quiloDbScript(base, slug) {
  const api = `${base}/api/kv/${encodeURIComponent(slug)}`;
  return `<script>(function(){var A=${JSON.stringify(api)};async function j(u,o){var r=await fetch(u,Object.assign({headers:{'Content-Type':'application/json'}},o));if(!r.ok)throw new Error('KV '+r.status);return r.json();}
window.QuiloDB={all:function(){return j(A);},get:async function(k){return (await j(A))[k];},set:function(k,v){return j(A+'/'+encodeURIComponent(k),{method:'PUT',body:JSON.stringify({value:v})});},push:function(k,item){return j(A+'/'+encodeURIComponent(k)+'/push',{method:'POST',body:JSON.stringify({item:item})});}};})();</script>`;
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

  // 좋아요 — 공개(중복은 클라이언트 localStorage 로 방지). IP 레이트리밋.
  r.post("/api/artifacts/:slug/like", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "?").split(",")[0].trim();
    if (!kvWriteAllowed(ip)) return res.status(429).json({ error: "rate limit" });
    try {
      const rec = await storeGet(req.params.slug);
      if (!rec || !rec.is_public) return res.status(404).json({ error: "없음" });
      res.json({ likes: await storeLike(req.params.slug) });
    } catch (e) {
      res.status(500).json({ error: "실패" });
    }
  });

  r.get("/api/artifacts/models", gate, (req, res) => {
    // '자동' 을 맨 앞에(바이브 코딩 기본값). 키 없는 모델은 숨김.
    const avail = BUILD_MODELS.filter(keyFor);
    res.json({ models: ["auto", ...avail], default: "auto" });
  });

  // 생성/수정 — 프롬프트 → HTML (model='auto' 면 비용 최소화 사다리)
  r.post("/api/artifacts/build", gate, async (req, res) => {
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "무엇을 만들지 설명해 주세요." });
    let model = String(req.body.model || "auto");
    if (model !== "auto" && !BUILD_MODELS.includes(model)) model = "auto";
    if (model !== "auto" && !keyFor(model))
      return res.status(503).json({ error: `${isGpt(model) ? "GPT_API_KEY" : "ANTHROPIC_API_KEY"} 가 없습니다.` });
    const currentHtml = req.body.currentHtml ? String(req.body.currentHtml).slice(0, 200000) : "";
    // 생성/업로드한 이미지 URL 을 프롬프트에 첨부 → AI 가 <img src> 로 삽입.
    const imgs = Array.isArray(req.body.images) ? req.body.images.filter((u) => typeof u === "string").slice(0, 8) : [];
    const fullPrompt = imgs.length
      ? `${prompt}\n\n[사용 가능한 이미지 URL — 필요하면 <img src="..."> 로 삽입하세요]\n${imgs.join("\n")}`
      : prompt;
    try {
      const out = await buildResolved(model, fullPrompt, currentHtml);
      if (!out.html || !/<\/html>/i.test(out.html))
        return res.status(502).json({ error: "AI가 완결된 HTML을 만들지 못했습니다. 다시 시도해 주세요." });
      res.json({ html: out.html, model: out.model, auto: out.auto });
    } catch (e) {
      console.error("[artifacts] build:", e.message);
      res.status(500).json({ error: e.message || "생성 실패" });
    }
  });

  // 이미지 생성 (gpt-image-1) → 저장 → URL
  r.post("/api/artifacts/image", gate, async (req, res) => {
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "이미지 설명을 적어주세요." });
    try {
      const b64 = await genImageB64(prompt, req.body.size);
      const url = await uploadMedia(Buffer.from(b64, "base64"), "png", "image/png");
      res.json({ url });
    } catch (e) {
      console.error("[artifacts] image:", e.message);
      res.status(500).json({ error: e.message || "이미지 생성 실패" });
    }
  });

  // 이미지 업로드 (dataURL JSON) → 저장 → URL
  r.post("/api/artifacts/upload", gate, async (req, res) => {
    const dataUrl = String(req.body.dataUrl || "");
    const m = dataUrl.match(/^data:(image\/(png|jpe?g|gif|webp|svg\+xml));base64,([\s\S]+)$/i);
    if (!m) return res.status(400).json({ error: "이미지 파일(data URL)이 아닙니다." });
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: "이미지가 너무 큽니다(6MB 이하)." });
    const ext = m[2].replace("jpeg", "jpg").replace("svg+xml", "svg");
    try {
      res.json({ url: await uploadMedia(buf, ext, m[1]) });
    } catch (e) {
      res.status(500).json({ error: e.message || "업로드 실패" });
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
      category: String(req.body.category || "").slice(0, 24) || "기타",
      likes: (prev && prev.likes) || 0,
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

  // ── KV(공유 데이터) API — sandbox iframe(null origin)에서 호출하므로 CORS 허용 ──
  const kvCors = (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
  const kvClientIp = (req) => (req.headers["x-forwarded-for"] || req.ip || "?").split(",")[0].trim();
  async function kvSlugOk(slug) {
    const rec = await storeGet(slug);
    return rec && rec.is_public; // 공개 아티팩트만 KV 사용
  }

  r.options("/api/kv/:slug", kvCors);
  r.options("/api/kv/:slug/:key", kvCors);
  r.options("/api/kv/:slug/:key/push", kvCors);

  r.get("/api/kv/:slug", kvCors, async (req, res) => {
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    try { res.json(await kvAll(req.params.slug)); } catch { res.status(500).json({ error: "read fail" }); }
  });

  r.put("/api/kv/:slug/:key", kvCors, async (req, res) => {
    if (!kvWriteAllowed(kvClientIp(req))) return res.status(429).json({ error: "rate limit" });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const v = req.body && req.body.value;
    if (JSON.stringify(v ?? null).length > KV_MAX_VAL) return res.status(413).json({ error: "값이 너무 큽니다" });
    try { await kvSet(req.params.slug, String(req.params.key).slice(0, 64), v); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post("/api/kv/:slug/:key/push", kvCors, async (req, res) => {
    if (!kvWriteAllowed(kvClientIp(req))) return res.status(429).json({ error: "rate limit" });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const item = req.body && req.body.item;
    if (JSON.stringify(item ?? null).length > KV_MAX_VAL) return res.status(413).json({ error: "값이 너무 큽니다" });
    try { const n = await kvPush(req.params.slug, String(req.params.key).slice(0, 64), item); res.json({ ok: true, length: n }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 게시 페이지 — sandbox iframe 으로 격리 제공 + QuiloDB(공유 저장) 주입
  r.get("/p/:slug", async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).type("html").send("<h1>404</h1><p>없는 페이지입니다.</p>");
    if (!rec.is_public) {
      const u = getSessionUser(req);
      if (!u || !u.isAdmin) return res.status(403).type("html").send("<h1>403</h1><p>비공개 페이지입니다.</p>");
    }
    const title = String(rec.title || "아티팩트").replace(/[<>&"]/g, "");
    const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
    // QuiloDB 헬퍼를 아티팩트 HTML 앞에 주입(공개 아티팩트만 KV 동작).
    const inner = rec.is_public ? quiloDbScript(base, rec.slug) + rec.html : rec.html;
    res.type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" srcdoc="${escapeForSrcdoc(inner)}"></iframe>
</body></html>`);
  });

  return r;
};
