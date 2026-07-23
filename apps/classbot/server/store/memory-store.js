import crypto from "node:crypto";
import { getSeoulParts, parseKoreaDateTime, startOfSeoulDay } from "../time.js";
import { hashInviteCode } from "../security.js";

const clone = (value) => structuredClone(value);

function redactAuditData(value) {
  if (Array.isArray(value)) return value.map(redactAuditData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "kakao_user_key" || key === "quilo_user_id" || key === "code_hash" ? "[redacted]" : redactAuditData(item),
    ]),
  );
}

function nowIso() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function fileMetadata(file) {
  const { body: _body, ...metadata } = file;
  return clone(metadata);
}

function timetableDateKey(value = new Date()) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("올바른 시간표 적용 날짜를 입력해 주세요.");
    return getSeoulParts(value).dateKey;
  }
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00+09:00`);
    if (!Number.isNaN(parsed.getTime()) && getSeoulParts(parsed).dateKey === raw) return raw;
    throw new Error("올바른 시간표 적용 날짜를 입력해 주세요.");
  }
  const parsed = new Date(raw);
  if (raw && !Number.isNaN(parsed.getTime())) return getSeoulParts(parsed).dateKey;
  throw new Error("올바른 시간표 적용 날짜를 입력해 주세요.");
}

function normalizeMemberTimetableRows(rows) {
  if (!Array.isArray(rows)) throw new Error("개인 시간표 데이터는 배열이어야 합니다.");
  const seen = new Set();
  return rows
    .filter((row) => String(row?.subject || "").trim())
    .map((row) => {
      const weekday = Number(row.weekday);
      const period = Number(row.period);
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 5) throw new Error("요일은 월요일부터 금요일까지만 선택할 수 있습니다.");
      if (!Number.isInteger(period) || period < 1 || period > 12) throw new Error("교시는 1부터 12 사이여야 합니다.");
      const effectiveFrom = timetableDateKey(row.effective_from || new Date());
      const effectiveTo = row.effective_to ? timetableDateKey(row.effective_to) : null;
      if (effectiveTo && effectiveTo < effectiveFrom) throw new Error("시간표 종료일은 시작일보다 빠를 수 없습니다.");
      const normalized = {
        weekday,
        period,
        subject: String(row.subject).trim(),
        activity: String(row.activity || "").trim(),
        teacher: String(row.teacher || "").trim(),
        room: String(row.room || "").trim(),
        memo: String(row.memo || "").trim(),
        effective_from: effectiveFrom,
        effective_to: effectiveTo,
      };
      const limits = { subject: 100, activity: 300, teacher: 100, room: 100, memo: 500 };
      for (const [key, limit] of Object.entries(limits)) {
        if (normalized[key].length > limit) throw new Error(`시간표 ${key} 값이 너무 깁니다.`);
      }
      const slot = `${weekday}:${period}:${effectiveFrom}`;
      if (seen.has(slot)) throw new Error("같은 적용일의 동일 교시를 두 번 등록할 수 없습니다.");
      seen.add(slot);
      return normalized;
    });
}

function activeTimetableRows(rows, dateKey) {
  const latestBySlot = new Map();
  for (const row of rows
    .filter((item) => item.effective_from <= dateKey && (!item.effective_to || item.effective_to >= dateKey))
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from))) {
    const slot = `${row.weekday}:${row.period}`;
    if (!latestBySlot.has(slot)) latestBySlot.set(slot, row);
  }
  return [...latestBySlot.values()].sort((a, b) => a.weekday - b.weekday || a.period - b.period);
}

function seedTimetable(classId) {
  const subjects = {
    1: [
      ["수학", "미분의 활용"],
      ["영어", "Presentation Practice"],
      ["물리학", "등속도 운동"],
      ["화학", "산화와 환원 반응"],
      ["국어", "현대시 읽기"],
      ["정보", "알고리즘"],
      ["체육", "배드민턴"],
    ],
    2: [
      ["영어", "Reading"],
      ["수학", "적분"],
      ["화학", "화학 평형"],
      ["물리학", "운동량"],
      ["국어", "토론"],
      ["한국사", "근대 사회"],
      ["창체", "학급 활동"],
    ],
    3: [
      ["물리학", "등속도 운동"],
      ["수학", "미분의 활용"],
      ["영어", "Presentation Practice"],
      ["화학", "산화와 환원 반응"],
      ["정보", "자료 구조"],
      ["국어", "문학 토론"],
      ["창체", "동아리"],
    ],
    4: [
      ["화학", "반응 속도"],
      ["물리학", "회전 운동"],
      ["수학", "정적분"],
      ["영어", "Speaking"],
      ["한국사", "개항기"],
      ["체육", "농구"],
      ["국어", "논증"],
    ],
    5: [
      ["국어", "비문학"],
      ["정보", "탐색"],
      ["수학", "수열"],
      ["물리학", "전자기"],
      ["화학", "전기화학"],
      ["영어", "Writing"],
      ["창체", "자율 활동"],
    ],
  };
  return Object.entries(subjects).flatMap(([weekday, rows]) =>
    rows.map(([subject, activity], index) => ({
      id: id("tt"),
      class_id: classId,
      weekday: Number(weekday),
      period: index + 1,
      subject,
      activity,
      teacher: "",
      room: "",
      memo: index === 0 && Number(weekday) === 3 ? "실험 도구 준비" : "",
      effective_from: "2026-03-01",
      effective_to: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    })),
  );
}

function seedEvents(classId) {
  const start = startOfSeoulDay(new Date());
  const at = (days, hour = 23, minute = 59) =>
    new Date(start.getTime() + days * 86_400_000 + hour * 3_600_000 + minute * 60_000).toISOString();
  return [
    {
      id: id("event"),
      class_id: classId,
      member_id: null,
      category: "assessment",
      subject: "화학",
      title: "화학 실험 보고서",
      description: "실험 결과와 오차 분석을 포함해 제출",
      due_at: at(1),
      status: "scheduled",
      reminder_offsets: [4320, 1440, 0],
      notify_on_change: true,
      created_by: "demo-admin",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    {
      id: id("event"),
      class_id: classId,
      member_id: null,
      category: "assessment",
      subject: "영어",
      title: "영어 발표",
      description: "3분 개인 발표",
      due_at: at(3, 9, 0),
      status: "scheduled",
      reminder_offsets: [4320, 1440, 0],
      notify_on_change: true,
      created_by: "demo-admin",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
    {
      id: id("event"),
      class_id: classId,
      member_id: null,
      category: "assignment",
      subject: "수학",
      title: "수학 탐구 과제",
      description: "탐구 주제 개요 제출",
      due_at: at(7),
      status: "scheduled",
      reminder_offsets: [10080, 4320, 1440],
      notify_on_change: true,
      created_by: "demo-admin",
      created_at: nowIso(),
      updated_at: nowIso(),
    },
  ];
}

export class MemoryStore {
  constructor(config) {
    const classId = "class_2_4";
    this.classroom = {
      id: classId,
      code: config.classCode,
      name: config.className,
      timezone: config.timezone,
      daily_digest_time: "07:00",
      daily_digest_enabled: true,
      max_members: 16,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    this.members = Array.from({ length: 13 }, (_, index) => ({
      id: id("member"),
      class_id: classId,
      display_name: `학생 ${index + 1}`,
      role: index < 2 ? "admin" : "student",
      quilo_user_id: null,
      kakao_user_key: null,
      kakao_user_key_type: "botUserKey",
      notification_enabled: true,
      daily_digest_enabled: true,
      status: "invited",
      joined_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }));
    this.invites = [];
    this.timetable = seedTimetable(classId);
    this.memberTimetable = [];
    this.events = seedEvents(classId);
    this.notices = [
      {
        id: id("notice"),
        class_id: classId,
        title: "2학년 4반 일정 알림을 시작합니다",
        body: "시간표와 수행평가 일정을 챗봇에서 확인할 수 있습니다.",
        status: "published",
        pinned: true,
        notify_on_publish: false,
        request_key: "demo-welcome-notice",
        created_by: "demo-admin",
        published_at: nowIso(),
        created_at: nowIso(),
        updated_at: nowIso(),
      },
    ];
    this.notifications = [];
    this.auditLogs = [];
    this.files = [];
    this.fileBodies = new Map();
    this.kakaoStates = new Map();
    this.kakaoActionStates = new Map();
  }

  async healthCheck() {
    return { ok: true, storage: "memory" };
  }

  async getClassroom() {
    return clone(this.classroom);
  }

  async updateSettings(patch, actor = "admin") {
    const allowed = ["daily_digest_time", "daily_digest_enabled", "name"];
    for (const key of allowed) {
      if (patch[key] !== undefined) this.classroom[key] = patch[key];
    }
    this.classroom.updated_at = nowIso();
    await this.appendAudit({ actor, action: "settings.update", entityType: "classroom", entityId: this.classroom.id, after: this.classroom });
    return clone(this.classroom);
  }

  async listMembers() {
    return clone(this.members).sort((a, b) => a.display_name.localeCompare(b.display_name, "ko"));
  }

  async getMember(memberId) {
    const member = this.members.find((item) => item.id === memberId);
    return member ? clone(member) : null;
  }

  async findMemberByQuiloUserId(userId) {
    const normalized = String(userId || "").trim();
    const member = this.members.find((item) => item.quilo_user_id === normalized);
    return member ? clone(member) : null;
  }

  async createMember(input, actor = "admin") {
    if (this.members.filter((member) => member.status !== "left").length >= this.classroom.max_members) throw new Error("학급 정원 16명을 초과할 수 없습니다.");
    const member = {
      id: id("member"),
      class_id: this.classroom.id,
      display_name: String(input.display_name || "").trim(),
      role: input.role === "admin" ? "admin" : "student",
      quilo_user_id: null,
      kakao_user_key: null,
      kakao_user_key_type: "botUserKey",
      notification_enabled: true,
      daily_digest_enabled: true,
      status: "invited",
      joined_at: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!member.display_name) throw new Error("구성원 이름을 입력해 주세요.");
    this.members.push(member);
    await this.appendAudit({ actor, action: "member.create", entityType: "member", entityId: member.id, after: member });
    return clone(member);
  }

  async seedMembersIfEmpty(items, actor = "admin") {
    if (this.members.length) return 0;
    const now = nowIso();
    this.members = items.map((item) => ({
      id: id("member"),
      class_id: this.classroom.id,
      display_name: String(item.display_name || "").trim(),
      role: item.role === "admin" ? "admin" : "student",
      quilo_user_id: null,
      kakao_user_key: null,
      kakao_user_key_type: "botUserKey",
      notification_enabled: true,
      daily_digest_enabled: true,
      status: "invited",
      joined_at: null,
      created_at: now,
      updated_at: now,
    }));
    await this.appendAudit({
      actor,
      action: "member.seed",
      entityType: "member",
      entityId: "initial-roster",
      after: { count: this.members.length },
    });
    return this.members.length;
  }

  async updateMember(memberId, patch, actor = "admin") {
    const member = this.members.find((item) => item.id === memberId);
    if (!member) throw new Error("구성원을 찾을 수 없습니다.");
    const before = clone(member);
    for (const key of ["display_name", "role", "notification_enabled", "daily_digest_enabled", "status"]) {
      if (patch[key] !== undefined) member[key] = patch[key];
    }
    member.updated_at = nowIso();
    await this.appendAudit({ actor, action: "member.update", entityType: "member", entityId: member.id, before, after: member });
    return clone(member);
  }

  async createInvite({ memberId, codeHash, expiresAt }, actor = "admin") {
    const member = this.members.find((item) => item.id === memberId);
    if (!member) throw new Error("초대할 구성원을 찾을 수 없습니다.");
    if (member.status === "active") throw new Error("이미 가입한 구성원에게 초대 코드를 만들 수 없습니다.");
    const now = nowIso();
    for (const previous of this.invites) {
      if (previous.member_id === memberId && (!previous.used_at || !previous.portal_used_at)) {
        previous.used_at = previous.used_at || now;
        previous.portal_used_at = previous.portal_used_at || now;
      }
    }
    const invite = {
      id: id("invite"),
      class_id: this.classroom.id,
      member_id: memberId,
      code_hash: codeHash,
      expires_at: expiresAt,
      used_at: null,
      portal_used_at: null,
      created_at: nowIso(),
    };
    this.invites.push(invite);
    await this.appendAudit({ actor, action: "invite.create", entityType: "invite", entityId: invite.id, after: { ...invite, code_hash: "[redacted]" } });
    return clone(invite);
  }

  async claimInvite({ code, userKey, userKeyType = "botUserKey" }) {
    const codeHash = hashInviteCode(code);
    const invite = this.invites.find((item) => item.code_hash === codeHash && !item.used_at);
    if (!invite || new Date(invite.expires_at) < new Date()) throw new Error("초대 코드가 올바르지 않거나 만료되었습니다.");
    const duplicate = this.members.find((item) => item.kakao_user_key === userKey);
    if (duplicate && duplicate.id !== invite.member_id) throw new Error("이미 다른 구성원으로 가입된 카카오 계정입니다.");
    const member = this.members.find((item) => item.id === invite.member_id);
    if (!member) throw new Error("초대 대상 구성원을 찾을 수 없습니다.");
    member.kakao_user_key = userKey;
    member.kakao_user_key_type = userKeyType;
    member.status = "active";
    member.joined_at = nowIso();
    member.updated_at = nowIso();
    invite.used_at = nowIso();
    await this.appendAudit({ actor: member.id, action: "invite.claim", entityType: "member", entityId: member.id, after: { status: "active" } });
    return clone(member);
  }

  async claimQuiloInvite({ code, userId }) {
    const normalizedUserId = String(userId || "").trim();
    if (!/^[A-Za-z0-9_-]{8,300}$/.test(normalizedUserId)) throw new Error("Quilo 사용자 식별값이 올바르지 않습니다.");
    const codeHash = hashInviteCode(code);
    const invite = this.invites.find((item) => item.code_hash === codeHash && !item.portal_used_at);
    if (!invite || new Date(invite.expires_at) < new Date()) throw new Error("초대 코드가 올바르지 않거나 만료되었습니다.");
    const duplicate = this.members.find((item) => item.quilo_user_id === normalizedUserId);
    if (duplicate && duplicate.id !== invite.member_id) throw new Error("이미 다른 구성원에 연결된 Quilo 계정입니다.");
    const member = this.members.find((item) => item.id === invite.member_id && !["disabled", "left"].includes(item.status));
    if (!member) throw new Error("초대 대상 구성원을 찾을 수 없습니다.");
    member.quilo_user_id = normalizedUserId;
    member.status = "active";
    member.joined_at ||= nowIso();
    member.updated_at = nowIso();
    invite.portal_used_at = nowIso();
    await this.appendAudit({ actor: member.id, action: "member.quilo_claim", entityType: "member", entityId: member.id, after: { status: "active" } });
    return clone(member);
  }

  async claimPortalInvite({ memberId, code }) {
    const member = this.members.find((item) => item.id === memberId);
    const codeHash = hashInviteCode(code);
    const invite = this.invites.find((item) => (
      item.member_id === memberId
      && item.code_hash === codeHash
      && !item.portal_used_at
      && new Date(item.expires_at).getTime() > Date.now()
    ));
    if (!member || !invite) throw new Error("이름 또는 초대 코드를 확인할 수 없습니다.");
    invite.portal_used_at = nowIso();
    await this.appendAudit({
      actor: member.id,
      action: "portal.login",
      entityType: "invite",
      entityId: invite.id,
      after: { member_id: member.id, portal_used_at: invite.portal_used_at },
    });
    return clone(member);
  }

  async findMemberByUserKey(userKey) {
    const member = this.members.find((item) => item.kakao_user_key === userKey && item.status === "active");
    return member ? clone(member) : null;
  }

  async setPendingFileSelection({ memberId, fileIds, expiresAt }) {
    const member = this.members.find((item) => item.id === memberId && item.status === "active");
    const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))].slice(0, 3);
    const expires = new Date(expiresAt);
    if (!member) throw new Error("구성원을 찾을 수 없습니다.");
    if (!ids.length || Number.isNaN(expires.getTime())) throw new Error("파일 후보 상태가 올바르지 않습니다.");
    const state = { class_id: this.classroom.id, member_id: memberId, file_ids: ids, expires_at: expires.toISOString() };
    this.kakaoStates.set(memberId, state);
    return clone(state);
  }

  async getPendingFileSelection(memberId) {
    const state = this.kakaoStates.get(memberId);
    if (!state) return null;
    if (new Date(state.expires_at).getTime() <= Date.now()) {
      this.kakaoStates.delete(memberId);
      return null;
    }
    return clone(state);
  }

  async clearPendingFileSelection(memberId) {
    this.kakaoStates.delete(memberId);
  }

  async setPendingKakaoAction({ memberId, action, eventId = null, payload, expiresAt }) {
    const member = this.members.find((item) => item.id === memberId && item.status === "active");
    const expires = new Date(expiresAt);
    if (!member) throw new Error("구성원을 찾을 수 없습니다.");
    if (!["create", "update", "complete", "delete"].includes(action)) throw new Error("일정 변경 상태가 올바르지 않습니다.");
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Number.isNaN(expires.getTime())) {
      throw new Error("일정 변경 상태가 올바르지 않습니다.");
    }
    const state = {
      class_id: this.classroom.id,
      member_id: memberId,
      action,
      event_id: eventId || null,
      payload: clone(payload),
      expires_at: expires.toISOString(),
    };
    this.kakaoActionStates.set(memberId, state);
    return clone(state);
  }

  async getPendingKakaoAction(memberId) {
    const state = this.kakaoActionStates.get(memberId);
    if (!state) return null;
    if (new Date(state.expires_at).getTime() <= Date.now()) {
      this.kakaoActionStates.delete(memberId);
      return null;
    }
    return clone(state);
  }

  async clearPendingKakaoAction(memberId) {
    this.kakaoActionStates.delete(memberId);
  }

  async listTimetable({ weekday } = {}) {
    return clone(this.timetable)
      .filter((row) => weekday == null || row.weekday === Number(weekday))
      .sort((a, b) => a.weekday - b.weekday || a.period - b.period);
  }

  async listMemberTimetable(memberId, { weekday, date } = {}) {
    const member = this.members.find((item) => item.id === memberId && item.class_id === this.classroom.id && item.status !== "left");
    if (!member) throw new Error("개인 시간표를 조회할 구성원을 찾을 수 없습니다.");
    const dateKey = timetableDateKey(date || new Date());
    return clone(activeTimetableRows(
      this.memberTimetable.filter((row) => row.member_id === memberId && (weekday == null || row.weekday === Number(weekday))),
      dateKey,
    ));
  }

  async replaceMemberTimetable({ memberId, rows }, actor = "admin") {
    const member = this.members.find((item) => item.id === memberId && item.class_id === this.classroom.id && item.status !== "left");
    if (!member) throw new Error("개인 시간표를 등록할 구성원을 찾을 수 없습니다.");
    const savedAt = nowIso();
    const normalized = normalizeMemberTimetableRows(rows).map((row) => ({
      id: id("member_tt"),
      class_id: this.classroom.id,
      member_id: memberId,
      ...row,
      created_at: savedAt,
      updated_at: savedAt,
    }));
    this.memberTimetable = this.memberTimetable.filter((row) => row.member_id !== memberId).concat(normalized);
    await this.appendAudit({
      actor,
      action: "member_timetable.replace",
      entityType: "member_timetable",
      entityId: memberId,
      after: { member_id: memberId, row_count: normalized.length },
    });
    return clone(normalized).sort((a, b) => a.weekday - b.weekday || a.period - b.period);
  }

  async replaceTimetableDay({ weekday, rows }, actor = "admin") {
    const numericWeekday = Number(weekday);
    if (!Number.isInteger(numericWeekday) || numericWeekday < 1 || numericWeekday > 5) throw new Error("요일은 월요일부터 금요일까지만 선택할 수 있습니다.");
    const normalized = rows
      .filter((row) => String(row.subject || "").trim())
      .map((row, index) => ({
        id: id("tt"),
        class_id: this.classroom.id,
        weekday: numericWeekday,
        period: Number(row.period || index + 1),
        subject: String(row.subject).trim(),
        activity: String(row.activity || "").trim(),
        teacher: String(row.teacher || "").trim(),
        room: String(row.room || "").trim(),
        memo: String(row.memo || "").trim(),
        effective_from: row.effective_from || getSeoulParts(new Date()).dateKey,
        effective_to: row.effective_to || null,
        created_at: nowIso(),
        updated_at: nowIso(),
      }));
    this.timetable = this.timetable.filter((row) => row.weekday !== numericWeekday).concat(normalized);
    await this.appendAudit({ actor, action: "timetable.replace", entityType: "timetable", entityId: String(numericWeekday), after: normalized });
    return clone(normalized);
  }

  async listEvents({ from, to, status, targetMemberId } = {}) {
    const start = from ? new Date(from).getTime() : -Infinity;
    const end = to ? new Date(to).getTime() : Infinity;
    return clone(this.events)
      .filter((event) => {
        const due = new Date(event.due_at).getTime();
        const visibleToTarget = targetMemberId === undefined || event.member_id == null || event.member_id === targetMemberId;
        return due >= start && due <= end && (!status || event.status === status) && visibleToTarget;
      })
      .sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  }

  async getEvent(eventId) {
    const event = this.events.find((item) => item.id === eventId);
    return event ? clone(event) : null;
  }

  async createEvent(input, actor = "admin") {
    if (input.request_key) {
      const existing = this.events.find((item) => item.request_key === input.request_key);
      if (existing) return clone(existing);
    }
    const dueAt = parseKoreaDateTime(input.due_at);
    if (input.member_id) {
      const member = this.members.find((item) => item.id === input.member_id && item.status !== "left");
      if (!member) throw new Error("개인 일정을 등록할 구성원을 찾을 수 없습니다.");
    }
    const event = {
      id: id("event"),
      class_id: this.classroom.id,
      member_id: input.member_id || null,
      category: input.category || "assessment",
      subject: String(input.subject || "").trim(),
      title: String(input.title || "").trim(),
      description: String(input.description || "").trim(),
      due_at: dueAt.toISOString(),
      status: "scheduled",
      reminder_offsets: Array.isArray(input.reminder_offsets) ? input.reminder_offsets.map(Number) : [4320, 1440, 0],
      notify_on_change: input.notify_on_change !== false,
      request_key: input.request_key || null,
      created_by: actor,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!event.title) throw new Error("일정 제목을 입력해 주세요.");
    this.events.push(event);
    await this.appendAudit({ actor, action: "event.create", entityType: "event", entityId: event.id, after: event });
    return clone(event);
  }

  async updateEvent(eventId, patch, actor = "admin") {
    const event = this.events.find((item) => item.id === eventId);
    if (!event) throw new Error("일정을 찾을 수 없습니다.");
    const before = clone(event);
    if (patch.member_id) {
      const member = this.members.find((item) => item.id === patch.member_id && item.status !== "left");
      if (!member) throw new Error("개인 일정을 등록할 구성원을 찾을 수 없습니다.");
    }
    for (const key of ["member_id", "category", "subject", "title", "description", "status", "notify_on_change"]) {
      if (patch[key] !== undefined) event[key] = patch[key];
    }
    if (patch.due_at !== undefined) event.due_at = parseKoreaDateTime(patch.due_at).toISOString();
    if (patch.reminder_offsets !== undefined) event.reminder_offsets = patch.reminder_offsets.map(Number);
    event.updated_at = nowIso();
    await this.appendAudit({ actor, action: "event.update", entityType: "event", entityId: event.id, before, after: event });
    return clone(event);
  }

  async cancelEvent(eventId, actor = "admin") {
    return this.updateEvent(eventId, { status: "cancelled" }, actor);
  }

  async listNotices({ status, limit = 50 } = {}) {
    return clone(this.notices)
      .filter((notice) => !status || notice.status === status)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at))
      .slice(0, Number(limit) || 50);
  }

  async getNotice(noticeId) {
    const notice = this.notices.find((item) => item.id === noticeId);
    return notice ? clone(notice) : null;
  }

  async createNotice(input, actor = "admin") {
    if (input.request_key) {
      const existing = this.notices.find((item) => item.request_key === input.request_key);
      if (existing) return clone(existing);
    }
    const status = input.status === "published" ? "published" : "draft";
    const notice = {
      id: id("notice"),
      class_id: this.classroom.id,
      title: String(input.title || "").trim(),
      body: String(input.body || "").trim(),
      status,
      pinned: Boolean(input.pinned),
      notify_on_publish: input.notify_on_publish !== false,
      request_key: input.request_key || null,
      created_by: actor,
      published_at: status === "published" ? nowIso() : null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    if (!notice.title || !notice.body) throw new Error("공지 제목과 내용을 입력해 주세요.");
    this.notices.push(notice);
    await this.appendAudit({ actor, action: "notice.create", entityType: "notice", entityId: notice.id, after: notice });
    return clone(notice);
  }

  async updateNotice(noticeId, patch, actor = "admin") {
    const notice = this.notices.find((item) => item.id === noticeId);
    if (!notice) throw new Error("공지를 찾을 수 없습니다.");
    const before = clone(notice);
    for (const key of ["title", "body", "pinned", "notify_on_publish"]) {
      if (patch[key] !== undefined) notice[key] = patch[key];
    }
    if (patch.status !== undefined) {
      notice.status = patch.status;
      if (patch.status === "published" && !notice.published_at) notice.published_at = nowIso();
    }
    if (!String(notice.title || "").trim() || !String(notice.body || "").trim()) {
      throw new Error("공지 제목과 내용을 입력해 주세요.");
    }
    notice.updated_at = nowIso();
    await this.appendAudit({ actor, action: "notice.update", entityType: "notice", entityId: notice.id, before, after: notice });
    return clone(notice);
  }

  async archiveNotice(noticeId, actor = "admin") {
    return this.updateNotice(noticeId, { status: "archived" }, actor);
  }

  async publishNotice(noticeId, actor = "admin") {
    const current = this.notices.find((item) => item.id === noticeId);
    if (!current) throw new Error("공지를 찾을 수 없습니다.");
    if (current.status === "archived") throw new Error("보관된 공지는 먼저 복원해야 게시할 수 있습니다.");
    if (current.status === "published") return { notice: clone(current), newlyPublished: false };
    return { notice: await this.updateNotice(noticeId, { status: "published" }, actor), newlyPublished: true };
  }

  async listFiles({ targetMemberId, all = false, status = "active" } = {}) {
    return this.files
      .filter((file) => (!status || file.status === status))
      .filter((file) => all || file.member_id == null || (targetMemberId && file.member_id === targetMemberId))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(fileMetadata);
  }

  async getFile(fileId) {
    const file = this.files.find((item) => item.id === fileId);
    return file ? fileMetadata(file) : null;
  }

  async createFile(input, body, actor = "admin") {
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > 20 * 1024 * 1024) {
      throw new Error("파일은 20MB 이하여야 합니다.");
    }
    if (this.files.filter((file) => file.status === "active").length >= 100) {
      throw new Error("자료실에는 최대 100개의 파일만 보관할 수 있습니다.");
    }
    const storedBytes = [...this.fileBodies.values()].reduce((sum, value) => sum + value.length, 0);
    if (storedBytes + body.length > 100 * 1024 * 1024) {
      throw new Error("개발용 자료실의 총 저장 용량 100MB를 초과할 수 없습니다.");
    }
    const alias = String(input.alias || "").trim();
    const duplicate = this.files.find((file) => (
      file.status === "active"
      && file.member_id === (input.member_id || null)
      && file.alias.toLocaleLowerCase("ko") === alias.toLocaleLowerCase("ko")
    ));
    if (duplicate) throw new Error("같은 대상에 동일한 자료 별칭을 두 번 등록할 수 없습니다.");
    const now = nowIso();
    const file = {
      id: id("file"),
      class_id: this.classroom.id,
      member_id: input.member_id || null,
      alias,
      filename: String(input.filename || "").trim(),
      description: String(input.description || "").trim(),
      mime_type: input.mime_type,
      size_bytes: body.length,
      bucket: "memory",
      object_path: id("object"),
      status: "active",
      created_by: actor,
      created_at: now,
      updated_at: now,
    };
    this.files.push(file);
    this.fileBodies.set(file.id, Buffer.from(body));
    await this.appendAudit({ actor, action: "file.create", entityType: "file", entityId: file.id, after: file });
    return fileMetadata(file);
  }

  async updateFile(fileId, patch, actor = "admin") {
    const file = this.files.find((item) => item.id === fileId);
    if (!file) throw new Error("파일을 찾을 수 없습니다.");
    const before = fileMetadata(file);
    for (const key of ["alias", "description", "member_id", "status"]) {
      if (patch[key] !== undefined) file[key] = patch[key];
    }
    file.updated_at = nowIso();
    await this.appendAudit({ actor, action: "file.update", entityType: "file", entityId: file.id, before, after: file });
    return fileMetadata(file);
  }

  async deleteFile(fileId, actor = "admin") {
    const index = this.files.findIndex((item) => item.id === fileId);
    if (index < 0) throw new Error("파일을 찾을 수 없습니다.");
    const [file] = this.files.splice(index, 1);
    this.fileBodies.delete(file.id);
    await this.appendAudit({ actor, action: "file.delete", entityType: "file", entityId: file.id, before: file });
    return fileMetadata(file);
  }

  async downloadFile(fileId) {
    const file = this.files.find((item) => item.id === fileId && item.status === "active");
    const body = this.fileBodies.get(fileId);
    if (!file || !body) throw new Error("파일을 찾을 수 없습니다.");
    return Buffer.from(body);
  }

  async listNotifications({ limit = 50, status } = {}) {
    return clone(this.notifications)
      .filter((item) => !status || item.status === status)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, limit);
  }

  async getNotification(notificationId) {
    const notification = this.notifications.find((item) => item.id === notificationId);
    return notification ? clone(notification) : null;
  }

  async reserveNotifications(items) {
    const reserved = [];
    for (const item of items) {
      if (this.notifications.some((notification) => notification.idempotency_key === item.idempotency_key)) continue;
      const notification = {
        id: id("notification"),
        class_id: this.classroom.id,
        member_id: item.member_id,
        event_id: item.event_id || null,
        notice_id: item.notice_id || null,
        idempotency_key: item.idempotency_key,
        kind: item.kind,
        scheduled_for: item.scheduled_for,
        status: "reserved",
        task_id: null,
        failure_reason: null,
        payload: item.payload,
        sent_at: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      this.notifications.push(notification);
      reserved.push(clone(notification));
    }
    return reserved;
  }

  async markNotifications(ids, patch) {
    const idSet = new Set(ids);
    const updated = [];
    for (const notification of this.notifications) {
      if (!idSet.has(notification.id)) continue;
      Object.assign(notification, patch, { updated_at: nowIso() });
      if (patch.status === "sent") notification.sent_at = nowIso();
      updated.push(clone(notification));
    }
    return updated;
  }

  async appendAudit({ actor, action, entityType, entityId, before = null, after = null }) {
    this.auditLogs.push({
      id: id("audit"),
      class_id: this.classroom.id,
      actor,
      action,
      entity_type: entityType,
      entity_id: entityId,
      before_data: before ? redactAuditData(clone(before)) : null,
      after_data: after ? redactAuditData(clone(after)) : null,
      created_at: nowIso(),
    });
  }
}
