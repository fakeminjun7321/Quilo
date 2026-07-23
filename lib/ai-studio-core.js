// AI 스튜디오 공용 코어 — Pro 회원 전용(게이트는 라우트) + 토큰 사용량 비례 크레딧 차감 JSON 생성 도구.
//
// "바이브 코딩 생성기"(/api/vibe)와 "고급 물리 문제 스튜디오"(/api/physics-studio)는
// 둘 다 "사용자 입력 → 모델 호출 → 구조화 JSON 응답"이라는 동일한 모양이다.
// 모델 선택/제공자 분기(Anthropic·GPT)·JSON 파싱·잔액 확인·크레딧 차감 같은 공통 로직을
// 이 모듈에 모으고, 각 도구는 시스템 프롬프트·입력 검증·출력 정규화(spec)만 제공한다.
//
// 보고서 파이프라인과 동일한 헬퍼를 재사용한다:
//  - lib/model-call.js   : GPT 호출(callGptReport), isGptModel, gptConfigured
//  - lib/json-sanitize.js: 모델이 string 안에 raw 제어문자를 넣은 JSON 복구(parseJsonLenient)
//  - lib/pricing.js      : 모델별 크레딧 단가(getModelCredits) — 단일 소스
//  - lib/supabase.js     : getCredits / spendCredits (원자적 RPC 우선)

const Anthropic = require("@anthropic-ai/sdk");
const crypto = require("node:crypto");
const { callGptReport, isGptModel, gptConfigured } = require("./model-call");
const { sanitizeJson } = require("./json-sanitize");
const byok = require("./byok");
const {
  refundDurableReservation,
  settleDurableReservation,
} = require("./credit-reservation-flow");

// 셀렉터에 노출하는 모델. 크레딧 단가는 pricing.getModelCredits 가 단일 소스이므로
// 여기서는 id·label·provider 만 둔다(보고서 타입과 동일 정책: Opus 기본, GPT 선택 가능).
const STUDIO_MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "anthropic" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "openai" },
  { id: "gpt-5.4", label: "GPT-5.4", provider: "openai" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: "openai" },
];
const MODEL_IDS = new Set(STUDIO_MODELS.map((m) => m.id));
const DEFAULT_MODEL = "claude-opus-4-8";
const STUDIO_RESERVATION_TTL_MS = 15 * 60 * 1000;
const STUDIO_RESERVATION_HEARTBEAT_MS = 4 * 60 * 1000;

function anthropicConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}
function modelConfigured(id) {
  const m = STUDIO_MODELS.find((x) => x.id === id);
  if (!m) return false;
  return m.provider === "openai" ? gptConfigured() : anthropicConfigured();
}

// 키가 설정된 제공자의 모델만 노출. pricing 을 주입받아 크레딧 단가를 함께 돌려준다.
function availableModels(pricing) {
  return STUDIO_MODELS.filter((m) => modelConfigured(m.id)).map((m) => ({
    id: m.id,
    label: m.label,
    provider: m.provider,
    credits: pricing ? pricing.getModelCredits(m.id) : undefined,
  }));
}

// 빈 요청만 설정된 기본 모델로 폴백한다. 명시된 유효 모델은 제공자 키 확인 전에
// 그대로 보존해, 키가 없을 때 다른 제공자로 조용히 바뀌지 않게 한다.
function resolveModel(requested) {
  const r = String(requested || "").trim();
  if (MODEL_IDS.has(r)) return r;
  if (modelConfigured(DEFAULT_MODEL)) return DEFAULT_MODEL;
  const alt = STUDIO_MODELS.find((m) => modelConfigured(m.id));
  return alt ? alt.id : DEFAULT_MODEL;
}

// 모델 출력에서 JSON 객체만 추출 (```json 펜스/앞뒤 잡담 제거).
function extractJsonBlock(text) {
  let s = String(text || "").trim();
  // ```json ... ``` 또는 ``` ... ``` 펜스 제거
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 가장 바깥 중괄호 블록
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}

