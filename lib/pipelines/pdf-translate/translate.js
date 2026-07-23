// PDF 통번역 오케스트레이션.
//   1) translate_pdf.py 로 번역 대상 문단 추출
//   2) Claude 로 문단을 묶음 단위 번역 (한국어)
//   3) translate_pdf.py 로 번역문을 원본 레이아웃에 삽입
// 그림·도표·벡터 그래픽은 건드리지 않으므로 그대로 보존된다.
const Anthropic = require("@anthropic-ai/sdk");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { calcCost } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const tool = require("./pdf-tool");
const {
  assertCompleteTranslations,
  assertCompleteRender,
} = require("./quality-gate");
const {
  createFifoSemaphore,
  createPdfTranslateResourceLimits,
  getProcessWidePdfTranslateResourceLimits,
} = require("./resource-gate");

// 본문 글꼴: Pretendard(고가독성) 있으면 우선, 없으면 NanumGothic.
const FONT_DIR = path.join(__dirname, "../../fonts");
const FONT_PATH = fs.existsSync(path.join(FONT_DIR, "Pretendard-Regular.ttf"))
  ? path.join(FONT_DIR, "Pretendard-Regular.ttf")
  : path.join(FONT_DIR, "NanumGothic-Regular.ttf");

// 번역 기본 모델: 문서 번역엔 Sonnet 으로 충분하고 빠르다(비용↓). 환경변수로 변경 가능.
const DEFAULT_MODEL = process.env.PDF_TRANSLATE_MODEL || "claude-sonnet-5";
// 페이지 절대 상한 — 비용/시간 폭주 방지. 이 이내면 자동 분할·병렬·병합으로 처리한다
// (예: 150쪽 → 50쪽씩 3구간). env 로 조절.
const rawMaxPages = String(process.env.PDF_TRANSLATE_MAX_PAGES || "700").trim();
const MAX_PAGES = /^\d+$/.test(rawMaxPages) && Number(rawMaxPages) > 0
  ? Number(rawMaxPages)
  : 700;
// 분할 기준: 이 쪽수를 넘는 PDF 는 구간으로 나눠 병렬 번역한 뒤 하나로 합친다.
const CHUNK_PAGES = Math.max(
  1,
  parseInt(process.env.PDF_TRANSLATE_CHUNK_PAGES || "50", 10),
);
const SPLIT_POLICY_NAME = "sentence-safe-backtrack-v1";
// 동시에 처리할 구간 수(python 프로세스·메모리 보호). API 동시성은 아래 gate 가 따로 상한.
const CHUNK_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PDF_TRANSLATE_CHUNK_CONCURRENCY || "4", 10),
);
// 한 번의 요청에 묶을 대략적 글자 수. 키울수록 API 호출(왕복) 수가 줄어 빨라진다.
// (병목은 모델 API 왕복이므로 가장 직접적인 코드레벨 속도 레버. JSON 강제 출력 +
// 누락 재시도가 있어 묶음을 키워도 안전.) env 로 더 키울 수 있다.
// 한 묶음당 글자 수. 키울수록 모델 왕복(=병목) 수가 줄어 빨라진다. maxTokens=글자×2.5 라
// 9000 이면 출력 한도 ~22.5k 로 32k 상한에 여유가 있어 잘림 위험이 낮다(누락 재시도가
// 안전망). 더 키우면 잘림 위험이 비선형으로 커진다. env 로 조절.
const BATCH_CHARS = parseInt(process.env.PDF_TRANSLATE_BATCH_CHARS || "9000", 10);
const BATCH_IDS = Math.max(
  1,
  parseInt(process.env.PDF_TRANSLATE_BATCH_IDS || "350", 10),
);
// 묶음 동시 번역 수(상한). 분할 PDF 는 모든 구간이 이 상한을 '공유'한다(레이트리밋 방지).
// 큰 문서일수록 동시성이 속도를 좌우 — 12 로 상향(rate limit 여유 내). env 로 조절.
const CONCURRENCY = Math.max(
  1,
  parseInt(process.env.PDF_TRANSLATE_CONCURRENCY || "12", 10),
);

const SYSTEM_PROMPT = [
  "You are a professional translator specializing in academic and technical/scientific documents",
  "(lab manuals, papers, textbooks). Translate each given text segment into natural, fluent Korean (한국어).",
  "",
  "Rules:",
  "- The input may contain <sub>...</sub> and <sup>...</sup> tags marking subscripts/superscripts in formulas (e.g. H<sub>2</sub><sup>+</sup>, ψ<sub>el</sub>, σ<sub>g</sub>1s, r<sub>AB</sub>). PRESERVE these tags EXACTLY — keep them around the very same characters, do not remove, move, reorder, translate, or alter them, and do not add new ones. They are markup, not content.",
  "- Translate faithfully. Do NOT summarize, add, drop, or merge content.",
  "- Translate the segment EXACTLY as given. If a segment appears to end mid-sentence (no final period), translate ONLY the text provided — do NOT continue, complete, guess, or invent the rest of the sentence.",
  "- Some IDs are marked as a page-edge continuation group. Read their joined_source as one continuous passage, but return every original ID separately. Do not finish a non-final member as an independent Korean sentence and do not leave a following member as a particle-only fragment; Korean word order may be distributed across the outputs while preserving meaning and page boundaries.",
  "- Always translate the natural-language (prose) parts, even when the segment also contains equations, symbols, chemical/electron configurations, or formulas. Return a segment unchanged ONLY if it is ENTIRELY symbols/numbers/formula with no translatable words (and never return English prose untranslated).",
  "- Preserve exactly: numbers, unit SYMBOLS (m, kg, eV, s, etc.), math/chemical formulas, variable names, equation symbols, code, URLs, citations,",
  "  and proper nouns that are conventionally left untranslated.",
  "- Translate an English large-number scale word attached to a numeral; do not leave million/billion/trillion in English. Exact-equivalent Korean scale notation is allowed (18 million → 1,800만; 500 million → 5억), but the mathematical quantity must not change.",
  "- Translate fully spelled-out unit and time NAMES into natural Korean even inside an equation or definition: nautical mile → 해리, electron volts → 전자볼트, years → 년. A first prose occurrence may include the English term in parentheses, but a later formula must use the Korean name (for example, 1 해리 = 1852 m), not repeat 'nautical mile'. Unit symbols such as m and eV remain unchanged.",
  "- Use accurate Korean scientific/technical terminology.",
  "- Read ALL segments in the batch as parts of one document. Use their shared context to keep repeated terminology, domain meaning, and Korean register consistent across IDs. IDs are separate only for output mapping and completeness checks: return exactly one translation for every input ID, without merging, splitting, or dropping segments.",
  "- Context-sensitive terminology guidance: translate born-digital as 디지털 원본 or 처음부터 디지털로 생성된; translate reflow text/prose as 텍스트/문단 재배치 or 줄바꿈 재조정 (never 재흐름); translate an internal jump in a PDF as 문서 내 이동 링크 (never 내부 점프); translate heading as 제목 or 표제 and distinguish it from header/머리글; translate a test/regression fixture as 테스트 픽스처 (never 고정물 or 실험 템플릿); translate measurement ledger as 측정값 기록부 or 측정값 목록.",
  "- Context overrides a glossary example when the domain meaning differs. In particular, a physical/mechanical fixture that holds an object is 장치 or 고정구, while a test/regression fixture remains 테스트 픽스처.",
  "- Match the source register, then choose one coherent Korean ending style for the document (해라체 or 하십시오체) and do not mix the two within the same document unless the source itself clearly requires a change.",
  "- For technical / domain-specific terms and named methods, write the Korean translation followed by the original English term in parentheses on first occurrence, e.g. 어텐션(attention), 잔차 연결(residual connection), 계층 정규화(layer normalization). Do this consistently for non-obvious terms. Keep well-known acronyms (BLEU, GPU, RNN, CNN) and proper nouns (제품·논문·사람 이름) as-is.",
  "- Outside those parenthetical English glosses, translate ordinary English adjectives and noun phrases completely. Do not produce mixed literal phrases such as '이 born-digital 페이지' or leave 'ordinary paragraph' in English; use natural Korean wording instead.",
  "- The target language is Korean. Never introduce Devanagari, Arabic, Thai, Cyrillic, Han, emoji, or any other unrelated writing-system characters that were not present in that source segment. Retain a non-Korean proper noun or formula symbol only when its exact characters occur in the source.",
  "- Do not output emoji or other non-BMP Unicode characters; the PDF renderer cannot safely embed them.",
  "- Before returning JSON, check that every number and URL is byte-for-byte unchanged and that every <sub>/<sup> tag and its enclosed literal occur in the same order as the source.",
  "- EXCEPTION: in short segments that are clearly a heading, section title, or table column header / cell (few words, no full sentence), do NOT add the parenthetical English gloss — give only concise Korean so it fits the layout. Still translate lowercase English common nouns such as fixture and page; preserve only proper nouns, IDs, acronyms, code, and other required literals.",
  "- Keep the translation concise; do not pad. Avoid adding words that are not in the source.",
  "- Output literal characters directly (<, >, &, ≤, ≥, /). NEVER use HTML entities such as &gt; &lt; &amp; in the output.",
  "- If a segment is already Korean, return it unchanged.",
  '- Output MUST be a single JSON object and nothing else: {"t": {"<id>": "<korean>", ...}} including every id given.',
].join("\n");

