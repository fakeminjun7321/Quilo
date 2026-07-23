"use strict";

const CATEGORIES = {
  reports: { title: "보고서·문서", description: "실험과 학업 자료를 제출 가능한 문서로 완성합니다." },
  study: { title: "학습·시험", description: "수행평가, 시험 대비, 심화 학습을 돕습니다." },
  create: { title: "창작·코딩", description: "웹 결과물, 코드, 문제와 아이디어를 만듭니다." },
  translate: { title: "번역·파일", description: "PDF, Capstone, 이미지와 문서를 변환합니다." },
  community: { title: "커뮤니티·지식", description: "Quilo의 사용자와 기술 문서를 연결합니다." },
  account: { title: "내 작업·연동", description: "작업, 파일, 크레딧과 외부 연동을 관리합니다." },
};

const FEATURE_KEYWORDS = Object.freeze({
  "chem-pre": ["화학 예비보고서", "화학 레포트", "사전 레포트", "pre lab"],
  "chem-result": ["화학 실험보고서", "화학 레포트", "결과 레포트", "post lab"],
  "phys-result": ["물리 실험보고서", "물리 레포트", "capstone", "캡스톤", "엑셀 보고서"],
  free: ["범용 보고서", "리포트", "레포트", "문서 작성"],
  "reading-log": ["독후감", "독서록", "독서 보고서"],
  "reading-log-bulk": ["독서록 여러개", "독후감 대량", "책 목록"],
  "problem-set": ["문제지", "시험지", "문제 생성", "워크북", "학습지"],
  "form-maker": ["서식", "템플릿", "양식 복원", "문서 사진"],
  "print-pdf-restore": ["프린트 복원", "사진 pdf 복원", "스캔 복원", "벡터 pdf", "수식 복원", "도해 복원", "ocr 검증"],
  "pdf-translate": ["번역", "통역", "translate", "영문 번역", "pdf 번역"],
  "cap-translate": ["cap 번역", "캡스톤 번역", "pasco 번역"],
  "file-convert": ["변환", "pdf 합치기", "이미지 변환", "엑셀 csv"],
  equation: ["수식 변환", "한글 수식", "latex", "hwpx 수식"],
  "image-ocr": ["사진 글자", "문자인식", "이미지 텍스트", "ocr"],
  "pdf-analysis": ["pdf 검사", "문서 분석", "스캔 확인"],
  "word-count": ["글자수", "문자수", "단어수", "word count"],
  statistics: ["통계", "평균", "표준편차", "중앙값"],
  regression: ["회귀", "추세선", "r2", "선형 회귀"],
  "unit-convert": ["단위", "환산", "단위 계산기"],
  "table-analysis": ["엑셀", "excel", "xlsx", "csv", "표 분석", "데이터 분석"],
  graph: ["차트", "그래프", "산점도", "막대그래프"],
  "file-chat": ["문서 질문", "파일 대화", "pdf 챗"],
  "quilo-schedule": ["학급 일정", "2학년 4반", "시간표", "반 공지", "학급 자료실"],
  "my-jobs": ["작업 내역", "생성 현황", "진행 상태"],
  "my-files": ["파일함", "생성 파일", "다운로드"],
});

