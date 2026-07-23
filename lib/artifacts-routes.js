// "창작/만들기"(AI 아티팩트 빌더) API 라우터.
// 마운트: app.use(require("./lib/artifacts-routes")({ requireAdmin, requireAdminOrBeta, getSessionUser }))
// 생성·관리 = 관리자 또는 'create' 베타 테스터. 갤러리·/p 보기 = 모두 공개.
//
// - POST /api/artifacts/build  : 프롬프트(+현재 HTML) → AI 가 self-contained HTML 생성
// - GET  /api/artifacts        : 내 아티팩트 목록
// - POST /api/artifacts        : 저장/게시(upsert) → { slug, url }
// - DELETE /api/artifacts/:id  : 삭제
// - GET  /p/:slug              : 게시된 아티팩트를 **sandbox iframe** 으로 안전하게 제공
//
// 저장: Supabase 'artifacts' 테이블(없으면 메모리 fallback — 재시작 시 사라짐).
// 보안: 생성/저장/관리 전부 관리자. 게시물은 origin 격리(sandbox, no same-origin)로
//       쿠키·세션 접근을 차단해 공개 뷰어를 보호한다.

const express = require("express");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const supa = require("./supabase");

const GPT_BASE = process.env.GPT_API_BASE || "https://api.openai.com/v1";
const isGpt = (m) => /^gpt/i.test(String(m || ""));
const BUILD_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const DEFAULT_BUILD_MODEL = "auto";
const DEFAULT_AI_TOKEN_SECRET =
  process.env.ARTIFACT_AI_TOKEN_SECRET ||
  process.env.SESSION_SECRET ||
  process.env.COOKIE_SECRET ||
  "artifact-ai-dev-secret";
let aiTokenSecret = DEFAULT_AI_TOKEN_SECRET;
const AI_TOKEN_TTL_MS = Math.max(
  60_000,
  parseInt(process.env.ARTIFACT_AI_TOKEN_TTL_MS || String(15 * 60 * 1000), 10),
);
// 바이브 코딩: 비용 최소화 사다리 — 싼 모델부터 시도, 결과가 부실하면 자동 상향.
const AUTO_LADDER = ["gpt-5.4-mini", "claude-sonnet-5", "claude-opus-4-8"];
const hasClaude = () => !!process.env.ANTHROPIC_API_KEY;
const hasGpt = () => !!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY);
const keyFor = (m) => (isGpt(m) ? hasGpt() : hasClaude());

function htmlLooksComplete(html) {
  if (!html) return false;
  const h = stripFences(html);
  if (!/<\/html>/i.test(h) || h.length < 500) return false;
  // 닫힘 균형(대략): <script>/<style> 개폐 수 일치
  const open = (h.match(/<script\b/gi) || []).length;
  const close = (h.match(/<\/script>/gi) || []).length;
  return open === close;
}

async function callOne(model, userText, wantSummary, projectMode, designMode) {
  return isGpt(model)
    ? callGptHtml({ model, userText, wantSummary, projectMode, designMode })
    : callClaudeHtml({ model, userText, wantSummary, projectMode, designMode });
}

// raw 를 모드에 맞게 마감 결과로 변환.
function finalizeBuild(raw, model, auto, projectMode) {
  if (projectMode) {
    const p = parseProjectFiles(raw);
    return { files: p.files, entry: p.entry, summary: p.summary, model, auto };
  }
  return { html: stripFences(raw), summary: parseSummary(raw), model, auto };
}

// model==="auto" 면 사다리로 가장 싼 모델부터, 충분히 완결되면 채택.
// userText 는 composeUserText()/composeProjectText() 가 만든 전체 사용자 메시지.
async function buildResolved(model, userText, wantSummary, projectMode, designMode) {
  if (model && model !== "auto" && BUILD_MODELS.includes(model)) {
    const raw = await callOne(model, userText, wantSummary, projectMode, designMode);
    return finalizeBuild(raw, model, false, projectMode);
  }
  const ladder = AUTO_LADDER.filter(keyFor);
  if (!ladder.length) throw new Error("사용 가능한 AI 키가 없습니다.");
  let lastRaw = "";
  for (let i = 0; i < ladder.length; i++) {
    const m = ladder[i];
    try {
      const raw = await callOne(m, userText, wantSummary, projectMode, designMode);
      lastRaw = raw || lastRaw;
      const last = i === ladder.length - 1;
      // 마지막 단계이거나 결과가 충분히 완결되면 채택
      const ok = projectMode
        ? projectLooksComplete(parseProjectFiles(raw))
        : htmlLooksComplete(stripFences(raw));
      if (ok || last) {
        return finalizeBuild(raw, m, true, projectMode);
      }
    } catch (e) {
      if (i === ladder.length - 1) throw e; // 마지막까지 실패면 에러
    }
  }
  return finalizeBuild(lastRaw, ladder[ladder.length - 1], true, projectMode);
}

// 채팅형 스튜디오: 이전 요청 맥락 + 현재 HTML + 이번 요청을 한 사용자 메시지로 합친다.
function composeUserText(prompt, currentHtml, history) {
  const prior = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.role === "user" && typeof h.content === "string" && h.content.trim())
    .map((h) => h.content.trim().slice(0, 300))
    .slice(-8);
  let t = "";
  if (prior.length)
    t += "이전 대화에서의 요청들(맥락 참고용):\n" + prior.map((p) => "- " + p).join("\n") + "\n\n";
  if (currentHtml)
    t +=
      "현재 HTML:\n```html\n" +
      currentHtml +
      "\n```\n\n이번 요청(이걸 반영해 전체 HTML 을 다시 출력):\n" +
      prompt;
  else t += prompt;
  return t;
}

// 채팅 모드에서 모델이 HTML 앞에 붙인 '> 한 줄 요약'을 떼어낸다(없으면 "").
function parseSummary(raw) {
  const t = String(raw || "");
  const idx = t.toLowerCase().indexOf("<!doctype");
  const head = idx > 0 ? t.slice(0, idx) : "";
  const line = head
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith(">"));
  return line ? line.replace(/^>+\s*/, "").slice(0, 200) : "";
}

// 채팅 모드 전용 시스템 보강 — 한 줄 요약 + 완결 HTML.
const CHAT_SUMMARY_ADDENDUM = `

[채팅 모드 추가 규칙] 이번 응답의 맨 첫 줄에 '> ' 로 시작하는 한국어 한 문장으로 '무엇을 만들었는지 / 이번에 무엇을 바꿨는지'를 짧고 친근하게 요약하라(예: "> 다크모드 토글과 마감 임박 빨강 강조를 추가했어요."). 그 다음 줄부터 <!doctype html> 로 시작하는 완결 HTML 을 출력하라. 요약 한 줄 외의 설명·코드펜스는 넣지 말 것.`;