function buildBatches(
  blocks,
  maxChars = BATCH_CHARS,
  maxIds = BATCH_IDS,
  maxPages = null,
) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  let curPages = new Set();
  const pageLimit = Number.isSafeInteger(Number(maxPages)) && Number(maxPages) > 0
    ? Number(maxPages)
    : null;
  const idLimit = Number.isSafeInteger(Number(maxIds)) && Number(maxIds) > 0
    ? Number(maxIds)
    : BATCH_IDS;
  const consumed = new Set();
  const grouped = new Map();
  for (const block of blocks || []) {
    if (!block?.continuation_group) continue;
    const key = String(block.continuation_group);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(block);
  }
  for (const block of blocks || []) {
    const id = String(block?.id);
    if (consumed.has(id)) continue;
    const unit = block?.continuation_group
      ? grouped.get(String(block.continuation_group)) || [block]
      : [block];
    for (const item of unit) consumed.add(String(item?.id));
    const unitChars = unit.reduce(
      (sum, item) => sum + String(item?.text || "").length,
      0,
    );
    const unitPages = new Set(
      unit.map((item) => item?.page).filter(Number.isInteger),
    );
    if (pageLimit && unitPages.size > pageLimit) {
      throw new Error(
        `one atomic translation group spans ${unitPages.size} pages, exceeding the ` +
          `${pageLimit}-page visual evidence limit`,
      );
    }
    const combinedPages = new Set([...curPages, ...unitPages]);
    if (
      cur.length &&
      (
        curChars + unitChars > maxChars ||
        cur.length + unit.length > idLimit ||
        (pageLimit && combinedPages.size > pageLimit)
      )
    ) {
      batches.push(cur);
      cur = [];
      curChars = 0;
      curPages = new Set();
    }
    cur.push(...unit);
    curChars += unitChars;
    for (const page of unitPages) curPages.add(page);
    if (curChars >= maxChars || cur.length >= idLimit) {
      batches.push(cur);
      cur = [];
      curChars = 0;
      curPages = new Set();
    }
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

const RESPONSE_RETRY_SIZES = Object.freeze([1500, 600, 1, 1, 1]);
const ENGLISH_TOKEN_RE = /[A-Za-z]+(?:-[A-Za-z]+)*/g;
const NUMERIC_TOKEN_RE = /[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?%?/g;
const ENGLISH_NUMBER_WORD_VALUES = Object.freeze({
  zero: "0", nonzero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11",
  twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16",
  seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20", thirty: "30",
  forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100", thousand: "1,000", million: "1,000,000",
  billion: "1,000,000,000", trillion: "1,000,000,000,000",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6",
  seventh: "7", eighth: "8", ninth: "9", tenth: "10", eleventh: "11",
  twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15",
  sixteenth: "16", seventeenth: "17", eighteenth: "18", nineteenth: "19",
  twentieth: "20",
  primary: "1", secondary: "2", tertiary: "3", quaternary: "4",
  unity: "1",
  jan: "1", feb: "2", mar: "3", apr: "4", jun: "6", jul: "7", aug: "8",
  sep: "9", sept: "9", oct: "10", nov: "11", dec: "12",
  january: "1", february: "2", march: "3", april: "4", may: "5", june: "6",
  july: "7", august: "8", september: "9", october: "10", november: "11",
  december: "12",
});
const ENGLISH_MONTH_WORDS = new Set([
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);
// Stop at non-ASCII Korean particles (".../path에서") while retaining RFC URL punctuation.
const URL_RE = /(?:https?:\/\/|www\.)[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi;
const SCIENTIFIC_SYMBOL_RE = /[Α-Ωα-ωϑϕϱ϶ϰ′″°=±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌]/g;
const ALWAYS_ALLOWED_TARGET_SCRIPT_RE = /^(?:\p{Script=Hangul}|\p{Script=Latin}|\p{Script=Common}|\p{Script=Inherited})$/u;

// Units and lowercase product names are literals, not untranslated prose. Single-letter
// units are handled by looksLikeUnitsOrFormulaOnly() instead of being ignored globally:
// otherwise the English article "a" would split a genuine untranslated phrase.
const LOWERCASE_LITERAL_WORDS = new Set([
  "cm", "mm", "km", "nm", "pm", "kg", "mg", "mmol", "mol", "ml", "dl",
  "ms", "ns", "hz", "khz", "mhz", "ghz", "mv", "ma", "kw", "kj", "kpa",
  "mpa", "rpm", "fps", "dpi", "ppi", "bit", "byte", "kb", "mb", "gb", "tb",
  "px", "pt", "db", "bar",
  "rad", "sr", "au", "ly", "pc", "kpc", "mpc", "arcmin", "arcsec",
  // Textbook formulae also use these compact astronomical / photometric unit
  // literals.  ``sterad`` is the printed abbreviation for steradian in older
  // editions, while ``magkpc`` is the whitespace-free extraction of
  // ``mag kpc``.  They are units, not English prose, and must remain byte-exact.
  "sterad", "mag", "magkpc",
  "numpy", "pandas", "scikit-learn", "tensorflow", "pytorch", "github", "latex",
  "linux", "unix",
  "abc", "kgm", "xyz", "const", "ugriz", "uvby",
  // Mathematical function names remain Latin literals inside equations. Without these,
  // an expression such as "y cos χ" is mistaken for untranslated prose and repeatedly
  // rejected even when the textbook formula is preserved exactly.
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "min", "max", "mod",
]);
// Compact unit strings and formula identifiers emitted by older scientific PDFs
// are allowed only when the exact token is also present in the source segment.
// Keeping these out of LOWERCASE_LITERAL_WORDS prevents a model from introducing
// one of them into unrelated prose and having it silently treated as a literal.
const SOURCE_EXACT_COMPACT_SCIENTIFIC_WORDS = new Set([
  "amu", "gausscm", "kms", "lgz", "sini", "ict", "ndl",
]);
const UNIT_WORDS = new Set([
  ...LOWERCASE_LITERAL_WORDS,
  "a", "c", "f", "g", "i", "j", "k", "l", "m", "s", "v", "w",
]);
const ALLOWED_LOWERCASE_PHRASES = [
  "et al", "in situ", "in vitro", "in vivo", "ex vivo", "per se", "vice versa",
];
const COMMON_TRANSLATABLE_LABELS = new Set([
  "fig", "figure", "table", "chapter", "section", "sect", "box", "appendix",
]);
const GLUED_MATH_FUNCTIONS = Object.freeze([
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "sin", "cos", "tan", "cot", "sec", "csc", "log", "exp", "lim",
  "min", "max", "mod", "ln",
]);
const FORMULA_PROSE_STOPWORDS = new Set([
  "and", "are", "for", "from", "if", "is", "of", "or", "that", "the",
  "then", "this", "to", "when", "where", "which", "with", "since",
]);
const NATURAL_MATH_WORD_FORMS = new Set(["sine", "cosine", "tangent", "logarithm"]);
// These ordinary textbook words begin with a supported math function name, but
// are prose even when a nearby page number or equation makes the local window
// look formula-like (for example, "Chandrasekhar limit, 309").
const NON_FORMULA_MATH_PREFIX_WORDS = new Set([
  "limit", "limiting", "minor", "limb",
]);

function sameStringArray(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameStringMultiset(a, b) {
  return sameStringArray(a.slice().sort(), b.slice().sort());
}

function extractNumericTokens(text) {
  return String(text || "").match(NUMERIC_TOKEN_RE) || [];
}

function joinDiscretionaryLatinLineBreaks(text) {
  return String(text || "").replace(/([A-Za-z])-\s+([a-z])/g, "$1$2");
}

function mathFunctionContext(value, start, end, rawToken) {
  const local = value.slice(Math.max(0, start - 12), Math.min(value.length, end + 12));
  const preceding = value.slice(Math.max(0, start - 96), start);
  const following = value.slice(end, Math.min(value.length, end + 8));
  return (
    /[=+*/^<>±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌Α-Ωα-ωϑϕϱ϶ϰ′″°\d()]|<\/?(?:sub|sup)>/i.test(local) ||
    /^\s*[A-Za-z](?=\s|[가-힣]|[),.;=+*/^<>−-]|$)/.test(following) ||
    (
      String(rawToken || "").length <= 6 &&
      /\b(?:write|written|factor|term|components?|expression|relation|equation|formula|form)\b[\s\S]{0,64}$/i.test(preceding)
    )
  );
}

function sourceGluedMathAllowances(sourceText) {
  const source = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(sourceText),
  );
  const allowances = new Map();
  const tokenRe = new RegExp(ENGLISH_TOKEN_RE.source, "g");
  let match;
  while ((match = tokenRe.exec(source))) {
    const raw = match[0];
    if (NON_FORMULA_MATH_PREFIX_WORDS.has(raw.toLowerCase())) continue;
    if (FORMULA_PROSE_STOPWORDS.has(raw.toLowerCase())) continue;
    const parsed = parseGluedMathIdentifier(raw);
    if (parsed?.length !== 1 || !mathFunctionContext(source, match.index, tokenRe.lastIndex, raw)) {
      continue;
    }
    const functionName = parsed[0];
    if (!raw.toLowerCase().startsWith(functionName)) continue;
    const argument = raw.slice(functionName.length);
    if (!/^[A-Za-z]{1,2}$/.test(argument)) continue;
    const key = `${functionName}:${argument}`;
    incrementCount(allowances, key);
  }
  return allowances;
}

function normalizeSourceBoundGluedMathNotation(sourceText, targetText) {
  if (typeof targetText !== "string" || !targetText) return targetText;
  const allowances = sourceGluedMathAllowances(sourceText);
  if (!allowances.size) return targetText;
  return targetText.replace(
    new RegExp(ENGLISH_TOKEN_RE.source, "g"),
    (raw, offset, whole) => {
      // A tagged base such as ``logI<sub>ν</sub>`` is already an exact scientific
      // markup atom. Splitting it to ``log I`` changes the base bound to the tag.
      if (/^<(?:sub|sup)>/i.test(whole.slice(offset + raw.length))) return raw;
      if (NON_FORMULA_MATH_PREFIX_WORDS.has(raw.toLowerCase())) return raw;
      if (FORMULA_PROSE_STOPWORDS.has(raw.toLowerCase())) return raw;
      const parsed = parseGluedMathIdentifier(raw);
      if (parsed?.length !== 1) return raw;
      const functionName = parsed[0];
      if (!raw.toLowerCase().startsWith(functionName)) return raw;
      const argument = raw.slice(functionName.length);
      if (!/^[A-Za-z]{1,2}$/.test(argument)) return raw;
      const exactKey = `${functionName}:${argument}`;
      const insensitiveKey = Array.from(allowances.keys()).find(
        (key) => key.toLowerCase() === exactKey.toLowerCase() && (allowances.get(key) || 0) > 0,
      );
      if (!insensitiveKey) return raw;
      allowances.set(insensitiveKey, allowances.get(insensitiveKey) - 1);
      return `${functionName} ${argument}`;
    },
  );
}

const ENGLISH_SCALE_FACTORS = Object.freeze({
  million: 1_000_000n,
  billion: 1_000_000_000n,
  trillion: 1_000_000_000_000n,
});
const KOREAN_SCALE_FACTORS = Object.freeze({
  천: 1_000n,
  만: 10_000n,
  십만: 100_000n,
  백만: 1_000_000n,
  천만: 10_000_000n,
  억: 100_000_000n,
  십억: 1_000_000_000n,
  백억: 10_000_000_000n,
  천억: 100_000_000_000n,
  조: 1_000_000_000_000n,
});

function scaledDecimalParts(rawToken, factor) {
  const value = String(rawToken || "").replace(/,/g, "");
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] || "";
  let numerator = BigInt(`${match[2]}${fraction}`) * factor;
  if (match[1] === "-") numerator = -numerator;
  let denominator = 10n ** BigInt(fraction.length);
  while (denominator > 1n && numerator % 10n === 0n) {
    numerator /= 10n;
    denominator /= 10n;
  }
  return { numerator, denominator };
}

function scaledDecimalKey(rawToken, factor) {
  const parts = scaledDecimalParts(rawToken, factor);
  return parts ? `${parts.numerator}/${parts.denominator}` : null;
}

function formatExactKoreanScaledNumber(rawToken, englishScale) {
  const factor = ENGLISH_SCALE_FACTORS[String(englishScale || "").toLowerCase()];
  if (!factor) return null;
  const parts = scaledDecimalParts(rawToken, factor);
  if (!parts || parts.numerator === 0n) return null;

  const absoluteNumerator = parts.numerator < 0n ? -parts.numerator : parts.numerator;
  const units = [
    ["조", KOREAN_SCALE_FACTORS.조],
    ["억", KOREAN_SCALE_FACTORS.억],
    ["만", KOREAN_SCALE_FACTORS.만],
  ];
  const selected = units.find(([, unitFactor]) =>
    absoluteNumerator >= parts.denominator * unitFactor,
  );
  if (!selected) return null;

  const [unit, unitFactor] = selected;
  const coefficientDenominator = parts.denominator * unitFactor;
  let decimalPlaces = 0;
  let decimalDivisor = coefficientDenominator;
  while (decimalDivisor > 1n && decimalDivisor % 10n === 0n) {
    decimalDivisor /= 10n;
    decimalPlaces += 1;
  }
  // Decimal source numerals and the supported scale factors always produce a
  // power-of-ten divisor. Keep this fail-closed if that invariant ever changes.
  if (decimalDivisor !== 1n) return null;

  const integerPart = absoluteNumerator / coefficientDenominator;
  const remainder = absoluteNumerator % coefficientDenominator;
  const groupedInteger = integerPart.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let coefficient = groupedInteger;
  if (remainder) {
    const fraction = remainder
      .toString()
      .padStart(decimalPlaces, "0")
      .replace(/0+$/, "");
    coefficient += `.${fraction}`;
  }
  const sign = parts.numerator < 0n ? "-" : String(rawToken).trim().startsWith("+") ? "+" : "";
  return `${sign}${coefficient}${unit}`;
}

const ENGLISH_TIME_UNIT_TO_KOREAN = Object.freeze({
  year: "년",
  years: "년",
  month: "개월",
  months: "개월",
  week: "주",
  weeks: "주",
  day: "일",
  days: "일",
  hour: "시간",
  hours: "시간",
  minute: "분",
  minutes: "분",
  second: "초",
  seconds: "초",
});

const SAFE_ENGLISH_SCALE_INTEGER_RE_SOURCE = "[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)";
const CURRENCY_WORD_RE = "(?:USD|EUR|GBP|JPY|KRW|CNY|RMB|CAD|AUD)";

function unsafeEnglishScaleContext(value, numericStart, matchEnd) {
  const before = value.slice(0, numericStart);
  const after = value.slice(matchEnd);
  if (/[$€£¥₩]\s*$/.test(before) || new RegExp(`\\b${CURRENCY_WORD_RE}\\s*$`).test(before)) {
    return true;
  }
  if (/(?:[/–—]|-\s*|\b(?:to|through|and)\s+)$/i.test(before)) return true;
  if (/^\s*(?:[/–—-]|\b(?:to|through)\b)/i.test(after)) return true;
  if (new RegExp(`^\\s*${CURRENCY_WORD_RE}\\b`).test(after)) return true;
  // A capitalized word immediately after the scale is likely part of a title,
  // not ordinary translated prose. Leave it for the language validator/retry.
  return /^\s+[A-Z][A-Za-z]*(?:\s|$)/.test(after);
}

function sourceEnglishScaleAllowances(sourceText) {
  const source = joinDiscretionaryLatinLineBreaks(sourceText);
  const re = new RegExp(
    `(^|[^A-Za-z0-9_.])(${SAFE_ENGLISH_SCALE_INTEGER_RE_SOURCE})\\s+` +
      "(million|billion|trillion)(?![A-Za-z])",
    "g",
  );
  const allowances = new Map();
  let match;
  while ((match = re.exec(source))) {
    const numericStart = match.index + match[1].length;
    if (unsafeEnglishScaleContext(source, numericStart, re.lastIndex)) continue;
    const key = `${match[2]}\u0000${match[3]}`;
    allowances.set(key, (allowances.get(key) || 0) + 1);
  }
  return allowances;
}

function normalizeTranslatedEnglishScaleNotation(sourceText, targetText) {
  if (typeof targetText !== "string" || !targetText) return targetText;
  const allowances = sourceEnglishScaleAllowances(sourceText);
  if (!allowances.size) return targetText;
  const timeUnits = Object.keys(ENGLISH_TIME_UNIT_TO_KOREAN).join("|");
  const re = new RegExp(
    `(^|[^A-Za-z0-9_.])(${SAFE_ENGLISH_SCALE_INTEGER_RE_SOURCE})\\s+` +
      `(million|billion|trillion)` +
      `(?:\\s+(${timeUnits})|\\s*(년|개월|주|일|시간|분|초))?(?![A-Za-z])`,
    "g",
  );
  return targetText.replace(
    re,
    (match, prefix, numericToken, scale, englishTimeUnit, koreanTimeUnit, offset) => {
      const numericStart = offset + prefix.length;
      if (unsafeEnglishScaleContext(targetText, numericStart, offset + match.length)) {
        return match;
      }
      const key = `${numericToken}\u0000${scale}`;
      const remaining = allowances.get(key) || 0;
      if (!remaining) return match;
      const normalizedNumber = formatExactKoreanScaledNumber(numericToken, scale);
      if (!normalizedNumber) return match;
      allowances.set(key, remaining - 1);
      const normalizedTimeUnit = englishTimeUnit
        ? ENGLISH_TIME_UNIT_TO_KOREAN[englishTimeUnit]
        : koreanTimeUnit;
      return `${prefix}${normalizedNumber}${normalizedTimeUnit ? ` ${normalizedTimeUnit}` : ""}`;
    },
  );
}

// Models sometimes preserve a fully-spelled English unit because the same compact
// unit symbol (km, eV, ...) would normally be protected.  Normalize only an exact
// phrase that is also present in this source segment, and consume at most the same
// number of occurrences.  This is deterministic translation, not a permissive
// validation exception: source-absent unit text remains untouched and is rejected
// by the untranslated-prose gate.
const BOUND_TRANSLATED_MEASUREMENTS = Object.freeze([
  Object.freeze({ key: "microgram", sourcePattern: "micrograms?", targetPattern: "마이크로그램" }),
  Object.freeze({ key: "gram", sourcePattern: "grams?", targetPattern: "그램" }),
]);

const SPELLED_UNIT_TRANSLATIONS = Object.freeze([
  ...BOUND_TRANSLATED_MEASUREMENTS.map(({ sourcePattern, targetPattern }) => [
    sourcePattern,
    targetPattern,
  ]),
  ["metres?", "미터"],
  ["meters?", "미터"],
  ["square kilometres?", "제곱킬로미터"],
  ["square kilometers?", "제곱킬로미터"],
  ["square metres?", "제곱미터"],
  ["square meters?", "제곱미터"],
  ["square miles?", "제곱마일"],
  ["cubic kilometres?", "세제곱킬로미터"],
  ["cubic kilometers?", "세제곱킬로미터"],
  ["cubic metres?", "세제곱미터"],
  ["cubic meters?", "세제곱미터"],
  ["cubic parsecs?", "세제곱파섹"],
  ["milliseconds?", "밀리초"],
  ["stops?(?=\\s+ND[ -]?filters?\\b)", "스톱"],
  ["nautical miles?", "해리"],
  ["electron[ -]volts?", "전자볼트"],
]);

function measurementUnitOccurrences(value, language) {
  const occurrences = [];
  for (const { key, sourcePattern, targetPattern } of BOUND_TRANSLATED_MEASUREMENTS) {
    const re = language === "source"
      ? new RegExp(`\\b(?:${sourcePattern})\\b`, "gi")
      // Korean particles may follow a unit without spacing, but another Hangul
      // word may not precede it. This keeps ``5그램`` valid without mistaking
      // the suffix of ``프로그램`` or ``킬로그램`` for the gram unit.
      : new RegExp(`(?<![가-힣])(?:${targetPattern})`, "g");
    let match;
    while ((match = re.exec(value))) {
      occurrences.push({ key, start: match.index, end: re.lastIndex });
    }
  }
  // ``그램`` is a suffix of ``마이크로그램``. Prefer the longest occurrence at
  // an overlap so one Korean unit cannot be counted twice.
  occurrences.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const selected = [];
  for (const occurrence of occurrences) {
    if (selected.some((entry) => occurrence.start < entry.end && occurrence.end > entry.start)) {
      continue;
    }
    selected.push(occurrence);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function measurementNumericTokenOccurrences(value) {
  const tokens = [];
  const re = new RegExp(NUMERIC_TOKEN_RE.source, "g");
  let match;
  while ((match = re.exec(value))) {
    tokens.push({ raw: match[0], start: match.index, end: re.lastIndex });
  }
  return tokens;
}

function measurementStrongClauseBoundaries(value) {
  const boundaries = [0, value.length];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === ";" || char === "\n" || char === "\r") {
      boundaries.push(index + 1);
      continue;
    }
    if (
      char === "/" &&
      /\s/.test(value[index - 1] || "") &&
      /\s/.test(value[index + 1] || "")
    ) {
      boundaries.push(index + 1);
      continue;
    }
    if (/[.!?。！？]/u.test(char)) {
      if (char === "." && /\d/.test(value[index - 1] || "") && /\d/.test(value[index + 1] || "")) {
        continue;
      }
      if (!value[index + 1] || /\s/.test(value[index + 1])) boundaries.push(index + 1);
    }
  }
  return Array.from(new Set(boundaries)).sort((a, b) => a - b);
}

function measurementBoundaryBetweenUnits(value, leftUnit, rightUnit) {
  const start = leftUnit.end;
  const end = rightUnit.start;
  const between = value.slice(start, end);
  const separatorRe = /\s+\/\s+|[;\n\r]|(?<!\d),(?=\s*(?:[+-]?\d|[A-Z가-힣]))|\b(?:and|or|but|while|whereas)\b|(?:그리고|하지만|반면|이고|이며|및)|(?:과|와)(?=\s|\d|[A-Za-z가-힣])/gi;
  const separators = [];
  let match;
  while ((match = separatorRe.exec(between))) {
    separators.push(start + match.index + Math.ceil(match[0].length / 2));
  }
  if (separators.length) {
    const midpoint = (start + end) / 2;
    return separators.sort((a, b) => Math.abs(a - midpoint) - Math.abs(b - midpoint))[0];
  }
  return Math.floor((start + end) / 2);
}

/**
 * Bind every translated unit occurrence to all numeric tokens in its local
 * clause/window. Strong punctuation and neighboring units partition the text;
 * sorting the token multiset permits Korean word-order changes without allowing
 * a temperature/context number and the measured value to be swapped between
 * micrograms and grams. Unbound/duplicated units remain explicit entries.
 */
function canonicalBoundTranslatedMeasurements(text, language) {
  const value = language === "source"
    ? joinDiscretionaryLatinLineBreaks(text)
    : String(text || "");
  const units = measurementUnitOccurrences(value, language);
  const numericTokens = measurementNumericTokenOccurrences(value);
  const strongBoundaries = measurementStrongClauseBoundaries(value);
  const neighborBoundaries = units.slice(0, -1).map((unit, index) =>
    measurementBoundaryBetweenUnits(value, unit, units[index + 1])
  );
  return units.map((unit, index) => {
    const hardLeft = strongBoundaries.filter((boundary) => boundary <= unit.start).at(-1) ?? 0;
    const hardRight = strongBoundaries.find((boundary) => boundary >= unit.end) ?? value.length;
    const left = Math.max(hardLeft, index ? neighborBoundaries[index - 1] : 0);
    const right = Math.min(
      hardRight,
      index < neighborBoundaries.length ? neighborBoundaries[index] : value.length,
    );
    const localTokens = numericTokens
      .filter((token) => {
        const center = (token.start + token.end) / 2;
        return center >= left && center < right;
      })
      .map((token) => token.raw)
      .sort();
    const numericSequence = localTokens.length ? localTokens.join("\u001f") : "<unbound>";
    return `${numericSequence}\u0000${unit.key}`;
  });
}

function normalizeTranslatedEnglishUnitNotation(sourceText, targetText) {
  if (typeof targetText !== "string" || !targetText) return targetText;
  const source = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(sourceText),
  );
  let target = targetText;
  for (const [pattern, replacement] of SPELLED_UNIT_TRANSLATIONS) {
    const sourceRe = new RegExp(`\\b(?:${pattern})\\b`, "gi");
    let remaining = (source.match(sourceRe) || []).length;
    if (!remaining) continue;
    const targetRe = new RegExp(`\\b(?:${pattern})\\b`, "gi");
    target = target.replace(targetRe, (match) => {
      if (!remaining) return match;
      remaining -= 1;
      return replacement;
    });
  }
  return target;
}

function normalizeTranslationCandidateText(sourceText, targetText) {
  if (typeof targetText !== "string") return targetText;
  const ligatures = normalizeLatinCompatibilityLigatures(targetText);
  const discretionaryBreaks = joinDiscretionaryLatinLineBreaks(ligatures);
  const gluedMath = normalizeSourceBoundGluedMathNotation(
    sourceText,
    discretionaryBreaks,
  );
  const scales = normalizeTranslatedEnglishScaleNotation(sourceText, gluedMath);
  return normalizeTranslatedEnglishUnitNotation(sourceText, scales);
}

function scaledNumberOccurrences(text, language) {
  const value = language === "source"
    ? joinDiscretionaryLatinLineBreaks(text)
    : String(text || "");
  const unitPattern = language === "source"
    ? "million|billion|trillion"
    : "천억|백억|십억|천만|백만|십만|조|억|만|천";
  const factors = language === "source" ? ENGLISH_SCALE_FACTORS : KOREAN_SCALE_FACTORS;
  const re = new RegExp(`(${NUMERIC_TOKEN_RE.source})\\s*(${unitPattern})(?![A-Za-z가-힣])`, "gi");
  const occurrences = [];
  let match;
  while ((match = re.exec(value))) {
    const unit = language === "source" ? match[2].toLowerCase() : match[2];
    const key = scaledDecimalKey(match[1], factors[unit]);
    if (key) occurrences.push({ token: match[1], key });
  }
  return occurrences;
}

function incrementCount(map, token, count = 1) {
  if (count > 0) map.set(token, (map.get(token) || 0) + count);
}

function englishNumberWordAllowances(sourceText) {
  const allowances = new Map();
  const source = String(sourceText || "");
  const re = /\b[A-Za-z]+\b/g;
  let match;
  while ((match = re.exec(source))) {
    const raw = match[0];
    const word = raw.toLowerCase();
    const targetToken = ENGLISH_NUMBER_WORD_VALUES[word];
    if (!targetToken) continue;
    // Month names grant a digit only when used as a proper calendar name. This
    // prevents the modal verb "may" from silently authorizing an invented 5.
    if (ENGLISH_MONTH_WORDS.has(word) && !/^[A-Z]/.test(raw)) continue;
    incrementCount(allowances, targetToken);
  }
  return allowances;
}

function sourceNumberWordCreditViews(sourceText) {
  const source = String(sourceText || "");
  const numberWords = Object.keys(ENGLISH_NUMBER_WORD_VALUES)
    .sort((a, b) => b.length - a.length)
    .join("|");
  // Keep a genuine compound boundary visible (``three- dimensional``), while
  // retaining the normal joined view for a word split such as ``sev- en``.
  const compoundPreserved = source.replace(
    new RegExp(`\\b(${numberWords})-\\s+([a-z])`, "gi"),
    "$1-$2",
  );
  return [joinDiscretionaryLatinLineBreaks(source), compoundPreserved];
}

function mergeMaximumCounts(target, source) {
  for (const [token, count] of source) {
    target.set(token, Math.max(target.get(token) || 0, count));
  }
  return target;
}

function countKoreanMinuteThirtyOccurrences(targetText) {
  return (
    String(targetText || "").match(/(?:^|[^\d])30\s*분(?!\s*의)/g) || []
  ).length;
}

function halfHourAllowances(sourceText, targetText) {
  const sourceHalfHours = (
    joinDiscretionaryLatinLineBreaks(sourceText).match(
      /\bhalf(?:\s+an?)?\s+hours?\b/gi,
    ) || []
  ).length;
  return Math.min(sourceHalfHours, countKoreanMinuteThirtyOccurrences(targetText));
}

function implicitPerTimeOneAllowances(sourceText, targetText) {
  const source = joinDiscretionaryLatinLineBreaks(sourceText);
  const target = String(targetText || "");
  const units = [
    ["millisecond", /(?:^|[^\d])1\s*밀리초/g],
    ["year", /(?:^|[^\d])1\s*년/g],
    ["month", /(?:^|[^\d])1\s*(?:개월|달)/g],
    ["week", /(?:^|[^\d])1\s*주/g],
    ["day", /(?:^|[^\d])1\s*일/g],
    ["hour", /(?:^|[^\d])1\s*시간/g],
    ["minute", /(?:^|[^\d])1\s*분(?!\s*의)/g],
    ["second", /(?:^|[^\d])1\s*초/g],
  ];
  let credits = 0;
  for (const [unit, targetPattern] of units) {
    const sourceCount = (
      source.match(new RegExp(`\\b(?:per|every)\\s+${unit}s?\\b`, "gi")) || []
    ).length;
    if (!sourceCount) continue;
    const targetCount = (target.match(targetPattern) || []).length;
    credits += Math.min(sourceCount, targetCount);
  }
  return credits;
}

function implicitIndefiniteTimeOneAllowances(sourceText, targetText) {
  const source = joinDiscretionaryLatinLineBreaks(sourceText);
  const target = String(targetText || "");
  const units = [
    ["year", /(?:^|[^\d])1\s*년/g],
    ["month", /(?:^|[^\d])1\s*(?:개월|달)/g],
    ["week", /(?:^|[^\d])1\s*주/g],
    ["day", /(?:^|[^\d])1\s*일/g],
    ["hour", /(?:^|[^\d])1\s*시간/g],
    ["minute", /(?:^|[^\d])1\s*분(?!\s*의)/g],
    ["second", /(?:^|[^\d])1\s*초/g],
  ];
  let credits = 0;
  for (const [unit, targetPattern] of units) {
    const sourceCount = (
      source.match(new RegExp(`\\b(?:a|an)\\s+${unit}s?\\b`, "gi")) || []
    ).length;
    if (!sourceCount) continue;
    const targetCount = (target.match(targetPattern) || []).length;
    credits += Math.min(sourceCount, targetCount);
  }
  return credits;
}

const ENGLISH_CARDINAL_WORD_VALUES = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
});

