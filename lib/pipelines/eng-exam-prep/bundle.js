// 영어 시험대비 자료 3종 세트 — 3개 PDF(모의고사·개념정리문제·빈칸학습지) 조판 + ZIP.
//
// generate.js 가 만든 content(JSON, passages[]) 를 받아:
//   1) 지문별 \section(hyperref+bookmark) 으로 북마크가 달린 3개 PDF 를 LaTeX 로 조판(Tectonic).
//   2) 세 PDF 를 ZIP 하나로 묶어 Buffer 로 돌려준다.
//
// 이 자료의 문항·본문은 자연어 텍스트(영어/한국어)이고 수식이 없으므로, 모든 모델 제공 문자열은
// escPlain 으로 LaTeX 특수문자(# $ % & _ { } ~ ^ \)를 전부 이스케이프한다(수식 보존 안 함).
// 한 PDF 조판이 실패해도 그 PDF 만 안내 페이지로 대체하고 나머지는 정상 출력한다.

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

// ── LaTeX 이스케이프 (평문 전용 — 수식 없음) ─────────────────────────────────
function escPlain(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%#_{}$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// 여러 줄 본문(빈칸학습지 본문 등): 줄바꿈을 \\ 로, 빈 줄은 문단 구분으로.
function escMultiline(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split("\n")
        .map((line) => escPlain(line))
        .join("\\\\\n"),
    )
    .join("\\par\\smallskip\n");
}

const PREAMBLE = (extra = "") => `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=18mm]{geometry}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\usepackage[hidelinks]{hyperref}
\\usepackage{bookmark}
\\setmainfont{${MAIN_FONT}}[Path=${FONT_DIR}/${BOLD_FONT ? `, BoldFont=${BOLD_FONT}` : ", AutoFakeBold=2.5"}]
\\setlength{\\parindent}{0pt}
\\definecolor{themeblue}{HTML}{1E4D8C}
\\definecolor{themedark}{HTML}{12233F}
\\definecolor{rulegray}{HTML}{C8D0DC}
\\definecolor{softbg}{HTML}{F2F5FA}
\\definecolor{ansgray}{HTML}{5A6678}
\\setlength{\\emergencystretch}{3em}
\\setlist{leftmargin=*,topsep=2pt,itemsep=4pt}
${extra}`;

function docTitle(title, subtitle) {
  return `{\\LARGE\\bfseries\\textcolor{themedark}{${escPlain(title)}}}\\hfill{\\small\\textcolor{themeblue}{${escPlain(subtitle)}}}\\par\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.6mm}}\\par\\medskip\n`;
}

// 지문 제목을 PDF 북마크가 달리는 \section 으로(번호 없이).
function sectionTex(title) {
  return `\\section*{${escPlain(title)}}\\addcontentsline{toc}{section}{${escPlain(title)}}\n`;
}

// 전역 안내(notes) 박스.
function notesBox(notes) {
  if (!Array.isArray(notes) || !notes.length) return "";
  let out = `\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{\\footnotesize\n`;
  out += notes.map((nt) => `\\textbullet\\ ${escPlain(nt)}`).join("\\\\\n");
  out += `\n}}\\par\\medskip\n`;
  return out;
}

// 답·해설 라인(작은 회색). 비면 생략.
function answerLine(label, value) {
  const v = String(value == null ? "" : value).trim();
  if (!v) return "";
  return `\\par\\smallskip{\\small\\textcolor{ansgray}{\\textbf{${escPlain(label)}}\\ ${escPlain(v)}}}\n`;
}

