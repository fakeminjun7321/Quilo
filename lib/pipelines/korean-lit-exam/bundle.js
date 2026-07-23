// 국어(문학) 내신·모의고사 — 3종 PDF 조판 + ZIP 묶음.
//
// generate.js 가 만든 content(works[] + questions[]) 를 받아:
//   1) 시험지(시험지.pdf)     — 작품별 지문 + 발문 + 객관식 선택지/표채우기 표(정답 없음).
//   2) 답안작성지(답안작성지.pdf) — 번호별 빈 답 작성 칸(유형에 맞춘 칸 높이).
//   3) 정답해설지(정답해설지.pdf) — 번호별 정답 + 해설.
//   세 PDF 모두 작품/섹션마다 \section{...} 으로 PDF 북마크(outline)를 단다.
//   4) 세 PDF 를 ZIP 하나로 묶어 { buffer, filename } 반환.
//
// 조판은 Tectonic(XeLaTeX, 번들 한국어 폰트). 모델 제공 문자열은 전부 LaTeX 이스케이프.
// 문학 문제는 평문이 대부분이므로 수식은 신경 쓰지 않고 평문 안전 이스케이프만 한다.
// (단 인라인 $...$ 가 오면 그대로 두고 안쪽 따옴표/균형만 보정 — escInline.)

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { compileTex } = require("../pdf-translate/latex-pdf");

const FONT_DIR = path.join(__dirname, "../../fonts");
const HAS_PRETENDARD = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"));
const MAIN_FONT = HAS_PRETENDARD ? "Pretendard-Regular.ttf" : "NanumGothic-Regular.ttf";
const BOLD_FONT = fs.existsSync(path.join(FONT_DIR, "Pretendard-Bold.ttf"))
  ? "Pretendard-Bold.ttf"
  : null;

// ── LaTeX 이스케이프 ─────────────────────────────────────────────────────────
// 전체 이스케이프(평문 전용: 제목·발문·선택지·표 셀·해설). 줄바꿈은 \n 그대로 두고
// 호출부에서 \par(또는 시 행은 \\)로 변환한다.
function escPlain(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%#_{}$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// 인라인 수식($...$)을 보존하면서 그 밖 평문은 escPlain. 문학 문제엔 드물지만 안전망.
function escInline(s) {
  s = String(s == null ? "" : s);
  if (s.indexOf("$") === -1) return escPlain(s);
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s[i] === "$") {
      const j = s.indexOf("$", i + 1);
      if (j === -1) {
        // 짝 없는 $ → 평문 취급(리터럴 $).
        out += escPlain(s.slice(i));
        break;
      }
      // 수식 안쪽은 그대로(균형만 신뢰) — 따옴표 보정.
      out += "$" + s.slice(i + 1, j).replace(/[’‘′]/g, "'").replace(/[“”″]/g, '"') + "$";
      i = j + 1;
    } else {
      const j = s.indexOf("$", i);
      const seg = j === -1 ? s.slice(i) : s.slice(i, j);
      out += escPlain(seg);
      i = j === -1 ? n : j;
    }
  }
  return out;
}

// 여러 줄(\n) 평문 → LaTeX 단락. 빈 줄은 단락 구분, 일반 줄바꿈은 \\ (시 행 보존).
function multilineTex(s, { verse = false } = {}) {
  const text = String(s == null ? "" : s).replace(/\r\n/g, "\n");
  const paras = text.split(/\n{2,}/);
  return paras
    .map((p) => {
      const lines = p.split("\n").map((ln) => escInline(ln));
      // verse(시): 모든 줄을 \\ 로 끊어 행을 보존. 산문: 자연 줄바꿈만.
      return verse ? lines.join(" \\\\\n") : lines.join("\\\\\n");
    })
    .join("\\par\\medskip\n");
}

function isVerseGenre(genre) {
  return genre === "현대시" || genre === "고전시가";
}