const SYSTEM_PROMPT = `너는 최고의 웹 아티팩트 빌더다. 사용자가 한국어로 "이런 웹페이지 / 위젯 / 작은 도구를 만들어줘"라고 하면, **완전히 self-contained 한 단일 HTML 문서 하나**를 만든다.

규칙:
- 출력은 <!DOCTYPE html> 로 시작해 </html> 로 끝나는 **완결된 HTML 문서 하나**. 모든 CSS 는 <style>, 모든 JS 는 <script> 안에 인라인.
- 번들러/빌드 필요 없는 것만. 단, 브라우저에서 바로 동작하는 CDN <script>/<link>(예: Chart.js, Tailwind Play CDN, Google Fonts)는 사용해도 된다.
- 이 HTML 은 **sandbox iframe**(allow-scripts; same-origin·쿠키 없음, 상위창 이동 불가) 안에서 돈다. 부모/사이트의 쿠키·localStorage·세션에 접근하려 하지 말 것. 외부 공개 API(CORS 허용) 호출은 가능.
- UI 는 기본 한국어. 반응형(모바일 OK), 깔끔하고 완성도 높게. 접근성·다크모드 고려하면 좋음.
- 데이터가 필요하면 그럴듯한 더미 데이터를 내장하되, 사용자가 값을 입력/조정할 수 있게.

**공유 데이터 저장(QuiloDB) — 방문자끼리 공유되는 데이터가 필요할 때 사용:**
이 페이지가 게시되면 \`window.QuiloDB\` 가 자동 주입된다(별도 로드 불필요). 모든 방문자가 공유하는 저장소다(예: 방명록, 투표/설문 집계, 랭킹, 공용 메모). 모두 async:
- \`await QuiloDB.set(key, value)\` — 값 저장(JSON 가능, 8KB 이하)
- \`await QuiloDB.get(key)\` — 값 읽기(없으면 undefined)
- \`await QuiloDB.all()\` — {키:값} 전체
- \`await QuiloDB.push(listKey, item)\` — 리스트에 항목 추가(방명록·로그용, 최대 1000개)
- \`const url = await QuiloDB.upload(dataUrl)\` — 앱 사용자가 올린 이미지(data URL)를 저장하고 URL 반환(갤러리/프로필 사진 등). 이미지 4MB 이하.
규칙: 방문자 공유가 필요하면 QuiloDB 를, '이 브라우저에만' 저장이면 localStorage 를 쓴다. 사용자별 데이터는 앱이 만든 uid 를 키 접두사로(예: 'user:'+uid). QuiloDB 호출은 try/catch 로 감싸고 실패해도 UI 가 깨지지 않게. 초기 로드시 QuiloDB.all() 로 기존 데이터를 그려라.

**AI 기능(QuiloAI) — 앱 안에서 AI 를 쓰고 싶을 때:**
\`const answer = await QuiloAI.ask("질문", { system: "선택적 역할지시" })\` → 문자열 답변. 챗봇, 자동 채점/피드백, 요약, 퀴즈 생성, 추천 등에 사용. 응답은 짧게(수백 토큰) 오니 길게 필요하면 나눠 호출. try/catch 로 감싸고 로딩 표시를 넣어라. (요청이 몰리면 429 가 올 수 있으니 사용자에게 안내.)

- **출력은 HTML 코드만.** 마크다운 코드펜스(\`\`\`)나 설명 문장을 절대 넣지 말 것.`;

// ── 멀티파일·멀티언어 프로젝트 모드 ────────────────────────────────────────────
const PROJECT_SYSTEM = `너는 최고의 멀티파일 웹 프로젝트 빌더다. 사용자가 앱/프로젝트를 요청하면 **여러 파일로 이루어진, 빌드 도구 없이 브라우저에서 바로 도는 프로젝트**를 만든다. HTML/CSS/JS 는 물론 React/JSX, TypeScript, Vue, Tailwind 등 여러 언어·프레임워크를 자유롭게 섞어도 된다.

출력 형식(반드시 정확히 지킬 것):
1) 맨 첫 줄: '> ' 로 시작하는 한국어 한 문장 요약(무엇을 만들었는지/이번에 무엇을 바꿨는지).
2) 그 다음부터 각 파일을 아래 형식으로 차례로 나열한다. 다른 머리말·설명·코드펜스(\`\`\`) 금지:
===FILE: index.html===
(파일 내용)
===FILE: styles.css===
(파일 내용)
===FILE: app.jsx===
(파일 내용)

규칙:
- 엔트리(미리보기 시작점)는 반드시 **index.html**. index.html 이 <link rel="stylesheet" href="styles.css"> / <script src="app.js"> 처럼 같은 프로젝트의 다른 파일을 **상대경로**로 참조하게 한다(미리보기가 알아서 연결해 준다).
- React/JSX·TypeScript 를 쓰면: index.html 에서 CDN 으로 React/ReactDOM + @babel/standalone 을 불러오고, JSX/TS 파일은 <script type="text/babel" data-presets="react,typescript" src="app.jsx"></script> 로 참조한다(빌드 없이 브라우저에서 트랜스파일).
- Vue 는 Vue 3 글로벌 빌드 CDN, Tailwind 는 Play CDN, 차트는 Chart.js CDN 등 'CDN 으로 바로 되는' 방식만 사용.
- ES 모듈(import/export)을 쓰려면 <script type="module"> + 상대경로 import 로 작성한다.
- 백엔드 언어(Node/Express, Python 서버 등)가 필요하면 파일로 만들어도 되지만, **미리보기는 프런트엔드만 실행**된다(백엔드 파일은 다운로드해 로컬에서 실행). 순수 계산 로직을 파이썬으로 보여주려면 main.py 로 작성하면 미리보기가 Pyodide(브라우저 파이썬)로 실행해 출력을 보여준다.
- 이 프로젝트는 sandbox iframe(allow-scripts) 안에서 돈다. 부모 쿠키/세션 접근 금지. 외부 공개 API(CORS 허용) 호출은 가능. (게시되면 단일 HTML 로 합쳐져 QuiloDB·QuiloAI 도 사용 가능.)
- UI 는 기본 한국어, 반응형, 완성도 높게.`;

// 디자인 모드: 슬라이드 덱·프로토타입·시안 비교·모바일 목업 등 '디자인 아티팩트'.
// 출력 형식은 PROJECT_SYSTEM 과 동일(===FILE: 블록, 엔트리 index.html) 이라 미리보기·ZIP 재사용.
const DESIGN_SYSTEM = `너는 최고의 디자이너이자 프로토타이퍼다. 사용자의 요청을 보고 무엇을 만들지 스스로 판단한다 — 슬라이드 덱(프레젠테이션), 클릭 가능한 하이파이 프로토타입, 여러 시안 비교(디자인 캔버스), 모바일 앱 목업 등.

출력 형식(반드시 정확히 지킬 것 — 일반 프로젝트와 동일):
1) 맨 첫 줄: '> ' 로 시작하는 한국어 한 문장 요약.
2) 그 다음부터 각 파일을 ===FILE: path=== 블록으로 나열. 엔트리는 반드시 index.html. 코드펜스(\`\`\`)·여분 설명 금지.
- 같은 프로젝트의 CSS/JS 는 상대경로로 참조(미리보기가 연결). 라이브러리는 CDN 으로 바로 되는 것만(구글폰트/Tailwind Play/Chart.js/React UMD 등).
- sandbox iframe(allow-scripts) 안에서 돈다. 부모 쿠키/세션 접근 금지.

디자인 원칙(반드시 지킬 것):
- **하나의 과감하고 구체적인 미감**을 정해 끝까지 밀어붙인다. 밋밋한 '기본 부트스트랩' 느낌 금지.
- **AI 슬롭 회피**: 과한 그라데이션 배경 금지 · 이모지는 브랜드가 쓸 때만 · '둥근모서리+왼쪽 컬러보더 강조박스' 금지 · 그림을 SVG로 억지로 그리지 말고 회색 플레이스홀더(이미지 자리, 캡션 포함)로 둔다 · 흔한 폰트(Inter/Roboto/Arial/시스템폰트) 대신 개성 있는 구글폰트.
- **진짜 레이아웃**: CSS grid, text-wrap:pretty, 여백·리듬·위계. 색은 조화롭게(oklch 권장), 배경색 1~2개로 절제. 적절한 타입 스케일.

종류별 가이드:
- **슬라이드 덱**: 1920×1080 고정 캔버스를 뷰포트에 맞춰 transform:scale 로 레터박스(검은 배경). ←→ 키보드 + 좌우 화살표 버튼(스케일 밖에 배치) + 슬라이드 번호 오버레이. 현재 슬라이드를 localStorage 저장·복원. @page 로 인쇄 시 한 슬라이드=한 페이지. 본문 24px+ , 제목 훨씬 크게. 한 덱에 배경색 최대 2개.
- **프로토타입**: 타이틀 화면 만들지 말고 뷰포트 중앙/적절한 여백에 배치. 실제 동작하는 인터랙션(상태·전환).
- **디자인 캔버스(시안 비교)**: 2개 이상 시안을 라벨 달아 그리드로 나란히.
- **모바일 목업**: 휴대폰 베젤(상태바 포함) 안에 화면. 터치 타깃 44px+.

가능하면 우하단에 작은 'Tweaks' 패널을 넣어 색/폰트/레이아웃 변형을 토글할 수 있게 한다(선택). 채울 내용이 없으면 억지 더미로 채우지 말고 레이아웃으로 해결한다. UI 기본 한국어.`;