// ── (1) 모의고사 — 단답형 + 서술형 + 정답·해설 ───────────────────────────────
function buildExamTex({ title, passages, notes }) {
  let body = docTitle(title, "모의고사 (단답형·서술형)");
  body += notesBox(notes);

  passages.forEach((p) => {
    body += sectionTex(p.title);
    const short = p.exam?.short || [];
    const essay = p.exam?.essay || [];

    if (short.length) {
      body += `\\noindent\\textbf{\\textcolor{themeblue}{[ 단답형 (Short Answer) ]}}\\par\\smallskip\n`;
      body += `\\begin{enumerate}[label=\\textbf{\\arabic*.}]\n`;
      for (const it of short) {
        body += `\\item ${escPlain(it.q)}\n`;
        body += answerLine("정답:", it.a);
        body += answerLine("해설:", it.explanation);
      }
      body += `\\end{enumerate}\\medskip\n`;
    }

    if (essay.length) {
      body += `\\noindent\\textbf{\\textcolor{themeblue}{[ 서술형 (Essay) ]}}\\par\\smallskip\n`;
      body += `\\begin{enumerate}[label=\\textbf{\\arabic*.}]\n`;
      for (const it of essay) {
        body += `\\item ${escPlain(it.q)}\n`;
        body += answerLine("모범답안:", it.a);
        body += answerLine("해설:", it.explanation);
      }
      body += `\\end{enumerate}\\medskip\n`;
    }

    if (!short.length && !essay.length) {
      body += `{\\small\\textcolor{ansgray}{(이 지문의 모의고사 문항이 비어 있습니다.)}}\\par\\medskip\n`;
    }
    body += `\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });

  return `${PREAMBLE()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// ── (2) 개념정리문제 — 분석형 문항 + 정답 ────────────────────────────────────
function buildConceptTex({ title, passages, notes }) {
  let body = docTitle(title, "개념정리문제 (분석형)");
  body += notesBox(notes);

  passages.forEach((p) => {
    body += sectionTex(p.title);
    const concept = p.concept || [];
    if (concept.length) {
      body += `\\begin{enumerate}[label=\\textbf{\\arabic*.}]\n`;
      for (const it of concept) {
        body += `\\item ${escPlain(it.q)}\n`;
        body += answerLine("정답:", it.a);
        body += answerLine("해설:", it.explanation);
      }
      body += `\\end{enumerate}\\medskip\n`;
    } else {
      body += `{\\small\\textcolor{ansgray}{(이 지문의 개념정리 문항이 비어 있습니다.)}}\\par\\medskip\n`;
    }
    body += `\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });

  return `${PREAMBLE()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// ── (3) 빈칸학습지 — 본문 빈칸 + 영작 + 답지 ─────────────────────────────────
function buildClozeTex({ title, passages, notes }) {
  let body = docTitle(title, "빈칸학습지 (빈칸·영작)");
  body += notesBox(notes);

  passages.forEach((p) => {
    body += sectionTex(p.title);
    const cz = p.cloze || {};
    const blanked = String(cz.blanked_text || "").trim();
    const answers = Array.isArray(cz.answers) ? cz.answers : [];
    const tasks = Array.isArray(cz.translation_task) ? cz.translation_task : [];

    if (blanked) {
      body += `\\noindent\\textbf{\\textcolor{themeblue}{[ 본문 빈칸 채우기 ]}}\\par\\smallskip\n`;
      body += `${escMultiline(blanked)}\\par\\medskip\n`;
    }

    if (tasks.length) {
      body += `\\noindent\\textbf{\\textcolor{themeblue}{[ 영작 (다음 문장을 영어로) ]}}\\par\\smallskip\n`;
      body += `\\begin{enumerate}[label=\\textbf{\\arabic*.}]\n`;
      for (const t of tasks) {
        body += `\\item ${escPlain(t.ko)}\n`;
      }
      body += `\\end{enumerate}\\medskip\n`;
    }

    // 답지(빈칸 정답 + 영작 모범 번역).
    if (answers.length || tasks.some((t) => t.en)) {
      body += `\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{\\small\n`;
      body += `\\textbf{답지}\\par\\smallskip\n`;
      if (answers.length) {
        const list = answers
          .map((a, i) => `(${i + 1}) ${escPlain(a)}`)
          .join("\\quad ");
        body += `\\textbf{빈칸:}\\ ${list}\\par\\smallskip\n`;
      }
      const en = tasks.filter((t) => t.en);
      if (en.length) {
        body += `\\textbf{영작:}\\par\n`;
        body += `\\begin{enumerate}[label=\\arabic*.]\n`;
        for (const t of en) body += `\\item ${escPlain(t.en)}\n`;
        body += `\\end{enumerate}\n`;
      }
      body += `}}\\par\\medskip\n`;
    }

    if (!blanked && !tasks.length) {
      body += `{\\small\\textcolor{ansgray}{(이 지문의 빈칸학습지 내용이 비어 있습니다.)}}\\par\\medskip\n`;
    }
    body += `\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });

  return `${PREAMBLE()}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// 한 페이지 안내 PDF(조판 실패 시 그 PDF 만 대체).
function buildPlaceholderTex(label, reason) {
  return `${PREAMBLE()}
\\begin{document}
{\\large\\bfseries ${escPlain(label)} 조판 실패}\\par\\medskip
이 PDF 는 조판 중 오류로 생성하지 못했습니다. 나머지 PDF 는 정상 생성되었습니다.\\par\\smallskip
{\\footnotesize ${escPlain(String(reason || "").slice(0, 200))}}\\par
\\end{document}
`;
}

// 조판 시도 → 실패하면 안내 페이지로 대체(나머지 ZIP 은 살림).
async function compileSafe(buildTex, label, { signal, onProgress }) {
  try {
    return await compileTex(buildTex(), { signal, onProgress });
  } catch (e) {
    onProgress(`⚠ ${label} 조판 실패 → 안내 페이지로 대체 (${String(e.message).slice(0, 90)})`);
    return await compileTex(buildPlaceholderTex(label, e.message), { signal, onProgress });
  }
}

// 간단 동시성 풀.
async function runPool(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      await fn(list[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, worker),
  );
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
 * @param {Object} content  generate.js 산출 content { title, passages[], notes[] }
 * @param {Object} opts      { studentId, userName, sourceFilename, signal, onProgress }
 * @returns {Promise<{buffer:Buffer, filename:string}>}
 */
async function generateBundle(content, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;
  const title = content.title || "영어 시험대비 자료";
  const passages = Array.isArray(content.passages) ? content.passages : [];
  const notes = Array.isArray(content.notes) ? content.notes : [];

  if (passages.length === 0) {
    throw new Error("지문이 없어 자료를 만들 수 없습니다.");
  }

  // Tectonic 은 프로세스당 메모리를 많이 써 동시 다수 조판 시 OOM 위험 → 기본 순차(1개씩).
  const COMPILE_CONC = (() => {
    const env = parseInt(process.env.ENG_EXAM_COMPILE_CONCURRENCY || "", 10);
    if (Number.isFinite(env) && env > 0) return Math.min(3, env);
    return 1;
  })();
  onProgress(
    COMPILE_CONC > 1
      ? "📐 3종 PDF 동시 조판 중 (Tectonic)..."
      : "📐 3종 PDF 순차 조판 중 (메모리 절약, Tectonic)...",
  );

  const jobs = [
    { label: "모의고사", build: () => buildExamTex({ title, passages, notes }) },
    { label: "개념정리문제", build: () => buildConceptTex({ title, passages, notes }) },
    { label: "빈칸학습지", build: () => buildClozeTex({ title, passages, notes }) },
  ];
  const compiled = new Array(jobs.length);
  await runPool(jobs, COMPILE_CONC, async (job, i) => {
    compiled[i] = await compileSafe(job.build, job.label, { signal, onProgress });
  });
  const [examPdf, conceptPdf, clozePdf] = compiled;

  onProgress("📦 3개 PDF를 ZIP으로 묶는 중...");
  const zip = new JSZip();
  zip.file("01_모의고사.pdf", examPdf);
  zip.file("02_개념정리문제.pdf", conceptPdf);
  zip.file("03_빈칸학습지.pdf", clozePdf);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const base = sanitizeName(opts.sourceFilename || title) || "영어시험대비";
  const filename = `${base}_시험대비_3종세트.zip`;
  return { buffer, filename };
}

module.exports = { generateBundle };
