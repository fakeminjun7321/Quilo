import { LogOut, Megaphone, Settings, ShieldCheck, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BottomNavigation, Sidebar, Topbar } from "../components/AppShell.jsx";
import { dateLabel } from "../lib/format.js";
import PortalCalendar from "./PortalCalendar.jsx";
import PortalDrive from "./PortalDrive.jsx";

function NoticesView({ notices }) {
  const ordered = useMemo(() => [...(notices || [])].sort((a, b) => (
    Number(b.pinned) - Number(a.pinned)
    || new Date(b.published_at || b.created_at || 0) - new Date(a.published_at || a.created_at || 0)
  )), [notices]);
  return (
    <section className="page portal-simple-page">
      <div className="page-heading"><h1>공지</h1><p>2학년 4반에 게시된 공지를 확인합니다.</p></div>
      <div className="content-panel portal-simple-list">
        {ordered.map((notice) => <article key={notice.id}><span className="portal-simple-icon"><Megaphone size={19} /></span><span><small>{notice.pinned ? "중요 공지 · " : ""}{dateLabel(notice.published_at || notice.created_at)}</small><strong>{notice.title}</strong><p>{notice.body}</p></span></article>)}
        {!ordered.length && <div className="empty-state"><Megaphone size={30} /><strong>게시된 공지가 없습니다.</strong><p>새 공지가 올라오면 이곳에 표시됩니다.</p></div>}
      </div>
    </section>
  );
}

function MembersView({ members }) {
  const ordered = useMemo(() => [...(members || [])].sort((a, b) => (
    Number(b.role === "admin") - Number(a.role === "admin")
    || a.display_name.localeCompare(b.display_name, "ko")
  )), [members]);
  return (
    <section className="page portal-simple-page">
      <div className="page-heading"><h1>구성원</h1><p>Quilo schedule을 함께 사용하는 2학년 4반 구성원입니다.</p></div>
      <div className="content-panel portal-member-grid">
        {ordered.map((member) => <article key={member.id}><span>{member.display_name.slice(0, 1)}</span><strong>{member.display_name}</strong><small>{member.role === "admin" ? "관리자 · 반장" : "학생"}</small></article>)}
      </div>
    </section>
  );
}

function SettingsView({ member, classroom, onLogout }) {
  return (
    <section className="page portal-simple-page">
      <div className="page-heading"><h1>설정</h1><p>Quilo 계정과 학급 연결 상태를 확인합니다.</p></div>
      <div className="content-panel portal-account-settings">
        <div className="portal-settings-copy"><span className="portal-simple-icon"><ShieldCheck size={21} /></span><span><small>로그인 계정</small><strong>{member?.display_name || "학생"}</strong><p>1회용 초대 코드로 {classroom?.name || "2학년 4반"} 명단과 안전하게 연결되었습니다.</p></span></div>
        <div className="portal-settings-actions"><a className="outline-button" href="/#settings"><Settings size={18} />Quilo 계정 설정</a><button className="secondary-button" onClick={onLogout}><LogOut size={18} />로그아웃</button></div>
      </div>
    </section>
  );
}

export default function StudentPortal({ session, onLogout }) {
  const [active, setActive] = useState("today");
  const [identity, setIdentity] = useState({ member: session?.member || null, classroom: session?.classroom || null, members: [], notices: [] });
  useEffect(() => setIdentity((current) => ({ ...current, member: session?.member || current.member, classroom: session?.classroom || current.classroom })), [session]);
  const receiveOverview = useCallback((overview) => setIdentity((current) => ({
    member: overview.member || current.member,
    classroom: overview.classroom || current.classroom,
    members: overview.members || current.members,
    notices: overview.notices || current.notices,
  })), []);
  const memberName = identity.member?.display_name || session?.member?.display_name || "학생";
  const classroom = identity.classroom || session?.classroom || { name: "2학년 4반", max_members: 16 };
  const profileRole = identity.member?.role === "admin" ? "관리자 · 반장" : "학생";

  let screen;
  if (active === "today") screen = <PortalCalendar key="today" initialView="day" onOverview={receiveOverview} />;
  else if (active === "events") screen = <PortalCalendar key="events" initialView="month" onOverview={receiveOverview} />;
  else if (active === "notices") screen = <NoticesView notices={identity.notices} />;
  else if (active === "files") screen = <PortalDrive />;
  else if (active === "members") screen = <MembersView members={identity.members} />;
  else screen = <SettingsView member={identity.member} classroom={classroom} onLogout={onLogout} />;

  return (
    <div className="app-shell portal-member-shell">
      <Sidebar active={active} onNavigate={setActive} classroom={classroom} memberCount={identity.members.length} profileName={memberName} profileRole={profileRole} menuLabel="학생 메뉴" />
      <div className="workspace"><Topbar classroom={classroom} /><main className="main-content portal-member-main">{screen}</main></div>
      <BottomNavigation active={active} onNavigate={setActive} />
    </div>
  );
}
