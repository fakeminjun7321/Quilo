# 나만의 GPT/Claude (BYOK 스킬 스튜디오) — 구현 계획

> 상태: **로컬 구현 일부 완료(2026-06-20). 아직 배포·push 안 함.** 사용자 라이브 작업 중 push 금지.
> 작성 기준: 기존 보고서 파이프라인 인프라(job/SSE/파일함) + 베타 게이팅 + Tectonic/HWPX 툴체인 재사용.

---

## ✅ 이번 작업에서 구현한 것 (사용자 추가 요청 반영 — 2026-06-20)

사용자 추가 요청 2가지를 우선 구현했다. 이건 아래 BYOK(개인키 암호화 저장) 설계를 **대체**한다 —
"관리자 키를 빌려 쓰는 위임" 모델이 더 단순하고 안전하기 때문(개인 키를 서버에 저장하지 않음).

### A. API 키 위임(grant) — 관리자가 지정한 사용자가 기간 한정으로 관리자 키를 크레딧 차감 없이 사용
- **핵심 통찰**: 모든 보고서 생성은 이미 서버 `ANTHROPIC_API_KEY`로 돈다. 따라서 "관리자 키로 사용"
  = **위임 기간 동안 그 사용자의 생성·챗봇이 크레딧 차감 없이 서버 키로 실행**되는 것. 개인 키 저장 불필요
  → `secret-box.js`/`user_api_keys` 암호화 테이블 **전부 불필요**(위험 표면 제거).
- 신규 테이블 `api_key_grants` (`db/migrations/20260620_add_api_key_grants.sql`): `user_id, granted_by,
  expires_at, note, revoked_at`. RLS on, 공개정책 없음. 파일챗봇 베타(`file-chat`) 시드도 포함.
- `lib/supabase.js`: `getActiveGrant / listGrants / createGrant / revokeGrant` (+ export). 테이블 없으면 graceful.
- `lib/grant-routes.js`: `GET /api/grants/me`(본인 상태), `GET/POST /api/grants`, `POST /api/grants/:id/revoke`(관리자).
- `server.js` `/api/generate` 배선: `hasGrant` 계산 → `creditCost=0`, 잔액검증 skip, `job.billingExempt`로
  이미지 추가과금·차감 단계 모두 면제, "🔑 관리자 키 위임" 진행 로그.
- `public/admin.html`: "🔑 키 위임" 탭/패널(사용자 이름 + 기간(일/시간) + 메모 → 부여, 활성 목록 + 회수).

### B. 파일 챗봇 — 파일 올리고 Claude와 대화
- `server.js`: `POST /api/filechat`(멀티파트, 평문 스트림) + `GET /api/filechat/access`.
  - 게이트: **관리자 OR 활성 위임 OR 베타(`file-chat`)** (서버 키 비용 누수 방지).
  - 첨부 처리: 이미지=`anthropic-media`, PDF=작으면 inline·크면 Files API(`anthropic-files`, 후처리 cleanup),
    텍스트=inline. 무상태 → 클라가 첨부를 매 턴 재전송해 맥락 유지. 모델 Sonnet 기본/Opus 선택(관리자 Fable).
  - 사용량 제한: `checkChatLimit`(IP) 재사용.
- `public/filechat.html`: 채팅 UI(파일 칩·모델 선택·스트리밍). 게이트는 `/api/filechat/access`.
- `public/index.html`+`app.js`: 도구 메뉴에 "파일 챗봇" 링크(관리자/베타/위임 시 노출).

### 배포 전 할 일 (지금은 안 함 — 라이브 작업 중)
1. Supabase SQL editor에 `db/migrations/20260620_add_api_key_grants.sql` 실행(없으면 위임은 비활성이고 크레딧 면제가 적용되지 않음, 사이트는 정상).
2. 환경변수 추가 불필요(서버 `ANTHROPIC_API_KEY` 그대로). 선택: `FILECHAT_MAX_TOKENS`(기본 4000).
3. 패치노트(`lib/version-info.js`)는 **공개 시점에** 추가 — 지금은 관리자/베타 한정이라 보류.
4. 공개 저장소 동기화 시 plan 문서/PII 점검.
5. 검증: 위임 부여→해당 사용자 생성 시 크레딧 0 차감 확인 / 파일챗봇 PDF·이미지 응답 / 위임 회수 즉시 반영.

