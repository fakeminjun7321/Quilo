import { Check, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { weekdays } from "../lib/format.js";

export default function TimetablePage({ timetable, onSave, saving }) {
  const today = new Date().getDay();
  const [weekday, setWeekday] = useState(today >= 1 && today <= 5 ? today : 1);
  const [rows, setRows] = useState([]);
  useEffect(() => {
    const current = timetable.filter((item) => item.weekday === weekday).sort((a, b) => a.period - b.period);
    setRows(current.length ? current : Array.from({ length: 7 }, (_, index) => ({ weekday, period: index + 1, subject: "", activity: "", teacher: "", room: "", memo: "" })));
  }, [weekday, timetable]);
  const update = (index, key, value) => setRows((current) => current.map((row, i) => i === index ? { ...row, [key]: value } : row));
  const addRow = () => setRows((current) => [...current, { weekday, period: current.length + 1, subject: "", activity: "", teacher: "", room: "", memo: "" }]);
  return (
    <div className="page timetable-page">
      <div className="page-heading split"><div><h1>시간표</h1><p>요일별 수업 정보를 수정하고 한 번에 저장합니다.</p></div><button className="primary-button" disabled={saving} onClick={() => onSave(weekday, rows)}><Save size={18} />{saving ? "저장 중" : "변경사항 저장"}</button></div>
      <div className="weekday-tabs" role="tablist">{weekdays.map((label, index) => <button role="tab" aria-selected={weekday === index + 1} className={weekday === index + 1 ? "active" : ""} key={label} onClick={() => setWeekday(index + 1)}>{label}요일</button>)}</div>
      <div className="editable-table">
        <div className="edit-head"><span>교시</span><span>과목</span><span>수업/활동</span><span>담당 선생님</span><span>메모</span><span /></div>
        {rows.map((row, index) => <div className="edit-row" key={row.id || index}><strong>{index + 1}교시</strong><input value={row.subject} onChange={(e) => update(index, "subject", e.target.value)} placeholder="과목" /><input value={row.activity} onChange={(e) => update(index, "activity", e.target.value)} placeholder="수업 내용" /><input value={row.teacher || ""} onChange={(e) => update(index, "teacher", e.target.value)} placeholder="선생님" /><input value={row.memo || ""} onChange={(e) => update(index, "memo", e.target.value)} placeholder="메모" /><button className="icon-button danger" onClick={() => setRows((current) => current.filter((_, i) => i !== index))} aria-label={`${index + 1}교시 삭제`}><Trash2 size={17} /></button></div>)}
      </div>
      <div className="table-actions"><button className="outline-button" onClick={addRow}><Plus size={18} />교시 추가</button><p><Check size={16} />과목이 비어 있는 교시는 시간표에서 표시되지 않습니다.</p></div>
    </div>
  );
}
