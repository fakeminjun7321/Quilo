// 커뮤니티 모더레이션 — 한국어/영어 비속어 감지 + 글/댓글 검증.
//
// 완벽한 필터는 불가능하지만(우회는 항상 가능), 흔한 욕설·변형(ㅅㅂ, 시1발, ㅆㅂ,
// 띄어 쓰기/반복/특수문자 삽입)을 정규화 후 잡는다. 걸리면 작성 거부 + 1주일 금지.

// 정규화: 소문자화 → leet 치환 → 한글/자모/영문만 남김 → 동일문자 연속 축약.
// 영문 leet(b1tch→bitch, fuuuck→fuck)을 잡는 데 강하다.
function normalize(text) {
  let s = String(text || "").toLowerCase();
  // leet/치환 흔한 것 복원
  s = s
    .replace(/[1l|]/g, "i")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/0/g, "o")
    .replace(/5/g, "s")
    .replace(/@/g, "a");
  // 한글·자모·영문만 남기고 제거(공백·특수문자·숫자로 끊어쓰기 우회 차단)
  s = s.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z]/g, "");
  // 동일 문자가 3회 이상 연속이면 1회로 축약(fuuuck → fuck).
  s = s.replace(/(.)\1{2,}/g, "$1");
  return s;
}

// 분리용 숫자·기호를 글자로 '치환'하지 않고 '제거'한 변형.
// 한글 음절 사이에 숫자/특수문자를 끼워 넣는 우회(시1발, 씨@발, ㅅ.ㅂ)를 잡는다.
// normalize()는 1→i, @→a 로 치환해 버려서 '시1발 → 시i발'처럼 음절 사이에
// 글자가 끼어 매칭이 깨지는데, 이 변형은 그런 분리자를 통째로 지운다.
function normalizeStripped(text) {
  let s = String(text || "").toLowerCase();
  // leet 치환 없이, 글자가 아닌 것(숫자·공백·특수문자)을 통째로 제거
  s = s.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣa-z]/g, "");
  s = s.replace(/(.)\1{2,}/g, "$1");
  return s;
}

// 정규화 후 부분일치로 검사할 비속어(이미 정규화된 형태로 등록).
const BAD = [
  // 한국어
  "시발", "씨발", "시바", "씨바", "쓰발", "시발롬", "시발놈", "시벌", "씨벌",
  "병신", "븅신", "빙신", "버엉신", "ㅄ", "ㅂㅅ",
  "지랄", "지랄년", "지랄남",
  "좆", "좆같", "존나", "졸라", "ㅈㄴ", "조까", "좆까",
  "개새끼", "개색기", "개색끼", "새끼", "쌔끼", "개쌔끼", "썅", "쌍놈", "쌍년",
  "닥쳐", "꺼져", "엿먹", "엿이나",
  "보지", "자지", "걸레", "창녀", "창놈",
  "느금마", "느금", "니애미", "니미", "에미", "애미뒤", "애미",
  "ㅅㅂ", "ㅆㅂ", "ㅗ", "ㅈ같", "tlqkf", "qudtls",
  // 영어
  "fuck", "fuk", "fck", "shit", "bitch", "asshole", "bastard", "dick",
  "pussy", "cunt", "motherfucker", "fucker", "nigger", "faggot", "retard",
];

// 패턴도 입력과 동일한 정규화를 거쳐 비교한다. 이렇게 하지 않으면 BAD에 적힌
// 'tlqkf' 같은 항목이 입력 정규화(l→i)와 어긋나 'tiqkf'로 변한 입력과 영영
// 매칭되지 않는다. 정규화 후 빈 문자열이 되는 항목은 버린다.
const BAD_NORM = BAD.map((raw) => ({ raw, norm: normalize(raw) })).filter((x) => x.norm);

// 텍스트에 비속어가 있으면 { hit:true, word } 반환, 없으면 { hit:false }.
// 두 가지 정규화 변형(leet 치환형 + 분리자 제거형) 모두에 대해 부분일치 검사.
function checkProfanity(text) {
  const variants = [normalize(text), normalizeStripped(text)];
  for (const { raw, norm } of BAD_NORM) {
    for (const n of variants) {
      if (n.includes(norm)) return { hit: true, word: raw };
    }
  }
  return { hit: false };
}

