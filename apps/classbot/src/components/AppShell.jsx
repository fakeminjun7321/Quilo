import {
  CalendarDays, ChevronDown, Clock3,
  FolderOpen, LayoutDashboard, Megaphone, Plus, Settings, Users, X,
} from "lucide-react";

const navItems = [
  ["today", "오늘", LayoutDashboard],
  ["events", "일정", CalendarDays],
  ["notices", "공지", Megaphone],
  ["files", "자료실", FolderOpen],
  ["members", "구성원", Users],
  ["settings", "설정", Settings],
];

export function Brand() {
  return <div className="brand"><img src={`${import.meta.env.BASE_URL}quilo-chatbot-icon.png`} alt="" aria-hidden="true" /><span>Quilo schedule</span></div>;
}

export function Sidebar({
  active,
  onNavigate,
  classroom,
  memberCount,
  profileName = "구민준",
  profileRole = "관리자",
  menuLabel = "Quilo schedule 메뉴",
}) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav aria-label={menuLabel} className="side-nav">
        {navItems.map(([id, label, Icon]) => (
          <button key={id} className={active === id ? "nav-item active" : "nav-item"} onClick={() => onNavigate(id)}>
            <Icon size={21} aria-hidden="true" /><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="class-progress">
          <div className="progress-title"><Users size={18} /><strong>{classroom?.name || "2학년 4반"}</strong></div>
          <span>가입 {memberCount} / {classroom?.max_members || 16}명</span>
          <div className="progress"><span style={{ width: `${Math.min(100, memberCount / (classroom?.max_members || 16) * 100)}%` }} /></div>
        </div>
        <div className="profile-row"><span className="avatar">{profileName.slice(0, 1)}</span><span><strong>{profileName}</strong><small>{profileRole}</small></span><ChevronDown size={16} /></div>
      </div>
    </aside>
  );
}

export function Topbar({ classroom, action, onAction, demoMode = false }) {
  return (
    <header className="topbar">
      <div className="topbar-context"><button className="class-picker">{classroom?.name || "2학년 4반"}<ChevronDown size={17} /></button>{demoMode && <span className="demo-indicator">데모 모드 · 브라우저에만 저장</span>}</div>
      {action && <button className="primary-button top-action" onClick={onAction}><Plus size={19} />{action}</button>}
    </header>
  );
}

export function BottomNavigation({ active, onNavigate }) {
  return (
    <nav className="bottom-nav" aria-label="모바일 메뉴">
      {navItems.map(([id, label, Icon]) => (
        <button key={id} className={active === id ? "active" : ""} onClick={() => onNavigate(id)}><Icon size={20} /><span>{label}</span></button>
      ))}
    </nav>
  );
}

export function DrawerShell({ title, children, onClose, footer, open }) {
  if (!open) return null;
  return (
    <>
      <button className="drawer-scrim" aria-label="편집 창 닫기" onClick={onClose} />
      <aside className="drawer" aria-label={title}>
        <div className="drawer-header"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="닫기"><X size={22} /></button></div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>
  );
}

export function EmptyState({ icon: Icon = Clock3, title, body, action, onAction }) {
  return <div className="empty-state"><Icon size={30} /><strong>{title}</strong><p>{body}</p>{action && <button className="outline-button" onClick={onAction}>{action}</button>}</div>;
}
