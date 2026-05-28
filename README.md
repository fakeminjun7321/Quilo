# Lab Report Generator Web

AI-assisted lab report generator web app입니다. 보고서 종류별로 업로드 파일과 입력 폼을 다르게 받아 Claude API로 초안을 만들고, `.docx` 또는 `.hwpx` 파일로 출력합니다.

## 지원 보고서

- 화학 사전보고서
  - 실험 매뉴얼 PDF와 AI 참고 메모를 바탕으로 사전보고서 생성
  - 시약 물성, 이론, 실험 과정, 참고문헌 정리
- 화학 결과보고서
  - 사전보고서, 실험 데이터, 사진, 매뉴얼, 참고 메모를 바탕으로 결과 추가 작성분 생성
  - 표, 차트, 사진, 오차 분석, 결론 작성
- 물리 결과보고서
  - PASCO Capstone `.cap`, 엑셀/CSV/텍스트 데이터, 매뉴얼 PDF, 사진/그래프 스크린샷, 참고 메모 지원
  - 물리 결과보고서 양식 기반 `.docx`/`.hwpx` 생성
  - 표, 그래프, 실험 결과 해석, 결론 및 오차 분석 작성

## 주요 기능

- 사용자 로그인, 관리자 페이지, 사용자별 잔액/크레딧 관리
- 보고서 종류별 입력 검증과 파일 파싱
- Claude Opus 4.7 기반 보고서 생성
- 엑셀/CSV/텍스트 데이터 파싱
- PASCO Capstone `.cap` 파일 파싱
- Chart.js 기반 그래프 PNG 생성
- HWPX 템플릿 기반 한글 파일 생성
- HWPX 한글 수식 객체 변환
- AI 참고 메모와 Markdown 메모 파일 입력
- 생성 파일 24시간 보관용 파일함
- 건의사항/버그 제보 탭과 이메일 알림
- 사이트 버전/패치노트 표시

## 기술 스택

- Backend: Node.js, Express
- AI: Anthropic Claude API
- DB/Auth/File records: Supabase
- Documents: `docx`, HWPX ZIP/XML 생성기
- Data: `xlsx`, CSV/text parser
- Charts: `chart.js`, `chartjs-node-canvas`
- Images: `sharp`
- Deploy: Render

## 문서

유지보수와 배포 전 점검은 아래 문서를 먼저 확인하세요.

- 전체 운영 기준: [`CLAUDE.md`](./CLAUDE.md)
- 화학 사전보고서 파이프라인: [`docs/chem-pre-pipeline.md`](./docs/chem-pre-pipeline.md)
- 화학 결과보고서 파이프라인: [`docs/chem-result-pipeline.md`](./docs/chem-result-pipeline.md)
- 물리 결과보고서 파이프라인: [`docs/phys-result-pipeline.md`](./docs/phys-result-pipeline.md)
- 보고서 생성기용 AI 참고 메모 작성 프롬프트: [`docs/report-generator-note-prompt.md`](./docs/report-generator-note-prompt.md)

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
| `ADMIN_NAME` | 서버 시작 시 보장할 관리자 이름 |
| `ADMIN_PASSWORD` | 서버 시작 시 관리자 생성에 사용할 초기 비밀번호 |
| `SESSION_SECRET` | Express session 서명용 32자 이상 랜덤 문자열 |
| `NODE_ENV` | `production` |

선택 환경변수:

| Key | 설명 |
|---|---|
| `MAX_TOKENS` | Claude 출력 token 상한, 기본 `32000` |
| `JOB_TIMEOUT_MS` | 작업 timeout, 기본 `480000` ms |
| `ANTHROPIC_IMAGE_MAX_BASE64_CHARS` | 이미지 1장 base64 제한 |
| `ANTHROPIC_IMAGE_MAX_EDGE` | 이미지 리사이즈 최대 edge |
| `RESEND_API_KEY` | 건의사항 이메일 전송용 |
| `FEEDBACK_EMAIL_FROM` 또는 `RESEND_FROM` | 건의사항 발신자 |
| `FEEDBACK_EMAIL_TO` | 건의사항 수신자 |

환경변수 예시는 [`.env.example`](./.env.example)을 참고하세요. 실제 `.env`와 API 키는 절대 GitHub에 올리지 않습니다.

## 입력 파일 요약

| 보고서 종류 | 주요 입력 |
|---|---|
| 화학 사전보고서 | 실험 매뉴얼 PDF, AI 참고 메모 |
| 화학 결과보고서 | 사전보고서 PDF/docx, 데이터 파일, 사진, 매뉴얼 PDF, AI 참고 메모 |
| 물리 결과보고서 | `.cap`, 엑셀/CSV/txt/md 데이터, 매뉴얼 PDF, 사진/그래프/표 스크린샷, AI 참고 메모 |

## 출력 형식

- `.docx`
- `.hwpx`

HWPX 출력은 각 파이프라인의 Python HWPX 생성기를 통해 만들어집니다. 물리 결과보고서는 학교 결과보고서 HWPX 템플릿을 기반으로 제목, 결과, 결론, 표, 그래프, 사진, 수식을 삽입합니다.

## 폴더 구조

```text
lab-report-generator-web/
├── server.js
├── public/
│   ├── index.html
│   ├── login.html
│   ├── admin.html
│   ├── changelog.html
│   └── style.css
├── lib/
│   ├── anthropic-media.js
│   ├── document-fonts.js
│   ├── excel-parser.js
│   ├── feedback-mailer.js
│   ├── output-sanitize.js
│   ├── version-info.js
│   ├── equation/
│   │   └── hwpx_equation_tool.py
│   └── pipelines/
│       ├── chem-pre/
│       ├── chem-result/
│       └── phys-result/
├── db/
│   └── migrations/
├── docs/
├── .env.example
├── package.json
└── README.md
```

## 배포 전 점검

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
- `.gitignore`에서 `.env`, `.claude/`, `.pdf`, `.hwp`, 예시 보고서 폴더를 제외합니다.
- 공개 저장소에는 학교/기관 전용 양식 PDF/HWPX와 실제 사용자 예시 보고서를 포함하지 않습니다.
- 생성물은 학습 보조 초안이며 제출 전 반드시 직접 검토해야 합니다.

## 라이선스

이 저장소의 자체 코드는 MIT License로 공개합니다. 자세한 내용은 [`LICENSE`](./LICENSE)를 확인하세요.

포함된 제3자 폰트와 의존성은 각각의 라이선스를 따릅니다. 공개 배포 전 확인 사항은 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)에 정리했습니다.
