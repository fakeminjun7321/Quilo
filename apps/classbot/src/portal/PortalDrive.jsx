import { Download, ExternalLink, FileImage, FileText, FolderOpen, RotateCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { dateLabel } from "../lib/format.js";

function fileName(item) {
  return item.alias || item.title || item.filename || item.original_name || "학급 자료";
}

function originalName(item) {
  return item.filename || item.original_name || item.file_name || "파일";
}

function fileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "용량 정보 없음";
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 ** 2).toFixed(size < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

export default function PortalDrive() {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true); setError("");
    api.portalFiles().then((result) => setFiles(result.items || [])).catch((err) => setError(err.message || "자료를 불러오지 못했습니다.")).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("ko-KR");
    return [...files].filter((item) => !needle || [fileName(item), originalName(item), item.description].some((value) => String(value || "").toLocaleLowerCase("ko-KR").includes(needle))).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }, [files, query]);

  return (
    <section className="portal-drive-page">
      <div className="portal-page-heading"><div><h1>자료실</h1><p>나에게 공개된 학급 PDF와 이미지를 확인할 수 있습니다.</p></div><label className="portal-drive-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="자료 검색" aria-label="자료 검색" /></label></div>
      <section className="content-panel portal-drive-list">
        <div className="section-line"><h2>공유 자료</h2><span>{visible.length}개</span></div>
        {loading && <div className="portal-calendar-state"><RotateCw className="spin" size={23} /><span>공유 자료를 불러오는 중</span></div>}
        {!loading && error && <div className="empty-state"><FolderOpen size={30} /><strong>자료를 불러오지 못했습니다.</strong><p>{error}</p><button className="outline-button" onClick={load}>다시 시도</button></div>}
        {!loading && !error && visible.map((item) => {
          const isImage = String(item.mime_type || item.content_type || "").startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(originalName(item));
          return <article className="portal-drive-row" key={item.id}><span className={`portal-file-icon ${isImage ? "image" : "pdf"}`}>{isImage ? <FileImage size={22} /> : <FileText size={22} />}</span><span className="portal-file-copy"><strong>{fileName(item)}</strong><small>{originalName(item)} · {fileSize(item.size_bytes ?? item.size)}</small>{item.description && <p>{item.description}</p>}<time>{dateLabel(item.created_at)}</time></span><span className="portal-file-scope">{item.visibility === "private" || item.member_id ? "개인 자료" : "반 전체"}</span><span className="portal-drive-actions">{item.open_url && <a className="outline-button" href={api.portalFileUrl(item.open_url)} target="_blank" rel="noreferrer"><ExternalLink size={17} />열기</a>}{item.download_url && <a className="secondary-button" href={api.portalFileUrl(item.download_url)} download><Download size={17} />다운로드</a>}</span></article>;
        })}
        {!loading && !error && !visible.length && <div className="empty-state"><FolderOpen size={30} /><strong>{query ? "검색 결과가 없습니다." : "공유된 자료가 없습니다."}</strong><p>{query ? "다른 검색어를 입력해 보세요." : "관리자가 자료를 공유하면 이곳에 표시됩니다."}</p></div>}
      </section>
    </section>
  );
}
