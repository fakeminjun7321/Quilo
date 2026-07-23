import {
  extractKakaoUser,
  personalizedQuickReplies,
  registeredQuickReplies,
  simpleImageResponse,
  simpleTextResponse,
  textCardResponse,
} from "./kakao.js";
import {
  formatEventRows,
  formatTimetableRows,
  formatWeekTimetable,
  getDaySchedule,
  getUpcomingEvents,
  getWeekEvents,
  getWeekTimetable,
} from "./schedule.js";
import { dateForSeoulOffset, formatKoreanDate, getSeoulParts } from "../time.js";
import { answerEventMutation, answerPendingEventMutation } from "./event-commands.js";
import {
  buildTodayBriefing,
  isTodayBriefingCommand,
  rankBrowseFileCandidates,
  readFileBrowseSpec,
} from "./chatbot-read-features.js";

const TRAILING_REQUEST_WORDS = new Set([
  "알려줘", "알려주세요", "보여줘", "보여주세요", "확인", "확인해줘", "확인해주세요",
  "조회", "조회해줘", "조회해주세요", "뭐야", "있어", "있나요", "부탁해", "부탁해요",
  "해줘", "해주세요", "일정", "시간표", "수업표", "수행평가", "시험", "과제", "숙제", "스케줄",
  "전체", "요약", "통합요약", "남은일정", "이번달", "이달", "다음일정",
  "자료", "목록", "자료목록", "파일", "pdf", "이미지",
]);

function parameterValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return String(value.value ?? value.origin ?? "");
  return String(value);
}

function extractCommand(payload) {
  const params = payload.action?.params || {};
  return parameterValue(params.command || params.action || payload.userRequest?.utterance).trim();
}

function extractInviteCode(payload, command) {
  const params = payload.action?.params || {};
  const explicit = parameterValue(params.inviteCode || params.invite_code || params.code).trim();
  if (explicit) return explicit;
  return command.match(/(?:가입|초대)\s*([A-Z0-9]{4}-?[A-Z0-9]{4})/i)?.[1] || "";
}

function readNameRegistration(payload, command) {
  const params = payload.action?.params || {};
  const explicit = parameterValue(params.displayName || params.display_name || params.memberName || params.member_name).trim();
  const match = normalizedText(command).match(/^이름\s*등록(?:\s+(.+))?$/u);
  if (!match) return null;
  return normalizedText(explicit || match[1] || "");
}

function normalizedText(value) {
  return String(value || "")
    .trim()
    .replace(/[?!.,。]+$/u, "")
    .replace(/\s+/g, " ");
}

function compactText(value) {
  return normalizedText(value).replace(/\s+/g, "").toLowerCase();
}

function compactFileText(value) {
  return normalizedText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ko")
    .replace(/[\p{P}\p{S}\s]+/gu, "");
}

function looksLikeFileCommand(command) {
  return /^(?:자료\s*(?:목록|리스트)|파일\s*(?:목록|리스트)|파일(?:\s|$)|pdf(?:\s|$)|이미지(?:\s|$))/iu.test(normalizedText(command));
}

function readFileCommand(command, { allowRaw = false } = {}) {
  const text = normalizedText(command);
  if (/^(?:자료|파일)\s*(?:목록|리스트)$/u.test(text)) return { kind: "list" };
  const match = text.match(/^(파일|pdf|이미지)\s+(.+)$/iu);
  if (!match) return allowRaw && text ? { kind: "open", requestedType: "file", alias: text } : null;
  const requestedType = match[1].toLowerCase() === "pdf"
    ? "pdf"
    : match[1] === "이미지"
      ? "image"
      : "file";
  return { kind: "open", requestedType, alias: normalizedText(match[2]) };
}

