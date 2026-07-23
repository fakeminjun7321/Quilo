import { Bell, Check, Clock3, LockKeyhole, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

export default function SettingsPage({ classroom, onSave, saving, onLogout }) {
  const [form, setForm] = useState(classroom || {});
  useEffect(() => setForm(classroom || {}), [classroom]);
  return (
    <div className="page settings-page">
      <div className="page-heading"><h1>설정</h1><p>학급 정보와 기본 알림 시간을 설정합니다.</p></div>
      <form onSubmit={(e) => { e.preventDefault(); onSave({ name: form.name, daily_digest_time: form.daily_digest_time, daily_digest_enabled: form.daily_digest_enabled }); }}>
        <section className="settings-section"><div className="settings-copy"><h2>학급 정보</h2><p>관리 화면과 카카오톡 안내에 표시됩니다.</p></div><div className="settings-fields"><label>학급 이름<input value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><label>학급 코드<input value={form.code || ""} disabled /></label></div></section>
        <section className="settings-section"><div className="settings-copy"><h2>매일 시간표 알림</h2><p>가입한 구성원에게 오늘의 시간표를 보냅니다.</p></div><div className="settings-fields"><label className="check-row"><input type="checkbox" checked={Boolean(form.daily_digest_enabled)} onChange={(e) => setForm({ ...form, daily_digest_enabled: e.target.checked })} /><span>매일 알림 사용</span></label><label>발송 요청 시각<span className="input-icon"><Clock3 size={18} /><input type="time" value={(form.daily_digest_time || "07:00").slice(0, 5)} onChange={(e) => setForm({ ...form, daily_digest_time: e.target.value })} /></span></label><p className="help-text">카카오 처리 상황에 따라 실제 도착 시각에는 약간의 차이가 있을 수 있습니다.</p></div></section>
        <div className="settings-save"><button className="primary-button" disabled={saving}><Save size={18} />{saving ? "저장 중" : "설정 저장"}</button></div>
      </form>
      <section className="settings-section account-section"><div className="settings-copy"><h2>관리자 계정</h2><p>현재 브라우저의 관리자 세션을 종료합니다.</p></div><div className="security-card"><ShieldCheck size={22} /><span><strong>관리자 세션 보호 중</strong><small>공용 기기에서는 사용 후 로그아웃하세요.</small></span><button className="outline-button" onClick={onLogout}><LockKeyhole size={17} />로그아웃</button></div></section>
    </div>
  );
}
