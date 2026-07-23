// 바이브 코딩 생성기 — 아이디어 한 문장을 "실제로 만들 수 있는 프로젝트 설계"로 바꾼다.
//
// codex 가 만든 초기 버전은 AI 없이 템플릿으로 채우는 결정적 생성기였다. 이 라우터는
// 같은 입력(아이디어/분위기/영역/스코프/스택)을 받되 실제 모델(Claude/GPT)에게
// 추론을 시켜 아이디어에 특화된 설계·MVP·첫 작업·검증 루틴·학습 가이드를 만든다.
// 로그인 사용자 전용 + 모델별 크레딧 차감(ai-studio-core).

const crypto = require("node:crypto");
const express = require("express");
const { createStudioHandler, availableModels, DEFAULT_MODEL } = require("./ai-studio-core");
const {
  refundDurableReservation,
  settleDurableReservation,
} = require("./credit-reservation-flow");
const { genImage, imageKeyAvailable } = require("./report-image-gen");

const MAX_IDEA = 2000;
// 개념 이미지 1장당 차감 크레딧(보고서 AI 이미지 정책과 동일).
const IMAGE_CREDITS = 1;
// 사용자가 요청하는 이미지 엔진. 사용자 요청대로 gpt-image-2 우선, 실패 시 gpt-image-1 폴백.
const IMAGE_MODEL = process.env.VIBE_IMAGE_MODEL || "gpt-image-2";
const IMAGE_MODEL_FALLBACK = "gpt-image-1";
const IMAGE_RESERVATION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IMAGE_CONCURRENCY_PER_USER = 2;
const cap = (v, n) => String(v == null ? "" : v).slice(0, n).trim();

function imageConcurrencyLimit(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 4)
    : DEFAULT_IMAGE_CONCURRENCY_PER_USER;
}

function createPerUserConcurrency(limit) {
  const active = new Map();
  return {
    acquire(userId) {
      const key = String(userId);
      const count = active.get(key) || 0;
      if (count >= limit) return false;
      active.set(key, count + 1);
      return true;
    },
    release(userId) {
      const key = String(userId);
      const count = active.get(key) || 0;
      if (count <= 1) active.delete(key);
      else active.set(key, count - 1);
    },
  };
}

