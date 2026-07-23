"use strict";

const path = require("node:path");
const JSZip = require("jszip");
const XLSX = require("xlsx");

const MAX_TEXT_CHARS = 160_000;
const MAX_ARCHIVE_ENTRIES = 400;
const MAX_EMBEDDED_IMAGES = 16;
const MAX_EMBEDDED_IMAGE_BYTES = 6 * 1024 * 1024;

const IMAGE_MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
});

const INLINE_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "audio/mpeg",
  "audio/wav",
  "audio/ogg",
  "video/mp4",
  "video/webm",
]);

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function formatBytes(bytes) {
  const size = Math.max(0, Number(bytes) || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

function extensionOf(filename) {
  return path.extname(String(filename || "")).toLowerCase();
}

function mimeFor(filename, supplied = "") {
  const mime = String(supplied || "").split(";")[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") return mime;
  const ext = extensionOf(filename);
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  return ({
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
  })[ext] || "application/octet-stream";
}

function truncateText(text, max = MAX_TEXT_CHARS) {
  const value = String(text || "").replace(/\u0000/g, "");
  if (value.length <= max) return { value, truncated: false };
  return { value: value.slice(0, max), truncated: true };
}

function previewPage({ filename, size, kind, body, note = "" }) {
  const ext = extensionOf(filename).replace(/^\./, "").toUpperCase() || "FILE";
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(filename)} 미리보기</title>
<style>
:root{color-scheme:light dark;--bg:#eef1f5;--paper:#fff;--ink:#172033;--muted:#667085;--line:#d8dee8;--brand:#2563eb;--soft:#f7f9fc}*{box-sizing:border-box}body{margin:0;padding:28px;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Malgun Gothic",sans-serif}.bar{max-width:980px;margin:0 auto 14px;display:flex;gap:12px;align-items:center}.badge{padding:4px 8px;border-radius:6px;background:#e8efff;color:#1f55c8;font-size:11px;font-weight:800}.meta{min-width:0}.meta strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px}.meta span,.note{color:var(--muted);font-size:12px}.paper{max-width:980px;min-height:70vh;margin:auto;padding:54px 58px;border:1px solid var(--line);background:var(--paper);box-shadow:0 14px 36px rgba(15,23,42,.09)}h1,h2,h3{line-height:1.35;letter-spacing:-.02em}h1{font-size:25px}h2{margin-top:30px;font-size:19px}h3{margin-top:22px;font-size:16px}p{margin:0 0 13px;white-space:pre-wrap}.text{margin:0;overflow-wrap:anywhere;white-space:pre-wrap;font:13px/1.75 ui-monospace,SFMono-Regular,Menlo,monospace}table{width:100%;margin:18px 0;border-collapse:collapse;font-size:12px}th,td{padding:7px 9px;border:1px solid var(--line);text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:var(--soft);font-weight:700}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:28px}.gallery figure{margin:0;padding:8px;border:1px solid var(--line);background:var(--soft)}.gallery img{display:block;width:100%;height:auto;max-height:360px;object-fit:contain;background:#fff}.gallery figcaption{padding-top:6px;color:var(--muted);font-size:11px}.empty{padding:36px;border:1px dashed var(--line);color:var(--muted);text-align:center}.notice{margin:0 0 22px;padding:11px 13px;border-left:3px solid var(--brand);background:#eef4ff;color:#3f4d68;font-size:12px}@media(max-width:700px){body{padding:10px}.paper{padding:28px 20px}.bar{align-items:flex-start}}
@media(prefers-color-scheme:dark){:root{--bg:#0d121b;--paper:#151b25;--ink:#edf1f7;--muted:#a5afbd;--line:#303a49;--brand:#76a0ff;--soft:#1d2531}.badge{background:#1f3157;color:#9cb9ff}.notice{background:#17233c;color:#c7d5ef}.gallery img{background:#fff}}
</style></head><body>
<header class="bar"><span class="badge">${escapeHtml(ext)}</span><div class="meta"><strong>${escapeHtml(filename)}</strong><span>${escapeHtml(kind)} · ${escapeHtml(formatBytes(size))}</span></div></header>
<main class="paper">${note ? `<p class="notice">${escapeHtml(note)}</p>` : ""}${body}</main>
</body></html>`;
}

function taggedText(xml) {
  const values = [];
  const source = String(xml || "").replace(/<(?:w:tab|w:br|w:cr)\b[^>]*\/?\s*>/g, " ");
  for (const match of source.matchAll(/<(?:w|m):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|m):t>/g)) {
    values.push(decodeXml(match[1]));
  }
  return values.join("").replace(/[ \t]+/g, " ").trim();
}

function docxParagraphHtml(xml) {
  const text = taggedText(xml);
  if (!text) return "";
  const style = decodeXml((xml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i) || [])[1] || "");
  if (/^(title|제목)$/i.test(style)) return `<h1>${escapeHtml(text)}</h1>`;
  if (/heading\s*1|제목\s*1/i.test(style)) return `<h2>${escapeHtml(text)}</h2>`;
  if (/heading\s*[2-9]|제목\s*[2-9]/i.test(style)) return `<h3>${escapeHtml(text)}</h3>`;
  const prefix = /<w:numPr\b/i.test(xml) ? "• " : "";
  return `<p>${escapeHtml(prefix + text)}</p>`;
}

function docxTableHtml(xml) {
  const rows = [];
  for (const row of xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
    const cells = [];
    for (const cell of row[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)) {
      const paragraphs = [...cell[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)]
        .map((item) => taggedText(item[0]))
        .filter(Boolean);
      cells.push(paragraphs.join("\n"));
    }
    if (cells.length) rows.push(cells);
    if (rows.length >= 200) break;
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  return `<table><tbody>${rows.map((row, rowIndex) => `<tr>${Array.from({ length: width }, (_, index) => {
    const tag = rowIndex === 0 ? "th" : "td";
    return `<${tag}>${escapeHtml(row[index] || "").replaceAll("\n", "<br>")}</${tag}>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}

async function embeddedImageGallery(zip, prefixes) {
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && prefixes.some((prefix) => entry.name.startsWith(prefix)))
    .filter((entry) => IMAGE_MIME[extensionOf(entry.name)])
    .slice(0, MAX_EMBEDDED_IMAGES);
  const figures = [];
  let total = 0;
  for (const entry of entries) {
    const data = await entry.async("nodebuffer");
    if (total + data.length > MAX_EMBEDDED_IMAGE_BYTES) break;
    total += data.length;
    figures.push(`<figure><img alt="${escapeHtml(path.basename(entry.name))}" src="data:${IMAGE_MIME[extensionOf(entry.name)]};base64,${data.toString("base64")}"><figcaption>${escapeHtml(path.basename(entry.name))}</figcaption></figure>`);
  }
  return figures.length ? `<section class="gallery">${figures.join("")}</section>` : "";
}

async function createDocxPreview(buffer, filename) {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntry = zip.file("word/document.xml");
  if (!documentEntry) throw new Error("DOCX 본문을 찾을 수 없습니다.");
  const xml = await documentEntry.async("string");
  const blocks = [];
  for (const match of xml.matchAll(/<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g)) {
    const rendered = match[1] === "tbl" ? docxTableHtml(match[0]) : docxParagraphHtml(match[0]);
    if (rendered) blocks.push(rendered);
    if (blocks.length >= 1200) break;
  }
  const gallery = await embeddedImageGallery(zip, ["word/media/"]);
  return previewPage({
    filename,
    size: buffer.length,
    kind: "Word 문서 간단 미리보기",
    note: "브라우저 미리보기에서는 글꼴·페이지 나눔·일부 도형이 실제 Word/Hancom 화면과 다를 수 있습니다.",
    body: `${blocks.length ? blocks.join("") : '<div class="empty">표시할 본문을 찾지 못했습니다.</div>'}${gallery}`,
  });
}

async function createHwpxPreview(buffer, filename) {
  const zip = await JSZip.loadAsync(buffer);
  let text = "";
  const preview = zip.file("Preview/PrvText.txt");
  if (preview) text = await preview.async("string");
  if (!text.trim()) {
    const sections = Object.values(zip.files)
      .filter((entry) => /^Contents\/section\d+\.xml$/i.test(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const lines = [];
    for (const section of sections) {
      const xml = await section.async("string");
      for (const paragraph of xml.matchAll(/<hp:p\b[\s\S]*?<\/hp:p>/g)) {
        const values = [...paragraph[0].matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)]
          .map((match) => decodeXml(match[1]));
        const line = values.join("").trim();
        if (line) lines.push(line);
      }
    }
    text = lines.join("\n");
  }
  const clipped = truncateText(text);
  const gallery = await embeddedImageGallery(zip, ["BinData/"]);
  return previewPage({
    filename,
    size: buffer.length,
    kind: "한글 문서 간단 미리보기",
    note: "HWPX 내부의 공식 미리보기 텍스트와 포함 이미지를 표시합니다. 정확한 표·수식·쪽 배치는 한컴오피스에서 확인하세요.",
    body: `${clipped.value ? `<pre class="text">${escapeHtml(clipped.value)}</pre>` : '<div class="empty">표시할 본문을 찾지 못했습니다.</div>'}${clipped.truncated ? '<p class="note">문서가 길어 일부만 표시했습니다.</p>' : ""}${gallery}`,
  });
}

function sheetTableHtml(rows) {
  if (!rows.length) return '<div class="empty">표시할 셀 데이터가 없습니다.</div>';
  const clippedRows = rows.slice(0, 120);
  const width = Math.min(40, Math.max(...clippedRows.map((row) => row.length), 1));
  return `<table><tbody>${clippedRows.map((row, rowIndex) => `<tr>${Array.from({ length: width }, (_, index) => {
    const tag = rowIndex === 0 ? "th" : "td";
    return `<${tag}>${escapeHtml(row[index] == null ? "" : row[index])}</${tag}>`;
  }).join("")}</tr>`).join("")}</tbody></table>${rows.length > clippedRows.length ? '<p class="note">120행까지만 표시했습니다.</p>' : ""}`;
}

function createSpreadsheetPreview(buffer, filename) {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheets = workbook.SheetNames.slice(0, 8).map((name) => {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: false, defval: "" });
    return `<h2>${escapeHtml(name)}</h2>${sheetTableHtml(rows)}`;
  });
  return previewPage({
    filename,
    size: buffer.length,
    kind: "스프레드시트 미리보기",
    note: "큰 시트는 앞부분만 표시되며, 수식은 계산된 셀 값으로 보일 수 있습니다.",
    body: sheets.join("") || '<div class="empty">표시할 시트가 없습니다.</div>',
  });
}

async function archiveRows(zip) {
  const entries = Object.values(zip.files).slice(0, MAX_ARCHIVE_ENTRIES);
  return `<table><thead><tr><th>경로</th><th>종류</th><th>크기</th></tr></thead><tbody>${entries.map((entry) => {
    const bytes = Number(entry?._data?.uncompressedSize) || 0;
    return `<tr><td>${escapeHtml(entry.name)}</td><td>${entry.dir ? "폴더" : escapeHtml(extensionOf(entry.name).replace(/^\./, "").toUpperCase() || "파일")}</td><td>${entry.dir ? "-" : escapeHtml(bytes ? formatBytes(bytes) : "-")}</td></tr>`;
  }).join("")}</tbody></table>${Object.keys(zip.files).length > entries.length ? `<p class="note">전체 ${Object.keys(zip.files).length}개 중 ${entries.length}개만 표시했습니다.</p>` : ""}`;
}

async function createArchivePreview(buffer, filename, isCap = false) {
  const zip = await JSZip.loadAsync(buffer);
  let body = "";
  if (isCap) {
    const main = zip.file("main.xml");
    if (main) {
      const xml = await main.async("string");
      const values = [...xml.matchAll(/>([^<>]{2,})</g)]
        .map((match) => decodeXml(match[1]).trim())
        .filter((value) => value && !/^[-+]?\d+(?:\.\d+)?$/.test(value));
      const unique = [...new Set(values)].slice(0, 180);
      if (unique.length) body += `<h2>Capstone 문서 텍스트</h2><pre class="text">${escapeHtml(unique.join("\n"))}</pre>`;
    }
  }
  body += `<h2>${isCap ? "패키지 구성" : "압축 파일 구성"}</h2>${await archiveRows(zip)}`;
  return previewPage({
    filename,
    size: buffer.length,
    kind: isCap ? "PASCO Capstone 패키지 미리보기" : "압축 파일 미리보기",
    note: isCap
      ? "Capstone 화면 배치와 센서 그래프는 PASCO Capstone 앱에서 정확히 확인하세요."
      : "압축 파일은 내부 파일 목록으로 미리 봅니다. 각 문서는 압축을 푼 뒤 원래 앱에서 확인하세요.",
    body,
  });
}

function createTextPreview(buffer, filename) {
  let text = buffer.toString("utf8");
  const ext = extensionOf(filename);
  if (ext === ".json") {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* 원문 표시 */ }
  }
  const clipped = truncateText(text);
  return previewPage({
    filename,
    size: buffer.length,
    kind: "텍스트 미리보기",
    body: `<pre class="text">${escapeHtml(clipped.value)}</pre>${clipped.truncated ? '<p class="note">파일이 길어 일부만 표시했습니다.</p>' : ""}`,
  });
}

function genericPreview(buffer, filename, mimeType) {
  const head = buffer.subarray(0, 96).toString("hex").replace(/(.{2})/g, "$1 ").trim();
  return previewPage({
    filename,
    size: buffer.length,
    kind: mimeType || "파일",
    note: "이 형식은 브라우저에서 내용 구조를 해석할 수 없어 파일 정보만 표시합니다. 다운로드 후 전용 앱에서 열어 주세요.",
    body: `<h2>파일 정보</h2><table><tbody><tr><th>이름</th><td>${escapeHtml(filename)}</td></tr><tr><th>MIME</th><td>${escapeHtml(mimeType || "알 수 없음")}</td></tr><tr><th>크기</th><td>${escapeHtml(formatBytes(buffer.length))}</td></tr><tr><th>파일 식별 바이트</th><td><code>${escapeHtml(head || "-")}</code></td></tr></tbody></table>`,
  });
}

async function createFilePreview(buffer, { filename = "파일", mimeType = "" } = {}) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const ext = extensionOf(filename);
  const mime = mimeFor(filename, mimeType);
  if (INLINE_MIME.has(mime)) {
    return { kind: "inline", body: data, contentType: mime };
  }
  try {
    let html;
    if (ext === ".docx") html = await createDocxPreview(data, filename);
    else if (ext === ".hwpx") html = await createHwpxPreview(data, filename);
    else if ([".xlsx", ".xls"].includes(ext)) html = createSpreadsheetPreview(data, filename);
    else if (ext === ".cap") html = await createArchivePreview(data, filename, true);
    else if (ext === ".zip") html = await createArchivePreview(data, filename, false);
    else if ([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".svg", ".js", ".css", ".py"].includes(ext) || mime.startsWith("text/")) {
      html = createTextPreview(data, filename);
    } else html = genericPreview(data, filename, mime);
    return { kind: "html", body: Buffer.from(html, "utf8"), contentType: "text/html; charset=utf-8" };
  } catch (error) {
    const html = previewPage({
      filename,
      size: data.length,
      kind: "파일 미리보기",
      note: `미리보기 변환 중 문제가 생겨 파일 정보만 표시합니다: ${String(error.message || error).slice(0, 180)}`,
      body: genericPreview(data, filename, mime).match(/<main class="paper">([\s\S]*?)<\/main>/)?.[1] || "",
    });
    return { kind: "html", body: Buffer.from(html, "utf8"), contentType: "text/html; charset=utf-8" };
  }
}

module.exports = {
  createFilePreview,
  escapeHtml,
  formatBytes,
};
