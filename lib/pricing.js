// Anthropic API pricing (USD per 1M tokens).
// 공식 가격: https://www.anthropic.com/pricing
// 가격 바뀌면 여기만 수정하면 됨.
const PRICING = {
  "claude-opus-4-5": {
    input: 15,
    output: 75,
    cache_write: 18.75,
    cache_read: 1.5,
  },
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cache_write: 18.75,
    cache_read: 1.5,
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
  "claude-haiku-4-5": {
    input: 1,
    output: 5,
    cache_write: 1.25,
    cache_read: 0.1,
  },
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

// Image services
const IMAGE_GENERATION_PRICE = 0.04; // Gemini 2.5 Flash Image (Nano Banana) per image
const IMAGE_SEARCH_PRICE = 0.005; // Google Custom Search per query (after 100/day free)

function getPrices(model) {
  // 모델명 정규화 (버전 suffix 등 제거)
  const normalized = (model || "").toLowerCase().replace(/\[.*?\]/g, "");
  for (const key of Object.keys(PRICING)) {
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
};
