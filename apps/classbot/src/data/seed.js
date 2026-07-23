const DAY = 86_400_000;

function isoAfter(days, hour = 23, minute = 59) {
  const base = new Date();
  base.setHours(hour, minute, 0, 0);
  return new Date(base.getTime() + days * DAY).toISOString();
}

const timetableRows = {
  1: [["수학", "미분의 활용"], ["영어", "Presentation Practice"], ["물리학", "등속도 운동"], ["화학", "산화와 환원 반응"], ["국어", "현대시 읽기"], ["정보", "알고리즘"], ["체육", "배드민턴"]],
  2: [["영어", "Reading"], ["수학", "적분"], ["화학", "화학 평형"], ["물리학", "운동량"], ["국어", "토론"], ["한국사", "근대 사회"], ["창체", "학급 활동"]],
  3: [["물리학", "등속도 운동"], ["수학", "미분의 활용"], ["영어", "Presentation Practice"], ["화학", "산화와 환원 반응"], ["정보", "자료 구조"], ["국어", "문학 토론"], ["창체", "동아리"]],
  4: [["화학", "반응 속도"], ["물리학", "회전 운동"], ["수학", "정적분"], ["영어", "Speaking"], ["한국사", "개항기"], ["체육", "농구"], ["국어", "논증"]],
  5: [["국어", "비문학"], ["정보", "탐색"], ["수학", "수열"], ["물리학", "전자기"], ["화학", "전기화학"], ["영어", "Writing"], ["창체", "자율 활동"]],
};

function buildTimetable() {
  return Object.entries(timetableRows).flatMap(([weekday, rows]) => rows.map(([subject, activity], index) => ({
    id: `seed-tt-${weekday}-${index + 1}`,
    weekday: Number(weekday),
    period: index + 1,
    subject,
    activity,
    teacher: "",
    room: "",
    memo: Number(weekday) === 3 && index === 0 ? "실험 도구 준비" : "",
  })));
}

export function createSeedOverview() {
  const now = new Date().toISOString();
  const roster = Array.from({ length: 16 }, (_, index) => `학생 ${index + 1}`);
  const events = [
    { id: "seed-event-1", category: "assessment", subject: "화학", title: "화학 실험 보고서", description: "실험 결과와 오차 분석을 포함해 제출", due_at: isoAfter(1), member_id: null, status: "scheduled", reminder_offsets: [4320, 1440, 0], notify_on_change: true },
    { id: "seed-event-2", category: "assessment", subject: "영어", title: "영어 발표", description: "3분 개인 발표", due_at: isoAfter(3, 9, 0), member_id: "seed-member-3", status: "scheduled", reminder_offsets: [4320, 1440, 0], notify_on_change: true },
    { id: "seed-event-3", category: "assignment", subject: "수학", title: "수학 탐구 과제", description: "탐구 주제 개요 제출", due_at: isoAfter(7), member_id: null, status: "scheduled", reminder_offsets: [10080, 4320, 1440], notify_on_change: true },
  ];
  const notices = [
    { id: "seed-notice-1", title: "이번 주 학급 일정 안내", body: "금요일 6교시 이후 학급 사진 촬영이 있습니다. 교복을 단정히 착용해 주세요.", status: "published", pinned: true, notify_on_publish: true, published_at: isoAfter(-1, 18, 20), created_at: isoAfter(-2, 15, 0) },
    { id: "seed-notice-2", title: "사물함 정리 안내", body: "방학 전 사물함 정리를 완료해 주세요.", status: "draft", pinned: false, notify_on_publish: true, published_at: null, created_at: isoAfter(-1, 12, 0) },
  ];
  const notifications = [
    { id: "seed-notification-1", kind: "daily_digest", status: "sent", scheduled_for: isoAfter(0, 7, 0), sent_at: isoAfter(0, 7, 0), payload: { title: "오늘 시간표" } },
    { id: "seed-notification-2", kind: "notice", status: "sent", scheduled_for: isoAfter(-1, 18, 20), sent_at: isoAfter(-1, 18, 20), payload: { title: "이번 주 학급 일정 안내" } },
    { id: "seed-notification-3", kind: "event_reminder", status: "failed", scheduled_for: isoAfter(-2, 18, 30), failure_reason: "카카오 채널 수신 동의가 필요합니다.", payload: { title: "수행평가 마감 안내" } },
    { id: "seed-notification-4", kind: "event_reminder", status: "reserved", scheduled_for: isoAfter(1, 7, 0), payload: { title: "화학 실험 보고서" } },
  ];
  const members = roster.map((displayName, index) => ({
    id: `seed-member-${index + 1}`,
    display_name: displayName,
    role: index === 0 ? "admin" : "student",
    status: index < 10 ? "active" : "invited",
    notification_enabled: index !== 6,
    daily_digest_enabled: index !== 6,
    joined_at: index < 10 ? now : null,
  }));

  return {
    classroom: { id: "class-2-4", code: "2-4", name: "2학년 4반", timezone: "Asia/Seoul", daily_digest_time: "07:00", daily_digest_enabled: true, max_members: 16 },
    members,
    timetable: buildTimetable(),
    events,
    notices,
    notifications,
    stats: { member_count: members.length, active_member_count: 10, scheduled_event_count: events.length, failed_notification_count: 1 },
  };
}