function readIntent(command) {
  const compact = compactText(command);
  if (compact.includes("시간표") || compact.includes("수업표")) return "timetable";
  const asksAssessment = compact.includes("수행평가") || compact.includes("시험") || compact.includes("테스트");
  const asksAssignment = compact.includes("과제") || compact.includes("숙제") || compact.includes("제출물");
  if ((asksAssessment && asksAssignment) || compact.includes("통합요약") || compact.includes("학업요약")) return "study-summary";
  if (asksAssessment) return "assessment";
  if (asksAssignment) return "assignment";
  if (["일정", "스케줄", "할일", "할것", "뭐있", "해야할"].some((word) => compact.includes(word))) return "schedule";
  return null;
}

function readPeriod(command, intent) {
  const compact = compactText(command);
  if (intent === "timetable" && (compact.includes("전체") || compact.includes("월금"))) {
    return { kind: "full-timetable", label: "전체" };
  }
  if (compact.includes("다음일정") || compact.includes("가장가까운일정") || compact.includes("제일빠른일정")) {
    return { kind: "next", label: "다음" };
  }
  if (compact.includes("이번달") || compact.includes("이달")) return { kind: "month", label: "이번 달" };
  if ((compact.includes("이번주") || compact.includes("금주")) && compact.includes("남은")) {
    return { kind: "remaining-week", label: "이번 주 남은" };
  }
  if (compact.includes("다음주") || compact.includes("차주")) return { kind: "week", offset: 1, label: "다음 주" };
  if (compact.includes("이번주") || compact.includes("금주") || compact.includes("주간")) return { kind: "week", offset: 0, label: "이번 주" };
  if (compact.includes("모레")) return { kind: "day", offset: 2 };
  if (compact.includes("내일") || compact.includes("명일") || compact.startsWith("낼")) return { kind: "day", offset: 1 };
  if (compact.includes("오늘") || compact.includes("금일")) return { kind: "day", offset: 0 };
  return intent === "timetable" ? { kind: "day", offset: 0 } : { kind: "upcoming", days: 30 };
}

function appearsAsSeparateName(text, name) {
  return text === name || text.startsWith(`${name} `) || text.endsWith(` ${name}`) || text.includes(` ${name} `);
}

function resolveTargetMember(command, members, { defaultMember } = {}) {
  const text = normalizedText(command);
  const registered = members
    .filter((member) => member.status !== "left" && String(member.display_name || "").trim())
    .map((member) => ({ ...member, display_name: normalizedText(member.display_name) }));
  const matches = registered.filter((member) => text === member.display_name || text.endsWith(` ${member.display_name}`));

  if (matches.length > 1) {
    throw new Error(`동명이인 '${matches[0].display_name}'이(가) 여러 명입니다. 관리자가 이름을 구분해 등록해야 합니다.`);
  }
  if (matches.length === 1) {
    const member = matches[0];
    return { member, query: text.slice(0, -member.display_name.length).trim(), implicit: false };
  }

  const misplaced = registered.find((member) => appearsAsSeparateName(text, member.display_name));
  if (misplaced) {
    throw new Error(`구성원 이름 '${misplaced.display_name}'은(는) 질문의 맨 뒤에 붙여 주세요. 예: '오늘 일정 ${misplaced.display_name}'`);
  }

  const tail = text.split(" ").at(-1) || "";
  const tailCompact = compactText(tail);
  const looksLikeQueryWord = TRAILING_REQUEST_WORDS.has(tailCompact)
    || ["오늘", "금일", "내일", "명일", "모레", "이번주", "다음주", "금주", "차주", "주간"].includes(tailCompact);
  if (looksLikeQueryWord && defaultMember) return { member: defaultMember, query: text, implicit: true };
  if (!looksLikeQueryWord && tail.length >= 2 && tail.length <= 40) {
    throw new Error(`등록된 구성원 '${tail}'을(를) 찾을 수 없습니다. 이름을 확인해 주세요.`);
  }
  throw new Error("조회할 구성원 이름을 질문의 맨 뒤에 붙여 주세요. 예: '오늘 일정 홍길동'");
}

