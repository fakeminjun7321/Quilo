const SEOUL_OFFSET = "+09:00";

const weekdayFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  weekday: "long",
});

const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "long",
  day: "numeric",
  weekday: "long",
});

export function parseKoreaDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const date = new Date(hasZone ? text : `${text}${SEOUL_OFFSET}`);
  if (Number.isNaN(date.getTime())) throw new Error("올바른 날짜와 시간을 입력해 주세요.");
  return date;
}

export function getSeoulParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: weekdayMap[map.weekday],
    dateKey: `${map.year}-${map.month}-${map.day}`,
    timeKey: `${map.hour}:${map.minute}`,
  };
}

export function addSeoulDays(date, days) {
  const parts = getSeoulParts(date);
  return new Date(`${parts.dateKey}T12:00:00${SEOUL_OFFSET}`).getTime() + days * 86_400_000;
}

export function dateForSeoulOffset(date, days) {
  return new Date(addSeoulDays(date, days));
}

export function startOfSeoulDay(date = new Date()) {
  const { dateKey } = getSeoulParts(date);
  return new Date(`${dateKey}T00:00:00${SEOUL_OFFSET}`);
}

export function endOfSeoulDay(date = new Date()) {
  const start = startOfSeoulDay(date);
  return new Date(start.getTime() + 86_400_000 - 1);
}

export function formatKoreanDate(date) {
  return dateFormatter.format(date);
}

export function formatKoreanWeekday(date) {
  return weekdayFormatter.format(date);
}

export function formatKoreanDateTime(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function minutesBetween(later, earlier) {
  return Math.round((later.getTime() - earlier.getTime()) / 60_000);
}
