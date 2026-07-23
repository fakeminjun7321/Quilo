import {
  AlertTriangle, CalendarClock, Check, ChevronLeft, ChevronRight, Clock3, Megaphone, Plus, RotateCw, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, createIdempotencyKey } from "../api/client.js";
import { categoryLabels, fromLocalInput, toLocalInput } from "../lib/format.js";

const weekLabels = ["일", "월", "화", "수", "목", "금", "토"];
const categoryTone = { assessment: "assessment", assignment: "assignment", class: "class", schedule_change: "class" };

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(date, amount) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount);
}

function startOfWeek(date) {
  return addDays(date, -date.getDay());
}

function rangeFor(view, cursor) {
  if (view === "day") return { start: cursor, end: cursor, days: [cursor] };
  const start = view === "week" ? startOfWeek(cursor) : startOfWeek(new Date(cursor.getFullYear(), cursor.getMonth(), 1));
  const count = view === "week" ? 7 : 42;
  const days = Array.from({ length: count }, (_, index) => addDays(start, index));
  return { start, end: days[days.length - 1], days };
}

function shiftCursor(cursor, view, direction) {
  if (view === "month") return new Date(cursor.getFullYear(), cursor.getMonth() + direction, 1);
  return addDays(cursor, direction * (view === "week" ? 7 : 1));
}

function titleFor(view, cursor, range) {
  if (view === "month") return `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`;
  if (view === "day") return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", weekday: "long" }).format(cursor);
  const start = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(range.start);
  const end = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" }).format(range.end);
  return `${start} – ${end}`;
}

function eventTime(event) {
  const value = event.due_at || event.starts_at;
  if (!value) return "";
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function EventChip({ event, compact = false }) {
  const tone = categoryTone[event.category] || "neutral";
  return <span className={`portal-event-chip ${tone} ${compact ? "compact" : ""}`} title={event.title}><i />{!compact && eventTime(event) && <time>{eventTime(event)}</time>}<strong>{event.title}</strong></span>;
}

function eventFormFor(date) {
  const due = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 17, 0, 0, 0);
  return { title: "", category: "assignment", subject: "", description: "", due_at: toLocalInput(due), scope: "self", request_key: createIdempotencyKey("portal-event") };
}

function PortalEventModal({ open, date, isAdmin, saving, error, onClose, onSave }) {
  const [form, setForm] = useState(() => eventFormFor(date));
  useEffect(() => { if (open) setForm(eventFormFor(date)); }, [open, date]);
  if (!open) return null;
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  return <div className="portal-modal-layer"><button className="portal-modal-scrim" onClick={onClose} aria-label="일정 추가 창 닫기" /><section className="portal-event-modal" role="dialog" aria-modal="true" aria-labelledby="portal-event-title"><header><h2 id="portal-event-title">일정 추가</h2><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={21} /></button></header><form onSubmit={(event) => { event.preventDefault(); if (form.title.trim() && form.due_at && !saving) onSave({ ...form, title: form.title.trim(), subject: form.subject.trim(), description: form.description.trim(), due_at: fromLocalInput(form.due_at), scope: isAdmin ? form.scope : "self" }); }}>
    <label>제목 <span>*</span><input value={form.title} onChange={(event) => set("title", event.target.value)} placeholder="일정 제목" required autoFocus disabled={saving} /></label>
    <div className="portal-modal-row"><label>유형 <span>*</span><select value={form.category} onChange={(event) => set("category", event.target.value)} disabled={saving}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>과목<input value={form.subject} onChange={(event) => set("subject", event.target.value)} placeholder="선택 입력" disabled={saving} /></label></div>
    <label>일시 <span>*</span><input type="datetime-local" value={form.due_at} onChange={(event) => set("due_at", event.target.value)} required disabled={saving} /></label>
    {isAdmin ? <label>공개 범위 <span>*</span><select value={form.scope} onChange={(event) => set("scope", event.target.value)} disabled={saving}><option value="self">나만 보기</option><option value="class">반 전체 공개</option></select></label> : <div className="portal-personal-scope"><strong>나만 보기</strong><span>이 일정은 내 캘린더에만 표시됩니다.</span></div>}
    <label>설명<textarea value={form.description} onChange={(event) => set("description", event.target.value)} placeholder="필요한 내용을 적어 주세요" rows="4" disabled={saving} /></label>
    {error && <p className="form-error"><AlertTriangle size={16} />{error}</p>}
    <footer><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" disabled={saving || !form.title.trim() || !form.due_at}><Check size={17} />{saving ? "저장 중" : "저장"}</button></footer>
  </form></section></div>;
}