// 글/댓글 텍스트 검증. 통과하면 { ok:true }, 비속어면 { ok:false, reason }.
function validateText(text, { min = 1, max = 5000 } = {}) {
  const t = String(text || "").trim();
  if (t.length < min) return { ok: false, reason: "내용이 비어 있습니다." };
  if (t.length > max) return { ok: false, reason: `너무 깁니다(최대 ${max}자).` };
  const p = checkProfanity(t);
  if (p.hit) return { ok: false, reason: "PROFANITY", profanity: true };
  return { ok: true };
}

const BAN_DAYS = Number(process.env.COMMUNITY_BAN_DAYS || 7);

// ── DB (글/공감/댓글) — supabase.js 를 수정하지 않고 클라이언트만 재사용 ──────────
const supa = require("./supabase");

async function getActiveBan(userId) {
  const c = supa.getClient();
  if (!c || !userId) return null;
  try {
    const { data } = await c
      .from("users")
      .select("community_banned_until")
      .eq("id", userId)
      .maybeSingle();
    const until = data && data.community_banned_until;
    if (until && new Date(until).getTime() > Date.now()) return until;
  } catch (_) {
    /* 컬럼 없음 등 → 밴 없음으로 */
  }
  return null;
}

async function banUser(userId) {
  const c = supa.getClient();
  if (!c || !userId) return null;
  const until = new Date(Date.now() + BAN_DAYS * 86400000).toISOString();
  try {
    await c.from("users").update({ community_banned_until: until }).eq("id", userId);
  } catch (_) {}
  return until;
}

async function unbanUser(userId) {
  const c = supa.getClient();
  if (!c || !userId) return;
  await c.from("users").update({ community_banned_until: null }).eq("id", userId);
}

// ── 생성(비용 남용) 정지 ─────────────────────────────────────────────────────
// 시간당 API 비용이 등급 한도를 넘으면 정지. 커뮤니티 밴과 동일 패턴(users 컬럼 +
// community_appeals 소명 재사용, kind="generation"). 관리자만 해제(소명 검토).
// 오탐으로 영구 잠기지 않게 GENERATION_BAN_DAYS 뒤 자동 만료(관리자가 먼저 해제 가능).
const GENERATION_BAN_DAYS = Number(process.env.GENERATION_BAN_DAYS || 30);

// 새 커뮤니티는 일반 게시판 분류만 받는다. feature/suggestion은 이전 글을
// 읽고 필터링할 때만 남겨 두어 기존 데이터를 마이그레이션 없이 보존한다.
const NEW_POST_CATEGORIES = Object.freeze([
  "general",
  "question",
  "tip",
  "showcase",
]);
const LEGACY_POST_CATEGORIES = Object.freeze(["feature", "suggestion"]);
const READABLE_POST_CATEGORIES = Object.freeze([
  ...NEW_POST_CATEGORIES,
  ...LEGACY_POST_CATEGORIES,
]);
const POST_CATEGORY_LABELS = Object.freeze({
  general: "자유",
  question: "질문",
  tip: "사용팁",
  showcase: "작업공유",
  feature: "이전 기능 요청",
  suggestion: "이전 건의사항",
});

function normalizeNewPostCategory(value) {
  const category = String(value || "").trim();
  return NEW_POST_CATEGORIES.includes(category) ? category : null;
}

function normalizeReadablePostCategory(value) {
  const category = String(value || "").trim();
  return READABLE_POST_CATEGORIES.includes(category) ? category : null;
}

async function getGenerationBan(userId) {
  const c = supa.getClient();
  if (!c || !userId) return null;
  try {
    const { data } = await c
      .from("users")
      .select("generation_banned_until, generation_ban_reason")
      .eq("id", userId)
      .maybeSingle();
    const until = data && data.generation_banned_until;
    if (until && new Date(until).getTime() > Date.now()) {
      return { until, reason: (data && data.generation_ban_reason) || "" };
    }
  } catch (_) {
    /* 컬럼 없음(마이그레이션 전) 등 → 정지 없음으로 fail-open */
  }
  return null;
}