// 프로젝트 모드 사용자 메시지(편집 시 현재 파일들 포함).
function composeProjectText(prompt, files, history) {
  const prior = (Array.isArray(history) ? history : [])
    .filter((h) => h && h.role === "user" && typeof h.content === "string" && h.content.trim())
    .map((h) => h.content.trim().slice(0, 300))
    .slice(-8);
  let t = "";
  if (prior.length)
    t += "이전 대화에서의 요청들(맥락 참고용):\n" + prior.map((p) => "- " + p).join("\n") + "\n\n";
  if (Array.isArray(files) && files.length) {
    t += "현재 프로젝트 파일들(이걸 수정해 전체 파일을 같은 형식으로 다시 출력):\n";
    for (const f of files.slice(0, 30)) {
      t += `\n===FILE: ${String(f.path || "").slice(0, 200)}===\n` + String(f.content || "").slice(0, 40000) + "\n";
    }
    t += "\n이번 요청:\n" + prompt;
  } else {
    t += prompt;
  }
  return t;
}

// raw → { files:[{path,content}], entry, summary }. ===FILE:=== 블록 파싱.
// 블록이 없으면 단일 HTML 로 폴백(index.html 한 파일).
function parseProjectFiles(raw) {
  const t = String(raw || "");
  const reFile = /^===FILE:[ \t]*(.+?)[ \t]*===[ \t]*$/gm;
  const heads = [];
  let m;
  while ((m = reFile.exec(t))) heads.push({ path: m[1].trim(), start: m.index, headEnd: reFile.lastIndex });
  // 요약: 첫 블록 이전 텍스트에서 '> ' 줄.
  const head = heads.length ? t.slice(0, heads[0].start) : t.slice(0, 400);
  const sumLine = head.split("\n").map((s) => s.trim()).find((s) => s.startsWith(">"));
  const summary = sumLine ? sumLine.replace(/^>+\s*/, "").slice(0, 200) : "";

  if (!heads.length) {
    const html = stripFences(t);
    if (!html) return { files: [], entry: "index.html", summary };
    return { files: [{ path: "index.html", content: html }], entry: "index.html", summary };
  }
  const files = [];
  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : t.length;
    let content = t.slice(cur.headEnd, end).replace(/^\r?\n/, "").replace(/\s+$/, "");
    content = content.replace(/^```[a-z0-9]*\r?\n?/i, "").replace(/\r?\n?```$/i, "");
    const path = cur.path.replace(/^\/+/, "").slice(0, 200);
    if (path) files.push({ path, content });
  }
  const entry =
    (files.find((f) => /(^|\/)index\.html$/i.test(f.path)) || {}).path ||
    (files.find((f) => /\.html$/i.test(f.path)) || {}).path ||
    (files[0] && files[0].path) ||
    "index.html";
  return { files, entry, summary };
}

function projectLooksComplete(parsed) {
  return (
    parsed &&
    Array.isArray(parsed.files) &&
    parsed.files.length >= 1 &&
    parsed.files.some((f) => f.content && f.content.trim().length > 30)
  );
}

function stripFences(s) {
  let t = String(s || "").trim();
  // ```html ... ``` 또는 ``` ... ``` 제거
  const m = t.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);
  if (m) t = m[1].trim();
  // 앞부분에 코드펜스만 떼고 뒤에 설명이 붙는 경우 대비: 첫 <!doctype ~ 마지막 </html>
  const lo = t.toLowerCase();
  const a = lo.indexOf("<!doctype");
  const b = lo.lastIndexOf("</html>");
  if (a >= 0 && b > a) t = t.slice(a, b + "</html>".length);
  return t.trim();
}

async function callClaudeHtml({ model, userText, wantSummary, projectMode, designMode }) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const sys = designMode
    ? DESIGN_SYSTEM
    : projectMode
      ? PROJECT_SYSTEM
      : SYSTEM_PROMPT + (wantSummary ? CHAT_SUMMARY_ADDENDUM : "");
  const msg = await client.messages.create({
    model,
    max_tokens: Math.min(Number(process.env.MAX_TOKENS) || 32000, 32000),
    system: sys,
    messages: [{ role: "user", content: userText }],
  });
  return (msg.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function callGptHtml({ model, userText, wantSummary, projectMode, designMode }) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("GPT_API_KEY 가 설정되지 않았습니다.");
  const sys = designMode
    ? DESIGN_SYSTEM
    : projectMode
      ? PROJECT_SYSTEM
      : SYSTEM_PROMPT + (wantSummary ? CHAT_SUMMARY_ADDENDUM : "");
  const resp = await fetch(`${GPT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText },
      ],
      max_completion_tokens: 32000,
      reasoning_effort: process.env.GPT_REASONING_EFFORT || "low",
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${raw.slice(0, 200)}`);
  const j = JSON.parse(raw);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

// 아티팩트 앱이 호출하는 AI(QuiloAI) — 비용 관리 위해 싼 모델·짧은 출력·레이트리밋.
async function callAiText(prompt, system) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("AI 키가 없습니다.");
  const resp = await fetch(`${GPT_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.QUILO_AI_MODEL || "gpt-5.4-mini",
      messages: [
        { role: "system", content: (system && String(system).slice(0, 2000)) || "너는 웹앱에 내장된 도우미다. 한국어로 간결하고 정확하게 답한다." },
        { role: "user", content: String(prompt).slice(0, 6000) },
      ],
      max_completion_tokens: 900,
      reasoning_effort: "low",
    }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`AI ${resp.status}`);
  const j = JSON.parse(raw);
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}
// AI 레이트리밋(비용): IP 당 분당 20, slug 당 분당 40.
const aiRate = new Map();
function aiAllowed(keyId, perMin) {
  const now = Date.now(), win = 60000;
  const rec = aiRate.get(keyId) || { t: now, n: 0 };
  if (now - rec.t > win) { rec.t = now; rec.n = 0; }
  rec.n++; aiRate.set(keyId, rec);
  return rec.n <= perMin;
}

function signAiToken(slug, user, now = Date.now()) {
  if (!user || !user.id) return "";
  const payload = {
    slug: String(slug || ""),
    uid: String(user.id),
    exp: now + AI_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", aiTokenSecret)
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verifyAiToken(token, slug) {
  const raw = String(token || "");
  const parts = raw.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expect = crypto
    .createHmac("sha256", aiTokenSecret)
    .update(body)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expect);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.slug !== String(slug || "")) return null;
  if (!payload.uid || Number(payload.exp) < Date.now()) return null;
  return payload;
}

// ── 이미지 생성 모델 라우팅 ──
// auto: 요청을 보고 '고화질 정교 작업'이면 high(gpt-image-2), '아이콘·로고·단순'이면 std(gpt-image-1).
// env 로 교체 가능. high 모델이 안 되면 std 로 graceful 폴백.
const IMAGE_STD = process.env.IMAGE_MODEL_STD || "gpt-image-1";
const IMAGE_HIGH = process.env.IMAGE_MODEL_HIGH || "gpt-image-2";
const IMAGE_MODELS = ["auto", IMAGE_STD, IMAGE_HIGH];

// 프롬프트를 보고 high/std 판단 — 명확한 키워드는 휴리스틱, 애매하면 싼 모델로 분류.
async function classifyImageTier(prompt) {
  const p = String(prompt).toLowerCase();
  const HIGH = /(사진|실사|포토|photo|realistic|디테일|detailed|정교|섬세|포스터|poster|배너|banner|일러스트|illustration|인물|얼굴|portrait|풍경|landscape|배경화면|wallpaper|4k|고화질|highres|high.?resolution|cinematic|복잡|장면|scene|render|3d|구도)/;
  const LOW = /(아이콘|icon|로고|logo|단순|심플|simple|플랫|flat|도형|shape|패턴|pattern|이모지|emoji|픽토|pictogram|버튼|button|배지|badge|와이어프레임|wireframe)/;
  if (HIGH.test(p) && !LOW.test(p)) return "high";
  if (LOW.test(p) && !HIGH.test(p)) return "std";
  try {
    const a = await callAiText(
      `이미지 생성 요청: "${String(prompt).slice(0, 400)}"\n이 요청이 사진·실사·정교한 일러스트·복잡한 장면처럼 '고화질'이 중요하면 high, 아이콘·로고·단순 그래픽이면 std 로만 답하라.`,
      "너는 분류기다. 오직 'high' 또는 'std' 한 단어만 출력한다.",
    );
    return /high/i.test(a) ? "high" : "std";
  } catch {
    return "std";
  }
}

async function callImageModel(key, model, prompt, size, quality) {
  const resp = await fetch(`${GPT_BASE}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, prompt, size: size || "1024x1024", quality }),
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`이미지 생성 ${resp.status}: ${raw.slice(0, 160)}`);
  const j = JSON.parse(raw);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("이미지 응답이 비었습니다.");
  return b64;
}