const FEATURES = [
  feature("chem-pre", "화학 사전보고서", "reports", "실험 목표·이론·기구·시약·절차를 학교 양식으로 작성합니다.", "/?report=chem-pre", { kind: "pipeline", status: "active", audience: "member", formats: ["docx", "hwpx"], api: "reports:write" }),
  feature("chem-result", "화학 결과보고서", "reports", "측정 데이터와 사진으로 표·그래프·분석·오차·결론을 작성합니다.", "/?report=chem-result", { kind: "pipeline", status: "active", audience: "member", formats: ["docx", "hwpx"], api: "reports:write" }),
  feature("phys-result", "물리 결과보고서", "reports", "Capstone·엑셀·사진을 Part별 표·그래프·분석·결론으로 완성합니다.", "/?report=phys-result", { kind: "pipeline", status: "active", audience: "member", formats: ["docx", "hwpx"], api: "reports:write" }),
  feature("free", "자유 보고서", "reports", "주제와 평가기준에 맞춘 범용 보고서를 표·수식·그래프와 함께 만듭니다.", "/?report=free", { kind: "pipeline", status: "active", audience: "member", formats: ["docx", "hwpx"], api: "reports:write" }),
  feature("reading-log", "독서활동 기록지", "reports", "도서 정보와 독서 내용을 학교 독서록 양식에 맞춰 작성합니다.", "/?report=reading-log", { kind: "pipeline", status: "active", audience: "member", formats: ["hwpx"], api: "reports:write" }),
  feature("reading-log-bulk", "독서록 대량 생성", "reports", "책 목록을 받아 여러 독서록을 만들고 ZIP으로 묶습니다.", "/?report=reading-log-bulk", { kind: "pipeline", status: "active", audience: "member", formats: ["zip"], api: "reports:write" }),
  feature("problem-set", "문제집 메이커", "study", "교재 문제를 바탕으로 문제지·해설지 세트를 만듭니다.", "/?report=problem-set", { kind: "pipeline", status: "pro", audience: "pro", formats: ["zip"], api: "reports:write" }),
  feature("vocabulary-book", "단어장 메이커", "study", "영어교재 PDF, 기존 영어 단어장, Excel·CSV 표에서 출처가 확인된 표현을 골라 영한 단어장과 단원 평가를 만듭니다.", "/?report=vocabulary-book", { kind: "pipeline", status: "pro", audience: "pro", formats: ["pdf", "json", "zip"], api: "reports:write", keywords: ["단어장", "단어짱", "영단어", "영어 단어", "어휘", "보카", "vocabulary", "vocab", "영어교재", "엑셀 단어장"] }),
  feature("form-maker", "양식 메이커", "reports", "설명이나 종이 문서 사진으로 편집 가능한 양식을 복원합니다.", "/?report=form-maker", { kind: "pipeline", status: "pro", audience: "pro", formats: ["docx", "hwpx"], api: "reports:write" }),
  feature("print-pdf-restore", "프린트 PDF 복원", "reports", "종이 프린트 사진의 원문·수식·표·레이아웃을 벡터 PDF로 재구성하고, 그래프·도해를 맥락과 물리적 의미에 맞춰 다시 그린 뒤 300dpi OCR·시각 QA로 검증합니다.", "/?report=print-pdf-restore", { kind: "pipeline", status: "beta", audience: "admin", formats: ["pdf"], api: "reports:write" }),
  feature("phys-inquiry", "물리 수행평가", "study", "탐구와 사고 과정의 오개념·해결·성찰을 구조화합니다.", "/exam-prep.html", { kind: "pipeline", status: "paused", audience: "pro", formats: ["docx", "hwpx"] }),
  feature("math-inquiry", "수학 수행평가", "study", "필기와 탐구 주제로 수학 탐구보고서를 작성합니다.", "/exam-prep.html", { kind: "pipeline", status: "paused", audience: "pro", formats: ["docx", "hwpx"] }),
  feature("eng-exam-prep", "영어 시험대비 세트", "study", "지문에서 모의고사·개념정리·빈칸 학습지를 만듭니다.", "/exam-prep.html", { kind: "pipeline", status: "paused", audience: "pro", formats: ["zip"] }),
  feature("korean-lit-exam", "국어 문학 시험 세트", "study", "학습지와 문제은행으로 시험지·답안·해설을 만듭니다.", "/exam-prep.html", { kind: "pipeline", status: "paused", audience: "pro", formats: ["zip"] }),
  feature("phys-mock-exam", "물리 모의고사", "study", "기출과 교과서 단원으로 새 문제와 풀이를 만듭니다.", "/exam-prep.html", { kind: "pipeline", status: "paused", audience: "pro", formats: ["zip"] }),
  feature("pdf-translate", "PDF 통번역", "translate", "일반 PDF·스캔본·수식 문서를 분석해 번역하거나 깨끗하게 재조판합니다.", "/translate.html", { kind: "workspace", status: "max", audience: "max", formats: ["pdf"], api: "translations:write" }),
  feature("cap-translate", "Capstone 번역", "translate", "PASCO Capstone 파일의 화면 텍스트만 번역하고 측정 데이터·센서·내부 구조는 보존한 .cap 파일을 만듭니다.", "/?report=cap-translate", { kind: "pipeline", status: "pro", audience: "pro", formats: ["cap"], api: "reports:write" }),
  feature("create", "창작 스튜디오", "create", "대화형 미리보기와 체크포인트로 웹 아티팩트를 생성·수정·저장·게시합니다.", "/create.html", { kind: "studio", status: "pro", audience: "pro", api: "studios:write" }),
  feature("vibe-coding", "바이브 코딩 생성기", "create", "아이디어 한 문장에서 프로젝트 구조와 구현 방향을 설계합니다.", "/vibe-coding.html", { kind: "studio", status: "pro", audience: "pro", api: "studios:write" }),
  feature("quilo-code", "Quilo Code", "create", "코드와 프로젝트 파일을 생성·수정·디버그하고 브라우저에서 미리 봅니다.", "/editor.html", { kind: "studio", status: "pro", audience: "pro", api: "studios:write" }),
  feature("physics-studio", "고급 물리 문제 스튜디오", "study", "주제와 난이도에 맞춘 심화 물리 문제와 풀이를 만듭니다.", "/physics-studio.html", { kind: "studio", status: "pro", audience: "pro", api: "studios:write" }),
  feature("file-chat", "파일 챗봇", "study", "업로드한 파일을 바탕으로 질문하고 답변을 받습니다.", "/filechat.html", { kind: "studio", status: "pro", audience: "pro", api: "chat:write" }),
  feature("coding-test", "코딩 수행평가 대비", "study", "브라우저 채점과 소크라테스식 튜터로 코딩 문제를 연습합니다.", "/exam-prep.html", { kind: "workspace", status: "pro", audience: "pro" }),
  feature("relativity-study", "상대론 학습", "study", "민코프스키 평면과 상대론 개념을 시각적으로 학습합니다.", "/study.html", { kind: "workspace", status: "pro", audience: "pro" }),
  feature("quilo-schedule", "Quilo schedule", "study", "등록된 2학년 4반 구성원이 개인 시간표·일정·공지·자료를 확인합니다.", "/schedule/", { kind: "workspace", status: "active", audience: "member", keywords: ["학급 일정", "2학년 4반", "시간표", "반 공지", "학급 자료실"] }),
  feature("word-count", "글자수 세기", "translate", "텍스트의 글자수와 분량을 API에서 계산합니다.", "/developers.html#catalog", { kind: "api-tool", status: "active", audience: "member", execution: "remote", api: "tools:read" }),
  feature("statistics", "기술통계", "translate", "숫자 배열의 평균·중앙값·표준편차·사분위수를 결정적으로 계산합니다.", "/developers.html", { kind: "api-tool", status: "active", audience: "member", api: "tools:read" }),
  feature("regression", "선형회귀·추세선", "translate", "데이터에서 회귀식과 결정계수를 API로 계산합니다.", "/developers.html#catalog", { kind: "api-tool", status: "active", audience: "member", execution: "remote", api: "tools:read" }),
  feature("unit-convert", "과학 단위 변환", "translate", "길이·질량·시간·온도·압력·에너지 등 과학 단위를 변환합니다.", "/developers.html", { kind: "api-tool", status: "active", audience: "member", api: "tools:read" }),
  feature("table-analysis", "CSV·Excel 분석", "translate", "CSV·Excel 시트와 숫자 열의 제한된 미리보기와 기술통계를 만듭니다.", "/developers.html", { kind: "api-tool", status: "active", audience: "member", api: "tools:read" }),
  feature("graph", "그래프 생성기", "translate", "데이터로 산점도, 선, 막대그래프를 API에서 만듭니다.", "/developers.html#catalog", { kind: "api-tool", status: "active", audience: "member", execution: "remote", api: "tools:read" }),
  feature("equation-notation", "수식 표기 변환", "translate", "LaTeX 스타일 수식을 읽기 쉬운 유니코드 표기로 변환합니다.", "/developers.html", { kind: "api-tool", status: "active", audience: "member", api: "tools:read" }),
  feature("file-convert", "파일·PDF 변환기", "translate", "표·이미지·PDF를 브라우저에서 변환하고 편집합니다.", "/tools/convert.html", { kind: "browser-tool", status: "active", audience: "public", execution: "local", api: "conversions:write" }),
  feature("equation", "LaTeX→한글 수식", "translate", "비영리 전용 제3자 구현을 분리했으며, 재라이선스 또는 독립 구현 기여를 기다리고 있습니다.", "/equation/index.html", { kind: "browser-tool", status: "paused", audience: "public", api: "documents:write" }),
  feature("image-ocr", "이미지 OCR", "translate", "사진·스크린샷을 4중 비교 판독하고 텍스트·수식·표는 편집 요소로, 감지 그림은 원본 크롭으로 복원해 DOCX·HWPX·HTML·TXT로 내보냅니다.", "/tools/image-ocr.html", { kind: "workspace", status: "pro", audience: "pro", api: "documents:write" }),
  feature("pdf-analysis", "PDF 분석", "translate", "번역하지 않고 페이지, 텍스트층, 스캔 여부, 수식 밀도와 레이아웃 특성만 분석합니다.", "/tools/pdf-analysis.html", { kind: "workspace", status: "active", audience: "member", api: "documents:read" }),
  feature("community", "커뮤니티", "community", "자유 글·질문·사용 팁·작업 사례를 나누고 댓글로 소통합니다.", "/community.html", { kind: "community", status: "active", audience: "member", api: "community:read" }),
  feature("lab", "Quilo Lab", "community", "Quilo에 실제로 적용된 기술과 코드 설명을 공개합니다.", "/community.html?tab=lab", { kind: "knowledge", status: "active", audience: "public", execution: "read-only", api: "knowledge:read" }),
  feature("examples", "예시 모음", "community", "보고서와 메모 작성 예시를 확인합니다.", "/examples.html", { kind: "knowledge", status: "active", audience: "public" }),
  feature("guide", "이용 가이드", "community", "Quilo의 기능과 입력 방법, 자주 묻는 질문을 안내합니다.", "/guide.html", { kind: "knowledge", status: "active", audience: "public" }),
  feature("my-jobs", "내 작업", "account", "진행 중이거나 완료된 백그라운드 작업을 확인합니다.", "/#jobs", { kind: "account", status: "active", audience: "member", api: "jobs:read" }),
  feature("my-files", "내 파일", "account", "완료 파일을 24시간 보관하거나 Dropbox에서 관리합니다.", "/#files", { kind: "account", status: "active", audience: "member", api: "files:read" }),
  feature("dropbox", "Dropbox 연동", "account", "완료 결과물을 사용자의 Dropbox에 저장합니다.", "/#integrations", { kind: "integration", status: "active", audience: "member" }),
  feature("google-drive", "Google Drive 연동", "account", "사용자 OAuth 권한으로 Drive 파일을 조회하고 결과물을 업로드합니다.", "/#integrations", { kind: "integration", status: "active", audience: "member", api: "integrations:write" }),
  feature("google-docs", "Google Docs 연동", "account", "Quilo 결과와 텍스트를 편집 가능한 Google 문서로 만듭니다.", "/#integrations", { kind: "integration", status: "active", audience: "member", api: "integrations:write" }),
  feature("notion", "Notion 연동", "account", "Quilo 내용을 사용자의 Notion workspace 페이지로 저장합니다.", "/#integrations", { kind: "integration", status: "active", audience: "member", api: "integrations:write" }),
  feature("email-results", "결과 이메일 전송", "account", "완료된 백그라운드 작업의 파일함 링크를 인증 이메일로 보냅니다.", "/#jobs", { kind: "integration", status: "active", audience: "member", api: "jobs:write" }),
  feature("byok", "내 AI API 키", "account", "본인 Anthropic·OpenAI 키를 암호화 저장해 크레딧 없이 실행합니다.", "/#settings", { kind: "integration", status: "active", audience: "member" }),
  feature("codex-plugin", "Quilo Codex 플러그인", "account", "Codex에서 전체 기능을 검색하고 계정·작업·파일 API를 연결합니다.", "/developers.html", { kind: "integration", status: "beta", audience: "member", api: "account:read" }),
];

