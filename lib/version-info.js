const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const packageJson = require("../package.json");

const PATCH_NOTES = [
  {
    date: "2026-05-30",
    title: "도구 추가: 텍스트 정리 · 이미지 변환·압축",
    type: "공통",
    items: [
      "텍스트 정리 — 여러 공백·빈 줄·줄바꿈을 정리해 깔끔한 평문으로",
      "이미지 변환·압축 — 사진을 JPG·PNG·WebP로 바꾸고 크기 축소 (브라우저 전용)",
    ],
  },
  {
    date: "2026-05-30",
    title: "보고서 도구 모음 · 이용 가이드 · 블로그",
    type: "공통",
    items: [
      "도구 모음(/tools) 추가 — 글자수 세기, 평균·표준편차 계산기, 유효숫자·오차 계산기 (모두 브라우저 전용)",
      "이용 가이드(/guide) 추가 — 보고서 종류별 단계 설명과 자주 묻는 질문",
      "네이버 블로그 링크 추가, 푸터·랜딩 네비 정리",
    ],
  },
  {
    date: "2026-05-30",
    title: "수식 변환기: 텍스트 → 한글 수식 변환 추가",
    type: "공통",
    items: [
      "수식 변환기(/equation)에 LaTeX 텍스트를 붙여넣어 한글 수식 스크립트로 바꾸는 기능 추가",
      "$…$·$$…$$·\\(…\\)·\\[…\\] 구분자가 있으면 그 부분만, 없으면 전체를 변환하고 수식별 복사 지원",
      "결과 스크립트를 한글 수식 편집기에 붙여넣으면 바로 수식으로 렌더링",
    ],
  },
  {
    date: "2026-05-30",
    title: "LaTeX → 한글 수식 변환기 페이지 추가",
    type: "공통",
    items: [
      "HWP·HWPX 문서 속 LaTeX 수식을 한글 수식 개체로 바꾸는 무료 변환기를 /equation 페이지로 추가 (푸터·랜딩에서 접근)",
      "변환은 전부 브라우저에서 실행 — 업로드 파일은 서버로 전송되지 않음",
      "변환 엔진은 Shin Mingyu의 latex-to-hwp(비영리·출처표시)를 기반으로 하며 출처 표기를 유지",
    ],
  },
  {
    date: "2026-05-30",
    title: "전면 UI 리디자인 — 랜딩 페이지와 라이트/다크 테마",
    type: "공통",
    items: [
      "로그인 화면을 히어로·기능 소개·사용법이 있는 마케팅 랜딩으로 개편",
      "라이트/다크 테마 토글 추가 (시스템 설정 자동 반영, 선택 저장)",
      "보고서 화면 재정리: 상단 배너, 보고서 종류 카드 아이콘, 드래그앤드롭 업로드, 섹션 그룹화",
      "관리자·약관·패치노트 페이지 디자인 통일, 푸터에 저작권·GitHub 링크 추가",
    ],
  },
  {
    date: "2026-05-20",
    title: "Markdown 참고 메모 정제 및 표 정렬",
    type: "공통",
    items: [
      "AI 참고 메모에 입력한 Markdown 서식 기호가 보고서 본문에 그대로 새지 않도록 프롬프트와 출력 정제 단계 보강",
      "취소선, inline code, 비관리자 굵게 마커가 최종 문서에 노출되지 않도록 제거",
      "화학 사전보고서 표 셀 정렬을 가운데 정렬로 통일",
    ],
  },
  {
    date: "2026-05-19",
    title: "사이트 버전/패치노트 표시",
    type: "운영",
    items: [
      "사이트에서 현재 배포 버전, 커밋, 서버 시작 시각을 확인할 수 있게 추가",
      "업데이트 내역을 별도 패치노트 페이지에서 확인 가능",
      "롤백 기준을 잡기 쉽도록 최근 주요 변경 사항을 날짜별로 정리",
    ],
  },
  {
    date: "2026-05-19",
    title: "물리 결과보고서 Capstone 그래프 정의 파싱 보정",
    type: "물리 결과",
    items: [
      ".cap 파일 내부 images/*를 그래프 화면으로 오인해 자동 삽입하던 동작 제거",
      "Capstone 워크북의 CSLineGraph, 선택 구간, curve fit 파라미터, RMSE를 텍스트로 파싱",
      "보고서 그래프는 Capstone 그래프 정의를 기준으로 서버 chart로 재구성하도록 프롬프트 수정",
    ],
  },
  {
    date: "2026-05-19",
    title: "물리 HWPX 제목 박스 안정화",
    type: "물리 결과",
    items: [
      "실험 주제 박스가 양식 구조와 다르게 움직이던 회귀 수정",
      "결과/결론 입력칸의 파란 안내문이 생성물에 남지 않도록 양식 표를 먼저 탐지한 뒤 채우도록 조정",
      "제목 박스는 양식 원본 구조를 유지하고 '(반드시 기재)'만 실제 실험 제목으로 치환",
    ],
  },
  {
    date: "2026-05-19",
    title: "물리 수식·표기 정리",
    type: "물리 결과",
    items: [
      "I_{cm}, I_{pivot}, ω_0처럼 HWPX에서 어색하게 보이던 inline 표기를 정리",
      "한글 수식 편집기 변환 전 일반 문장 속 아래첨자 표기 보정",
      "샘플링 주기와 주파수 표기가 서로 맞지 않는 경우 보정 로직 추가",
    ],
  },
  {
    date: "2026-05-18",
    title: "물리 데이터 신뢰성 보정",
    type: "물리 결과",
    items: [
      "엑셀/CSV 원본과 AI 서술이 충돌할 때 원본 데이터 기준으로 표와 문장을 보정",
      "측정값을 임의 생성하지 않도록 데이터 사용 가이드 강화",
      "그래프 범례 겹침과 이미지·표 크기를 줄여 페이지 초과 위험 완화",
    ],
  },
  {
    date: "2026-05-17",
    title: "입력 파일 확장",
    type: "공통",
    items: [
      "물리 결과보고서에서 여러 데이터 파일 입력 지원",
      "데이터표·그래프 스크린샷 및 텍스트/md 메모 파일 입력 지원",
      "큰 이미지가 Claude 제한을 넘지 않도록 자동 축소 처리",
    ],
  },
  {
    date: "2026-05-16",
    title: "건의사항/운영 기능",
    type: "운영",
    items: [
      "건의사항 탭 추가",
      "버그 제보와 개선 요청을 운영자 이메일로 받을 수 있게 구성",
      "사용자 파일함과 생성 파일 24시간 보관 흐름 정리",
    ],
  },
];