export default function PortalCalendar({ onOverview, initialView = "month" }) {
  const [view, setView] = useState(initialView);
  const [cursor, setCursor] = useState(() => new Date());
  const [data, setData] = useState({ member: null, classroom: null, timetable: [], events: [], notices: [], members: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [eventModalOpen, setEventModalOpen] = useState(false);
  const [eventSaving, setEventSaving] = useState(false);
  const [eventError, setEventError] = useState("");
  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const from = dateKey(range.start);
  const to = dateKey(range.end);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    api.portalOverview(from, to).then((result) => {
      if (cancelled) return;
      const next = { member: result.member || null, classroom: result.classroom || null, timetable: result.timetable || [], events: (result.events || []).filter((event) => event.status !== "cancelled"), notices: result.notices || [], members: result.members || [] };
      setData(next); onOverview?.(next);
    }).catch((err) => { if (!cancelled) setError(err.message || "일정을 불러오지 못했습니다."); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [from, to, onOverview, reloadKey]);

  const eventsByDay = useMemo(() => {
    const grouped = new Map();
    data.events.forEach((event) => {
      const value = event.due_at || event.starts_at;
      if (!value) return;
      const key = dateKey(new Date(value));
      grouped.set(key, [...(grouped.get(key) || []), event]);
    });
    grouped.forEach((events) => events.sort((a, b) => new Date(a.due_at || a.starts_at) - new Date(b.due_at || b.starts_at)));
    return grouped;
  }, [data.events]);

  const todayKey = dateKey(new Date());
  const latestNotice = [...data.notices].sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0))[0];
  const selectedEvents = eventsByDay.get(dateKey(cursor)) || [];
  const weekday = cursor.getDay();
  const selectedTimetable = data.timetable.filter((item) => Number(item.weekday) === weekday).sort((a, b) => Number(a.period) - Number(b.period));
  const saveEvent = async (input) => {
    setEventSaving(true); setEventError("");
    try { await api.portalCreateEvent(input); setEventModalOpen(false); setReloadKey((value) => value + 1); }
    catch (err) { setEventError(err.message || "일정을 저장하지 못했습니다."); }
    finally { setEventSaving(false); }
  };

  return (
    <section className="portal-calendar-page">
      <div className="portal-calendar-toolbar">
        <div className="portal-date-navigation"><button className="icon-button" onClick={() => setCursor(shiftCursor(cursor, view, -1))} aria-label="이전 기간"><ChevronLeft size={19} /></button><button className="portal-today-button" onClick={() => setCursor(new Date())}>오늘</button><button className="icon-button" onClick={() => setCursor(shiftCursor(cursor, view, 1))} aria-label="다음 기간"><ChevronRight size={19} /></button></div>
        <h1>{titleFor(view, cursor, range)}</h1>
        <div className="portal-calendar-actions"><div className="portal-view-switch" aria-label="캘린더 보기"><button className={view === "month" ? "active" : ""} onClick={() => setView("month")}>월</button><button className={view === "week" ? "active" : ""} onClick={() => setView("week")}>주</button><button className={view === "day" ? "active" : ""} onClick={() => setView("day")}>일</button></div><button className="primary-button portal-add-event" onClick={() => { setEventError(""); setEventModalOpen(true); }}><Plus size={18} />일정 추가</button></div>
      </div>

      {latestNotice && <div className="portal-notice-strip"><Megaphone size={17} /><strong>{latestNotice.title}</strong><span>{latestNotice.body}</span></div>}
      {loading && <div className="portal-calendar-state"><RotateCw className="spin" size={23} /><span>내 일정을 불러오는 중</span></div>}
      {!loading && error && <div className="portal-calendar-state error"><CalendarClock size={25} /><strong>일정을 불러오지 못했습니다.</strong><p>{error}</p></div>}

      {!loading && !error && view === "month" && <div className="portal-month-calendar content-panel"><div className="portal-month-weekdays">{weekLabels.map((label) => <span key={label}>{label}</span>)}</div><div className="portal-month-grid">{range.days.map((day) => {
        const key = dateKey(day); const dayEvents = eventsByDay.get(key) || []; const outside = day.getMonth() !== cursor.getMonth();
        return <button key={key} className={`portal-month-day ${outside ? "outside" : ""} ${key === todayKey ? "today" : ""}`} onClick={() => { setCursor(day); setView("day"); }}><span className="portal-day-number">{day.getDate()}</span><span className="portal-cell-events">{dayEvents.slice(0, 3).map((event) => <EventChip key={event.id} event={event} compact />)}{dayEvents.length > 3 && <small>+{dayEvents.length - 3}개</small>}</span></button>;
      })}</div></div>}

      {!loading && !error && view === "week" && <div className="portal-week-grid">{range.days.map((day) => {
        const key = dateKey(day); const dayEvents = eventsByDay.get(key) || [];
        return <section className={`portal-week-day ${key === todayKey ? "today" : ""}`} key={key}><button className="portal-week-heading" onClick={() => { setCursor(day); setView("day"); }}><span>{weekLabels[day.getDay()]}</span><strong>{day.getDate()}</strong></button><div className="portal-week-events">{dayEvents.map((event) => <EventChip key={event.id} event={event} />)}{!dayEvents.length && <small>일정 없음</small>}</div></section>;
      })}</div>}

      {!loading && !error && view === "day" && <div className="portal-day-layout">
        <section className="content-panel portal-day-panel"><div className="section-line"><h2>오늘 시간표</h2><span>{selectedTimetable.length}교시</span></div><div className="portal-timetable-list">{selectedTimetable.map((item) => <div className="portal-timetable-row" key={item.id || `${item.weekday}-${item.period}`}><span>{item.period}교시</span><strong>{item.subject}</strong><small>{item.activity || item.memo || "수업"}</small></div>)}{!selectedTimetable.length && <div className="portal-small-empty"><Clock3 size={23} /><span>{weekday === 0 || weekday === 6 ? "주말에는 시간표가 없습니다." : "등록된 시간표가 없습니다."}</span></div>}</div></section>
        <section className="content-panel portal-day-panel"><div className="section-line"><h2>오늘 일정</h2><span>{selectedEvents.length}개</span></div><div className="portal-day-events">{selectedEvents.map((event) => <article className={`portal-day-event ${categoryTone[event.category] || "neutral"}`} key={event.id}><span className="portal-event-time">{eventTime(event) || "종일"}</span><span><small>{categoryLabels[event.category] || "일정"}{event.subject ? ` · ${event.subject}` : ""}</small><strong>{event.title}</strong>{event.description && <p>{event.description}</p>}</span></article>)}{!selectedEvents.length && <div className="portal-small-empty"><CalendarClock size={23} /><span>이날 예정된 일정이 없습니다.</span></div>}</div></section>
      </div>}
      <PortalEventModal open={eventModalOpen} date={cursor} isAdmin={data.member?.role === "admin"} saving={eventSaving} error={eventError} onClose={() => { if (!eventSaving) setEventModalOpen(false); }} onSave={saveEvent} />
    </section>
  );
}