function noticeText(notices) {
  if (!notices.length) return "게시된 반 공지가 없습니다.";
  return notices
    .map((notice) => `${notice.pinned ? "📌 " : "• "}${notice.title}\n${notice.body}`)
    .join("\n\n");
}

function helpText({ registered = false, displayName = "" } = {}) {
  const registration = registered
    ? `${displayName || "구성원"}님으로 등록되어 있어요. 이제 명령 뒤에 이름을 붙이지 않아도 됩니다.`
    : "관리자에게 받은 1회용 초대 코드로 ‘가입 ABCD-EFGH’처럼 입력해 주세요.";
  return [
    "Quilo schedule 사용법",
    registration,
    "",
    "자주 쓰는 기능",
    "• 오늘 브리핑 / 오늘 일정 / 시간표 전체",
    "• 7월 20일 수학 수행평가 추가",
    "• 방금 일정 완료 / 수학 수행평가 22일로 변경",
    "• 공지 / 파일 리스트 / 최근 올라온 파일",
    "• 수학 자료 / 김종수T 학습지 / 영어 PDF",
    "• 알림 설정",
    "",
    "일정 변경은 확인 후 적용됩니다. 다른 구성원의 반 전체 일정은 질문 맨 뒤에 정확한 이름을 붙여 조회할 수 있어요.",
  ].join("\n");
}

function helpQuickReplies(registered = false) {
  if (registered) return registeredQuickReplies();
  return ["도움말", "공지", "오늘 일정", "시간표 전체", "파일 리스트"]
    .map((messageText) => ({ label: messageText, action: "message", messageText }));
}

function eventKind(intent) {
  if (intent === "assessment") return { label: "수행평가", category: "assessment", empty: "등록된 수행평가가 없습니다." };
  if (intent === "assignment") return { label: "과제", category: "assignment", empty: "등록된 과제가 없습니다." };
  if (intent === "study-summary") {
    return {
      label: "수행평가·과제 통합 요약",
      categories: new Set(["assessment", "assignment"]),
      empty: "등록된 수행평가나 과제가 없습니다.",
    };
  }
  return { label: "일정", category: null, empty: "등록된 일정이 없습니다." };
}

