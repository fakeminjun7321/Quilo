import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, RotateCw } from "lucide-react";
import { api } from "./api/client.js";
import { BottomNavigation, Sidebar, Topbar } from "./components/AppShell.jsx";
import { EventDrawer, NoticeDrawer } from "./components/Editors.jsx";
import TodayPage from "./pages/TodayPage.jsx";
import EventsPage from "./pages/EventsPage.jsx";
import NoticesPage from "./pages/NoticesPage.jsx";
import FilesPage from "./pages/FilesPage.jsx";
import MembersPage from "./pages/MembersPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import PortalLogin from "./portal/PortalLogin.jsx";
import StudentPortal from "./portal/StudentPortal.jsx";

const actions = { today: "일정 추가", events: "일정 추가", notices: "공지 추가" };

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function ConnectionError({ message, onRetry }) {
  return <main className="connection-error"><div><AlertTriangle size={28} /><h1>관리 서버에 연결할 수 없습니다.</h1><p>{message || "잠시 후 다시 시도해 주세요."}</p><button className="outline-button" onClick={onRetry}><RotateCw size={17} />다시 시도</button></div></main>;
}

export default function App() {
  const [session, setSession] = useState(null);
  const [portalSession, setPortalSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [overview, setOverview] = useState(null);
  const [active, setActive] = useState("today");
  const [drawer, setDrawer] = useState({ type: null, item: null, open: false });
  const [fileLibrary, setFileLibrary] = useState({ items: [], loading: false, loaded: false, error: "", drive: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const flash = (message) => { setToast(message); window.setTimeout(() => setToast(""), 2800); };
  const load = async () => {
    setLoading(true); setLoadError("");
    try {
      const nextSession = await api.session();
      setSession(nextSession);
      if (nextSession.authenticated) {
        const data = await api.overview();
        setSession({ ...nextSession, demo: nextSession.demo || api.mode === "local" });
        setOverview(data);
        if (window.matchMedia("(min-width: 1181px)").matches) setDrawer({ type: "event", item: null, open: true });
      } else {
        setOverview(null);
        setDrawer({ type: null, item: null, open: false });
        setPortalSession(await api.portalSession());
      }
    } catch (err) {
      setLoadError(err.message || "관리 서버 요청에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const patchCollection = (collection, item) => setOverview((current) => ({ ...current, [collection]: current[collection].map((existing) => existing.id === item.id ? item : existing) }));
  const addCollection = (collection, item) => setOverview((current) => ({ ...current, [collection]: [item, ...current[collection]] }));
  const loadFiles = async () => {
    setFileLibrary((current) => ({ ...current, loading: true, error: "" }));
    try {
      const [result, drive] = await Promise.all([
        api.files(),
        api.driveStatus().catch(() => ({ configured: false, connected: false, reason: "status_unavailable" })),
      ]);
      const items = result.items || result.files || [];
      setFileLibrary({
        items,
        loading: false,
        loaded: true,
        error: "",
        drive: { ...drive, item_count: items.filter((item) => item.provider === "google_drive").length },
      });
    } catch (err) {
      setFileLibrary((current) => ({ ...current, loading: false, loaded: false, error: err.message || "자료 목록 요청에 실패했습니다." }));
    }
  };

  const loginPortal = async (credentials) => {
    setBusy(true); setError("");
    try { await api.portalLogin(credentials); setPortalSession(await api.portalSession()); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const logoutPortal = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await api.quiloLogout(); window.location.assign("/"); }
    catch (err) { setError(err.message || "로그아웃하지 못했습니다."); }
    finally { setBusy(false); }
  };

  const openCreate = () => setDrawer({ type: active === "notices" ? "notice" : "event", item: null, open: true });
  const closeDrawer = () => setDrawer((current) => ({ ...current, open: false }));
  const saveEvent = async (input) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = drawer.item ? await api.updateEvent(drawer.item.id, input) : await api.createEvent(input);
      drawer.item ? patchCollection("events", result.item) : addCollection("events", result.item);
      closeDrawer(); flash(drawer.item ? "일정을 수정했습니다." : "새 일정을 추가했습니다.");
    } catch (err) { flash(err.message); } finally { setBusy(false); }
  };
  const deleteEvent = async () => { if (busy || !drawer.item || !window.confirm("이 일정을 삭제할까요?")) return; setBusy(true); try { await api.deleteEvent(drawer.item.id); setOverview((current) => ({ ...current, events: current.events.filter((item) => item.id !== drawer.item.id) })); closeDrawer(); flash("일정을 삭제했습니다."); } finally { setBusy(false); } };
  const saveNotice = async (input) => { if (busy) return; setBusy(true); try { const result = drawer.item ? await api.updateNotice(drawer.item.id, input) : await api.createNotice(input); drawer.item ? patchCollection("notices", result.item) : addCollection("notices", result.item); closeDrawer(); flash("공지를 저장했습니다."); } catch (err) { flash(err.message); } finally { setBusy(false); } };
  const deleteNotice = async () => { if (busy || !drawer.item || !window.confirm("이 공지를 삭제할까요?")) return; setBusy(true); try { await api.deleteNotice(drawer.item.id); setOverview((current) => ({ ...current, notices: current.notices.filter((item) => item.id !== drawer.item.id) })); closeDrawer(); flash("공지를 삭제했습니다."); } finally { setBusy(false); } };
  const uploadFile = async (input) => { if (busy) return false; setBusy(true); try { const result = await api.uploadFile(input); setFileLibrary((current) => ({ ...current, items: [result.item, ...current.items], loaded: true, error: "" })); flash("자료를 업로드했습니다."); return true; } catch (err) { flash(err.message); return false; } finally { setBusy(false); } };
  const deleteFile = async (item) => { if (busy || !window.confirm(`'${item.alias || item.original_name || "자료"}'을 삭제할까요?`)) return; setBusy(true); try { await api.deleteFile(item.id); setFileLibrary((current) => ({ ...current, items: current.items.filter((file) => file.id !== item.id) })); flash("자료를 삭제했습니다."); } catch (err) { flash(err.message); } finally { setBusy(false); } };
  const copyFileLink = async (item) => { try { await copyText(api.fileShareUrl(item)); flash("자료 링크를 복사했습니다."); } catch { flash("링크를 복사하지 못했습니다."); } };
  const syncDrive = async () => {
    if (busy) return;
    setBusy(true);
    try { await api.syncDrive(); await loadFiles(); flash("Google Drive 자료를 동기화했습니다."); }
    catch (err) { flash(err.message || "Google Drive를 동기화하지 못했습니다."); }
    finally { setBusy(false); }
  };
  const navigate = (id) => { setActive(id); if (id === "files" && !fileLibrary.loaded && !fileLibrary.loading) loadFiles(); if (drawer.open) closeDrawer(); };

  const screen = useMemo(() => {
    if (!overview) return null;
    if (active === "today") return <TodayPage overview={overview} onEditEvent={(item) => setDrawer({ type: "event", item, open: true })} onNavigate={navigate} />;
    if (active === "events") return <EventsPage events={overview.events} members={overview.members} onEdit={(item) => setDrawer({ type: "event", item, open: true })} />;
    if (active === "notices") return <NoticesPage notices={overview.notices} onEdit={(item) => setDrawer({ type: "notice", item, open: true })} onSend={async (id) => { if (busy) return; setBusy(true); try { const result = await api.sendNotice(id); patchCollection("notices", result.item); flash("게시 요청을 접수했습니다. 전송 상태는 오늘 화면에서 확인할 수 있습니다."); } catch (err) { flash(err.message); } finally { setBusy(false); } }} />;
    if (active === "files") return <FilesPage files={fileLibrary.items} members={overview.members} busy={busy} loading={fileLibrary.loading} error={fileLibrary.error} drive={fileLibrary.drive} onDriveSync={syncDrive} onUpload={uploadFile} onDelete={deleteFile} onCopy={copyFileLink} onRefresh={loadFiles} downloadUrl={api.fileDownloadUrl} />;
    if (active === "members") return <MembersPage members={overview.members} classroom={overview.classroom} busy={busy} onCreate={async (input) => { if (busy) return false; setBusy(true); try { const result = await api.createMember(input); addCollection("members", result.item); flash("구성원을 추가했습니다."); return true; } catch (err) { flash(err.message); return false; } finally { setBusy(false); } }} onUpdate={async (id, patch) => { if (busy) return; setBusy(true); try { const result = await api.updateMember(id, patch); patchCollection("members", result.item); } catch (err) { flash(err.message); } finally { setBusy(false); } }} onInvite={async (id) => { if (busy) return; setBusy(true); try { const result = await api.inviteMember(id); await navigator.clipboard?.writeText(result.invite_url || result.code || ""); flash("초대 링크를 복사했습니다."); } catch (err) { flash(err.message); } finally { setBusy(false); } }} />;
    return <SettingsPage classroom={overview.classroom} saving={busy} onSave={async (patch) => { if (busy) return; setBusy(true); try { const result = await api.updateSettings(patch); setOverview((current) => ({ ...current, classroom: result.item })); flash("설정을 저장했습니다."); } catch (err) { flash(err.message); } finally { setBusy(false); } }} onLogout={async () => { await api.logout(); setSession({ authenticated: false }); setPortalSession({ authenticated: false }); setOverview(null); }} />;
  }, [active, overview, busy, drawer.item, fileLibrary]);

  if (loading) return <div className="app-loading"><RotateCw className="spin" /><span>학급 정보를 불러오는 중</span></div>;
  if (loadError && !overview) return <ConnectionError message={loadError} onRetry={load} />;
  if (!session) return <ConnectionError message="관리자 세션을 확인하지 못했습니다." onRetry={load} />;
  if (!session.authenticated) {
    if (portalSession?.authenticated) return <StudentPortal session={portalSession} onLogout={logoutPortal} />;
    return <PortalLogin onLogin={loginPortal} busy={busy} error={error} session={portalSession} embedded={api.embedded} />;
  }
  if (!overview) return <div className="app-loading"><AlertTriangle /><span>{error || "데이터를 불러오지 못했습니다."}</span><button className="outline-button" onClick={load}>다시 시도</button></div>;
  return (
    <div className={`app-shell ${drawer.open ? "drawer-open" : ""}`}>
      <Sidebar active={active} onNavigate={navigate} classroom={overview.classroom} memberCount={overview.members.length} profileName={session.actor?.name || "구민준"} profileRole="관리자" />
      <div className="workspace"><Topbar classroom={overview.classroom} action={actions[active]} onAction={openCreate} demoMode={session.demo || api.mode === "local"} /><main className="main-content">{screen}</main></div>
      <EventDrawer open={drawer.open && drawer.type === "event"} item={drawer.item} members={overview.members} onClose={closeDrawer} onSave={saveEvent} onDelete={deleteEvent} busy={busy} />
      <NoticeDrawer open={drawer.open && drawer.type === "notice"} item={drawer.item} onClose={closeDrawer} onSave={saveNotice} onDelete={deleteNotice} busy={busy} />
      <BottomNavigation active={active} onNavigate={navigate} />
      {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}</div>}
    </div>
  );
}
