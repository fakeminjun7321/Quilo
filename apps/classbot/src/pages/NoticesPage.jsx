import { Bell, ChevronRight, Megaphone, Pin, Send } from "lucide-react";
import { dateLabel } from "../lib/format.js";

export default function NoticesPage({ notices, onEdit, onSend }) {
  const ordered = [...notices].sort((a, b) => Number(b.pinned) - Number(a.pinned) || new Date(b.created_at) - new Date(a.created_at));
  return (
    <div className="page">
      <div className="page-heading"><h1>반 공지</h1><p>학급 공지를 작성하고 카카오톡으로 함께 알릴 수 있습니다.</p></div>
      <section className="content-panel notice-list">
        <div className="section-line"><h2>공지 목록</h2><span>{notices.length}개</span></div>
        {ordered.map((item) => <article className="notice-row" key={item.id}><button className="notice-main" onClick={() => onEdit(item)}><span className={item.status === "published" ? "notice-icon published" : "notice-icon"}><Megaphone size={20} /></span><span className="row-copy"><span className="meta-line">{item.pinned && <b><Pin size={12} />고정</b>}<em>{item.status === "published" ? "게시됨" : item.status === "archived" ? "보관됨" : "작성 중"}</em></span><strong>{item.title}</strong><small>{item.body}</small><time>{dateLabel(item.published_at || item.created_at)}</time></span><ChevronRight size={19} /></button>{item.status !== "published" && <button className="outline-button send-notice" onClick={() => onSend(item.id)}><Send size={17} />게시 및 알림</button>}</article>)}
        {!ordered.length && <div className="empty-state"><Bell size={30} /><strong>등록된 공지가 없습니다.</strong></div>}
      </section>
    </div>
  );
}
