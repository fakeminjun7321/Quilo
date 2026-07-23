// 독서활동 기록지 (독서록) — 콘텐츠 생성
//
// 입력: 도서명(+선택 저자/출판사/영역/교과/대출/날짜) + 참고 메모(userNotes)
// 출력: prompt.md 스키마를 따르는 JSON (author / publisher / selection_reason /
//        content_summary / reflection) + 양식 채우기에 필요한 메타데이터.
//
// 출력 분량이 짧아(세 서술 항목) 단일 non-stream messages.create 로 충분하다.
// 호스팅 스트림 수명 컷오프(~150s) 위험 구간에 한참 못 미친다.

const Anthropic = require("@anthropic-ai/sdk");
const byok = require("../../byok");
const fs = require("fs");
const path = require("path");
const { calcCost, formatCostLine } = require("../../pricing");
const { parseJsonLenient } = require("../../json-sanitize");
const { extractJson } = require("../../claude-stream");
const { isGptModel, callGptReport } = require("../../model-call");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = Math.min(parseInt(process.env.MAX_TOKENS || "32000", 10), 8000);

const SKILL_PATH = path.join(__dirname, "prompt.md");
function loadSkill() {
  return fs.readFileSync(SKILL_PATH, "utf8");
}

// 영역 코드 → (큰 분류, 표시 라벨). index.html 의 select 값과 일치해야 한다.
const DOMAIN_MAP = {
  "major-math": ["전공도서", "수학"],
  "major-physics": ["전공도서", "물리"],
  "major-chemistry": ["전공도서", "화학"],
  "major-biology": ["전공도서", "생명과학"],
  "major-earth": ["전공도서", "지구과학"],
  "major-cs": ["전공도서", "정보과학"],
  "general-philosophy": ["일반도서", "교양·철학·종교"],
  "general-social": ["일반도서", "사회과학"],
  "general-science-art": ["일반도서", "과학·예술·언어"],
  "general-literature": ["일반도서", "문학"],
  "general-history": ["일반도서", "역사"],
  "general-classics": ["일반도서", "고전"],
};

// 전공도서 분야(domain) → 그 분야로 볼 만한 수강 과목 이름 키워드.
// 학생이 수강 중인 과목(enrolledSubjects) 중 이 키워드에 걸리는 것이 있으면
// "과목별 독서기록"으로, 없으면(수학·지구과학·정보 등 미수강) "공통 독서기록"으로 본다.
const DOMAIN_SUBJECT_KEYWORDS = {
  "major-physics": ["물리"],
  "major-chemistry": ["화학"],
  "major-biology": ["생명", "생물"],
  "major-math": ["수학", "미적", "기하", "대수", "확률", "통계", "해석학", "정수론"],
  "major-earth": ["지구", "천체", "천문", "지질", "대기", "해양"],
  "major-cs": ["정보", "컴퓨터", "프로그", "알고리즘", "코딩", "전산"],
};

