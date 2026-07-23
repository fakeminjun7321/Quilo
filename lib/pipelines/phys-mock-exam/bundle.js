// 물리 모의고사 - 시험지+답안지 PDF(LaTeX) + HWPX(한글) 를 ZIP 하나로 묶는다.
//
// generate.js 가 만든 content({ meta, problems[] }) 를 받아:
//   1) 시험지(문제 + 답안 박스)와 답안지(모범답안 + 채점기준)를 LaTeX 로 조판(Tectonic).
//      한 문서에 두 섹션(시험지/답안지)을 \section 으로 넣어 PDF 북마크(목차)를 만든다.
//   2) Python(build_hwpx.py)을 spawn 해 같은 JSON 으로 HWPX 를 만든다.
//      Python/HWPX 실패 시 PDF-only ZIP 으로 graceful degrade(throw 금지).
//   3) PDF + HWPX 를 ZIP 으로 묶어 { buffer, filename } 반환.
//
// 수식 처리: 모델이 $...$/\[..\] 로 낸 LaTeX 는 신뢰하되, 수식 밖 평문에 새어든·미정규
//   수식을 방어한다(problem-set/bundle.js 의 fixInlineLatex 패턴 재사용).

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const JSZip = require("jszip");
const { assertGeneratedOutputMagic } = require("../../output-validate");
const { compileTex } = require("../pdf-translate/latex-pdf");

const FONT_DIR = path.join(__dirname, "../../fonts");
const HAS_PRETENDARD = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"));
const MAIN_FONT = HAS_PRETENDARD ? "Pretendard-Regular.ttf" : "NanumGothic-Regular.ttf";
const BOLD_FONT = fs.existsSync(path.join(FONT_DIR, "Pretendard-Bold.ttf"))
  ? "Pretendard-Bold.ttf"
  : null;

const PY_SCRIPT = path.join(__dirname, "build_hwpx.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv1 = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venv1)) return venv1;
  const venv2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venv2)) return venv2;
  return "python3";
}
const PYTHON = detectPython();

