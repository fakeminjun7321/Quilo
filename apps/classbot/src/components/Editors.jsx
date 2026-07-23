import { useEffect, useState } from "react";
import { CalendarDays, Check, Megaphone, Trash2 } from "lucide-react";
import { DrawerShell } from "./AppShell.jsx";
import { createIdempotencyKey } from "../api/client.js";
import { categoryLabels, fromLocalInput, toLocalInput } from "../lib/format.js";

const initialEvent = { category: "assessment", subject: "", title: "", description: "", due_at: "", member_id: null, reminder_offsets: [1440], notify_on_change: true, status: "scheduled" };

export function EventDrawer({ open, item, members = [], onClose, onSave, onDelete, busy }) {
  const [form, setForm] = useState(initialEvent);
  useEffect(() => setForm(item ? { ...initialEvent, ...item, due_at: toLocalInput(item.due_at) } : { ...initialEvent, request_key: createIdempotencyKey("event") }), [item, open]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const targetOptions = members
    .filter((member) => member.status !== "left")
    .sort((a, b) => a.display_name.localeCompare(b.display_name, "ko"));
  const selectedTargetMissing = form.member_id && !targetOptions.some((member) => member.id === form.member_id);
  const submit = (event) => {
    event.preventDefault();
    if (!form.title || !form.due_at) return;
    onSave({ ...form, due_at: fromLocalInput(form.due_at) });
  };
  const footer = <><button className="primary-button wide" form="event-form" disabled={busy}><Check size={18} />{busy ? "저장 중" : "저장"}</button><button className="secondary-button wide" type="button" onClick={onClose}>취소</button>{item && <button className="danger-text wide" type="button" onClick={onDelete}><Trash2 size={17} />일정 삭제</button>}</>;
  return (
    <DrawerShell open={open} title={item ? "일정 수정" : "일정 추가"} onClose={onClose} footer={footer}>
      <form id="event-form" className="editor-form" onSubmit={submit}>
        <label>유형 <span>*</span><select value={form.category} onChange={(e) => set("category", e.target.value)}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>대상 <span>*</span><select value={form.member_id || ""} onChange={(e) => set("member_id", e.target.value || null)}><option value="">반 전체</option>{selectedTargetMissing && <option value={form.member_id}>학생 정보 없음</option>}{targetOptions.map((member) => <option key={member.id} value={member.id}>{member.display_name}</option>)}</select></label>
        <label>과목 <span>*</span><input value={form.subject} onChange={(e) => set("subject", e.target.value)} placeholder="예: 화학" required /></label>
        <label>제목 <span>*</span><input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="제목을 입력하세요" required /></label>
        <label>마감일 <span>*</span><span className="input-icon"><CalendarDays size={18} /><input type="datetime-local" value={form.due_at} onChange={(e) => set("due_at", e.target.value)} required /></span></label>
        <label>설명<textarea value={form.description || ""} onChange={(e) => set("description", e.target.value)} placeholder="일정에 필요한 내용을 적어 주세요" rows="4" /></label>
        <fieldset><legend>알림</legend><label className="check-row"><input type="checkbox" checked={form.notify_on_change} onChange={(e) => set("notify_on_change", e.target.checked)} /><span>카카오톡 알림 보내기</span></label><select value={form.reminder_offsets?.[0] ?? 1440} onChange={(e) => set("reminder_offsets", [Number(e.target.value)])}><option value="0">마감 시각</option><option value="180">3시간 전</option><option value="1440">하루 전</option><option value="4320">3일 전</option></select><p className="help-text">알림은 지정한 시각에 전송을 요청하며, 실제 결과는 알림 기록에서 확인할 수 있습니다.</p></fieldset>
      </form>
    </DrawerShell>
  );
}

const initialNotice = { title: "", body: "", status: "draft", pinned: false, notify_on_publish: true };

export function NoticeDrawer({ open, item, onClose, onSave, onDelete, busy }) {
  const [form, setForm] = useState(initialNotice);
  useEffect(() => setForm(item ? { ...initialNotice, ...item } : { ...initialNotice, request_key: createIdempotencyKey("notice") }), [item, open]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  const footer = <><button className="primary-button wide" form="notice-form" disabled={busy}><Check size={18} />{busy ? "저장 중" : "저장"}</button><button className="secondary-button wide" onClick={onClose}>취소</button>{item && <button className="danger-text wide" onClick={onDelete}><Trash2 size={17} />공지 삭제</button>}</>;
  return (
    <DrawerShell open={open} title={item ? "공지 수정" : "공지 추가"} onClose={onClose} footer={footer}>
      <form id="notice-form" className="editor-form" onSubmit={(e) => { e.preventDefault(); if (form.title && form.body) onSave(form); }}>
        <div className="notice-form-icon"><Megaphone size={22} /></div>
        <label>제목 <span>*</span><input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="공지 제목" required /></label>
        <label>내용 <span>*</span><textarea value={form.body} onChange={(e) => set("body", e.target.value)} placeholder="학급에 알릴 내용을 적어 주세요" rows="9" required /></label>
        <label className="check-row"><input type="checkbox" checked={form.pinned} onChange={(e) => set("pinned", e.target.checked)} /><span>목록 상단에 고정</span></label>
        <label className="check-row"><input type="checkbox" checked={form.notify_on_publish} onChange={(e) => set("notify_on_publish", e.target.checked)} /><span>게시할 때 카카오톡 알림 요청</span></label>
      </form>
    </DrawerShell>
  );
}
