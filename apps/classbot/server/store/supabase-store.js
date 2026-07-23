import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { hashInviteCode } from "../security.js";
import { getSeoulParts, parseKoreaDateTime } from "../time.js";

function unwrap(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data;
}

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

function fetchWithTimeout(url, options = {}) {
  // Free Render instances can need extra time for their first outbound TLS
  // connection after a cold start. Keep the request bounded without killing
  // Supabase initialization during that warm-up window.
  const timeout = AbortSignal.timeout(30_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetch(url, { ...options, signal });
}

function isTransientSupabaseConnectionError(error) {
  return /fetch failed|network|econnreset|enotfound|eai_again|und_err/i.test(String(error?.message || error));
}

const FILE_BUCKET = "classbot-files";
const FILE_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"];
const FILE_EXTENSIONS = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

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

function activeTimetableRows(rows) {
  const latestBySlot = new Map();
  for (const row of rows.slice().sort((a, b) => b.effective_from.localeCompare(a.effective_from))) {
    const slot = `${row.weekday}:${row.period}`;
    if (!latestBySlot.has(slot)) latestBySlot.set(slot, row);
  }
  return [...latestBySlot.values()].sort((a, b) => a.weekday - b.weekday || a.period - b.period);
}

export class SupabaseStore {
  constructor(config) {
    this.config = config;
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
    this.classroom = null;
    this.initializationRetryDelays = config.supabaseInitializationRetryDelaysMs || [1_000, 2_500, 5_000];
  }

  async initialize() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.initializeOnce();
        return;
      } catch (error) {
        const delay = this.initializationRetryDelays[attempt];
        if (delay === undefined || !isTransientSupabaseConnectionError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  async initializeOnce() {
    const existing = unwrap(
      await this.client.from("classbot_classes").select("*").eq("code", this.config.classCode).maybeSingle(),
      "학급 조회 실패",
    );
    if (existing) {
      this.classroom = existing;
    } else {
      this.classroom = unwrap(
        await this.client
          .from("classbot_classes")
          .insert({ code: this.config.classCode, name: this.config.className, timezone: this.config.timezone })
          .select("*")
          .single(),
        "학급 생성 실패",
      );
    }
  }

  async ensureClassroom() {
    if (!this.classroom) await this.initialize();
    return this.classroom;
  }

  async healthCheck() {
    await this.ensureClassroom();
    const version = unwrap(await this.client.rpc("classbot_health_check"), "학급 저장소 상태 확인 실패");
    if (Number(version) !== 7) throw new Error("지원하지 않는 Classbot 데이터베이스 스키마입니다.");
    return { ok: true, storage: "supabase" };
  }

  async getClassroom() {
    const classroom = await this.ensureClassroom();
    const fresh = unwrap(
      await this.client.from("classbot_classes").select("*").eq("id", classroom.id).single(),
      "학급 조회 실패",
    );
    this.classroom = fresh;
    return fresh;
  }

  async updateSettings(patch, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => ["daily_digest_time", "daily_digest_enabled", "name"].includes(key)),
    );
    const updated = unwrap(
      await this.client.from("classbot_classes").update(allowed).eq("id", classroom.id).select("*").single(),
      "학급 설정 저장 실패",
    );
    this.classroom = updated;
    await this.appendAudit({ actor, action: "settings.update", entityType: "classroom", entityId: classroom.id, after: updated });
    return updated;
  }

  async listMembers() {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client.from("classbot_members").select("*").eq("class_id", classroom.id).order("display_name"),
      "구성원 조회 실패",
    );
  }

  async getMember(memberId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client.from("classbot_members").select("*").eq("class_id", classroom.id).eq("id", memberId).maybeSingle(),
      "구성원 조회 실패",
    );
  }

  async findMemberByQuiloUserId(userId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client
        .from("classbot_members")
        .select("*")
        .eq("class_id", classroom.id)
        .eq("quilo_user_id", String(userId || "").trim())
        .maybeSingle(),
      "Quilo 구성원 조회 실패",
    );
  }

  async createMember(input, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const created = unwrap(
      await this.client.rpc("classbot_create_member", {
        p_class_id: classroom.id,
        p_display_name: String(input.display_name || "").trim(),
        p_role: input.role === "admin" ? "admin" : "student",
      }),
      "구성원 생성 실패",
    );
    const member = created?.[0];
    if (!member) throw new Error("구성원을 생성하지 못했습니다.");
    await this.appendAudit({ actor, action: "member.create", entityType: "member", entityId: member.id, after: member });
    return member;
  }

  async seedMembersIfEmpty(items, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const count = Number(unwrap(
      await this.client.rpc("classbot_seed_members_if_empty", {
        p_class_id: classroom.id,
        p_members: items,
      }),
      "초기 구성원 명단 생성 실패",
    ) || 0);
    if (count > 0) {
      await this.appendAudit({
        actor,
        action: "member.seed",
        entityType: "member",
        entityId: "initial-roster",
        after: { count },
      });
    }
    return count;
  }

  async updateMember(memberId, patch, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => ["display_name", "role", "notification_enabled", "daily_digest_enabled", "status"].includes(key)),
    );
    const member = unwrap(
      await this.client.from("classbot_members").update(allowed).eq("class_id", classroom.id).eq("id", memberId).select("*").single(),
      "구성원 저장 실패",
    );
    await this.appendAudit({ actor, action: "member.update", entityType: "member", entityId: member.id, after: member });
    return member;
  }

  async createInvite({ memberId, codeHash, expiresAt }, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const member = unwrap(
      await this.client.from("classbot_members").select("id,status").eq("class_id", classroom.id).eq("id", memberId).maybeSingle(),
      "초대 대상 조회 실패",
    );
    if (!member) throw new Error("초대할 구성원을 찾을 수 없습니다.");
    if (member.status === "active") throw new Error("이미 가입한 구성원에게 초대 코드를 만들 수 없습니다.");
    unwrap(
      await this.client
        .from("classbot_invites")
        .update({ used_at: new Date().toISOString(), portal_used_at: new Date().toISOString() })
        .eq("class_id", classroom.id)
        .eq("member_id", memberId)
        .or("used_at.is.null,portal_used_at.is.null"),
      "기존 초대 코드 정리 실패",
    );
    const invite = unwrap(
      await this.client
        .from("classbot_invites")
        .insert({ class_id: classroom.id, member_id: memberId, code_hash: codeHash, expires_at: expiresAt })
        .select("*")
        .single(),
      "초대 코드 생성 실패",
    );
    await this.appendAudit({ actor, action: "invite.create", entityType: "invite", entityId: invite.id, after: { ...invite, code_hash: "[redacted]" } });
    return invite;
  }

  async claimInvite({ code, userKey, userKeyType = "botUserKey" }) {
    const classroom = await this.ensureClassroom();
    const codeHash = hashInviteCode(code);
    const claimed = unwrap(
      await this.client.rpc("classbot_claim_invite", {
        p_class_id: classroom.id,
        p_code_hash: codeHash,
        p_user_key: userKey,
        p_user_key_type: userKeyType,
      }),
      "초대 코드 가입 처리 실패",
    );
    const member = claimed?.[0];
    if (!member) throw new Error("초대 코드가 올바르지 않거나 만료되었습니다.");
    await this.appendAudit({ actor: member.id, action: "invite.claim", entityType: "member", entityId: member.id, after: { status: "active" } });
    return member;
  }

  async claimQuiloInvite({ code, userId }) {
    const classroom = await this.ensureClassroom();
    const claimed = unwrap(
      await this.client.rpc("classbot_claim_quilo_invite", {
        p_class_id: classroom.id,
        p_code_hash: hashInviteCode(code),
        p_quilo_user_id: String(userId || "").trim(),
      }),
      "Quilo 계정 연결 실패",
    );
    const member = claimed?.[0];
    if (!member) throw new Error("초대 코드가 올바르지 않거나 만료되었습니다.");
    await this.appendAudit({ actor: member.id, action: "member.quilo_claim", entityType: "member", entityId: member.id, after: { status: "active" } });
    return member;
  }

  async claimPortalInvite({ memberId, code }) {
    const classroom = await this.ensureClassroom();
    const usedAt = new Date().toISOString();
    const invite = unwrap(
      await this.client
        .from("classbot_invites")
        .update({ portal_used_at: usedAt })
        .eq("class_id", classroom.id)
        .eq("member_id", memberId)
        .eq("code_hash", hashInviteCode(code))
        .is("portal_used_at", null)
        .gt("expires_at", usedAt)
        .select("id,member_id,portal_used_at")
        .maybeSingle(),
      "학생 포털 초대 코드 확인 실패",
    );
    if (!invite) throw new Error("이름 또는 초대 코드를 확인할 수 없습니다.");
    const member = await this.getMember(memberId);
    if (!member) throw new Error("이름 또는 초대 코드를 확인할 수 없습니다.");
    await this.appendAudit({
      actor: member.id,
      action: "portal.login",
      entityType: "invite",
      entityId: invite.id,
      after: { member_id: member.id, portal_used_at: invite.portal_used_at },
    }).catch(() => {});
    return member;
  }

  async findMemberByUserKey(userKey) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client
        .from("classbot_members")
        .select("*")
        .eq("class_id", classroom.id)
        .eq("kakao_user_key", userKey)
        .eq("status", "active")
        .maybeSingle(),
      "구성원 조회 실패",
    );
  }

  async setPendingFileSelection({ memberId, fileIds, expiresAt }) {
    const classroom = await this.ensureClassroom();
    const ids = [...new Set((Array.isArray(fileIds) ? fileIds : []).map(String).filter(Boolean))].slice(0, 3);
    const expires = new Date(expiresAt);
    if (!String(memberId || "").trim() || !ids.length || Number.isNaN(expires.getTime())) throw new Error("파일 후보 상태가 올바르지 않습니다.");
    const state = unwrap(
      await this.client
        .from("classbot_kakao_states")
        .upsert({
          class_id: classroom.id,
          member_id: memberId,
          pending_file_ids: ids,
          pending_expires_at: expires.toISOString(),
        }, { onConflict: "member_id" })
        .select("class_id,member_id,pending_file_ids,pending_expires_at")
        .single(),
      "파일 후보 저장 실패",
    );
    return {
      class_id: state.class_id,
      member_id: state.member_id,
      file_ids: state.pending_file_ids,
      expires_at: state.pending_expires_at,
    };
  }

  async getPendingFileSelection(memberId) {
    const classroom = await this.ensureClassroom();
    const state = unwrap(
      await this.client
        .from("classbot_kakao_states")
        .select("class_id,member_id,pending_file_ids,pending_expires_at")
        .eq("class_id", classroom.id)
        .eq("member_id", memberId)
        .gt("pending_expires_at", new Date().toISOString())
        .maybeSingle(),
      "파일 후보 조회 실패",
    );
    return state ? {
      class_id: state.class_id,
      member_id: state.member_id,
      file_ids: state.pending_file_ids,
      expires_at: state.pending_expires_at,
    } : null;
  }

  async clearPendingFileSelection(memberId) {
    const classroom = await this.ensureClassroom();
    unwrap(
      await this.client
        .from("classbot_kakao_states")
        .delete()
        .eq("class_id", classroom.id)
        .eq("member_id", memberId),
      "파일 후보 삭제 실패",
    );
  }

  async setPendingKakaoAction({ memberId, action, eventId = null, payload, expiresAt }) {
    const classroom = await this.ensureClassroom();
    const expires = new Date(expiresAt);
    if (!String(memberId || "").trim() || !["create", "update", "complete", "delete"].includes(action)) {
      throw new Error("일정 변경 상태가 올바르지 않습니다.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Number.isNaN(expires.getTime())) {
      throw new Error("일정 변경 상태가 올바르지 않습니다.");
    }
    const state = unwrap(
      await this.client
        .from("classbot_kakao_pending_actions")
        .upsert({
          class_id: classroom.id,
          member_id: memberId,
          action,
          event_id: eventId || null,
          payload,
          expires_at: expires.toISOString(),
        }, { onConflict: "member_id" })
        .select("class_id,member_id,action,event_id,payload,expires_at")
        .single(),
      "일정 변경 상태 저장 실패",
    );
    return state;
  }

  async getPendingKakaoAction(memberId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client
        .from("classbot_kakao_pending_actions")
        .select("class_id,member_id,action,event_id,payload,expires_at")
        .eq("class_id", classroom.id)
        .eq("member_id", memberId)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle(),
      "일정 변경 상태 조회 실패",
    );
  }

  async clearPendingKakaoAction(memberId) {
    const classroom = await this.ensureClassroom();
    unwrap(
      await this.client
        .from("classbot_kakao_pending_actions")
        .delete()
        .eq("class_id", classroom.id)
        .eq("member_id", memberId),
      "일정 변경 상태 삭제 실패",
    );
  }

  async listTimetable({ weekday } = {}) {
    const classroom = await this.ensureClassroom();
    let query = this.client.from("classbot_timetable").select("*").eq("class_id", classroom.id);
    if (weekday != null) query = query.eq("weekday", Number(weekday));
    return unwrap(await query.order("weekday").order("period"), "시간표 조회 실패");
  }

  async listMemberTimetable(memberId, { weekday, date } = {}) {
    const classroom = await this.ensureClassroom();
    if (!String(memberId || "").trim()) throw new Error("개인 시간표를 조회할 구성원이 필요합니다.");
    const dateKey = timetableDateKey(date || new Date());
    let query = this.client
      .from("classbot_member_timetable")
      .select("*")
      .eq("class_id", classroom.id)
      .eq("member_id", memberId)
      .lte("effective_from", dateKey)
      .or(`effective_to.is.null,effective_to.gte.${dateKey}`);
    if (weekday != null) {
      const numericWeekday = Number(weekday);
      if (!Number.isInteger(numericWeekday) || numericWeekday < 1 || numericWeekday > 5) throw new Error("요일은 월요일부터 금요일까지만 선택할 수 있습니다.");
      query = query.eq("weekday", numericWeekday);
    }
    const rows = unwrap(
      await query.order("weekday").order("period").order("effective_from", { ascending: false }),
      "개인 시간표 조회 실패",
    );
    return activeTimetableRows(rows);
  }

  async replaceMemberTimetable({ memberId, rows }, actor = "admin") {
    const classroom = await this.ensureClassroom();
    if (!String(memberId || "").trim()) throw new Error("개인 시간표를 등록할 구성원이 필요합니다.");
    const payload = normalizeMemberTimetableRows(rows);
    const saved = unwrap(
      await this.client.rpc("classbot_replace_member_timetable", {
        p_class_id: classroom.id,
        p_member_id: memberId,
        p_rows: payload,
      }),
      "개인 시간표 저장 실패",
    );
    await this.appendAudit({
      actor,
      action: "member_timetable.replace",
      entityType: "member_timetable",
      entityId: memberId,
      after: { member_id: memberId, row_count: saved.length },
    });
    return saved;
  }

  async replaceTimetableDay({ weekday, rows }, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const numericWeekday = Number(weekday);
    if (!Number.isInteger(numericWeekday) || numericWeekday < 1 || numericWeekday > 5) throw new Error("요일은 월요일부터 금요일까지만 선택할 수 있습니다.");
    const payload = rows
      .filter((row) => String(row.subject || "").trim())
      .map((row, index) => ({
        class_id: classroom.id,
        weekday: numericWeekday,
        period: Number(row.period || index + 1),
        subject: String(row.subject).trim(),
        activity: String(row.activity || "").trim(),
        teacher: String(row.teacher || "").trim(),
        room: String(row.room || "").trim(),
        memo: String(row.memo || "").trim(),
        effective_from: row.effective_from || new Date().toISOString().slice(0, 10),
        effective_to: row.effective_to || null,
      }));
    const saved = unwrap(
      await this.client.rpc("classbot_replace_timetable_day", {
        p_class_id: classroom.id,
        p_weekday: numericWeekday,
        p_rows: payload,
      }),
      "시간표 저장 실패",
    );
    await this.appendAudit({ actor, action: "timetable.replace", entityType: "timetable", entityId: String(numericWeekday), after: saved });
    return saved;
  }

  async listEvents({ from, to, status, targetMemberId } = {}) {
    const classroom = await this.ensureClassroom();
    let query = this.client.from("classbot_events").select("*").eq("class_id", classroom.id);
    if (from) query = query.gte("due_at", from);
    if (to) query = query.lte("due_at", to);
    if (status) query = query.eq("status", status);
    if (targetMemberId !== undefined) query = query.or(`member_id.is.null,member_id.eq.${targetMemberId}`);
    return unwrap(await query.order("due_at"), "일정 조회 실패");
  }

  async getEvent(eventId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client.from("classbot_events").select("*").eq("class_id", classroom.id).eq("id", eventId).maybeSingle(),
      "일정 조회 실패",
    );
  }

  async createEvent(input, actor = "admin") {
    const classroom = await this.ensureClassroom();
    if (input.member_id) {
      const member = await this.getMember(input.member_id);
      if (!member || member.status === "left") throw new Error("개인 일정을 등록할 구성원을 찾을 수 없습니다.");
    }
    if (input.request_key) {
      const existing = unwrap(
        await this.client
          .from("classbot_events")
          .select("*")
          .eq("class_id", classroom.id)
          .eq("request_key", input.request_key)
          .maybeSingle(),
        "중복 일정 확인 실패",
      );
      if (existing) return existing;
    }
    const result = await this.client
        .from("classbot_events")
        .insert({
          class_id: classroom.id,
          member_id: input.member_id || null,
          category: input.category || "assessment",
          subject: String(input.subject || "").trim(),
          title: String(input.title || "").trim(),
          description: String(input.description || "").trim(),
          due_at: parseKoreaDateTime(input.due_at).toISOString(),
          reminder_offsets: input.reminder_offsets || [4320, 1440, 0],
          notify_on_change: input.notify_on_change !== false,
          request_key: input.request_key || null,
          created_by: actor,
        })
        .select("*")
        .single();
    if (result.error && input.request_key && result.error.code === "23505") {
      const existing = unwrap(
        await this.client.from("classbot_events").select("*").eq("class_id", classroom.id).eq("request_key", input.request_key).single(),
        "중복 일정 조회 실패",
      );
      return existing;
    }
    const event = unwrap(result, "일정 생성 실패");
    await this.appendAudit({ actor, action: "event.create", entityType: "event", entityId: event.id, after: event });
    return event;
  }

  async updateEvent(eventId, patch, actor = "admin") {
    const classroom = await this.ensureClassroom();
    if (patch.member_id) {
      const member = await this.getMember(patch.member_id);
      if (!member || member.status === "left") throw new Error("개인 일정을 등록할 구성원을 찾을 수 없습니다.");
    }
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => ["member_id", "category", "subject", "title", "description", "status", "notify_on_change", "reminder_offsets"].includes(key)),
    );
    if (patch.due_at !== undefined) allowed.due_at = parseKoreaDateTime(patch.due_at).toISOString();
    const event = unwrap(
      await this.client.from("classbot_events").update(allowed).eq("class_id", classroom.id).eq("id", eventId).select("*").single(),
      "일정 저장 실패",
    );
    await this.appendAudit({ actor, action: "event.update", entityType: "event", entityId: event.id, after: event });
    return event;
  }

  async cancelEvent(eventId, actor = "admin") {
    return this.updateEvent(eventId, { status: "cancelled" }, actor);
  }

  async listNotices({ status, limit = 50 } = {}) {
    const classroom = await this.ensureClassroom();
    let query = this.client
      .from("classbot_notices")
      .select("*")
      .eq("class_id", classroom.id)
      .order("pinned", { ascending: false })
      .order("published_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(Number(limit) || 50);
    if (status) query = query.eq("status", status);
    return unwrap(await query, "공지 조회 실패");
  }

  async getNotice(noticeId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client.from("classbot_notices").select("*").eq("class_id", classroom.id).eq("id", noticeId).maybeSingle(),
      "공지 조회 실패",
    );
  }

  async createNotice(input, actor = "admin") {
    const classroom = await this.ensureClassroom();
    if (input.request_key) {
      const existing = unwrap(
        await this.client
          .from("classbot_notices")
          .select("*")
          .eq("class_id", classroom.id)
          .eq("request_key", input.request_key)
          .maybeSingle(),
        "중복 공지 확인 실패",
      );
      if (existing) return existing;
    }
    const status = input.status === "published" ? "published" : "draft";
    const result = await this.client
        .from("classbot_notices")
        .insert({
          class_id: classroom.id,
          title: String(input.title || "").trim(),
          body: String(input.body || "").trim(),
          status,
          pinned: Boolean(input.pinned),
          notify_on_publish: input.notify_on_publish !== false,
          request_key: input.request_key || null,
          created_by: actor,
          published_at: status === "published" ? new Date().toISOString() : null,
        })
        .select("*")
        .single();
    if (result.error && input.request_key && result.error.code === "23505") {
      const existing = unwrap(
        await this.client.from("classbot_notices").select("*").eq("class_id", classroom.id).eq("request_key", input.request_key).single(),
        "중복 공지 조회 실패",
      );
      return existing;
    }
    const notice = unwrap(result, "공지 생성 실패");
    await this.appendAudit({ actor, action: "notice.create", entityType: "notice", entityId: notice.id, after: notice });
    return notice;
  }

  async updateNotice(noticeId, patch, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => ["title", "body", "status", "pinned", "notify_on_publish"].includes(key)),
    );
    if (patch.status === "published") {
      const current = await this.getNotice(noticeId);
      if (!current) throw new Error("공지를 찾을 수 없습니다.");
      if (!current.published_at) allowed.published_at = new Date().toISOString();
    }
    const notice = unwrap(
      await this.client
        .from("classbot_notices")
        .update(allowed)
        .eq("class_id", classroom.id)
        .eq("id", noticeId)
        .select("*")
        .single(),
      "공지 저장 실패",
    );
    await this.appendAudit({ actor, action: "notice.update", entityType: "notice", entityId: notice.id, after: notice });
    return notice;
  }

  async archiveNotice(noticeId, actor = "admin") {
    return this.updateNotice(noticeId, { status: "archived" }, actor);
  }

  async publishNotice(noticeId, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const published = unwrap(
      await this.client
        .from("classbot_notices")
        .update({ status: "published", published_at: new Date().toISOString() })
        .eq("class_id", classroom.id)
        .eq("id", noticeId)
        .eq("status", "draft")
        .select("*")
        .maybeSingle(),
      "공지 게시 실패",
    );
    if (published) {
      await this.appendAudit({ actor, action: "notice.publish", entityType: "notice", entityId: published.id, after: published });
      return { notice: published, newlyPublished: true };
    }
    const current = await this.getNotice(noticeId);
    if (!current) throw new Error("공지를 찾을 수 없습니다.");
    if (current.status === "archived") throw new Error("보관된 공지는 먼저 복원해야 게시할 수 있습니다.");
    return { notice: current, newlyPublished: false };
  }

  async ensureFileBucket() {
    const existing = await this.client.storage.getBucket(FILE_BUCKET);
    if (existing.data) return;
    const created = await this.client.storage.createBucket(FILE_BUCKET, {
      public: false,
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: FILE_MIME_TYPES,
    });
    if (created.error && !/already exists|duplicate/i.test(created.error.message || "")) {
      throw new Error(`자료실 저장소 준비 실패: ${created.error.message}`);
    }
  }

  async listFiles({ targetMemberId, all = false, status = "active" } = {}) {
    const classroom = await this.ensureClassroom();
    let query = this.client
      .from("classbot_files")
      .select("*")
      .eq("class_id", classroom.id)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (!all) {
      query = targetMemberId
        ? query.or(`member_id.is.null,member_id.eq.${targetMemberId}`)
        : query.is("member_id", null);
    }
    return unwrap(await query, "자료실 조회 실패");
  }

  async getFile(fileId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client.from("classbot_files").select("*").eq("class_id", classroom.id).eq("id", fileId).maybeSingle(),
      "파일 조회 실패",
    );
  }

  async createFile(input, body, actor = "admin") {
    const classroom = await this.ensureClassroom();
    if (!Buffer.isBuffer(body) || body.length < 1 || body.length > 20 * 1024 * 1024) {
      throw new Error("파일은 20MB 이하여야 합니다.");
    }
    const countResult = await this.client
      .from("classbot_files")
      .select("id", { count: "exact", head: true })
      .eq("class_id", classroom.id)
      .eq("status", "active");
    if (countResult.error) throw new Error(`자료실 용량 확인 실패: ${countResult.error.message}`);
    if ((countResult.count || 0) >= 100) throw new Error("자료실에는 최대 100개의 파일만 보관할 수 있습니다.");

    await this.ensureFileBucket();
    const extension = FILE_EXTENSIONS.get(input.mime_type);
    if (!extension) throw new Error("PDF 또는 지원되는 이미지 파일만 올릴 수 있습니다.");
    const fileId = crypto.randomUUID();
    const objectPath = `${classroom.id}/${fileId}/${crypto.randomUUID()}.${extension}`;
    const upload = await this.client.storage.from(FILE_BUCKET).upload(objectPath, body, {
      contentType: input.mime_type,
      cacheControl: "0",
      upsert: false,
    });
    if (upload.error) throw new Error(`파일 업로드 실패: ${upload.error.message}`);

    const result = await this.client.from("classbot_files").insert({
      id: fileId,
      class_id: classroom.id,
      member_id: input.member_id || null,
      alias: input.alias,
      filename: input.filename,
      description: input.description || "",
      mime_type: input.mime_type,
      size_bytes: body.length,
      bucket: FILE_BUCKET,
      object_path: objectPath,
      status: "active",
      created_by: actor,
    }).select("*").single();
    if (result.error) {
      await this.client.storage.from(FILE_BUCKET).remove([objectPath]);
      if (result.error.code === "23505") throw new Error("같은 대상에 동일한 자료 별칭을 두 번 등록할 수 없습니다.");
      throw new Error(`파일 정보 저장 실패: ${result.error.message}`);
    }
    await this.appendAudit({ actor, action: "file.create", entityType: "file", entityId: result.data.id, after: result.data });
    return result.data;
  }

  async updateFile(fileId, patch, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const before = await this.getFile(fileId);
    if (!before) throw new Error("파일을 찾을 수 없습니다.");
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([key]) => ["alias", "description", "member_id", "status"].includes(key)),
    );
    const updated = unwrap(
      await this.client.from("classbot_files").update(allowed).eq("class_id", classroom.id).eq("id", fileId).select("*").single(),
      "파일 정보 저장 실패",
    );
    await this.appendAudit({ actor, action: "file.update", entityType: "file", entityId: fileId, before, after: updated });
    return updated;
  }

  async deleteFile(fileId, actor = "admin") {
    const classroom = await this.ensureClassroom();
    const file = await this.getFile(fileId);
    if (!file) throw new Error("파일을 찾을 수 없습니다.");
    const removedObject = await this.client.storage.from(file.bucket).remove([file.object_path]);
    if (removedObject.error) throw new Error(`파일 삭제 실패: ${removedObject.error.message}`);
    unwrap(
      await this.client.from("classbot_files").delete().eq("class_id", classroom.id).eq("id", fileId),
      "파일 정보 삭제 실패",
    );
    await this.appendAudit({ actor, action: "file.delete", entityType: "file", entityId: fileId, before: file });
    return file;
  }

  async downloadFile(fileId) {
    const file = await this.getFile(fileId);
    if (!file || file.status !== "active") throw new Error("파일을 찾을 수 없습니다.");
    const downloaded = await this.client.storage.from(file.bucket).download(file.object_path);
    if (downloaded.error) throw new Error(`파일 다운로드 실패: ${downloaded.error.message}`);
    return Buffer.from(await downloaded.data.arrayBuffer());
  }

  async listNotifications({ limit = 50, status } = {}) {
    const classroom = await this.ensureClassroom();
    let query = this.client
      .from("classbot_notifications")
      .select("*")
      .eq("class_id", classroom.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status) query = query.eq("status", status);
    return unwrap(await query, "알림 기록 조회 실패");
  }

  async getNotification(notificationId) {
    const classroom = await this.ensureClassroom();
    return unwrap(
      await this.client
        .from("classbot_notifications")
        .select("*")
        .eq("class_id", classroom.id)
        .eq("id", notificationId)
        .maybeSingle(),
      "알림 기록 조회 실패",
    );
  }

  async reserveNotifications(items) {
    if (!items.length) return [];
    const classroom = await this.ensureClassroom();
    const payload = items.map((item) => ({ ...item, class_id: classroom.id, status: "reserved" }));
    const result = await this.client.from("classbot_notifications").upsert(payload, { onConflict: "idempotency_key", ignoreDuplicates: true }).select("*");
    return unwrap(result, "알림 예약 실패");
  }

  async markNotifications(ids, patch) {
    if (!ids.length) return [];
    const classroom = await this.ensureClassroom();
    const changes = { ...patch };
    if (patch.status === "sent") changes.sent_at = new Date().toISOString();
    return unwrap(
      await this.client.from("classbot_notifications").update(changes).eq("class_id", classroom.id).in("id", ids).select("*"),
      "알림 상태 저장 실패",
    );
  }

  async appendAudit({ actor, action, entityType, entityId, before = null, after = null }) {
    const classroom = await this.ensureClassroom();
    unwrap(
      await this.client.from("classbot_audit_logs").insert({
        class_id: classroom.id,
        actor,
        action,
        entity_type: entityType,
        entity_id: entityId,
        before_data: before ? redactAuditData(before) : null,
        after_data: after ? redactAuditData(after) : null,
      }),
      "변경 기록 저장 실패",
    );
  }
}
