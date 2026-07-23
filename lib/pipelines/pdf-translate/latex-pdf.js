// 재조판(re-typeset) PDF: Claude가 만든 한국어 LaTeX 본문을 고정 프리앰블로 감싸
// Tectonic(self-contained XeLaTeX)으로 컴파일해 PDF 를 만든다.
//
// 왜 Tectonic: 단일 바이너리(TeX Live 전체보다 가벼움), 필요한 패키지를 처음
// 실행 때만 받아 캐시한다. 한글 폰트는 시스템 설치 없이 **번들 .ttf 를 경로로
// 지정**(fontspec Path=)해서 쓰므로 Render 에서도 폰트 의존성이 없다.
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { assertGeneratedOutputMagic } = require("../../output-validate");

const FONT_DIR = path.join(__dirname, "../../fonts");
// 본문 글꼴(번들). 고가독성 Pretendard 우선, 없으면 NanumGothic.
const SERIF = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"))
  ? "Pretendard-Regular.ttf"
  : "NanumGothic-Regular.ttf";

// 모델이 본문(텍스트 모드)에 그대로 박은 그리스·수학 유니코드 글자를 수식 폰트로 렌더한다.
// 한글 본문 폰트에는 대문자 그리스(Ψ Φ Ω 등)·일부 수학기호 글리프가 없어 그대로 두면
// XeLaTeX 가 ▦(.notdef)로 그린다 → \ensuremath 로 감싸 수식 폰트(전체 그리스 보유)로 그린다.
const UNICODE_MATH_MAP = [
  ["Γ", "\\Gamma"], ["Δ", "\\Delta"], ["Θ", "\\Theta"], ["Λ", "\\Lambda"], ["Ξ", "\\Xi"],
  ["Π", "\\Pi"], ["Σ", "\\Sigma"], ["Υ", "\\Upsilon"], ["Φ", "\\Phi"], ["Ψ", "\\Psi"], ["Ω", "\\Omega"],
  ["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"], ["ε", "\\varepsilon"],
  ["ζ", "\\zeta"], ["η", "\\eta"], ["θ", "\\theta"], ["ι", "\\iota"], ["κ", "\\kappa"], ["λ", "\\lambda"],
  ["μ", "\\mu"], ["ν", "\\nu"], ["ξ", "\\xi"], ["ρ", "\\rho"], ["σ", "\\sigma"], ["τ", "\\tau"],
  ["υ", "\\upsilon"], ["φ", "\\varphi"], ["χ", "\\chi"], ["ψ", "\\psi"], ["ω", "\\omega"], ["π", "\\pi"],
  ["ℏ", "\\hbar"], ["ℓ", "\\ell"], ["∞", "\\infty"], ["∂", "\\partial"], ["∇", "\\nabla"],
  // ×(U+00D7)··(U+00B7)는 본문 폰트에 이미 있어 매핑하지 않는다(매핑하면 산문 구분자
  // '가로×세로'·'속도·가속도'가 수식 연산자 간격으로 깨짐). −(U+2212)는 폴백 폰트(NanumGothic)에
  // 없을 수 있어 유지하되 \ensuremath{-} 는 추가 간격이 없다.
  ["−", "-"], ["±", "\\pm"], ["∓", "\\mp"],
  ["≈", "\\approx"], ["≠", "\\neq"], ["≡", "\\equiv"], ["≤", "\\leq"], ["≥", "\\geq"],
  ["→", "\\rightarrow"], ["←", "\\leftarrow"], ["↔", "\\leftrightarrow"], ["⇒", "\\Rightarrow"],
  ["∈", "\\in"], ["∉", "\\notin"], ["∝", "\\propto"], ["∼", "\\sim"], ["√", "\\surd"],
  ["∫", "\\int"], ["∑", "\\sum"], ["∏", "\\prod"], ["∀", "\\forall"], ["∃", "\\exists"],
]
  .map(([u, m]) => `\\newunicodechar{${u}}{\\ensuremath{${m}}}`)
  .join("\n");

function detectTectonic() {
  if (process.env.TECTONIC_BIN) return process.env.TECTONIC_BIN;
  const local = path.resolve(process.cwd(), "bin/tectonic");
  if (fs.existsSync(local)) return local;
  return "tectonic"; // PATH
}
const TECTONIC = detectTectonic();
let tectonicPreflightOk = false;