// ── 공통 프리앰블 ────────────────────────────────────────────────────────────
// hyperref+bookmark 로 \section 이 PDF 북마크(outline)가 되게 한다. 섹션 번호는 숨긴다
// (시험지 미관). themegreen 등 색은 problem-set 과 통일.
function preamble(extra = "") {
  return `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=18mm]{geometry}
\\usepackage{xcolor}
\\usepackage{array}
\\usepackage{enumitem}
\\usepackage{setspace}
\\usepackage{needspace}
\\usepackage[hidelinks]{hyperref}
\\usepackage{bookmark}
\\setmainfont{${MAIN_FONT}}[Path=${FONT_DIR}/${BOLD_FONT ? `, BoldFont=${BOLD_FONT}` : ", AutoFakeBold=2.5"}]
\\setlength{\\parindent}{0pt}
\\setstretch{1.15}
\\definecolor{themegreen}{HTML}{1F7A5A}
\\definecolor{themedark}{HTML}{0F3D2E}
\\definecolor{rulegray}{HTML}{C8D6CF}
\\definecolor{softbg}{HTML}{F3F8F5}
\\definecolor{boxline}{HTML}{9DB8AD}
\\setlength{\\emergencystretch}{3em}
% 섹션을 북마크용으로만 쓰고 번호/본문 큰 제목은 우리가 직접 그린다.
\\setcounter{secnumdepth}{0}
${extra}`;
}

// 문서 머리(제목 + 구분선).
function docHeader(title, subtitle) {
  return `{\\LARGE\\bfseries\\textcolor{themedark}{${escPlain(title)}}}\\hfill{\\normalsize\\textcolor{themegreen}{${escPlain(subtitle)}}}\\par\\smallskip
\\textcolor{rulegray}{\\rule{\\linewidth}{0.6mm}}\\par\\medskip
`;
}

const GENRE_LABEL = {
  현대시: "현대시",
  고전시가: "고전시가",
  현대소설: "현대소설",
  고전소설: "고전소설",
};

// 작품 헤더 + 북마크(\section). \needspace 로 작품 머리가 페이지 끝에 외롭게 남지 않게.
function workHeader(w, idx) {
  const label = GENRE_LABEL[w.genre] || w.genre || "작품";
  const taughtTag = w.taught === false ? " · 연계(외부 지문)" : "";
  // \section 은 북마크 텍스트로만 쓰고 화면엔 우리가 그린 박스를 보여준다.
  const sec = `\\phantomsection\\addcontentsline{toc}{section}{[${escPlain(label)}] ${escPlain(w.title)}}\n`;
  return (
    `\\needspace{5\\baselineskip}\n${sec}` +
    `\\noindent\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{` +
    `\\textcolor{themegreen}{\\bfseries [${escPlain(label)}${escPlain(taughtTag)}]}\\quad{\\bfseries ${escPlain(w.title)}}}}\\par\\smallskip\n`
  );
}

// 작품 지문 박스(발췌). 시는 행 보존, 소설은 단락 보존.
function passageBox(w) {
  const txt = String(w.passage_excerpt || "").trim();
  if (!txt) return "";
  const body = multilineTex(txt, { verse: isVerseGenre(w.genre) });
  return (
    `\\noindent\\fcolorbox{boxline}{white}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{\\small\n` +
    `${body}\n}}\\par\\medskip\n`
  );
}

// 객관식 선택지(① ~). 모델이 이미 ①②③ 를 붙여 보낼 수도, 안 붙일 수도 있어 둘 다 대응.
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
function choicesTex(choices) {
  const arr = Array.isArray(choices) ? choices : [];
  if (!arr.length) return "";
  let out = "\\begin{itemize}[leftmargin=1.6em,itemsep=2pt,topsep=2pt,label={}]\n";
  arr.forEach((c, i) => {
    let s = String(c).trim();
    // 이미 동그라미 번호가 있으면 그대로, 없으면 붙인다.
    if (!/^[①-⑩]/.test(s)) s = `${CIRCLED[i] || `(${i + 1})`} ${s}`;
    out += `\\item ${escInline(s)}\n`;
  });
  out += "\\end{itemize}\n";
  return out;
}