// 문자열 내부의 "유효하지 않은 백슬래시 escape"를 이스케이프한다.
// LaTeX 수식(\theta, \frac, \( 등)을 JSON string 안에 single backslash 로 쓰면
// JSON.parse 가 깨진다(\t, \f 는 제어문자, \( 는 invalid escape). 모델이 흔히 이렇게
// 출력하므로, JSON escape 로 유효한 문자(" \ / b f n r t u)로 시작하지 않는 백슬래시만
// \\ 로 바꿔 복구한다. (구조적 백슬래시는 string 밖에 없으므로 inString 일 때만 처리.)
function repairBackslashes(s) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === "\\") {
      const next = s[i + 1];
      if (inString && !'"\\/bfnrtu'.includes(next)) {
        out += "\\\\"; // 유효하지 않은 escape → 백슬래시를 이스케이프
        continue; // next 는 다음 루프에서 일반 문자로 처리
      }
      out += c;
      escaped = true; // 유효한 escape → 다음 문자는 그대로
      continue;
    }
    if (c === '"') {
      inString = !inString;
    }
    out += c;
  }
  return out;
}

// LaTeX·raw 제어문자가 섞인 모델 JSON 을 최대한 복구해서 파싱.
function robustJsonParse(text) {
  const block = extractJsonBlock(text);
  const candidates = [
    block,
    sanitizeJson(block),
    repairBackslashes(block),
    sanitizeJson(repairBackslashes(block)),
  ];
  let lastErr;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("JSON 파싱 실패");
}

async function callAnthropicJson({ model, system, userText, maxTokens, signal }) {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 5 * 60 * 1000,
  });
  const msg = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      // temperature 미지정 — 일부 최신 모델(Opus 4.8 등)이 temperature 파라미터를
      // deprecated 로 400 을 반환한다(보고서 파이프라인도 temperature 를 보내지 않음).
      system,
      messages: [{ role: "user", content: userText }],
    },
    signal ? { signal } : undefined,
  );
  if (msg.stop_reason === "max_tokens") {
    throw new Error(
      "출력이 최대 길이에 도달해 잘렸습니다. 문항 수를 줄이거나 다시 시도해 주세요.",
    );
  }
  const text = (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { text, usage: msg.usage || {} };
}