/**
 * Grant a numeric literal only for an exact spelled duration conversion that is
 * actually present in both strings (``two decades`` -> ``20년``).  The generic
 * number-word allowance cannot prove this because it sees only ``two`` and would
 * otherwise authorize 2, not 20.  Binding the computed value to the Korean year
 * suffix keeps the exception source-derived and prevents it from excusing an
 * unrelated 20 elsewhere in the answer.
 */
function implicitSpelledDurationAllowances(sourceText, targetText) {
  const source = joinDiscretionaryLatinLineBreaks(sourceText);
  const target = String(targetText || "");
  const sourceCounts = new Map();
  const durationRe = new RegExp(
    `\\b(${Object.keys(ENGLISH_CARDINAL_WORD_VALUES).join("|")}|a|an)\\s+` +
      "(decades?|centur(?:y|ies)|millenn(?:ium|ia|iums))\\b",
    "gi",
  );
  let match;
  while ((match = durationRe.exec(source))) {
    const word = match[1].toLowerCase();
    const count = word === "a" || word === "an"
      ? 1
      : ENGLISH_CARDINAL_WORD_VALUES[word];
    const unit = match[2].toLowerCase();
    const factor = unit.startsWith("decade")
      ? 10
      : unit.startsWith("centur") ? 100 : 1000;
    const token = String(count * factor);
    incrementCount(sourceCounts, token);
  }

  const allowances = new Map();
  for (const [token, sourceCount] of sourceCounts) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const targetCount = (
      target.match(new RegExp(`(?:^|[^\\d])${escaped}\\s*(?:여\\s*)?년`, "g")) || []
    ).length;
    incrementCount(allowances, token, Math.min(sourceCount, targetCount));
  }
  return allowances;
}

/** Bind a spelled scale quantity to an exact Korean scaled numeral. */
function implicitSpelledScaleAllowances(sourceText, targetText) {
  const source = joinDiscretionaryLatinLineBreaks(sourceText);
  const sourceQuantities = [];
  const wordPattern = [
    "a", "an", ...Object.keys(ENGLISH_CARDINAL_WORD_VALUES),
  ].join("|");
  const re = new RegExp(
    `\\b(${wordPattern})\\s+(million|billion|trillion)\\b`,
    "gi",
  );
  let match;
  while ((match = re.exec(source))) {
    const word = match[1].toLowerCase();
    const coefficient = word === "a" || word === "an"
      ? 1
      : ENGLISH_CARDINAL_WORD_VALUES[word];
    if (!coefficient) continue;
    const factor = ENGLISH_SCALE_FACTORS[match[2].toLowerCase()];
    const key = scaledDecimalKey(String(coefficient), factor);
    if (key) sourceQuantities.push(key);
  }
  const implicitTimeScale = /\b(?:the\s+)?(?:next|last|about)\s+(million|billion|trillion)\s+(?:years?|months?|weeks?|days?|hours?|minutes?|seconds?)\b/gi;
  while ((match = implicitTimeScale.exec(source))) {
    const factor = ENGLISH_SCALE_FACTORS[match[1].toLowerCase()];
    const key = scaledDecimalKey("1", factor);
    if (key) sourceQuantities.push(key);
  }

  const targetQuantities = scaledNumberOccurrences(targetText, "target");
  const usedTargets = new Set();
  const rawTargetQuantities = [];
  const rawTargetText = String(targetText || "");
  const rawTargetRe = new RegExp(NUMERIC_TOKEN_RE.source, "g");
  let rawTargetMatch;
  while ((rawTargetMatch = rawTargetRe.exec(rawTargetText))) {
    const following = rawTargetText.slice(rawTargetRe.lastIndex);
    if (/^\s*(?:천억|백억|십억|천만|백만|십만|조|억|만|천)/.test(following)) {
      continue;
    }
    rawTargetQuantities.push({
      token: rawTargetMatch[0],
      key: scaledDecimalKey(rawTargetMatch[0], 1n),
    });
  }
  const usedRawTargets = new Set();
  const allowances = new Map();
  for (const key of sourceQuantities) {
    const targetIndex = targetQuantities.findIndex(
      (quantity, index) => !usedTargets.has(index) && quantity.key === key,
    );
    if (targetIndex >= 0) {
      usedTargets.add(targetIndex);
      incrementCount(allowances, targetQuantities[targetIndex].token);
      continue;
    }
    const rawIndex = rawTargetQuantities.findIndex(
      (quantity, index) => !usedRawTargets.has(index) && quantity.key === key,
    );
    if (rawIndex < 0) continue;
    usedRawTargets.add(rawIndex);
    incrementCount(allowances, rawTargetQuantities[rawIndex].token);
  }
  return allowances;
}

function numericTokensPreserved(sourceText, targetText) {
  const source = extractNumericTokens(sourceText);
  const target = extractNumericTokens(targetText);
  const sourceCounts = new Map();
  const targetCounts = new Map();
  for (const token of source) sourceCounts.set(token, (sourceCounts.get(token) || 0) + 1);
  for (const token of target) targetCounts.set(token, (targetCounts.get(token) || 0) + 1);

  // Korean large-number notation changes the visible numeral while preserving an
  // exact quantity (18 mil- lion -> 1,800만; 500 million -> 5억). Reconcile only
  // a source literal immediately bound to an English scale word with one target
  // literal immediately bound to a Korean scale unit, and require exact rational
  // equality. Unscaled literals remain byte-for-byte mandatory below.
  const sourceScaled = scaledNumberOccurrences(sourceText, "source");
  const targetScaled = scaledNumberOccurrences(targetText, "target");
  const usedTargetScaled = new Set();
  for (const sourceQuantity of sourceScaled) {
    const targetIndex = targetScaled.findIndex(
      (targetQuantity, index) =>
        !usedTargetScaled.has(index) && targetQuantity.key === sourceQuantity.key,
    );
    if (targetIndex < 0) continue;
    const targetQuantity = targetScaled[targetIndex];
    if (
      (sourceCounts.get(sourceQuantity.token) || 0) < 1 ||
      (targetCounts.get(targetQuantity.token) || 0) < 1
    ) continue;
    sourceCounts.set(sourceQuantity.token, sourceCounts.get(sourceQuantity.token) - 1);
    targetCounts.set(targetQuantity.token, targetCounts.get(targetQuantity.token) - 1);
    usedTargetScaled.add(targetIndex);
  }

  // Every literal source number remains mandatory, including its exact formatting.
  for (const [token, count] of sourceCounts) {
    if ((targetCounts.get(token) || 0) < count) return false;
  }

  // Korean convention often renders source number/month words with digits (Sixth
  // Edition -> 제6판, April -> 4월, one tenth -> 10분의 1). Credits are value-aware:
  // an English "one" can authorize only an added 1, never an unrelated 7 or 99.
  const extraTargetCounts = new Map();
  for (const [token, count] of targetCounts) {
    const extra = Math.max(0, count - (sourceCounts.get(token) || 0));
    if (extra) extraTargetCounts.set(token, extra);
  }
  const spelledScaleWords = [
    "a", "an", ...Object.keys(ENGLISH_CARDINAL_WORD_VALUES),
  ].join("|");
  const allowances = new Map();
  for (const sourceView of sourceNumberWordCreditViews(sourceText)) {
    const sourceForWordCredits = sourceView
      .replace(
        new RegExp(`(?:${NUMERIC_TOKEN_RE.source})\\s*(?:million|billion|trillion)\\b`, "gi"),
        "",
      )
      .replace(
        new RegExp(`\\b(?:${spelledScaleWords})\\s+(?:million|billion|trillion)\\b`, "gi"),
        "",
      );
    mergeMaximumCounts(allowances, englishNumberWordAllowances(sourceForWordCredits));
  }
  incrementCount(
    allowances,
    "1",
    implicitPerTimeOneAllowances(sourceText, targetText) +
      implicitIndefiniteTimeOneAllowances(sourceText, targetText),
  );
  for (const [token, count] of implicitSpelledDurationAllowances(sourceText, targetText)) {
    incrementCount(allowances, token, count);
  }
  for (const [token, count] of implicitSpelledScaleAllowances(sourceText, targetText)) {
    incrementCount(allowances, token, count);
  }
  // "half an hour" is a semantic conversion, not a generic number-word credit.
  // Bind it to an actual Korean 30분 occurrence so it cannot excuse 30 elsewhere.
  incrementCount(allowances, "30", halfHourAllowances(sourceText, targetText));
  for (const [token, count] of extraTargetCounts) {
    if (count > (allowances.get(token) || 0)) return false;
  }
  return true;
}

function extractUrls(text) {
  return (String(text || "").match(URL_RE) || []).map((url) =>
    // Sentence punctuation is not part of an otherwise valid URL. Do not strip ')' because
    // it may legitimately occur in a URL path and exact preservation is safer here.
    url.replace(/[.,;:!?]+$/g, ""),
  );
}

function extractScientificMarkup(text) {
  const value = String(text || "");
  const tags = value.match(/<\/?(?:sub|sup)>/gi) || [];
  const literals = [];
  const re = /<(sub|sup)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(value))) {
    literals.push(`${match[1]}:${match[2]}`);
  }
  const footnoteMarkers = [];
  const footnoteRe = /<sup>([a-z])<\/sup>/g;
  while ((match = footnoteRe.exec(value))) {
    const before = value.slice(0, match.index);
    const after = value.slice(footnoteRe.lastIndex);
    const suffixWord = before.match(/([A-Za-z가-힣]{2,})\s*$/);
    const proseSuffix = Boolean(
      suffixWord && !GLUED_MATH_FUNCTIONS.includes(suffixWord[1].toLowerCase()),
    );
    const prefixBoundary = !before || /[\s,;:()\[\]{}] ?$/.test(before);
    const prosePrefix = prefixBoundary &&
      /^\s*(?:[A-Z][a-z]{1,}|[가-힣]|[⇑⇓])/.test(after);
    if (proseSuffix || prosePrefix) footnoteMarkers.push(match[1]);
  }
  // Bind each tag chain to its scientific base.  A chain can follow its base
  // (R<sub>e</sub>) or precede it for isotope notation (<sup>12</sup>C).
  // Prefer the right-hand isotope base so prose such as ``of <sup>12</sup>C``
  // cannot be misread as the impossible atom ``of<sup>12</sup>``.
  const atoms = [];
  const numericTagChain = (chain) => {
    const contents = Array.from(
      String(chain || "").matchAll(/<(?:sub|sup)>([^<>]*)<\/(?:sub|sup)>/gi),
      (entry) => entry[1].trim(),
    );
    return Boolean(
      contents.length && contents.every((content) => /^[+−-]?\d+$/.test(content)),
    );
  };
  const prefixAtomRe = /((?:<sub>[^<>]*<\/sub>|<sup>[^<>]*<\/sup>)(?:\s*(?:<sub>[^<>]*<\/sub>|<sup>[^<>]*<\/sup>))*)([A-Z][a-z]?|[Α-Ωα-ωϑϕϱ϶ϰ])/g;
  while ((match = prefixAtomRe.exec(value))) {
    if (!numericTagChain(match[1])) continue;
    atoms.push(
      `${match[1].replace(/\s/g, "").toLowerCase()}${match[2]}`,
    );
  }

  const atomRe = /([A-Za-zΑ-Ωα-ωϑϕϱ϶ϰ0-9]+(?:\s*[′″'])?)\s*((?:(?:<sub>[^<>]*<\/sub>|<sup>[^<>]*<\/sup>)\s*)+)/gi;
  while ((match = atomRe.exec(value))) {
    const following = value.slice(atomRe.lastIndex);
    // The same chain was already bound to a following isotope/element symbol.
    if (
      numericTagChain(match[2]) &&
      /^(?:[A-Z][a-z]?|[Α-Ωα-ωϑϕϱ϶ϰ])/.test(following)
    ) continue;
    const base = match[1].replace(/[\s′″']/g, "");
    const chain = match[2].replace(/\s/g, "").toLowerCase();
    const proseFootnote =
      /^[A-Za-z]{2,}$/.test(base) &&
      !GLUED_MATH_FUNCTIONS.includes(base.toLowerCase()) &&
      /^<sup>[a-z]<\/sup>$/.test(chain);
    // A superscript letter on a prose/table label is a footnote marker. Its tag
    // and literal still remain byte-exact above, but the translated label itself
    // must not be preserved as though it were a formula variable.
    if (proseFootnote) continue;
    const gluedLabelVariablePrefixes = new Set([
      "angle", "density", "distance", "energy", "frequency", "luminosity",
      "mass", "pressure", "radius", "temperature", "velocity",
    ]);
    const labelVariable =
      /^<sub>[+−-]?\d+<\/sub>/.test(chain) &&
      /^\s*=/.test(following) &&
      gluedLabelVariablePrefixes.has(base.slice(0, -1).toLowerCase())
        ? base.slice(-1)
        : match[1].replace(/\s/g, "");
    atoms.push(
      `${labelVariable}${match[2].replace(/\s/g, "").toLowerCase()}`,
    );
  }
  return { tags, literals, atoms, footnoteMarkers };
}

function extractSourceExactCompactScientificLedger(text) {
  const value = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(text),
  );
  const ledger = [];
  const tokenRe = new RegExp(ENGLISH_TOKEN_RE.source, "g");
  let match;
  while ((match = tokenRe.exec(value))) {
    const raw = match[0];
    if (!SOURCE_EXACT_COMPACT_SCIENTIFIC_WORDS.has(raw.toLowerCase())) continue;
    // A genuine glued function such as ``sini`` has its function+argument
    // identity recorded separately and is normalized to ``sin i`` in accepted
    // output. All other compact tokens remain exact in spelling, case and count.
    if (
      parseGluedMathIdentifier(raw)?.length &&
      mathFunctionContext(value, match.index, tokenRe.lastIndex, raw)
    ) {
      continue;
    }
    ledger.push(`source-exact:${raw}`);
  }
  return ledger;
}

function extractScientificLiterals(text) {
  // Rejoin only discretionary alphabetic line breaks before looking for math
  // functions. Without this, textbook prose such as ``1 arc sec- ond`` exposes a
  // false ``sec`` function because a nearby digit makes the fragment look formulaic.
  const value = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(text),
  );
  const symbols = (value.match(SCIENTIFIC_SYMBOL_RE) || []).map((token) => `symbol:${token}`);
  const functions = [];
  const functionAtoms = [];
  const tokenRe = new RegExp(ENGLISH_TOKEN_RE.source, "g");
  let match;
  while ((match = tokenRe.exec(value))) {
    if (NATURAL_MATH_WORD_FORMS.has(match[0].toLowerCase())) continue;
    if (NON_FORMULA_MATH_PREFIX_WORDS.has(match[0].toLowerCase())) continue;
    if (FORMULA_PROSE_STOPWORDS.has(match[0].toLowerCase())) continue;
    const parsed = parseGluedMathIdentifier(match[0]);
    if (!parsed?.length) continue;
    const following = value.slice(tokenRe.lastIndex, Math.min(value.length, tokenRe.lastIndex + 8));
    const exactFunctionInFormula = mathFunctionContext(
      value,
      match.index,
      tokenRe.lastIndex,
      match[0],
    );
    if (!exactFunctionInFormula) continue;
    for (const name of parsed) functions.push(`function:${name}`);
    if (parsed.length === 1) {
      const functionName = parsed[0];
      const rawToken = match[0];
      let argument = "";
      if (rawToken.toLowerCase().startsWith(functionName)) {
        const suffix = rawToken.slice(functionName.length);
        if (/^[A-Za-z]{1,2}$/.test(suffix)) argument = suffix;
      }
      if (!argument && rawToken.toLowerCase() === functionName) {
        const separated = following.match(
          /^\s+([A-Za-z]{1,2})(?=\s|[가-힣]|[),.;=+*/^<>−-]|[}\]]|$)/,
        );
        if (separated) argument = separated[1];
      }
      if (argument) functionAtoms.push(`function-atom:${functionName}:${argument}`);
    }
  }
  return [
    ...symbols,
    ...functions,
    ...functionAtoms,
    ...extractSourceExactCompactScientificLedger(value),
  ];
}

