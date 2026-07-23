// LaTeX / 수식 마커 본문 → 읽기 좋은 유니코드 평문 변환기 (DOCX 전용).
//
// DOCX 출력에는 한컴 수식 객체가 없으므로, `{{EQ-LATEX:...}}`/`{{EQ:...}}`
// 마커 본문의 LaTeX(\nabla, \cdot, \frac{}{} 등)나 raw 유니코드 수식 기호를
// 사람이 읽을 수 있는 평문 수식(∇·∫·√·π·Σ·분수)으로 정돈한다.
//
//   - `_{...}` / `^{...}` 중괄호는 그대로 남겨, docx 의 parseRichText 가 실제
//     아래/위첨자 TextRun 으로 렌더하게 한다(이미 동작 중). 단, 단일 문자
//     첨자(_{0}, ^{2})는 유니코드 첨자(₀, ²)로 미리 떨궈 문자열 자체도 읽기 좋게.
//   - 변환에 실패한 명령은 글자 노출(\nabla → "nabla")을 피하려 했지만, 알 수
//     없는 명령은 최후에 백슬래시만 떼어 라틴 글자로 남는다(기존 cleanEquation 동작).
//
// ⚠ 이 모듈은 DOCX 출력 경로 전용이다. HWPX 경로(format=hwpx)는 절대 이 변환을
//   타지 않는다 - HWPX 는 Python 후처리가 마커를 실제 한컴 수식 객체로 바꾼다.
//
// 기존 chem-pre/chem-result 외 4개 docx-gen 에 흩어져 있던 cleanEquation 을
// 단일 출처로 모은 것. (phys-inquiry / math-inquiry / free-report docx-gen 재사용)

const GREEK = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

// 단일 문자 → 유니코드 위/아래첨자 (가능한 것만). 없는 문자는 `_{..}`/`^{..}` 유지.
const SUP = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶",
  "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽",
  ")": "⁾", n: "ⁿ", i: "ⁱ",
};
const SUB = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆",
  "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍",
  ")": "₎", a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ",
  m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ",
};

// 단일 문자 첨자만 유니코드로. {ab} 처럼 2글자 이상이면 parseRichText 가 처리하도록
// `_{ab}`/`^{ab}` 형태를 유지한다(중괄호 1개만 안전하게 매칭).
function unicodeSimpleScripts(s) {
  s = s.replace(/\^\{([^{}])\}/g, (m, ch) => SUP[ch] || m);
  s = s.replace(/_\{([^{}])\}/g, (m, ch) => SUB[ch] || m);
  return s;
}