### C. 5개 스킬 파이프라인 전부 구현 (2026-06-20, 추가)
problem-set는 기존 존재. 신규 4종을 `lib/pipelines/<name>/`에 자체완결 모듈로 작성(병렬 워크플로 + 본인 통합):
- **eng-exam-prep** (`영어 시험대비 3종`): 영어 지문 → 모의고사·개념정리·빈칸 PDF 3종 ZIP. (LLM→JSON→LaTeX/Tectonic→JSZip, 지문별 북마크)
- **korean-lit-exam** (`국어 문학 시험`): 학습지(판서)+문제은행 → 시험지·답안작성지·정답해설지 PDF ZIP.
- **cap-translate** (`Capstone .cap 번역`): .cap 화면 텍스트만 번역해 동일구조 .cap 재생성(JSZip 바이트보존 재패키징; `cap-xml.js` byte-span 치환). atwood.cap 라운드트립 검증(147 units, 바이너리 12개 byte-identical).
- **phys-mock-exam** (`물리 모의고사`): 기출+교과서 → draft→verify→reconcile(순차 LLM 3패스) → 시험지+답안 PDF + HWPX(`build_hwpx.py`) ZIP. python-hwpx 없으면 PDF-only로 graceful.

각 모듈 export: `prepareInput / generateReportContent / generateBundle`(outputKind:"zip", {buffer,filename}).
통합: server.js `PIPELINES` 4개 등록 + `FREE_BETA_TYPES` + `GPT_OK_TYPES` + `ensureBetaFeature` 시드 / index.html 카드·폼 4개 / app.js 카드노출·submit 핸들러 4개.
검증: node -c·require 전부 OK, 서버 부팅(=require 해소), 실라우트 prepareInput 검증 400 4종, 프리뷰에서 카드노출·폼전환 OK, console 0. **렌더 E2E는 빌드 에이전트가 실제 Tectonic PDF·.cap 라운드트립·HWPX 라운드트립으로 확인.** 단 실제 LLM 호출(키 필요)·한컴 열기·Render python-hwpx 설치는 미검증(배포 후 staged 검증 필요).

### 안 한 것(원안 유지, 후속)
- 개인키 BYOK 암호화 저장(위임 모델로 대체), 스킬별 저장 프리셋(나만의 GPT) → Phase 3.

---

## 0. 사용자 확정 사항

1. **실제 스킬 실행** — 채팅형이 아니라, 스킬을 돌려서 결과 파일(PDF/HWPX/.cap/ZIP)까지 만든다.
2. **개인 API 키(BYOK), 서버 암호화 저장, 보안 최우선** — 일반 사용자는 본인 Anthropic/OpenAI 키를 발급받아 입력 → Supabase에 **암호화** 저장. 관리자는 서버 env 키 그대로 사용.
3. **관리자/베타 먼저** — UI 숨김 + 관리자/테스터만 노출, 서버에서도 막음. 안정화 후 공개.
4. **API 키 발급 안내 분리** — 키 입력 폼에 줄줄이 쓰지 말고 "API 키 발급 방법" 버튼 → **별도 페이지로 이동**. Claude/GPT 각각 안내.

## 1. 현실적 범위 (정직하게)

- "실제 스킬 실행"은 **임의의 `.skill` 업로드 자동 실행이 아니다.** 그건 코드 실행 샌드박스가 필요해 Render 웹앱에서 안전하지 않다.
- 대신 **5개 스킬을 각각 서버 파이프라인으로 만들어 카탈로그에 등록**하고, 사용자가 본인 키로 그 스킬을 실행한다. = 기존 보고서 타입과 똑같은 구조에 BYOK를 얹는 것.
- "나만의 GPT" 성격 = (a) 사용자별 개인 키로 자기 인스턴스를 돌림 + (b) 스킬별 **저장 프리셋/프로필**(예: 출제 난이도·문체·과목 기본값)을 본인이 만들어 재사용. (b)는 Phase 3.
- **사용자가 새 스킬 자체를 코드로 작성·실행하는 기능은 범위 밖**(샌드박스 필요). 필요하면 별도 논의.

