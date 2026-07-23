// 문제집 메이커 - 3종 PDF(영어 문제지·한글 문제지·해설지) 조판 + ZIP 묶음.
//
// generate.js 가 만든 content(JSON) + 첨부 자산(소스 PDF·후보 그림 버퍼)을 받아:
//   1) 각 문제의 그림을 확정(후보 버퍼 또는 page+bbox 크롭 폴백).
//   2) 해설지의 chart 는 PNG 로, image(삽화 프롬프트)는 gpt-image 로 렌더.
//   3) 영어 문제지·한글 문제지·해설지를 LaTeX 로 조판(Tectonic) - 실패 시 안전모드,
//      그래도 실패하면 그 PDF 1개만 안내 페이지로 대체(나머지는 정상 출력).
//   4) 세 PDF 를 ZIP 하나로 묶어 Buffer 로 돌려준다.
//
// 자산 파일명은 문제/해설의 **배열 인덱스**로 만든다(문제 번호 num 으로 만들면
// "1(a)"·"1.a" 가 같은 파일로 충돌). 그림은 문제 인덱스, 차트/삽화는 해설 인덱스 기준.

const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { compileTex } = require("../pdf-translate/latex-pdf");
const { renderChart } = require("../chem-result/chart-gen");
const { genImage } = require("../../report-image-gen");
const { cropRegions } = require("./figures");

const FONT_DIR = path.join(__dirname, "../../fonts");
const HAS_PRETENDARD = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"));
const MAIN_FONT = HAS_PRETENDARD ? "Pretendard-Regular.ttf" : "NanumGothic-Regular.ttf";
const BOLD_FONT = fs.existsSync(path.join(FONT_DIR, "Pretendard-Bold.ttf"))
  ? "Pretendard-Bold.ttf"
  : null;
const PS_IMAGE_MODEL =
  process.env.PROBLEMSET_IMAGE_MODEL || process.env.IMAGE_MODEL_HIGH || "gpt-image-2";
// 해설 삽화는 최대 2장(AI 삽화는 부정확·장식이 많아 보수적으로). env 로 조절.
const MAX_ANSWER_IMAGES = Math.max(
  0,
  parseInt(process.env.PROBLEMSET_IMAGE_MAX || "2", 10) || 2,
);