function formatCodePoint(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

const LATIN_COMPATIBILITY_LIGATURES = Object.freeze({
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
});

/**
 * Expand only the seven presentation-form Latin ligatures emitted by older PDFs.
 * Do not use broad NFKC here: numeric and scientific literals must remain raw for
 * the existing deterministic preservation checks.
 */
function normalizeLatinCompatibilityLigatures(value) {
  if (typeof value !== "string") return value;
  return value.replace(/[ﬀ-ﬆ]/g, (char) => LATIN_COMPATIBILITY_LIGATURES[char]);
}

/**
 * Return unsupported target code points without normalization or text excerpts.
 *
 * The bundled renderer supports BMP Korean/Latin/Common/Inherited characters. Other BMP
 * scripts are retained only when that exact raw code point occurs in the source (formulae and
 * proper nouns). Every non-BMP code point is rejected even if present in the source because the
 * renderer currently cannot guarantee a glyph. Deliberately comparing raw code points prevents
 * NFC/NFKC normalization from laundering a source-absent character into the allow-list.
 */
function findUnsupportedTargetCodePoints(sourceText, targetText) {
  const sourceCodePoints = new Set(
    Array.from(String(sourceText || ""), (char) => char.codePointAt(0)),
  );
  const unsupported = new Map();
  for (const char of Array.from(String(targetText || ""))) {
    const codePoint = char.codePointAt(0);
    const isNonBmp = codePoint > 0xffff;
    const isAlwaysAllowedBmp = !isNonBmp && ALWAYS_ALLOWED_TARGET_SCRIPT_RE.test(char);
    if (isNonBmp || (!isAlwaysAllowedBmp && !sourceCodePoints.has(codePoint))) {
      unsupported.set(codePoint, formatCodePoint(codePoint));
    }
  }
  return Array.from(unsupported.values());
}

function maskRange(chars, start, end) {
  for (let i = Math.max(0, start); i < Math.min(chars.length, end); i += 1) chars[i] = " ";
}

const BIBLIOGRAPHY_YEAR_RE_SOURCE = "(?:18|19|20)\\d{2}[a-z]?";
const CLASSIC_BIBLIOGRAPHY_AUTHOR_RE_SOURCE =
  "[A-Z][A-Za-z’'\\-]+,\\s*(?:[A-Z]\\.){1,4}";
const MODERN_BIBLIOGRAPHY_NAME_RE_SOURCE =
  "(?:(?:[A-Z]\\.){1,4}\\s*)?[A-Z][A-Za-z’'\\-]+";
const CLASSIC_BIBLIOGRAPHY_AUTHOR_YEAR_RE = new RegExp(
  `\\b${CLASSIC_BIBLIOGRAPHY_AUTHOR_RE_SOURCE}` +
    `(?:\\s*,\\s*${CLASSIC_BIBLIOGRAPHY_AUTHOR_RE_SOURCE})*` +
    `(?:\\s+et\\s+al\\.)?\\s*\\(${BIBLIOGRAPHY_YEAR_RE_SOURCE}\\)` +
    "(?=\\s*[:;,.)])",
  "g",
);
const MODERN_BIBLIOGRAPHY_AUTHOR_YEAR_RE = new RegExp(
  `\\b${MODERN_BIBLIOGRAPHY_NAME_RE_SOURCE}` +
    `(?:(?:\\s*,\\s*|\\s+and\\s+)${MODERN_BIBLIOGRAPHY_NAME_RE_SOURCE})*` +
    `(?:\\s+et\\s+al\\.)?\\s*,?\\s+${BIBLIOGRAPHY_YEAR_RE_SOURCE}` +
    "(?=\\s*(?:,|;|\\)|\\]|$))",
  "g",
);
const ENGLISH_CREDIT_WRAPPER_RE_SOURCE =
  "(?:(?:photo(?:graphs?|graphy|s)?(?:\\s+credits?)?|pictures?|images?|diagrams?|drawings?|graphics?)(?:\\s+by)?|" +
    "credits?|sources?|courtesy(?:\\s+of)?|by)";
const KOREAN_CREDIT_WRAPPER_RE_SOURCE =
  "(?:(?:사진|이미지|도표|그림|그래픽)(?:\\s*(?:출처|제공|촬영|제작))?|" +
    "출처|자료\\s*제공|제공|크레디트)";
const KOREAN_TRAILING_CREDIT_WRAPPER_RE_SOURCE =
  "(?:(?:사진|이미지|도표|그림)\\s*(?:출처|제공|촬영|제작)|" +
    "출처|자료\\s*제공|제공|크레디트)";
const INLINE_PHOTOGRAPHER_NAME_RE_SOURCE =
  "(?:" +
    "[A-Z][\\p{L}\\p{M}’'\\-]+(?:\\s+[A-Z]\\.){1,3}\\s+[A-Z][\\p{L}\\p{M}’'\\-]+|" +
    "(?:[A-Z]\\.){1,4}\\s*[A-Z][\\p{L}\\p{M}’'\\-]+|" +
    "[A-Z][\\p{L}\\p{M}’'\\-]+\\s+[A-Z][\\p{L}\\p{M}’'\\-]+" +
  ")";
const NON_AUTHOR_MODERN_CITATION_NAMES = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december", "edition", "version",
  "figure", "table", "chapter", "section", "volume",
]);