// → { b64, model, tier, auto, fallback }. model 미지정/'auto' 면 분류해서 모델·품질 선택.
async function genImage(prompt, { size, model } = {}) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("이미지 생성 키(GPT_API_KEY)가 없습니다.");
  let chosen = model && model !== "auto" && IMAGE_MODELS.includes(model) ? model : null;
  let tier, auto = false;
  if (!chosen) {
    auto = true;
    tier = await classifyImageTier(prompt);
    chosen = tier === "high" ? IMAGE_HIGH : IMAGE_STD;
  } else {
    tier = chosen === IMAGE_HIGH ? "high" : "std";
  }
  // high 등급은 더 좋은 모델(gpt-image-2)을 쓰되 품질은 medium 기본 — 'high'는 1~3분 걸려
  // Render 프록시 타임아웃·체감 지연 위험이 커서, 원하면 IMAGE_HIGH_QUALITY=high 로 올린다.
  const quality = tier === "high" ? (process.env.IMAGE_HIGH_QUALITY || "medium") : "medium";
  try {
    const b64 = await callImageModel(key, chosen, prompt, size, quality);
    return { b64, model: chosen, tier, auto };
  } catch (e) {
    if (chosen !== IMAGE_STD) {
      const b64 = await callImageModel(key, IMAGE_STD, prompt, size, "medium");
      return { b64, model: IMAGE_STD, tier: "std", auto, fallback: true };
    }
    throw e;
  }
}

// 미디어 저장: Supabase Storage 'artifact-media'(공개) → 공개 URL. 없으면 data URL.
const MEDIA_BUCKET = process.env.ARTIFACT_MEDIA_BUCKET || "artifact-media";
let mediaBucketOk = null;
async function uploadMedia(buffer, ext, contentType) {
  const c = await sb();
  if (c) {
    try {
      if (mediaBucketOk === null) {
        const { error: ge } = await c.storage.getBucket(MEDIA_BUCKET);
        if (ge) await c.storage.createBucket(MEDIA_BUCKET, { public: true });
        mediaBucketOk = true;
      }
      const path = `img/${crypto.randomUUID()}.${ext}`;
      const { error } = await c.storage.from(MEDIA_BUCKET).upload(path, buffer, { contentType, upsert: false });
      if (error) throw error;
      const { data } = c.storage.from(MEDIA_BUCKET).getPublicUrl(path);
      if (data && data.publicUrl) return data.publicUrl;
    } catch (e) {
      mediaBucketOk = false; // 스토리지 불가 → data URL fallback
    }
  }
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function slugify(s) {
  const base = String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\- ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return base || "page";
}

// ── 저장소: Supabase 'artifacts' 테이블, 없으면 메모리 ────────────────────────
const mem = new Map(); // slug -> record
let tableOk = null; // null=미확인, true/false

async function sb() {
  if (!supa.isEnabled()) return null;
  try {
    return supa.getClient();
  } catch {
    return null;
  }
}

async function storeUpsert(rec) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { error } = await c.from("artifacts").upsert(rec, { onConflict: "slug" });
      if (error) throw error;
      tableOk = true;
      return rec;
    } catch (e) {
      // owner_id 없는 DB 행은 표시명만으로 소유권을 증명할 수 없다. 마이그레이션이
      // 빠진 환경에서는 레거시 DB 쓰기를 재시도하지 않고 ID가 보존되는 메모리
      // fallback을 사용한다. 운영 배포는 owner_id 마이그레이션을 필수로 한다.
      tableOk = false;
    }
  }
  mem.set(rec.slug, rec);
  return rec;
}

// 관리 목록: 관리자는 전체, 비관리자는 본인 것만.
// 보안(H1): 본인 판정은 불변 owner_id 기준. 값은 supabase-js .eq()/.is() 로만 전달해
// PostgREST 필터 인젝션(표시명에 콤마/괄호 등 포함 시) 을 피한다. 레거시(owner_id 없음)
// owner_id가 없는 레거시 행은 관리자만 볼 수 있으며 일반 사용자에게는 노출하지 않는다.
async function storeList({ ownerId, isAdmin }) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const cols = "id,slug,title,is_public,updated_at,owner,owner_id";
      if (isAdmin) {
        const { data, error } = await c.from("artifacts").select(cols).order("updated_at", { ascending: false }).limit(300);
        if (error) throw error;
        tableOk = true;
        return data || [];
      }
      const { data, error } = ownerId
        ? await c.from("artifacts").select(cols).eq("owner_id", ownerId).order("updated_at", { ascending: false }).limit(300)
        : { data: [], error: null };
      if (error) throw error;
      tableOk = true;
      return data || [];
    } catch (e) {
      tableOk = false;
    }
  }
  return [...mem.values()]
    .filter((r) => isAdmin || (ownerId && r.owner_id === ownerId))
    .map((r) => ({ id: r.id, slug: r.slug, title: r.title, is_public: r.is_public, updated_at: r.updated_at, owner: r.owner, owner_id: r.owner_id }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

// 공개 갤러리: 공개(is_public) 아티팩트만, 모두에게.
async function storeGallery() {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c
        .from("artifacts")
        .select("slug,title,updated_at,owner,category,likes,views,forked_from")
        .eq("is_public", true)
        .order("updated_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      tableOk = true;
      return data || [];
    } catch {
      tableOk = false;
    }
  }
  return [...mem.values()]
    .filter((r) => r.is_public)
    .map((r) => ({ slug: r.slug, title: r.title, updated_at: r.updated_at, owner: r.owner, category: r.category || "", likes: r.likes || 0, views: r.views || 0, forked_from: r.forked_from || null }))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
}

// 조회수 +1 (html 미수정). 비침습.
async function storeView(slug) {
  const c = await sb();
  if (c && tableOk) {
    try {
      const cur = await storeGet(slug);
      if (cur) await c.from("artifacts").update({ views: (cur.views || 0) + 1 }).eq("slug", slug);
      return;
    } catch { /* memory */ }
  }
  const r = mem.get(slug);
  if (r) r.views = (r.views || 0) + 1;
}

async function storeLike(slug) {
  const c = await sb();
  if (c && tableOk) {
    try {
      const cur = await storeGet(slug);
      if (!cur) return 0;
      const likes = (cur.likes || 0) + 1;
      await c.from("artifacts").update({ likes }).eq("slug", slug);
      return likes;
    } catch {
      /* memory */
    }
  }
  const r = mem.get(slug);
  if (!r) return 0;
  r.likes = (r.likes || 0) + 1;
  return r.likes;
}

async function storeGet(slug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c.from("artifacts").select("*").eq("slug", slug).maybeSingle();
      if (error) throw error;
      tableOk = true;
      if (data) return data;
    } catch {
      tableOk = false;
    }
  }
  return mem.get(slug) || null;
}

// PostgREST 필터 인젝션 차단용: 입력이 UUID 형식인지 판정해 id/slug 분기에 사용.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// idOrSlug(id 또는 slug)로 레코드 1건을 찾는다(소유권 검사용). 인젝션 없이 분기 .eq().
async function storeFind(idOrSlug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const col = UUID_RE.test(idOrSlug) ? "id" : "slug";
      const { data, error } = await c.from("artifacts").select("*").eq(col, idOrSlug).maybeSingle();
      if (error) throw error;
      tableOk = true;
      if (data) return data;
    } catch {
      tableOk = false;
    }
  }
  for (const [slug, rrec] of mem) if (rrec.id === idOrSlug || slug === idOrSlug) return rrec;
  return null;
}

// idOrSlug 가 UUID 형식이면 id 로, 아니면 slug 로 삭제한다.
// (이전엔 .or(`id.eq.${v},slug.eq.${v}`) 로 사용자 입력을 raw PostgREST 필터에 인터폴레이션해
//  콤마/점/연산자 토큰으로 필터를 깰 수 있었다. 분기 .eq() 로 인젝션을 차단한다.)
async function storeDelete(idOrSlug) {
  const c = await sb();
  if (c && tableOk) {
    try {
      if (UUID_RE.test(idOrSlug)) await c.from("artifacts").delete().eq("id", idOrSlug);
      else await c.from("artifacts").delete().eq("slug", idOrSlug);
    } catch {
      /* ignore */
    }
  }
  for (const [slug, r] of mem) if (r.id === idOrSlug || slug === idOrSlug) mem.delete(slug);
}

