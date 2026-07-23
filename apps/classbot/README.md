# Quilo schedule

2학년 4반의 개인별 시간표, 수행평가·과제 일정, 반 공지와 카카오톡 조회를 관리하는 Quilo 내장 기능이다. 관리자와 학생 화면은 데스크톱·모바일을 지원한다. 웹과 카카오는 관리자가 발급한 1회용 초대 코드로 불변 계정 식별값을 명단에 연결하며, 표시 이름은 인증에 사용하지 않는다.

## 현재 구현 범위

- 관리자·학생 공통 메뉴: 오늘, 일정, 공지, 자료실, 구성원, 설정
- 학생용 월·주·일 캘린더, 개인별 시간표, 일정 추가, PDF·이미지 드라이브
- 최대 16명 구성원과 기존 Quilo 로그인 세션 기반 접근 제어
- 카카오 챗봇 명령: `도움말`, `가입 ABCD-EFGH`, `오늘 일정`, `다음 일정`, `이번 달 일정`, `이번 주 남은 일정`, `수행평가 과제 통합 요약`, `시간표 전체`, `파일 리스트`, `김종수T 학습지`
- 파일명·별칭이 정확히 일치하면 바로 보내고, 비슷하면 최대 3개 후보를 물은 뒤 `맞아` 또는 번호 응답으로 보낸다.
- 반 전체 일정과 구성원별 개인 일정, 개인 일정 대상자에게만 보내는 알림
- 학생은 자기 개인 일정만 생성·수정·삭제하고, 관리자 역할만 반 전체 일정을 생성·수정·삭제한다.
- 반 전체 자료는 Google Drive, 개인 자료는 비공개 Supabase 저장소에 보관하고 15분 프록시 링크로만 연다.
- Google Drive 운영 계정은 기존 Quilo의 `구민준` 계정을 정확한 이름으로 찾아 연결한다.
- 일정 마감·변경, 평일 아침 시간표, 반 공지 Event API 알림
- Event API 작업 결과 조회와 사용자별 성공·실패 기록
- 일정·공지 생성 멱등성, 명시적 실패 재시도, 감사 로그
- 로컬 메모리 저장소와 운영 Supabase 저장소

## 로컬 실행

Node.js 20 이상이 필요하다.

```bash
cd apps/classbot
npm ci
cp .env.example .env
npm run dev
```

- 웹: `http://localhost:5173`
- API: `http://localhost:4310`
- 개발 기본 관리자 비밀번호: `local-admin`
- 로컬 메모리 데이터는 서버 재시작 시 초기화된다.

검증은 다음 명령으로 실행한다.

```bash
npm run check
npm audit --omit=dev
# 또는 전체 릴리스 점검
npm run release:check
```

## 운영 배포

1. Supabase 프로젝트의 SQL 편집기에서 [`db/schema.sql`](./db/schema.sql)을 적용한다. 기존 v5 운영 DB는 [`db/migrations/006_kakao_personal_event_actions.sql`](./db/migrations/006_kakao_personal_event_actions.sql)을 적용한다.
2. 기존 Quilo Render 서비스에 Cron·카카오 스킬 비밀값을 설정한다. Supabase 연결과 관리자 로그인은 기존 Quilo 설정을 그대로 쓴다.
3. 기존 Quilo 서비스를 재배포한다. 루트 `postinstall`이 일정 관리 화면을 함께 빌드한다.
4. `GET /schedule/api/health`가 `ok: true`와 `storage: supabase`를 반환하는지 확인한다.
5. 관리 화면은 `/schedule/`, 카카오 스킬은 `/schedule/api/kakao/skill`을 사용한다.

일정 관리는 별도 Web Service를 만들지 않고 기존 Quilo 프로세스의 `/schedule` namespace에서 동작한다. 자동 알림이 필요해질 때만 외부 Cron과 Event API 설정을 추가한다. 메모리 저장소는 데이터와 중복 방지 기록이 재시작 때 사라지므로 운영에서 사용할 수 없다. 세부 순서와 롤백 기준은 [`docs/deployment.md`](./docs/deployment.md)를 따른다.

## 카카오 챗봇 연결

단톡방에서 사용자가 직접 질문하고 답을 받는 조회 기능에는 배포된 챗봇과 공개 HTTPS 스킬 URL이 필요하다. 사업자 인증·월렛·Event API는 챗봇이 먼저 메시지를 보내는 자동 알림을 켤 때만 추가로 필요하다.

- 스킬 URL: `POST https://quilolab.com/schedule/api/kakao/skill?secret=CLASSBOT_KAKAO_SKILL_SECRET`
- Event 이름: 관리자센터 값과 `KAKAO_EVENT_NAME`을 정확히 동일하게 설정
- Event API 활성화: 준비가 끝난 뒤 `KAKAO_EVENT_ENABLED=true`
- 최초 가입: 관리자가 발급한 1회용 초대 코드로 `가입 ABCD-EFGH` 입력. 표시 이름만으로는 가입할 수 없다.
- 등록 후 조회: `오늘 일정`, `내일 시간표`, `시간표 전체`, `파일 리스트`처럼 이름 없이 사용
- 개인 일정 변경: `내일 영어 과제 추가`, `수학 수행평가 22일로 변경`, `방금 일정 완료`처럼 입력하고 10분 안에 확인. 반 전체 일정은 카카오에서 변경할 수 없음
- 명시적 대상 조회: 미등록 상태이거나 다른 구성원의 공개 일정을 볼 때만 `오늘 일정 등록이름`처럼 이름을 맨 뒤에 입력

Event API의 POST 성공은 접수 성공일 뿐 실제 전송 완료가 아니다. 이 서비스는 `taskId` 결과 조회 후에만 `sent`로 기록하며, 실패는 자동 재시도하지 않는다. 상세 운영 정책은 [`server/README.md`](./server/README.md), 공식 연동 근거와 열품타 정책은 [`docs/integrations.md`](./docs/integrations.md)를 참고한다.

## 열품타

2026-07-16 기준 일반 개발자가 사용할 수 있는 공식 공개 API·웹훅·OAuth·ICS 내보내기 문서를 확인하지 못했다. 따라서 비공개 API 역공학, 토큰·쿠키 추출, 앱 자동화 또는 화면 스크래핑은 사용하지 않는다. 현재는 Quilo를 학급 일정 원본으로 사용하고 필요한 항목만 열품타 Todo로 직접 옮기는 방식이다.