// 표(표채우기). 행은 헤더 열 수에 맞춰 패딩.
function tableTex(t) {
  if (!t || !Array.isArray(t.headers) || !t.headers.length) return "";
  const cols = t.headers.length;
  const spec = "|" + "l|".repeat(cols);
  const head = t.headers.map((h) => `\\textbf{${escPlain(h)}}`).join(" & ");
  const rows = (Array.isArray(t.rows) ? t.rows : [])
    .map((r) => {
      const cells = (Array.isArray(r) ? r : [r]).slice(0, cols).map((c) => escPlain(c));
      while (cells.length < cols) cells.push("");
      return cells.join(" & ");
    })
    .join(" \\\\ \\hline\n");
  return (
    `\\begin{center}\\small\n\\begin{tabular}{${spec}}\\hline\n` +
    `${head} \\\\ \\hline\n${rows}${rows ? " \\\\ \\hline" : ""}\n` +
    `\\end{tabular}\\end{center}\n`
  );
}

// 문항 번호 배지.
function numBadge(no) {
  return `\\colorbox{themegreen}{\\textcolor{white}{\\bfseries\\,${escPlain(no)}\\,}}`;
}
function typeTag(type) {
  return `{\\footnotesize\\textcolor{themegreen}{[${escPlain(type)}]}}`;
}

// 작품별로 문항을 묶는다. 반환: Map(work_id -> [questions]) + 순서 유지.
function groupByWork(works, questions) {
  const order = works.map((w) => w.id);
  const map = new Map(order.map((id) => [id, []]));
  for (const q of questions) {
    if (!map.has(q.work_id)) map.set(q.work_id, []);
    map.get(q.work_id).push(q);
  }
  return map;
}