function bibliographyInnerValue(candidate) {
  const value = String(candidate || "").trim();
  if (
    (value.startsWith("(") && value.endsWith(")")) ||
    (value.startsWith("[") && value.endsWith("]"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function yearlessCreditBody(candidate) {
  const value = bibliographyInnerValue(joinDiscretionaryLatinLineBreaks(candidate));
  const wrapper = new RegExp(
    `^(?:${ENGLISH_CREDIT_WRAPPER_RE_SOURCE}|${KOREAN_CREDIT_WRAPPER_RE_SOURCE})` +
      "\\s*[:：]?\\s+([\\s\\S]+)$",
    "i",
  );
  const match = value.match(wrapper);
  if (match) {
    const body = match[1].trim();
    // An explicit credit wrapper is not enough: bind only a retained Latin
    // proper name / organisation signature, not translatable source prose.
    return /^(?:©\s*)?(?:the\s+)?[A-Z][A-Za-z0-9.’'&/\-]*/.test(body)
      ? body
      : null;
  }
  const koreanSuffix = value.match(new RegExp(
    `^((?:©\\s*)?(?:the\\s+)?[A-Z][\\s\\S]+?)\\s+(?:${KOREAN_CREDIT_WRAPPER_RE_SOURCE})$`,
  ));
  if (koreanSuffix) return koreanSuffix[1].trim();
  // Wrapper-free credits in astronomy captions are commonly a slash-separated
  // all-caps agency ledger, optionally followed by a named contributor.
  if (
    /^(?:[A-Z]{2,}|(?:[A-Z]\.){2,})(?:\/[A-Z0-9][A-Za-z0-9.\-]*)+(?:[\s,;/].*)?$/.test(value)
  ) {
    return value;
  }
  return null;
}

function hasBibliographyAuthorYearLedger(candidate) {
  if (new RegExp(CLASSIC_BIBLIOGRAPHY_AUTHOR_YEAR_RE.source).test(candidate)) return true;
  const modern = new RegExp(MODERN_BIBLIOGRAPHY_AUTHOR_YEAR_RE.source, "g");
  let match;
  while ((match = modern.exec(candidate))) {
    const nameWords = match[0].match(/\b[A-Z][A-Za-z’'\-]+\b/g) || [];
    if (nameWords.some((word) => NON_AUTHOR_MODERN_CITATION_NAMES.has(word.toLowerCase()))) {
      continue;
    }
    return true;
  }
  return false;
}

function hasBibliographyLedger(candidate) {
  return hasBibliographyAuthorYearLedger(candidate) || Boolean(yearlessCreditBody(candidate));
}

function bibliographyCanonicalSignature(candidate) {
  let value = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(candidate),
  ).trim();
  let opening = "";
  let closing = "";
  if (value.startsWith("(") && value.endsWith(")")) {
    opening = "(";
    closing = ")";
  } else if (value.startsWith("[") && value.endsWith("]")) {
    opening = "[";
    closing = "]";
  }
  if (opening) value = value.slice(1, -1).trim();

  // Only explicit attribution wrappers may be translated. Everything inside
  // the citation ledger—including case, colon/dash choice, journal punctuation,
  // author order and repeated citations—remains exact after whitespace and
  // discretionary line-break normalization.
  value = value.replace(
    /^(?:(?:drawing|picture)\s+(?:based\s+on|from)|(?:adapted|modified)\s+from(?:\s+the)?|based\s+on|from)\s*[:：]?\s+/i,
    "",
  );
  value = value.replace(
    new RegExp(`^${ENGLISH_CREDIT_WRAPPER_RE_SOURCE}\\s*[:：]?\\s+`, "i"),
    "",
  );
  value = value.replace(
    new RegExp(
      `^(?:${KOREAN_CREDIT_WRAPPER_RE_SOURCE}|다음을\\s*바탕으로\\s*함|` +
        "다음에\\s*바탕을\\s*둠)\\s*[:：]?\\s*",
    ),
    "",
  );
  value = value.replace(/\s*used\s+by\s+permission\s*$/i, "");
  value = value.replace(
    /\s*(?:(?:을|를)?\s*바탕으로\s*(?:수정|각색|재구성)(?:함|됨)?|에서\s*(?:수정|각색|재구성)(?:함|됨)?)\s*\.?\s*$/,
    ".",
  );
  value = value.replace(
    /\s*(?:에\s*바탕을\s*(?:둠|둔\s*(?:그림|것|자료)|두었음)|(?:을|를)\s*바탕으로\s*한\s*(?:그림|것|자료)|에서\s*그림|에\s*기반(?:함|한\s*그림)|허가를\s*받아\s*사용(?:함|됨)?)\s*\.?\s*$/,
    "",
  );
  value = value.replace(
    new RegExp(`\\s+(?:${KOREAN_CREDIT_WRAPPER_RE_SOURCE})$`),
    "",
  );
  value = value.replace(/\s+/g, " ").trim();
  return `${opening}${value}${closing}`;
}

function boundedTrailingCreditCandidate(value, start) {
  const tail = value.slice(start);
  const stop = tail.search(
    /\s+(?=(?:printed\s+on|springer\s+is|isbn|copyright)\b|무산성(?:지|종이|용지)?|산성\s+(?:성분이\s+)?없는\s+(?:종이|용지)|인쇄(?:됨|되었|된)|Springer[는가])/i,
  );
  return stop > 0 ? tail.slice(0, stop) : tail;
}

function bibliographyCandidates(text) {
  const value = String(text || "");
  const candidates = [];
  const add = (candidate, start) => {
    if (!hasBibliographyLedger(candidate)) return;
    const end = start + candidate.length;
    if (candidates.some((entry) => start < entry.end && end > entry.start)) return;
    candidates.push({
      value: candidate,
      canonical: bibliographyCanonicalSignature(candidate),
      start,
      end,
    });
  };

  const bracketed = /\[[^\[\]]+\]/g;
  let match;
  while ((match = bracketed.exec(value))) add(match[0], match.index);

  // The smallest balanced parenthetical group containing an author-year ledger
  // is a caption bibliography. Nested year / publisher parentheses do not match
  // the author pattern on their own, so the enclosing citation is selected.
  const stack = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") {
      stack.push(index);
    } else if (value[index] === ")" && stack.length) {
      const start = stack.pop();
      add(value.slice(start, index + 1), start);
    }
  }

  // Some textbook captions use an unbracketed sentence-final bibliography.
  // Match from the first one- or multi-author ``Surname, I.I. (year):`` ledger.
  for (const ledgerRe of [
    CLASSIC_BIBLIOGRAPHY_AUTHOR_YEAR_RE,
    MODERN_BIBLIOGRAPHY_AUTHOR_YEAR_RE,
  ]) {
    ledgerRe.lastIndex = 0;
    while ((match = ledgerRe.exec(value))) {
      if (
        ledgerRe === MODERN_BIBLIOGRAPHY_AUTHOR_YEAR_RE &&
        !/\bet\s+al\.|(?:[A-Z]\.){1,4}/.test(match[0]) &&
        !/[\[(]/.test(value[match.index - 1] || "")
      ) {
        // Bare ``Smith 2004`` is citation-like only inside an explicit
        // parenthetical group. This avoids treating ordinary tails such as
        // ``Sixth Edition, April 2016`` as unbracketed bibliographies.
        continue;
      }
      add(value.slice(match.index), match.index);
    }
  }
  const trailingCreditRe = new RegExp(
    "(?:(?:\\b(?:photo(?:graphs?|graphy|s)?(?:\\s+credits?)?|pictures?|images?|diagrams?|drawings?|graphics?|credits?|sources?)\\b\\s*[:：]\\s*|" +
      "\\bcourtesy\\b(?:\\s+of)?\\s*(?:[:：]\\s*)?)|" +
      `${KOREAN_TRAILING_CREDIT_WRAPPER_RE_SOURCE}\\s*[:：]?\\s+)` +
      "(?=(?:©\\s*)?(?:the\\s+)?[A-Z])",
    "gi",
  );
  while ((match = trailingCreditRe.exec(value))) {
    add(boundedTrailingCreditCandidate(value, match.index), match.index);
  }
  return candidates.sort((a, b) => a.start - b.start);
}

// Credit-list prose sometimes carries an attribution inline instead of in a
// bracketed caption, e.g. ``Observatory, photograph by David R. Malin``. Bind
// the photographer body while allowing the wrapper to become either a Korean
// prefix or the idiomatic suffix ``David R. Malin 촬영``. Requiring a list
// boundary keeps ordinary prose such as ``The photograph by ... was shown``
// out of this ledger.
function inlinePhotographerCreditCandidates(text) {
  const value = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(text),
  );
  const candidates = [];
  const addMatches = (re, bodyGroup = 1) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value))) {
      const body = String(match[bodyGroup] || "").replace(/\s+/g, " ").trim();
      if (!body) continue;
      candidates.push({ value: match[0].trim(), canonical: body });
    }
  };

  addMatches(new RegExp(
    `(?:^|[,;])\\s*photograph\\s+by\\s+(${INLINE_PHOTOGRAPHER_NAME_RE_SOURCE})` +
      "(?=\\s|[,;.)]|$)",
    "giu",
  ));
  addMatches(new RegExp(
    `(?:^|[,;])\\s*(?:사진(?:\\s*(?:촬영|제공))?|촬영)\\s*[:：]?\\s+` +
      `(${INLINE_PHOTOGRAPHER_NAME_RE_SOURCE})(?=\\s|[,;.)]|$)`,
    "gu",
  ));
  addMatches(new RegExp(
    `(?:^|[,;])\\s*(${INLINE_PHOTOGRAPHER_NAME_RE_SOURCE})` +
      "\\s*(?:이|가)?\\s*촬영(?=\\s|[,;.)]|$)",
    "gu",
  ));
  return candidates;
}

function sourceBoundBibliographyRanges(sourceText, targetText) {
  const remaining = new Map();
  for (const entry of bibliographyCandidates(sourceText)) {
    incrementCount(remaining, entry.canonical);
  }
  const ranges = [];
  for (const entry of bibliographyCandidates(targetText)) {
    const count = remaining.get(entry.canonical) || 0;
    if (!count) continue;
    remaining.set(entry.canonical, count - 1);
    ranges.push([entry.start, entry.end]);
  }
  return ranges;
}

// Keep string length stable so token offsets remain meaningful while excluding explicitly
// allowed English contexts: URLs, code literals, scientific markup, and parenthetical glosses.
function maskAllowedEnglishRegions(text, bibliographySourceText = null) {
  const value = String(text || "");
  // Regex offsets are UTF-16 code-unit offsets, so split("") (not Array.from) keeps indices
  // aligned even when Korean text or astral math symbols precede a masked range.
  const chars = value.split("");
  const maskMatches = (re) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value))) maskRange(chars, match.index, match.index + match[0].length);
  };
  const maskConditionalMatches = (re, predicate) => {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(value))) {
      if (predicate(match[0])) maskRange(chars, match.index, match.index + match[0].length);
    }
  };
  maskMatches(/```[\s\S]*?```/g);
  maskMatches(/`[^`]*`/g);
  // A base variable immediately followed by sub/sup markup is a formula atom.
  // Mask the base before masking the tag so extracted x′y′z′ coordinate chains
  // and expressions such as r<sup>2</sup> dr do not look like prose runs.
  maskMatches(/\b[A-Za-z](?=\s*<(?:sub|sup)>)/g);
  maskMatches(/<(sub|sup)>[\s\S]*?<\/\1>/gi);
  maskMatches(URL_RE);
  maskMatches(/\b[A-Za-z][A-Za-z0-9]*(?:[_./:@\\][A-Za-z0-9_-]+)+\b/g);
  maskMatches(/\b(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g);
  maskMatches(/\b(?:ID|No\.?)\s*[:#]?\s*[A-Za-z0-9][\w.-]*/gi);
  maskMatches(/\bcode\s*[:#]\s*[A-Za-z0-9][\w.-]*/gi);
  for (const [start, end] of sourceBoundBibliographyRanges(
    bibliographySourceText,
    value,
  )) {
    maskRange(chars, start, end);
  }
  // Do not split Kröger / Kyröläinen at the non-ASCII letter and mistake the
  // lowercase suffix ("ger", "inen") for untranslated English prose.
  maskConditionalMatches(/[\p{Script=Latin}\p{M}]+(?:[-’'][\p{Script=Latin}\p{M}]+)*/gu, (word) =>
    /[^\x00-\x7F]/.test(word),
  );
  // Retained multiword names containing an accented Latin word (for example a
  // Finnish foundation name) are a proper-name unit, not a lowercase prose run.
  maskConditionalMatches(/[A-Z][\p{Script=Latin}\p{M}]*(?:\s+[\p{Script=Latin}\p{M}]+){1,6}/gu, (phrase) =>
    /[^\x00-\x7F]/.test(phrase),
  );
  // Multiword organisation / instrument names often contain lowercase
  // connectors ("California Association for Research in Astronomy").  Retaining
  // that whole proper name is not untranslated prose.
  maskConditionalMatches(
    /\b[A-Z][A-Za-z]*(?:\s+[A-Z][A-Za-z]*)+(?:(?:\s+(?:for|of|and|in|the)\s+[A-Z][A-Za-z]*)|(?:\s+[A-Z][A-Za-z]*)){1,}\b/g,
    (phrase) => !/^(?:The|This|That|These|Those|A|An|Adopted|Use|Using|See)\b/.test(phrase),
  );
  // Bibliographies conventionally retain "and" between dotted author initials.
  // Requiring a dot on both sides keeps ordinary prose such as "A and B" visible
  // to the untranslated-English validator.
  maskMatches(/\b(?:[A-Z]\.){1,4}\s+and\s+(?:[A-Z]\.){1,4}/g);
  // A cited foreign lexeme may naturally follow a Korean language label, e.g.
  // "프랑스어 couder".  Only that tightly bound token is protected.
  maskMatches(/(?:영어|프랑스어|독일어|라틴어|그리스어|이탈리아어|스페인어|러시아어|일본어|중국어)\s+[A-Za-z]+(?:-[A-Za-z]+)*/g);

  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(" || ch === "（") {
      depth += 1;
      chars[i] = " ";
    } else if ((ch === ")" || ch === "）") && depth > 0) {
      chars[i] = " ";
      depth -= 1;
    } else if (depth > 0) {
      chars[i] = " ";
    }
  }

  let masked = chars.join("");
  for (const phrase of ALLOWED_LOWERCASE_PHRASES) {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    masked = masked.replace(new RegExp(`\\b${escaped}\\b`, "gi"), (m) => " ".repeat(m.length));
  }
  return masked;
}

function englishTokens(text) {
  const tokens = [];
  const re = new RegExp(ENGLISH_TOKEN_RE.source, "g");
  let match;
  while ((match = re.exec(String(text || "")))) {
    tokens.push({ raw: match[0], value: match[0].toLowerCase(), start: match.index, end: re.lastIndex });
  }
  return tokens;
}

function isRomanNumeralToken(value) {
  const token = String(value || "").toLowerCase();
  if (!token || token.length > 12) return false;
  return /^(?=[ivxlcdm]+$)m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/.test(token);
}

function isLiteralEnglishToken(raw, normalized) {
  return LOWERCASE_LITERAL_WORDS.has(normalized) || isRomanNumeralToken(raw);
}

function startsWithMathFunction(value) {
  return GLUED_MATH_FUNCTIONS.find((name) => value.startsWith(name)) || null;
}

// Old scientific PDFs often omit the visual thin space between a function and its
// variable (``cosc``, ``sinB``), or even between consecutive factors
// (``sinAsinb``).  Accept only a deliberately small formula grammar.  In
// particular, an ordinary word such as "since" is not a math identifier: one
// function may have only one trailing variable, while two trailing variables are
// allowed only after two or more explicit function names (e.g. ``sinsinaA``).
function parseGluedMathIdentifier(rawToken) {
  const raw = String(rawToken || "");
  if (!raw || /^[A-Z]/.test(raw)) return null;
  let value = raw.toLowerCase();
  let functionCount = 0;
  const functions = [];

  // A single leading variable is common in extracted products such as zsinχ.
  // Keep this narrow so prose words such as "using" cannot enter the grammar.
  if (!startsWithMathFunction(value)) {
    if (raw.length > 4 || value.length < 2 || !startsWithMathFunction(value.slice(1))) {
      return null;
    }
    value = value.slice(1);
  }

  while (value) {
    const fn = startsWithMathFunction(value);
    if (!fn) return null;
    // ``mod`` is also a very common prose prefix (model, mode, modern).  Accept
    // the operator only as the exact standalone token; glued trigonometric
    // functions retain the narrow variable grammar below.
    if (fn === "mod" && value !== "mod") return null;
    functionCount += 1;
    functions.push(fn);
    value = value.slice(fn.length);
    if (!value) return functions;
    if (startsWithMathFunction(value)) continue;

    // Consume one variable between two function factors.
    if (value.length >= 2 && startsWithMathFunction(value.slice(1))) {
      value = value.slice(1);
      continue;
    }
    // In printed formulae a function argument commonly contains a two-variable
    // product without a space (cos kx -> coskx). Prose stopwords are excluded by
    // the callers, and longer suffixes still fail this deliberately small grammar.
    const maximumTrailingVariables = 2;
    return value.length <= maximumTrailingVariables ? functions : null;
  }
  return functionCount > 0 ? functions : null;
}

function looksLikeGluedMathIdentifier(rawToken) {
  return Boolean(parseGluedMathIdentifier(rawToken)?.length);
}

function looksLikeUnitsOrFormulaOnly(text) {
  const value = maskAllowedEnglishRegions(text).trim();
  if (!value) return true;
  const tokens = englishTokens(value);
  if (!tokens.length) return true;
  const hasFormulaSyntax = /[=+*/^<>±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌Α-Ωα-ωϑϕϱ϶ϰ′″°]|<\/?(?:sub|sup)>/i.test(
    String(text || ""),
  );
  return tokens.every(({ raw, value: token }) =>
    UNIT_WORDS.has(token) || isRomanNumeralToken(raw) || raw === raw.toUpperCase() || raw.length === 1 ||
    (hasFormulaSyntax && (
      (!FORMULA_PROSE_STOPWORDS.has(token) && looksLikeGluedMathIdentifier(raw)) ||
      (raw === raw.toLowerCase() && raw.length <= 3 && !FORMULA_PROSE_STOPWORDS.has(token))
    )),
  );
}

function looksLikeCodeOnly(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/^```[\s\S]*```$/.test(value) || /^`[^`]*`$/.test(value)) return true;
  if (/^(?:npm|pnpm|yarn|pip|python3?|node|git|curl|wget|docker|kubectl|brew|sudo)\s+[-\w./:=@]+(?:\s+[-\w./:=@]+)*$/i.test(value)) return true;
  if (/^(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*[:=;]|\s*$)/.test(value)) return true;
  if (/^(?:def|class|function)\s+[A-Za-z_$][\w$]*(?:\s*\(|\s+(?:extends|implements)\b|\s*[:{]|\s*$)/i.test(value)) return true;
  if (/^import\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\s+as\s+[A-Za-z_$][\w$]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)*\s*;?$/i.test(value)) return true;
  if (/^from\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s+import\s+(?:\*|[A-Za-z_$][\w$]*(?:\s+as\s+[A-Za-z_$][\w$]*)?)(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*;?$/i.test(value)) return true;
  if (/^select\s+[\s\S]+\s+from\s+\S+/i.test(value)) return true;
  if (/^insert\s+into\s+\S+/i.test(value)) return true;
  if (/^update\s+\S+\s+set\s+\S+/i.test(value)) return true;
  if (/^[A-Za-z_$][\w$]*\s*(?:=|=>|==|!=|<=|>=)\s*\S+/.test(value)) return true;
  if (/[{};]\s*$/.test(value) && /[=_$.()]/.test(value)) return true;
  return false;
}

function containsTokenSequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Conservatively find source English prose that survived in the target. We intentionally do
 * not flag isolated lowercase words: they may be an identifier, unit, or proper noun. A match
 * requires either a lowercase hyphenated word or two adjacent lowercase words, and the same
 * token sequence must occur in the source. Parenthetical glosses and literal regions are masked.
 */
function findUntranslatedEnglishProse(sourceText, targetText) {
  if (looksLikeCodeOnly(sourceText) || looksLikeUnitsOrFormulaOnly(sourceText)) return [];
  const sourceScan = maskAllowedEnglishRegions(sourceText, sourceText);
  const targetScan = maskAllowedEnglishRegions(targetText, sourceText);
  const sourceValues = englishTokens(sourceScan).map((token) => token.value);
  const sourceValueSet = new Set(sourceValues);
  const targetTokens = englishTokens(targetScan);
  const targetValues = targetTokens.map((token) => token.value);
  const preservesArcSec =
    containsTokenSequence(sourceValues, ["arc", "sec"]) &&
    containsTokenSequence(targetValues, ["arc", "sec"]);
  const suspects = [];
  const seen = new Set();
  const inlineFormulaVariable = (token) => {
    if (token.raw.length !== 1) return false;
    const near = targetScan.slice(
      Math.max(0, token.start - 12),
      Math.min(targetScan.length, token.end + 12),
    );
    return /[=+*/^<>±×÷√∞∫∑∏∂∇≤≥≈≠≡−→←↔⇌]|<\/?(?:sub|sup)>/i.test(near);
  };
  const allowedLiteral = (token) =>
    isLiteralEnglishToken(token.raw, token.value) ||
    (
      SOURCE_EXACT_COMPACT_SCIENTIFIC_WORDS.has(token.value) &&
      sourceValueSet.has(token.value)
    ) || (token.value === "arc" && preservesArcSec);

  const add = (tokens, requireSource = true) => {
    const values = tokens.map((token) => token.value);
    if (requireSource && !containsTokenSequence(sourceValues, values)) return;
    const phrase = tokens.map((token) => token.raw).join(" ");
    const key = phrase.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      suspects.push(phrase);
    }
  };

  for (const token of targetTokens) {
    const lowercase = token.raw === token.raw.toLowerCase();
    if (
      SOURCE_EXACT_COMPACT_SCIENTIFIC_WORDS.has(token.value) &&
      !sourceValueSet.has(token.value)
    ) {
      add([token], false);
    }
    if (
      token.value === "arc" &&
      containsTokenSequence(targetValues, ["arc", "sec"]) &&
      !containsTokenSequence(sourceValues, ["arc", "sec"])
    ) {
      add([token], false);
    }
    if (
      lowercase &&
      token.value.includes("-") &&
      token.value.split("-").every((part) => part.length >= 2) &&
      !allowedLiteral(token)
    ) {
      add([token]);
    }
    if (
      !allowedLiteral(token) &&
      !/^[a-z]?(?:sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|log|ln|exp|lim|min|max|mod)$/i.test(token.value) &&
      ((lowercase && token.value.length >= 3) || COMMON_TRANSLATABLE_LABELS.has(token.value))
    ) {
      add([token], false);
    }
  }

  let run = [];
  const flush = () => {
    // Two or more ordinary lowercase words are prose even if the model invented
    // them rather than copying them from the source. Parenthetical glosses,
    // proper names, URLs and formula literals have already been masked.
    if (run.length >= 2) add(run, false);
    run = [];
  };
  for (const token of targetTokens) {
    const lowercase = token.raw === token.raw.toLowerCase();
    const allowed = allowedLiteral(token) || inlineFormulaVariable(token);
    const gap = run.length ? targetScan.slice(run[run.length - 1].end, token.start) : "";
    if (!lowercase || allowed || (run.length && !/^\s+$/.test(gap))) {
      flush();
    }
    if (lowercase && !allowed) run.push(token);
  }
  flush();
  const multiwordTokenSets = suspects
    .filter((phrase) => phrase.includes(" "))
    .map((phrase) => new Set(phrase.toLowerCase().split(/\s+/)));
  const properFollower = (phrase) => {
    if (phrase.includes(" ")) return false;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b([A-Z][A-Za-z]{1,})\\s+${escaped}\\b`, "g");
    let match;
    while ((match = re.exec(String(targetText || "")))) {
      if (String(sourceText || "").includes(match[0])) return true;
    }
    return false;
  };
  return suspects.filter((phrase) =>
    !properFollower(phrase) && (
      phrase.includes(" ") ||
      !multiwordTokenSets.some((tokens) => tokens.has(phrase.toLowerCase()))
    ),
  );
}

function responseReason(code, message, details = {}) {
  return { code, message, ...details };
}

function sourceEndsWithOpenFormulaIntroduction(sourceText) {
  const value = normalizeLatinCompatibilityLigatures(String(sourceText || "")).trim();
  if (!value || /[.!?…。？！]["'’”)]*$/.test(value)) return false;
  // The block schema does not yet expose a verified "next block is a displayed
  // formula" relation. Keep the reduced shortness floor bound to printed
  // introductions covered by real extraction fixtures; broad English ending
  // heuristics ("... is", "... we have") can hide a truncated long subject.
  return [
    /^and\s+the\s+altitude\s+at\s+the\s+lower\s+culmination\s+is$/i,
    /^for\s+the\s+corresponding\s+angular\s+relation\s+we\s+have:$/i,
    /^we\s+(?:now\s+)?define\s+that\s+the\s+product\s+of\s+(?:a|the)\s+matrix\s+and\s+(?:a|the)\s+column\s+vector$/i,
  ].some((pattern) => pattern.test(value));
}

function isSyntheticTableCellId(id) {
  return String(id || "").startsWith("__pdf_table_cell__:");
}

function conciseNominalLabelMinimum(block, targetText) {
  if (
    !block?.concise_structural_label &&
    !isSyntheticTableCellId(block?.id) &&
    !["heading", "outline", "metadata"].includes(block?.kind)
  ) {
    return null;
  }
  const sourceText = String(block?.text || "");
  const source = normalizeLatinCompatibilityLigatures(
    joinDiscretionaryLatinLineBreaks(sourceText),
  ).trim();
  if (!source || source.length > 60 || /[.!?…。？！:]\s*$/.test(source)) return null;
  const words = source.match(/[A-Za-z]+(?:-[A-Za-z]+)*/g) || [];
  if (words.length < 2 || words.length > 6) return null;
  if (/\b(?:am|is|are|was|were|be|been|being|has|have|had|do|does|did|define|defines|defined)\b/i.test(source)) {
    return null;
  }
  const visibleTarget = String(targetText || "")
    .replace(/<\/?(?:sub|sup)>/gi, "")
    .replace(/\s/g, "");
  const hangulCount = (visibleTarget.match(/[가-힣]/g) || []).length;
  const letterCount = (visibleTarget.match(/[\p{L}]/gu) || []).length;
  if (!letterCount || hangulCount / letterCount < 0.6) return null;
  const contentStopwords = new Set([
    "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
  ]);
  const sourceContentWords = words.filter(
    (word) => !contentStopwords.has(word.toLowerCase()),
  ).length;
  const targetHangulWords = String(targetText || "")
    .split(/\s+/)
    .filter((word) => /[가-힣]/.test(word))
    .length;
  if (sourceContentWords && targetHangulWords < sourceContentWords) return null;
  const sourceSemanticLength = source
    .replace(/<\/?(?:sub|sup)>/gi, "")
    .replace(/\s/g, "")
    .length;
  return Math.max(5, Math.floor(sourceSemanticLength * 0.18));
}

/** Deterministic response-stage validation; no model self-attestation is trusted. */
function validateTranslationCandidate(block, candidate) {
  const source = String(block?.text || "");
  const target = typeof candidate === "string"
    ? normalizeTranslationCandidateText(source, candidate)
    : "";
  const reasons = [];
  if (!target.trim()) {
    reasons.push(responseReason("missing_response", "번역 응답이 비어 있음"));
    return { ok: false, reasons };
  }

  if (!looksLikeCodeOnly(source) && !looksLikeUnitsOrFormulaOnly(source)) {
    const sourceSemanticLength = source
      .replace(/<\/?(?:sub|sup)>/gi, "")
      .replace(/\s/g, "")
      .length;
    const targetSemanticLength = target
      .replace(/<\/?(?:sub|sup)>/gi, "")
      .replace(/\s/g, "")
      .length;
    // A page-edge/formula-introduction fragment can legitimately translate to a
    // short Korean topic phrase (``... altitude ... is`` -> ``... 고도는``). Keep
    // the normal proportional floor everywhere else and never permit fewer than 8
    // semantic characters even for this narrow open-source form.
    const conciseLabelMinimum = conciseNominalLabelMinimum(block, target);
    const minimumTargetLength = sourceEndsWithOpenFormulaIntroduction(source)
      ? 8
      : conciseLabelMinimum ?? Math.max(8, Math.floor(sourceSemanticLength * 0.25));
    if (sourceSemanticLength >= 30 && targetSemanticLength < minimumTargetLength) {
      reasons.push(responseReason(
        "translation_too_short",
        "원문의 의미 요소가 누락된 것으로 보일 만큼 번역문이 지나치게 짧음",
        { sourceLength: sourceSemanticLength, targetLength: targetSemanticLength, minimumTargetLength },
      ));
    }
    const maximumTargetLength = Math.max(48, Math.ceil(sourceSemanticLength * 3));
    if (sourceSemanticLength > 0 && targetSemanticLength > maximumTargetLength) {
      reasons.push(responseReason(
        "translation_too_long",
        "번역문이 원문에 없는 설명·반복을 덧붙인 것으로 보일 만큼 지나치게 김",
        { sourceLength: sourceSemanticLength, targetLength: targetSemanticLength, maximumTargetLength },
      ));
    }
  }

  const sourceMarkup = extractScientificMarkup(source);
  const targetMarkup = extractScientificMarkup(target);
  if (
    !sameStringMultiset(sourceMarkup.tags, targetMarkup.tags) ||
    !sameStringMultiset(sourceMarkup.literals, targetMarkup.literals) ||
    !sameStringMultiset(sourceMarkup.atoms, targetMarkup.atoms) ||
    !sameStringArray(sourceMarkup.footnoteMarkers, targetMarkup.footnoteMarkers)
  ) {
    reasons.push(responseReason(
      "scientific_markup_changed",
      "<sub>/<sup> 태그, literal 또는 결합된 과학 토큰의 값·개수가 원문과 다름",
      { source: sourceMarkup, target: targetMarkup },
    ));
  }

  const sourceScientificLiterals = extractScientificLiterals(source);
  const targetScientificLiterals = extractScientificLiterals(target);
  if (!sameStringMultiset(sourceScientificLiterals, targetScientificLiterals)) {
    reasons.push(responseReason(
      "scientific_literals_changed",
      "보존해야 할 그리스 문자·수학 연산자·함수 literal이 원문과 다름",
      { source: sourceScientificLiterals, target: targetScientificLiterals },
    ));
  }

  const sourceNumbers = extractNumericTokens(source);
  const targetNumbers = extractNumericTokens(target);
  if (!numericTokensPreserved(source, target)) {
    reasons.push(responseReason(
      "preserved_numbers_changed",
      "보존해야 할 숫자의 값 또는 개수가 원문과 다름",
      { source: sourceNumbers, target: targetNumbers },
    ));
  }

  const sourceMeasurements = canonicalBoundTranslatedMeasurements(source, "source");
  const targetMeasurements = canonicalBoundTranslatedMeasurements(target, "target");
  if (!sameStringMultiset(sourceMeasurements, targetMeasurements)) {
    reasons.push(responseReason(
      "preserved_measurements_changed",
      "숫자와 번역 단위의 결합 또는 개수가 원문과 다름",
      { source: sourceMeasurements, target: targetMeasurements },
    ));
  }

  const sourceUrls = extractUrls(source);
  const targetUrls = extractUrls(target);
  if (!sameStringMultiset(sourceUrls, targetUrls)) {
    reasons.push(responseReason(
      "preserved_urls_changed",
      "보존해야 할 URL의 값 또는 개수가 원문과 다름",
      { source: sourceUrls, target: targetUrls },
    ));
  }

  const sourceBibliographyEntries = bibliographyCandidates(source);
  const targetBibliographyEntries = bibliographyCandidates(target);
  const sourceBibliography = sourceBibliographyEntries.map((entry) => entry.canonical);
  const targetBibliography = targetBibliographyEntries.map((entry) => entry.canonical);
  const sourceInlineCreditEntries = inlinePhotographerCreditCandidates(source);
  // Target-side credit-like Korean prose is relevant only when the source
  // actually established this narrow inline-credit context. This prevents an
  // ordinary translated sentence from creating a new preservation ledger.
  const targetInlineCreditEntries = sourceInlineCreditEntries.length
    ? inlinePhotographerCreditCandidates(target)
    : [];
  const sourceInlineCredits = sourceInlineCreditEntries.map((entry) => entry.canonical);
  const targetInlineCredits = targetInlineCreditEntries.map((entry) => entry.canonical);
  if (
    !sameStringMultiset(sourceBibliography, targetBibliography) ||
    !sameStringMultiset(sourceInlineCredits, targetInlineCredits)
  ) {
    reasons.push(responseReason(
      "preserved_bibliography_changed",
      "서지 인용의 저자·연도·서명·출판 정보가 원문과 다름",
      {
        source: [
          ...sourceBibliographyEntries.map((entry) => entry.value),
          ...sourceInlineCreditEntries.map((entry) => entry.value),
        ],
        target: [
          ...targetBibliographyEntries.map((entry) => entry.value),
          ...targetInlineCreditEntries.map((entry) => entry.value),
        ],
      },
    ));
  }

  const unsupportedCodePoints = findUnsupportedTargetCodePoints(source, target);
  if (unsupportedCodePoints.length) {
    reasons.push(responseReason(
      "unsupported_target_characters",
      `지원하지 않거나 원문에 없던 문자 코드포인트 포함: ${unsupportedCodePoints.join(", ")}`,
      { codePoints: unsupportedCodePoints },
    ));
  }

  const untranslated = findUntranslatedEnglishProse(source, target);
  if (untranslated.length) {
    reasons.push(responseReason(
      "untranslated_english_prose",
      `괄호·코드 밖에 미번역 영어 prose가 남음: ${untranslated.join(", ")}`,
      { phrases: untranslated },
    ));
  }
  return { ok: reasons.length === 0, reasons };
}

function validateTranslationMap(blocks, map) {
  const sourceMap = isPlainObject(map) ? map : {};
  const normalizedMap = {};
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id);
    normalizedMap[id] = normalizeTranslationCandidateText(
      block?.text,
      sourceMap[id],
    );
  }

  // Korean word order can move a predicate across two true page-continuation IDs.
  // Permit an individually short member only when every member is nontrivial and
  // the joined translation still meets the unchanged proportional completeness
  // floor. Number, markup, script, URL, and English-prose checks remain per-ID.
  const groupShortnessExemptIds = new Set();
  for (const members of pageContinuationGroups(blocks).values()) {
    const memberTargets = members.map((block) => normalizedMap[String(block.id)]);
    if (memberTargets.some((target) => typeof target !== "string" || !target.trim())) continue;
    const memberTargetLengths = memberTargets.map((target) =>
      target.replace(/<\/?(?:sub|sup)>/gi, "").replace(/\s/g, "").length,
    );
    if (memberTargetLengths.some((length) => length < 8)) continue;
    const joinedSourceLength = members
      .map((block) => String(block?.text || ""))
      .join("")
      .replace(/<\/?(?:sub|sup)>/gi, "")
      .replace(/\s/g, "")
      .length;
    const joinedTargetLength = memberTargetLengths.reduce((sum, length) => sum + length, 0);
    const joinedMinimum = Math.max(8, Math.floor(joinedSourceLength * 0.25));
    if (joinedSourceLength >= 30 && joinedTargetLength < joinedMinimum) continue;
    for (const member of members) groupShortnessExemptIds.add(String(member.id));
  }

  const accepted = {};
  const rejected = {};
  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id);
    // Compatibility ligatures are typography, not semantic model output. Expand
    // them before every deterministic check and retain only the render-safe ASCII
    // candidate. Source text is intentionally untouched.
    const candidate = normalizedMap[id];
    const result = validateTranslationCandidate(block, candidate);
    const reasons = groupShortnessExemptIds.has(id)
      ? result.reasons.filter((reason) => reason.code !== "translation_too_short")
      : result.reasons;
    if (!reasons.length) accepted[id] = candidate;
    else rejected[id] = { candidate: typeof candidate === "string" ? candidate : null, reasons };
  }
  return { accepted, rejected };
}

// 모델 제공자 추상화. GPT(OpenAI) 면 chat/completions(OpenAI 호환, fetch), 그 외는
// Claude(Anthropic SDK). 반환을 {text, usage} 로 통일하고 usage 는 Anthropic 형식
// (input/output/cache_read/cache_creation)으로 맞춰 calcCost 가 그대로 쓰게 한다.
function makeCaller(model) {
  if (isGptModel(model)) {
    const base = process.env.GPT_API_BASE || "https://api.openai.com/v1";
    const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
    if (!key) {
      throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
    }
    return async ({ system, user, maxTokens, signal }) => {
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          // gpt-5.x 계열은 max_completion_tokens 사용. JSON 강제로 펜스/설명 누락 방지.
          max_completion_tokens: Math.min(maxTokens, 32000),
          response_format: { type: "json_object" },
        }),
        signal,
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        throw new Error(`OpenAI ${resp.status}: ${t.slice(0, 200)}`);
      }
      // 빈/비-JSON 응답이면 "Unexpected end of JSON input" 대신 분명한 메시지로.
      const rawBody = await resp.text();
      let j;
      try {
        j = JSON.parse(rawBody);
      } catch {
        throw new Error(
          `OpenAI 응답을 해석할 수 없습니다(status ${resp.status}, ${rawBody.length}바이트)${rawBody ? ": " + rawBody.slice(0, 160) : " — 빈 응답"}`,
        );
      }
      const text = j.choices?.[0]?.message?.content || "";
      const u = j.usage || {};
      const cached = u.prompt_tokens_details?.cached_tokens || 0;
      return {
        text,
        usage: {
          input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
          output_tokens: u.completion_tokens || 0,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 0, // OpenAI 는 캐시 write 비용 없음
        },
      };
    };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 /* Fable 등 장시간 스트림 — 작업 타임아웃(45분)보다 길게 */ });
  return async ({ system, user, maxTokens, signal }) => {
    const message = await client.messages.create(
      {
        model,
        max_tokens: Math.min(maxTokens, 32000),
        // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
        ...(/fable/i.test(model || "") ? {} : { thinking: { type: "disabled" } }),
        system: [
          // 정적 시스템 프롬프트 → 5분 ephemeral 캐시로 묶음 간 입력 비용 절감.
          { type: "text", text: system, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: user }],
      },
      signal ? { signal } : undefined,
    );
    const text = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return { text, usage: message.usage };
  };
}

async function translateBatch(
  caller,
  blocks,
  signal,
  { rejectionReasons = {} } = {},
) {
  const items = blocks.map((block) => {
    const item = { id: block.id, text: block.text };
    if (block.continuation_group) {
      item.continuation_group = block.continuation_group;
      item.continuation_role = block.continuation_role;
      item.continuation_index = block.continuation_index;
      item.continuation_count = block.continuation_count;
      item.joined_source = block.joined_source;
    }
    return item;
  });
  const correctionLines = blocks
    .map((block) => {
      const reasons = rejectionReasons[String(block.id)];
      if (!Array.isArray(reasons) || !reasons.length) return null;
      const formatted = reasons.map((reason) => {
        const message = reason.message || reason.code || String(reason);
        if (reason.code === "translation_too_long") {
          return `${message} (source semantic length: ${reason.sourceLength}; ` +
            `rejected target semantic length: ${reason.targetLength}; ` +
            `maximum target length: ${reason.maximumTargetLength})`;
        }
        if (reason.code === "preserved_bibliography_changed") {
          const source = Array.isArray(reason.source) ? reason.source : [];
          const target = Array.isArray(reason.target) ? reason.target : [];
          return `${message} (source credit/citation ledgers: ${JSON.stringify(source)}; ` +
            `rejected target ledgers: ${JSON.stringify(target)})`;
        }
        if (reason.code !== "preserved_numbers_changed") return message;
        const source = Array.isArray(reason.source) ? reason.source : [];
        const target = Array.isArray(reason.target) ? reason.target : [];
        return `${message} (source numeric literals: ${JSON.stringify(source)}; ` +
          `rejected target numeric literals: ${JSON.stringify(target)})`;
      });
      return `- ID ${String(block.id)}: ${formatted.join("; ")}`;
    })
    .filter(Boolean);
  const corrective = correctionLines.length
    ? [
        "This is a targeted correction retry. The previous answers below were rejected by deterministic validation.",
        "Produce fresh corrected translations; do not repeat the rejected wording.",
        "If a rejection names untranslated English prose, translate that exact phrase everywhere outside an allowed first-occurrence parenthetical gloss. Translate generic facility and attribution prose too: write 'Chandra X-ray observatory' as 'Chandra X-ray 천문대' and 'photograph by David R. Malin' as 'David R. Malin 촬영', while preserving any proper-name body explicitly listed as a source credit ledger. A fully spelled unit name is not a protected unit symbol: write 'nautical mile' as '해리' and 'electron volts' as '전자볼트', including in equations; keep only compact symbols such as m and eV unchanged.",
        "If a rejection says numbers changed, preserve each literal number with exactly the same occurrence count as the source. The only scale exception is an exact Korean rendering of an attached million/billion/trillion quantity (for example 18 million → 1,800만 and 500 million → 5억); never leave the scale word in English or change the quantity. Do not repeat a number in both a Korean translated term and its parenthetical English gloss; keep a numbered proper name once.",
        "If a rejection says a measurement changed, keep each number attached to its original unit and preserve the exact number of measurements; never swap values between micrograms and grams.",
        "If a rejection says a credit or citation changed, preserve every Latin author/organisation credit body exactly after joining printed discretionary line-break hyphens. Translate only its attribution wrapper (Photo/Photos/Drawing/Graphics); do not translate 'and' or 'for', alter punctuation, reorder names, or add/drop a credit.",
        "If a rejection says the translation is too long, translate the complete source once and concisely. Remove duplicated wording, glosses, commentary, and explanations that are not in the source, and stay within the reported maximum target length.",
        "While correcting only these IDs, keep terminology, domain meaning, and Korean ending style consistent with the surrounding document context.",
        ...correctionLines,
        "",
      ].join("\n")
    : "";
  const user =
    corrective +
    "Translate the following segments to Korean. Return only the JSON object described.\n\n" +
    JSON.stringify(items, null, 0);

  // 출력이 잘리면 JSON 파싱 실패로 묶음 전체가 누락된다. 입력 길이에 맞춰 출력 한도를
  // 키운다(실제 출력 토큰만 과금되므로 비용 영향 없음).
  const inputChars = items.reduce((s, it) => s + (it.text || "").length, 0);
  const maxTokens = Math.min(32000, Math.max(8000, Math.ceil(inputChars * 2.5)));

  const { text, usage } = await caller({
    system: SYSTEM_PROMPT,
    user,
    maxTokens,
    signal,
  });

  // {"t":{id:ko}} 가 정상. 모델이 {id:ko} 를 바로 주면 그것도 받되, 배열 등 예상 외
  // 형태는 무시. 펜스/앞뒤 설명이 붙어도 JSON 범위만 추출(누락 주원인 방어).
  let map = {};
  try {
    const parsed = parseJsonLenient(extractJsonText(text));
    if (isPlainObject(parsed) && isPlainObject(parsed.t)) map = parsed.t;
    else if (isPlainObject(parsed)) map = parsed;
  } catch {
    map = {};
  }
  return { map, usage };
}

// 모델 응답에서 JSON 만 뽑는다: ```json 펜스 → 펜스 내부, 아니면 첫 '{'~마지막 '}'.
function extractJsonText(text) {
  const s = String(text || "");
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first !== -1 && last > first) return body.slice(first, last + 1).trim();
  return body.trim();
}

// 작업 내부 동시성 게이트. 프로세스 전체 상한은 resource-gate의 별도 FIFO 세마포어가
// 담당하며, 이 게이트는 한 작업/대형 문서 내부의 기존 상한과 진행률 동작을 유지한다.
function makeGate(max) {
  const semaphore = createFifoSemaphore(max);
  const gate = (fn, options) => semaphore.run(fn, options);
  gate.stats = () => semaphore.stats();
  return gate;
}

// 묶음 번역 진행률 집계기. 단일 PDF 면 자체적으로, 분할 PDF 면 모든 구간이 같은 집계기를
// 공유해 "(done/total 묶음)" 한 줄로 합산 표시한다(병렬 로그 난잡 방지).
function makeBatchProgress(onProgress, label = "🌐 번역 중...") {
  let total = 0;
  let done = 0;
  let last = "";
  const emit = () => {
    if (!total) return;
    const line = `${label} (${done}/${total} 묶음)`;
    if (line !== last) {
      last = line;
      onProgress(line);
    }
  };
  return {
    addTotal(n) {
      total += n;
      emit();
    },
    tick() {
      done += 1;
      emit();
    },
  };
}

function emptyTranslationUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function buildTranslationReusePlan(blocks) {
  const pending = [];
  const direct = {};
  const aliases = new Map();
  const canonicalIdByText = new Map();
  const canonicalBlockById = new Map();
  let koreanCount = 0;
  let duplicateCount = 0;

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id);
    const text = String(block?.text || "");
    // MuPDF can expose ordinary source words as presentation-form ligatures
    // (``ﬂattening``). Use an ASCII view only for language classification so
    // prose cannot be mistaken for a formula. Any proven formula identity still
    // stores the exact original string below for source-glyph preservation.
    const classificationText = normalizeLatinCompatibilityLigatures(text);

    // 시스템 프롬프트도 이미 한국어 구간은 그대로 반환하도록 요구한다. 모델을
    // 왕복하지 않고 같은 문자열을 넣으면 의미·숫자·수식이 byte-for-byte 보존된다.
    const hangulCount = (classificationText.match(/[\uac00-\ud7a3]/g) || []).length;
    const latinCount = (classificationText.match(/[A-Za-z]/g) || []).length;
    const koreanDominant = hangulCount > 0 && hangulCount / (hangulCount + latinCount) >= 0.7;
    if (koreanDominant && validateTranslationCandidate(block, text).ok) {
      direct[id] = text;
      koreanCount += 1;
      continue;
    }

    // Pure formulas, units and code have no natural language to translate.  A
    // model round-trip can only damage their literals, and historic PDFs often
    // expose visually correct glyphs through a garbled Unicode map.  Returning
    // the exact source string lets the renderer keep the original glyph stream.
    if (
      (looksLikeCodeOnly(classificationText) || looksLikeUnitsOrFormulaOnly(classificationText)) &&
      validateTranslationCandidate(block, text).ok
    ) {
      direct[id] = text;
      continue;
    }

    // 같은 문서의 반복 머리글·꼬리글·섹션명은 한 번만 번역한다. exact text만
    // 묶으므로 문맥이 다른 유사 문장은 합치지 않으며, 결과는 모든 원래 ID로 복제한다.
    const reuseKey = `${String(block?.kind || "page")}\u0000${text}`;
    const canReuseDuplicate = !block?.continuation_group && text.trim().length >= 12;
    const canonicalId = canReuseDuplicate ? canonicalIdByText.get(reuseKey) : null;
    if (canonicalId != null) {
      if (isSyntheticTableCellId(id) || isSyntheticTableCellId(canonicalId)) {
        const canonicalBlock = canonicalBlockById.get(canonicalId);
        if (canonicalBlock) canonicalBlock.concise_structural_label = true;
      }
      if (!aliases.has(canonicalId)) aliases.set(canonicalId, []);
      aliases.get(canonicalId).push(id);
      duplicateCount += 1;
      continue;
    }

    if (canReuseDuplicate) {
      canonicalIdByText.set(reuseKey, id);
      canonicalBlockById.set(id, block);
    }
    pending.push(block);
  }

  return { pending, direct, aliases, koreanCount, duplicateCount };
}

