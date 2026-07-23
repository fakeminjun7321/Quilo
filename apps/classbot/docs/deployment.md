# Quilo 일정 관리 운영 배포 절차

기준일: 2026-07-16

Quilo 일정 관리 서비스는 별도 Render 서비스를 만들지 않고 기존 `quilolab.com` 서버의 `/schedule` namespace에 함께 배포한다. 실제 비밀값은 Git, 문서, 채팅, 스크린샷에 넣지 않는다.

## 1. 배포 전 확인

```bash
cd apps/classbot
npm ci
npm run release:check
```

- `apps/classbot`이 Git에 커밋되어 원격 저장소에 올라가 있어야 한다.
- 루트 `package.json`의 `postinstall`이 `apps/classbot` 의존성 설치와 Vite 빌드를 완료해야 한다.
- `node -c server.js`와 classbot 테스트가 모두 통과해야 한다.

## 2. Supabase 스키마

Supabase SQL Editor에서 [`db/schema.sql`](../db/schema.sql) 전체를 실행한다. 이 파일은 재실행 가능하게 작성되어 있다. 완료 후 아래 읽기 전용 SQL로 버전과 필수 RPC를 확인한다.

```sql
select id, version from public.classbot_schema_meta where id = 1;

select
  to_regprocedure('public.classbot_health_check()') is not null as health_rpc,
  to_regprocedure('public.classbot_create_member(uuid,text,text)') is not null as member_rpc,
  to_regprocedure('public.classbot_claim_invite(uuid,text,text,text)') is not null as invite_rpc,
  to_regprocedure('public.classbot_claim_quilo_invite(uuid,text,text)') is not null as quilo_invite_rpc,
  to_regprocedure('public.classbot_replace_timetable_day(uuid,integer,jsonb)') is not null as timetable_rpc,
  to_regprocedure('public.classbot_replace_member_timetable(uuid,uuid,jsonb)') is not null as member_timetable_rpc;
```

기대값은 schema version `7`과 모든 RPC의 `true`다. 기존 v6 운영 DB에는 [`007_immutable_quilo_identity.sql`](../db/migrations/007_immutable_quilo_identity.sql)을 적용할 수 있다. 모든 일정 관리 테이블은 RLS가 활성화되고 anon/authenticated 정책은 만들지 않는다. 서버만 service role key로 접근한다.

## 3. 기존 Render 서비스 설정

기존 Quilo Render 서비스의 Environment에 아래 값을 추가한 뒤 같은 서비스를 재배포한다.

최초 입력이 필요한 값:

- `CLASSBOT_CRON_SECRET`: 32자 이상
- `CLASSBOT_KAKAO_SKILL_SECRET`: 32자 이상
- `CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID`: Google Drive를 연결한 Quilo 관리자 계정 UUID. 표시 이름은 신원 확인에 사용하지 않는다.