## 2. 5개 스킬 → 파이프라인 매핑

| # | 스킬 | 기존 파이프라인? | 출력 | 작업량 |
|---|------|-----------------|------|--------|
| 1 | problem-set-pdf-maker | ✅ **있음** `lib/pipelines/problem-set/` (generate.js·bundle.js·figures.js/py·prompt.md, `outputKind:"zip"`, Tectonic) | ZIP(3 PDF) | **재사용**(BYOK만 추가) |
| 2 | korean-lit-exam-generator | ❌ 신규 | PDF(시험지+답안+해설) | 중 |
| 3 | eng-exam-prep-suite | ❌ 신규 | PDF 3종(북마크) | 중 |
| 4 | capstone-cap-translator | ❌ 신규 (`cap-parser.js`는 **읽기 전용** — .cap 재생성 로직 신규) | .cap | 중상 (.cap rebuild 검증 필요) |
| 5 | physics-mock-exam-generator | ❌ 신규 (멀티에이전트 draft→verify→reconcile) | PDF + HWPX | **상** (가장 무거움) |

→ problem-set은 끝났고, 나머지 4개를 새로 만든다. physics-mock이 제일 크다.

## 3. 아키텍처 (기존 인프라 재사용)

### 3.1 스킬 = 보고서 타입처럼 등록
- `server.js`의 `PIPELINES` 객체에 스킬 타입 추가 (problem-set과 동일 패턴: `prepareInput`/`generateContent`/`generateBundle|Hwpx|Docx`/`outputKind`/파일명/타임아웃).
- `/api/generate` → `runGeneration()` → SSE 진행 로그 → 파일 생성 → 다운로드 job + Supabase 24h 파일함. **그대로 재사용.**
- 프런트도 기존 보고서 폼/진행스트리밍/다운로드 UI 컴포넌트 재사용.

### 3.2 BYOK 키 주입 (가장 중요한 배선)
현재 키 소스 2곳을 "요청별 키" 받도록 수정:
- **Claude**: 각 `generate.js`의 `new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })` → `new Anthropic({ apiKey: ctx.apiKeys.anthropic || process.env.ANTHROPIC_API_KEY })`.
- **GPT**: `lib/model-call.js`의 `callGptReport({...})`가 `opts.apiKey`를 받아 `gptKey()` 대신 사용(없으면 env 폴백).
- `runGeneration()`/job 객체에 `apiKeys = { anthropic, openai }`를 실어 파이프라인 `ctx`로 전달.
- **관리자**: `apiKeys`를 비워 보내면 자동으로 env 키 사용 → 관리자는 기존대로.
- **일반 사용자**: 요청 처리 시작 시 서버가 그 사용자의 저장 키를 **복호화해 메모리에서만** 사용, 끝나면 폐기. 절대 로그/응답에 노출 금지.

### 3.3 보조 유료 호출 정책 (비용 누수 차단)
- problem-set은 해설 삽화에 `genImage`(gpt-image, **서버 GPT 키**)를 쓴다. BYOK 사용자가 이걸 쓰면 관리자 비용이 샌다.
- 정책: **AI 삽화/이미지 생성 등 보조 유료 호출은 (a) 사용자가 OpenAI 키도 등록했으면 그 키로, (b) 아니면 비활성화**. 메인 LLM 호출만 사용자 키 강제.
- `web_search`(Anthropic tool)는 사용자 Anthropic 키로 같이 나가므로 OK.

## 4. 보안 설계 (사용자 강조 — 최우선)

