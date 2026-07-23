import { useMemo, useRef, useState } from "react";
import {
  Cloud, Copy, ExternalLink, FileImage, FileText, FolderOpen, LoaderCircle,
  LockKeyhole, RefreshCw, Trash2, Upload, Users, X,
} from "lucide-react";
import { dateLabel } from "../lib/format.js";

const ACCEPTED_TYPES = "application/pdf,image/jpeg,image/png,image/webp,image/gif";
const ACCEPTED_EXTENSIONS = /\.(pdf|png|jpe?g|webp|gif)$/i;

function isAcceptedFile(file) {
  return ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/gif"].includes(file?.type) || ACCEPTED_EXTENSIONS.test(file?.name || "");
}

function originalName(item) {
  return item.original_name || item.original_filename || item.file_name || item.filename || "파일";
}

function fileMime(item) {
  return item.mime_type || item.content_type || "";
}

function fileSize(item) {
  const value = Number(item.size_bytes ?? item.size ?? item.file_size ?? item.byte_size);
  if (!Number.isFinite(value) || value < 0) return "용량 정보 없음";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 ** 2).toFixed(value < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

function driveStatusText(drive) {
  if (drive?.connected) return `${drive.folder_name || "Quilo schedule 자료실"} · ${drive.item_count || 0}개 동기화`;
  if (drive?.reason === "owner_user_missing") return "Google Drive 운영 계정 이름을 설정해 주세요.";
  if (drive?.reason === "demo_mode") return "데모에서는 Google Drive를 연결하지 않습니다.";
  return "Quilo 계정의 Google Drive 연결을 확인해 주세요.";
}

export default function FilesPage({ files, members, busy, loading, error, drive, onDriveSync, onUpload, onDelete, onCopy, onRefresh, downloadUrl }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [alias, setAlias] = useState("");
  const [description, setDescription] = useState("");
  const [memberId, setMemberId] = useState("");
  const [fileError, setFileError] = useState("");
  const targetOptions = useMemo(() => members.filter((member) => member.status !== "left"), [members]);
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.display_name])), [members]);
  const ordered = useMemo(() => [...files].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)), [files]);

  const chooseFile = (nextFile) => {
    if (!nextFile) return;
    if (!isAcceptedFile(nextFile)) {
      setFileError("PDF, JPEG, PNG, WebP 또는 GIF 파일만 업로드할 수 있습니다.");
      return;
    }
    setFile(nextFile);
    setFileError("");
    if (!alias.trim()) setAlias(nextFile.name.replace(/\.[^.]+$/, ""));
  };

  const reset = () => {
    setFile(null); setAlias(""); setDescription(""); setMemberId(""); setFileError("");
    if (inputRef.current) inputRef.current.value = "";
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file) { setFileError("업로드할 파일을 선택해 주세요."); return; }
    if (!alias.trim() || busy) return;
    const saved = await onUpload({ file, alias: alias.trim(), description: description.trim(), member_id: memberId || null });
    if (saved !== false) reset();
  };

  return (
    <div className="page files-page">
      <div className="page-heading split">
        <span><h1>자료실</h1><p>PDF와 이미지를 반 전체 또는 선택한 구성원에게 안전하게 공유합니다.</p></span>
        <span className="drive-heading-actions">
          {drive?.folder_url ? <a className="outline-button" href={drive.folder_url} target="_blank" rel="noreferrer"><FolderOpen size={17} />Drive 열기</a> : null}
          <button type="button" className="secondary-button" onClick={onDriveSync} disabled={busy || !drive?.configured}><RefreshCw className={busy ? "spin" : ""} size={17} />Drive 동기화</button>
        </span>
      </div>

      <section className={`drive-status-card ${drive?.connected ? "connected" : "disconnected"}`}>
        <span className="drive-status-icon"><Cloud size={20} /></span>
        <span><strong>{drive?.connected ? "Google Drive 연결됨" : "Google Drive 연결 필요"}</strong><small>{driveStatusText(drive)}</small></span>
        {!drive?.connected && drive?.connect_url ? <a href={drive.connect_url} target="_top">Quilo 연결 설정 열기</a> : null}
      </section>

      <form className="content-panel file-upload-panel" onSubmit={submit}>
        <div className="section-line"><h2>자료 업로드</h2><span>PDF · 이미지</span></div>
        <div className="file-upload-grid">
          <div className="file-picker">
            <input ref={inputRef} id="class-file-upload" className="visually-hidden" type="file" accept={ACCEPTED_TYPES} onChange={(event) => chooseFile(event.target.files?.[0])} disabled={busy} />
            <label className="file-drop" htmlFor="class-file-upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files?.[0]); }}>
              <span className="file-drop-icon"><Upload size={23} /></span>
              <strong>{file ? "다른 파일 선택" : "PDF 또는 이미지 선택"}</strong>
              <small>클릭하거나 파일을 이곳에 놓으세요.</small>
            </label>
            {file && <div className="selected-file"><span><strong>{file.name}</strong><small>{fileSize(file)}</small></span><button type="button" className="icon-button" aria-label="선택한 파일 제거" onClick={() => { setFile(null); if (inputRef.current) inputRef.current.value = ""; }}><X size={18} /></button></div>}
            {fileError && <p className="file-error">{fileError}</p>}
          </div>

          <div className="file-fields">
            <label>별칭 <span>*</span><input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="자료실에 표시할 이름" required disabled={busy} /></label>
            <label>설명<textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="자료에 대한 간단한 설명" rows="3" disabled={busy} /></label>
            <label>공개 범위 <span>*</span><select value={memberId} onChange={(event) => setMemberId(event.target.value)} disabled={busy}><option value="">반 전체 공개</option>{targetOptions.map((member) => <option key={member.id} value={member.id}>개인 공개 · {member.display_name}</option>)}</select></label>
            <p className="help-text">반 전체 자료는 {drive?.connected ? "Google Drive에 저장되고" : "기존 비공개 저장소에 저장되며"}, 개인 자료는 항상 선택한 구성원에게만 표시됩니다.</p>
            <button className="primary-button file-submit" disabled={busy || !file || !alias.trim()}><Upload size={18} />{busy ? "업로드 중" : "자료 업로드"}</button>
          </div>
        </div>
      </form>

      <section className="content-panel file-list-panel">
        <div className="section-line"><h2>공유 자료</h2><span>{ordered.length}개</span></div>
        {loading && <div className="file-loading"><LoaderCircle className="spin" size={24} /><span>자료 목록을 불러오는 중</span></div>}
        {!loading && error && <div className="empty-state"><FolderOpen size={30} /><strong>자료 목록을 불러오지 못했습니다.</strong><p>{error}</p><button className="outline-button" onClick={onRefresh}>다시 시도</button></div>}
        {!loading && !error && ordered.map((item) => {
          const isImage = fileMime(item).startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(originalName(item));
          const targetName = item.member_id ? memberNames.get(item.member_id) || "구성원 정보 없음" : "반 전체";
          const targetClass = item.member_id ? "private" : "classwide";
          const fromDrive = item.provider === "google_drive";
          return <article className="file-row" key={item.id}>
            <span className={`file-type-icon ${isImage ? "image" : "pdf"}`}>{isImage ? <FileImage size={22} /> : <FileText size={22} />}</span>
            <span className="file-copy"><strong>{item.alias || item.title || originalName(item)}{fromDrive ? <em className="drive-file-badge">Drive</em> : null}</strong><small>{originalName(item)} · {fileSize(item)}</small>{item.description && <p>{item.description}</p>}<time>{dateLabel(item.created_at)}</time></span>
            <span className={`file-visibility ${targetClass}`}>{item.member_id ? <LockKeyhole size={14} /> : <Users size={14} />}{targetName}</span>
            <span className="file-actions"><a className="icon-button" href={downloadUrl(item)} target="_blank" rel="noreferrer" aria-label={`${item.alias || originalName(item)} 열기`} title="파일 열기"><ExternalLink size={18} /></a>{!item.member_id && <button className="icon-button" onClick={() => onCopy(item)} aria-label={`${item.alias || originalName(item)} 링크 복사`} title="링크 복사"><Copy size={18} /></button>}{fromDrive ? null : <button className="icon-button danger" onClick={() => onDelete(item)} aria-label={`${item.alias || originalName(item)} 삭제`} title="삭제" disabled={busy}><Trash2 size={18} /></button>}</span>
          </article>;
        })}
        {!loading && !error && !ordered.length && <div className="empty-state"><FolderOpen size={30} /><strong>공유된 자료가 없습니다.</strong><p>PDF나 이미지를 올려 학급 자료실을 시작해 보세요.</p></div>}
      </section>
    </div>
  );
}
