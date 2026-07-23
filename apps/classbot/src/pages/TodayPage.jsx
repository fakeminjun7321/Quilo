import { Beaker, Bell, CheckCircle2, ChevronRight, CircleAlert, Clock3, Mic2, Radical } from "lucide-react";
import { dateLabel, dayDistance, eventTargetLabel, notificationTitle, todayWeekday } from "../lib/format.js";

const eventIcons = [Beaker, Mic2, Radical];

function EventSummary({ events, members, onOpen, onAll }) {
  const upcoming = events.filter((item) => item.status === "scheduled").sort((a, b) => new Date(a.due_at) - new Date(b.due_at)).slice(0, 3);
  return (
    <section className="home-panel">
      <h2>다가오는 수행평가</h2>
      <div className="border-list">
        {upcoming.map((item, index) => {
          const Icon = eventIcons[index % eventIcons.length];
          const days = dayDistance(item.due_at);
          return <button className="event-summary-row" key={item.id} onClick={() => onOpen(item)}><span className={`round-icon tone-${index}`}><Icon size={20} /></span><span className="row-copy"><strong>{item.subject} {item.title.replace(item.subject, "").trim()}</strong><small>{dateLabel(item.due_at)} · {eventTargetLabel(item, members)}</small></span><span className="deadline">{days === 0 ? "오늘" : days === 1 ? "내일" : `D-${days}`}</span><ChevronRight size={18} /></button>;
        })}
        <button className="list-more" onClick={onAll}>전체 보기 <ChevronRight size={17} /></button>
      </div>
    </section>
  );
}

function NotificationSummary({ notifications }) {
  const recent = [...notifications].sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for)).slice(0, 3);
  const next = notifications.find((item) => item.status === "reserved");
  return (
    <section className="home-panel">
      <h2>다음 알림</h2>
      <div className="border-list notification-summary">
        <div className="next-notification"><span className="square-icon"><Bell size={18} /></span><span><strong>{next ? dateLabel(next.scheduled_for) : "예정된 알림 없음"}</strong><small>{next ? notificationTitle(next) : "설정된 알림이 없습니다"}</small></span></div>
        <div className="list-subtitle">최근 알림 상태</div>
        {recent.map((item) => <div className="notification-mini-row" key={item.id}><span>{dateLabel(item.scheduled_for)}</span><span>{notificationTitle(item)}</span><NotificationStatus status={item.status} /></div>)}
      </div>
    </section>
  );
}

export function NotificationStatus({ status }) {
  if (status === "sent") return <span className="status-label sent">전송 완료 <CheckCircle2 size={15} /></span>;
  if (status === "failed") return <span className="status-label failed">전송 실패 <CircleAlert size={15} /></span>;
  if (status === "skipped") return <span className="status-label skipped">건너뜀</span>;
  return <span className="status-label reserved">결과 확인 중 <Clock3 size={15} /></span>;
}

export default function TodayPage({ overview, onEditEvent, onNavigate }) {
  const weekday = todayWeekday();
  const rows = overview.timetable.filter((item) => item.weekday === weekday).sort((a, b) => a.period - b.period).slice(0, 4);
  const fullDate = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(new Date());
  return (
    <div className="page today-page">
      <div className="page-heading split"><div><h1>오늘의 학급 운영</h1><p className="date-emphasis">{fullDate}</p></div></div>
      <div className="timetable-table compact-table">
        <div className="table-head"><span>교시</span><span>과목</span><span>수업/활동</span><span>담당 선생님</span><span>메모</span><span>작업</span></div>
        {rows.map((row) => <div className="table-row" key={row.id}><span className="period-cell"><i className="drag-dots">⠿</i>{row.period}교시</span><strong>{row.subject}</strong><span>{row.activity || "-"}</span><span>{row.teacher || "-"}</span><span className="muted-cell">{row.memo || "-"}</span><span>-</span></div>)}
      </div>
      <div className="home-grid"><EventSummary events={overview.events} members={overview.members} onOpen={onEditEvent} onAll={() => onNavigate("events")} /><NotificationSummary notifications={overview.notifications} /></div>
    </div>
  );
}
