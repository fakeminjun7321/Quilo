// KRW ↔ USD 환율 변환. frankfurter.app 무료 API 사용 (가입 불필요).
// 메모리 캐시 1시간.

const CACHE_TTL_MS = 60 * 60 * 1000;
const FALLBACK_KRW_PER_USD = 1400; // API 실패 시 폴백 환율

let cache = { rate: null, fetchedAt: 0 };

/**
 * 1 USD = X KRW 비율을 반환. 실패 시 FALLBACK_KRW_PER_USD.
 */
async function getKrwPerUsd() {
  const now = Date.now();
  if (cache.rate && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.rate;
  }
  try {
    // 2026년경 frankfurter.app은 frankfurter.dev로 이전됨 (.app은 301 리다이렉트만 반환).
    // fetch는 기본적으로 redirect를 따라가지만 일부 호스트가 응답 본문을 비워 보내서
    // 안전하게 새 도메인을 직접 사용한다.
    const resp = await fetch(
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=KRW",
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const rate = data?.rates?.KRW;
    if (typeof rate !== "number" || rate <= 0) throw new Error("invalid rate");
    cache = { rate, fetchedAt: now };
    return rate;
  } catch (e) {
    console.warn("[exchange-rate] frankfurter 실패, 폴백 환율 사용:", e.message);
    return FALLBACK_KRW_PER_USD;
  }
}

async function krwToUsd(krw) {
  const rate = await getKrwPerUsd();
  return Number(krw) / rate;
}

async function usdToKrw(usd) {
  const rate = await getKrwPerUsd();
  return Number(usd) * rate;
}

module.exports = { getKrwPerUsd, krwToUsd, usdToKrw };