const serverStartedAt = new Date().toISOString();

function readGitCommit() {
  const fromEnv =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return fromEnv.trim();

  try {
    return execSync("git rev-parse HEAD", {
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1000,
    }).trim();
  } catch {
    return "";
  }
}

function readGitBranch() {
  const fromEnv =
    process.env.RENDER_GIT_BRANCH ||
    process.env.GIT_BRANCH ||
    process.env.BRANCH ||
    process.env.VERCEL_GIT_COMMIT_REF;
  if (fromEnv) return fromEnv.trim();

  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: path.join(__dirname, ".."),
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 1000,
    }).trim();
  } catch {
    return "";
  }
}

function readPackageUpdatedAt() {
  try {
    return fs.statSync(path.join(__dirname, "..", "package.json")).mtime.toISOString();
  } catch {
    return "";
  }
}

function getVersionInfo() {
  const commit = readGitCommit();
  return {
    app: packageJson.name,
    version: packageJson.version,
    commit,
    shortCommit: commit ? commit.slice(0, 7) : "",
    branch: readGitBranch(),
    serverStartedAt,
    packageUpdatedAt: readPackageUpdatedAt(),
    environment: process.env.NODE_ENV || "development",
    patchNotes: PATCH_NOTES,
  };
}

module.exports = {
  getVersionInfo,
  PATCH_NOTES,
};
