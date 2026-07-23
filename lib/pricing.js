// Anthropic API pricing (USD per 1M tokens).
// 공식 가격: https://www.anthropic.com/pricing
// 가격 바뀌면 여기만 수정하면 됨.
const PRICING = {
  // Fable 5 — Opus 위 최상위 티어 (공식: $10/$50, cache write 1.25x, read 0.1x)
  "claude-fable-5": {
    input: 10,
    output: 50,
    cache_write: 12.5,
    cache_read: 1.0,
  },
  // Opus 4.5+ 공식 단가는 $5/$25 (이전 15/75는 구세대 Opus 가격 — 표시가 3배 과대였음)
  "claude-opus-4-8": {
    input: 5,
    output: 25,
    cache_write: 6.25,
    cache_read: 0.5,
  },
  "claude-opus-4-5": {
    input: 5,
    output: 25,
    cache_write: 6.25,
    cache_read: 0.5,
  },
  "claude-opus-4-7": {
    input: 5,
    output: 25,
    cache_write: 6.25,
    cache_read: 0.5,
  },
  "claude-sonnet-4-5": {
    input: 3,
    output: 15,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  "claude-sonnet-4-6": {
    input: 3,
    output: 15,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  // Sonnet 5 — 공식 단가 $3/$15(4.6 과 동일 sticker; 도입 할인 $2/$10 은 한시적이라 보수적으로 정가 적용)
  "claude-sonnet-5": {
    input: 3,
    output: 15,
    cache_write: 3.75,
    cache_read: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cache_write: 1.25,
    cache_read: 0.1,
  },
  // OpenAI GPT (USD/1M). cache_read = OpenAI 자동 프롬프트 캐시 입력가(스크린샷의
  // 가운데 열). OpenAI 는 캐시 write 비용이 없어 cache_write 는 미사용(입력가로 둠).
  "gpt-5.5": { input: 5, output: 30, cache_write: 5, cache_read: 0.5 },
  "gpt-5.4": { input: 2.5, output: 15, cache_write: 2.5, cache_read: 0.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache_write: 0.75, cache_read: 0.075 },
  // Google Gemini (USD/1M, OpenAI 호환 엔드포인트). cache_read 는 근사값(암묵적 캐시).
  // 2026-07 기준: 2.5 Flash $0.30/$2.50, 3.1 Pro $2.00/$12.00(≤200k). 가격 변동 시 여기만 수정.
  "gemini-3.1-pro": { input: 2, output: 12, cache_write: 2, cache_read: 0.5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache_write: 0.3, cache_read: 0.075 },
};

// Web search 도구 비용 (검색 1회당 USD)
const WEB_SEARCH_PRICE = 0.01;

// ── Report fixed prices (USD) ──────────────────────────────────────────────────
// 사용자가 보고서 1건 만들 때 차감되는 USD 금액. 실제 Anthropic 비용과 무관.
// 환율 변동 시 KRW 표시는 매번 현재 환율로 자동 환산됨 (lib/exchange-rate.js).
//
// 가격 정책 (사용자 정한 KRW 기준 → 변경 시점 환율로 USD 환산):
// - 화학 사전: ₩1,200 ÷ ₩1,478/$ ≈ $0.81 (4월 30일 기준, frankfurter.dev)
// - 결과 (화학·물리): ₩1,500 ÷ ₩1,478/$ ≈ $1.02 (4월 30일 기준)
// USD로 hardcode → 환율 변동 시 KRW 표시 자동 변동.
const REPORT_PRICE_USD = {
  "chem-pre": 0.81,
  "chem-result": 1.02,
  "phys-result": 1.02,
};

// 보고서 종류별 credit 그룹 (잔액은 두 가지로 분리됨: 사전 / 결과)
const REPORT_CREDIT_FIELD = {
  "chem-pre": "pre",
  "chem-result": "result",
  "phys-result": "result",
};

function getReportPrice(reportType) {
  return REPORT_PRICE_USD[reportType] || 0;
}

function getCreditField(reportType) {
  return REPORT_CREDIT_FIELD[reportType] || null;
}

// ── 통합 크레딧 포인트제: 모델별 크레딧 단가 (정수) ───────────────────────────
// 보고서 1건당 선택한 모델에 따라 차감되는 크레딧.
// Opus = 3, Sonnet = 1. (사용자 정책)
// 2026-06-10 개편: 실비 비례 사다리 (mini 무료 / GPT-5.4 1 / Sonnet 2 / GPT-5.5·Opus 4 / Fable 9).
// 기존 잔액은 ×2 보정(db/migrations/20260610_credits_x2.sql)으로 가치 보존(Sonnet 1→2 스케일).
const MODEL_CREDITS = {
  "claude-fable-5": 9, // 관리자 전용(셀렉터는 관리자에게만 노출)
  "claude-opus-4-8": 4,
  "claude-opus-4-7": 4,
  "claude-opus-4-5": 4,
  "claude-sonnet-5": 2,
  "claude-sonnet-4-6": 2,
  "claude-sonnet-4-5": 2,
  "claude-haiku-4-5": 1,
  "gpt-5.5": 4,
  "gpt-5.4-mini": 0, // 무료
  "gpt-5.4": 1,
  // Gemini: Flash=가성비 1크레딧, Pro=정밀 2크레딧 (2026-07 사용자 정책)
  "gemini-3.1-pro": 2,
  "gemini-2.5-flash": 1,
};
const DEFAULT_MODEL_CREDITS = 4; // 미확인 모델은 보수적으로 Opus 단가

// ── 토큰 사용량 비례 크레딧 (스튜디오 등 소형 호출용) ─────────────────────────
// 보고서(건당 정액)와 달리, 바이브 코딩·물리 문제 스튜디오처럼 호출 크기가 작고
// 편차가 큰 도구는 실제 토큰 비용에 비례해 차감한다.
// 1크레딧 ≈ TOKEN_CREDIT_USD 달러어치 토큰. 2026-07-02 확정 0.15 — 크레딧 판매
// 예상가(₩250~300 ≈ $0.18~0.22)보다 지급 토큰이 크면 팔수록 손해라 0.25→0.15 하향.
// (⚠ 적용 전 Pro 사용자 공지 필요: 체감 크레딧 소모 약 +67%) env TOKEN_CREDIT_USD 로 조정.
// 무료 모델(getModelCredits=0)은 계속 무료, 유료 모델은 최소 1크레딧부터.
const TOKEN_CREDIT_USD = Math.max(
  0.01,
  Number(process.env.TOKEN_CREDIT_USD) || 0.15,
);
function creditsForUsage({ usage, model, webSearchCount = 0 }) {
  if (getModelCredits(model) === 0) return 0;
  const usd = calcCost({ usage: usage || {}, webSearchCount, model }).total;
  if (!(usd > 0)) return 0;
  return Math.max(1, Math.ceil(usd / TOKEN_CREDIT_USD));
}

// 독서록은 실제 토큰 사용량으로 정산하지만, GPT-5.4-mini 일일 무료 한도를
// 넘긴 요청은 모델의 기본 단가(0)가 아니라 요청 접수 때 예약한 1크레딧을
// 그대로 확정해야 한다. 이 예외를 한곳에 두어 완료 단계에서 무료로 되돌아가는
// 회귀를 막는다.
function readingLogCreditsForUsage({ usage, model, miniOverCap = false }) {
  if (miniOverCap) return 1;
  return usage ? creditsForUsage({ usage, model }) : 0;
}

function getModelCredits(model) {
  const normalized = (model || "").toLowerCase().replace(/\[.*?\]/g, "");
  // 더 긴(구체적) 키부터 — 'gpt-5.4-mini' 가 'gpt-5.4' 로 잘못 매칭되지 않게.
  const keys = Object.keys(MODEL_CREDITS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.startsWith(key)) return MODEL_CREDITS[key];
  }
  return DEFAULT_MODEL_CREDITS;
}

// Image services
const IMAGE_GENERATION_PRICE = 0.04; // Gemini 2.5 Flash Image (Nano Banana) per image
const IMAGE_SEARCH_PRICE = 0.005; // Google Custom Search per query (after 100/day free)

function getPrices(model) {
  // 모델명 정규화 (버전 suffix 등 제거)
  const normalized = (model || "").toLowerCase().replace(/\[.*?\]/g, "");
  if (PRICING[normalized]) return PRICING[normalized]; // 정확 일치 우선
  // 접두사 일치는 더 긴(구체적) 키부터 — 'gpt-5.4-mini' 가 'gpt-5.4' 로 잘못
  // 매칭되는 것을 막는다.
  for (const key of Object.keys(PRICING).sort((a, b) => b.length - a.length)) {
    if (normalized.startsWith(key)) return PRICING[key];
  }
  // Default = Opus pricing (보수적으로)
  return PRICING["claude-opus-4-5"];
}

function calcCost({ usage, webSearchCount = 0, model }) {
  const p = getPrices(model);
  const inputTokens = usage?.input_tokens || 0;
  const outputTokens = usage?.output_tokens || 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens = usage?.cache_read_input_tokens || 0;

  const inputCost = (inputTokens / 1_000_000) * p.input;
  const outputCost = (outputTokens / 1_000_000) * p.output;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * p.cache_write;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * p.cache_read;
  const webSearchCost = webSearchCount * WEB_SEARCH_PRICE;

  const total =
    inputCost + outputCost + cacheWriteCost + cacheReadCost + webSearchCost;

  return {
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    webSearchCount,
    inputCost,
    outputCost,
    cacheWriteCost,
    cacheReadCost,
    webSearchCost,
    total,
    model,
  };
}

function fmtUSD(amount) {
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(3)}`;
}

function fmtKRW(usd, rate = 1400) {
  return `≈ ${Math.round(usd * rate).toLocaleString()}원`;
}

function fmtTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatCostLine(cost) {
  const parts = [
    `입력 ${fmtTokens(cost.inputTokens)}토큰`,
    `출력 ${fmtTokens(cost.outputTokens)}토큰`,
  ];
  if (cost.cacheReadTokens > 0)
    parts.push(`캐시읽기 ${fmtTokens(cost.cacheReadTokens)}토큰`);
  if (cost.cacheWriteTokens > 0)
    parts.push(`캐시쓰기 ${fmtTokens(cost.cacheWriteTokens)}토큰`);
  if (cost.webSearchCount > 0) parts.push(`웹검색 ${cost.webSearchCount}회`);
  return `💰 텍스트 비용: ${fmtUSD(cost.total)} ${fmtKRW(cost.total)} (${parts.join(", ")})`;
}

// ── Image cost ────────────────────────────────────────────────────────────────
function calcImageCost({ searchCount = 0, generationCount = 0 }) {
  const searchCost = searchCount * IMAGE_SEARCH_PRICE;
  const generationCost = generationCount * IMAGE_GENERATION_PRICE;
  const total = searchCost + generationCost;
  return {
    searchCount,
    generationCount,
    searchCost,
    generationCost,
    total,
  };
}

function formatImageCostLine(cost) {
  if (cost.searchCount === 0 && cost.generationCount === 0) return null;
  const parts = [];
  if (cost.searchCount > 0) parts.push(`검색 ${cost.searchCount}회`);
  if (cost.generationCount > 0)
    parts.push(`AI생성 ${cost.generationCount}장`);
  return `🖼 이미지 비용: ${fmtUSD(cost.total)} ${fmtKRW(cost.total)} (${parts.join(", ")})`;
}

module.exports = {
  calcCost,
  calcImageCost,
  formatCostLine,
  formatImageCostLine,
  fmtUSD,
  fmtKRW,
  fmtTokens,
  REPORT_PRICE_USD,
  REPORT_CREDIT_FIELD,
  getReportPrice,
  getCreditField,
  MODEL_CREDITS,
  getModelCredits,
  TOKEN_CREDIT_USD,
  creditsForUsage,
  readingLogCreditsForUsage,
};