### 4.1 저장
- 새 테이블 `user_api_keys` (마이그레이션 `db/migrations/2026XXXX_add_user_api_keys.sql`):
  ```
  user_id    uuid  references users(id) on delete cascade,
  provider   text  check (provider in ('anthropic','openai')),
  ciphertext text  not null,   -- base64
  iv         text  not null,   -- base64 (12B, GCM nonce)
  auth_tag   text  not null,   -- base64 (16B, GCM tag)
  last4      text  not null,   -- 마스킹 표시용 (sk-...abcd)
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  primary key (user_id, provider)
  ```
  RLS on, 공개 정책 없음(service_role만) — 기존 컨벤션 동일.
- **평문 키는 어디에도 저장·로그 금지.** DB엔 ciphertext/iv/auth_tag/last4만.

### 4.2 암호화
- 새 모듈 `lib/secret-box.js`: AES-256-GCM.
  - 마스터 키 = 새 env `KEY_ENCRYPTION_SECRET`(없으면 시작 시 경고 + BYOK 비활성). `scrypt`/`sha256`로 32B 파생.
  - `encrypt(plain)` → `{ciphertext, iv, auth_tag}`, `decrypt(...)` → plain. `crypto.createCipheriv('aes-256-gcm', ...)`.
- (선택 강화) 사용자별 salt를 섞어 키 분리.

### 4.3 노출 차단
- **응답에 키 평문 절대 반환 안 함.** 상태 조회는 `{anthropic:{set:true,last4:'abcd'}, openai:{set:false}}`만.
- 저장은 password 필드, HTTPS(Render 기본). 한 번 저장 후 다시 못 읽음(교체만 가능).
- `lib/lab-routes.js`의 secret-scrub/화이트리스트에 신규 모듈·env 추가 → 코드 뷰어로도 노출 안 되게.
- 에러 메시지에 키 echo 금지. 키 저장/검증 엔드포인트 rate-limit.

### 4.4 키 검증
- 저장 직전 **싸게 1회 검증 호출**: Anthropic = 짧은 messages(max_tokens 1) 또는 모델 목록; OpenAI = `GET /v1/models`. 유효하지 않으면 저장 거부 + 안내.

### 4.5 엔드포인트 (모두 로그인 + admin/beta 게이트)
- `GET  /api/keys/status` — set/unset + last4
- `POST /api/keys` `{provider, key}` — 검증 후 암호화 저장
- `DELETE /api/keys/:provider` — 삭제(즉시 폐기)

## 5. 게이팅 (관리자/베타 먼저)
- 베타 feature key 신설: 예 `skill-studio`. `requireAdminOrBeta("skill-studio")`로 페이지·엔드포인트·실행 전부 보호.
- `db/migrations`에 `insert into beta_features('skill-studio', ...)` 시드(enabled=true, 테스터 지정).
- 프런트: 허브에서 카드/탭 숨김 + `isAdmin || beta` 일 때만 노출(기존 패턴).
- **크레딧**: BYOK 스킬은 사용자 본인 키로 과금되므로 크레딧 차감 안 함. 단 `FREE_BETA_TYPES`는 역사적 이름의 "크레딧 면제 + 베타 게이트" allowlist이며, `type=free`/자유 보고서 이름과 무관하다. 비관리자 실행 시 **해당 provider 키가 저장돼 있어야 실행 허용**(없으면 키 등록 안내).
- 관리자는 키 없이도 env 키로 실행(서비스 크레딧 차감 없음).

## 6. 프런트엔드

### 6.1 새 페이지 `public/my-gpt.html` ("나만의 GPT / 스킬 스튜디오")
- (A) **API 키 설정 패널**: Claude 키 / GPT 키 입력·교체·삭제, 마스킹 표시(`sk-...abcd`), 상태 배지. 여기에 **"API 키 발급 방법" 버튼 → `/api-key-guide.html`로 이동**(누르면 이동).
- (B) **스킬 카탈로그**: 5개 카드(아이콘·이름·설명·필요한 키 표시). 카드 클릭 → 입력 폼.
- (C) **스킬 입력 폼 + 실행**: 스킬별 입력(파일/주제/옵션) → 기존 진행 로그 SSE + 다운로드 UI 재사용.
- 딥링크 `?skill=<key>` 지원(기존 `?report=` 패턴 따라).

