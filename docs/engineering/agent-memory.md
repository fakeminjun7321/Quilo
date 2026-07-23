# Quilo Durable Agent Memory

Codex와 Claude Code의 Quilo 관련 로컬 작업 기록에서 반복적으로 확인된 안정적인 교훈만 정리한 메모리다. 원문 대화, 비밀번호, 토큰, 쿠키, 키, 이메일, 보고서 입력, 개인 파일 내용은 포함하지 않는다.

이 문서는 “현재 작업 일지”가 아니다. 자주 바뀌는 commit, deploy ID, job ID, 임시 PID는 `.harness/runs/<run-id>/state.json`에만 기록한다.

## 저장소와 운영

- 공개 저장소 범위는 웹·Render 파이프라인이다. iPad 로컬 앱과 권한 있는 학교 템플릿은 별도 경계다.
- 운영 서비스는 `https://quilolab.com`, Render production branch는 `main`이다.
- Render health 경로는 `/healthz`다. `/health` 또는 `/api/health`를 추측하지 않는다.
- 관리자도 일반 Quilo 로그인 시스템을 쓰고 `users.is_admin`으로 권한을 판정한다. 별도 관리자 아이디·비밀번호 환경변수를 만들지 않는다.
- `SESSION_SECRET`이 유지되는 정상 배포에서는 로그인 세션이 살아야 한다. 비밀번호·역할·계정·세션 키 변경은 기존 세션을 fail-closed로 끊어야 한다.
- 배포 완료는 push가 아니라 Render live, 운영 commit, health, 실제 경로, 로그까지 확인한 상태다.

## 반복해서 놓친 UI 결함

- 기본 브라우저 file input, 무스타일 dialog, 잘못된 모바일 순서, `NaN` 예상 시간, 원시 콘솔 로그는 정적 코드와 headless 일부 테스트만으로 놓치기 쉽다.
- 보고서·Studio·PDF 번역의 일반 사용자 진행 화면에는 raw server/model log를 기본 노출하지 않는다. 단계와 현재 작업만 보여주고 관리자 debug는 별도 경계로 둔다.
- “기능 코드가 있다”와 “사용자가 들어갈 수 있다”는 다르다. 메뉴, 검색, query/hash, 직접 ID, 폼의 라디오·서브모드까지 실제 연결을 확인한다.
- 실제 screenshot을 기준 화면과 같은 viewport·상태로 비교하고, padding·잘림·가로 스크롤·font weight·border·button hierarchy를 직접 본다.

## 기능 노출 surface

- 기능 상태는 목록 하나가 아니라 catalog, menu, search, direct route, form, files, jobs, history, analytics, API, v1, MCP, cloud import/copy/comment 전체에 적용한다.
- retired 또는 미출시 기능은 과거 파일명·metadata·patch note를 통해 다시 노출될 수 있다. historical artifact도 같은 상태 계약으로 필터링한다.
- role 화면을 mock으로 렌더한 결과와 실제 운영 인증 결과를 구분한다. admin fixture 통과는 운영 관리자 로그인 성공의 증거가 아니다.

## 생성 job과 저장

- 생성 성공은 `POST /api/generate` 200이 아니다. job 시작, SSE 재연결, 취소, 생성, 구조 검증, 24시간 저장, 다운로드 준비까지 하나의 수명주기다.
- 영구 또는 24시간 저장이 실패하면 `done`과 크레딧 정산으로 넘어가면 안 된다. 예약 환불은 idempotent해야 한다.
- queue, concurrency, memory limit을 변경할 때 job ownership과 재시작 복구를 함께 검증한다.
- 실제 생성 검증은 사용자가 명시한 fixture만 업로드하고, Render 로그·job ID·QA 지표·결과 링크를 증거로 남긴다.

## 보고서·출력 불변식

- 업로드 원본 데이터가 authoritative다. 보이지 않는 수치, 측정값, 오차 원인, 제외 기준을 만들지 않는다.
- 사용자가 정리한 엑셀/CSV가 `.cap` 원자료보다 우선이라는 규칙을 유지한다.
- 생성과 렌더를 분리한다. LLM 콘텐츠 JSON·binary sidecar를 캐시하면 renderer 수정은 추가 모델 호출 없이 반복할 수 있다.
- DOCX/HWPX/PDF는 눈으로만 보지 않는다. ZIP/XML, embedded binary, table data, raw equation marker, PDF magic/EOF, 페이지 수를 결정론적으로 검사한다.
- HWPX 수식 postprocess 실패는 fatal이다. raw `{{EQ...}}`를 남긴 파일을 내보내지 않는다.
- 프린트 PDF 복원은 semantic schema와 고정 renderer를 거쳐야 한다. TeX 허용 목록은 lexical escape와 parser 정규화 우회까지 adversarial fixture로 검증한다.

