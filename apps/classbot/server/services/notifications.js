import crypto from "node:crypto";
import { buildDailyDigestText, buildEventReminderText, getDaySchedule } from "./schedule.js";
import { getSeoulParts, parseKoreaDateTime } from "../time.js";

const MAX_LATENESS_MINUTES = 180;
const ORPHAN_GRACE_MINUTES = 10;

function userFingerprint(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function parseTime(value) {
  const [hour, minute] = String(value || "07:00").slice(0, 5).split(":").map(Number);
  return { hour, minute };
}

function dailyScheduledAt(now, time) {
  const parts = getSeoulParts(now);
  const parsed = parseTime(time);
  return parseKoreaDateTime(`${parts.dateKey}T${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}:00`);
}

function dueWithinWindow(scheduledFor, now) {
  const delta = now.getTime() - scheduledFor.getTime();
  return delta >= 0 && delta <= MAX_LATENESS_MINUTES * 60_000;
}

export class NotificationService {
  constructor({ store, kakaoClient }) {
    this.store = store;
    this.kakaoClient = kakaoClient;
  }

  async buildDueBatches(now = new Date()) {
    const [classroom, members, events] = await Promise.all([
      this.store.getClassroom(),
      this.store.listMembers(),
      this.store.listEvents({ status: "scheduled" }),
    ]);
    const activeMembers = members.filter(
      (member) => member.status === "active" && member.notification_enabled && member.kakao_user_key,
    );
    const batches = [];
    const parts = getSeoulParts(now);

    if (classroom.daily_digest_enabled && parts.weekday >= 1 && parts.weekday <= 5) {
      const scheduledFor = dailyScheduledAt(now, classroom.daily_digest_time);
      if (dueWithinWindow(scheduledFor, now)) {
        const recipients = activeMembers.filter((member) => member.daily_digest_enabled);
        for (const recipient of recipients) {
          const bundle = await getDaySchedule(this.store, now, { targetMemberId: recipient.id });
          batches.push({
            key: `daily:${parts.dateKey}`,
            kind: "daily_digest",
            eventId: null,
            scheduledFor,
            message: buildDailyDigestText(bundle),
            recipients: [recipient],
          });
        }
      }
    }

    for (const event of events) {
      if (event.notify_on_change === false) continue;
      for (const offset of event.reminder_offsets || []) {
        const scheduledFor = new Date(new Date(event.due_at).getTime() - Number(offset) * 60_000);
        const recipients = event.member_id
          ? activeMembers.filter((member) => member.id === event.member_id)
          : activeMembers;
        if (!dueWithinWindow(scheduledFor, now) || !recipients.length) continue;
        batches.push({
          key: `event:${event.id}:${new Date(event.due_at).toISOString()}:${offset}`,
          kind: "event_reminder",
          eventId: event.id,
          scheduledFor,
          message: buildEventReminderText(event, Number(offset), now),
          recipients,
        });
      }
    }

    return batches;
  }

  async dispatchDue({ now = new Date(), dryRun = false } = {}) {
    const batches = await this.buildDueBatches(now);
    if (dryRun || !this.kakaoClient.enabled) {
      return {
        dryRun: true,
        kakaoEnabled: this.kakaoClient.enabled,
        batches: batches.map((batch) => ({
          kind: batch.kind,
          scheduledFor: batch.scheduledFor.toISOString(),
          message: batch.message,
          recipientCount: batch.recipients.length,
        })),
      };
    }

    const results = [];
    for (const batch of batches) {
      const pending = batch.recipients.map((member) => ({
        member_id: member.id,
        event_id: batch.eventId,
        idempotency_key: `${batch.key}:${member.id}`,
        kind: batch.kind,
        scheduled_for: batch.scheduledFor.toISOString(),
        payload: { message: batch.message, user_fingerprint: userFingerprint(member.kakao_user_key) },
      }));
      const reserved = await this.store.reserveNotifications(pending);
      if (!reserved.length) continue;
      const reservedMemberIds = new Set(reserved.map((item) => item.member_id));
      const recipients = batch.recipients.filter((member) => reservedMemberIds.has(member.id));
      results.push(
        await this.submitReserved({
          reserved,
          recipients,
          kind: batch.kind,
          message: batch.message,
        }),
      );
    }
    return { dryRun: false, kakaoEnabled: true, results };
  }

  async dispatchNotice(notice, { dryRun = false } = {}) {
    if (!notice || notice.status !== "published") throw new Error("게시된 공지만 알림으로 보낼 수 있습니다.");
    const members = await this.store.listMembers();
    const recipients = members.filter(
      (member) => member.status === "active" && member.notification_enabled && member.kakao_user_key,
    );
    const message = `[Quilo] 반 공지\n${notice.title}\n\n${notice.body}`;
    return this.dispatchBroadcast({
      key: `notice:${notice.id}:${notice.updated_at}`,
      kind: "notice",
      noticeId: notice.id,
      message,
      recipients,
      dryRun,
    });
  }

  async dispatchTest({ message = "Quilo 알림 연결 테스트입니다.", memberId, dryRun = false } = {}) {
    const members = await this.store.listMembers();
    const recipients = members.filter(
      (member) =>
        member.status === "active" &&
        member.notification_enabled &&
        member.kakao_user_key &&
        (!memberId || member.id === memberId),
    );
    return this.dispatchBroadcast({
      key: `test:${new Date().toISOString()}`,
      kind: "test",
      noticeId: null,
      message: String(message).slice(0, 900),
      recipients,
      dryRun,
    });
  }

  async dispatchBroadcast({ key, kind, eventId = null, noticeId = null, message, recipients, dryRun = false }) {
    if (dryRun || !this.kakaoClient.enabled) {
      return { dryRun: true, kakaoEnabled: this.kakaoClient.enabled, kind, message, recipientCount: recipients.length };
    }
    if (!recipients.length) {
      return { dryRun: false, kakaoEnabled: true, kind, status: "skipped", recipientCount: 0 };
    }
    const now = new Date().toISOString();
    const pending = recipients.map((member) => ({
      member_id: member.id,
      event_id: eventId,
      notice_id: noticeId,
      idempotency_key: `${key}:${member.id}`,
      kind,
      scheduled_for: now,
      payload: { message, user_fingerprint: userFingerprint(member.kakao_user_key) },
    }));
    const reserved = await this.store.reserveNotifications(pending);
    if (!reserved.length) {
      return { dryRun: false, kakaoEnabled: true, kind, status: "duplicate", recipientCount: 0 };
    }
    const reservedMemberIds = new Set(reserved.map((item) => item.member_id));
    const uniqueRecipients = recipients.filter((member) => reservedMemberIds.has(member.id));
    return this.submitReserved({ reserved, recipients: uniqueRecipients, kind, message });
  }

  async submitReserved({ reserved, recipients, kind, message }) {
    let response;
    try {
      response = await this.kakaoClient.send({
        users: recipients.map((member) => ({ type: member.kakao_user_key_type, id: member.kakao_user_key })),
        data: { message, kind },
      });
    } catch (error) {
      await this.store.markNotifications(
        reserved.map((item) => item.id),
        { status: "failed", failure_reason: error.message },
      );
      return { kind, status: "failed", recipientCount: recipients.length, error: error.message };
    }

    if (!response.taskId) {
      const reason = "Kakao Event API가 발송 결과 조회용 taskId를 반환하지 않았습니다.";
      await this.store.markNotifications(
        reserved.map((item) => item.id),
        { status: "failed", failure_reason: reason },
      );
      return { kind, status: "failed", recipientCount: recipients.length, error: reason };
    }

    await this.store.markNotifications(
      reserved.map((item) => item.id),
      { status: "reserved", task_id: response.taskId, failure_reason: null },
    );
    return this.resolveTaskNotifications(reserved, response.taskId, { kind, recipientCount: recipients.length });
  }

  async resolveTaskNotifications(notifications, taskId, summary = {}) {
    let task;
    try {
      task = await this.kakaoClient.getTask(taskId);
    } catch (error) {
      return { ...summary, status: "pending", taskId, pendingReason: error.message };
    }

    if (task.status === "ALL SUCCESS") {
      await this.store.markNotifications(
        notifications.map((item) => item.id),
        { status: "sent", task_id: taskId, failure_reason: null },
      );
      return { ...summary, status: "sent", taskId, successCount: notifications.length, failCount: 0 };
    }

    const rawFailures = task.fail?.list;
    const failures = Array.isArray(rawFailures)
      ? rawFailures
      : rawFailures && typeof rawFailures === "object"
        ? Object.values(rawFailures)
        : [];
    const resolvedFailureCount = Number(task.fail?.count || failures.length || 0);
    const completed = /FAIL$/i.test(String(task.status || "")) || resolvedFailureCount > 0;
    if (!completed) return { ...summary, status: "pending", taskId };

    const failureByUser = new Map(
      failures.map((failure) => [userFingerprint(failure.userID ?? failure.userId ?? ""), failure.errorMsg || "카카오 발송 실패"]),
    );
    const failed = notifications.filter((item) => failureByUser.has(String(item.payload?.user_fingerprint || "")));
    const succeeded = notifications.filter((item) => !failureByUser.has(String(item.payload?.user_fingerprint || "")));

    if (failed.length !== resolvedFailureCount) {
      await this.store.markNotifications(
        notifications.map((item) => item.id),
        { status: "failed", task_id: taskId, failure_reason: "카카오 발송 결과의 실패 대상 정보를 완전히 대조할 수 없습니다." },
      );
      return { ...summary, status: "failed", taskId, successCount: 0, failCount: notifications.length };
    }
    if (succeeded.length) {
      await this.store.markNotifications(
        succeeded.map((item) => item.id),
        { status: "sent", task_id: taskId, failure_reason: null },
      );
    }
    for (const notification of failed) {
      await this.store.markNotifications([notification.id], {
        status: "failed",
        task_id: taskId,
        failure_reason: failureByUser.get(String(notification.payload?.user_fingerprint || "")),
      });
    }
    return {
      ...summary,
      status: succeeded.length ? "partial_failed" : "failed",
      taskId,
      successCount: succeeded.length,
      failCount: failed.length,
    };
  }

  async reconcilePending({ limit = 200 } = {}) {
    const reserved = await this.store.listNotifications({ status: "reserved", limit });
    const cutoff = Date.now() - ORPHAN_GRACE_MINUTES * 60_000;
    const orphans = reserved.filter((item) => !item.task_id && new Date(item.created_at).getTime() <= cutoff);
    const recentUnassigned = reserved.filter((item) => !item.task_id && new Date(item.created_at).getTime() > cutoff);
    if (orphans.length) {
      await this.store.markNotifications(
        orphans.map((item) => item.id),
        {
          status: "failed",
          failure_reason: "Kakao 요청 taskId가 기록되지 않아 자동 재시도하지 않았습니다. 관리자 명시적 재시도가 필요합니다.",
        },
      );
    }
    const orphanSummary = orphans.map((item) => ({ id: item.id, kind: item.kind, created_at: item.created_at }));
    if (!this.kakaoClient.enabled) {
      return {
        kakaoEnabled: false,
        results: [],
        orphanCount: orphans.length,
        orphans: orphanSummary,
        recentUnassignedCount: recentUnassigned.length,
      };
    }
    const pending = reserved.filter((item) => item.task_id);
    const groups = new Map();
    for (const notification of pending) {
      if (!groups.has(notification.task_id)) groups.set(notification.task_id, []);
      groups.get(notification.task_id).push(notification);
    }
    const results = [];
    for (const [taskId, notifications] of groups) {
      results.push(await this.resolveTaskNotifications(notifications, taskId, { recipientCount: notifications.length }));
    }
    return {
      kakaoEnabled: true,
      results,
      orphanCount: orphans.length,
      orphans: orphanSummary,
      recentUnassignedCount: recentUnassigned.length,
    };
  }

  async retryFailed(notification, { retryKey, dryRun = false } = {}) {
    if (!notification || notification.status !== "failed") throw new Error("실패한 알림만 명시적으로 재시도할 수 있습니다.");
    if (!retryKey) throw new Error("재시도 요청 중복 방지 키가 필요합니다.");
    const member = await this.store.getMember(notification.member_id);
    if (!member || member.status !== "active" || !member.notification_enabled || !member.kakao_user_key) {
      throw new Error("현재 알림을 받을 수 있는 활성 구성원이 아닙니다.");
    }
    const message = String(notification.payload?.message || "").trim();
    if (!message) throw new Error("원본 알림 메시지가 없어 재시도할 수 없습니다.");
    return this.dispatchBroadcast({
      key: `retry:${notification.id}:${retryKey}`,
      kind: notification.kind,
      eventId: notification.event_id || null,
      noticeId: notification.notice_id || null,
      message,
      recipients: [member],
      dryRun,
    });
  }
}
