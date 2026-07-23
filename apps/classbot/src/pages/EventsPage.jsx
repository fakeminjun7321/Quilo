import { CalendarClock, ChevronRight, Filter, Search, UserRound } from "lucide-react";
import { categoryLabels, dateLabel, dayDistance, eventTargetLabel } from "../lib/format.js";

export default function EventsPage({ events, members, onEdit }) {
  const ordered = [...events].sort((a, b) => new Date(a.due_at) - new Date(b.due_at));
  return (
    <div className="page">
      <div className="page-heading"><h1>일정</h1><p>수행평가와 과제, 학급 일정을 한곳에서 관리합니다.</p></div>
      <div className="toolbar"><label className="search-box"><Search size={18} /><input placeholder="일정 검색" /></label><button className="filter-button"><Filter size={17} />예정된 일정</button></div>
      <section className="content-panel event-list-panel">
        <div className="section-line"><h2>예정된 일정</h2><span>{ordered.filter((item) => item.status === "scheduled").length}개</span></div>
        {ordered.map((item) => {
          const days = dayDistance(item.due_at);
          return <button className="large-list-row" key={item.id} onClick={() => onEdit(item)}><span className="date-tile"><strong>{new Date(item.due_at).getDate()}</strong><small>{new Intl.DateTimeFormat("ko-KR", { month: "short" }).format(new Date(item.due_at))}</small></span><span className="row-copy"><span className="meta-line"><b>{categoryLabels[item.category] || item.category}</b>{item.subject && <em>{item.subject}</em>}<em className="event-target"><UserRound size={12} />{eventTargetLabel(item, members)}</em></span><strong>{item.title}</strong><small>{item.description || "세부 설명이 없습니다."}</small></span><span className="due-column"><b className={days <= 1 ? "urgent" : ""}>{days === 0 ? "오늘 마감" : days === 1 ? "내일 마감" : `D-${days}`}</b><small>{dateLabel(item.due_at)}</small></span><ChevronRight size={19} /></button>;
        })}
        {!ordered.length && <div className="empty-state"><CalendarClock size={30} /><strong>아직 일정이 없습니다.</strong><p>일정을 추가하면 알림까지 함께 관리할 수 있어요.</p></div>}
      </section>
    </div>
  );
}