### 6.2 별도 안내 페이지 `public/api-key-guide.html`
- 두 섹션, 탭/앵커 분리:
  - **Claude(Anthropic)**: console.anthropic.com → 가입/로그인 → Billing 결제수단 등록 → API Keys → Create Key → 복사 → Quilo에 붙여넣기. 비용·요금(토큰 과금) 한 줄 안내. 스크린샷/단계 카드.
  - **GPT(OpenAI)**: platform.openai.com → 로그인 → Billing 크레딧 충전 → API keys → Create new secret key → 복사 → 붙여넣기. 동일 형식.
  - 보안 주의(키는 비밀, 남과 공유 금지, 사용량 한도 설정 권장).
- 기존 페이지 톤/`style.css` 재사용. 허브 도움말에서도 링크.

## 7. 파일 변경 목록 (예정)

**신규**
- `lib/secret-box.js` — AES-256-GCM 암복호화
- `lib/user-keys.js` (또는 supabase.js에 함수 추가) — 저장/조회/삭제/검증
- `db/migrations/2026XXXX_add_user_api_keys.sql`
- `public/my-gpt.html`, `public/api-key-guide.html`
- `lib/pipelines/korean-lit-exam/*`, `lib/pipelines/eng-exam-prep/*`, `lib/pipelines/cap-translate/*`, `lib/pipelines/phys-mock-exam/*` (Phase 2, 각 generate.js·prompt.md·렌더러)

**수정**
- `server.js` — 키 엔드포인트 3개, PIPELINES에 스킬 등록, runGeneration에 `apiKeys` 주입, 게이팅, 허브 노출
- `lib/model-call.js` — `callGptReport`에 `apiKey` 인자
- `lib/pipelines/*/generate.js` — Anthropic 클라이언트가 `ctx.apiKeys.anthropic` 우선
- `lib/lab-routes.js` — secret scrub에 신규 모듈/env 추가
- `lib/version-info.js` — PATCH_NOTES 항목(배포 시)
- `.env.example` — `KEY_ENCRYPTION_SECRET` 문서화

## 8. 단계 (Phase)

- **Phase 0 — 보안 기반**: `secret-box.js`, `user_api_keys` 테이블, 키 저장/검증/삭제 엔드포인트, 마스킹 상태, scrub 등록, env 문서화. (단독 검증 가능)
- **Phase 1 — BYOK 배선 + 첫 스킬 E2E**: runGeneration `apiKeys` 주입 → **problem-set(이미 존재)**을 BYOK로 실행되게 + `my-gpt.html` + `api-key-guide.html` + 게이팅. → 전체 흐름을 신규 파이프라인 없이 증명.
- **Phase 2 — 신규 스킬 4종**(쉬운 순): eng-exam-prep → korean-lit-exam → cap-translate(.cap 재생성 검증) → phys-mock-exam(멀티에이전트, 최重).
- **Phase 3 — 마감**: 스킬별 저장 프리셋(나만의 GPT), 관리자 베타 토글 UI, 패치노트, docs, 회귀 테스트.

## 9. 열린 질문 / 검증 필요
1. `.cap` 재생성(rebuild) 가능성 — `cap-parser.js`는 읽기 전용. 원본 ZIP 구조 보존하며 텍스트만 치환해 재패키징하는 방식이 한글/PASCO에서 열리는지 검증 필요.
2. physics-mock-exam의 멀티에이전트를 단일 서버 프로세스에서 BYOK 키로 순차/병렬 호출하는 비용·시간(타임아웃) — JOB_TIMEOUT 별도 지정 필요.
3. "나만의 GPT" 프리셋의 범위(스킬별 옵션 저장만 vs 시스템프롬프트 커스터마이즈까지).
4. 키 미보유 사용자 UX — 실행 누르면 키 등록 모달 → 안내 페이지 링크.
5. 공개 저장소(Quilo) 동기화 시 키/PII 누출 점검.