const SYSTEM_PROMPT = `당신은 "바이브 코딩"을 돕는 한국어 시니어 제품 엔지니어입니다.
사용자가 만들고 싶은 앱/사이트 아이디어 한 문장과 몇 가지 선택지를 주면, 그 아이디어에
**특화된** 실행 가능한 프로젝트 설계를 만듭니다. 일반론이 아니라 이 아이디어에서만 나올
구체적 화면·데이터·기능을 제시하세요.

[매우 중요한 출력 규칙]
- 출력은 **단 하나의 JSON 객체**만. JSON 앞뒤에 설명/인사/코드펜스 텍스트를 넣지 마세요.
- 모든 문자열은 한국어로. 기술 용어(React, localStorage, API 등)는 그대로 써도 됩니다.
- 빈 배열/빈 문자열을 남기지 말고 모든 필드를 의미 있게 채우세요.
- 과장·홍보 문구 금지. 실제로 코드를 짜기 시작할 수 있을 만큼 구체적으로.

[스코프 해석]
- "주말 프로젝트": 하루~이틀, 단일 화면 위주, 외부 의존성 최소.
- "MVP": 1~2주, 핵심 가치 1개를 끝까지.
- "정식 제품": 인증·저장·결제 등 실제 서비스 수준 고려.

[반드시 따를 JSON 스키마]
{
  "title": "프로젝트 이름(짧고 기억하기 쉬운 한국어/영문 혼용 가능)",
  "tagline": "한 줄 설명(무엇을, 누구를 위해)",
  "problem": "이 프로젝트가 해결하는 진짜 문제 2~3문장",
  "targetUser": "주 사용자와 그들의 상황",
  "mvp": [ { "feature": "MVP에 꼭 필요한 기능", "why": "왜 이게 핵심인지" } ],   // 3~5개
  "screens": [ { "name": "화면/뷰 이름", "purpose": "이 화면이 하는 일", "elements": ["주요 UI 요소"] } ], // 2~5개
  "modules": [ { "name": "코드 모듈/파일", "responsibility": "이 모듈의 책임" } ], // 3~6개
  "dataModel": [ { "entity": "데이터 객체", "fields": ["필드:타입"] } ],          // 1~4개
  "firstTasks": [ { "task": "지금 바로 시작할 작업", "detail": "구체적 실행 방법", "done": "완료 판단 기준" } ], // 4~7개, 의존 순서대로
  "stack": { "recommended": ["권장 스택(언어/프레임워크/저장소/배포)"], "rationale": "이 스택을 고른 이유" },
  "validation": ["만들면서 스스로 확인할 검증 루틴(테스트/수동 확인)"],            // 3~5개
  "risks": [ { "risk": "막힐 가능성이 큰 지점", "mitigation": "대처법" } ],         // 2~4개
  "variations": [ { "angle": "다른 각도", "idea": "이렇게 비틀면" } ],              // 2~3개
  "launchChecklist": ["출시 전 점검 항목"],                                        // 4~6개
  "buildReadiness": { "score": 0부터100사이정수, "reasons": ["점수 근거"] },
  "guideCards": [ { "title": "바이브 코딩 기본기 카드 제목", "body": "이 아이디어에 맞춘 실전 조언" } ], // 3~4개
  "aiPrompt": "이 프로젝트를 AI 코딩 도구(Claude Code/Cursor 등)에 그대로 붙여넣어 시작할 수 있는 잘 구조화된 작업 지시문(여러 줄, 한국어)",
  "imagePrompt": "이 앱을 한 장으로 보여주는 깔끔한 개념 일러스트 또는 UI 목업을 묘사하는 영어 프롬프트. 플랫/미니멀 일러스트 스타일, 텍스트 라벨 최소화(생성 이미지의 글자는 잘 깨짐), 앱의 핵심 사용 장면이나 화면을 시각화."
}`;

const spec = {
  feature: "vibe-coding",
  maxTokens: 16000,
  parseInput(body) {
    const idea = cap(body.idea, MAX_IDEA);
    if (idea.length < 3) {
      throw new Error("만들고 싶은 아이디어를 한 문장 이상 적어 주세요.");
    }
    return {
      idea,
      mood: cap(body.mood, 80),
      area: cap(body.area, 80),
      scope: cap(body.scope, 80),
      stack: cap(body.stack, 120),
    };
  },
  buildSystem() {
    return SYSTEM_PROMPT;
  },
  buildUserText(input) {
    const lines = [
      `[아이디어]\n${input.idea}`,
      input.mood ? `[분위기/톤] ${input.mood}` : "",
      input.area ? `[영역/분야] ${input.area}` : "",
      input.scope ? `[스코프] ${input.scope}` : "",
      input.stack ? `[선호 스택] ${input.stack}` : "",
      "",
      "위 아이디어에 특화된 프로젝트 설계를 스키마대로 JSON 하나로만 출력하세요.",
    ];
    return lines.filter(Boolean).join("\n");
  },
  shapeResult(data) {
    // 방어적 정규화 — 배열 필드가 객체/문자열로 와도 깨지지 않게.
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    data.mvp = arr(data.mvp);
    data.screens = arr(data.screens);
    data.modules = arr(data.modules);
    data.dataModel = arr(data.dataModel);
    data.firstTasks = arr(data.firstTasks);
    data.validation = arr(data.validation);
    data.risks = arr(data.risks);
    data.variations = arr(data.variations);
    data.launchChecklist = arr(data.launchChecklist);
    data.guideCards = arr(data.guideCards);
    if (data.stack && !Array.isArray(data.stack.recommended)) {
      data.stack.recommended = arr(data.stack && data.stack.recommended);
    }
    if (data.buildReadiness) {
      let s = Math.round(Number(data.buildReadiness.score));
      if (!Number.isFinite(s)) s = 0;
      data.buildReadiness.score = Math.max(0, Math.min(100, s));
      data.buildReadiness.reasons = arr(data.buildReadiness.reasons);
    }
    if (typeof data.imagePrompt !== "string") data.imagePrompt = "";
    return data;
  },
};

