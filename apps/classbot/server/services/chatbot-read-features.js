import { endOfSeoulDay, getSeoulParts, startOfSeoulDay } from "../time.js";

const FILE_COMMAND_WORDS = new Set([
  "찾기", "찾아줘", "찾아주세요", "검색", "검색해줘", "검색해주세요",
  "열기", "열어줘", "열어주세요", "보여줘", "보여주세요", "알려줘", "알려주세요",
]);

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/[?!.,。]+$/u, "")
    .replace(/\s+/g, " ");
}

function compactText(value) {
  return normalizedText(value).replace(/\s+/g, "").toLocaleLowerCase("ko");
}

function normalizedSearchText(value) {
  return normalizedText(value)
    .toLocaleLowerCase("ko")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function searchTokens(value) {
  return normalizedSearchText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !FILE_COMMAND_WORDS.has(token));
}

function requestedFileType(value) {
  const type = String(value || "").toLocaleLowerCase("ko");
  if (type === "pdf") return "pdf";
  if (type === "이미지") return "image";
  return "file";
}

export function isTodayBriefingCommand(command) {
  const compact = compactText(command);
  return new Set(["오늘브리핑", "오늘요약", "브리핑"]).has(compact);
}

export function readFileBrowseSpec(command, { allowRaw = false } = {}) {
  const text = normalizedText(command);
  if (!text || /^(?:자료|파일)\s*(?:목록|리스트)$/iu.test(text)) return null;

  if (/^(?:최근|최신|새로)(?:\s*(?:올라온|등록된))?\s*(?:자료|파일)(?:\s*(?:목록|리스트|보여줘|보여주세요))?$/iu.test(text)) {
    return { kind: "recent", requestedType: "file", query: "", explicit: true };
  }

  const prefix = text.match(/^(파일|pdf|이미지)\s+(.+)$/iu);
  if (prefix) {
    return {
      kind: "search",
      requestedType: requestedFileType(prefix[1]),
      query: normalizedText(prefix[2]),
      explicit: true,
    };
  }

  const suffix = text.match(/^(.+?)\s+(자료|파일|pdf|이미지)(?:\s+(?:찾기|찾아줘|찾아주세요|검색|검색해줘|검색해주세요|열어줘|열어주세요|보여줘|보여주세요))?$/iu);
  if (suffix) {
    return {
      kind: "search",
      requestedType: requestedFileType(suffix[2]),
      query: normalizedText(suffix[1]),
      explicit: true,
    };
  }

  return allowRaw ? {
    kind: "search",
    requestedType: "file",
    query: text,
    explicit: /(?:학습지|프린트|자료|파일|pdf|이미지)/iu.test(text),
  } : null;
}

function isPdf(file) {
  return String(file?.mime_type || "").toLocaleLowerCase("ko") === "application/pdf"
    || String(file?.filename || "").toLocaleLowerCase("ko").endsWith(".pdf");
}

function isImage(file) {
  return String(file?.mime_type || "").toLocaleLowerCase("ko").startsWith("image/");
}

function matchesType(file, requestedType) {
  return requestedType === "file"
    || (requestedType === "pdf" && isPdf(file))
    || (requestedType === "image" && isImage(file));
}

function fileSearchText(file) {
  return normalizedSearchText([
    file?.alias,
    file?.filename,
    file?.description,
    file?.mime_type,
  ].filter(Boolean).join(" "));
}

function fileTimestamp(file) {
  const value = new Date(file?.created_at || file?.updated_at || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function rankBrowseFileCandidates(files, spec) {
  const eligible = (Array.isArray(files) ? files : []).filter((file) => matchesType(file, spec?.requestedType || "file"));
  if (spec?.kind === "recent") {
    return eligible
      .sort((a, b) => fileTimestamp(b) - fileTimestamp(a))
      .slice(0, 3)
      .map((file) => ({ file, score: 1 }));
  }

  const tokens = searchTokens(spec?.query);
  if (!tokens.length) return [];
  return eligible
    .map((file) => {
      const haystack = fileSearchText(file);
      const matched = tokens.filter((token) => haystack.includes(token)).length;
      return { file, score: matched / tokens.length, matched };
    })
    .filter((item) => item.matched === tokens.length)
    .sort((a, b) => b.score - a.score || fileTimestamp(b.file) - fileTimestamp(a.file))
    .slice(0, 3)
    .map(({ file, score }) => ({ file, score }));
}

function compactTimetable(rows) {
  if (!rows.length) return "없음";
  return rows
    .slice(0, 8)
    .map((row) => `${row.period}교시 ${row.subject}`)
    .join(" · ");
}

function eventDday(event, now) {
  const today = startOfSeoulDay(now).getTime();
  const due = startOfSeoulDay(new Date(event.due_at)).getTime();
  const days = Math.round((due - today) / 86_400_000);
  if (days === 0) return "오늘";
  if (days === 1) return "내일";
  return `D-${days}`;
}

function compactEvents(events, now) {
  if (!events.length) return "없음";
  return events
    .slice(0, 3)
    .map((event) => `• ${event.subject ? `${event.subject} ` : ""}${event.title} (${eventDday(event, now)})`)
    .join("\n");
}

function recentBy(items, fields) {
  return [...(Array.isArray(items) ? items : [])].sort((a, b) => {
    const timestamp = (item) => {
      const raw = fields.map((field) => item?.[field]).find(Boolean) || 0;
      const value = new Date(raw).getTime();
      return Number.isFinite(value) ? value : 0;
    };
    return timestamp(b) - timestamp(a);
  });
}

async function optionalList(loader) {
  try {
    return await loader();
  } catch {
    return [];
  }
}

export async function buildTodayBriefing({ store, member, now = new Date() }) {
  const parts = getSeoulParts(now);
  const [timetable, events, notices, files] = await Promise.all([
    parts.weekday >= 1 && parts.weekday <= 5
      ? (async () => {
          if (typeof store.listMemberTimetable === "function") {
            const personal = await store.listMemberTimetable(member.id, { weekday: parts.weekday, date: parts.dateKey });
            if (personal.length) return personal;
          }
          return store.listTimetable({ weekday: parts.weekday });
        })()
      : Promise.resolve([]),
    store.listEvents({
      from: startOfSeoulDay(now).toISOString(),
      to: endOfSeoulDay(new Date(startOfSeoulDay(now).getTime() + 2 * 86_400_000)).toISOString(),
      status: "scheduled",
      targetMemberId: member.id,
    }),
    optionalList(() => store.listNotices({ status: "published", limit: 5 })),
    typeof store.listFiles === "function"
      ? optionalList(() => store.listFiles({ targetMemberId: member.id }))
      : Promise.resolve([]),
  ]);

  const latestNotice = recentBy(notices, ["published_at", "created_at"])[0];
  const latestFiles = recentBy(
    files.filter((file) => file?.member_id == null || file.member_id === member.id)
      .filter((file) => String(file?.status || "active").toLocaleLowerCase("ko") === "active"),
    ["created_at", "updated_at"],
  ).slice(0, 2);
  const fileSummary = latestFiles.length
    ? latestFiles.map((file) => file.alias || file.filename).join(" · ")
    : "없음";

  return [
    `${member.display_name}님의 오늘 브리핑`,
    "",
    `시간표: ${compactTimetable(timetable)}`,
    "",
    "오늘·임박 일정",
    compactEvents(events, now),
    "",
    `새 공지: ${latestNotice?.title || "없음"}`,
    `최근 자료: ${fileSummary}`,
  ].join("\n");
}