async function banGeneration(userId, reason) {
  const c = supa.getClient();
  if (!c || !userId) return null;
  const until = new Date(
    Date.now() + GENERATION_BAN_DAYS * 86400000,
  ).toISOString();
  try {
    await c
      .from("users")
      .update({
        generation_banned_until: until,
        generation_ban_reason: String(reason || "").slice(0, 500),
      })
      .eq("id", userId);
  } catch (_) {}
  return until;
}

async function unbanGeneration(userId) {
  const c = supa.getClient();
  if (!c || !userId) return;
  try {
    await c
      .from("users")
      .update({ generation_banned_until: null, generation_ban_reason: null })
      .eq("id", userId);
  } catch (_) {}
}

async function createPost({ userId, authorName, category, title, body }) {
  const c = supa.getClient();
  if (!c) throw new Error("DB 미설정");
  const normalizedCategory = normalizeNewPostCategory(category);
  if (!normalizedCategory) {
    const error = new Error("새 글에 사용할 수 없는 분류입니다.");
    error.code = "INVALID_COMMUNITY_CATEGORY";
    throw error;
  }
  const { data, error } = await c
    .from("community_posts")
    .insert({
      user_id: userId,
      author_name: authorName || "익명",
      category: normalizedCategory,
      title: String(title).slice(0, 200),
      body: String(body).slice(0, 5000),
      upvotes: 0,
    })
    .select()
    .single();
  if (error) throw new Error(`createPost: ${error.message}`);
  return data;
}