function assertTectonicAvailable() {
  if (tectonicPreflightOk) return;
  const res = spawnSync(TECTONIC, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
  if (res.error) {
    throw new Error(
      `Tectonic runtime check failed: ${res.error.message} (TECTONIC_BIN=${TECTONIC}).`,
    );
  }
  if (res.status !== 0) {
    const detail = `${res.stderr || res.stdout || ""}`.trim().slice(0, 500);
    throw new Error(
      `Tectonic runtime check failed (exit ${res.status})${detail ? ": " + detail : ""}.`,
    );
  }
  tectonicPreflightOk = true;
}

// Claude 본문(\section/\[...\] 등 LaTeX)에 고정 프리앰블을 씌운다.
// title/author/date 는 인자로 받아 \maketitle 로.
function buildTex({ body, title = "", author = "", date = "", twoColumn = false, pageNumbers = true }) {
  // 2단 원문이면 출력도 2단으로(원본 배치 보존). 2단은 줄폭이 좁아 줄간격을 조금
  // 줄이고 여백을 좁힌다. \maketitle 은 2단에서도 상단 전폭에 제목을 둔다.
  const docOpts = twoColumn ? "11pt,twocolumn" : "11pt";
  const margin = twoColumn ? "1.8cm" : "2.5cm";
  const spacing = twoColumn ? "\\onehalfspacing" : "\\onehalfspacing";
  return `\\documentclass[${docOpts}]{article}
\\usepackage{fontspec}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage[a4paper,margin=${margin}]{geometry}
\\usepackage{setspace}
\\usepackage{indentfirst}
\\usepackage{graphicx}
\\usepackage{newunicodechar}
% 모델이 표·목록에서 습관적으로 쓰는 패키지들을 미리 로드해 '첫 컴파일 실패 → 값비싼
% 모델 재조판 재시도' 라운드트립을 없앤다(스트래글러·비용의 주원인). 모두 표준 TeX Live
% 패키지라 Tectonic 이 최초 1회만 받아 캐시하며, amsmath/fontspec 과 충돌이 없다.
\\usepackage{array}
\\usepackage{booktabs}
\\usepackage{multirow}
\\usepackage{enumitem}
% 모델이 자주 만들어내지만 어떤 패키지에도 없는 매크로를 표준 의미로 미리 정의(\\providecommand
% 라 이미 정의돼 있으면 건너뜀 → 안전). 정의가 없으면 'Undefined control sequence'로 컴파일이
% 통째 깨지므로, 흔한 것들을 막아 재시도를 줄인다.
\\providecommand{\\degree}{\\ensuremath{^\\circ}}
\\providecommand{\\celsius}{\\ensuremath{^\\circ\\mathrm{C}}}
\\providecommand{\\abs}[1]{\\left\\lvert#1\\right\\rvert}
\\providecommand{\\norm}[1]{\\left\\lVert#1\\right\\rVert}
\\providecommand{\\dd}{\\mathrm{d}}
\\providecommand{\\ket}[1]{\\left|#1\\right\\rangle}
\\providecommand{\\bra}[1]{\\left\\langle#1\\right|}
\\setmainfont{${SERIF}}[Path=${FONT_DIR}/]
${UNICODE_MATH_MAP}
${spacing}
${pageNumbers ? "" : "\\pagestyle{empty}"}
\\setlength{\\parskip}{0.35em}
\\setlength{\\parindent}{1.1em}
\\title{${title || "번역"}}
\\author{${author}}
\\date{${date}}
\\begin{document}
${title ? "\\maketitle" : ""}
${body}
\\end{document}
`;
}

function stripTexComments(src) {
  return String(src || "")
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "%" && line[i - 1] !== "\\") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

function hasCommand(src, names) {
  const body = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // 제어열 이름은 문자 또는 @ 로 이어질 수 있다(\makeatletter 로 @ 가 letter 가 되면
  // \@@input · \@input 가 \input 프리미티브로 풀린다). 따라서 이름 앞의 백슬래시부터
  // '@' 를 포함해 매칭하고, 뒤는 문자/@ 가 이어지지 않을 때만 경계로 본다.
  return new RegExp(`\\\\[@]*(?:${body})(?![A-Za-z@])`, "i").exec(src);
}

function assertSafeIncludeGraphics(src, assets) {
  const allowed = new Set(
    (assets || [])
      .map((a) => String(a && a.name ? a.name : ""))
      .filter(Boolean),
  );
  const re = /\\includegraphics(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/gi;
  let m;
  while ((m = re.exec(src))) {
    const requested = String(m[1] || "").trim();
    if (
      !requested ||
      requested.includes("/") ||
      requested.includes("\\") ||
      requested.includes("..") ||
      !allowed.has(requested)
    ) {
      throw new Error(
        `LaTeX 보안 정책: 허용되지 않은 includegraphics 경로(${requested || "empty"})`,
      );
    }
  }
}

// 신뢰할 수 없는(모델 생성) LaTeX 소스에서 파일 입출력/셸 프리미티브를 fail-closed로 차단한다.
// 번역 대상 PDF 본문이 번역 모델을 프롬프트 인젝션해 \input{/etc/passwd} 같은
// 절대경로 파일 읽기나 셸 명령을 끼워넣을 수 있다. Tectonic --untrusted 는
// shell-escape 만 막고 \input 류 '파일 읽기'는 (경고만 내고) 막지 못함이 0.16.9 에서
// 실측되었으므로, 소스 단에서 위험 명령을 발견하면 컴파일하지 않는다.
function sanitizeUntrustedTex(src, { assets = [] } = {}) {
  if (typeof src !== "string") return { text: src, neutralized: 0 };
  const text = stripTexComments(src);
  const alwaysForbidden = [
    "input",
    "@@input", // 저장된 파일읽기 프리미티브(\@@input) — \input alias
    "@input",
    "include",
    "InputIfFileExists",
    "openin",
    "openout",
    "read",
    "write",
    "special",
    "subfile",
    "subfileinclude",
    "csname",
    "catcode",
    "makeatletter", // @ 를 letter 로 만들어 \@@input 등 프리미티브 alias 노출
    "makeatother",
    "endinput",
    "scantokens", // 임의 토큰 재해석(우회 경로)
    "expandafter", // 프리미티브 확장 재배열로 검사 우회
    "def",
    "edef",
    "gdef",
    "xdef",
    "let",
    "futurelet",
    "newread",
    "newwrite",
  ];
  const bad = hasCommand(text, alwaysForbidden);
  if (bad) {
    throw new Error(`LaTeX 보안 정책: 위험 명령 ${bad[0]} 사용 불가`);
  }
  // 백슬래시가 'input' 바로 앞에 없는 토큰 형태(@@input · @input)도 직접 잡는다.
  // \makeatletter 로 @ 가 letter 가 된 상태에서 \@@input 이 만들어지면 위 hasCommand
  // 가 '\' 로 시작하는 제어열로도 잡지만, 소스에 원시 '@@input'/'@input' 부분문자열이
  // 남아 있는 경우(매크로 조합·주석 우회 등)까지 fail-closed 로 차단한다.
  if (/@@?input\b/i.test(text)) {
    throw new Error("LaTeX 보안 정책: 위험 명령 @@input 사용 불가");
  }
  if (/\\(?:immediate\s*)?write\s*18\b/i.test(text)) {
    throw new Error("LaTeX 보안 정책: write18 사용 불가");
  }
  const beginMatch = /\\begin\s*\{\s*document\s*\}/i.exec(text);
  const begin = beginMatch ? beginMatch.index : -1;
  const end = text.lastIndexOf("\\end{document}");
  const bodyStart = begin >= 0 ? begin + beginMatch[0].length : 0;
  const body = text.slice(bodyStart, end > bodyStart ? end : text.length);
  const bodyPreamble = /\\(?:documentclass|usepackage)(?![A-Za-z@])|\\(?:begin|end)\s*\{\s*document\s*\}/i.exec(body);
  if (bodyPreamble) {
    throw new Error(`LaTeX 보안 정책: 본문에서 ${bodyPreamble[0]} 사용 불가`);
  }
  assertSafeIncludeGraphics(text, assets);
  return { text: src, neutralized: 0 };
}

// .tex 문자열 → PDF Buffer. signal 로 중단 가능.
// assets: [{name, buffer}] — .tex 와 같은 디렉터리에 써서 \includegraphics 가 찾게 한다.
function _doCompile(texSource, { signal, onProgress = () => {}, assets = [] } = {}) {
  return new Promise((resolve, reject) => {
    try {
      assertTectonicAvailable();
    } catch (e) {
      return reject(e);
    }

    // 전용 하위 디렉터리(.tex + 그림 에셋). \includegraphics 는 .tex 위치 기준으로 해석.
    const dir = path.join(
      os.tmpdir(),
      `ltx-${crypto.randomBytes(8).toString("hex")}`,
    );
    fs.mkdirSync(dir, { recursive: true });
    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    };
    const texPath = path.join(dir, "doc.tex");
    const pdfPath = path.join(dir, "doc.pdf");
    // 신뢰 불가 소스의 파일 입출력/셸 프리미티브 제거(주 가드). --untrusted 는 보조.
    let safeSource;
    let neutralized = 0;
    try {
      const sanitized = sanitizeUntrustedTex(texSource, { assets });
      safeSource = sanitized.text;
      neutralized = sanitized.neutralized;
    } catch (e) {
      cleanup();
      return reject(e);
    }
    if (neutralized > 0) {
      onProgress(`🔒 LaTeX 보안 정리: 위험 명령 ${neutralized}개 무력화`);
    }
    fs.writeFileSync(texPath, safeSource, "utf8");
    for (const a of assets || []) {
      if (a && a.name && a.buffer) {
        try {
          fs.writeFileSync(path.join(dir, a.name), a.buffer);
        } catch {
          /* 에셋 쓰기 실패 시 그 그림만 빠짐(컴파일은 진행) */
        }
      }
    }

    // Tectonic: 처음 실행 시 패키지 다운로드(캐시됨).
    // --untrusted: shell-escape 등 known-insecure 기능 차단(보조 방어). 단 절대경로
    //   \input 파일 읽기는 --untrusted 로 막히지 않으므로(0.16.9 실측), 위의
    //   sanitizeUntrustedTex 가 소스 단에서 파일 입출력 명령을 제거하는 것이 주 방어다.
    //   \includegraphics 의 정상 에셋은 .tex 와 같은 dir 에 쓰므로 계속 동작한다.
    const args = [
      "-X",
      "compile",
      texPath,
      "--outdir",
      dir,
      "--untrusted",
      "--keep-logs",
    ];
    onProgress("📐 LaTeX 컴파일 중 (Tectonic)...");
    // 심층 방어: web2c 파일접근 정책을 paranoid('p')로 강제해, 화이트리스트에 없는
    // 읽기 프리미티브(예: \@@input)가 sanitize 를 우회하더라도 temp/출력 디렉터리
    // 밖으로 벗어나지 못하게 한다. .tex·에셋 PNG 는 모두 이 dir(=input·outdir)에
    // 쓰므로 \includegraphics 정상 동작에는 영향이 없다.
    const proc = spawn(TECTONIC, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, openin_any: "p", openout_any: "p" },
    });
    const err = [];
    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("error", (e) => {
      cleanup(); // spawn 실패 시에도 temp dir 누수 방지(다른 종료 경로와 동일)
      reject(
        new Error(
          `Tectonic 실행 실패: ${e.message} (TECTONIC_BIN=${TECTONIC}). 서버에 Tectonic 설치 필요.`,
        ),
      );
    });
    proc.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(pdfPath)) {
        const stderrLog = Buffer.concat(err).toString("utf8");
        // 전체 TeX 로그(doc.log)를 에러에 붙인다 — 호출자가 'l.<N>' 에러 라인을
        // 소스 블록에 매핑해 그 블록만 격리(per-block safe)하는 데 쓴다(--keep-logs).
        let texLog = stderrLog;
        try {
          const lf = path.join(dir, "doc.log");
          if (fs.existsSync(lf)) texLog = fs.readFileSync(lf, "utf8") + "\n" + stderrLog;
        } catch {
          /* ignore */
        }
        cleanup();
        const e = new Error(`LaTeX 컴파일 실패 (code ${code}): ${stderrLog.slice(-800)}`);
        e.texLog = texLog;
        return reject(e);
      }
      let pdf;
      try {
        pdf = assertGeneratedOutputMagic(
          fs.readFileSync(pdfPath),
          "pdf",
          "Tectonic PDF",
        );
      } catch (e) {
        cleanup();
        return reject(e);
      }
      cleanup();
      resolve(pdf);
    });

    if (signal) {
      if (signal.aborted) proc.kill("SIGKILL");
      else signal.addEventListener("abort", () => proc.kill("SIGKILL"), { once: true });
    }
  });
}