// LaTeX/유니코드 수식 본문 → 읽기 좋은 평문. (마커 래퍼는 벗긴 상태로 들어온다)
function latexToUnicode(body) {
  let s = String(body ?? "").trim();
  if (!s) return "";

  // \frac/\sqrt 같은 중괄호 구조가 있을 때만 무거운 처리. 백슬래시도 유니코드
  // 첨자도 전혀 없으면 그대로 반환(빠른 경로).
  const ARG = "((?:[^{}]|\\{(?:[^{}]|\\{[^{}]*\\})*\\})*)";

  if (s.includes("\\")) {
    // \sqrt{...} → √(...)  (frac 보다 먼저: frac 인자 속 sqrt 중괄호 단계를 줄임)
    const SQRT = new RegExp("\\\\sqrt\\s*\\{" + ARG + "\\}", "g");
    for (let i = 0; i < 4; i++) {
      const next = s.replace(SQRT, "√($1)");
      if (next === s) break;
      s = next;
    }
    // \frac{a}{b} → (a)/(b) - 안쪽부터 반복
    const FRAC = new RegExp("\\\\[dt]?frac\\s*\\{" + ARG + "\\}\\s*\\{" + ARG + "\\}", "g");
    for (let i = 0; i < 6; i++) {
      const next = s.replace(FRAC, "($1)/($2)");
      if (next === s) break;
      s = next;
    }

    s = s
      .replace(/\\left\s*/g, "")
      .replace(/\\right\s*/g, "")
      // 적분/합/곱 - 다중적분은 긴 것부터
      .replace(/\\iiint(?![A-Za-z])/g, "∭")
      .replace(/\\iint(?![A-Za-z])/g, "∬")
      .replace(/\\oiint(?![A-Za-z])/g, "∯")
      .replace(/\\oint(?![A-Za-z])/g, "∮")
      .replace(/\\int(?![A-Za-z])/g, "∫")
      .replace(/\\sum(?![A-Za-z])/g, "Σ")
      .replace(/\\prod(?![A-Za-z])/g, "Π")
      // 벡터 미적분 연산자
      .replace(/\\nabla(?![A-Za-z])/g, "∇")
      .replace(/\\partial(?![A-Za-z])/g, "∂")
      // 화살표·점·생략
      .replace(/\\(?:to|rightarrow)(?![A-Za-z])/g, "→")
      .replace(/\\(?:gets|leftarrow)(?![A-Za-z])/g, "←")
      .replace(/\\(?:leftrightarrow)(?![A-Za-z])/g, "↔")
      .replace(/\\(?:Rightarrow|implies)(?![A-Za-z])/g, "⇒")
      .replace(/\\(?:Leftarrow)(?![A-Za-z])/g, "⇐")
      .replace(/\\(?:Leftrightarrow|iff)(?![A-Za-z])/g, "⇔")
      .replace(/\\cdots(?![A-Za-z])/g, "⋯")
      .replace(/\\(?:dots|ldots)(?![A-Za-z])/g, "⋯")
      .replace(/\\cdot(?![A-Za-z])/g, "·")
      .replace(/\\times(?![A-Za-z])/g, "×")
      .replace(/\\div(?![A-Za-z])/g, "÷")
      .replace(/\\ast(?![A-Za-z])/g, "∗")
      .replace(/\\star(?![A-Za-z])/g, "⋆")
      // 비교/관계
      .replace(/\\leq?(?![A-Za-z])/g, "≤")
      .replace(/\\geq?(?![A-Za-z])/g, "≥")
      .replace(/\\neq?(?![A-Za-z])/g, "≠")
      .replace(/\\approx(?![A-Za-z])/g, "≈")
      .replace(/\\(?:equiv)(?![A-Za-z])/g, "≡")
      .replace(/\\(?:sim)(?![A-Za-z])/g, "∼")
      .replace(/\\(?:propto)(?![A-Za-z])/g, "∝")
      .replace(/\\pm(?![A-Za-z])/g, "±")
      .replace(/\\mp(?![A-Za-z])/g, "∓")
      // 집합/논리
      .replace(/\\infty(?![A-Za-z])/g, "∞")
      .replace(/\\in(?![A-Za-z])/g, "∈")
      .replace(/\\notin(?![A-Za-z])/g, "∉")
      .replace(/\\subset(?![A-Za-z])/g, "⊂")
      .replace(/\\subseteq(?![A-Za-z])/g, "⊆")
      .replace(/\\cup(?![A-Za-z])/g, "∪")
      .replace(/\\cap(?![A-Za-z])/g, "∩")
      .replace(/\\forall(?![A-Za-z])/g, "∀")
      .replace(/\\exists(?![A-Za-z])/g, "∃")
      .replace(/\\angle(?![A-Za-z])/g, "∠")
      .replace(/\\perp(?![A-Za-z])/g, "⊥")
      .replace(/\\parallel(?![A-Za-z])/g, "∥")
      .replace(/\\degree(?![A-Za-z])/g, "°")
      .replace(/\\hbar(?![A-Za-z])/g, "ℏ")
      // 공백 명령
      .replace(/\\(?:quad|qquad)(?![A-Za-z])/g, "  ")
      .replace(/\\[,;:!> ]/g, " ")
      // 그리스 문자
      .replace(
        /\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)(?![A-Za-z])/g,
        (m, k) => GREEK[k],
      )
      // 글꼴 명령은 인자만 남김
      .replace(/\\(?:mathrm|mathbf|mathit|mathcal|mathbb|text|operatorname)\s*\{([^{}]*)\}/g, "$1")
      // 액센트 명령(\vec{E}, \hat{n}, \bar{x}, \dot{x}, \overline{AB} …)은 인자만
      // 남긴다. 인자 1글자면 결합 기호를 붙이고(x̄, x̂), 길면 그냥 인자만.
      .replace(/\\(?:vec|overrightarrow|overline)\s*\{([^{}]*)\}/g, "$1")
      .replace(/\\bar\s*\{([^{}])\}/g, "$1̄")
      .replace(/\\hat\s*\{([^{}])\}/g, "$1̂")
      .replace(/\\(?:dot)\s*\{([^{}])\}/g, "$1̇")
      .replace(/\\(?:bar|hat|dot|tilde|overline)\s*\{([^{}]*)\}/g, "$1")
      // 남은 알 수 없는 명령은 백슬래시만 제거(글자 노출은 감수 - 기존 동작)
      .replace(/\\([A-Za-z]+)/g, "$1")
      .replace(/\\(.)/g, "$1");
  }

  // 단일 문자 첨자는 유니코드로(읽기 좋게). 다중 문자/미지원은 `_{..}`/`^{..}` 유지.
  s = unicodeSimpleScripts(s);

  return s.replace(/\s{2,}/g, " ").trim();
}