// 개념 이미지를 안전한 일러스트 스타일로 감싼다(텍스트 라벨 최소화).
function buildVibeImagePrompt(p) {
  const base = String(p || "").trim().slice(0, 800);
  return `${base}\n\nStyle: clean modern flat illustration / soft UI concept art for a product idea, friendly and minimal, soft gradients, plenty of whitespace, NO text labels, no words, not a photograph.`;
}

// ── 대화형 수정(refine) ────────────────────────────────────────────────────────
// 생성된 설계를 두고 사용자가 추가 질문/수정을 요청하면, 모델이 설계를 갱신하고
// 무엇을 바꿨는지 대화로 답한다. 출력 = { reply(대화), plan(전체 설계 갱신본) }.
const REFINE_SYSTEM_PROMPT = `당신은 사용자의 "바이브 코딩 프로젝트 설계"를 대화하며 함께 다듬는 한국어 시니어 제품 엔지니어입니다.
사용자가 현재 설계(JSON)에 대해 질문하거나 수정을 요청하면, 요청을 반영해 설계를 업데이트하고 무엇을 어떻게 바꿨는지(또는 질문에 대한 답변) 친근하게 설명하세요.

[출력 — 매우 중요]
- 출력은 **단 하나의 JSON 객체**만. 앞뒤에 설명/코드펜스 금지.
- 형식:
{
  "reply": "사용자에게 보여줄 대화 응답(무엇을 바꿨는지 또는 질문 답변, 한국어, 2~5문장).",
  "plan": { ...전체 프로젝트 설계 JSON... }
}

[규칙]
- "plan"은 **제공된 현재 설계와 같은 구조(같은 필드들)를 모두 채운 완전한 설계**입니다. 바뀐 부분만 주지 말고 항상 전체를 주세요.
- 사용자가 수정을 요청하면 그 부분을 반영하되, 명시하지 않은 부분을 임의로 크게 바꾸지 마세요.
- 단순 질문(수정 요청 아님)이면 plan은 기존과 거의 동일하게 유지하고 reply로 답하세요.
- 모든 사람이 읽는 문자열은 한국어로(기술 용어는 그대로). buildReadiness.score는 0~100 정수.`;

const refineSpec = {
  feature: "vibe-refine",
  maxTokens: 16000,
  parseInput(body) {
    const message = cap(body.message, 2000);
    if (message.length < 1) throw new Error("메시지를 입력해 주세요.");
    const result =
      body.result && typeof body.result === "object" && !Array.isArray(body.result)
        ? body.result
        : null;
    if (!result || !result.title) {
      throw new Error("다듬을 설계가 없습니다. 먼저 설계를 생성하세요.");
    }
    const history = Array.isArray(body.history)
      ? body.history
          .slice(-12)
          .map((h) => ({
            role: h && h.role === "ai" ? "ai" : "user",
            content: cap(h && h.content, 2000),
          }))
          .filter((h) => h.content)
      : [];
    return { message, result, history };
  },
  buildSystem() {
    return REFINE_SYSTEM_PROMPT;
  },
  buildUserText(input) {
    const lines = ["[현재 프로젝트 설계 JSON]", JSON.stringify(input.result), ""];
    if (input.history.length) {
      lines.push("[지금까지의 대화]");
      input.history.forEach((h) =>
        lines.push(`${h.role === "ai" ? "AI" : "사용자"}: ${h.content}`),
      );
      lines.push("");
    }
    lines.push(
      `[사용자의 새 요청]\n${input.message}`,
      "",
      "위 요청을 반영해 { reply, plan } JSON 하나로만 출력하세요. plan은 현재 설계와 같은 구조의 전체 설계입니다.",
    );
    return lines.join("\n");
  },
  shapeResult(data, input) {
    const reply =
      typeof data.reply === "string" && data.reply.trim()
        ? data.reply.trim()
        : "요청을 반영했어요.";
    let plan =
      data.plan && typeof data.plan === "object" && !Array.isArray(data.plan)
        ? data.plan
        : input.result;
    // generate 와 동일한 정규화로 누락 필드 방어.
    plan = spec.shapeResult(plan);
    return { reply, plan };
  },
};