// ── 1) 시험지 ────────────────────────────────────────────────────────────────
function buildExamTex({ title, works, questions, date }) {
  let body = docHeader(title, `시험지${date ? ` · ${escPlain(date)}` : ""}`);
  const byWork = groupByWork(works, questions);
  works.forEach((w, wi) => {
    const qs = byWork.get(w.id) || [];
    if (!qs.length && !String(w.passage_excerpt || "").trim()) return;
    body += workHeader(w, wi);
    body += passageBox(w);
    qs.forEach((q) => {
      body += `\\needspace{3\\baselineskip}\\noindent${numBadge(q.no)}~${typeTag(q.type)}~${escInline(q.prompt)}\\par\\smallskip\n`;
      if (q.type === "객관식") body += choicesTex(q.choices);
      else if (q.type === "표채우기") body += tableTex(q.table);
      body += `\\smallskip\n`;
    });
    body += `\\medskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });
  return `${preamble()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// ── 2) 답안 작성지 ───────────────────────────────────────────────────────────
// 유형별로 빈 칸 높이를 다르게 준다(객관식/단답=짧게, 서술=넉넉히, 표채우기=표 빈칸 + 줄).
function buildAnswerSheetTex({ title, works, questions, date }) {
  let body = docHeader(title, `답안 작성지${date ? ` · ${escPlain(date)}` : ""}`);
  const byWork = groupByWork(works, questions);

  // 빈 답란: 옅은 가로줄(밑줄) n개를 JS 문자열 반복으로 찍는다(LaTeX 루프·pgffor 불필요).
  const ruleLine = `\\par\\vskip 7mm\\noindent\\textcolor{rulegray}{\\rule{\\linewidth}{0.12mm}}`;
  const blankLines = (n) => ruleLine.repeat(Math.max(1, n));

  works.forEach((w, wi) => {
    const qs = byWork.get(w.id) || [];
    if (!qs.length) return;
    body += workHeader(w, wi);
    qs.forEach((q) => {
      body += `\\needspace{4\\baselineskip}\\noindent${numBadge(q.no)}~${typeTag(q.type)}~{\\footnotesize\\textcolor{themedark}{${escInline(String(q.prompt).slice(0, 80))}${String(q.prompt).length > 80 ? "…" : ""}}}\\par\n`;
      if (q.type === "객관식") {
        // 답란: ① ② ③ ④ ⑤ 에 동그라미.
        body += `\\smallskip\\noindent\\hspace{2mm}\\large ① \\quad ② \\quad ③ \\quad ④ \\quad ⑤\\par\\medskip\n`;
      } else if (q.type === "표채우기") {
        body += blankLines(3) + "\\par\\medskip\n";
      } else if (q.type === "서술") {
        body += blankLines(4) + "\\par\\medskip\n";
      } else {
        // 단답
        body += blankLines(1) + "\\par\\medskip\n";
      }
    });
    body += `\\medskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });
  return `${preamble()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// ── 3) 정답·해설지 ───────────────────────────────────────────────────────────
function buildSolutionTex({ title, works, questions, date }) {
  let body = docHeader(title, `정답·해설지${date ? ` · ${escPlain(date)}` : ""}`);
  const byWork = groupByWork(works, questions);
  works.forEach((w, wi) => {
    const qs = byWork.get(w.id) || [];
    if (!qs.length) return;
    body += workHeader(w, wi);
    qs.forEach((q) => {
      body += `\\needspace{4\\baselineskip}\\noindent${numBadge(q.no)}~${typeTag(q.type)}~{\\footnotesize\\textcolor{themedark}{${escInline(q.prompt)}}}\\par\\smallskip\n`;
      if (q.type === "표채우기" && q.table) body += tableTex(q.table);
      if (String(q.answer).trim()) {
        body += `\\noindent\\textbf{\\textcolor{themegreen}{정답:}}\\ ${escInline(q.answer)}\\par\\smallskip\n`;
      }
      if (String(q.explanation).trim()) {
        body += `\\noindent\\textbf{해설:}\\ ${multilineTex(q.explanation)}\\par\n`;
      }
      body += `\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\smallskip\n`;
    });
    body += `\\medskip\n`;
  });
  return `${preamble()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// 한 페이지 안내 PDF(조판 실패 시 그 PDF 만 대체).
function buildPlaceholderTex(label, reason) {
  return `${preamble()}
\\begin{document}
{\\large\\bfseries ${escPlain(label)} 조판 실패}\\par\\medskip
이 PDF 는 조판 중 오류로 생성하지 못했습니다. 나머지 PDF 는 정상 생성되었습니다.\\par\\smallskip
{\\footnotesize ${escPlain(String(reason || "").slice(0, 200))}}\\par
\\end{document}
`;
}

// 신뢰 컴파일 → 실패 시 안내 페이지로 대체(나머지 ZIP 은 살린다).
async function compileSafe(buildFn, { signal, onProgress, label }) {
  try {
    return await compileTex(buildFn(), { signal, onProgress });
  } catch (e) {
    onProgress(`⚠ ${label} 조판 실패 → 안내 페이지로 대체 (${String(e.message).slice(0, 90)})`);
    return await compileTex(buildPlaceholderTex(label, e.message), { signal, onProgress });
  }
}

function sanitizeName(s) {
  return String(s || "")
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 60)
    .trim();
}

/**
 * @param {Object} content generate.js 산출 content (title, works[], questions[], date)
 * @param {Object} opts    { studentId, userName, sourceFilename, signal, onProgress }
 * @returns {Promise<{buffer:Buffer, filename:string}>}
 */
async function generateBundle(content, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;
  const title = content.title || "국어 문학 내신·모의고사";
  const works = Array.isArray(content.works) ? content.works : [];
  const questions = Array.isArray(content.questions) ? content.questions : [];
  const date = content.date || "";

  if (!works.length || !questions.length) {
    throw new Error("조판할 작품/문항이 없습니다.");
  }

  onProgress("📐 시험지·답안작성지·정답해설지 3종 PDF 조판 중 (Tectonic)...");
  // Tectonic 은 프로세스당 메모리를 많이 써서 동시에 3개를 띄우면 OOM 위험 → 순차 조판.
  const examPdf = await compileSafe(
    () => buildExamTex({ title, works, questions, date }),
    { signal, onProgress, label: "시험지" },
  );
  const sheetPdf = await compileSafe(
    () => buildAnswerSheetTex({ title, works, questions, date }),
    { signal, onProgress, label: "답안작성지" },
  );
  const solPdf = await compileSafe(
    () => buildSolutionTex({ title, works, questions, date }),
    { signal, onProgress, label: "정답해설지" },
  );

  onProgress("📦 3개 PDF를 ZIP으로 묶는 중...");
  const zip = new JSZip();
  zip.file("01_시험지.pdf", examPdf);
  zip.file("02_답안작성지.pdf", sheetPdf);
  zip.file("03_정답해설지.pdf", solPdf);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const base = sanitizeName(opts.sourceFilename || title) || "국어문학";
  const filename = `${base}_시험지·답안·해설.zip`;
  return { buffer, filename };
}

module.exports = { generateBundle };