// `{{EQ:...}}`/`{{EQ-LATEX:...}}` 래퍼가 통째로 감싼 문자열이면 벗긴 뒤 변환.
// docx-gen 의 {equation:} 블록 처리에서 쓰던 cleanEquation 과 동일한 시그니처.
function cleanEquation(text) {
  let s = String(text ?? "").trim();
  // 래퍼는 전체를 감싼 형태일 때만 벗긴다 - 그냥 `}}`로 끝나는 LaTeX 보호.
  const wrapped = s.match(/^\{\{EQN?(?:-LATEX)?:\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) s = wrapped[1].trim();
  return latexToUnicode(s);
}

// 마커 프리픽스: `{{EQ:` `{{EQN:` `{{EQ-LATEX:` `{{EQN-LATEX:` (+ 콜론 앞뒤 공백 허용).
// 비-LaTeX 별칭(MATH/FORMULA/EQUATION)도 같이 잡아 평문화한다.
const EQ_MARKER_HEAD =
  /\{\{\s*(?:EQN-LATEX|EQ-LATEX|EQN|EQ|MATH|FORMULA|EQUATION)\s*:\s*/i;

// DOCX 산문 속 수식 마커를 중괄호 균형을 맞춰 떼고 본문을 유니코드 평문으로 변환.
//
// 기존 정규식(`([\s\S]*?)\}\}`)은 본문에 중괄호가 있으면(\frac{a}{b}, x^{2}})
// 첫 `}}`에서 잘려 식이 깨졌다. 여기서는 여는 `{{` 이후 중괄호 깊이를 세어
// 본문이 끝나는 진짜 `}}`(깊이 0에서 만나는 `}}`)를 찾는다.
//
// 입력: DOCX 모드의 sanitize 문자열 1개. 반환: 마커가 모두 변환된 문자열.
function stripEquationMarkersForDocx(input) {
  let s = String(input ?? "");
  let result = "";
  let searchFrom = 0;
  // 무한 루프 방지용 안전 상한(현실적 보고서 문장 길이를 크게 상회).
  let guard = 0;
  while (guard++ < 10000) {
    EQ_MARKER_HEAD.lastIndex = 0;
    const rest = s.slice(searchFrom);
    const m = EQ_MARKER_HEAD.exec(rest);
    if (!m) {
      result += rest;
      break;
    }
    const headStart = searchFrom + m.index;
    const bodyStart = headStart + m[0].length;
    // headStart 이전(마커 앞 평문)은 그대로 누적.
    result += s.slice(searchFrom, headStart);
    // bodyStart 부터 중괄호 깊이 0 에서 `}}` 를 만나면 그 자리가 마커 종료.
    let depth = 0;
    let i = bodyStart;
    let bodyEnd = -1; // 본문 끝(닫는 `}}` 직전)
    let markerEnd = -1; // 마커 전체 끝(닫는 `}}` 다음)
    for (; i < s.length; i++) {
      const ch = s[i];
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        if (depth > 0) {
          depth--;
        } else if (s[i + 1] === "}") {
          // 깊이 0 에서 만난 `}}` → 마커 종료.
          bodyEnd = i;
          markerEnd = i + 2;
          break;
        }
        // depth 0 인데 단일 `}` 면 본문 일부로 간주(균형 안 맞는 입력 방어).
      }
    }
    if (markerEnd === -1) {
      // 닫는 `}}` 를 못 찾음(잘린 마커). 헤드만 떼고 본문은 변환해 그대로 남긴다.
      result += latexToUnicode(s.slice(bodyStart));
      break;
    }
    const body = s.slice(bodyStart, bodyEnd);
    result += latexToUnicode(body);
    searchFrom = markerEnd;
  }
  return result;
}

module.exports = { latexToUnicode, cleanEquation, stripEquationMarkersForDocx };
