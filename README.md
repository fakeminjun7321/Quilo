# Quilo | 학습과 연구의 전 과정을 연결하는 AI Workspace

[![License: AGPL v3 or later](https://img.shields.io/badge/License-AGPL_v3_or_later-blue.svg)](./LICENSE)
[![Open source release guard](https://github.com/fakeminjun7321/Quilo/actions/workflows/open-source-guard.yml/badge.svg)](https://github.com/fakeminjun7321/Quilo/actions/workflows/open-source-guard.yml)

Quilo의 웹·Render 서버 파이프라인을 공개합니다. 문제 제보뿐 아니라 구조, 보안,
라이선스, HWPX/DOCX 생성, 데이터 무결성에 관한 조언과 기여를 환영합니다.
혼자 만든 프로젝트라 부족한 부분이 많습니다. “이 설계는 위험하다”, “이렇게 나누면
더 유지보수하기 쉽다” 같은 솔직한 리뷰도 큰 도움이 됩니다.

> **공개 경계:** 비밀값, 사용자 업로드, 권리 제한 학교 양식, 데스크톱/iPad 앱은
> 포함하지 않습니다. 비영리 전용 제3자 코드가 포함됐던 브라우저 수식 변환기는
> OSI 오픈소스가 아니어서 구현을 제외했습니다. 자세한 기준은
> [`docs/repository-boundaries.md`](./docs/repository-boundaries.md)와
> [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)를 확인해 주세요.

**Quilo**는 보고서, 리서치, 데이터 분석, 문서, 번역과 코딩을 하나의 흐름으로 연결하는 AI Workspace입니다. 고등학생부터 대학생까지 자신이 실제로 수행한 실험과 학습 자료를 바탕으로 결과물을 완성할 수 있게 돕습니다. 업로드한 실제 자료를 우선하고, 없는 사실을 임의로 만들지 않는 것을 핵심 원칙으로 삼습니다.

대표 기능은 화학·물리 실험/수행평가 보고서 생성이며, 보고서 종류별로 업로드 파일과 입력 폼을 다르게 받아 Claude / GPT API로 초안을 만들고 `.docx` 또는 `.hwpx`로 출력합니다. 여기서 시작해 지금은 여러 과목의 시험대비·문서 생성 도구, **PDF 통번역**, **창작·코딩 스튜디오**, **커뮤니티/랩**, **브라우저 전용 도구 모음**까지 포함하는 학습 플랫폼으로 확장되었습니다.

라이브 서비스: **https://quilolab.com**

## 지원 보고서

보고서는 메인 화면에서 종류를 고르고 → 자료를 올리고 → 정보를 입력하고 → 생성하면, 진행 로그가 실시간으로 표시되며 완성 파일을 다운로드합니다.

### 공개 (로그인 + 크레딧 차감)

- **화학 사전보고서** (`chem-pre`) — 실험 매뉴얼 PDF와 AI 참고 메모로 실험목표·이론·기구/시약·실험과정 생성. 시약 물성은 웹검색으로 보강
- **화학 결과보고서** (`chem-result`) — 사전보고서(PDF/docx)·실험 데이터·사진·매뉴얼로 결과 추가 작성분(표·차트·오차분석·결론) 생성
- **물리 결과보고서** (`phys-result`) — PASCO Capstone `.cap`, 엑셀/CSV/텍스트, 매뉴얼 PDF, 사진/그래프 스크린샷 지원. `.cap` 워크북 구조에 맞춰 Part별 표·그래프·분석·결론 작성
- **자유 보고서** (`free`) — 임의 주제 범용 보고서. 작성 지시 + 평가기준 + 참고자료를 받아 표·수식·그래프·사진 포함 자유 형식 생성

### 베타 (관리자·지정 테스터 전용, 무료)

- **물리 수행평가** (`phys-inquiry`) — 탐구 주제 + 필기노트 PDF → 「탐구 및 사고 과정 성찰 보고서」(오개념→해결→성찰)
- **수학 수행평가** (`math-inquiry`) — 탐구 주제 + 필기노트 → 「수학Ⅲ 급수 탐구보고서」(Ⅰ~Ⅴ 양식, 표·차트·수식)
- **독서록** (`reading-log`) — 도서 정보 → 학교 「독서활동 기록지」 HWPX 양식을 채워서 출력 (`.hwpx` 전용)
- **독서록 대량생성** (`reading-log-bulk`) — 책 목록 엑셀 → 책마다 독서록 HWPX 생성 후 ZIP으로 묶음 (기간 자동 분배)
- **문제집 메이커** (`problem-set`) — 교재 문제 PDF → 영어/한글 문제지 + 해설지 3종 PDF를 ZIP으로
- **양식 메이커** (`form-maker`) — 말로 설명한 한글 양식 생성, 또는 종이 문서 사진 → 문서 복원
- **영어 시험대비 3종 세트** (`eng-exam-prep`) — 영어 지문/학습지 → 모의고사·개념정리·빈칸 학습지 3종 PDF(ZIP)
- **국어(문학) 내신·모의고사** (`korean-lit-exam`) — 학습지(판서) + 문제은행 → 시험지·답안지·정답해설지 3종 PDF(ZIP)
- **Capstone `.cap` 번역본** (`cap-translate`) — PASCO Capstone `.cap`의 화면 텍스트를 한국어로 번역한 `.cap` 재생성
- **물리 모의고사** (`phys-mock-exam`) — 기출 + 교과서 단원 → 같은 스타일의 새 문제와 답안(PDF + HWPX)

## 모델과 크레딧

보고서 1건당 선택한 모델만큼 크레딧이 차감됩니다(베타 타입은 무료). 실제 차감 단가는 `lib/pricing.js`의 `MODEL_CREDITS`가 기준입니다.

| 모델 | 크레딧 | 비고 |
|---|---|---|
| **Claude Opus 4.8** | 4 | 기본값, 가장 똑똑함 |
| Claude Sonnet 5 | 2 | 빠르고 저렴 |
| GPT-5.5 | 4 | 화학/물리·자유·시험대비 등 대부분 타입에서 선택 가능 |
| GPT-5.4 | 1 | 〃 |
| GPT-5.4-mini | 0 (무료) | 〃 |
| Claude Fable 5 | 9 | 관리자 전용(셀렉터는 관리자에게만 노출) |

- GPT 모델은 `chem-pre`·`chem-result`·`phys-result`·`free`·`problem-set`·`form-maker`·`math-inquiry`·`eng-exam-prep`·`korean-lit-exam`·`cap-translate`·`phys-mock-exam`에서 선택할 수 있습니다(`phys-inquiry`·독서록은 Claude 전용).
- **AI 이미지 생성**을 켜면 삽입 이미지 1장당 1크레딧이 추가로 차감됩니다.
- 보고서 생성에는 **로그인 + 이메일 인증 + 관리자 승인**이 필요합니다(관리자는 예외).

## 주요 기능

- 사용자 로그인/회원가입, **학교 이메일 인증 + 관리자 승인** 2단계 게이트
- **통합 크레딧제** — 보고서 1건당 선택 모델 단가만큼 차감, 개인 사용 내역 대시보드
- 보고서 종류별 입력 검증과 파일 파싱(엑셀/CSV/텍스트, PASCO Capstone `.cap`)
- Chart.js 기반 그래프 PNG 생성, `sharp` 이미지 처리
- HWPX 템플릿 기반 한글 파일 생성 + HWPX 한글 수식 객체 변환
- AI 참고 메모(`userNotes`)와 "내 글 스타일"(문체만 참고, 내용·데이터 누출 없음) 입력
- **백그라운드 실행** — 탭을 닫아도 서버가 끝까지 생성하고 "내 파일함"/이메일로 전달(구독자·관리자 한정)
- 생성 파일 24시간 보관용 파일함(Supabase)
- 상단 공지 티커, 건의사항/버그 제보(커뮤니티) + 이메일 알림, 사이트 버전/패치노트

### 관리자 기능

- 사용자별 크레딧 충전, 시간당 생성 한도 관리
- **사용자별 모델 제한**(전체 / Opus만 / Sonnet만)과 **보고서 종류 접근 제한**(ACL)
- **베타 기능 시스템** — 기능별 ON/OFF + 지정 테스터에게만 노출, 테스터 1인당 일일 사용 한도
- **API 키 위임(Grant)** — 지정 사용자에게 기간 한정 "관리자 키 무료사용" 부여
- **백그라운드 구독 관리** — 지정 사용자에게 기간 한정 백그라운드 실행 권한 부여
- 공지사항 CRUD

## 그 외 기능

- **PDF 통번역** (`/translate.html`, 베타) — 그림·레이아웃을 최대한 보존하며 텍스트를 한국어로 번역(빠른 번역은 추출 텍스트, 재조판·OCR은 PDF 또는 페이지 이미지를 번역 제공자 및 설정된 OCR 제공자에 전송할 수 있음)
  - **변환 방식 자동 선택** — 일반 텍스트 문서는 **빠른 번역**(in-place, PyMuPDF), 수식 많은 문서·스캔본/이미지 PDF는 **재조판**(Claude → 한국어 LaTeX → Tectonic)
  - 스캔본·글자 깨진 PDF는 고해상도 타일 **OCR**로 읽고 원본 그림도 복원해 재조판, 대용량은 자동 분할·병렬·병합
- **도구 모음** (`/tools`, 브라우저 전용) — 글자수 세기, 선형회귀·추세선, 그래프 생성기, 파일 변환기(표·이미지·이미지↔PDF), **PDF 도구 10종**(병합/분할/추출/삭제/정렬/회전/페이지번호/워터마크/여백자르기/압축). 브라우저 LaTeX→한글 수식 변환은 비영리 전용 구현을 제거해 clean-room 대체 구현 전까지 일시 중지했습니다.
- **창작 스튜디오** (`/create.html`, `/studio.html`) — 대화형 "바이브 코딩" 스튜디오. 미리보기·체크포인트로 웹 아티팩트 제작
- **바이브 코딩 생성기** (`/vibe-coding.html`) / **고급 물리 문제 스튜디오** (`/physics-studio.html`) — 아이디어·주제로 프로젝트 설계 또는 심화 물리 문제·풀이 생성
- **수행평가 도움 허브** (`/exam-prep.html`, 베타) — 백준식 코딩 테스트(브라우저 Pyodide 채점, 소크라테스식 GPT 튜터) + 물리 수행평가
- **커뮤니티 + 랩** (`/community.html`) — 건의/기능요청 게시판 + "랩"(서비스에 쓰인 기술을 GitHub식으로 열람·다운로드)
- **공부(상대론)** (`/study.html`, 베타) — 상대성이론 민코프스키 평면 학습 도식 생성·렌더링
- **파일 챗봇** (`/filechat.html`, 베타) — 파일 업로드 후 Claude와 대화
- **AI 채팅 도우미** — 보고서 폼에 내장. 메모 작성·사용법을 돕는 라이트 챗봇
- **Quilo Desktop** (`/apps/quilo.html`) — macOS·Windows용 Quilo 데스크톱 앱
- **Live Translator** (`/apps/live-translator.html`) — macOS·Windows용 로컬 실시간 음성 번역 앱
- **예시 모음** (`/examples.html`), **이용 가이드** (`/guide.html`), **패치노트** (`/changelog.html`)

### 앱 직접 다운로드 API

앱 소개 페이지는 외부 배포 페이지로 이동하지 않고 Quilo 서버의 고정 allowlist endpoint에서 설치 파일을 직접 내려받습니다.

```text
GET /api/apps/quilo/download?platform=mac
GET /api/apps/quilo/download?platform=windows
GET /api/apps/live-translator/download?platform=mac
GET /api/apps/live-translator/download?platform=windows
```

등록되지 않은 앱은 `404`, 지원하지 않는 platform은 `400`을 반환합니다. 서버는 허용된 릴리스 asset만 확인해 스트리밍하며 Range 요청을 전달합니다.

## 기술 스택

- Frontend: 정적 HTML + ES modules, `/public/ui`의 surface별 CSS 아키텍처, Playwright QA
- Backend: Node.js, Express
- AI: Anthropic Claude API (Opus 4.8 / Sonnet 5 / Fable 5), OpenAI GPT (5.5 / 5.4 / 5.4-mini)
- DB/Auth/File records: Supabase
- Documents: `docx`, HWPX ZIP/XML 생성기(Python)
- Data: `xlsx`, CSV/text parser
- Charts: `chart.js`, `chartjs-node-canvas`
- Images: `sharp`
- PDF 통번역: `PyMuPDF`(텍스트 교체·페이지 래스터화), `Tectonic`(한국어 LaTeX 재조판 컴파일)
- 코딩 채점: 브라우저 Pyodide
- Deploy: Render

## 문서

유지보수와 배포 전 점검은 아래 문서를 먼저 확인하세요. 운영 기준서(`CLAUDE.md`/`AGENTS.md`)와 파이프라인 문서는 웹/Render 서버의 화학·물리 핵심 보고서 흐름을 다룹니다.

- 전체 운영 기준: [`CLAUDE.md`](./CLAUDE.md) · [`AGENTS.md`](./AGENTS.md)
- 공개 소스와 내부 운영·권리 제한 자산의 경계: [`docs/repository-boundaries.md`](./docs/repository-boundaries.md)
- 다른 AI에게 Quilo를 설명하는 컨텍스트 문서: [`QUILO.md`](./QUILO.md)
- Codex 플러그인·외부 API: [`docs/codex-plugin-api.md`](./docs/codex-plugin-api.md)
- 화학 사전보고서 파이프라인: [`docs/chem-pre-pipeline.md`](./docs/chem-pre-pipeline.md)
- 화학 결과보고서 파이프라인: [`docs/chem-result-pipeline.md`](./docs/chem-result-pipeline.md)
- 물리 결과보고서 파이프라인: [`docs/phys-result-pipeline.md`](./docs/phys-result-pipeline.md)
- 보고서 생성기용 AI 참고 메모 작성 프롬프트: [`docs/report-generator-note-prompt.md`](./docs/report-generator-note-prompt.md)
- 프론트엔드 토큰·shell·페이지군·QA 계약: [`docs/design-system.md`](./docs/design-system.md)

## 프론트엔드 구조

모든 화면은 `/public/ui/foundation.css`의 의미론 토큰과 라이트·다크 테마를 기반으로 합니다. 화면군은 필요한 surface stylesheet만 추가로 로드합니다.

| 화면군 | 스타일 |
|---|---|
| 공개 사이트·가이드·도구·앱 소개 | `foundation.css` + `shell.css` + `pages.css` |
| 로그인·회원가입·이메일 인증 | `foundation.css` + `auth.css` |
| 메인·보고서 작성·생성 진행 | `foundation.css` + `workspace.css` + `forms.css` + `generation.css` |
| 관리자 | `foundation.css` + `admin.css` |
| 편집기·스튜디오·번역·학습 앱 | `foundation.css` + `app-shell.css` |
| Quilo Bot | `chat.css` + `/public/chat/{api,voice,view,index}.js` |

`public/chat-widget.js`는 기존 페이지 호환을 위한 작은 loader이며, 채팅 CSS를 한 번만 연결하고 ES module 진입점을 동적 import합니다. HTML의 `<style>`/`style=` 및 일반 UI의 JavaScript `style.display` 토글은 사용하지 않고, `hidden`·ARIA·상태 클래스를 사용합니다.

## 로컬 실행

```bash
npm install
cp .env.example .env
npm start
```

기본 포트는 `3000`입니다.

```text
http://localhost:3000
```

API 키가 없어도 정적 화면과 다수의 단위·계약 테스트를 살펴볼 수 있습니다. 실제 AI,
Supabase, 이메일, 외부 저장소 연동은 각 서비스의 본인 자격 증명이 필요하며
`.env` 파일은 절대 커밋하지 마세요.

## 함께 도와주세요

처음 기여한다면 [`CONTRIBUTING.md`](./CONTRIBUTING.md)를 읽고 작은 이슈부터
시작해 주세요. 특히 아래 영역의 설계 리뷰와 테스트 기여를 찾고 있습니다.

- 업로드·인증·권한·크레딧 경계의 보안 검토
- 원본 측정값을 보존하는 보고서 데이터 파이프라인
- macOS/Windows 한컴에서 재현 가능한 HWPX 호환성 픽스처
- 비영리 전용 구현을 대체할 clean-room 한글 수식 변환기
- 한국어/영어 문서와 초보 기여자 온보딩

보안 취약점은 공개 이슈 대신 [`SECURITY.md`](./SECURITY.md)의 비공개 제보 절차를
사용해 주세요.

## Render 배포

Render Web Service 설정 예시:

| 항목 | 값 |
|---|---|
| Runtime | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Branch | `main` |

필수 환경변수:

| Key | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 호출용 키 |
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `SESSION_SECRET` | Express session 서명용 32자 이상 랜덤 문자열 |
| `NODE_ENV` | `production` |

관리자도 일반 Quilo 계정으로 가입·로그인하며, 권한은 Supabase `users.is_admin`으로만
판정한다. 서버 시작 시 관리자 계정을 만들거나 비밀번호를 환경변수와 동기화하지 않는다.
최초 관리자는 정확한 계정을 확인한 뒤 Supabase SQL Editor에서 `is_admin=true`만 지정하고,
비밀번호 분실 시 로그인 화면의 이메일 재설정 흐름을 사용한다.

선택 환경변수:

| Key | 설명 |
|---|---|
| `OPENAI_API_KEY` | GPT 보고서 모델과 Quilo Bot 사용 시 |
| `OPENAI_CHAT_MODEL` | Quilo Bot 저비용 모델, 기본 `gpt-4o-mini` |
| `OPENAI_CHAT_MEMO_MODEL` | 메모 작성 도우미 모델, 기본 `gpt-4o-mini` |
| `OPENAI_CHAT_API_BASE` | OpenAI 호환 API 주소, 기본 `https://api.openai.com/v1` |
| `CHAT_MAX_TOKENS` | Quilo Bot 답변 길이 상한, 기본 `700` |
| `CHAT_DAILY_MAX` | Quilo Bot 전역 일일 메시지 상한, 기본 `1500` |
| `MAX_TOKENS` | Claude 출력 token 상한, 기본 `32000` |
| `MAX_UPLOAD_MB` | 업로드 파일 1개 최대 크기, 기본 `64` |
| `JOB_TIMEOUT_MS` | 일반 작업 timeout, 기본 `900000` ms(15분) |
| `JOB_TIMEOUT_PRINT_PDF_RESTORE_MS` | 프린트 PDF 복원 timeout, 기본 `5400000` ms(90분) |
| `PRINT_RESTORE_MODEL` | 프린트 PDF 복원 기본 모델, 기본 `claude-opus-4-8` |
| `JOB_ARTIFACT_MEMORY_MAX_BYTES` | 완료 산출물 RAM 캐시 상한, 기본 `134217728`(128MiB) |
| `JOB_ARTIFACT_MEMORY_TTL_MS` | 완료 산출물 RAM 캐시 TTL, 기본 `900000` ms(15분); 파일함 원본은 24시간 유지 |
| `REPORT_STORAGE_RETRY_ATTEMPTS` | 24시간 파일함 저장 시도 횟수, 기본 `3`(최대 `4`); 최종 실패 시 정산·완료 중단 |
| `REPORT_STORAGE_RETRY_BASE_DELAY_MS` | 파일함 저장 재시도 지수 backoff 기준, 기본 `250` ms |
| `MAX_CONCURRENT_GENERATIONS` | 서버 전체 동시 생성 수, 기본 `10`; 초과 요청은 중단 가능한 FIFO 대기 |
| `MAX_GENERATION_QUEUE` | 생성 대기열 최대 길이, 기본 `6`; 포화 시 업로드 전 `503` |
| `GENERATION_QUEUE_TIMEOUT_MS` | 생성 대기열 최대 대기시간, 기본 `600000` ms |
| `MAX_UPLOAD_MEMORY_MB` | 대기·실행 중 multipart 입력의 서버 전체 RAM 예산, 기본 `256` MiB |
| `VIBE_IMAGE_CONCURRENCY_PER_USER` | 바이브 이미지 사용자별 동시 생성 수, 기본 `2`(최대 `4`) |
| `VERIFY_EXEMPT_EMAILS` | 다회 이메일 인증을 허용할 권한 있는 테스트 주소 목록(쉼표 구분); 기본값 없음 |
| `ALLOW_STATELESS_PRODUCTION` | 운영 Supabase 없이 읽기 전용 데모만 띄울 때 `1`; 정식 서비스에서는 사용 금지 |
| `MCP_OAUTH_REGISTRATION_LIMIT` | MCP OAuth 동적 클라이언트 등록 IP당 시간 한도, 기본 `30` |
| `MCP_OAUTH_REDIRECT_ALLOWLIST` | ChatGPT 외 허용할 정확한 HTTPS callback URL 목록(쉼표 구분, prefix 매칭 안 함) |
| `ANTHROPIC_IMAGE_MAX_BASE64_CHARS` | 이미지 1장 base64 제한 |
| `ANTHROPIC_IMAGE_MAX_EDGE` | 이미지 리사이즈 최대 edge |
| `MISTRAL_API_KEY` | 이미지 OCR 및 PDF strict OCR 공급자 키 |
| `MISTRAL_OCR_MODEL` | 이미지·PDF OCR 모델, 기본 `mistral-ocr-4-0` |
| `IMAGE_OCR_MAX_EDGE` | 이미지 OCR 전처리 최대 edge, 기본 `6000` |
| `IMAGE_OCR_MAX_PIXELS` | 이미지 OCR 입력의 해상도 안전 상한, 기본 `80000000` |
| `IMAGE_OCR_RETRY_CONFIDENCE` | 보정본 자동 재판독 평균 신뢰도 임계값, 기본 `0.90` |
| `PYTHON_BIN` | HWPX·PDF 생성기가 쓸 Python 경로(미설정 시 `.venv` 우선) |
| `PDF_AUTO_MATH_THRESHOLD` | PDF 통번역 자동 모드의 수식 밀도 임계값, 기본 `12` |
| `PDF_TRANSLATE_MAX_PAGES` | PDF 통번역 전체 최대 페이지, 기본 `700` |
| `PDF_TRANSLATE_LIBREOFFICE_ENABLED` | LibreOffice 재조판 렌더러 운영 플래그. 기본 비활성화이며 실행 파일과 전용 검증 준비가 끝난 환경에서만 `1` |
| `PDF_OCR_MAX_PAGES` | 폐기된 호환 변수. 값이 남아 있어도 무시되며 스캔본은 전체 PDF 상한을 따름 |
| `PDF_OCR_PROVIDER_BATCH_PAGES` | strict OCR 공급자 호출당 페이지, 기본 `50` |
| `PDF_OCR_PROVIDER_CONCURRENCY` | 문서 내 strict OCR 동시 호출, 기본 `2`(최대 `4`) |
| `PDF_OCR_RISK_VISUAL_BATCH_PAGES` | 저신뢰 OCR 시각 판정 호출당 페이지, 기본 `4`(최대 `8`) |
| `PDF_OCR_RISK_VISUAL_BATCH_TILES` | 저신뢰 OCR 시각 판정 호출당 타일, 기본 `12`(최대 `24`) |
| `PDF_OCR_RISK_VISUAL_BATCH_BYTES` | 저신뢰 OCR 시각 판정 호출당 실제 이미지 바이트, 기본 `8MiB`(최대 `24MiB`) |
| `PDF_OCR_RISK_VISUAL_BATCH_TOKENS` | 저신뢰 OCR 시각 판정 호출당 숫자·단위 등 위험 토큰, 기본 `20`(최대 `40`) |
| `MISTRAL_OCR_INLINE_MAX_MB` | OCR data URL 직접 전송 기준, 기본 `45`. 초과 입력은 임시 파일 URL 사용 후 즉시 삭제 |
| `MISTRAL_OCR_MAX_FILE_MB` | OCR 공급자 파일 절대 상한, 기본 `512` |
| `MISTRAL_OCR_CLEANUP_TIMEOUT_MS` | 임시 OCR 파일 삭제 전용 timeout, 기본 `20000` ms |
| `PDF_TRANSLATE_TIMEOUT_MS` | PDF 파일별 작업 timeout, 기본 `5400000` ms(90분) |
| `PDF_RETYPESET_MODEL` | 재조판 기본 모델(미설정 시 Sonnet/요청값) |
| `TECTONIC_BIN` | Tectonic 바이너리 경로(미설정 시 `bin/tectonic`→PATH) |
| `BETA_DAILY_LIMIT` | 베타 기능 테스터 1인당 일일 사용 한도 기본값, 기본 `15` |
| `ALLOWED_EMAIL_DOMAINS` | 회원가입 허용 이메일 도메인 화이트리스트 |
| `PUBLIC_BASE_URL` | 이메일 인증 링크 등에 쓰는 사이트 기본 URL |
| `RESEND_API_KEY` | 인증/건의사항 이메일 전송용 |
| `FEEDBACK_EMAIL_FROM` 또는 `RESEND_FROM` | 발신자 |
| `FEEDBACK_EMAIL_TO` | 건의사항 수신자 |
| `PREMIUM_PRICE_KRW` / `PREMIUM_BANK` / `PREMIUM_ACCOUNT` / `PREMIUM_HOLDER` / `PREMIUM_PERIOD_DAYS` / `PREMIUM_NOTIFY_EMAIL` | 백그라운드 구독 입금 안내용 |

PDF 통번역의 일반 사용자 기술 상한은 기본 700쪽이며, 관리자는 페이지 수 검사만 면제된다. 페이지·구간별 픽셀/타일/요청 크기 안전장치와 완전성 검증은 관리자에게도 동일하게 적용된다.

환경변수 예시는 [`.env.example`](./.env.example)을 참고하세요. 실제 `.env`와 API 키는 절대 GitHub에 올리지 않습니다.

크레딧 예약을 서버 재시작에도 안전하게 정산하려면 배포 전에
`db/migrations/20260721_add_credit_reservation_ledger.sql`을 Supabase SQL Editor에서
적용해야 합니다. 마이그레이션 전에는 기록 없는 선차감을 하지 않고 기존 후불 경로로
폴백하지만, 동시 요청 보호가 약해지므로 정식 운영에서는 마이그레이션이 필수입니다.

## 출력 형식

- `.docx`
- `.hwpx`
- 문제집·시험대비·독서록 대량·모의고사 등 일부 타입은 여러 파일을 **ZIP**으로 묶어 내보냅니다.

HWPX 출력은 각 파이프라인의 Python HWPX 생성기를 통해 만들어집니다. 물리 결과보고서와 독서록 등은 학교 표준 양식 HWPX 템플릿을 기반으로 제목·결과·표·그래프·사진·수식을 삽입합니다.

## 폴더 구조

```text
Quilo/
├── server.js                 # 메인 서버 + 모든 보고서 PIPELINES 정의
├── translate-server.js       # PDF 통번역 전용(선택 분리 실행)
├── public/
│   ├── index.html            # 메인(Quilo) — 보고서 작성 + 개인 설정
│   ├── login / signup / verify-email / admin / changelog / guide / examples
│   ├── ui/                    # foundation + shell/pages/auth/workspace/forms/
│   │                          # generation/admin/app-shell/chat surface CSS
│   ├── chat/                  # Quilo Bot API/voice/view/index ES modules
│   ├── chat-widget.js         # 채팅 CSS + module 호환 loader
│   ├── apps/                  # Quilo Desktop / Live Translator 소개·직접 다운로드
│   ├── translate.html        # PDF 통번역 (베타)
│   ├── community.html         # 커뮤니티 + 랩
│   ├── create.html / studio.html / vibe-coding.html / physics-studio.html
│   ├── exam-prep.html / study.html / filechat.html
│   ├── tools/                # 도구 모음 (브라우저 전용)
│   └── equation/             # LaTeX→한글 수식 변환기
├── lib/
│   ├── anthropic-media.js / anthropic-files.js / excel-parser.js
│   ├── pricing.js / version-info.js / rate-limit.js / supabase.js / product-telemetry.js
│   ├── *-routes.js           # community / lab / artifacts / coding / study /
│   │                         #   vibe / physics-studio / announcement / grant / subscription
│   ├── equation/hwpx_equation_tool.py
│   └── pipelines/
│       ├── chem-pre/ chem-result/ phys-result/ free-report/
│       ├── phys-inquiry/ math-inquiry/ reading-log/
│       ├── problem-set/ form-maker/ eng-exam-prep/ korean-lit-exam/
│       ├── cap-translate/ phys-mock-exam/
│       └── pdf-translate/    # PyMuPDF in-place + Claude→LaTeX→Tectonic 재조판
├── db/migrations/
├── scripts/
├── docs/
├── .env.example
├── package.json
└── README.md
```

## 배포 전 점검

서비스 품질 관측과 선택형 제품 분석을 사용하려면 Supabase SQL Editor에서
`db/migrations/20260715_add_product_telemetry.sql`을 먼저 적용합니다. 수집 항목,
금지 필드, 보존기간과 확인 절차는 `docs/product-telemetry.md`를 따릅니다.

```bash
node -c server.js
node -c lib/pipelines/chem-pre/generate.js
node -c lib/pipelines/chem-result/generate.js
node -c lib/pipelines/phys-result/generate.js
python3 -m py_compile lib/pipelines/chem-pre/hwpx-gen.py
python3 -m py_compile lib/pipelines/chem-result/hwpx-gen.py
python3 -m py_compile lib/pipelines/phys-result/hwpx-gen.py
git diff --check
```

민감정보 점검:

```bash
git ls-files | grep -E '(^|/)(\.env|.*key.*|.*secret.*)'
rg -n "sk-ant-|SUPABASE_SERVICE_KEY|RESEND_API_KEY|SESSION_SECRET|eyJ|password|패스워드|비밀번호" .
```

문서의 placeholder가 검색될 수 있으므로 실제 secret 값인지 확인합니다.

## 보안 메모

- API 키, Supabase service role key, session secret은 Render 환경변수로만 관리합니다.
- 실제 사용자 업로드 파일, 예시 보고서 PDF/HWP, 개인 계정 정보는 GitHub에 올리지 않습니다.
- `.gitignore`에서 `.env`, `.claude/`, `.pdf`, `.hwp`, `.hwpx`, 예시 보고서 폴더, 테스트 산출물(`test-results/`)을 제외합니다.
- 공개 저장소에는 학교/기관 전용 양식 PDF/HWPX와 실제 사용자 업로드·보고서를 포함하지 않습니다.
- 생성물은 학습 보조 초안이며 제출 전 반드시 직접 검토해야 합니다.

## 라이선스

별도 고지가 없는 Quilo 소스는
[`AGPL-3.0-or-later`](./LICENSE)로 배포됩니다. 네트워크를 통해 수정본을 제공하는
경우에도 해당 사용자에게 그 수정본의 대응 소스를 제공해야 합니다. SDK처럼
자체 디렉터리에 별도 라이선스가 명시된 구성요소는 그 라이선스를 따릅니다.

포함된 제3자 폰트와 의존성은 각각의 라이선스를 따릅니다. 공개 배포 전 확인 사항과
제외된 구성요소는 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)에
정리했습니다. 이 문서는 법률 자문이 아닙니다.