function feature(id, title, category, summary, path, options = {}) {
  const keywords = [...new Set([...(FEATURE_KEYWORDS[id] || []), ...(options.keywords || [])])];
  return {
    id,
    title,
    category,
    summary,
    path,
    ...options,
    keywords,
    execution: options.execution || inferExecution(options),
  };
}

function inferExecution(options) {
  if (options.status === "paused") return "paused";
  if (options.api) return "remote";
  if (options.kind === "browser-tool") return "local";
  if (options.kind === "knowledge") return "read-only";
  return "handoff";
}

function normalizeSearch(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function compactSearch(value) {
  return normalizeSearch(value).replace(/\s+/g, "");
}

function editSimilarity(left, right) {
  const a = [...compactSearch(left)];
  const b = [...compactSearch(right)];
  if (!a.length || !b.length) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = saved;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function bigramSimilarity(left, right) {
  const grams = (value) => {
    const text = compactSearch(value);
    if (text.length < 2) return [text];
    return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
  };
  const a = grams(left);
  const b = grams(right);
  if (!a[0] || !b[0]) return 0;
  const remaining = [...b];
  let overlap = 0;
  for (const gram of a) {
    const index = remaining.indexOf(gram);
    if (index >= 0) { overlap += 1; remaining.splice(index, 1); }
  }
  return (2 * overlap) / (a.length + b.length);
}

function featureSearchScore(item, query) {
  const q = normalizeSearch(query);
  const compact = compactSearch(q);
  if (!compact) return 0;
  const title = compactSearch(item.title);
  const id = compactSearch(item.id);
  const keywords = (item.keywords || []).map(compactSearch).filter(Boolean);
  const terms = [item.title, item.id, ...(item.keywords || [])];
  const corpus = compactSearch([item.title, item.id, item.summary, item.category, CATEGORIES[item.category]?.title, ...(item.keywords || [])].join(" "));
  let score = 0;
  if (title === compact || id === compact) score = 130;
  else if (keywords.includes(compact)) score = 120;
  else if (title.startsWith(compact)) score = 108;
  else if (keywords.some((term) => term.startsWith(compact))) score = 102;
  else if (title.includes(compact)) score = 94;
  else if (keywords.some((term) => term.includes(compact))) score = 88;
  else if (corpus.includes(compact)) score = 78;
  const queryTokens = q.split(/\s+/).filter(Boolean);
  const tokenHits = queryTokens.filter((token) => corpus.includes(compactSearch(token))).length;
  if (queryTokens.length > 1) score = Math.max(score, 52 + Math.round((tokenHits / queryTokens.length) * 38));
  const fuzzy = Math.max(...terms.map((term) => Math.max(editSimilarity(compact, term), bigramSimilarity(compact, term))), 0);
  score = Math.max(score, Math.round(fuzzy * 86));
  return score;
}

function listFeatures({ category, status, audience, execution, query } = {}) {
  let items = FEATURES;
  if (category) items = items.filter((item) => item.category === category);
  if (status) items = items.filter((item) => item.status === status);
  if (audience) items = items.filter((item) => item.audience === audience);
  if (execution) items = items.filter((item) => item.execution === execution);
  if (query) {
    items = items
      .map((item) => ({ item, score: featureSearchScore(item, query) }))
      .filter(({ score }) => score >= 38)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "ko"))
      .map(({ item }) => item);
  }
  return items.map((item) => ({ ...item }));
}

function getFeature(id) {
  const item = FEATURES.find((entry) => entry.id === id);
  return item ? { ...item } : null;
}

module.exports = { CATEGORIES, FEATURES, inferExecution, normalizeSearch, featureSearchScore, listFeatures, getFeature };