// 제공자-인지 JSON 생성. → { data(파싱된 객체), raw(원문), usage }
async function callModelJson({ model, system, userText, maxTokens = 8000, signal }) {
  let text, usage;
  if (isGptModel(model)) {
    const r = await callGptReport({
      model,
      system,
      content: [{ type: "text", text: userText }],
      maxTokens,
      jsonObject: true,
      signal,
    });
    text = r.text;
    usage = r.usage;
  } else {
    const r = await callAnthropicJson({ model, system, userText, maxTokens, signal });
    text = r.text;
    usage = r.usage;
  }
  if (!text || !text.trim()) throw new Error("AI가 빈 응답을 반환했습니다.");
  let data;
  try {
    data = robustJsonParse(text);
  } catch (e) {
    throw new Error("AI 응답을 JSON으로 해석하지 못했습니다. 다시 시도해 주세요.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("AI가 올바른 형식(JSON 객체)을 반환하지 않았습니다.");
  }
  return { data, raw: text, usage };
}

// 도구용 express 핸들러 팩토리.
// spec: { feature, parseInput(body)->input, buildSystem(input)->str,
//         buildUserText(input)->str, maxTokens?, shapeResult?(data,input)->result }
// deps: { getSessionUser, refreshSessionUser, supa, pricing }
function createStudioHandler(spec, deps) {
  const { getSessionUser, refreshSessionUser, supa, pricing } = deps;
  if (typeof getSessionUser !== "function")
    throw new Error("ai-studio-core: getSessionUser 의존성이 필요합니다.");
  if (!supa || !pricing)
    throw new Error("ai-studio-core: supa·pricing 의존성이 필요합니다.");

  return async function studioHandler(req, res) {
    const userInfo = getSessionUser(req);
    if (!userInfo || !userInfo.id) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    // 입력 검증
    let input;
    try {
      input = spec.parseInput(req.body || {});
    } catch (e) {
      return res.status(400).json({ error: e.message || "입력이 올바르지 않습니다." });
    }

    // BYOK: 본인 API 키 등록 사용자는 해당 제공자 호출을 본인 키로 실행 + 크레딧 미차감.
    const requested = String((req.body && req.body.model) || "").trim();
    if (requested && !MODEL_IDS.has(requested)) {
      return res.status(400).json({ error: "지원하지 않는 AI 모델입니다." });
    }
    const byokKeys = await byok.loadUserKeys(supa, userInfo.id);
    const model = resolveModel(requested);
    const byokActive = !!(byokKeys && byokKeys[byok.activeProvider(model)]);
    if (!modelConfigured(model) && !byokActive) {
      return res
        .status(503)
        .json({ error: "AI 모델 키가 서버에 설정되지 않았습니다. 관리자에게 문의하세요." });
    }

    // 관리자·무제한 계정·BYOK 는 과금 면제. fresh row 로 권한 확인(세션 staleness 방지).
    let fresh = userInfo;
    try {
      if (typeof refreshSessionUser === "function") {
        fresh = (await refreshSessionUser(req)) || userInfo;
      }
    } catch {
      /* 권한 새로고침 실패 → 세션 값 사용 */
    }
    const exempt = !!(fresh.isAdmin || fresh.unlimited) || byokActive;
    // 토큰 사용량 비례 차감(pricing.creditsForUsage) — 무료 모델(단가 0)은 계속 무료.
    const chargeable =
      !exempt && supa.isEnabled() && pricing.getModelCredits(model) > 0;

    // 잔액 예약 (P1/H2): 생성 '전'에 모델별 최악치(getModelCredits)를 원자적으로 선차감한다.
    // 완료 후 실제 사용량 비용만 남기고 차액을 환불한다. 이렇게 하면 (a) 잔액 1로 여러 건을
    // 동시 호출해 공짜로 생성하거나 (b) 비용이 잔액을 넘겨 0으로 바닥 처리(무료)되는 문제를
    // 막는다. durable RPC가 없으면 동시 요청을 안전하게 과금할 수 없으므로 생성 전 차단한다.
    const studioJobId = `${spec.feature}-${crypto.randomBytes(12).toString("hex")}`;
    let studioReservation = null; // durable 예약 성공 정보
    let studioReservationHeartbeat = null;
    if (chargeable) {
      const reserveAmt = Math.max(1, pricing.getModelCredits(model) || 1);
      try {
        const r = await supa.reserveCredits(userInfo.id, reserveAmt, {
          jobId: studioJobId,
          ttlMs: STUDIO_RESERVATION_TTL_MS,
        });
        if (r.unavailable) {
          return res.status(503).json({
            error: "크레딧 예약 시스템을 준비 중입니다. 잠시 후 다시 시도해 주세요.",
          });
        } else if (!r.ok) {
          const have = await supa.getCredits(userInfo.id);
          return res.status(402).json({
            error: `🚫 크레딧 부족 (보유 ${have}). 이 도구는 호출당 최대 ${reserveAmt}크레딧을 예약하고 실제 사용량만 차감(나머지 환불)합니다. 관리자에게 충전을 요청하세요.`,
          });
        } else {
          studioReservation = {
            amount: reserveAmt,
            jobId: studioJobId,
            durable: r.durable === true,
          };
          if (
            studioReservation.durable &&
            typeof supa.touchCreditReservation === "function"
          ) {
            studioReservationHeartbeat = setInterval(() => {
              void supa
                .touchCreditReservation(
                  studioReservation.jobId,
                  STUDIO_RESERVATION_TTL_MS,
                )
                .catch((error) => {
                  console.warn(
                    `[${spec.feature}] credit reservation heartbeat:`,
                    error.message,
                  );
                });
            }, STUDIO_RESERVATION_HEARTBEAT_MS);
            if (typeof studioReservationHeartbeat.unref === "function") {
              studioReservationHeartbeat.unref();
            }
          }
        }
      } catch (e) {
        console.error(`[${spec.feature}] credit reserve:`, e.message);
        return res.status(500).json({ error: "잔액 확인 중 오류가 발생했습니다." });
      }
    }

    // 생성 (BYOK 키가 있으면 그 키의 컨텍스트에서 호출)
    let result;
    let usage = null;
    try {
      const system = spec.buildSystem(input);
      const userText = spec.buildUserText(input);
      const r = await byok.run(byokKeys || {}, () =>
        callModelJson({
          model,
          system,
          userText,
          maxTokens: spec.maxTokens || 8000,
        }),
      );
      usage = r.usage;
      result = spec.shapeResult ? spec.shapeResult(r.data, input) : r.data;
    } catch (e) {
      console.error(`[${spec.feature}] generate:`, e.message);
      // 생성 실패 — 선예약 크레딧 전액 환불.
      if (studioReservation?.durable) {
        try {
          await refundDurableReservation(supa, studioReservation.jobId);
        } catch (re) {
          console.error(`[${spec.feature}] reserve refund FAILED:`, re.message);
        }
      }
      const status = /빈 응답|JSON|형식/.test(e.message || "") ? 502 : 502;
      return res
        .status(status)
        .json({ error: "AI 생성 중 오류가 발생했습니다: " + (e.message || "알 수 없는 오류") });
    } finally {
      if (studioReservationHeartbeat) {
        clearInterval(studioReservationHeartbeat);
        studioReservationHeartbeat = null;
      }
    }

    // 생성 성공 후 정산: 실제 토큰 사용량 비용만 남기고 예약분 차액을 환불한다.
    // 정산 응답이 유실되면 같은 jobId로 재시도하고, 그래도 불명확하면 ledger의
    // refund 결과가 settled인지 refunded인지 확인해 차감됐는데 결과가 사라지는 일을 막는다.
    let creditsCharged = 0;
    let newBalance;
    if (chargeable) {
      const cost = pricing.creditsForUsage
        ? pricing.creditsForUsage({ usage, model })
        : pricing.getModelCredits(model);
      try {
        if (studioReservation?.durable) {
          const s = await settleDurableReservation(
            supa,
            studioReservation.jobId,
            cost,
          );
          if (s.status === "refunded") {
            return res.status(503).json({
              error: "크레딧 정산을 확인하지 못해 예약을 환불했습니다. 다시 시도해 주세요.",
            });
          }
          newBalance = s.newBalance;
          creditsCharged = cost;
        } else if (cost > 0) {
          const s = await supa.spendCredits(userInfo.id, cost);
          creditsCharged = cost;
          newBalance = s.newBalance;
        }
      } catch (e) {
        console.error(`[${spec.feature}] settle FAILED:`, e.message);
        return res.status(503).json({
          error: "크레딧 정산 확인이 지연되고 있습니다. 중복 실행하지 말고 잠시 후 확인해 주세요.",
        });
      }
    }

    // 실비 계측 로깅(usage_logs) — 기능·모델별 원가 대시보드의 데이터 소스(2026-07-02 지혈 결정).
    try {
      if (supa.isEnabled() && typeof supa.recordUsage === "function") {
        await supa.recordUsage({
          userId: userInfo.id,
          jobId: studioJobId,
          textCostUsd: pricing.calcCost
            ? pricing.calcCost({ usage: usage || {}, model }).total
            : 0,
          meta: { feature: spec.feature, model, byok: byokActive, creditsCharged },
        });
      }
    } catch (e) {
      console.warn(`[${spec.feature}] usage log 실패:`, e.message);
    }

    return res.json({
      ok: true,
      result,
      model,
      creditsCharged,
      newBalance,
      byok: byokActive,
    });
  };
}

module.exports = {
  STUDIO_MODELS,
  DEFAULT_MODEL,
  availableModels,
  modelConfigured,
  anthropicConfigured,
  resolveModel,
  extractJsonBlock,
  callModelJson,
  createStudioHandler,
};