function isPageContinuationProse(block) {
  if (!block || !Number.isInteger(block.page)) return false;
  if (["outline", "metadata"].includes(block.kind)) return false;
  const text = String(block.text || "").trim();
  if (text.length < 40 || !/[A-Za-z]{3,}/.test(text)) return false;
  if (/^(?:https?|mailto):/i.test(text)) return false;
  // Figure/table captions are often the last extracted text object on a page
  // even when the body column continues on the next page. A caption without a
  // printed full stop must never displace that real body head and become a
  // synthetic cross-page sentence (e.g. Fig. 11.3 paired with "only becomes").
  if (/^(?:fig(?:ure)?\.?|table|box)\s*\d/i.test(text)) return false;
  return !looksLikeCodeOnly(text) && !looksLikeUnitsOrFormulaOnly(text);
}

// Detect one logical sentence split across adjacent PDF pages. The annotation is
// source-bound metadata only: it never joins IDs or changes text sent to the renderer.
function annotatePageContinuations(blocks) {
  const annotated = (Array.isArray(blocks) ? blocks : []).map((block) => {
    const clone = { ...block };
    delete clone.continuation_group;
    delete clone.continuation_role;
    delete clone.continuation_index;
    delete clone.continuation_count;
    delete clone.joined_source;
    return clone;
  });
  const sourceOrder = new Map(annotated.map((block, index) => [block, index]));
  const byPage = new Map();
  for (const block of annotated) {
    if (!isPageContinuationProse(block)) continue;
    if (!byPage.has(block.page)) byPage.set(block.page, []);
    byPage.get(block.page).push(block);
  }
  const edges = [];
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  for (const page of pages) {
    const nextPage = page + 1;
    if (!byPage.has(nextPage)) continue;
    const head = byPage.get(page).at(-1);
    const tail = byPage.get(nextPage)[0];
    const headText = String(head.text || "").trim();
    const tailText = String(tail.text || "").trim();
    if (/[.!?…。？！]["'’”)\]]*$/.test(headText)) continue;
    if (!/^["'‘“(]*[a-z]/.test(tailText)) continue;
    edges.push([head, tail]);
  }

  // A page can contain one long block that is both the tail of the previous page
  // and the head of the next. Build connected components instead of overwriting
  // that block's first pair annotation with the second one.
  const adjacent = new Map();
  const connect = (left, right) => {
    if (!adjacent.has(left)) adjacent.set(left, new Set());
    adjacent.get(left).add(right);
  };
  for (const [head, tail] of edges) {
    connect(head, tail);
    connect(tail, head);
  }
  const visited = new Set();
  for (const start of adjacent.keys()) {
    if (visited.has(start)) continue;
    const members = [];
    const stack = [start];
    visited.add(start);
    while (stack.length) {
      const member = stack.pop();
      members.push(member);
      for (const next of adjacent.get(member) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    members.sort(
      (a, b) => (a.page - b.page) || (sourceOrder.get(a) - sourceOrder.get(b)),
    );
    const group = members.map((member) => String(member.id)).join(">");
    const joinedSource = members
      .map((member) => String(member.text || "").trim())
      .join(" ⟂ ");
    members.forEach((member, index) => Object.assign(member, {
      continuation_group: group,
      continuation_role:
        index === 0 ? "head" : (index === members.length - 1 ? "tail" : "middle"),
      continuation_index: index,
      continuation_count: members.length,
      joined_source: joinedSource,
    }));
  }
  return annotated;
}

function pageContinuationGroups(blocks) {
  const groups = new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block?.continuation_group) continue;
    const key = String(block.continuation_group);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(block);
  }
  for (const members of groups.values()) {
    members.sort((a, b) => {
      const aIndex = Number.isInteger(a.continuation_index)
        ? a.continuation_index
        : (a.continuation_role === "head" ? -1 : Number.MAX_SAFE_INTEGER);
      const bIndex = Number.isInteger(b.continuation_index)
        ? b.continuation_index
        : (b.continuation_role === "head" ? -1 : Number.MAX_SAFE_INTEGER);
      return aIndex - bIndex;
    });
  }
  return groups;
}

function pageContinuationIssue(members, translations) {
  if (!Array.isArray(members) || members.length < 2) return null;
  const targets = members.map((block) => translations[String(block.id)]);
  if (targets.some((target) => typeof target !== "string" || !target.trim())) {
    return responseReason(
      "page_continuation_incomplete",
      "페이지 경계의 연속 문장 ID를 하나의 그룹으로 완성하지 못함",
    );
  }
  for (let index = 0; index < targets.length - 1; index += 1) {
    const headValue = targets[index].trim();
    const tailValue = targets[index + 1].trim();
    const independentlyFinishedHead =
      /(?:했다|하였다|되었다|이었다|이다|한다|된다|있다|없다|였다|았다|었다|[가-힣]습니다)[.!?。？！]?$/.test(headValue);
    const firstTailClause = tailValue.split(/[.!?。？！]/, 1)[0].trim();
    const particleOnlyTail =
      /(?:을|를|이|가|은|는|에|의|과|와|도|만|까지|부터|에서|에게|께|보다|처럼|마다|조차|마저|로|으로)$/.test(firstTailClause);
    const openFormulaIntroTail = sourceEndsWithOpenFormulaIntroduction(
      members[index + 1]?.text,
    );
    if (
      !independentlyFinishedHead &&
      (!particleOnlyTail || openFormulaIntroTail)
    ) continue;
    return responseReason(
      "page_continuation_broken",
      "페이지 경계 연속 문장의 중간 ID를 독립 종결하거나 다음 ID를 조사만 남은 조각으로 번역함 — 그룹 전체를 한 문맥으로 다시 번역할 것",
    );
  }
  return null;
}

function findAllowedPreservedOriginalIds(blocks, translations) {
  const map = translations && typeof translations === "object" ? translations : {};
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => {
      // Reader-UI outline/metadata entries are handled by the virtual translator,
      // never by the page-content glyph-preservation path.
      if (block?.kind === "outline" || block?.kind === "metadata") return false;
      const source = String(block?.text || "");
      const target = map[String(block?.id)];
      return (
        typeof target === "string" &&
        target === source &&
        (looksLikeCodeOnly(source) || looksLikeUnitsOrFormulaOnly(source))
      );
    })
    .map((block) => String(block.id));
}

/**
 * Translate and deterministically validate text blocks before they can reach the renderer.
 * Invalid answers are deliberately not inserted into translations, so the existing missing-id
 * retry and final assertCompleteTranslations gate remain fail-closed.
 */
async function translateBlocksWithRetries({
  blocks,
  caller,
  gate = (fn) => Promise.resolve().then(fn),
  progress = { addTotal() {}, tick() {} },
  onProgress = () => {},
  signal,
  verbose = true,
  batchChars = BATCH_CHARS,
  batchPages = null,
  retrySizes = RESPONSE_RETRY_SIZES,
  context = "PDF 빠른 번역",
  resourceLimits = getProcessWidePdfTranslateResourceLimits(),
}) {
  const sourceBlocks = annotatePageContinuations(
    Array.isArray(blocks) ? blocks : [],
  );
  const reuse = buildTranslationReusePlan(sourceBlocks);
  const modelBlocks = reuse.pending;
  const translations = { ...reuse.direct };
  const usageSum = emptyTranslationUsage();
  const rejectionReasons = {};
  const lastRejectedCandidate = {};

  const addUsage = (usage) => {
    if (!usage) return;
    usageSum.input_tokens += usage.input_tokens || 0;
    usageSum.output_tokens += usage.output_tokens || 0;
    usageSum.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
    usageSum.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  };

  const mergeValidatedResult = (batch, map, usage) => {
    addUsage(usage);
    const { accepted, rejected } = validateTranslationMap(batch, map);
    for (const [id, candidate] of Object.entries(accepted)) {
      translations[id] = candidate;
      delete rejectionReasons[id];
      delete lastRejectedCandidate[id];
    }
    for (const [id, rejection] of Object.entries(rejected)) {
      const reasons = rejection.reasons.slice();
      if (
        rejection.candidate != null &&
        Object.prototype.hasOwnProperty.call(lastRejectedCandidate, id) &&
        rejection.candidate === lastRejectedCandidate[id]
      ) {
        reasons.push(responseReason(
          "repeated_rejected_answer",
          "이전 품질 거부 응답을 그대로 반복함 — 다른 자연스러운 한국어로 다시 번역할 것",
        ));
      }
      rejectionReasons[id] = reasons;
      if (rejection.candidate != null) lastRejectedCandidate[id] = rejection.candidate;
    }
    return Object.keys(rejected).length;
  };

  const enforceContinuationPairs = () => {
    let invalidated = 0;
    for (const members of pageContinuationGroups(sourceBlocks).values()) {
      const issue = pageContinuationIssue(members, translations);
      if (!issue) continue;
      for (const block of members) {
        const id = String(block.id);
        const candidate = translations[id];
        if (typeof candidate === "string" && candidate.trim()) {
          lastRejectedCandidate[id] = candidate;
        }
        if (Object.prototype.hasOwnProperty.call(translations, id)) {
          delete translations[id];
          invalidated += 1;
        }
        const prior = Array.isArray(rejectionReasons[id])
          ? rejectionReasons[id].filter((reason) =>
              !["page_continuation_incomplete", "page_continuation_broken"].includes(reason.code),
            )
          : [];
        rejectionReasons[id] = [...prior, issue];
      }
    }
    return invalidated;
  };

  const runBatches = async (batchList) => {
    progress.addTotal(batchList.length);
    await Promise.all(
      batchList.map((batch) =>
        gate(
          () => resourceLimits.runApi(async () => {
            if (signal?.aborted) return;
            try {
              const { map, usage } = await translateBatch(caller, batch, signal, {
                rejectionReasons,
              });
              const rejectedCount = mergeValidatedResult(batch, map, usage);
              if (rejectedCount && verbose) {
                onProgress(`⚠ 응답 품질 검증에서 ${rejectedCount}개 문단 거부 — 해당 문단만 다시 번역합니다.`);
              }
            } catch (e) {
              // An API/parse failure and a rejected answer both remain absent from translations;
              // the same bounded targeted retry schedule handles them without accepting partials.
              if (!signal?.aborted) {
                onProgress("⚠ 묶음 실패 — 누락/품질 미통과 문단 재시도에서 다시 시도");
              }
            }
            progress.tick();
          }, { signal }),
          { signal },
        ),
      ),
    );
    const continuationInvalidated = enforceContinuationPairs();
    if (continuationInvalidated && verbose) {
      onProgress(
        `⚠ 페이지 경계 연속 문장 ${continuationInvalidated}개 ID 거부 — 쌍으로 다시 번역합니다.`,
      );
    }
    if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
  };

  if (verbose && (reuse.koreanCount || reuse.duplicateCount)) {
    onProgress(
      `♻️ 모델 호출 절약 — 기존 한국어 ${reuse.koreanCount}개, 동일 반복 구간 ${reuse.duplicateCount}개 재사용`,
    );
  }

  await runBatches(buildBatches(modelBlocks, batchChars, BATCH_IDS, batchPages));

  let pendingBlocks = modelBlocks.filter(
    (block) => !translations[String(block.id)],
  );
  for (const size of Array.from(retrySizes || [])) {
    if (!pendingBlocks.length) break;
    if (verbose) onProgress(`🔁 누락/품질 미통과 ${pendingBlocks.length}개 문단 재번역 시도...`);
    await runBatches(buildBatches(pendingBlocks, size, BATCH_IDS, batchPages));
    pendingBlocks = modelBlocks.filter(
      (block) => !translations[String(block.id)],
    );
  }

  // 정식 번역·품질 검증을 통과한 canonical 결과만 반복 ID에 복제한다. canonical이
  // 실패했다면 alias도 비워 둬 아래 completeness gate가 문서 전체를 fail-closed한다.
  for (const [canonicalId, aliasIds] of reuse.aliases.entries()) {
    const translated = translations[canonicalId];
    if (typeof translated !== "string" || !translated.trim()) continue;
    for (const aliasId of aliasIds) translations[aliasId] = translated;
  }
  enforceContinuationPairs();

  // Invalid responses were never merged, so exhausting retries turns them into deterministic
  // missing IDs and reuses the shared fail-closed contract instead of rendering source prose.
  assertCompleteTranslations(sourceBlocks, translations, { context });
  return {
    translations,
    usage: usageSum,
    rejectionReasons,
    reuse: {
      korean: reuse.koreanCount,
      duplicates: reuse.duplicateCount,
      modelBlocks: modelBlocks.length,
    },
  };
}

// 단일 PDF(또는 한 페이지 구간)를 한국어로 통번역한다. caller·gate·progress 를 외부에서
// 주입받아 여러 구간이 동시성·진행률을 공유하게 한다. cost 가 아닌 usage 를 돌려주어
// 호출부가 구간별 usage 를 합산한 뒤 한 번에 비용을 계산한다.
async function translateSinglePdf(options = {}) {
  const resourceLimits =
    options.resourceLimits || getProcessWidePdfTranslateResourceLimits();
  return resourceLimits.runDocument(
    () => translateSinglePdfWithinDocumentPermit({
      ...options,
      resourceLimits,
    }),
    { signal: options.signal },
  );
}

async function translateSinglePdfWithinDocumentPermit({
  pdfBuffer,
  caller,
  gate,
  progress,
  onProgress = () => {},
  signal,
  verbose = true,
  allowBlankPassThrough = false,
  resourceLimits,
  pdfTool = tool,
  retrySizes,
  batchChars,
  batchPages,
  captureDocumentModel = false,
}) {
  const base = path.join(
    os.tmpdir(),
    `pdftr-${crypto.randomBytes(8).toString("hex")}`,
  );
  const inPath = `${base}.pdf`;
  const outPath = `${base}.ko.pdf`;
  fs.writeFileSync(inPath, pdfBuffer);

  try {
    const {
      page_count,
      scanned,
      truly_blank: trulyBlank,
      blocks,
      page_block_count,
      fig_regions,
      fitz,
    } = await pdfTool.extractBlocks(inPath, { signal });
    // 진단: 그림 영역 감지 여부 + PDF 엔진 버전(로컬과 동작 비교용). 분할 구간에선 생략.
    if (verbose) {
      onProgress(
        `🔍 그림 영역 ${fig_regions ?? "?"}개 감지 · PDF엔진 ${fitz ?? "?"}`,
      );
    }

    const pageBlockCount = Number.isInteger(page_block_count)
      ? page_block_count
      : blocks.filter((block) => !["outline", "metadata"].includes(block?.kind)).length;
    if (!pageBlockCount) {
      // A split chunk may consist only of genuinely blank separator pages.  It is
      // safe to carry that chunk through unchanged, but never use the coarse
      // low-text/scanned hint for this decision: raster/vector content still needs
      // OCR or an explicit fail-closed route.
      if (allowBlankPassThrough && trulyBlank === true && !blocks.length) {
        return {
          buffer: Buffer.from(pdfBuffer),
          usage: emptyUsage(),
          pageCount: page_count,
          scanned: false,
          blockCount: 0,
          missing: 0,
          stats: emptyRenderStats(),
          ...(captureDocumentModel
            ? {
                documentModel: {
                  schema_version: 1,
                  source_sha256: crypto
                    .createHash("sha256")
                    .update(pdfBuffer)
                    .digest("hex"),
                  page_count,
                  blocks: [],
                  translations: {},
                },
              }
            : {}),
        };
      }
      // A truly blank page may still have reader-visible outline/metadata virtual
      // blocks in the non-split path.  Translate those instead of misclassifying
      // the document as a scanned page.
      if (scanned && trulyBlank !== true) {
        throw new Error(
          "추출 가능한 텍스트가 없습니다. 스캔본(글자가 이미지인 PDF)으로 보입니다 — 현재 버전은 텍스트 레이어가 있는 PDF만 지원합니다(OCR 미지원).",
        );
      }
      if (!blocks.length) throw new Error("번역할 텍스트를 찾지 못했습니다.");
    }
    if (scanned && verbose) {
      onProgress(
        "⚠ 텍스트가 매우 적습니다 — 일부가 스캔 이미지일 수 있어 그 부분은 번역되지 않습니다.",
      );
    }
    if (verbose) onProgress(`✓ ${page_count}쪽, 번역 대상 ${blocks.length}개 구간`);

    const { translations, usage: usageSum } = await translateBlocksWithRetries({
      blocks,
      caller,
      gate,
      progress,
      onProgress,
      signal,
      verbose,
      context: "PDF 빠른 번역",
      resourceLimits,
      retrySizes,
      batchChars,
      batchPages,
    });
    const missing = 0;

    if (verbose) onProgress("🖋 번역문을 원본 레이아웃에 삽입 중...");
    const stats = await pdfTool.renderTranslated(
      inPath,
      outPath,
      FONT_PATH,
      translations,
      { signal },
    );
    assertCompleteRender(stats, blocks.length, {
      context: "PDF 빠른 번역 렌더링",
      allowedPreservedOriginalIds: findAllowedPreservedOriginalIds(
        blocks,
        translations,
      ),
    });
    const buffer = fs.readFileSync(outPath);
    if (verbose) {
      const preserved = Number(stats.preserved_original) || 0;
      onProgress(
        `✓ 레이아웃 삽입 완료 (교체 ${stats.replaced}곳` +
          `${preserved ? `, 원본 수식 보존 ${preserved}곳` : ""}` +
          `${stats.shrunk ? `, 자동 축소 ${stats.shrunk}곳` : ""})`,
      );
    }

    return {
      buffer,
      usage: usageSum,
      pageCount: page_count,
      scanned: !!scanned,
      blockCount: blocks.length,
      missing,
      stats,
      ...(captureDocumentModel
        ? {
            // Renderer-neutral, hash-bound capture for later DOCX/ODT/Writer
            // output. It is opt-in because large books can carry thousands of
            // blocks; normal web requests do not need to retain this map after
            // the PDF has been rendered.
            documentModel: {
              schema_version: 1,
              source_sha256: crypto
                .createHash("sha256")
                .update(pdfBuffer)
                .digest("hex"),
              page_count,
              blocks: blocks.map((block) => ({
                id: block.id,
                page: block.page,
                text: block.text,
                ...(block.kind ? { kind: block.kind } : {}),
              })),
              translations: { ...translations },
            },
          }
        : {}),
    };
  } finally {
    for (const p of [inPath, outPath]) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// PDF 페이지 수만 빠르게 확인(분할/상한 판단용). 호출부가 이미 알면 이 함수는 건너뛴다.
async function peekPageCount(pdfBuffer, signal) {
  const p = path.join(
    os.tmpdir(),
    `pdfpk-${crypto.randomBytes(6).toString("hex")}.pdf`,
  );
  fs.writeFileSync(p, pdfBuffer);
  try {
    const meta = await tool.analyzePdf(p, { signal });
    return Math.max(0, Number(meta.page_count) || 0);
  } finally {
    try {
      fs.unlinkSync(p);
    } catch {
      /* best-effort */
    }
  }
}

const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const emptyRenderStats = () => ({
  ok: true,
  expected: 0,
  replaced: 0,
  drawn: 0,
  completed: 0,
  page_expected: 0,
  page_drawn: 0,
  font_expected: 0,
  preserved_original: 0,
  preserved_original_ids: [],
  virtual_replaced: 0,
  outline_expected: 0,
  outline_replaced: 0,
  metadata_expected: 0,
  metadata_replaced: 0,
  shrunk: 0,
  overflow: 0,
  failed: 0,
  overflow_ids: [],
  failed_ids: [],
  min_font: null,
  min_glyph_font: null,
  font_sizes: [],
});

function validateSplitPartManifest({
  chunks,
  partManifest,
  pageCount,
  dir,
  maxPagesPerChunk = null,
}) {
  if (!Array.isArray(chunks) || !partManifest || typeof partManifest !== "object") {
    throw new Error("PDF 분할 provenance manifest가 없습니다.");
  }
  if (partManifest.version !== 1 || !/^[0-9a-f]{32}$/.test(String(partManifest.document_token || ""))) {
    throw new Error("PDF 분할 provenance manifest가 손상되었습니다.");
  }
  if (!Array.isArray(partManifest.chunks) || partManifest.chunks.length !== chunks.length) {
    throw new Error("PDF 분할 provenance 구간 수가 일치하지 않습니다.");
  }
  const root = `${path.resolve(dir)}${path.sep}`;
  const tokens = new Set();
  let expectedStart = 1;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const manifestChunk = partManifest.chunks[index];
    const start = Number(chunk?.start);
    const end = Number(chunk?.end);
    const manifestStart = Number(manifestChunk?.start);
    const manifestEnd = Number(manifestChunk?.end);
    const chunkTokens = Array.isArray(chunk?.page_tokens) ? chunk.page_tokens.map(String) : null;
    const manifestTokens = Array.isArray(manifestChunk?.page_tokens)
      ? manifestChunk.page_tokens.map(String)
      : null;
    const resolvedPath = path.resolve(String(chunk?.path || ""));
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start !== expectedStart ||
      end < start ||
      start !== manifestStart ||
      end !== manifestEnd ||
      (Number.isSafeInteger(Number(maxPagesPerChunk)) &&
        Number(maxPagesPerChunk) > 0 &&
        end - start + 1 > Number(maxPagesPerChunk)) ||
      !resolvedPath.startsWith(root) ||
      !chunkTokens ||
      !manifestTokens ||
      chunkTokens.length !== end - start + 1 ||
      manifestTokens.length !== chunkTokens.length ||
      chunkTokens.some((token, tokenIndex) => token !== manifestTokens[tokenIndex])
    ) {
      throw new Error("PDF 분할 provenance 구간 정보가 손상되었습니다.");
    }
    for (const token of chunkTokens) {
      if (!/^[0-9a-f]{32}$/.test(token) || tokens.has(token)) {
        throw new Error("PDF 분할 provenance page token이 손상되었거나 중복되었습니다.");
      }
      tokens.add(token);
    }
    expectedStart = end + 1;
  }
  if (expectedStart !== Number(pageCount) + 1) {
    throw new Error("PDF 분할 provenance가 전체 페이지를 연속해서 덮지 않습니다.");
  }
  return partManifest;
}

// 대용량 PDF: 페이지 구간(기본 50쪽)으로 나눠 병렬 번역한 뒤 원래 순서로 합친다.
// API 동시 호출 수는 이 문서 내부 gate와 프로세스 전역 gate를 함께 적용하고, 구간 수도
// 문서 내부 CHUNK_CONCURRENCY와 프로세스 전역 document gate를 함께 적용한다.
async function translateLargePdf({
  pdfBuffer,
  caller,
  model,
  pageCount,
  onProgress = () => {},
  signal,
  resourceLimits = getProcessWidePdfTranslateResourceLimits(),
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdftr-chunks-"));
  const inPath = path.join(dir, "in.pdf");
  const outPath = path.join(dir, "merged.ko.pdf");
  fs.writeFileSync(inPath, pdfBuffer);

  // 내부 abort 컨트롤러: 한 구간이라도 (중단이 아닌) 실패로 죽으면 형제 구간·대기 묶음의
  // API 호출을 즉시 끊어 낭비를 막는다. 외부 signal(사용자/타임아웃 중단)에도 연동한다.
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const isAborted = () => ctrl.signal.aborted;

  try {
    const {
      page_count: splitPageCount,
      chunks = [],
      virtual_blocks: rawVirtualBlocks = [],
      part_manifest: rawPartManifest = null,
      split_policy: splitPolicy = null,
    } = await resourceLimits.runDocument(
      () => tool.splitPdf(inPath, dir, {
        pagesPerChunk: CHUNK_PAGES,
        signal: ctrl.signal,
      }),
      { signal: ctrl.signal },
    );
    if (Number(splitPageCount) !== Number(pageCount)) {
      throw new Error(
        `PDF 분할 페이지 수가 원본과 다릅니다 (${splitPageCount}/${pageCount}).`,
      );
    }
    if (
      splitPolicy?.name !== SPLIT_POLICY_NAME ||
      Number(splitPolicy?.max_pages_per_chunk) !== Number(CHUNK_PAGES)
    ) {
      throw new Error("PDF 분할기가 sentence-safe 경계 정책을 증명하지 못했습니다.");
    }
    const partManifest = validateSplitPartManifest({
      chunks,
      partManifest: rawPartManifest,
      pageCount,
      dir,
      maxPagesPerChunk: CHUNK_PAGES,
    });
    const virtualBlocks = Array.isArray(rawVirtualBlocks) ? rawVirtualBlocks : [];
    const virtualIds = new Set();
    for (const block of virtualBlocks) {
      const id = String(block?.id ?? "");
      if (
        !id ||
        !["outline", "metadata"].includes(block?.kind) ||
        virtualIds.has(id)
      ) {
        throw new Error("PDF 분할 문서 구조 블록이 손상되었거나 중복되었습니다.");
      }
      virtualIds.add(id);
    }
    // 분할이 1구간 이하면 의미 없음 → 단일 처리.
    if (chunks.length <= 1) {
      const gate = makeGate(CONCURRENCY);
      const progress = makeBatchProgress(onProgress);
      const r = await translateSinglePdf({
        pdfBuffer,
        caller,
        gate,
        progress,
        onProgress,
        signal: ctrl.signal,
        resourceLimits,
      });
      return { ...r, cost: calcCost({ usage: r.usage, model }) };
    }

    onProgress(
      `📚 ${pageCount}쪽이 많아 최대 ${CHUNK_PAGES}쪽, 문장 안전 경계 기준 ${chunks.length}개 구간으로 나눠 병렬 번역합니다.`,
    );

    const gate = makeGate(CONCURRENCY); // API 동시성: 전체 구간이 공유하는 상한
    const chunkGate = makeGate(CHUNK_CONCURRENCY); // 동시에 처리할 구간 수
    const progress = makeBatchProgress(onProgress);

    // 목차 제목과 title/subject/keywords는 전체 문서에 한 번만 존재한다.
    // chunk마다 번역하면 중복 청구뿐 아니라 제목이 서로 다르게 번역될 수 있으므로,
    // page 병렬 작업과 같이 실행하되 독립된 단일 translation map으로 유지한다.
    let firstFailure = null;
    const abortForFailure = (error) => {
      if (!ctrl.signal.aborted && !firstFailure) firstFailure = error;
      ctrl.abort();
    };
    const structurePromise = (
      virtualBlocks.length
        ? translateBlocksWithRetries({
            blocks: virtualBlocks,
            caller,
            gate,
            progress,
            onProgress,
            signal: ctrl.signal,
            verbose: false,
            context: "PDF 대용량 문서 목차/문서정보 번역",
            resourceLimits,
          })
        : Promise.resolve({ translations: {}, usage: emptyUsage() })
    ).catch((error) => {
      abortForFailure(error);
      throw error;
    });

    let chunksDone = 0;
    const pagePromises = chunks.map((c, i) =>
        chunkGate(async () => {
          if (isAborted()) throw new Error("작업이 중단되었습니다.");
          try {
            const buf = fs.readFileSync(c.path);
            const r = await translateSinglePdf({
              pdfBuffer: buf,
              caller,
              gate,
              progress,
              onProgress,
              signal: ctrl.signal,
              verbose: false,
              allowBlankPassThrough: true,
              resourceLimits,
            });
            const partPath = path.join(dir, `part-${i}.ko.pdf`);
            fs.writeFileSync(partPath, r.buffer); // 디스크에 쓰고 버퍼는 즉시 해제
            chunksDone += 1;
            onProgress(
              `✅ 구간 ${chunksDone}/${chunks.length} 완료 (${c.start}–${c.end}쪽)`,
            );
            return {
              i,
              partPath,
              usage: r.usage,
              blockCount: r.blockCount,
              missing: r.missing,
              stats: r.stats,
            };
          } catch (e) {
            // 첫 실패 시 형제 구간·대기 묶음을 즉시 끊는다(이미 망한 작업에 청구 방지).
            abortForFailure(e);
            throw e;
          }
        }, { signal: ctrl.signal }),
    );
    // Promise.all rejects on the first error and would let a slow sibling keep an
    // API/document permit after this function returned.  Abort immediately, then
    // drain every child before cleanup or error delivery.
    const settled = await Promise.allSettled([...pagePromises, structurePromise]);
    const rejected = settled.filter((item) => item.status === "rejected");
    if (rejected.length) {
      throw firstFailure || rejected[0].reason;
    }
    const results = settled.slice(0, pagePromises.length).map((item) => item.value);
    const structureResult = settled[settled.length - 1].value;

    if (isAborted()) throw new Error("작업이 중단되었습니다.");

    // 구간들을 원래 페이지 순서대로 합친다(Promise.all 은 순서 보존이지만 명시적으로 정렬).
    onProgress(`🧩 ${results.length}개 구간을 하나의 PDF로 합치는 중...`);
    const ordered = results.slice().sort((a, b) => a.i - b.i);
    const mergeStats = await resourceLimits.runDocument(
      () => tool.mergePdf(
        outPath,
        ordered.map((r) => r.partPath),
        {
          signal: ctrl.signal,
          sourcePdf: inPath,
          translations: structureResult.translations,
          partManifest,
        },
      ),
      { signal: ctrl.signal },
    );
    if (
      !mergeStats?.ok ||
      !mergeStats?.structure_restored ||
      Number(mergeStats?.page_count) !== Number(pageCount) ||
      Number(mergeStats?.virtual_replaced) !== virtualBlocks.length
    ) {
      throw new Error(
        "PDF 병합 후 목차/문서정보 복원 검증을 통과하지 못했습니다.",
      );
    }
    const buffer = fs.readFileSync(outPath);

    const usageSum = { ...emptyUsage() };
    usageSum.input_tokens += structureResult.usage?.input_tokens || 0;
    usageSum.output_tokens += structureResult.usage?.output_tokens || 0;
    usageSum.cache_read_input_tokens +=
      structureResult.usage?.cache_read_input_tokens || 0;
    usageSum.cache_creation_input_tokens +=
      structureResult.usage?.cache_creation_input_tokens || 0;
    let blockCount = virtualBlocks.length;
    let missing = 0;
    const stats = {
      ok: true,
      replaced: 0,
      drawn: 0,
      completed: 0,
      expected: 0,
      page_expected: 0,
      page_drawn: 0,
      font_expected: 0,
      preserved_original: 0,
      preserved_original_ids: [],
      shrunk: 0,
      overflow: 0,
      failed: 0,
      overflow_ids: [],
      failed_ids: [],
      min_font: null,
      min_glyph_font: null,
    };
    for (const r of results) {
      usageSum.input_tokens += r.usage.input_tokens || 0;
      usageSum.output_tokens += r.usage.output_tokens || 0;
      usageSum.cache_read_input_tokens += r.usage.cache_read_input_tokens || 0;
      usageSum.cache_creation_input_tokens +=
        r.usage.cache_creation_input_tokens || 0;
      blockCount += r.blockCount || 0;
      missing += r.missing || 0;
      stats.replaced += r.stats?.replaced || 0;
      stats.drawn += r.stats?.drawn ?? r.stats?.replaced ?? 0;
      stats.page_expected += Number(r.stats?.page_expected) || 0;
      stats.page_drawn += Number(r.stats?.page_drawn) || 0;
      stats.font_expected += Number(r.stats?.font_expected) || 0;
      stats.preserved_original += Number(r.stats?.preserved_original) || 0;
      stats.preserved_original_ids.push(
        ...(r.stats?.preserved_original_ids || []).map((id) => `${r.i}:${id}`),
      );
      stats.shrunk += r.stats?.shrunk || 0;
      stats.overflow += r.stats?.overflow || 0;
      stats.failed += r.stats?.failed || 0;
      stats.overflow_ids.push(...(r.stats?.overflow_ids || []));
      stats.failed_ids.push(...(r.stats?.failed_ids || []));
      const partMinFont = Number(r.stats?.min_font);
      if (Number.isFinite(partMinFont) && partMinFont > 0) {
        stats.min_font =
          stats.min_font == null ? partMinFont : Math.min(stats.min_font, partMinFont);
      }
      const partMinGlyphFont = Number(r.stats?.min_glyph_font);
      if (Number.isFinite(partMinGlyphFont) && partMinGlyphFont > 0) {
        stats.min_glyph_font =
          stats.min_glyph_font == null
            ? partMinGlyphFont
            : Math.min(stats.min_glyph_font, partMinGlyphFont);
      }
    }
    stats.replaced += Number(mergeStats.virtual_replaced) || 0;
    stats.drawn += Number(mergeStats.virtual_replaced) || 0;
    stats.virtual_replaced = Number(mergeStats.virtual_replaced) || 0;
    stats.outline_expected = Number(mergeStats.outline_expected) || 0;
    stats.outline_replaced = Number(mergeStats.outline_replaced) || 0;
    stats.metadata_expected = Number(mergeStats.metadata_expected) || 0;
    stats.metadata_replaced = Number(mergeStats.metadata_replaced) || 0;
    stats.expected = blockCount;
    stats.completed = stats.replaced + stats.preserved_original;
    stats.structure_restored = true;
    stats.ok =
      stats.overflow === 0 &&
      stats.failed === 0 &&
      stats.completed === stats.expected;

    return {
      buffer,
      cost: calcCost({ usage: usageSum, model }),
      pageCount,
      scanned: false,
      blockCount,
      missing,
      stats,
    };
  } finally {
    if (signal) signal.removeEventListener("abort", onOuterAbort);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * PDF 를 한국어로 통번역한다. 페이지가 많으면(CHUNK_PAGES 초과) 자동으로 구간 분할·병렬
 * 번역·병합한다(예: 150쪽 → 50쪽씩 3구간 병렬 후 하나로 합침).
 * @returns {Promise<{buffer:Buffer, cost:Object, pageCount:number, scanned:boolean,
 *                    blockCount:number, missing:number, stats:Object}>}
 */
async function translatePdf({
  pdfBuffer,
  model = null,
  pageCount = null,
  maxPages = MAX_PAGES,
  onProgress = () => {},
  signal,
  resourceLimits = null,
}) {
  const MODEL = model || DEFAULT_MODEL;
  const caller = makeCaller(MODEL); // 키 누락이면 여기서 즉시 실패(GPT/Claude 자동 분기)
  const limits = resourceLimits || getProcessWidePdfTranslateResourceLimits();

  onProgress(`🤖 번역 모델: ${MODEL}`);
  onProgress("📄 PDF 분석 중 (텍스트 추출)...");

  // 페이지 수 확인(호출부가 알려주면 재분석 생략). 상한/분할 판단에 쓴다.
  const pages =
    Number.isFinite(pageCount) && pageCount > 0
      ? pageCount
      : await limits.runDocument(
          () => peekPageCount(pdfBuffer, signal),
          { signal },
        );

  const pageLimit = Number.isSafeInteger(Number(maxPages)) && Number(maxPages) > 0
    ? Number(maxPages)
    : MAX_PAGES;
  if (pages > pageLimit) {
    throw new Error(
      `페이지가 너무 많습니다 (${pages}쪽 > 상한 ${pageLimit}쪽). 파일을 나눠서 시도하세요.`,
    );
  }

  // 작은 문서는 단일 처리(기존 동작 그대로). 큰 문서만 분할·병렬·병합.
  if (pages <= CHUNK_PAGES) {
    const gate = makeGate(CONCURRENCY);
    const progress = makeBatchProgress(onProgress);
    const r = await translateSinglePdf({
      pdfBuffer,
      caller,
      gate,
      progress,
      onProgress,
      signal,
      resourceLimits: limits,
    });
    return { ...r, cost: calcCost({ usage: r.usage, model: MODEL }) };
  }

  return translateLargePdf({
    pdfBuffer,
    caller,
    model: MODEL,
    pageCount: pages,
    onProgress,
    signal,
    resourceLimits: limits,
  });
}

module.exports = {
  translatePdf,
  translateSinglePdf,
  translateLargePdf,
  makeGate,
  createPdfTranslateResourceLimits,
  getProcessWidePdfTranslateResourceLimits,
  DEFAULT_MODEL,
  MAX_PAGES,
  CHUNK_PAGES,
  makeCaller,
  isGptModel,
  translateBatch,
  translateBlocksWithRetries,
  buildBatches,
  validateTranslationCandidate,
  validateTranslationMap,
  findUntranslatedEnglishProse,
  extractNumericTokens,
  extractUrls,
  extractScientificMarkup,
  findUnsupportedTargetCodePoints,
  normalizeLatinCompatibilityLigatures,
  normalizeSourceBoundGluedMathNotation,
  normalizeTranslatedEnglishScaleNotation,
  normalizeTranslatedEnglishUnitNotation,
  looksLikeCodeOnly,
  maskAllowedEnglishRegions,
  buildTranslationReusePlan,
  annotatePageContinuations,
  pageContinuationIssue,
  findAllowedPreservedOriginalIds,
};