## 테스트와 브라우저

- `tests/QA`는 spec별 임시 포트와 외부 key 차단 환경을 사용한다. 고정 포트 3000 하나를 병렬 spec이 공유하거나 서로 teardown하지 않는다.
- `tests/pipelines/`는 한 프로세스의 순차 실행 계약이 있다. 임의 병렬 실행하지 않는다.
- 실제 프론트 모듈과 CSS를 로드하고 필요한 API만 stub하는 browser harness가 전체 화면을 가짜 HTML로 재현하는 것보다 신뢰도가 높다.
- 404는 앱, Render edge, 인증 gate를 구분한다. 서버 로그에 요청이 도달했는지 확인한다.
- 조직 정책으로 Chrome 다운로드가 차단될 수 있다. 앱의 생성 실패와 혼동하지 말고 server job 완료, preview endpoint, 파일 저장, magic/EOF gate를 별도로 본다.

## 병렬 작업

- 병렬 agent는 UI, backend, security, operations처럼 bounded lane으로 나눈다.
- 같은 파일, 같은 포트, 같은 서버 lifecycle을 동시에 소유하지 않는다.
- 공용 renderer·수식 엔진·`server.js`·`package.json`은 단일 소유자가 통합한다.
- 하위 agent의 “통과”를 그대로 신뢰하지 않는다. 중앙 조정자가 diff와 전체 gate를 다시 실행한다.
- 다른 worktree나 사용자의 WIP를 덮지 않는다. 작업 파일만 명시적으로 stage한다.

## 작업 중단과 재개

- Codex의 Quilo 세션은 많았지만 durable memory가 비어 있어 같은 탐색과 실수가 반복됐다. 그래서 저장소 문서와 구조화 state를 공통 기억으로 사용한다.
- 체크포인트에는 objective, acceptance criteria, base SHA, dirty baseline, iteration, changed files, test exit code·duration, risk, blocker, next action을 남긴다.
- 세션 재개 시 대화 원문을 다시 훑기 전에 `harness:resume`, Git history, 관련 파이프라인 문서를 읽는다.
- 정확한 토큰 잔여율이 5% 이하이면 체크포인트 후 중단한다. 잔여율이 없으면 추측하지 않는다.
- `caffeinate`, local server, browser tab은 소유 PID·ID를 남기고 자신이 만든 자원만 cleanup한다.

## 지속적인 규칙 학습

- 모든 Quilo 저장소 작업은 종료 전에 공통 규칙 갱신 여부를 검토한다. 작업 크기가 작다는 이유로 생략하지 않는다.
- 반복 가능한 새 교훈은 가장 좁은 지속 원본에 승격한다. 제품 불변식은 `AGENTS.md`, 실행 절차는 `agent-harness.md`, 경험적 교훈은 이 문서, 기계 판독 계약은 `.harness/config.json`, 깨지면 안 되는 동작은 테스트에 둔다.
- 일회성 오류 메시지, 현재 commit·deploy·job·PID, 개인 데이터, 원문 채팅은 공통 규칙에 넣지 않는다.
- 기존 규칙이 이미 사례를 완전히 포함하면 문서를 억지로 바꾸지 않는다. 대신 완료 체크포인트의 `ruleReview`에 중복 승격하지 않은 이유를 기록한다.
- 규칙을 승격했다면 해당 규칙이 실제로 로드되고 강제되는지 계약 테스트를 함께 추가하거나 갱신한다.

## 완료 선언

- 테스트 개수보다 manifest coverage와 실제 운영 증거를 우선한다.
- `완료`, `미검증`, `운영에서만 확인 가능`, `외부 앱 수동 확인 필요`를 분리한다.
- macOS 한글에서 열림은 Windows 한컴 확인을 대신하지 않는다.
- 릴리스 보고에는 pass/fail 수, 실제 route·role·viewport, 생성 산출물, live commit, 남은 risk를 각각 적는다.