// ── 댓글 (Supabase 'artifact_comments' + 메모리 fallback) ──────────────────────
const memComments = new Map(); // slug -> [{id,author,text,at}]
async function commentsList(slug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c.from("artifact_comments").select("*").eq("slug", slug).order("at", { ascending: true }).limit(200);
      if (error) throw error;
      tableOk = true;
      if (data) return data;
    } catch { tableOk = false; }
  }
  return memComments.get(slug) || [];
}
async function commentAdd(slug, author, text) {
  const entry = { slug, author: String(author || "익명").slice(0, 40), text: String(text || "").slice(0, 1000), at: nowIso() };
  const c = await sb();
  if (c && tableOk) {
    try { const { data } = await c.from("artifact_comments").insert(entry).select().maybeSingle(); if (data) return data; } catch { /* memory */ }
  }
  entry.id = "c_" + Math.abs((slug + entry.at + entry.text).split("").reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7)).toString(36);
  const arr = memComments.get(slug) || [];
  arr.push(entry);
  if (arr.length > 500) arr.shift();
  memComments.set(slug, arr);
  return entry;
}

// ── 아티팩트용 공유 KV 저장소 (인터랙티브 앱: 투표·방명록·랭킹·상태) ──────────
// Supabase 'artifact_kv'(slug,k,v) + 메모리 fallback. 캡으로 남용 방지.
const KV_MAX_VAL = 8 * 1024; // 값(JSON) 최대 8KB
const KV_MAX_KEYS = 300; // slug 당 키 수
const KV_MAX_LIST = 1000; // push 리스트 길이
const memKv = new Map(); // slug -> Map(k -> v)

function memKvOf(slug) {
  if (!memKv.has(slug)) memKv.set(slug, new Map());
  return memKv.get(slug);
}
async function kvAll(slug) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { data, error } = await c.from("artifact_kv").select("k,v").eq("slug", slug).limit(KV_MAX_KEYS);
      if (error) throw error;
      const o = {};
      for (const row of data || []) o[row.k] = row.v;
      return o;
    } catch {
      /* fall through to memory */
    }
  }
  return Object.fromEntries(memKvOf(slug));
}
async function kvGet(slug, k) {
  const all = await kvAll(slug);
  return all[k];
}
async function kvSet(slug, k, v) {
  const c = await sb();
  if (c && tableOk !== false) {
    try {
      const { error } = await c.from("artifact_kv").upsert({ slug, k, v, updated_at: nowIso() }, { onConflict: "slug,k" });
      if (error) throw error;
      return;
    } catch {
      /* memory */
    }
  }
  const m = memKvOf(slug);
  if (!m.has(k) && m.size >= KV_MAX_KEYS) throw new Error("저장 키 수 한도 초과");
  m.set(k, v);
}
async function kvPush(slug, k, item) {
  const cur = (await kvGet(slug, k)) || [];
  const arr = Array.isArray(cur) ? cur : [];
  arr.push(item);
  while (arr.length > KV_MAX_LIST) arr.shift();
  await kvSet(slug, k, arr);
  return arr.length;
}

// 간단 IP 레이트리밋(쓰기): 분당 N회
const kvRate = new Map();
function kvWriteAllowed(ip) {
  const now = Date.now();
  const win = 60000, lim = 80;
  const rec = kvRate.get(ip) || { t: now, n: 0 };
  if (now - rec.t > win) { rec.t = now; rec.n = 0; }
  rec.n++; kvRate.set(ip, rec);
  if (kvRate.size > 5000) {
    for (const [key, value] of kvRate) {
      if (now - value.t > win) kvRate.delete(key);
    }
  }
  return rec.n <= lim;
}

// 유료 모델 호출(빌드/이미지 생성) per-user 빈도 제한 — 비용 남용 방지.
// coding-routes 의 checkAssistLimit 와 동일한 슬라이딩 윈도(분/일) 방식. 메모리 보관 → 재시작 시 리셋.
const BUILD_PER_MIN = Math.max(0, Number(process.env.ARTIFACT_BUILD_PER_MIN) || 10);
const BUILD_PER_DAY = Math.max(0, Number(process.env.ARTIFACT_BUILD_PER_DAY) || 150);
const IMAGE_PER_MIN = Math.max(0, Number(process.env.ARTIFACT_IMAGE_PER_MIN) || 6);
const IMAGE_PER_DAY = Math.max(0, Number(process.env.ARTIFACT_IMAGE_PER_DAY) || 60);
const _costMin = new Map(); // bucket:userKey -> [ts]
const _costDay = new Map();
function costLimitAllowed(bucket, userKey, perMin, perDay) {
  const now = Date.now(), MIN = 60 * 1000, DAY = 24 * 60 * 60 * 1000;
  const key = bucket + ":" + userKey;
  const mn = (_costMin.get(key) || []).filter((t) => now - t < MIN);
  const dy = (_costDay.get(key) || []).filter((t) => now - t < DAY);
  if (perMin > 0 && mn.length >= perMin) { _costMin.set(key, mn); _costDay.set(key, dy); return false; }
  if (perDay > 0 && dy.length >= perDay) { _costMin.set(key, mn); _costDay.set(key, dy); return false; }
  mn.push(now); dy.push(now);
  _costMin.set(key, mn); _costDay.set(key, dy);
  return true;
}
// 게이트 통과 사용자 식별: 불변 사용자 ID·없으면 Express가 신뢰 프록시 설정으로
// 계산한 IP. 표시명과 원시 X-Forwarded-For는 공격자가 바꿀 수 있어 쓰지 않는다.
function costUserKey(req, user) {
  const u = user || {};
  return u.id ? "u:" + u.id : "ip:" + String(req.ip || "?");
}