// 부팅 워밍업: 첫 컴파일은 Tectonic 이 TeX 번들·폰트 패키지를 받아 ~60초 콜드 지연이 난다.
// 부팅 직후 1회 미리 컴파일해 캐시를 데워 둔다. 진행 중이면 실제 컴파일이 이를 먼저 기다려
// 중복 콜드 다운로드를 막는다(아래 compileTex).
let _prewarmPromise = null;
function prewarmTectonic() {
  if (_prewarmPromise) return _prewarmPromise;
  let tex;
  try {
    tex = buildTex({ body: "워밍업 $x^{2}$", pageNumbers: false });
  } catch {
    tex = "\\documentclass[11pt]{article}\\begin{document}x\\end{document}";
  }
  // _doCompile 직접 호출(compileTex 경유 X) → 자기 자신을 기다리는 교착 방지.
  _prewarmPromise = _doCompile(tex, { onProgress: () => {} }).then(
    () => true,
    () => false, // 실패해도 무시 — 실제 컴파일이 다시 시도한다.
  );
  return _prewarmPromise;
}

// 실제 컴파일. 워밍업이 진행 중이면 먼저 끝나길 기다려 동시 콜드 다운로드를 피한다.
function compileTex(texSource, opts = {}) {
  if (_prewarmPromise) {
    return _prewarmPromise.then(
      () => _doCompile(texSource, opts),
      () => _doCompile(texSource, opts),
    );
  }
  return _doCompile(texSource, opts);
}

module.exports = {
  buildTex,
  compileTex,
  prewarmTectonic,
  sanitizeUntrustedTex,
  SERIF,
  TECTONIC,
};
