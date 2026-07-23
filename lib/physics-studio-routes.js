// 고급 물리 문제 스튜디오 — 주제·난이도·스타일을 주면 모델이 **새로운** 심화 물리 문제를
// 풀이·힌트·검산과 함께 생성한다.
//
// codex 초기 버전은 6개 하드코딩 문제를 그대로 내보내는 비-AI 생성기였다(라그랑주 역학만).
// 이 라우터는 실제 모델(Claude/GPT)에게 자기 검증을 강제하며 새 문제를 만들게 한다.
// 문제 스타일·난이도 체계는 codex 가 다듬어 둔 분류를 그대로 계승했다.
// 로그인 사용자 전용 + 모델별 크레딧 차감(ai-studio-core).

const express = require("express");
const { createStudioHandler, availableModels, DEFAULT_MODEL } = require("./ai-studio-core");

const cap = (v, n) => String(v == null ? "" : v).slice(0, n).trim();

// codex 가 다듬은 5가지 문제 스타일을 계승.
const STYLES = {
  "structured-practice": "세트형 계산 훈련 — 좌표 설정→식 세우기→풀이→검산까지 긴 연쇄 하위문항.",
  "proof-derivation": "증명·유도형 — 수치 대입보다 일반 기호로 명제를 증명하고, 보존량·대칭성으로 재확인.",
  "olympiad-deep": "물리올림피아드/심화형 — 임계 조건·경계 사례·숨은 보존량을 겨냥, 오답이 갈리는 지점.",
  "concept-check": "개념확인형 — 계산량을 줄이고 자유도·좌표·부호·차원 같은 핵심 개념과 흔한 오개념 점검.",
  "diagnostic-modeling": "오류진단·모델링형 — 그럴듯하지만 불완전한 학생 풀이의 오류를 찾아 모델을 고침.",
};
const STYLE_IDS = Object.keys(STYLES);

const DIFFICULTIES = [
  "학부 기초",
  "학부 중급",
  "상위 학부 중상",
  "대학원 입문",
  "올림피아드 심화",
];

const SYSTEM_PROMPT = `당신은 대학·올림피아드 수준의 **물리 문제 출제자**이자 검증자입니다.
주어진 주제·난이도·스타일에 맞춰 **새로운** 심화 물리 문제를 만들고, 각 문제에 대해
스스로 풀어 본 뒤 검산까지 통과한 풀이·힌트를 함께 제시합니다.

[정확성 — 가장 중요]
- 물리적으로 **정확**해야 합니다. 운동방정식, 보존량, 차원, 극한, 부호가 모두 일관되어야 합니다.
- 각 문제는 실제로 풀 수 있어야 하며, solution.finalAnswer 는 statement/tasks 에서 곧장 유도됩니다.
- 풀이를 적기 전에 머릿속으로 끝까지 풀고, checks 에 차원·극한·특수값 검산을 최소 1개 넣으세요.
- 확실하지 않은 결과식을 지어내지 마세요. 만들 수 없는 문제는 더 단순한 변형으로 바꾸세요.

[출제 품질]
- 교과서 예제 복사가 아니라, 주제에서 자연스럽게 나오는 **독창적이고 자기완결적인** 상황을 설정.
- 같은 세트 안에서 문제들이 서로 다른 측면(좌표화/보존량/안정성/근사 등)을 다루게 다양화.
- statement 는 군더더기 없이, 주어진 양과 기호를 명확히 정의.

[수식 표기]
- 모든 수식은 **LaTeX**로, 인라인은 \\( ... \\) 또는 $...$, 별행은 $$...$$ 를 사용.
- 그리스문자·첨자·분수·적분을 정확한 LaTeX로(예: $\\theta$, $\\dot{\\theta}$, $\\frac{g}{R}$, $\\Omega^2$).

[출력 규칙]
- 출력은 **단 하나의 JSON 객체**만. 앞뒤에 설명/코드펜스를 넣지 마세요.
- 사람이 읽는 문장(title/statement/tasks/풀이 설명/concepts/checks)은 한국어, 수식은 LaTeX.
- 모든 필드를 채우고 빈 배열을 남기지 마세요.

[반드시 따를 JSON 스키마]
{
  "title": "문제 세트 제목(한국어)",
  "topic": "이 세트의 주제",
  "overview": "다루는 범위·난이도 2~3문장",
  "problems": [
    {
      "id": "P1",
      "title": "문제 제목",
      "subtopic": "세부 주제",
      "difficulty": "난이도 표기",
      "estimatedMinutes": 정수,
      "statement": "문제 상황(LaTeX 수식 포함, 주어진 양과 기호 정의)",
      "tasks": ["(가) ...", "(나) ...", "..."],
      "hints": [ { "level": 1, "title": "힌트 제목", "body": "막혔을 때 단서(LaTeX)" } ],
      "solution": {
        "steps": [ { "label": "단계 제목", "body": "유도 과정과 식(LaTeX)" } ],
        "finalAnswer": "핵심 결과식(LaTeX)"
      },
      "concepts": ["문제에 쓰인 핵심 개념"],
      "checks": ["차원/극한/특수값 검산"],
      "commonMistakes": ["흔한 오답·함정"]
    }
  ]
}`;