async function listPosts({ category = null, viewerId = null, limit = 200 } = {}) {
  const c = supa.getClient();
  if (!c) return [];
  let q = c
    .from("community_posts")
    .select("id, user_id, author_name, category, title, body, upvotes, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (category) q = q.eq("category", category);
  const { data, error } = await q;
  if (error) throw new Error(`listPosts: ${error.message}`);
  const posts = data || [];
  const ids = posts.map((p) => p.id);
  const voted = new Set();
  const counts = {};
  if (ids.length) {
    if (viewerId) {
      const { data: v } = await c
        .from("community_votes")
        .select("post_id")
        .eq("user_id", viewerId)
        .in("post_id", ids);
      (v || []).forEach((x) => voted.add(x.post_id));
    }
    const { data: cm } = await c
      .from("community_comments")
      .select("post_id")
      .in("post_id", ids);
    (cm || []).forEach((x) => (counts[x.post_id] = (counts[x.post_id] || 0) + 1));
  }
  return posts.map((p) => ({
    ...p,
    voted: voted.has(p.id),
    comment_count: counts[p.id] || 0,
  }));
}

async function getPost(id) {
  const c = supa.getClient();
  if (!c) return null;
  const { data } = await c.from("community_posts").select("*").eq("id", id).maybeSingle();
  return data || null;
}

async function deletePost(id) {
  const c = supa.getClient();
  if (!c) return;
  await c.from("community_posts").delete().eq("id", id);
}

async function toggleVote(postId, userId) {
  const c = supa.getClient();
  if (!c) throw new Error("DB 미설정");
  const { data: existing } = await c
    .from("community_votes")
    .select("post_id")
    .eq("post_id", postId)
    .eq("user_id", userId)
    .maybeSingle();
  let voted;
  if (existing) {
    await c.from("community_votes").delete().eq("post_id", postId).eq("user_id", userId);
    voted = false;
  } else {
    await c.from("community_votes").insert({ post_id: postId, user_id: userId });
    voted = true;
  }
  const { count } = await c
    .from("community_votes")
    .select("post_id", { count: "exact", head: true })
    .eq("post_id", postId);
  const upvotes = count || 0;
  await c.from("community_posts").update({ upvotes }).eq("id", postId);
  return { voted, upvotes };
}

async function listComments(postId) {
  const c = supa.getClient();
  if (!c) return [];
  const { data } = await c
    .from("community_comments")
    .select("id, user_id, author_name, body, created_at")
    .eq("post_id", postId)
    .order("created_at", { ascending: true });
  return data || [];
}

async function addComment({ postId, userId, authorName, body }) {
  const c = supa.getClient();
  if (!c) throw new Error("DB 미설정");
  const { data, error } = await c
    .from("community_comments")
    .insert({
      post_id: postId,
      user_id: userId,
      author_name: authorName || "익명",
      body: String(body).slice(0, 2000),
    })
    .select()
    .single();
  if (error) throw new Error(`addComment: ${error.message}`);
  return data;
}

async function getComment(id) {
  const c = supa.getClient();
  if (!c) return null;
  const { data } = await c.from("community_comments").select("*").eq("id", id).maybeSingle();
  return data || null;
}

async function deleteComment(id) {
  const c = supa.getClient();
  if (!c) return;
  await c.from("community_comments").delete().eq("id", id);
}

// ── 소명(해명) — 오탐(욕설 아닌데 차단)으로 제재된 사용자가 해명 제출 → 관리자 검토 ──
async function addAppeal({ userId, authorName, kind, blockedText, reason }) {
  const c = supa.getClient();
  if (!c) throw new Error("DB 미설정");
  const { data, error } = await c
    .from("community_appeals")
    .insert({
      user_id: userId,
      author_name: authorName || "익명",
      // post/comment = 커뮤니티 욕설 오탐 소명, generation = 생성 정지 소명.
      kind: ["comment", "generation"].includes(kind) ? kind : "post",
      blocked_text: String(blockedText || "").slice(0, 5000),
      reason: String(reason || "").slice(0, 2000),
      status: "pending",
    })
    .select()
    .single();
  if (error) throw new Error(`addAppeal: ${error.message}`);
  return data;
}

async function listAppeals({ status = null, limit = 200 } = {}) {
  const c = supa.getClient();
  if (!c) return [];
  let q = c
    .from("community_appeals")
    .select(
      "id, user_id, author_name, kind, blocked_text, reason, status, created_at, resolved_at",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw new Error(`listAppeals: ${error.message}`);
  const rows = data || [];
  // 각 신청자의 현재 밴 상태를 함께 표시. kind 에 따라 커뮤니티/생성 밴을 구분해서 본다.
  const uids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const banMap = {};
  if (uids.length) {
    try {
      const { data: us } = await c
        .from("users")
        .select("id, community_banned_until, generation_banned_until")
        .in("id", uids);
      (us || []).forEach((u) => (banMap[u.id] = u));
    } catch (_) {}
  }
  const active = (until) =>
    until && new Date(until).getTime() > Date.now() ? until : null;
  return rows.map((r) => {
    const rec = banMap[r.user_id] || {};
    const until =
      r.kind === "generation"
        ? rec.generation_banned_until
        : rec.community_banned_until;
    return { ...r, banned_until: active(until) };
  });
}

async function resolveAppeal(id, { unban = false } = {}) {
  const c = supa.getClient();
  if (!c) throw new Error("DB 미설정");
  const { data: ap } = await c
    .from("community_appeals")
    .select("user_id, kind")
    .eq("id", id)
    .maybeSingle();
  if (unban && ap && ap.user_id) {
    // 소명 종류에 맞는 밴을 해제한다(생성 정지 vs 커뮤니티 밴).
    if (ap.kind === "generation") await unbanGeneration(ap.user_id);
    else await unbanUser(ap.user_id);
  }
  await c
    .from("community_appeals")
    .update({ status: "resolved", resolved_at: new Date().toISOString() })
    .eq("id", id);
  return { ok: true };
}

module.exports = {
  normalize,
  checkProfanity,
  validateText,
  BAN_DAYS,
  BAD,
  getActiveBan,
  banUser,
  unbanUser,
  GENERATION_BAN_DAYS,
  getGenerationBan,
  banGeneration,
  unbanGeneration,
  NEW_POST_CATEGORIES,
  LEGACY_POST_CATEGORIES,
  READABLE_POST_CATEGORIES,
  POST_CATEGORY_LABELS,
  normalizeNewPostCategory,
  normalizeReadablePostCategory,
  createPost,
  listPosts,
  getPost,
  deletePost,
  toggleVote,
  listComments,
  addComment,
  getComment,
  deleteComment,
  addAppeal,
  listAppeals,
  resolveAppeal,
};