// ── LaTeX 이스케이프 + 수식 정규화 (problem-set/bundle.js 와 동일 전략) ───────
function escPlain(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%#_{}$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}
function fixMathPrimes(s) {
  return String(s).replace(/[’‘′]/g, "'").replace(/[“”″]/g, '"');
}
function balanceLeftRight(eq) {
  const l = (eq.match(/\\left\b/g) || []).length;
  const r = (eq.match(/\\right\b/g) || []).length;
  if (l === r) return eq;
  return l > r ? eq + "\\right.".repeat(l - r) : "\\left.".repeat(r - l) + eq;
}
function balanceBraces(s) {
  let depth = 0,
    out = String(s);
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "\\") {
      i++;
      continue;
    }
    if (out[i] === "{") depth++;
    else if (out[i] === "}") {
      if (depth > 0) depth--;
      else {
        out = "{" + out;
        i++;
      }
    }
  }
  if (depth > 0) out += "}".repeat(depth);
  return out;
}
function balanceBeginEnd(s) {
  s = String(s);
  const stack = [];
  const drop = [];
  const re = /\\(begin|end)\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[1] === "begin") stack.push(m[2]);
    else if (stack.length && stack[stack.length - 1] === m[2]) stack.pop();
    else drop.push([m.index, m.index + m[0].length]);
  }
  for (let k = drop.length - 1; k >= 0; k--) s = s.slice(0, drop[k][0]) + s.slice(drop[k][1]);
  while (stack.length) s += `\\end{${stack.pop()}}`;
  return s;
}
function sanitizeEquation(eq) {
  eq = String(eq == null ? "" : eq).replace(/\r\n/g, "\n");
  eq = eq.replace(/(?<!\\)\$/g, "");
  eq = fixMathPrimes(eq);
  eq = balanceBeginEnd(eq);
  eq = balanceLeftRight(eq);
  eq = balanceBraces(eq);
  if (/\\\\/.test(eq) && !/\\begin\s*\{/.test(eq)) {
    eq = eq.replace(/\\\\\s*$/, "");
    eq = `\\begin{aligned} ${eq} \\end{aligned}`;
  }
  return eq;
}
function sanitizeInline(inner) {
  return balanceBraces(
    balanceLeftRight(fixMathPrimes(String(inner == null ? "" : inner).replace(/\\\\/g, " "))),
  );
}
function escTextOnly(s) {
  return balanceBraces(s.replace(/(?<!\\)([%#&])/g, "\\$1"));
}
function escTextWithStrayMath(s) {
  return String(s)
    .replace(/\\([a-zA-Z]+)/g, "\\textbackslash{}$1")
    .replace(/(?<!\\)([%#&_])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}");
}
function fixTextLine(line) {
  if (!line.trim()) return line;
  const hasMath = /\\[a-zA-Z]+|[_^]/.test(line);
  if (!hasMath) return escTextOnly(line);
  const hasHangul = /[가-힣]/.test(line);
  const prose = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(line);
  if (!hasHangul && !prose) {
    return `\\[ ${sanitizeEquation(line)} \\]`;
  }
  return escTextWithStrayMath(line);
}
function fixTextRun(run) {
  return run.split("\n").map(fixTextLine).join("\n");
}
// 모델 LaTeX(인라인 $...$, 디스플레이 \[..\]/\(..\)) 신뢰 + 평문 방어.
function fixInlineLatex(s) {
  s = String(s == null ? "" : s).replace(/\r\n/g, "\n");
  let out = "",
    buf = "",
    i = 0;
  const n = s.length;
  const flush = () => {
    if (buf) {
      out += fixTextRun(buf);
      buf = "";
    }
  };
  while (i < n) {
    const c = s[i];
    if (c === "$") {
      const dd = s[i + 1] === "$";
      const close = dd ? "$$" : "$";
      const j = s.indexOf(close, i + close.length);
      flush();
      if (j === -1) {
        out += close + sanitizeInline(s.slice(i + close.length)) + close;
        break;
      }
      out += close + sanitizeInline(s.slice(i + close.length, j)) + close;
      i = j + close.length;
      continue;
    }
    if (c === "\\" && (s[i + 1] === "[" || s[i + 1] === "(")) {
      const isDisplay = s[i + 1] === "[";
      const open = s.slice(i, i + 2);
      const closeTok = isDisplay ? "\\]" : "\\)";
      const j = s.indexOf(closeTok, i + 2);
      flush();
      const inner = j === -1 ? s.slice(i + 2) : s.slice(i + 2, j);
      out += open + (isDisplay ? sanitizeEquation(inner) : sanitizeInline(inner)) + closeTok;
      if (j === -1) break;
      i = j + 2;
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}
function safeInline(s) {
  return escPlain(s);
}
function textOf(s, safe) {
  return safe ? safeInline(s) : fixInlineLatex(s);
}
function isBad(bad, id) {
  return bad === "ALL" || (bad != null && typeof bad.has === "function" && bad.has(id));
}
// 'l.<N>' 에러 라인 → 가장 가까운 %%BLOCK 마커 id (블록 단위 안전모드 격리).
function mapErrorLinesToBlocks(tex, log) {
  const lines = String(tex).split("\n");
  const lineBlock = new Array(lines.length + 2).fill(null);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^%%BLOCK:(.+)$/);
    if (m) cur = m[1].trim();
    lineBlock[i + 1] = cur;
  }
  const ids = new Set();
  const re = /(?:^|[^a-zA-Z])l\.(\d+)|doc\.tex:(\d+)/g;
  let m;
  while ((m = re.exec(String(log || "")))) {
    const ln = parseInt(m[1] || m[2], 10);
    if (ln >= 1 && ln < lineBlock.length && lineBlock[ln]) ids.add(lineBlock[ln]);
  }
  return [...ids];
}

// ── 프리앰블 (한국어 본문 → Pretendard fontspec; 답안 박스·채점 박스 매크로) ──
function preamble() {
  return `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,top=18mm,bottom=20mm,left=18mm,right=18mm]{geometry}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage[colorlinks=true,linkcolor=themedark,bookmarksopen=true]{hyperref}
\\usepackage{bookmark}
\\setmainfont{${MAIN_FONT}}[Path=${FONT_DIR}/${BOLD_FONT ? `, BoldFont=${BOLD_FONT}` : ", AutoFakeBold=2.5"}]
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{4pt}
\\definecolor{themedark}{HTML}{12324F}
\\definecolor{themeblue}{HTML}{1F5C8B}
\\definecolor{rulegray}{HTML}{C9D4DE}
\\definecolor{gradingbg}{HTML}{F1F5F9}
\\definecolor{ansbg}{HTML}{F7FAFC}
\\setlength{\\emergencystretch}{3em}
\\newcommand{\\probnum}[2]{\\colorbox{themedark}{\\textcolor{white}{\\bfseries\\,#1\\,}}\\hspace{2mm}\\mbox{\\small[#2점]}}
\\newcommand{\\ansbox}{\\par\\smallskip\\fcolorbox{rulegray}{ansbg}{\\parbox[t][20mm][t]{\\dimexpr\\linewidth-2\\fboxsep}{\\textbf{답:}}}\\par\\smallskip}
`;
}

// 객관식 보기 목록.
function choicesTex(choices, safe) {
  if (!Array.isArray(choices) || !choices.length) return "";
  let out = "\\begin{itemize}[leftmargin=8mm,itemsep=1pt,topsep=2pt,label={}]\n";
  for (const ch of choices) out += `\\item ${textOf(ch, safe)}\n`;
  out += "\\end{itemize}\n";
  return out;
}

// ── 시험지(문제) LaTeX 본문 ─────────────────────────────────────────────────
function examBodyTex(problems, bad) {
  let body = "";
  problems.forEach((p, idx) => {
    const safe = isBad(bad, `e:${idx}`);
    body += `%%BLOCK:e:${idx}\n`;
    body += `\\needspace{4\\baselineskip}\\noindent\\probnum{${idx + 1}}{${p.points || 0}}\\quad ${textOf(p.statement, safe)}\\par\n`;
    if (p.figure && typeof p.figure === "string" && p.figure.trim().toLowerCase() !== "none") {
      body += `\\par\\smallskip\\noindent{\\small\\itshape〔그림〕 ${escPlain(p.figure)}}\\par\n`;
    }
    body += choicesTex(p.choices, safe);
    body += `\\ansbox\n`;
    body += `\\par\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });
  return body;
}

// ── 답안지(모범답안 + 채점기준) LaTeX 본문 ──────────────────────────────────
function keyBodyTex(problems, bad) {
  let body = "";
  problems.forEach((p, idx) => {
    const safe = isBad(bad, `k:${idx}`);
    body += `%%BLOCK:k:${idx}\n`;
    body += `\\needspace{4\\baselineskip}\\noindent\\probnum{${idx + 1}}{${p.points || 0}}\\quad{\\small ${textOf(p.statement, safe)}}\\par\\smallskip\n`;
    if (p.answer && String(p.answer).trim()) {
      body += `\\noindent\\textbf{정답:}\\ ${textOf(p.answer, safe)}\\par\\smallskip\n`;
    }
    if (p.solution && String(p.solution).trim()) {
      body += `\\noindent\\textbf{풀이.}\\ ${textOf(p.solution, safe)}\\par\\smallskip\n`;
    }
    if (p.grading && String(p.grading).trim()) {
      body += `\\noindent\\colorbox{gradingbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{\\small\\textbf{채점기준:}\\ ${textOf(p.grading, safe)}}}\\par\\smallskip\n`;
    }
    body += `\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });
  return body;
}

function headBlock(title, subtitle) {
  return `{\\LARGE\\bfseries\\textcolor{themedark}{${escPlain(title)}}}\\hfill{\\small\\textcolor{themeblue}{${escPlain(subtitle)}}}\\par\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.6mm}}\\par\\medskip\n`;
}

// 시험지+답안지 한 문서. \section 으로 PDF 북마크(목차) 생성.
function buildFullTex({ problems, title, meta, date }, bad) {
  const totalPts = problems.reduce((s, p) => s + (p.points || 0), 0);
  const sub = [meta.unit, meta.course].filter(Boolean).join(" · ");
  const metaLine = `${problems.length}문항 · 총 ${totalPts}점${date ? ` · ${date}` : ""}${sub ? ` · ${escPlain(sub)}` : ""}`;
  let body = "";
  body += `\\section*{${escPlain(title)} - 시험지}\\addcontentsline{toc}{section}{시험지}\n`;
  body += headBlock(`${title}`, "시험지 (문제)");
  body += `\\noindent{\\small ${metaLine}}\\par\\smallskip\\noindent{\\small 이름: \\underline{\\hspace{30mm}}\\quad 학번: \\underline{\\hspace{25mm}}}\\par\\medskip\n`;
  if (meta.style_notes) {
    body += `\\noindent{\\footnotesize 모든 수치는 계산기 없이 풀리도록 구성되었습니다.}\\par\\medskip\n`;
  }
  body += examBodyTex(problems, bad);
  body += `\\clearpage\n`;
  body += `\\section*{${escPlain(title)} - 답안지}\\addcontentsline{toc}{section}{답안지 · 채점기준}\n`;
  body += headBlock(`${title}`, "답안지 (모범답안 · 채점기준)");
  body += `\\noindent{\\small 각 문제의 부분점수 합이 배점과 같습니다.}\\par\\medskip\n`;
  body += keyBodyTex(problems, bad);

  // needspace 는 \usepackage 라 프리앰블에 있어야 한다 → 프리앰블에 추가해 조립.
  const pre = preamble() + "\\usepackage{needspace}\n";
  return `${pre}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// 안내 PDF(조판 완전 실패 시 1페이지 대체).
function placeholderTex(reason) {
  return `${preamble()}\\usepackage{needspace}
\\begin{document}
{\\large\\bfseries 물리 모의고사 PDF 조판 실패}\\par\\medskip
조판 중 오류로 PDF 를 생성하지 못했습니다.\\par\\smallskip
{\\footnotesize ${escPlain(String(reason || "").slice(0, 200))}}\\par
\\end{document}
`;
}

// 블록 단위 안전모드 격리 컴파일(problem-set/bundle.js 패턴).
const MAX_LOCALIZE_ROUNDS = 8;
async function compileResilient(build, { signal, onProgress }) {
  const bad = new Set();
  let lastErr = null;
  for (let round = 0; round <= MAX_LOCALIZE_ROUNDS; round++) {
    const tex = build(bad);
    try {
      return await compileTex(tex, { signal, onProgress });
    } catch (e) {
      lastErr = e;
      const ids = mapErrorLinesToBlocks(tex, e.texLog || e.message || "");
      const fresh = ids.filter((id) => !bad.has(id));
      if (!fresh.length) break;
      fresh.forEach((id) => bad.add(id));
      onProgress(`⚠ 수식 ${fresh.length}곳만 격리 후 재시도 (${round + 1}차, 누적 ${bad.size}곳)`);
    }
  }
  try {
    onProgress(`⚠ 남은 수식 평문 폴백 (${String((lastErr && lastErr.message) || "").slice(0, 80)})`);
    return await compileTex(build("ALL"), { signal, onProgress });
  } catch (e2) {
    onProgress(`⚠ PDF 조판 실패 → 안내 페이지로 대체 (${String(e2.message).slice(0, 80)})`);
    return await compileTex(placeholderTex(e2.message), { signal, onProgress });
  }
}

// ── HWPX (Python spawn) ─────────────────────────────────────────────────────
function generateHwpx(content, { signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "pmx-"));
    const outPath = path.join(outDir, "exam.hwpx");
    const proc = spawn(PYTHON, [PY_SCRIPT, outPath], { stdio: ["pipe", "pipe", "pipe"] });
    const stderr = [];
    let settled = false;
    const cleanup = () => {
      try {
        fs.rmSync(outDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    proc.stderr.on("data", (c) => stderr.push(c));
    proc.on("error", (err) =>
      fail(new Error(`build_hwpx.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`)),
    );
    proc.stdin.on("error", (err) =>
      fail(new Error(`build_hwpx.py stdin 쓰기 실패(EPIPE 등): ${err.message}`)),
    );
    proc.on("close", (code) => {
      if (settled) return;
      const log = Buffer.concat(stderr).toString("utf8");
      if (code !== 0 || !fs.existsSync(outPath)) {
        settled = true;
        cleanup();
        reject(new Error(`build_hwpx.py 종료 코드 ${code}\n${log.slice(0, 1000)}`));
        return;
      }
      try {
        const buf = assertGeneratedOutputMagic(
          fs.readFileSync(outPath),
          "hwpx",
          "phys-mock HWPX output",
        );
        settled = true;
        cleanup();
        resolve(buf);
      } catch (e) {
        fail(e);
      }
    });

    if (signal) {
      if (signal.aborted) proc.kill("SIGKILL");
      else signal.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    }

    // build_hwpx.py 는 stdin 으로 JSON payload 를 받는다.
    try {
      proc.stdin.write(JSON.stringify(content));
      proc.stdin.end();
    } catch (e) {
      fail(e);
    }
  });
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
 * @param {Object} content  generate.js 산출 { meta, problems[], date }
 * @param {Object} opts     { studentId, userName, sourceFilename, signal, onProgress }
 * @returns {Promise<{buffer:Buffer, filename:string}>}
 */
async function generateBundle(content, opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const signal = opts.signal;
  const problems = Array.isArray(content.problems) ? content.problems : [];
  if (!problems.length) throw new Error("출제된 문제가 없습니다.");
  const meta = content.meta && typeof content.meta === "object" ? content.meta : {};
  const title = meta.unit ? `물리 모의고사 - ${meta.unit}` : "물리 모의고사";
  const date = content.date || "";

  // ── 1) PDF (시험지+답안지) ────────────────────────────────────────────────
  onProgress("📐 시험지·답안지 PDF 조판 중 (Tectonic)...");
  const pdf = await compileResilient(
    (bad) => buildFullTex({ problems, title, meta, date }, bad),
    { signal, onProgress },
  );

  // ── 2) HWPX (Python) - 실패 시 PDF-only 로 degrade ─────────────────────────
  let hwpx = null;
  try {
    onProgress("📄 HWPX(한글) 생성 중...");
    hwpx = await generateHwpx({ meta, problems, date, title }, { signal, onProgress });
    onProgress("✓ HWPX 생성 완료");
  } catch (e) {
    onProgress(`⚠ HWPX 생성 실패 - PDF 만 묶습니다: ${String(e.message).slice(0, 140)}`);
    hwpx = null;
  }

  // ── 3) ZIP ─────────────────────────────────────────────────────────────────
  onProgress("📦 ZIP 으로 묶는 중...");
  const zip = new JSZip();
  zip.file("물리모의고사.pdf", pdf);
  if (hwpx && hwpx.length) zip.file("물리모의고사.hwpx", hwpx);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const base = sanitizeName(opts.sourceFilename || meta.unit || "물리모의고사") || "물리모의고사";
  const filename = `${base}_모의고사.zip`;
  return {
    buffer: assertGeneratedOutputMagic(buffer, "zip", "phys-mock bundle ZIP"),
    filename,
  };
}

module.exports = { generateBundle };