자료실은 기존 Quilo의 Google OAuth 연결과 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CLOUD_TOKEN_SECRET`을 그대로 재사용한다. 관리자가 Quilo에서 Google Drive를 먼저 연결하면 서버가 제한된 `drive.file` 권한으로 `Quilo schedule 자료실` 폴더를 자동 생성하고, 그 폴더의 PDF·이미지만 일정 사이트와 챗봇에 표시한다. 공개 공유 링크를 만들지 않으며, 파일은 기존 15분 HMAC 링크를 거쳐 서버가 프록시한다.

반 전체 파일은 일정 사이트의 자료 업로드 화면을 통해 올려야 Google Drive 파일로 생성되어 동기화된다. `drive.file` 최소 권한 특성상 사용자가 Drive 화면에서 직접 만든 파일은 같은 폴더에 넣어도 Quilo 앱이 읽지 못할 수 있다. 개인 자료는 Drive에 올리지 않고 기존 비공개 Supabase 저장소에 유지한다. Drive 폴더 열기는 관리자에게만 제공하며 학생과 챗봇에는 Google 원본 링크를 노출하지 않는다.

기본 폴더 이름은 `CLASSBOT_GOOGLE_DRIVE_FOLDER_NAME=Quilo schedule 자료실`이다. `CLASSBOT_GOOGLE_DRIVE_FOLDER_ID`는 같은 Quilo OAuth 앱이 이미 생성해 접근 가능한 폴더를 지정할 때만 선택적으로 사용한다. 외부 Google Drive 앱이나 Connector가 만든 폴더 ID를 넣으면 `drive.file` 권한으로 접근할 수 없으므로 사용하지 않는다.

배포 후 관리자 세션으로 아래를 확인한다.

```text
GET  /schedule/api/admin/drive/status
POST /schedule/api/admin/drive/sync
```

서버는 `CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID`에 명시된 불변 Quilo 사용자 ID만 사용한다. `connected: true`가 아니면 이 UUID, Quilo의 Google 연결 상태, 세 OAuth 환경변수를 먼저 확인한다. Drive 연결이 실패해도 기존 Supabase 자료실은 계속 작동한다.

내장 운영에서는 `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`을 기존 Quilo 값으로 재사용한다. 운영 관리 화면은 별도 Classbot 관리자 비밀번호나 쿠키를 만들지 않고, 기존 Quilo 계정의 최신 `users.is_admin` 값을 매 요청 다시 검증한다. `CLASSBOT_ADMIN_PASSWORD`는 Classbot을 독립 서비스로 실행할 때만 필요하다.

첫 배포에서는 `KAKAO_EVENT_ENABLED=false`를 유지한다. `/schedule/api/health`가 다음 조건을 만족해야 한다.

```json
{"ok":true,"storage":"supabase","kakaoEnabled":false}
```

이 health check는 Supabase의 `classbot_health_check()` RPC와 schema version을 실제로 확인하며 실패 시 HTTP 503을 반환한다.

## 4. 읽기 전용 배포 후 점검

```bash
cd apps/classbot
CLASSBOT_EXPECT_STORAGE=supabase npm run smoke -- https://quilolab.com/schedule
```

Smoke test는 관리자 로그인을 시도하거나 데이터를 생성하지 않는다. 정적 화면, health, 익명 세션, 관리자 API 보호, Cron Bearer 보호, 카카오 스킬 secret 보호만 확인한다.

기본 배포에는 Cron Job이 없다. 자동 알림을 나중에 켤 때만 `/schedule/api/cron/notifications`를 호출하는 외부 Cron을 추가하고, REST API 키는 Render에 직접 입력한다.

## 5. 카카오 조회 기능 활성화

1. 기본 채널형 `Quilo` 채널을 생성한다. 사용할 수 없으면 `Quilo 일정`을 사용한다. `Class`는 넣지 않는다.
2. 챗봇 생성·채널 연결과 봇 배포를 완료한다. 단톡방에서 직접 호출하는 조회 기능만 쓸 때는 사업자 인증이나 월렛이 필요하지 않다.
3. 카카오 스킬에 공개 HTTPS `/schedule/api/kakao/skill` 엔드포인트와 `X-Classbot-Skill-Secret` 헤더를 연결하고 폴백 블록이 스킬 응답을 사용하게 한다.
4. `KAKAO_BOT_ID=6a57ace9fd013545b6416293`을 설정하고, `KAKAO_REST_API_KEY`는 Render에 직접 입력한다.
5. 개발봇 또는 테스트 채널에서 관리자에게 발급한 1회용 코드로 `가입 ABCD-EFGH`를 한 번 입력한 뒤 `오늘 일정`, `시간표 전체`, `파일 리스트`를 이름 없이 조회하고 개인 일정·개인 자료 격리를 확인한다.

학생 웹 포털은 `https://quilolab.com/schedule/`에서 기존 Quilo 계정으로 로그인한 뒤 관리자 초대 코드로 명단을 연결한다. 연결에는 Quilo 사용자 UUID가 저장되며 표시 이름은 인증에 사용하지 않는다. 학생은 본인 일정만 추가할 수 있고 관리자 역할만 반 전체 공개 범위를 선택할 수 있는지 확인한다.

자동 알림을 추가로 켜는 경우에만 비즈니스 채널 인증, 비즈앱, 카카오 로그인, 월렛과 Event 블록을 준비하고 이벤트명을 `quilo_schedule_notification`으로 설정한다. 테스트 구성원 한 명만 활성 수신자로 둔 상태에서 `KAKAO_EVENT_ENABLED=true`로 바꾸고 한 건만 시험 발송한다. POST 접수 후 task 결과가 `sent`로 확정되면 운영 Cron을 활성화하고, 실패하면 즉시 `KAKAO_EVENT_ENABLED=false`로 되돌린다.

실패 알림은 자동 재시도하지 않는다. 원인을 확인한 뒤 관리자 명시적 재시도만 사용한다.

## 6. 롤백 기준

다음 중 하나라도 발생하면 카카오 발송을 먼저 끄고 직전 정상 배포로 롤백한다.

- `/schedule/api/health`가 503이거나 schema version이 다르다.
- 관리자 세션이 반복 해제되거나 외부 Origin에서 관리자 API가 허용된다.
- 동일 일정·공지·Cron 실행에서 중복 알림이 생긴다.
- task 결과 조회 전 알림이 성공 처리된다.
- 데이터가 재배포 후 사라지거나 16명 정원·카카오 이름 1회 연결 규칙이 깨진다.

롤백 후에도 Supabase 스키마를 임의로 삭제하지 않는다. 먼저 `KAKAO_EVENT_ENABLED=false`로 전송을 정지하고 Render의 직전 정상 Deploy를 선택한다.