function parseEnrolledSubjects(v) {
  if (Array.isArray(v)) {
    return v.map((s) => String(s || "").trim()).filter(Boolean);
  }
  return String(v || "")
    .split(/[,\n;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 이 책(domain)에 해당하는 수강 과목 후보(enrolled 중 키워드 매칭).
function subjectCandidates(domain, enrolled) {
  const kws = DOMAIN_SUBJECT_KEYWORDS[domain] || [];
  if (!kws.length) return [];
  return enrolled.filter((s) => kws.some((k) => s.includes(k)));
}

// 학생부 기록영역 자동 결정.
// - 일반도서 → 공통
// - 전공도서 + 수강 과목 매칭 → 과목별(그 과목)
// - 전공도서 + 미수강(후보 없음) → 공통
// aiPick 은 후보가 2개 이상일 때 AI가 고른 과목(검증 후 사용).
function deriveRecordArea(domain, domainGroup, enrolled, aiPick) {
  if (domainGroup !== "전공도서") return { recordArea: "common", subject: "" };
  const cands = subjectCandidates(domain, enrolled);
  if (cands.length === 0) return { recordArea: "common", subject: "" };
  if (cands.length === 1) return { recordArea: "subject", subject: cands[0] };
  const pick = aiPick && cands.includes(aiPick) ? aiPick : cands[0];
  return { recordArea: "subject", subject: pick };
}

// YYYY-MM-DD → "YYYY년 M월 D일". 형식이 어긋나면 원문 그대로.
function fmtKoreanDate(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return String(s || "").trim();
  return `${m[1]}년 ${parseInt(m[2], 10)}월 ${parseInt(m[3], 10)}일`;
}

function buildDateRange(startDate, endDate) {
  const a = fmtKoreanDate(startDate);
  const b = fmtKoreanDate(endDate);
  if (a && b) return `${a} ~ ${b}`;
  if (a) return a;
  if (b) return b;
  return "";
}

function toParas(v) {
  if (Array.isArray(v)) {
    return v.map((x) => String(x == null ? "" : x).trim()).filter(Boolean);
  }
  const s = String(v == null ? "" : v).trim();
  if (!s) return [];
  return s.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
}

// 서술 항목을 '한 문단, 최대 ~6줄'로 강제한다. 양식 칸은 한 줄에 한글 약 40자라
// 6줄 ≈ 약 235자. 모델이 길게 쓰면 한 문단으로 합친 뒤 문장 경계에서 잘라 6줄을
// 넘지 않게 한다. (최소 분량은 prompt.md 가 담당 — 여기서는 과다 분량만 막는다.)
const SECTION_MAX_CHARS = 235;
function clampSection(paras, maxChars = SECTION_MAX_CHARS) {
  let text = (Array.isArray(paras) ? paras : [paras])
    .map((p) => String(p == null ? "" : p).trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [];
  if (text.length > maxChars) {
    const slice = text.slice(0, maxChars);
    const idx = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("."),
      slice.lastIndexOf("!"),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("。"),
    );
    if (idx >= maxChars * 0.5) {
      text = slice.slice(0, idx + 1).trim();
    } else {
      const sp = slice.lastIndexOf(" ");
      text =
        (sp >= maxChars * 0.5 ? slice.slice(0, sp) : slice).replace(/[\s,·]+$/, "") +
        ".";
    }
  }
  return [text];
}

// 저자 표기 정규화: 2명 이상이면 "대표저자 외". 이미 "외" 형식이면 대표저자만 남긴다.
// 쉼표·세미콜론·가운뎃점 등 명시적 구분자만 분리(한국어 이름 속 '와/과'는 건드리지 않음).
function formatAuthor(s) {
  const raw = String(s || "").trim();
  if (!raw) return "";
  if (/\s*외\s*\d*\s*명?\s*$/.test(raw)) {
    const head = raw
      .split(/\s*[,;·、/&]\s*/)[0]
      .replace(/\s*외\s*\d*\s*명?\s*$/, "")
      .trim();
    return head ? `${head} 외` : raw;
  }
  const parts = raw
    .split(/\s*[,;·、/&]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length >= 2) return `${parts[0]} 외`;
  return raw;
}

// 두 도서명이 '같은 책'인지(오타·띄어쓰기 차이 정도인지) 판단.
// 약한 모델이 book_title 을 엉뚱한 책(예: '코스모스')으로 바꾸는 것을 막되,
// '코스모드'→'코스모스' 같은 진짜 오타 교정은 허용하기 위함.
function titlesSimilar(a, b) {
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[\s·,.\-:()[\]'"!?~/]+/g, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // 포함(부분 문자열) 관계는 길이 차가 크면 '같은 책'이 아니다.
  // 예: '정석' ⊂ '수학의 정석' — 짧은 입력이 다른 책 제목의 일부라 바꿔치기됨.
  // 짧은/긴 길이 비율이 0.6 이상일 때만 표기 차이로 인정한다.
  if (na.includes(nb) || nb.includes(na)) {
    return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) >= 0.6;
  }
  // 공통 접두 길이 비율이 0.6 이상이면 같은 책의 표기 차이로 본다.
  let i = 0;
  while (i < na.length && i < nb.length && na[i] === nb[i]) i++;
  return i / Math.max(na.length, nb.length) >= 0.6;
}

async function generateReportContent({
  bookTitle = "",
  author = "",
  publisher = "",
  recordArea = "",
  subject = "",
  domain = "",
  borrowed = "",
  startDate = "",
  endDate = "",
  enrolledSubjects = [],
  userNotes = "",
  reasonSeed = "", // bulk 균질화 방지용 계기 유형 힌트(선택) — bulk.js가 회전 주입
  fontFace,
  date,
  model = null,
  signal,
  onProgress = () => {},
}) {
  const title = String(bookTitle || "").trim();
  if (!title) throw new Error("도서명이 비어 있습니다.");

  const [domainGroup, domainLabel] = DOMAIN_MAP[domain] || ["", ""];
  const dateRange = buildDateRange(startDate, endDate);
  const enrolled = parseEnrolledSubjects(enrolledSubjects);

  // 학생부 기록영역 모드: "auto"(영역·수강과목 기준 자동) / "subject" / "common" / ""(표시 안 함).
  // 빈 값이라도 수강 과목이 주어졌으면 자동으로 본다(대량 생성 기본).
  const recordMode =
    recordArea === "auto" || (recordArea === "" && enrolled.length)
      ? "auto"
      : recordArea;
  // 자동 모드에서 과목 후보가 2개 이상이면(예: 화학→일반화학1·유기화학) AI 가 책 내용에
  // 더 맞는 하나를 고르도록 후보를 프롬프트에 넣는다.
  const autoCands = recordMode === "auto" ? subjectCandidates(domain, enrolled) : [];

  const MODEL = model || DEFAULT_MODEL;

  // ── 사용자 입력 → 프롬프트 컨텍스트 ──────────────────────────────────
  const lines = [];
  lines.push(`도서명: ${title}`);
  if (author) lines.push(`저자(사용자 입력): ${author}`);
  if (publisher) lines.push(`출판사(사용자 입력): ${publisher}`);
  if (domainGroup) lines.push(`독서 영역: ${domainGroup} - ${domainLabel}`);
  if (recordMode === "subject")
    lines.push(`학생부 기록: 과목별 독서기록${subject ? ` (교과명: ${subject})` : ""}`);
  else if (recordMode === "common") lines.push("학생부 기록: 공통 독서기록");
  if (autoCands.length > 1)
    lines.push(
      `과목 후보(이 책 내용에 가장 가까운 하나를 'subject'로 골라라): ${autoCands.join(" / ")}`,
    );

  let userMessage =
    "아래 책에 대한 독서활동 기록지를 작성한다.\n\n" + lines.join("\n");
  if (String(userNotes || "").trim()) {
    userMessage +=
      "\n\n[참고 메모 — 학생 본인의 감상·관점. 최우선 반영하되 과장·날조 금지]\n" +
      String(userNotes).trim().slice(0, 8000);
  }
  if (String(reasonSeed || "").trim()) {
    userMessage +=
      `\n\n[계기 유형 힌트] 선택 계기는 가능하면 '${String(reasonSeed).trim()}' 방향으로 구성하라. ` +
      "책과 자연스럽게 맞지 않으면 무시해도 된다.";
  }
  userMessage +=
    "\n\n위 정보를 바탕으로 prompt.md 스키마(_plan 먼저, 그다음 author/publisher/selection_reason/content_summary/reflection)를 따르는 JSON 한 블록만 출력하라.";
  // 책 바꿔치기 이력이 있는 GPT 계열엔 대상 도서를 말미에 한 번 더 못박는다.
  if (isGptModel(MODEL)) {
    userMessage += `\n\n[대상 도서 재확인] 반드시 "${title}" 이 책에 대해서만 쓴다. 같은 분야의 다른 유명 도서(예: 더 잘 알려진 책)의 내용·저자·인물로 대체하는 것은 실패다.`;
  }

  onProgress("📖 독서록 초안을 작성하는 중…");

  // 모델 1회 호출 → JSON 파싱 → 본문 3항목 추출. 본문이 비거나 JSON 파싱에 실패하면
  // null 을 돌려주어 바깥 루프가 재시도하게 한다. (gpt-5.4-mini 같은 작은 추론 모델은
  // 가끔 본문이 빈 JSON 을 반환한다 — 이때 한 번에 실패시키지 않고 다시 생성한다.)
  async function attemptGenerate() {
    let finalText;
    let usage = null; // 실제 소비 토큰(크레딧 정산용) — { input_tokens, output_tokens, ... }
    if (isGptModel(MODEL)) {
      // GPT(OpenAI) 경로 — 단일 호출, JSON 응답.
      const gpt = await callGptReport({
        model: MODEL,
        system: loadSkill(),
        content: userMessage,
        maxTokens: MAX_TOKENS,
        jsonObject: true,
        signal,
        onProgress,
      });
      finalText = gpt.text;
      usage = gpt.usage || null;
      try {
        const cost = calcCost({ usage: gpt.usage, model: MODEL });
        if (cost) onProgress(formatCostLine(cost));
      } catch (_) {
        /* 비용 표기는 부가 정보 — 실패해도 무시 */
      }
    } else {
      // Claude(Anthropic) 경로.
      const client = new Anthropic({
        apiKey: byok.anthropicKey(),
        timeout: 10 * 60 * 1000,
      });
      const resp = await client.messages.create(
        {
          model: MODEL,
          max_tokens: MAX_TOKENS,
          // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
          ...(/fable/i.test(MODEL || "") ? {} : { thinking: { type: "disabled" } }),
          // ⚠ temperature 금지: Sonnet 5·Opus 4.8 모두 deprecated 400 으로 거부(2026-07-03 실측).
          // 문장 리듬 다양화는 prompt.md 의 '문장 리듬' 규칙이 담당한다.
          system: loadSkill(),
          messages: [{ role: "user", content: userMessage }],
        },
        { signal },
      );
      usage = resp.usage || null;
      try {
        const cost = calcCost({ usage: resp.usage, model: MODEL });
        if (cost) onProgress(formatCostLine(cost));
      } catch (_) {
        /* 비용 표기는 부가 정보 — 실패해도 무시 */
      }
      finalText = (resp.content || [])
        .filter((b) => b && b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }

    let p;
    try {
      p = parseJsonLenient(extractJson(finalText));
    } catch (_) {
      return null; // JSON 파싱 실패 → 재시도 대상
    }
    if (!p || typeof p !== "object") return null;
    // p._plan(작성 전 grounding 계획)은 여기서 읽지 않으므로 자동 폐기된다 — hwpx 미출력.

    // 각 항목을 한 문단·최대 ~6줄로 압축(과다 분량 방지). 최소 분량은 prompt.md 가 담당.
    const sr = clampSection(toParas(p.selection_reason));
    const cs = clampSection(toParas(p.content_summary));
    const rf = clampSection(toParas(p.reflection));
    if (!sr.length && !cs.length && !rf.length) return null; // 본문이 빈 응답 → 재시도
    return { parsed: p, selectionReason: sr, contentSummary: cs, reflection: rf, usage };
  }

  let attemptResult = null;
  for (let attempt = 1; attempt <= 3 && !attemptResult; attempt++) {
    if (attempt > 1) onProgress(`↻ 본문이 비어 다시 생성합니다… (${attempt}/3)`);
    attemptResult = await attemptGenerate();
  }
  if (!attemptResult) {
    throw new Error("AI 가 본문 내용을 만들지 못했습니다. 다시 시도해 주세요.");
  }
  const { parsed, selectionReason, contentSummary, reflection, usage } =
    attemptResult;

  onProgress("✅ 독서록 초안 작성 완료 — 양식에 채우는 중…");

  // 도서명: AI 가 바로잡은 정식 제목을 우선(오타 교정), 없으면 입력값.
  // 도서명은 사용자 입력(엑셀/폼)을 신뢰한다. AI 가 돌려준 book_title 은 '같은 책'으로
  // 확인될 때(오타 교정 수준)만 채택하고, 그렇지 않으면 입력 제목을 그대로 쓴다.
  // (gpt-5.4-mini 등 약한 모델이 입력과 무관한 책 제목을 내놓는 사고를 차단.)
  const aiTitle = String(parsed.book_title || "").trim().slice(0, 200);
  const canonicalTitle =
    aiTitle && titlesSimilar(aiTitle, title) ? aiTitle : title;
  // 저자: 사용자 입력 우선, 없으면 AI 값. 2명 이상이면 "대표저자 외"로 정규화.
  const finalAuthor = formatAuthor(author || String(parsed.author || "").trim());
  const finalPublisher = publisher || String(parsed.publisher || "").trim();

  // 학생부 기록영역 확정.
  let finalRecordArea = "";
  let finalSubject = "";
  if (recordMode === "auto") {
    const d = deriveRecordArea(
      domain,
      domainGroup,
      enrolled,
      String(parsed.subject || "").trim(),
    );
    finalRecordArea = d.recordArea;
    finalSubject = d.subject;
  } else if (recordMode === "subject") {
    finalRecordArea = "subject";
    finalSubject = String(subject || "").trim();
  } else if (recordMode === "common") {
    finalRecordArea = "common";
  }

  const content = {
    title: canonicalTitle, // 파일명용
    book_title: canonicalTitle,
    author: finalAuthor,
    publisher: finalPublisher,
    record_area: finalRecordArea, // "subject" | "common" | ""
    subject: finalSubject,
    domain_group: domainGroup, // "전공도서" | "일반도서" | ""
    domain_label: domainLabel, // "물리" 등 | ""
    borrowed: borrowed, // "yes" | "no" | ""
    date_range: dateRange, // "YYYY년 M월 D일 ~ ..." | ""
    end_date: String(endDate || "").trim(), // 하단 확인 날짜용(읽기 종료일)
    selection_reason: selectionReason,
    content_summary: contentSummary,
    reflection: reflection,
    __fontFace: fontFace,
    __style: "default",
    // 크레딧 정산·통계용 — 이 책 생성에 실제 소비된 토큰과 그 비용(대량은 bulk 가 합산).
    __usage: usage || null,
    __cost: usage ? calcCost({ usage, model: MODEL }) : null,
  };

  // 콘텐츠 구조 검증(DEF-010) - 파싱·후처리(clampSection 등) 완료 지점.
  // 독서록은 hwpx 전용 파이프라인이므로 format 은 hwpx 고정.
  require("../../output-sanitize").assertContentSchema("reading-log", content, {
    format: "hwpx",
    onProgress,
  });

  return content;
}

module.exports = {
  generateReportContent,
  // 테스트·재사용용 내부 헬퍼
  deriveRecordArea,
  subjectCandidates,
  parseEnrolledSubjects,
  formatAuthor,
  clampSection,
  SECTION_MAX_CHARS,
  DOMAIN_MAP,
};
