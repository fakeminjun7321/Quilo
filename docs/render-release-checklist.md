# Quilo Render 릴리스 체크리스트

프론트엔드 전면 개편을 운영 환경에 반영하기 전후로 확인할 읽기 전용 기준이다. 운영 사용자·크레딧·파일·토큰을 생성하거나 수정하거나 삭제하는 검증은 하지 않는다.

## 1. Render 설정

- Runtime: `Node`
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`
- Production branch: 배포 직전 확정한 브랜치
- `NODE_ENV=production`

필수 비밀값은 Render Environment에만 저장하고 Git에 넣지 않는다.

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `SESSION_SECRET`

관리자도 일반 Quilo 계정으로 로그인하고 최신 `users.is_admin` 권한으로만 판정한다.
Render에는 별도 관리자 아이디·비밀번호를 저장하지 않는다. 최초 관리자 지정은 정확한
계정 UUID/username을 확인한 뒤 Supabase SQL Editor에서 `is_admin=true`만 변경한다.
비밀번호 분실은 `/password-reset.html`의 인증 이메일 흐름으로 복구한다.

`SESSION_SECRET`은 32자 이상인 별도 랜덤 값이어야 한다. 운영 서버는 누락되거나
짧으면 시작을 거부하며, 공개 URL 같은 값에서 세션 키를 파생하지 않는다.
운영 서버는 Supabase 설정이 없을 때도 시작을 거부한다. 정식 서비스에서는
`ALLOW_STATELESS_PRODUCTION=1`을 설정하지 않는다.

Quilo Bot 비용 제어 권장값:

- `OPENAI_CHAT_MODEL=gpt-4o-mini`
- `OPENAI_CHAT_MEMO_MODEL=gpt-4o-mini`
- `OPENAI_CHAT_API_BASE=https://api.openai.com/v1`
- `CHAT_MAX_TOKENS=700`
- `CHAT_DAILY_MAX=1500`

## 2. 배포 전 로컬 검증

Supabase SQL Editor에서 아래 운영 마이그레이션이 적용됐는지 먼저 확인한다.

- `db/migrations/20260721_add_credit_reservation_ledger.sql` — 재시작 안전 크레딧 예약·정산·환불 원장
- `db/migrations/20260722_add_password_reset.sql` — 단일 사용 비밀번호 재설정 토큰
- `db/migrations/20260715_add_product_telemetry.sql` — 서비스 품질·감사 로그
- `db/migrations/20260702_add_user_api_keys.sql` — 사용자 BYOK
- `db/migrations/20260705_add_artifact_owner_id.sql` — 불변 사용자 ID 소유권과 신규 null 소유자 차단

크레딧 원장 마이그레이션이 빠지면 서버는 안전을 위해 유료 생성을 `503`으로 차단한다.
따라서 코드 배포보다 먼저 적용해야 하는 정식 운영 배포의 필수 조건이다.

기존 관리자 계정에 인증 이메일이 저장되어 있지 않다면, 비밀번호 재설정 마이그레이션을
먼저 적용한 다음 `db/operations/set_admin_recovery_email.sql`의 두 placeholder를 로컬에서
바꾸어 한 번만 실행한다. 이 운영 SQL은 `is_admin=true`인 정확히 한 계정만 갱신하며,
실제 아이디나 이메일은 저장소 또는 채팅에 남기지 않는다.

```bash
node -c server.js
node --test tests/*.test.js
npm run test:qa
```

- 첫 화면과 공통 페이지에서 데스크톱 상단바가 동일한지 확인한다.
- `/api/chat/status`가 비활성인 환경에서도 홈의 `물리 결과보고서 시작` fallback이 실제
  물리 결과보고서 폼으로 이동하는지 확인한다.
- 390px 모바일 보고서 화면에서 단계 안내와 활성 입력 폼이 긴 상태 요약보다 먼저
  표시되고 가로 스크롤이 생기지 않는지 확인한다.
- 화학 사전/결과 및 물리 결과 폼에서 사용 가능한 AI 모델을 바꿨을 때 선택 상태와
  예상 비용이 즉시 갱신되는지 확인한다.
- Quilo Bot 텍스트 입력·스트리밍·음성 받아쓰기를 확인한다.
- 제거한 `/tools/word-count.html`, `/tools/regression.html`, `/tools/graph.html`이 더 이상 노출되지 않는지 확인한다.
- 관리자 화면은 fixture 또는 읽기 전용 API로만 렌더링한다.
- Git diff에 `.env`, `.env.local`, 키, 운영 사용자 데이터가 없는지 확인한다.
- `JOB_ARTIFACT_MEMORY_MAX_BYTES`(기본 128MiB), `JOB_ARTIFACT_MEMORY_TTL_MS`(기본 15분),
  `MAX_CONCURRENT_GENERATIONS`(기본 10), `MAX_GENERATION_QUEUE`(기본 6),
  `MAX_UPLOAD_MEMORY_MB`(기본 256)가 Render 인스턴스 메모리·CPU에 맞는지 확인한다.
- `VIBE_IMAGE_CONCURRENCY_PER_USER`(기본 2)가 이미지 공급자 한도와 맞는지 확인한다.
- Supabase 파일함을 임시로 사용 불가 상태로 두고 픽스처 생성을 실행했을 때,
  24시간 보관 실패가 `done`·크레딧 정산으로 넘어가지 않고 작업 오류·예약 환불로
  종료되는지 확인한다. 정상 저장 시에는 `fileId`(또는 Google/Dropbox 파일
  식별자)가 있어야 한다.
- `MCP_OAUTH_REDIRECT_ALLOWLIST`를 쓴다면 완전한 HTTPS callback URL만 등록하고,
  유사 prefix URL이 허용되지 않는지 확인한다.

## 3. 배포 후 읽기 전용 점검

- `GET /healthz`가 `{ "ok": true }`를 반환한다.
- `GET /api/version`에서 서버 버전 응답과 클라우드 설정 boolean만 확인한다.
- `GET /api/chat/status`에서 Quilo Bot이 활성화되고 모델명이 기대값인지 확인한다.
- 로그아웃 홈, 가이드, 개발자 페이지, 앱 소개 페이지, 로그인·회원가입 화면을 연다.
- 관리자 계정으로 로그인할 때는 목록 조회까지만 확인하고 저장·삭제·크레딧·권한 버튼을 누르지 않는다.
- 보고서 생성·결제·이메일·API 토큰 발급은 운영 스모크 테스트에서 호출하지 않는다.

## 4. 롤백 기준

다음 중 하나라도 발생하면 직전 정상 배포로 롤백한다.

- 로그인 또는 세션이 반복 해제된다.
- 보고서 폼이 열리지 않거나 제출 계약의 `id`, `name`, endpoint가 달라졌다.
- 관리자 페이지가 읽기만 해도 사용자 정보를 수정한다.
- Quilo Bot 오류율이나 비용이 급증한다.
- 데스크톱 기본 화면에 가로 스크롤·메뉴 겹침·빈 화면이 발생한다.