function escapeForSrcdoc(html) {
  return String(html || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

// 게시 페이지의 sandbox iframe 안에 주입할 QuiloDB 헬퍼(절대 URL 로 KV 호출).
function quiloDbScript(base, slug, aiToken = "") {
  const api = `${base}/api/kv/${encodeURIComponent(slug)}`;
  const aiApi = `${base}/api/ai/${encodeURIComponent(slug)}`;
  const mediaApi = `${base}/api/media/${encodeURIComponent(slug)}`;
  return `<script>(function(){var A=${JSON.stringify(api)},AI=${JSON.stringify(aiApi)},MD=${JSON.stringify(mediaApi)},AIT=${JSON.stringify(aiToken)};async function j(u,o){var r=await fetch(u,Object.assign({headers:{'Content-Type':'application/json'}},o));if(!r.ok)throw new Error('KV '+r.status);return r.json();}
window.QuiloDB={all:function(){return j(A);},get:async function(k){return (await j(A))[k];},set:function(k,v){return j(A+'/'+encodeURIComponent(k),{method:'PUT',body:JSON.stringify({value:v})});},push:function(k,item){return j(A+'/'+encodeURIComponent(k)+'/push',{method:'POST',body:JSON.stringify({item:item})});},upload:async function(dataUrl){var r=await fetch(MD,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:dataUrl})});if(!r.ok)throw new Error('upload '+r.status);return (await r.json()).url;}};
window.QuiloAI={ask:async function(prompt,opts){if(!AIT)throw new Error('AI 401');var r=await fetch(AI,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+AIT},body:JSON.stringify({prompt:prompt,system:(opts&&opts.system)||undefined})});if(!r.ok)throw new Error('AI '+r.status);return (await r.json()).text;}};})();</script>`;
}

function nowIso() {
  return new Date().toISOString();
}

module.exports = function artifactsRouter({
  requireAdmin,
  requireAdminOrBeta,
  getSessionUser,
  refreshSessionUser,
  sessionSecret,
}) {
  if (sessionSecret) aiTokenSecret = String(sessionSecret);
  const r = express.Router();
  // 생성·관리는 관리자 또는 'create' 베타 테스터만. 보기(갤러리·/p)는 모두 공개.
  const gate = requireAdminOrBeta ? requireAdminOrBeta("create") : requireAdmin;

  // 소유권 검사: 관리자는 전체, 비관리자는 본인 작품만.
  // 보안(H1): 소유권은 불변 user id(owner_id) 로 판정한다. 표시명(owner=name)은
  // 중복 가능(스키마상 unique 아님)하므로, 같은 이름으로 가입한 타인이 남의 비공개
  // 아티팩트를 읽기/덮어쓰기/삭제할 수 있었다(IDOR). owner_id 가 있으면 그것으로만
  // 비교한다. owner_id가 없는 레거시 행은 일반 사용자가 안전하게 소유권을 증명할
  // 방법이 없으므로 관리자만 마이그레이션하거나 삭제할 수 있다.
  function canManage(req, rec) {
    if (!rec) return false;
    const u = getSessionUser(req) || {};
    if (u.isAdmin) return true;
    return rec.owner_id != null && rec.owner_id !== "" && !!u.id && rec.owner_id === u.id;
  }

  // 공개 갤러리 — 로그인 불필요(비베타·비로그인도 만든 것 구경 가능)
  r.get("/api/artifacts/gallery", async (req, res) => {
    try {
      res.json({ items: await storeGallery() });
    } catch (e) {
      res.status(500).json({ error: "갤러리를 불러오지 못했습니다." });
    }
  });

  // 리믹스(포크): 베타/관리자가 공개 아티팩트의 HTML 을 가져와 새 작품으로 변형
  r.get("/api/artifacts/:slug/remix", gate, async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec || !rec.is_public) return res.status(404).json({ error: "없음" });
    res.json({ html: rec.html, title: `${rec.title} (리믹스)`, category: rec.category || "기타", forkedFrom: rec.slug });
  });

  // 신고 — 공개, 레이트리밋. 메모리(+가능하면 supabase) 기록 → 관리자 확인.
  const reports = [];
  r.post("/api/artifacts/:slug/report", async (req, res) => {
    const ip = String(req.ip || "?");
    if (!kvWriteAllowed(ip)) return res.status(429).json({ error: "rate limit" });
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).json({ error: "없음" });
    const entry = { slug: req.params.slug, reason: String(req.body.reason || "").slice(0, 300), at: nowIso() };
    reports.push(entry);
    if (reports.length > 500) reports.shift();
    const c = await sb();
    if (c) { try { await c.from("artifact_reports").insert(entry); } catch {} }
    res.json({ ok: true });
  });
  // 관리자: 신고 목록
  r.get("/api/artifacts/reports", gate, async (req, res) => {
    const u = getSessionUser(req) || {};
    if (!u.isAdmin) return res.status(403).json({ error: "관리자만" });
    const c = await sb();
    if (c) { try { const { data } = await c.from("artifact_reports").select("*").order("at", { ascending: false }).limit(200); if (data) return res.json({ reports: data }); } catch {} }
    res.json({ reports: [...reports].reverse() });
  });

  // 좋아요 — 공개(중복은 클라이언트 localStorage 로 방지). IP 레이트리밋.
  r.post("/api/artifacts/:slug/like", async (req, res) => {
    const ip = String(req.ip || "?");
    if (!kvWriteAllowed(ip)) return res.status(429).json({ error: "rate limit" });
    try {
      const rec = await storeGet(req.params.slug);
      if (!rec || !rec.is_public) return res.status(404).json({ error: "없음" });
      res.json({ likes: await storeLike(req.params.slug) });
    } catch (e) {
      res.status(500).json({ error: "실패" });
    }
  });

  // 댓글 — 보기는 공개, 작성은 로그인 필요(작성자 = 세션 이름). IP 레이트리밋.
  r.get("/api/artifacts/:slug/comments", async (req, res) => {
    try {
      const rec = await storeGet(req.params.slug);
      if (!rec || !rec.is_public) return res.status(404).json({ error: "없음" });
      res.json({ comments: await commentsList(req.params.slug) });
    } catch (e) { res.status(500).json({ error: "실패" }); }
  });
  r.post("/api/artifacts/:slug/comments", async (req, res) => {
    const ip = String(req.ip || "?");
    if (!kvWriteAllowed(ip)) return res.status(429).json({ error: "rate limit" });
    const u = getSessionUser(req);
    if (!u || !u.name) return res.status(401).json({ error: "로그인 후 댓글을 쓸 수 있습니다." });
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "내용을 입력하세요." });
    try {
      const rec = await storeGet(req.params.slug);
      if (!rec || !rec.is_public) return res.status(404).json({ error: "없음" });
      res.json({ comment: await commentAdd(req.params.slug, u.name, text) });
    } catch (e) { res.status(500).json({ error: "실패" }); }
  });

  r.get("/api/artifacts/models", gate, (req, res) => {
    // '자동' 을 맨 앞에(바이브 코딩 기본값). 키 없는 모델은 숨김.
    const avail = BUILD_MODELS.filter(keyFor);
    res.json({ models: ["auto", ...avail], default: "auto" });
  });

  // 생성/수정 — 프롬프트 → HTML (model='auto' 면 비용 최소화 사다리)
  r.post("/api/artifacts/build", gate, async (req, res) => {
    if (!costLimitAllowed("build", costUserKey(req, getSessionUser(req)), BUILD_PER_MIN, BUILD_PER_DAY))
      return res.status(429).json({ error: "생성 요청이 잠시 많습니다. 잠시 후 다시 시도해 주세요." });
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "무엇을 만들지 설명해 주세요." });
    let model = String(req.body.model || "auto");
    if (model !== "auto" && !BUILD_MODELS.includes(model)) model = "auto";
    if (model !== "auto" && !keyFor(model))
      return res.status(503).json({ error: `${isGpt(model) ? "GPT_API_KEY" : "ANTHROPIC_API_KEY"} 가 없습니다.` });
    const currentHtml = req.body.currentHtml ? String(req.body.currentHtml).slice(0, 200000) : "";
    // 생성/업로드한 이미지 URL 을 프롬프트에 첨부 → AI 가 <img src> 로 삽입.
    const imgs = Array.isArray(req.body.images) ? req.body.images.filter((u) => typeof u === "string").slice(0, 8) : [];
    const fullPrompt = imgs.length
      ? `${prompt}\n\n[사용 가능한 이미지 URL — 필요하면 <img src="..."> 로 삽입하세요]\n${imgs.join("\n")}`
      : prompt;
    // 채팅형 스튜디오: 이전 대화 맥락(history) + '뭘 바꿨는지' 요약(summary) 지원.
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const wantSummary = req.body.summary === true || req.body.chat === true;
    // 디자인 모드(슬라이드 덱·프로토타입·시안 비교·모바일 목업) — 출력은 프로젝트 형식.
    const designMode = req.body.design === true;
    // 멀티파일 프로젝트 모드: 현재 프로젝트 파일들을 받아 전체를 다시 출력. (디자인 모드도 프로젝트 형식.)
    const projectMode = req.body.project === true || designMode;
    const projectFiles = Array.isArray(req.body.projectFiles) ? req.body.projectFiles : null;
    const userText = projectMode
      ? composeProjectText(fullPrompt, projectFiles, history)
      : composeUserText(fullPrompt, currentHtml, history);
    try {
      const out = await buildResolved(model, userText, wantSummary, projectMode, designMode);
      if (projectMode) {
        if (!out.files || !out.files.length)
          return res.status(502).json({ error: "AI가 프로젝트 파일을 만들지 못했습니다. 다시 시도해 주세요." });
        return res.json({
          files: out.files,
          entry: out.entry || "index.html",
          summary: out.summary || "",
          model: out.model,
          auto: out.auto,
        });
      }
      if (!out.html || !/<\/html>/i.test(out.html))
        return res.status(502).json({ error: "AI가 완결된 HTML을 만들지 못했습니다. 다시 시도해 주세요." });
      res.json({ html: out.html, summary: out.summary || "", model: out.model, auto: out.auto });
    } catch (e) {
      console.error("[artifacts] build:", e.message);
      res.status(500).json({ error: e.message || "생성 실패" });
    }
  });

  // ── 스튜디오 의도 라우터 ──────────────────────────────────────────────────
  // 사용자 메시지 + 첨부 파일 목록 → 무엇을 할지 분류:
  //   chat(파일 대화) / generate(문서 생성, reportType+fileRoles) / app / image / ask(되묻기)
  // 빠르고 싼 모델로 JSON 한 덩어리만 받는다. 실패 시 안전하게 chat 으로 폴백.
  const ROUTER_MODEL = process.env.STUDIO_ROUTER_MODEL || "claude-haiku-4-5";
  const GEN_TYPES = new Set(["cap-translate"]);
  const ROUTER_SYS =
    "You are the intent router for Quilo Studio. Decide what the user wants and reply with ONE JSON object only " +
    "(no prose, no markdown fence).\n\n" +
    "Capabilities (action):\n" +
    '- "chat": answer/discuss/analyze the attached files or general Q&A. This is the DEFAULT when unsure or the user just asks something. Never makes a downloadable file.\n' +
    '- "generate": produce a downloadable document. reportType is one of:\n' +
    '   - "cap-translate": PASCO Capstone .cap 화면 텍스트 번역본. Needs exactly one .cap → field "cap".\n' +
    '- "app": build or modify a self-contained web app/widget/tool/page (HTML).\n' +
    '- "design": create a DESIGN artifact — slide deck/presentation(프레젠테이션·슬라이드·덱·PPT), clickable hi-fi prototype(프로토타입·목업·시안), design canvas comparing options, or a mobile app mockup. Choose this over "app" when the user wants a presentation, mockup, prototype, slides, or visual design comparison rather than a working tool.\n' +
    '- "image": generate an image/illustration/icon.\n' +
    '- "ask": you need clarification — required file missing, or ambiguous which attached file plays which role. Put a short Korean question in "ask".\n\n' +
    'Map each provided filename to a field in "fileRoles" for generate. If a generate intent is missing the required .cap file, use "ask".\n' +
    'CRITICAL: if the user asks to MAKE / BUILD / CREATE something runnable or visual — a game, app, widget, tool, calculator, page, website, dashboard, form, chart, animation, etc. (Korean 만들어/만들어줘/짜줘/제작해/그려줘) — choose "app" (or "design" for a slide deck/presentation/prototype/mockup/시안). NEVER route a build request to "chat": chat only writes the code as TEXT and does NOT build or render it. Examples: "반응속도 게임 만들어줘"→app, "계산기 만들어줘"→app, "투표 위젯 만들어줘"→app, "랜딩페이지 만들어줘"→app, "슬라이드 덱 만들어줘"→design, "모바일 앱 목업"→design.\n' +
    'Use "chat" ONLY for genuine questions / discussion / analyzing attached files when NO artifact is requested. Use "generate" only when they clearly want a finished document/exam/translation FILE.\n\n' +
    'Reply JSON exactly: {"action":"chat|generate|app|design|image|ask","reportType":null,"fileRoles":{},"ask":null,"reply":"<one short Korean sentence about what you will do>"}';

  r.post("/api/studio/route", gate, async (req, res) => {
    if (!costLimitAllowed("route", costUserKey(req, getSessionUser(req)), 30, 600))
      return res.status(429).json({ error: "요청이 잠시 많습니다. 잠시 후 다시 시도해 주세요." });
    if (!hasClaude())
      return res.status(503).json({ error: "ANTHROPIC_API_KEY 가 없습니다." });
    const message = String(req.body.message || "").slice(0, 4000);
    const files = (Array.isArray(req.body.files) ? req.body.files : [])
      .slice(0, 12)
      .map((f) => ({
        name: String((f && f.name) || "").slice(0, 200),
        type: String((f && f.type) || "").slice(0, 80),
        sizeKB: Math.round(Number((f && f.sizeKB) || 0)),
      }));
    const history = (Array.isArray(req.body.history) ? req.body.history : [])
      .slice(-4)
      .map((m) => `${m.role}: ${String(m.content || "").slice(0, 300)}`)
      .join("\n");
    const userText =
      `사용자 메시지: ${message || "(없음)"}\n` +
      `첨부 파일: ${files.length ? JSON.stringify(files) : "없음"}\n` +
      (history ? `최근 대화:\n${history}\n` : "") +
      `\n위를 보고 JSON 한 개로만 답하세요.`;
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await client.messages.create({
        model: ROUTER_MODEL,
        max_tokens: 700,
        system: ROUTER_SYS,
        messages: [{ role: "user", content: userText }],
      });
      const text = (msg.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      let parsed = null;
      try {
        const m = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(m ? m[0] : text);
      } catch (_) {
        parsed = null;
      }
      const out = {
        action: "chat",
        reportType: null,
        fileRoles: {},
        ask: null,
        reply: "",
      };
      if (parsed && typeof parsed === "object") {
        const a = String(parsed.action || "chat");
        out.action = ["chat", "generate", "app", "design", "image", "ask"].includes(a)
          ? a
          : "chat";
        if (out.action === "generate") {
          out.reportType = GEN_TYPES.has(parsed.reportType)
            ? parsed.reportType
            : null;
          if (!out.reportType) out.action = "chat"; // 종류 불명 → 안전하게 대화
          // fileRoles 방향 정규화 → 항상 {파일명: 필드}. 모델이 {필드: 파일명}으로 줄 때도 보정.
          const KNOWN_FIELDS = new Set([
            "cap",
          ]);
          const raw =
            parsed.fileRoles && typeof parsed.fileRoles === "object"
              ? parsed.fileRoles
              : {};
          const norm = {};
          for (const k of Object.keys(raw)) {
            const v = raw[k];
            if (typeof v !== "string" || typeof k !== "string") continue;
            if (KNOWN_FIELDS.has(k) && !KNOWN_FIELDS.has(v)) norm[v] = k;
            else norm[k] = v;
          }
          out.fileRoles = norm;
        }
        out.ask = parsed.ask ? String(parsed.ask).slice(0, 500) : null;
        out.reply = parsed.reply ? String(parsed.reply).slice(0, 300) : "";
      }
      res.json(out);
    } catch (e) {
      console.error("[studio] route:", e.message);
      // 라우팅 실패는 치명적이지 않게 — 대화로 폴백.
      res.json({ action: "chat", reportType: null, fileRoles: {}, ask: null, reply: "" });
    }
  });

  // 이미지 생성 모델 목록(이미지 모드 드롭다운용)
  r.get("/api/artifacts/image-models", gate, (req, res) => {
    const has = !!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY);
    res.json({ models: has ? IMAGE_MODELS : [], default: "auto", std: IMAGE_STD, high: IMAGE_HIGH });
  });

  // 이미지 생성(auto 라우팅: 고화질이면 gpt-image-2, 아니면 gpt-image-1) → 저장 → URL
  r.post("/api/artifacts/image", gate, async (req, res) => {
    if (!costLimitAllowed("image", costUserKey(req, getSessionUser(req)), IMAGE_PER_MIN, IMAGE_PER_DAY))
      return res.status(429).json({ error: "이미지 생성 요청이 잠시 많습니다. 잠시 후 다시 시도해 주세요." });
    const prompt = String(req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "이미지 설명을 적어주세요." });
    try {
      const out = await genImage(prompt, { size: req.body.size, model: req.body.model });
      const url = await uploadMedia(Buffer.from(out.b64, "base64"), "png", "image/png");
      res.json({ url, model: out.model, tier: out.tier, auto: !!out.auto, fallback: !!out.fallback });
    } catch (e) {
      console.error("[artifacts] image:", e.message);
      res.status(500).json({ error: e.message || "이미지 생성 실패" });
    }
  });

  // 이미지 업로드 (dataURL JSON) → 저장 → URL
  r.post("/api/artifacts/upload", gate, async (req, res) => {
    const dataUrl = String(req.body.dataUrl || "");
    const m = dataUrl.match(/^data:(image\/(png|jpe?g|gif|webp|svg\+xml));base64,([\s\S]+)$/i);
    if (!m) return res.status(400).json({ error: "이미지 파일(data URL)이 아닙니다." });
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 6 * 1024 * 1024) return res.status(413).json({ error: "이미지가 너무 큽니다(6MB 이하)." });
    const ext = m[2].replace("jpeg", "jpg").replace("svg+xml", "svg");
    try {
      res.json({ url: await uploadMedia(buf, ext, m[1]) });
    } catch (e) {
      res.status(500).json({ error: e.message || "업로드 실패" });
    }
  });

  // 목록(내가 관리할 것) — 관리자=전체, 베타=본인 것
  r.get("/api/artifacts", gate, async (req, res) => {
    try {
      const u = getSessionUser(req) || {};
      res.json({ artifacts: await storeList({ ownerId: u.id || null, isAdmin: !!u.isAdmin }), persistent: tableOk === true });
    } catch (e) {
      res.status(500).json({ error: "목록을 불러오지 못했습니다." });
    }
  });

  // 저장/게시 (upsert)
  r.post("/api/artifacts", gate, async (req, res) => {
    const title = String(req.body.title || "").trim() || "제목 없음";
    const html = String(req.body.html || "");
    if (!/<\/html>/i.test(html)) return res.status(400).json({ error: "저장할 HTML이 비어 있거나 완결되지 않았습니다." });
    let slug = slugify(req.body.slug || title);
    const sessUser = getSessionUser(req) || {};
    const owner = sessUser.name || "admin"; // 표시용(중복 가능)
    const ownerId = sessUser.id || null; // 소유권 판정 기준(불변)
    // 새 slug면 충돌 시 숫자 suffix
    const existing = await storeGet(slug);
    if (existing && String(req.body.slug || "") !== slug && !req.body.overwrite) {
      slug = `${slug}-${Math.floor(Date.now() / 1000) % 100000}`;
    }
    let prev = await storeGet(slug);
    // 소유권 가드: 기존 slug 의 주인이 다른 사용자면 덮어쓰기 거부.
    // 충돌 회피를 위해 새 slug 로 재명명한다(타인 작품을 가로채거나 노출시키지 않음).
    if (prev && !canManage(req, prev)) {
      slug = `${slug}-${Math.floor(Date.now() / 1000) % 100000}`;
      prev = await storeGet(slug);
      if (prev && !canManage(req, prev)) {
        return res.status(409).json({ error: "이미 사용 중인 주소입니다. 다른 제목/주소로 저장해 주세요." });
      }
    }
    const rec = {
      id: (prev && prev.id) || crypto.randomUUID(),
      slug,
      title,
      html,
      is_public: req.body.isPublic !== false,
      owner,
      owner_id: ownerId || (prev && prev.owner_id) || null,
      category: String(req.body.category || "").slice(0, 24) || "기타",
      likes: (prev && prev.likes) || 0,
      views: (prev && prev.views) || 0,
      forked_from: (prev && prev.forked_from) || (req.body.forkedFrom ? String(req.body.forkedFrom).slice(0, 80) : null),
      created_at: (prev && prev.created_at) || nowIso(),
      updated_at: nowIso(),
    };
    try {
      await storeUpsert(rec);
      res.json({ ok: true, slug, url: `/p/${encodeURIComponent(slug)}`, persistent: tableOk === true });
    } catch (e) {
      res.status(500).json({ error: e.message || "저장 실패" });
    }
  });

  // 편집용 원본 HTML 가져오기 — 관리자 또는 본인 작품만(타인 비공개·공개 모두 차단).
  r.get("/api/artifacts/:slug/raw", gate, async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).json({ error: "없음" });
    if (!canManage(req, rec)) return res.status(404).json({ error: "없음" });
    res.json({ slug: rec.slug, title: rec.title, html: rec.html, is_public: rec.is_public });
  });

  // 삭제 — 관리자 또는 본인 작품만. :id 는 id(UUID) 또는 slug 일 수 있다.
  r.delete("/api/artifacts/:id", gate, async (req, res) => {
    const idOrSlug = req.params.id;
    const rec = await storeFind(idOrSlug);
    // 레코드가 있는데 본인 것이 아니면 거부. 못 찾으면 멱등 삭제(기존 동작 유지).
    if (rec && !canManage(req, rec)) return res.status(403).json({ error: "본인 작품만 삭제할 수 있습니다." });
    await storeDelete(idOrSlug);
    res.json({ ok: true });
  });

  // ── KV(공유 데이터) API — sandbox iframe(null origin)에서 호출하므로 CORS 허용 ──
  const kvCors = (req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET,PUT,POST,OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
  const kvClientIp = (req) => String(req.ip || "?");
  async function kvSlugOk(slug) {
    const rec = await storeGet(slug);
    return rec && rec.is_public; // 공개 아티팩트만 KV 사용
  }

  r.options("/api/kv/:slug", kvCors);
  r.options("/api/kv/:slug/:key", kvCors);
  r.options("/api/kv/:slug/:key/push", kvCors);

  r.get("/api/kv/:slug", kvCors, async (req, res) => {
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    try { res.json(await kvAll(req.params.slug)); } catch { res.status(500).json({ error: "read fail" }); }
  });

  r.put("/api/kv/:slug/:key", kvCors, async (req, res) => {
    if (!kvWriteAllowed(kvClientIp(req))) return res.status(429).json({ error: "rate limit" });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const v = req.body && req.body.value;
    if (JSON.stringify(v ?? null).length > KV_MAX_VAL) return res.status(413).json({ error: "값이 너무 큽니다" });
    try { await kvSet(req.params.slug, String(req.params.key).slice(0, 64), v); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // AI 프록시 — 아티팩트 앱(sandbox)이 호출. 공개 아티팩트 한정, 강한 레이트리밋.
  r.options("/api/ai/:slug", kvCors);
  r.post("/api/ai/:slug", kvCors, async (req, res) => {
    const ip = kvClientIp(req);
    const auth = String(req.get("authorization") || "");
    const token = auth.replace(/^Bearer\s+/i, "");
    const payload = verifyAiToken(token, req.params.slug);
    if (!payload) return res.status(401).json({ error: "AI 인증이 필요합니다." });
    if (
      !aiAllowed("ip:" + ip, 10) ||
      !aiAllowed("slug:" + req.params.slug, 30) ||
      !aiAllowed("user:" + payload.uid, 20)
    )
      return res.status(429).json({ error: "AI 사용량이 잠시 많습니다. 잠시 후 다시." });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const prompt = String(req.body && req.body.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "prompt 가 필요합니다." });
    try {
      res.json({ text: await callAiText(prompt, req.body && req.body.system) });
    } catch (e) {
      res.status(500).json({ error: "AI 오류" });
    }
  });

  // 앱 사용자 파일 업로드(QuiloDB.upload) — sandbox 앱에서 호출(CORS). 이미지 한정·캡.
  r.options("/api/media/:slug", kvCors);
  r.post("/api/media/:slug", kvCors, async (req, res) => {
    if (!kvWriteAllowed(kvClientIp(req))) return res.status(429).json({ error: "rate limit" });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const dataUrl = String(req.body && req.body.dataUrl || "");
    const m = dataUrl.match(/^data:(image\/(png|jpe?g|gif|webp));base64,([\s\S]+)$/i);
    if (!m) return res.status(400).json({ error: "이미지만 업로드 가능합니다." });
    const buf = Buffer.from(m[3], "base64");
    if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: "4MB 이하만" });
    try { res.json({ url: await uploadMedia(buf, m[2].replace("jpeg", "jpg"), m[1]) }); }
    catch (e) { res.status(500).json({ error: "업로드 실패" }); }
  });

  r.post("/api/kv/:slug/:key/push", kvCors, async (req, res) => {
    if (!kvWriteAllowed(kvClientIp(req))) return res.status(429).json({ error: "rate limit" });
    if (!(await kvSlugOk(req.params.slug))) return res.status(404).json({ error: "없음" });
    const item = req.body && req.body.item;
    if (JSON.stringify(item ?? null).length > KV_MAX_VAL) return res.status(413).json({ error: "값이 너무 큽니다" });
    try { const n = await kvPush(req.params.slug, String(req.params.key).slice(0, 64), item); res.json({ ok: true, length: n }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 게시 페이지 — sandbox iframe 으로 격리 제공 + QuiloDB(공유 저장) 주입
  r.get("/p/:slug", async (req, res) => {
    const rec = await storeGet(req.params.slug);
    if (!rec) return res.status(404).type("html").send("<h1>404</h1><p>없는 페이지입니다.</p>");
    if (!rec.is_public) {
      const u =
        typeof refreshSessionUser === "function"
          ? await refreshSessionUser(req).catch(() => null)
          : getSessionUser(req);
      if (!u || !u.isAdmin) return res.status(403).type("html").send("<h1>403</h1><p>비공개 페이지입니다.</p>");
    }
    if (rec.is_public) storeView(rec.slug).catch(() => {}); // 조회수 +1 (비동기)
    const title = String(rec.title || "아티팩트").replace(/[<>&"]/g, "");
    const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`;
    // QuiloDB 헬퍼를 아티팩트 HTML 앞에 주입(공개 아티팩트만 KV 동작).
    const aiToken = rec.is_public ? signAiToken(rec.slug, getSessionUser(req)) : "";
    const inner = rec.is_public ? quiloDbScript(base, rec.slug, aiToken) + rec.html : rec.html;
    res.type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100vh;display:block}</style>
</head><body>
<iframe sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads" srcdoc="${escapeForSrcdoc(inner)}"></iframe>
</body></html>`);
  });

  return r;
};