module.exports = function vibeRouter(deps = {}) {
  const {
    requireAuth,
    requirePro,
    getSessionUser,
    refreshSessionUser,
    supa,
    pricing,
  } = deps;
  if (typeof requireAuth !== "function")
    throw new Error("vibe-routes: requireAuth 의존성이 필요합니다.");
  if (typeof requirePro !== "function")
    throw new Error("vibe-routes: requirePro 의존성이 필요합니다.");

  const r = express.Router();
  const generateImage =
    typeof deps.generateImage === "function" ? deps.generateImage : genImage;
  const hasImageKey =
    typeof deps.imageKeyAvailable === "function"
      ? deps.imageKeyAvailable
      : imageKeyAvailable;
  const imageSlots = createPerUserConcurrency(
    imageConcurrencyLimit(deps.imageConcurrencyLimit),
  );
  const creditFlowOptions = deps.creditFlowOptions;

  // 모델 목록·단가 (셀렉터용). 로그인 불필요 — 생성 엔드포인트만 Pro 게이트.
  r.get("/config", (_req, res) => {
    res.json({
      models: availableModels(pricing),
      defaultModel: DEFAULT_MODEL,
      imageAvailable: hasImageKey(),
      imageCredits: IMAGE_CREDITS,
    });
  });

  // Pro 회원 전용 + 토큰 사용량 비례 크레딧 차감(코어에서 처리).
  r.post(
    "/generate",
    requireAuth,
    requirePro,
    createStudioHandler(spec, { getSessionUser, refreshSessionUser, supa, pricing }),
  );

  // 대화형 수정: 현재 설계 + 대화이력 + 새 요청 → { reply, plan(갱신본) }. Pro + 토큰 비례 차감.
  r.post(
    "/refine",
    requireAuth,
    requirePro,
    createStudioHandler(refineSpec, { getSessionUser, refreshSessionUser, supa, pricing }),
  );

  // 개념 이미지 생성(gpt-image-2 → 폴백 gpt-image-1). Pro + 이미지 1장당 IMAGE_CREDITS 차감.
  r.post("/image", requireAuth, requirePro, async (req, res) => {
    const userInfo = getSessionUser(req);
    if (!userInfo || !userInfo.id) return res.status(401).json({ error: "로그인이 필요합니다." });
    if (!hasImageKey()) {
      return res.status(503).json({ error: "이미지 생성 키(GPT)가 서버에 설정되지 않았습니다." });
    }
    const prompt = String((req.body && req.body.prompt) || "").trim();
    if (prompt.length < 3) return res.status(400).json({ error: "이미지 프롬프트가 없습니다." });

    // 한 사용자가 느린 이미지 요청을 무제한 병렬 실행해 provider 비용/소켓을 점유하지
    // 못하게 한다. 모든 return/throw 경로에서 finally 로 슬롯을 반환한다.
    if (!imageSlots.acquire(userInfo.id)) {
      return res.status(429).json({
        error: "이미지 생성 요청이 이미 진행 중입니다. 완료 후 다시 시도해 주세요.",
      });
    }

    try {
      // 관리자·무제한 면제는 기존 동작을 유지한다. Vibe 이미지 경로는 사용자 BYOK를
      // provider 호출에 사용하지 않으므로 기존과 동일하게 BYOK 면제를 새로 만들지 않는다.
      let fresh = userInfo;
      try {
        if (typeof refreshSessionUser === "function") {
          fresh = (await refreshSessionUser(req)) || userInfo;
        }
      } catch {}
      const exempt = !!(fresh.isAdmin || fresh.unlimited);
      const chargeable = !exempt && supa.isEnabled() && IMAGE_CREDITS > 0;

      // 비용이 발생하는 provider 호출 전에 durable ledger로 크레딧을 원자 예약한다.
      // ledger가 없거나 예약 상태가 불명확하면 이미지를 생성하지 않고 fail closed 한다.
      let reservation = null;
      if (chargeable) {
        const jobId = `vibe-image-${crypto.randomBytes(12).toString("hex")}`;
        try {
          const reserved = await supa.reserveCredits(userInfo.id, IMAGE_CREDITS, {
            jobId,
            ttlMs: IMAGE_RESERVATION_TTL_MS,
          });
          if (reserved.unavailable) {
            return res.status(503).json({
              error: "크레딧 예약 시스템을 준비 중입니다. 잠시 후 다시 시도해 주세요.",
            });
          }
          if (!reserved.ok) {
            const have = await supa.getCredits(userInfo.id);
            return res.status(402).json({
              error: `🚫 크레딧 부족 (보유 ${have} / 필요 ${IMAGE_CREDITS}).`,
            });
          }
          if (reserved.durable !== true) {
            return res.status(503).json({
              error: "크레딧 예약 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
            });
          }
          reservation = { jobId, amount: IMAGE_CREDITS };
        } catch (error) {
          console.error("[vibe-image] credit reserve:", error.message);
          return res.status(503).json({ error: "잔액 확인 중 오류가 발생했습니다." });
        }
      }

      // 생성 (gpt-image-2 → 실패 시 gpt-image-1)
      let buffer;
      const imagePrompt = buildVibeImagePrompt(prompt);
      try {
        buffer = await generateImage(imagePrompt, {
          size: "1536x1024",
          model: IMAGE_MODEL,
        });
      } catch (primaryError) {
        try {
          buffer = await generateImage(imagePrompt, {
            size: "1536x1024",
            model: IMAGE_MODEL_FALLBACK,
          });
        } catch (fallbackError) {
          console.error(
            "[vibe-image] generate:",
            primaryError.message,
            "| fallback:",
            fallbackError.message,
          );
          if (reservation) {
            try {
              const refunded = await refundDurableReservation(
                supa,
                reservation.jobId,
                creditFlowOptions,
              );
              if (refunded.status !== "refunded") {
                return res.status(503).json({
                  error: "이미지 생성은 실패했고 크레딧 상태를 확인 중입니다. 중복 실행하지 마세요.",
                });
              }
            } catch (refundError) {
              console.error("[vibe-image] reserve refund FAILED:", refundError.message);
              return res.status(503).json({
                error: "이미지 생성은 실패했고 크레딧 환불 확인이 지연되고 있습니다. 중복 실행하지 마세요.",
              });
            }
          }
          return res.status(502).json({
            error:
              "이미지 생성에 실패했습니다: " +
              (fallbackError.message || primaryError.message),
          });
        }
      }

      // 생성 성공 후 같은 jobId를 정산한다. 응답 유실은 멱등 재시도/환불 상태로
      // 판별하고, 끝내 상태를 확인할 수 없으면 이미지 bytes를 반환하지 않는다.
      let creditsCharged = 0;
      let newBalance;
      if (reservation) {
        try {
          const settled = await settleDurableReservation(
            supa,
            reservation.jobId,
            reservation.amount,
            creditFlowOptions,
          );
          if (settled.status !== "settled") {
            return res.status(503).json({
              error: "크레딧 정산을 확인하지 못해 예약을 환불했습니다. 다시 시도해 주세요.",
            });
          }
          creditsCharged = reservation.amount;
          newBalance = settled.newBalance;
        } catch (error) {
          console.error("[vibe-image] settle FAILED:", error.message);
          return res.status(503).json({
            error: "크레딧 정산 확인이 지연되고 있습니다. 중복 실행하지 말고 잠시 후 확인해 주세요.",
          });
        }
      }
      return res.json({
        ok: true,
        dataUrl: "data:image/png;base64," + buffer.toString("base64"),
        creditsCharged,
        newBalance,
      });
    } finally {
      imageSlots.release(userInfo.id);
    }
  });

  return r;
};

module.exports._spec = spec;
