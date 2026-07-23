import { CheckCircle2, Copy, Link2, Plus, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { createIdempotencyKey } from "../api/client.js";

export default function MembersPage({ members, classroom, onCreate, onUpdate, onInvite, busy }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("student");
  const [requestKey, setRequestKey] = useState(() => createIdempotencyKey("member"));
  const active = members.filter((item) => item.status === "active").length;
  return (
    <div className="page">
      <div className="page-heading"><h1>구성원</h1><p>학급 구성원과 카카오톡 가입 상태를 관리합니다.</p></div>
      <div className="metric-strip"><div><Users size={20} /><span><strong>{members.length}</strong><small>전체 구성원</small></span></div><div><CheckCircle2 size={20} /><span><strong>{active}</strong><small>가입 완료</small></span></div><div><Link2 size={20} /><span><strong>{members.length - active}</strong><small>초대 대기</small></span></div></div>
      <form className="inline-create" onSubmit={async (e) => { e.preventDefault(); if (!name.trim() || busy) return; const saved = await onCreate({ display_name: name.trim(), role, request_key: requestKey }); if (saved !== false) { setName(""); setRequestKey(createIdempotencyKey("member")); } }}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="구성원 이름" aria-label="구성원 이름" disabled={busy} /><select value={role} onChange={(e) => setRole(e.target.value)} aria-label="역할" disabled={busy}><option value="student">학생</option><option value="admin">관리자</option></select><button className="primary-button" disabled={busy}><Plus size={18} />{busy ? "저장 중" : "구성원 추가"}</button></form>
      <section className="content-panel member-table">
        <div className="member-head"><span>이름</span><span>역할</span><span>가입 상태</span><span>일일 알림</span><span>작업</span></div>
        {members.map((member) => <div className="member-row" key={member.id}><span className="member-name"><i>{member.display_name.slice(0, 1)}</i><strong>{member.display_name}</strong></span><select value={member.role} onChange={(e) => onUpdate(member.id, { role: e.target.value })} disabled={busy}><option value="student">학생</option><option value="admin">관리자</option></select><span className={`member-status ${member.status}`}>{member.status === "active" ? "가입 완료" : member.status === "invited" ? "초대 대기" : "사용 중지"}</span><label className="switch"><input type="checkbox" checked={member.daily_digest_enabled} onChange={(e) => onUpdate(member.id, { daily_digest_enabled: e.target.checked })} disabled={busy} /><span /></label>{member.status === "invited" ? <button className="small-button" onClick={() => onInvite(member.id)} disabled={busy}>초대 링크</button> : <span className="member-action-empty">-</span>}</div>)}
      </section>
    </div>
  );
}
