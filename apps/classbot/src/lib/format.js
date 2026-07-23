export const weekdays = ["월", "화", "수", "목", "금"];

export function todayWeekday() {
  const day = new Date().getDay();
  return day >= 1 && day <= 5 ? day : 1;
}

export function dateLabel(value, includeTime = true) {
  if (!value) return "-";
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

export function dayDistance(value) {
  const target = new Date(value);
  const today = new Date();
  target.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86_400_000);
}

export function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromLocalInput(value) {
  return value ? new Date(value).toISOString() : "";
}

export const categoryLabels = {
  assessment: "수행평가",
  assignment: "과제",
  class: "수업",
  schedule_change: "시간표 변경",
};

export function eventTargetLabel(event, members = []) {
  if (!event?.member_id) return "반 전체";
  return members.find((member) => member.id === event.member_id)?.display_name || "학생 정보 없음";
}

export const notificationLabels = {
  daily_digest: "오늘 시간표",
  event_reminder: "일정 알림",
  schedule_change: "시간표 변경",
  notice: "반 공지",
  test: "테스트 알림",
};

export function notificationTitle(item) {
  const title = item?.payload?.title?.trim();
  if (title) return title;
  const message = item?.payload?.message?.trim();
  if (message) return message.split(/\r?\n/, 1)[0];
  return notificationLabels[item?.kind] || "알림";
}
