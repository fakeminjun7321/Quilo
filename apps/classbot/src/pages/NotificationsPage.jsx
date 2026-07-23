import { BellRing, CircleAlert, RefreshCw, Send } from "lucide-react";
import { dateLabel, notificationLabels, notificationTitle } from "../lib/format.js";
import { NotificationStatus } from "./TodayPage.jsx";

export default function NotificationsPage({ notifications, onTest, onRefresh, busy }) {
  const ordered = [...notifications].sort((a, b) => new Date(b.scheduled_for) - new Date(a.scheduled_for));
  return (
    <div className="page">
      <div className="page-heading split"><div><h1>알림 기록</h1><p>카카오톡 알림 요청과 실제 전송 결과를 확인합니다.</p></div><div className="heading-actions"><button className="secondary-button" onClick={onRefresh} disabled={busy}><RefreshCw size={18} />새로고침</button><button className="outline-button" onClick={onTest} disabled={busy}><Send size={18} />{busy ? "요청 중" : "테스트 알림"}</button></div></div>
      <div className="info-banner"><BellRing size={20} /><p><strong>전송 요청과 성공은 다릅니다.</strong> ‘결과 확인 중’인 알림은 아직 카카오의 완료 결과가 확인되지 않은 상태입니다. 새로고침해 최신 상태를 확인하세요.</p></div>
      <section className="content-panel notification-table">
        <div className="notification-head"><span>요청 시각</span><span>유형</span><span>내용</span><span>상태</span><span>상세</span></div>
        {ordered.map((item) => <div className="notification-row" key={item.id}><time>{dateLabel(item.scheduled_for)}</time><span>{notificationLabels[item.kind] || item.kind}</span><strong>{notificationTitle(item)}</strong><NotificationStatus status={item.status} /><span className="failure-copy">{item.failure_reason || (item.status === "reserved" ? "카카오 처리 결과 확인 중" : "-")}</span></div>)}
        {!ordered.length && <div className="empty-state"><CircleAlert size={30} /><strong>아직 알림 기록이 없습니다.</strong></div>}
      </section>
    </div>
  );
}