const spec = {
  feature: "physics-studio",
  maxTokens: 16000,
  parseInput(body) {
    const topic = cap(body.topic, 400);
    if (topic.length < 2) {
      throw new Error("문제 주제를 입력해 주세요. (예: 라그랑주 역학 — 회전 구속, 자기장 속 하전입자 운동 등)");
    }
    let count = parseInt(body.count, 10);
    if (!Number.isFinite(count)) count = 3;
    count = Math.max(1, Math.min(6, count));
    const style = STYLE_IDS.includes(body.style) ? body.style : "olympiad-deep";
    const difficulty = DIFFICULTIES.includes(body.difficulty)
      ? body.difficulty
      : "상위 학부 중상";
    return {
      topic,
      count,
      style,
      difficulty,
      includeSolutions: body.includeSolutions !== false && body.includeSolutions !== "false",
      includeHints: body.includeHints !== false && body.includeHints !== "false",
      notes: cap(body.notes, 800),
    };
  },
  buildSystem() {
    return SYSTEM_PROMPT;
  },
  buildUserText(input) {
    const lines = [
      `[주제] ${input.topic}`,
      `[난이도] ${input.difficulty}`,
      `[문제 스타일] ${STYLES[input.style]}`,
      `[문항 수] ${input.count}개`,
      `[풀이 포함] ${input.includeSolutions ? "예 — solution.steps 와 finalAnswer 를 채울 것" : "아니오 — solution 은 빈 객체로 두되 checks 는 채울 것"}`,
      `[힌트 포함] ${input.includeHints ? "예 — 문제마다 힌트 1~3개" : "아니오 — hints 는 빈 배열"}`,
      input.notes ? `[추가 요청] ${input.notes}` : "",
      "",
      `위 조건으로 ${input.count}개의 새로운 심화 물리 문제를 스키마대로 JSON 하나로만 출력하세요. 각 문제를 스스로 풀어 검산까지 끝낸 뒤 풀이를 적으세요.`,
    ];
    return lines.filter(Boolean).join("\n");
  },
  shapeResult(data, input) {
    const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    data.problems = arr(data.problems).slice(0, input.count).map((p, i) => {
      p = p && typeof p === "object" ? p : {};
      p.id = p.id || `P${i + 1}`;
      p.tasks = arr(p.tasks);
      p.hints = input.includeHints ? arr(p.hints) : [];
      p.concepts = arr(p.concepts);
      p.checks = arr(p.checks);
      p.commonMistakes = arr(p.commonMistakes);
      if (!p.solution || typeof p.solution !== "object") p.solution = {};
      p.solution.steps = input.includeSolutions ? arr(p.solution.steps) : [];
      if (p.solution.finalAnswer == null) p.solution.finalAnswer = "";
      return p;
    });
    return data;
  },
};

module.exports = function physicsStudioRouter(deps = {}) {
  const { requireAuth, requirePro, getSessionUser, refreshSessionUser, supa, pricing } = deps;
  if (typeof requireAuth !== "function")
    throw new Error("physics-studio-routes: requireAuth 의존성이 필요합니다.");
  if (typeof requirePro !== "function")
    throw new Error("physics-studio-routes: requirePro 의존성이 필요합니다.");

  const r = express.Router();

  r.get("/config", (_req, res) => {
    res.json({
      models: availableModels(pricing),
      defaultModel: DEFAULT_MODEL,
      styles: STYLE_IDS.map((id) => ({ id, label: STYLES[id] })),
      difficulties: DIFFICULTIES,
    });
  });

  // Pro 회원 전용 + 토큰 사용량 비례 크레딧 차감(코어에서 처리).
  r.post(
    "/generate",
    requireAuth,
    requirePro,
    createStudioHandler(spec, { getSessionUser, refreshSessionUser, supa, pricing }),
  );

  return r;
};

module.exports._spec = spec;