// ── LaTeX 이스케이프 + 수식 정규화 ──────────────────────────────────────────
// 전체 이스케이프(평문 전용: 제목·캡션·표 셀·번호). 수식 없음 가정.
function escPlain(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%#_{}$])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

// 굽은 따옴표/프라임 → 곧은 ASCII(수식 안에서 프라임으로 렌더되게). ’‘′ → '
function fixMathPrimes(s) {
  return String(s).replace(/[’‘′]/g, "'").replace(/[“”″]/g, '"');
}

// 수식 안 \left … \right 짝 맞추기(부족분은 널 구분자 \left. / \right. 로 보충).
function balanceLeftRight(eq) {
  const l = (eq.match(/\\left\b/g) || []).length;
  const r = (eq.match(/\\right\b/g) || []).length;
  if (l === r) return eq;
  return l > r ? eq + "\\right.".repeat(l - r) : "\\left.".repeat(r - l) + eq;
}

// 이스케이프 안 된 중괄호 균형(여는 게 모자라면 앞에, 닫는 게 모자라면 뒤에 보충).
function balanceBraces(s) {
  let depth = 0, out = String(s);
  for (let i = 0; i < out.length; i++) {
    if (out[i] === "\\") { i++; continue; }
    if (out[i] === "{") depth++;
    else if (out[i] === "}") { if (depth > 0) depth--; else { out = "{" + out; i++; } }
  }
  if (depth > 0) out += "}".repeat(depth);
  return out;
}

// \begin{env} … \end{env} 스택 매칭(안 닫힌 건 LIFO 로 \end 보충, 짝 없는 \end 는 제거).
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

// 디스플레이 수식 1개 정규화: 떠돌이 $ 제거 → 프라임 → 환경·\left/\right·중괄호 균형 →
// 여러 줄(\\)이면 aligned 로 감싼다. 멱등(이미 정상인 입력엔 무해).
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

// 이미 구분자가 있는 인라인 수식($...$, \(...\)) 안쪽 정규화. 인라인은 줄바꿈(\\)이
// 불가하므로 공백으로 바꾼다. 프라임·균형만 보정.
function sanitizeInline(inner) {
  return balanceBraces(balanceLeftRight(fixMathPrimes(String(inner == null ? "" : inner).replace(/\\\\/g, " "))));
}

// 평문(수식 토큰 없음): % # & 이스케이프 + 중괄호만 균형.
function escTextOnly(s) {
  return balanceBraces(s.replace(/(?<!\\)([%#&])/g, "\\$1"));
}

// 평문에 새어든 수식 전용 토큰(\frac, _, ^ 등)을 텍스트모드에서 안전하게(리터럴로) 만든다.
// 모델이 $ 를 빠뜨린 드문 경우 - 크래시 대신 약간 못생긴 리터럴로 떨어뜨린다.
function escTextWithStrayMath(s) {
  return String(s)
    .replace(/\\([a-zA-Z]+)/g, "\\textbackslash{}$1")
    .replace(/(?<!\\)([%#&_])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}");
}

// 한 줄(수식 구분자 밖) 처리: 순수 수식 줄이면 \[..\] 로 감싸고(핵심 브레이커 차단),
// 평문이면 그대로, 평문+새어든 수식이면 안전 이스케이프.
function fixTextLine(line) {
  if (!line.trim()) return line;
  const hasMath = /\\[a-zA-Z]+|[_^]/.test(line);
  if (!hasMath) return escTextOnly(line);
  const hasHangul = /[가-힣]/.test(line);
  const prose = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(line);
  if (!hasHangul && !prose) {
    // 모델이 구분자 없이 평문 줄로 내보낸 디스플레이 수식 → 자동 래핑.
    return `\\[ ${sanitizeEquation(line)} \\]`;
  }
  return escTextWithStrayMath(line);
}

function fixTextRun(run) {
  return run.split("\n").map(fixTextLine).join("\n");
}

// 모델 LaTeX(인라인 $...$, 디스플레이 \[..\]/\(..\) 포함)를 신뢰하되, 수식 밖 평문에
// 새어든·미정규 수식을 방어한다. 수식 구간은 보존(프라임·균형만 보정), 구분자 없는 평문
// 줄에 든 디스플레이 수식은 자동으로 \[..\] 로 감싼다(모델이 $·\[ 를 빠뜨리는 주 브레이커).
function fixInlineLatex(s) {
  s = String(s == null ? "" : s).replace(/\r\n/g, "\n");
  let out = "", buf = "", i = 0;
  const n = s.length;
  const flush = () => { if (buf) { out += fixTextRun(buf); buf = ""; } };
  while (i < n) {
    const c = s[i];
    if (c === "$") {
      const dd = s[i + 1] === "$";
      const close = dd ? "$$" : "$";
      const j = s.indexOf(close, i + close.length);
      flush();
      if (j === -1) {
        // 닫는 $ 누락 → 나머지를 수식으로 보고 닫는다(프라임/균형 보정).
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

// 안전모드: 수식까지 전부 평문 이스케이프(컴파일 보장, 수식 서식 포기).
function safeInline(s) {
  return escPlain(s);
}

function textOf(s, safe) {
  return safe ? safeInline(s) : fixInlineLatex(s);
}

// 블록 단위 안전모드 격리: bad 는 나쁜 블록 id 들의 Set, 또는 "ALL"(전부 안전모드).
// 기본(빈 Set)이면 모든 블록이 신뢰모드 → 출력은 수정 전과 동일(마커 주석만 추가).
function isBad(bad, id) {
  return bad === "ALL" || (bad != null && typeof bad.has === "function" && bad.has(id));
}

// 조판 실패 시 'l.<N>' 에러 라인을 가장 가까운 직전 %%BLOCK 마커 id 로 매핑한다.
function mapErrorLinesToBlocks(tex, log) {
  const lines = String(tex).split("\n");
  const lineBlock = new Array(lines.length + 2).fill(null);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^%%BLOCK:(.+)$/);
    if (m) cur = m[1].trim();
    lineBlock[i + 1] = cur; // 1-indexed 물리 라인
  }
  const ids = new Set();
  const re = /(?:^|[^a-zA-Z])l\.(\d+)|doc\.tex:(\d+)/g;
  let m;
  while ((m = re.exec(String(log || "")))) {
    const n = parseInt(m[1] || m[2], 10);
    if (n >= 1 && n < lineBlock.length && lineBlock[n]) ids.add(lineBlock[n]);
  }
  return [...ids];
}

const PREAMBLE_COMMON = (extra = "") => `\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=14mm]{geometry}
\\usepackage{graphicx}
\\usepackage{xcolor}
\\usepackage{array}
\\usepackage{setspace}
\\setmainfont{${MAIN_FONT}}[Path=${FONT_DIR}/${BOLD_FONT ? `, BoldFont=${BOLD_FONT}` : ", AutoFakeBold=2.5"}]
\\setlength{\\parindent}{0pt}
\\definecolor{themegreen}{HTML}{1F7A5A}
\\definecolor{themedark}{HTML}{0F3D2E}
\\definecolor{rulegray}{HTML}{C8D6CF}
\\definecolor{reconorange}{HTML}{B45309}
\\definecolor{softbg}{HTML}{F3F8F5}
\\setlength{\\emergencystretch}{3em}
${extra}`;

// 번호 배지.
function numBadge(num) {
  return `\\colorbox{themegreen}{\\textcolor{white}{\\bfseries\\,${escPlain(num)}\\,}}`;
}

// 재구성/불일치 배지.
function reconBadge() {
  return `\\,\\colorbox{reconorange}{\\textcolor{white}{\\footnotesize\\,재구성됨\\,}}`;
}
function uncertainBadge() {
  return `\\,\\colorbox{reconorange}{\\textcolor{white}{\\footnotesize\\,재확인 필요\\,}}`;
}

// 표 블록(평문 데이터) → tabular. 행은 헤더 열 수에 맞춰 빈칸으로 패딩(짧은 행이 깨짐 방지).
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
  const cap = t.caption || t.title;
  return (
    `\\begin{center}\\small\n\\begin{tabular}{${spec}}\\hline\n` +
    `${head} \\\\ \\hline\n${rows}${rows ? " \\\\ \\hline" : ""}\n` +
    `\\end{tabular}\n${cap ? `\\\\[2pt]{\\footnotesize ${escPlain(cap)}}` : ""}\\end{center}\n`
  );
}

// solution 블록 배열 → LaTeX. bad 격리용으로 각 블록 앞에 %%BLOCK 마커를 찍고
// 블록별로 신뢰/안전 모드를 결정한다(baseId 예: "a:3" → 블록 id "a:3:b0" …).
function blocksTex(blocks, bad, baseId) {
  const arr = Array.isArray(blocks) ? blocks : blocks ? [blocks] : [];
  let out = "";
  arr.forEach((b, k) => {
    const id = `${baseId}:b${k}`;
    const safe = isBad(bad, id);
    out += `%%BLOCK:${id}\n`;
    if (typeof b === "string") {
      if (b.trim()) out += `${textOf(b, safe)}\\par\\smallskip\n`;
    } else if (b && typeof b === "object") {
      if (typeof b.equation === "string" && b.equation.trim()) {
        // 수식 블록은 순수 LaTeX(계약). 신뢰모드는 sanitizeEquation 으로 균형 보정 후 \[..\]
        // (떠돌이 $ 제거, \left/\right·중괄호·\begin/\end 균형, 여러 줄 aligned 래핑).
        // 안전모드만 평문화. compileTex 의 sanitizeUntrustedTex 가 파일 IO 위험만 차단.
        out += safe
          ? `\\texttt{${safeInline(b.equation)}}\\par\\smallskip\n`
          : `\\[ ${sanitizeEquation(b.equation)} \\]\n`;
      } else if (b.table) {
        out += tableTex(b.table);
      } else if (typeof b.subheading === "string") {
        out += `\\textbf{${textOf(b.subheading, safe)}}\\par\\smallskip\n`;
      }
    }
  });
  return out;
}

function figureTex(filename, widthFrac = 0.55, maxH = "42mm") {
  return `\\begin{center}\\includegraphics[width=${widthFrac}\\linewidth,height=${maxH},keepaspectratio]{${filename}}\\end{center}\n`;
}

// ── 문제지(영어/한글) LaTeX ─────────────────────────────────────────────────
function buildWorksheetTex({ problems, lang, nPerPage, title, figByIdx, bad }) {
  const N = Math.max(1, Math.min(12, nPerPage));
  const gapCount = N - 1;
  const subtitle = lang === "ko" ? "문제지 (한국어)" : "Worksheet (English)";
  const preamble = PREAMBLE_COMMON(`\\newdimen\\slotgap \\slotgap=3mm
\\newdimen\\slotheight
% 페이지마다 머리글(제목+구분선)이 ~18mm 차지하므로 예약 후 N등분.
\\setlength{\\slotheight}{\\dimexpr(\\textheight - ${gapCount}\\slotgap - 20mm)/${N}\\relax}
% 풀이 칸: 7mm 간격의 옅은 가로줄로 슬롯의 남은 높이를 채운다.
\\newcommand{\\ruleunit}{\\vbox to 7mm{\\vfil\\hbox to \\linewidth{\\textcolor{rulegray}{\\rule{\\linewidth}{0.12mm}}}}}
\\newcommand{\\solveruling}{\\leaders\\ruleunit\\vfill}`);

  const header = `{\\large\\bfseries\\textcolor{themedark}{${escPlain(title)}}}\\hfill{\\small\\textcolor{themegreen}{${escPlain(subtitle)}}}\\\\[1mm]\\textcolor{rulegray}{\\rule{\\linewidth}{0.5mm}}\\par\\medskip\n`;

  const slot = (p, idx) => {
    const num = numBadge(p.num);
    const recon = p.reconstructed ? reconBadge() : "";
    const safe = isBad(bad, `w:${lang}:${idx}`);
    const body = lang === "ko" ? p.text_ko || p.text_en || "" : p.text_en || p.text_ko || "";
    let fig = "";
    const f = figByIdx.get(idx);
    if (f) fig = figureTex(f, 0.5, "40mm");
    let given = "";
    if (p.given_data && Array.isArray(p.given_data.headers)) {
      given = tableTex(p.given_data);
    }
    return `\\vbox to \\slotheight{%
\\hsize=\\linewidth
\\noindent${num}\\hspace{2mm}${recon}\\hspace{1mm}${textOf(body, safe)}\\par
${given}${fig}\\vspace{1mm}
\\solveruling
}`;
  };

  // 슬롯(\vbox)을 수직 모드에서 \nointerlineskip 으로 쌓아 글루 누적(페이지 넘침) 방지.
  let bodyTex = header;
  for (let i = 0; i < problems.length; i++) {
    bodyTex += `\\nointerlineskip\n%%BLOCK:w:${lang}:${i}\n` + slot(problems[i], i) + "\n";
    if (i === problems.length - 1) break;
    const lastOnPage = (i + 1) % N === 0;
    if (lastOnPage) {
      bodyTex += "\\newpage\n" + header;
    } else {
      bodyTex += "\\nointerlineskip\\vskip\\slotgap\n";
    }
  }

  return `${preamble}
\\begin{document}\\sloppy
${bodyTex}
\\end{document}
`;
}

// ── 해설지 LaTeX ────────────────────────────────────────────────────────────
function buildAnswerTex({ answerKey, title, notes, assetByIdx, bad }) {
  const preamble = PREAMBLE_COMMON("");
  let body = `{\\LARGE\\bfseries\\textcolor{themedark}{${escPlain(title)} - 해설지}}\\par\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.6mm}}\\par\\medskip\n`;

  if (Array.isArray(notes) && notes.length) {
    body += `\\colorbox{softbg}{\\parbox{\\dimexpr\\linewidth-2\\fboxsep}{\\footnotesize\n`;
    body += notes.map((nt) => `\\textbullet\\ ${escPlain(nt)}`).join("\\\\\n");
    body += `\n}}\\par\\medskip\n`;
  }

  answerKey.forEach((a, idx) => {
    const num = numBadge(a.num);
    const badges = (a.reconstructed ? reconBadge() : "") + (a.uncertain ? uncertainBadge() : "");
    body += `\\noindent${num}${badges}\\par\\smallskip\n`;
    body += blocksTex(a.solution, bad, `a:${idx}`);

    const asset = assetByIdx.get(idx);
    if (asset && asset.chart) {
      body += `\\begin{center}\\includegraphics[width=0.82\\linewidth,height=72mm,keepaspectratio]{${asset.chart}}\\end{center}\n`;
    }
    if (asset && asset.image) {
      body += `\\begin{center}\\includegraphics[width=0.6\\linewidth,height=60mm,keepaspectratio]{${asset.image}}`;
      if (asset.imageCaption) body += `\\\\[2pt]{\\footnotesize ${escPlain(asset.imageCaption)}}`;
      body += `\\end{center}\n`;
    }

    if (a.final_answer && String(a.final_answer).trim()) {
      const faSafe = isBad(bad, `a:${idx}:fa`);
      body += `%%BLOCK:a:${idx}:fa\n\\smallskip\\noindent\\textbf{정답:}\\ ${textOf(a.final_answer, faSafe)}\\par\n`;
    }
    body += `\\smallskip\\textcolor{rulegray}{\\rule{\\linewidth}{0.2mm}}\\par\\medskip\n`;
  });

  return `${preamble}
\\begin{document}\\sloppy
${body}
\\end{document}
`;
}

// 한 페이지 안내 PDF(조판 실패 시 그 PDF 만 대체 - 나머지는 정상 출력).
function buildPlaceholderTex(label, reason) {
  return `${PREAMBLE_COMMON("")}
\\begin{document}
{\\large\\bfseries ${escPlain(label)} 조판 실패}\\par\\medskip
이 PDF 는 조판 중 오류로 생성하지 못했습니다. 나머지 PDF 는 정상 생성되었습니다.\\par\\smallskip
{\\footnotesize ${escPlain(String(reason || "").slice(0, 200))}}\\par
\\end{document}
`;
}

// 한 블록의 LaTeX 에러가 문서 전체를 안전모드로 떨어뜨리지 않도록 **블록 단위로 격리**한다.
// 1차 신뢰 컴파일 실패 → 에러 라인을 블록 id 로 매핑 → 그 블록만 안전모드로 돌리고 재컴파일
// (여러 라운드, 매 라운드 새 나쁜 블록만 추가). 격리로도 못 살리면 문서 전체 안전모드 →
// 그래도 실패면 그 PDF 1개만 안내 페이지로 대체(나머지 ZIP 은 살림).
const MAX_LOCALIZE_ROUNDS = 8;
async function compileResilient(build, assets, { signal, onProgress, label }) {
  const bad = new Set();
  let lastErr = null;
  for (let round = 0; round <= MAX_LOCALIZE_ROUNDS; round++) {
    const tex = build(bad);
    try {
      return await compileTex(tex, { signal, onProgress, assets });
    } catch (e) {
      lastErr = e;
      const ids = mapErrorLinesToBlocks(tex, e.texLog || e.message || "");
      const fresh = ids.filter((id) => !bad.has(id));
      if (!fresh.length) break; // 더 좁힐 수 없음 → 전체 안전모드로 폴백
      fresh.forEach((id) => bad.add(id));
      onProgress(`⚠ ${label} 수식 ${fresh.length}곳만 격리 후 재시도 (${round + 1}차, 누적 ${bad.size}곳)`);
    }
  }
  try {
    onProgress(`⚠ ${label} 남은 수식 평문 폴백 (${String((lastErr && lastErr.message) || "").slice(0, 80)})`);
    return await compileTex(build("ALL"), { signal, onProgress, assets });
  } catch (e2) {
    onProgress(`⚠ ${label} 조판 실패 → 안내 페이지로 대체 (${String(e2.message).slice(0, 80)})`);
    // 안내 PDF 는 자산 없이 컴파일(자산 자체가 원인일 수 있으므로).
    return await compileTex(buildPlaceholderTex(label, e2.message), { signal, onProgress });
  }
}

/**
 * @param {Object} content  generate.js 산출 content (+ __sourcePdf, __candidates, __allowImageGen)
 * @param {Object} ctx      { studentId, userName, sourceFilename, signal, onProgress }
 * @returns {Promise<{buffer:Buffer, filename:string}>}
 */
async function generateBundle(content, ctx = {}) {
  const onProgress = ctx.onProgress || (() => {});
  const signal = ctx.signal;
  const problems = Array.isArray(content.problems) ? content.problems : [];
  const answerKey = Array.isArray(content.answer_key) ? content.answer_key : [];
  const title = content.title || "Problem Set";
  const nPerPage = content.per_page || 6;
  const candById = content.__candidates instanceof Map ? content.__candidates : new Map();
  const sourcePdf = content.__sourcePdf || null;

  // ── 1) 문제 그림 확정 (파일명·매핑 모두 문제 배열 인덱스 기준) ─────────────
  const assets = []; // [{name, buffer}] - .tex 옆에 쓰여 \includegraphics 가 참조
  const figByIdx = new Map(); // problemIndex → asset filename
  const cropQueue = []; // {id, idx, page, bbox}
  problems.forEach((p, idx) => {
    const f = p.figure;
    if (!f) return;
    if (f.candidate_id && candById.has(f.candidate_id)) {
      const cand = candById.get(f.candidate_id);
      if (cand && cand.buffer && cand.buffer.length) {
        const name = `figp${idx}.png`;
        assets.push({ name, buffer: cand.buffer });
        figByIdx.set(idx, name);
      }
    } else if (sourcePdf && f.page && Array.isArray(f.bbox) && f.bbox.length === 4) {
      cropQueue.push({ id: `c${idx}`, idx, page: f.page, bbox: f.bbox });
    }
  });
  if (cropQueue.length && sourcePdf) {
    try {
      onProgress(`✂ 소스에서 그림 ${cropQueue.length}개 크롭 중...`);
      const crops = await cropRegions(sourcePdf, cropQueue, { signal });
      const idxById = new Map(cropQueue.map((q) => [q.id, q.idx]));
      for (const cr of crops) {
        const idx = idxById.get(cr.id);
        if (idx == null || !cr.buffer || !cr.buffer.length) continue;
        const name = `figc${idx}.png`;
        assets.push({ name, buffer: cr.buffer });
        figByIdx.set(idx, name);
      }
    } catch (e) {
      onProgress(`⚠ 그림 크롭 실패(건너뜀): ${e.message}`);
    }
  }

  // ── 2) 해설지 chart / image 렌더 (병렬 - 인덱스별 독립) ───────────────────
  const assetByIdx = new Map(); // answerIndex → {chart, image, imageCaption}
  const entryOf = (i) => {
    let e = assetByIdx.get(i);
    if (!e) {
      e = {};
      assetByIdx.set(i, e);
    }
    return e;
  };
  const chartJobs = [];
  const imageJobs = [];
  answerKey.forEach((a, i) => {
    if (a.chart && typeof a.chart === "object") chartJobs.push({ i, spec: a.chart });
    if (
      content.__allowImageGen &&
      a.image &&
      typeof a.image.prompt === "string" &&
      a.image.prompt.trim() &&
      imageJobs.length < MAX_ANSWER_IMAGES
    ) {
      imageJobs.push({ i, image: a.image });
    }
  });
  // 차트 병렬 렌더(cap 2 - 차트 워커는 native canvas 라 동시 개수↑면 메모리↑).
  await runPool(chartJobs, 2, async (job) => {
    try {
      const png = await renderChart(job.spec);
      if (png && png.length) {
        const name = `chart${job.i}.png`;
        assets.push({ name, buffer: png });
        entryOf(job.i).chart = name;
      }
    } catch (e) {
      onProgress(`⚠ 차트 렌더 실패(${job.i + 1}번째 해설): ${e.message}`);
    }
  });
  // 삽화 병렬 생성(cap 3).
  if (imageJobs.length) {
    onProgress(`🖼 해설 삽화 ${imageJobs.length}장 생성 중(${PS_IMAGE_MODEL})...`);
    await runPool(imageJobs, 3, async (job) => {
      const prompt = `${job.image.prompt.trim().slice(0, 900)}\n\nStyle: clean educational schematic / diagram, flat vector, white background, minimal text labels. Not a photograph, not real measured data.`;
      let png = null;
      try {
        png = await genImage(prompt, { size: "1024x1024", model: PS_IMAGE_MODEL });
      } catch (e1) {
        try {
          png = await genImage(prompt, { size: "1024x1024" }); // gpt-image-1 폴백
        } catch (e2) {
          onProgress(`⚠ 삽화 생성 실패(${job.i + 1}번째 해설): ${String(e2.message).slice(0, 90)}`);
        }
      }
      if (png && png.length) {
        const name = `img${job.i}.png`;
        assets.push({ name, buffer: png });
        const e = entryOf(job.i);
        e.image = name;
        e.imageCaption = job.image.caption || "개념 도식 (AI 생성)";
      }
    });
  }

  // ── 3) 3종 PDF 컴파일 ────────────────────────────────────────────────────
  // Tectonic 은 프로세스당 메모리를 많이 쓴다(폰트·문서·이미지 로드). 3개를 동시에
  // 띄우면 큰 문서(문제 수↑·쪽수↑·그림↑)에서 인스턴스 메모리 한도를 넘어 OOM·재시작이
  // 난다. 그래서 문서가 크면 **순차(1개씩)** 로, 작으면 병렬로 조판한다. env 로 강제 가능.
  // 기본은 '순차(1개씩)'. Tectonic 은 프로세스당 기본 메모리(엔진+번들 폰트)가 ~200MB+ 로
  // 커서, 3개를 동시에 띄우면 문서 크기와 무관하게 ~800MB 까지 치솟아(실측) 인스턴스 메모리
  // 한도를 넘겨 OOM·강제 재시작이 난다. 순차면 ~330MB 로 안정적이다(실측). 메모리가 넉넉한
  // 인스턴스에서 속도를 원하면 PROBLEMSET_COMPILE_CONCURRENCY=2 또는 3 으로 올린다.
  const COMPILE_CONC = (() => {
    const env = parseInt(process.env.PROBLEMSET_COMPILE_CONCURRENCY || "", 10);
    if (Number.isFinite(env) && env > 0) return Math.min(3, env);
    return 1;
  })();
  onProgress(
    COMPILE_CONC > 1
      ? "📐 3종 PDF 동시 조판 중 (Tectonic)..."
      : "📐 3종 PDF 순차 조판 중 (메모리 절약, Tectonic)...",
  );
  const compileJobs = [
    {
      label: "영어 문제지",
      build: (bad) => buildWorksheetTex({ problems, lang: "en", nPerPage, title, figByIdx, bad }),
    },
    {
      label: "한글 문제지",
      build: (bad) => buildWorksheetTex({ problems, lang: "ko", nPerPage, title, figByIdx, bad }),
    },
    {
      label: "해설지",
      build: (bad) => buildAnswerTex({ answerKey, title, notes: content.notes, assetByIdx, bad }),
    },
  ];
  const compiled = new Array(compileJobs.length);
  await runPool(compileJobs, COMPILE_CONC, async (job, i) => {
    compiled[i] = await compileResilient(job.build, assets, {
      signal,
      onProgress,
      label: job.label,
    });
  });
  const [enPdf, koPdf, akPdf] = compiled;

  // ── 4) ZIP ───────────────────────────────────────────────────────────────
  onProgress("📦 3개 PDF를 ZIP으로 묶는 중...");
  const zip = new JSZip();
  zip.file("01_영어_문제지.pdf", enPdf);
  zip.file("02_한글_문제지.pdf", koPdf);
  zip.file("03_해설지.pdf", akPdf);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const base = sanitizeName(ctx.sourceFilename || title) || "문제집";
  const filename = `${base}_문제지·해설지.zip`;
  return { buffer, filename };
}

// 간단 동시성 풀(결과·중단 불필요 - 차트/삽화 렌더용). 각 작업은 자체 try/catch.
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

module.exports = { generateBundle };
