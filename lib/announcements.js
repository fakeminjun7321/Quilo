// 공지사항(상단 티커) 저장소.
// Supabase `announcements` 테이블이 있으면 거기에, 없으면(또는 미설정) 메모리에 보관한다.
// → 테이블 SQL을 적용하지 않아도 즉시 동작하고(재시작 시 초기화), 적용하면 영구 저장된다.

const supa = require("./supabase");

const mem = []; // [{id,title,category,link,active,created_at}]
let memSeq = 1;
const isMemId = (id) => String(id).startsWith("mem-");
const nowIso = () => new Date().toISOString();

// 공지 링크 정규화(저장단 XSS 방어).
// 프론트가 이 link 를 상단 티커 <a href> 로 렌더하므로, 위험한 스킴
// (javascript:/data:/vbscript: 등)이 저장되면 클릭형 저장 XSS 가 된다.
// 허용: http://, https://, 또는 상대경로(`/` 로 시작). 그 외 스킴은 빈 링크로 무력화한다.
// (반환형/필드명은 그대로 — 정상 사용자의 http/https/상대경로 링크는 100% 동일하게 동작.)
function sanitizeLink(raw) {
  const link = String(raw || "").trim().slice(0, 500);
  if (!link) return "";
  // 상대경로(절대경로 형태)는 허용하되, 프로토콜 상대 URL("//host") 은 차단한다.
  if (link.startsWith("/")) return link.startsWith("//") ? "" : link;
  // 스킴 검사 전에 제어문자/공백을 제거해 "ja\tvascript:" 같은 우회를 막는다.
  // eslint-disable-next-line no-control-regex
  const probe = link.replace(/[\x00-\x20]+/g, "");
  if (/^https?:\/\//i.test(probe)) return link;
  return ""; // javascript:/data:/vbscript:/mailto: 등 그 외 스킴 → 무력화
}

async function list(activeOnly = false) {
  const c = supa.getClient();
  if (c) {
    try {
      const { data, error } = await c
        .from("announcements")
        .select("id,title,category,link,active,created_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      let rows = data || [];
      if (activeOnly) rows = rows.filter((r) => r.active);
      return { rows, store: "db" };
    } catch (_) {
      /* 테이블 없음 등 → 메모리 fallback */
    }
  }
  let rows = mem
    .slice()
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  if (activeOnly) rows = rows.filter((r) => r.active);
  return { rows, store: "memory" };
}

async function create({ title, category, link }) {
  const rec = {
    title: String(title || "").slice(0, 200),
    category: String(category || "공지").trim().slice(0, 40) || "공지",
    link: sanitizeLink(link),
    active: true,
  };
  const c = supa.getClient();
  if (c) {
    try {
      const { data, error } = await c
        .from("announcements")
        .insert(rec)
        .select()
        .single();
      if (error) throw error;
      return { row: data, store: "db" };
    } catch (_) {
      /* fallback */
    }
  }
  const row = { id: "mem-" + memSeq++, ...rec, created_at: nowIso() };
  mem.unshift(row);
  return { row, store: "memory" };
}

async function setActive(id, active) {
  const c = supa.getClient();
  if (c && !isMemId(id)) {
    try {
      await c.from("announcements").update({ active: !!active }).eq("id", id);
      return { store: "db" };
    } catch (_) {
      /* fallback */
    }
  }
  const r = mem.find((x) => String(x.id) === String(id));
  if (r) r.active = !!active;
  return { store: "memory" };
}

async function remove(id) {
  const c = supa.getClient();
  if (c && !isMemId(id)) {
    try {
      await c.from("announcements").delete().eq("id", id);
      return { store: "db" };
    } catch (_) {
      /* fallback */
    }
  }
  const i = mem.findIndex((x) => String(x.id) === String(id));
  if (i >= 0) mem.splice(i, 1);
  return { store: "memory" };
}

module.exports = { list, create, setActive, remove };