function monthBounds(date) {
  const { year, month } = getSeoulParts(date);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+09:00`);
  const next = new Date(`${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00+09:00`);
  return { start, end: new Date(next.getTime() - 1), label: `${year}년 ${month}월` };
}

function availableFiles(items, memberId) {
  return (Array.isArray(items) ? items : [])
    .filter((file) => file?.member_id == null || file.member_id === memberId)
    .filter((file) => String(file.status || "").toLowerCase() === "active")
    .sort((a, b) => String(a.alias || a.filename || "").localeCompare(String(b.alias || b.filename || ""), "ko"));
}

function isImageFile(file) {
  return String(file.mime_type || "").toLowerCase().startsWith("image/");
}

function isPdfFile(file) {
  return String(file.mime_type || "").toLowerCase() === "application/pdf"
    || String(file.filename || "").toLowerCase().endsWith(".pdf");
}

function fileSizeLabel(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fileListText(files, displayName) {
  if (!files.length) return `${displayName}님이 조회할 수 있는 자료가 없습니다.`;
  const rows = files.map((file) => {
    const type = isImageFile(file) ? "이미지" : isPdfFile(file) ? "PDF" : "파일";
    const scope = file.member_id == null ? "반 전체" : "개인";
    const detail = [file.description, file.filename, fileSizeLabel(file.size_bytes)].filter(Boolean).join(" · ");
    return `• [${scope} ${type}] ${file.alias || file.filename}${detail ? `\n  ${detail}` : ""}`;
  });
  return `${displayName}님의 자료 목록\n\n${rows.join("\n")}`;
}

function fileMatchesType(file, requestedType) {
  return requestedType === "file"
    || (requestedType === "pdf" && isPdfFile(file))
    || (requestedType === "image" && isImageFile(file));
}

function fileLookupKeys(file) {
  return [...new Set([file.alias, file.filename].map(compactFileText).filter(Boolean))];
}

function bigrams(value) {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

function similarityScore(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  if (candidate.includes(query) || query.includes(candidate)) {
    return 0.62 + (Math.min(query.length, candidate.length) / Math.max(query.length, candidate.length)) * 0.3;
  }
  const left = bigrams(query);
  const right = bigrams(candidate);
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return left.size + right.size ? (2 * overlap) / (left.size + right.size) : 0;
}

function rankFileCandidates(files, query, requestedType) {
  const compactQuery = compactFileText(query);
  return files
    .filter((file) => fileMatchesType(file, requestedType))
    .map((file) => ({
      file,
      score: Math.max(0, ...fileLookupKeys(file).map((key) => similarityScore(compactQuery, key))),
    }))
    .filter((item) => item.score >= 0.34)
    .sort((a, b) => b.score - a.score || String(a.file.alias || a.file.filename).localeCompare(String(b.file.alias || b.file.filename), "ko"))
    .slice(0, 3);
}

async function respondWithFile({ file, makeFileUrl, replies }) {
  if (typeof makeFileUrl !== "function") {
    return simpleTextResponse("현재 자료 열기 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", replies);
  }
  let url;
  try {
    url = await makeFileUrl(file);
  } catch {
    return simpleTextResponse("현재 자료 열기 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", replies);
  }
  const title = file.alias || file.filename || "Quilo 자료";
  if (isImageFile(file) && file.member_id == null) {
    try {
      return simpleImageResponse({ imageUrl: url, altText: `${title} 이미지` }, replies);
    } catch {
      return simpleTextResponse("현재 자료 열기 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", replies);
    }
  }
  try {
    return textCardResponse({
      title,
      description: [file.description, file.filename, fileSizeLabel(file.size_bytes)].filter(Boolean).join("\n"),
      url,
      buttonLabel: isPdfFile(file) ? "PDF 열기" : "파일 열기",
    }, replies);
  } catch {
    return simpleTextResponse("현재 자료 열기 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", replies);
  }
}

function candidateQuickReplies(candidates) {
  return [
    { label: "맞아요", action: "message", messageText: "맞아요" },
    ...candidates.map(({ file }, index) => {
      const name = String(file.alias || file.filename || `후보 ${index + 1}`);
      return { label: `${index + 1}. ${name}`.slice(0, 14), action: "message", messageText: `${index + 1}번` };
    }),
    { label: "파일 리스트", action: "message", messageText: "파일 리스트" },
  ];
}

async function rememberFileCandidates(store, requester, candidates) {
  if (typeof store.setPendingFileSelection !== "function") return;
  if (typeof store.clearPendingKakaoAction === "function") {
    await store.clearPendingKakaoAction(requester.id);
  }
  await store.setPendingFileSelection({
    memberId: requester.id,
    fileIds: candidates.map(({ file }) => file.id),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
}

async function answerFileQuery({ command, requester, store, makeFileUrl, quickReplies, allowRaw = false }) {
  const replies = quickReplies || registeredQuickReplies();
  if (typeof store.listFiles !== "function") {
    return simpleTextResponse("현재 자료 조회 기능을 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.", replies);
  }
  const browseSpec = readFileBrowseSpec(command, { allowRaw });
  const baseSpec = readFileCommand(command, { allowRaw });
  const spec = browseSpec
    ? { kind: "open", requestedType: browseSpec.requestedType, alias: browseSpec.query }
    : baseSpec;
  if (!spec) return allowRaw ? null : simpleTextResponse("‘파일 리스트’ 또는 ‘파일 별칭’처럼 입력해 주세요.", replies);

  const files = availableFiles(await store.listFiles({ targetMemberId: requester.id }), requester.id);
  if (spec.kind === "list") return simpleTextResponse(fileListText(files, requester.display_name), replies);

  const query = compactFileText(spec.alias);
  const exactMatches = files.filter((file) => (
    fileMatchesType(file, spec.requestedType) && fileLookupKeys(file).includes(query)
  ));
  if (exactMatches.length === 1) {
    if (typeof store.clearPendingFileSelection === "function") await store.clearPendingFileSelection(requester.id);
    return respondWithFile({ file: exactMatches[0], makeFileUrl, replies });
  }
  const browseCandidates = browseSpec ? rankBrowseFileCandidates(files, browseSpec) : [];
  if (browseCandidates.length === 1) {
    if (typeof store.clearPendingFileSelection === "function") await store.clearPendingFileSelection(requester.id);
    return respondWithFile({ file: browseCandidates[0].file, makeFileUrl, replies });
  }
  const candidates = browseCandidates.length > 1
    ? browseCandidates
    : rankFileCandidates(files, spec.alias, spec.requestedType);
  if (!candidates.length) {
    return allowRaw && !browseSpec?.explicit
      ? null
      : simpleTextResponse("요청한 자료를 찾을 수 없습니다. ‘파일 리스트’에서 파일명이나 별칭을 확인해 주세요.", replies);
  }
  await rememberFileCandidates(store, requester, candidates);
  const names = candidates.map(({ file }, index) => `${index + 1}. ${file.alias || file.filename}`).join("\n");
  return simpleTextResponse(
    `혹시 ‘${candidates[0].file.alias || candidates[0].file.filename}’ 파일이 맞나요?\n\n비슷한 후보\n${names}\n\n맞으면 ‘맞아’, 아니면 아래 후보나 ‘파일 리스트’를 눌러 주세요.`,
    candidateQuickReplies(candidates),
  );
}

const FILE_CONFIRM_YES = new Set(["맞아", "맞아요", "맞습니다", "네", "넵", "예", "응", "ㅇㅇ"]);
const FILE_CONFIRM_NO = new Set(["아니", "아니야", "아니요", "ㄴㄴ"]);

async function answerPendingFileConfirmation({ command, requester, store, makeFileUrl }) {
  const normalized = compactText(command);
  const ordinal = normalized.match(/^([123])(?:번|번째)?$/)?.[1];
  if (!FILE_CONFIRM_YES.has(normalized) && !FILE_CONFIRM_NO.has(normalized) && !ordinal) return null;
  if (typeof store.getPendingFileSelection !== "function") return null;
  const pending = await store.getPendingFileSelection(requester.id);
  if (!pending?.file_ids?.length) return null;
  if (FILE_CONFIRM_NO.has(normalized)) {
    if (typeof store.clearPendingFileSelection === "function") await store.clearPendingFileSelection(requester.id);
    return simpleTextResponse("알겠습니다. ‘파일 리스트’를 눌러 정확한 파일명이나 별칭을 확인해 주세요.", registeredQuickReplies());
  }
  const selectedId = pending.file_ids[ordinal ? Number(ordinal) - 1 : 0];
  const files = availableFiles(await store.listFiles({ targetMemberId: requester.id }), requester.id);
  const file = files.find((item) => item.id === selectedId);
  if (typeof store.clearPendingFileSelection === "function") await store.clearPendingFileSelection(requester.id);
  if (!file) return simpleTextResponse("후보 파일이 만료되었거나 더 이상 사용할 수 없습니다. ‘파일 리스트’를 다시 확인해 주세요.", registeredQuickReplies());
  return respondWithFile({ file, makeFileUrl, replies: registeredQuickReplies() });
}

async function answerReadQuery({ command, intent, member, store, now, quickReplies, privateAccess = false }) {
  const period = readPeriod(command, intent);
  const replies = quickReplies || personalizedQuickReplies(member.display_name);
  const targetMemberId = privateAccess ? member.id : undefined;

  if (intent === "timetable") {
    if (period.kind === "full-timetable") {
      const bundle = await getWeekTimetable(store, now, { targetMemberId });
      return simpleTextResponse(
        `${member.display_name}님의 월~금 전체 시간표\n\n${formatWeekTimetable(bundle)}`,
        replies,
      );
    }
    if (period.kind === "week") {
      const bundle = await getWeekTimetable(store, now, { weekOffset: period.offset, targetMemberId });
      return simpleTextResponse(
        `${member.display_name}님의 ${period.label} 시간표\n\n${formatWeekTimetable(bundle)}`,
        replies,
      );
    }
    const target = dateForSeoulOffset(now, period.offset);
    const bundle = await getDaySchedule(store, target, { targetMemberId });
    return simpleTextResponse(
      `${member.display_name}님의 ${formatKoreanDate(target)} 시간표\n\n${formatTimetableRows(bundle.timetable)}`,
      replies,
    );
  }

  let events;
  let rangeLabel;
  if (period.kind === "day") {
    const target = dateForSeoulOffset(now, period.offset);
    events = (await getDaySchedule(store, target, { targetMemberId })).events;
    rangeLabel = formatKoreanDate(target);
  } else if (period.kind === "week") {
    events = await getWeekEvents(store, now, { weekOffset: period.offset, targetMemberId });
    rangeLabel = period.label;
  } else if (period.kind === "remaining-week") {
    events = (await getWeekEvents(store, now, { targetMemberId }))
      .filter((event) => new Date(event.due_at).getTime() >= now.getTime());
    rangeLabel = period.label;
  } else if (period.kind === "month") {
    const bounds = monthBounds(now);
    events = await store.listEvents({
      from: bounds.start.toISOString(),
      to: bounds.end.toISOString(),
      status: "scheduled",
      targetMemberId,
    });
    rangeLabel = bounds.label;
  } else if (period.kind === "next") {
    events = await store.listEvents({
      from: now.toISOString(),
      status: "scheduled",
      targetMemberId,
    });
    events = events.slice(0, 1);
    rangeLabel = period.label;
  } else {
    events = await getUpcomingEvents(store, now, period.days, { targetMemberId });
    rangeLabel = `앞으로 ${period.days}일`;
  }

  if (!privateAccess) events = events.filter((event) => event.member_id == null);
  const kind = eventKind(intent);
  if (kind.category) events = events.filter((event) => event.category === kind.category);
  if (kind.categories) events = events.filter((event) => kind.categories.has(event.category));
  return simpleTextResponse(
    `${member.display_name}님의 ${rangeLabel} ${kind.label}\n\n${formatEventRows(events, now, kind.empty)}`,
    replies,
  );
}

export async function handleKakaoCommand({ payload, store, now = new Date(), makeFileUrl }) {
  const command = extractCommand(payload);
  const normalized = compactText(command);
  const user = extractKakaoUser(payload);
  let targetDisplayName = "";
  let targetQuickReplies;
  let requesterLoaded = false;
  let requesterMember = null;
  const getRequester = async () => {
    if (!requesterLoaded) {
      requesterLoaded = true;
      requesterMember = user ? await store.findMemberByUserKey(user.id) : null;
    }
    return requesterMember;
  };

  try {
    const registrationName = readNameRegistration(payload, command);
    if (registrationName !== null) {
      return simpleTextResponse(
        "이름만으로는 본인 확인을 할 수 없어 ‘이름 등록’은 지원하지 않습니다. 관리자에게 받은 1회용 초대 코드로 ‘가입 ABCD-EFGH’처럼 입력해 주세요.",
        helpQuickReplies(),
      );
    }

    if (/^(가입|초대)/.test(command)) {
      const code = extractInviteCode(payload, command);
      if (!user) return simpleTextResponse("카카오 사용자 식별값을 확인할 수 없어 가입할 수 없습니다.");
      if (!code) return simpleTextResponse("가입에는 관리자에게 받은 1회용 초대 코드가 필요합니다. 예: ‘가입 ABCD-EFGH’", helpQuickReplies());
      const member = await store.claimInvite({ code, userKey: user.id, userKeyType: user.type });
      const isFriend = String(payload.userRequest?.user?.properties?.isFriend ?? "").toLowerCase();
      const friendGuide = isFriend === "false" ? "\n알림을 받으려면 이 카카오톡 채널을 친구 추가해 주세요." : "";
      return simpleTextResponse(
        `${member.display_name}님, 초대 코드 확인과 2학년 4반 가입이 완료되었습니다.\n이제 ‘오늘 일정’처럼 이름 없이 물어볼 수 있어요. 알림 설정에서 수신 여부도 바꿀 수 있습니다.${friendGuide}`,
        registeredQuickReplies(),
      );
    }

    if (!normalized || new Set(["시작", "처음", "도움말", "사용법", "안녕", "안녕하세요", "뭐할수있어", "뭘할수있어"]).has(normalized)) {
      const requester = await getRequester();
      const registered = requester?.status === "active";
      return simpleTextResponse(
        helpText({ registered, displayName: requester?.display_name }),
        helpQuickReplies(registered),
      );
    }

    const confirmingRequester = await getRequester();
    if (confirmingRequester?.status === "active") {
      const eventConfirmation = await answerPendingEventMutation({
        command,
        member: confirmingRequester,
        store,
      });
      if (eventConfirmation) return eventConfirmation;
      const confirmation = await answerPendingFileConfirmation({
        command,
        requester: confirmingRequester,
        store,
        makeFileUrl,
      });
      if (confirmation) return confirmation;
    }

    if (isTodayBriefingCommand(command)) {
      if (!confirmingRequester || confirmingRequester.status !== "active") {
        return simpleTextResponse("오늘 브리핑은 2학년 4반 구성원만 볼 수 있습니다. 관리자에게 받은 초대 코드로 먼저 가입해 주세요.", helpQuickReplies());
      }
      return simpleTextResponse(
        await buildTodayBriefing({ store, member: confirmingRequester, now }),
        registeredQuickReplies(),
      );
    }

    const mutationResponse = await answerEventMutation({
      command,
      member: confirmingRequester,
      store,
      now,
    });
    if (mutationResponse) return mutationResponse;

    if (looksLikeFileCommand(command)) {
      const requester = await getRequester();
      const text = normalizedText(command);
      const requesterName = normalizedText(requester?.display_name);
      if (!requester || requester.status !== "active" || !requesterName) {
        return simpleTextResponse("자료를 조회할 권한이 없습니다. 관리자에게 받은 초대 코드로 먼저 가입해 주세요.", helpQuickReplies());
      }
      const registered = (await store.listMembers()).filter((member) => member.status !== "left");
      const trailingMatches = registered.filter((member) => {
        const name = normalizedText(member.display_name);
        return name && (text === name || text.endsWith(` ${name}`));
      });
      if (trailingMatches.some((member) => member.id !== requester.id)) {
        return simpleTextResponse("자료를 조회할 권한이 없습니다. 자료는 가입된 본인만 조회할 수 있습니다.");
      }
      const explicitSelf = trailingMatches.some((member) => member.id === requester.id);
      targetDisplayName = requesterName;
      targetQuickReplies = explicitSelf ? personalizedQuickReplies(requesterName) : registeredQuickReplies();
      const query = explicitSelf ? text.slice(0, -requesterName.length).trim() : text;
      return await answerFileQuery({ command: query, requester, store, makeFileUrl, quickReplies: targetQuickReplies });
    }

    const intent = readIntent(command);
    if (intent) {
      const requester = await getRequester();
      const defaultMember = requester?.status === "active" ? requester : null;
      const target = resolveTargetMember(command, await store.listMembers(), { defaultMember });
      targetDisplayName = target.member.display_name;
      const targetIntent = readIntent(target.query);
      if (!targetIntent) throw new Error("조회할 일정 종류가 필요합니다. 예: '오늘 일정 홍길동'");
      targetQuickReplies = target.implicit ? registeredQuickReplies() : personalizedQuickReplies(target.member.display_name);
      return await answerReadQuery({
        command: target.query,
        intent: targetIntent,
        member: target.member,
        store,
        now,
        quickReplies: targetQuickReplies,
        privateAccess: Boolean(requester && requester.id === target.member.id),
      });
    }

    const member = await getRequester();
    const requiresMembership = normalized.includes("알림") || normalized.includes("공지");
    if (requiresMembership && !member) {
      return simpleTextResponse("2학년 4반 구성원만 조회할 수 있습니다. 관리자에게 받은 초대 코드로 먼저 가입해 주세요.", helpQuickReplies());
    }

    const memberReplies = member ? registeredQuickReplies() : undefined;
    if (normalized.includes("알림")) {
      if (normalized.includes("아침알림끄기")) {
        await store.updateMember(member.id, { daily_digest_enabled: false }, member.id);
        return simpleTextResponse("평일 아침 시간표 알림을 껐습니다. 수행평가와 공지 알림은 계속 받을 수 있어요.", memberReplies);
      }
      if (normalized.includes("아침알림켜기")) {
        await store.updateMember(member.id, { daily_digest_enabled: true }, member.id);
        return simpleTextResponse("평일 아침 시간표 알림을 켰습니다.", memberReplies);
      }
      if (normalized.includes("끄기") || normalized.includes("해제") || normalized.includes("거부")) {
        await store.updateMember(member.id, { notification_enabled: false }, member.id);
        return simpleTextResponse("모든 카카오 알림을 껐습니다. 시간표와 일정 조회는 계속 사용할 수 있어요.", memberReplies);
      }
      if (normalized.includes("켜기") || normalized.includes("신청") || normalized.includes("동의")) {
        await store.updateMember(member.id, { notification_enabled: true }, member.id);
        return simpleTextResponse("카카오 알림을 켰습니다.", memberReplies);
      }
      return simpleTextResponse(
        `${member.display_name}님의 알림\n전체 알림: ${member.notification_enabled ? "켜짐" : "꺼짐"}\n평일 아침 시간표: ${member.daily_digest_enabled ? "켜짐" : "꺼짐"}\n\n‘알림 켜기’, ‘알림 끄기’, ‘아침 알림 켜기’로 바꿀 수 있어요.`,
        memberReplies,
      );
    }

    if (normalized.includes("공지")) {
      const notices = await store.listNotices({ status: "published", limit: 5 });
      return simpleTextResponse(`2학년 4반 공지\n\n${noticeText(notices)}`, memberReplies);
    }

    if (member?.status === "active") {
      const fileResponse = await answerFileQuery({
        command,
        requester: member,
        store,
        makeFileUrl,
        quickReplies: registeredQuickReplies(),
        allowRaw: true,
      });
      if (fileResponse) return fileResponse;
    }

    return simpleTextResponse(
      helpText({ registered: member?.status === "active", displayName: member?.display_name }),
      helpQuickReplies(member?.status === "active"),
    );
  } catch (error) {
    const friendly = /초대 코드|이미 다른 구성원|이미 가입|이미 등록|다른 카카오|학급 정원|찾을 수 없습니다|명단|정확|필요합니다|구성원 이름|등록된 구성원|동명이인|맨 뒤|비활성|날짜|시간|일정 제목|본인 개인 일정|이미 삭제|이미 완료/.test(error.message)
      ? error.message
      : "잠시 후 다시 시도해 주세요.";
    const replies = targetQuickReplies || (targetDisplayName ? personalizedQuickReplies(targetDisplayName) : undefined);
    return simpleTextResponse(`요청을 처리하지 못했습니다. ${friendly}`, replies);
  }
}
