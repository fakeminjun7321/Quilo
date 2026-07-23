# Quilo Agent Harness & Loop Engineering

이 문서는 Codex와 Claude Code가 Quilo를 같은 방식으로 수정·검증·배포하도록 만드는 공통 실행 계약이다. `AGENTS.md`가 규칙의 단일 원본이고, 이 문서는 그 규칙을 실제 작업 루프로 확장한다.

## 1. 목적

하네스 엔지니어링은 에이전트에게 “더 열심히 하라”고 반복하는 대신, 다음 작업을 에이전트가 직접 보고 실행하고 판정할 수 있게 만드는 일이다.

- 현재 상태와 제품 경계를 읽을 수 있는 문서·카탈로그·로그
- 한 명령으로 재현 가능한 서버·테스트·렌더 환경
- 코드 존재가 아니라 사용자 행동으로 판정하는 테스트
- 중단 뒤에도 이어갈 수 있는 구조화 체크포인트
- 권한, 보안, 운영 mutation을 넘지 않는 명시적 경계

루프 엔지니어링은 아래 반복이 증거에 의해 닫힐 때까지 계속하는 방식이다.

`관찰 → 재현 → 계약 → 최소 수정 → focused 검증 → 실제 실행 → 독립 평가 → broader gate → 체크포인트`

공식 참고 원칙:

- OpenAI, [Harness engineering](https://openai.com/index/harness-engineering/): 저장소 지식, 도구, UI·로그 가시성, 에이전트 리뷰 루프를 제품의 일부로 만든다.
- OpenAI, [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/): 사용자 입력, 도구 실행, 관찰, 다음 추론, 종료 상태를 하나의 명시적 루프로 본다.
- Anthropic, [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): 초기 환경, 기능 목록, 점진적 작업, Git·progress artifact로 세션 사이 상태를 잇는다.
- Anthropic, [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps): planner·generator·evaluator 역할과 sprint contract, 실제 브라우저 평가를 분리한다.

## 2. 시작 계약

### 모든 작업

1. 가장 가까운 `AGENTS.md`와 이 문서를 읽는다.
2. 변경 대상 파이프라인 문서를 읽는다.
3. `npm run harness:doctor`를 실행한다.
4. `git status --short --branch`, `git log -5 --oneline`으로 기준선을 기록한다.
5. 사용자·다른 에이전트의 기존 변경을 보존한다.
6. 목표, 완료 조건, 허용 경로, 외부 mutation 여부를 먼저 적는다.

### 모든 저장소 작업

```bash
npm run harness:init -- release-audit \
  --objective "운영 배포 전 전 경로 회귀와 실생성 검증" \
  --tool codex
```

생성되는 `.harness/runs/<run-id>/state.json`은 로컬 체크포인트다. 원문 업로드, 비밀번호, 이메일, 토큰, 쿠키, 키, 보고서 본문은 기록하지 않는다.

저장소를 읽거나 수정하는 Quilo 작업은 크기와 관계없이 작업별 run을 만든다. 단순 사용법 답변처럼 저장소를 전혀 읽거나 바꾸지 않는 대화만 생략할 수 있다. 이 규칙은 작은 작업에서 발견한 교훈도 다음 작업에 전달하기 위한 것이다.

재개할 때는 다음을 먼저 실행한다.

```bash
npm run harness:resume -- <run-id>
git status --short --branch
git log -5 --oneline
```

대화 요약이나 자동 메모리가 Git diff·테스트 결과·체크포인트와 충돌하면 후자를 우선한다.

## 3. 완료 계약

작업 시작 전에 판정 가능한 완료 조건을 만든다.

좋은 완료 조건:

- 특정 route×role×viewport×control 조합이 기대 상태와 일치한다.
- 입력 fixture가 이전 오류를 재현하고 패치 후 통과한다.
- 출력 ZIP/XML/PDF가 구조 게이트를 통과하고 raw marker가 없다.
- API 목록, 직접 ID, 검색, history, cloud, MCP 등 모든 노출 surface에서 같은 기능 상태를 보장한다.
- 배포 요청이면 운영 commit, health, 실제 경로, 같은 로그인 세션, 서버 로그를 확인한다.

나쁜 완료 조건:

- 코드가 존재한다.
- URL이 200이다.
- 자동 테스트가 많이 통과했다.
- 화면을 한 장 캡처했다.
- 에이전트나 심판이 “괜찮다”고 말했다.

테스트되지 않은 항목은 실패가 아니라 `미검증`으로 남긴다. 미검증 셀이 있으면 “모든 경로·모든 컨트롤 완료”라고 표현하지 않는다.

## 4. 반복 루프

한 반복은 하나의 가설과 최소 변경만 가진다.

1. **관찰**: 스크린샷, DOM, 서버 로그, 실패 산출물, 원본 데이터를 확보한다.
2. **재현**: 가장 작은 fixture 또는 사용자 경로로 실패를 다시 만든다.
3. **경계 분류**: UI, 입력 검증, 인증, job/SSE, 모델, parser, renderer, 저장, 배포 라우팅 중 어디인지 나눈다.
4. **계약**: 이번 반복이 바꿀 동작과 바꾸지 않을 동작을 적는다.
5. **최소 수정**: 공유 파일보다 가장 좁은 소유 모듈을 먼저 고친다.
6. **focused 검증**: 실패 fixture와 인접 회귀를 실행한다.
7. **결정론 검증**: 스키마, 숫자, ZIP/XML, magic bytes, `%%EOF`, raw marker, 권한 predicate를 검사한다.
8. **실제 실행**: 실제 프론트 모듈·CSS·브라우저 경로와, 필요 시 사용자가 지정한 실입력을 실행한다.
9. **독립 평가**: 구현 에이전트와 다른 관점에서 결과를 원본·완료 조건과 대조한다.
10. **broader gate**: `verify:quick` → 도메인 테스트 → `verify:core` → 필요 시 `verify:release` 순서로 넓힌다.
11. **규칙 검토**: 이번 작업에서 반복 가능한 새 교훈이 생겼는지 확인하고 공통 규칙·메모리·설정·계약 테스트 중 알맞은 위치에 승격한다.
12. **체크포인트**: 새 증거, 변경 파일, 명령·exit code, 위험, 다음 행동, 규칙 검토 결과를 기록한다.

반복마다 최소 하나가 새로 생겨야 한다.

- 코드 변경
- 새 진단 증거
- 새 테스트 또는 새로운 테스트 결과
- 범위가 줄어든 명확한 blocker

두 번 연속 새 증거가 없으면 재계획한다. 같은 실패가 세 번 반복되면 안전한 대안을 확인하고 체크포인트를 남긴 뒤 `blocked`로 전환한다.

## 5. 검증 계층

### 빠른 게이트

```bash
npm run verify:quick
npm run verify:quick -- --run <run-id>
```

각 반복 뒤 실행한다. 문서·하네스 계약과 diff 무결성을 빠르게 확인한다.

### 코어 게이트

```bash
npm run verify:core
npm run verify:core -- --run <run-id>
```

루트 unit/contract, security, report pipeline 테스트를 모두 실행한다. `tests/pipelines/`는 공유 프로세스·순차 실행 계약이 있으므로 임의 병렬화하지 않는다.

### 릴리스 게이트

```bash
npm run verify:release
npm run verify:release -- --run <run-id>
```

코어, 격리 Playwright QA, production dependency audit를 실행한다. Playwright QA는 스펙별 임시 포트와 외부 키 차단 환경을 사용한다. 외부 운영 URL에 전체 QA를 돌리지 않는다.

### 경로별 추가 게이트

`.harness/config.json`의 `routes`가 검증 라우팅의 기계 판독 원본이다.

- 수식·HWPX: `bash scripts/eq_gate.sh`
- PDF 통번역: `npm run test:pdf-translate`
- UI: 관련 Playwright spec + 실제 브라우저 journey + 시각 비교
- 인증·권한: 실제 handler/predicate fixture + security test
- 출력: 생성 단계와 렌더 단계를 분리하고, 캐시된 콘텐츠로 렌더를 반복 검증

테스트 expectation을 완화해 green으로 만들지 않는다. 제품 계약이 바뀐 경우에만 근거와 함께 expectation을 수정한다.

## 6. UI와 기능 전수 점검

기능 하나를 다음 surface의 묶음으로 본다.

- 카탈로그·메뉴·검색·도움말·패치노트
- 직접 URL·직접 ID·query/hash 진입
- 로그아웃, 일반, Pro/Max, 관리자 역할
- 데스크톱·모바일 viewport
- 입력, 선택, submit, cancel, retry, stop, preview, download
- 파일함·job history·analytics·background job
- public API, v1, MCP, cloud import/copy/comment

목록에서 숨긴 것만으로 퇴역 기능이 숨겨졌다고 판단하지 않는다. 같은 상태 계약을 모든 discovery·direct access surface에 적용한다.

UI는 headless 통과만으로 완료하지 않는다. 실제 화면에서 최소한 다음을 본다.

- 간격, 잘림, 가로 스크롤, 기본 브라우저 control 노출
- 빈 상태, loading, success, error, retry
- 모델 선택과 비용 갱신
- 원시 서버 로그·stack trace·내부 모델명이 일반 사용자에게 노출되지 않는지
- 배포 후 로그인 세션과 권한 표시가 유지되는지

## 7. 병렬 작업 계약

병렬화 전 각 lane에 아래 소유권을 부여한다.

- 파일·디렉터리
- 테스트 파일
- 로컬 포트·서버 PID
- 브랜치·worktree
- 외부 자원과 mutation 허용 여부

권장 lane:

- UI·브라우저
- 백엔드·생성 파이프라인
- 인증·보안·노출 surface
- 배포·운영 읽기 전용 검증

공유 renderer, 공통 수식 엔진, `server.js`, `package.json`처럼 충돌·파급이 큰 파일은 단일 소유자가 직렬 처리한다. 병합과 최종 gate는 중앙 조정자 한 명이 수행한다.

하위 작업 handoff는 반드시 다음을 포함한다.

- 조사 범위
- findings와 심각도
- 변경 파일
- 실행한 명령과 pass/fail
- 남은 blocker·risk

에이전트 보고를 그대로 믿지 않고 diff, 산출물, 원본으로 재검증한다.

## 8. 운영·배포 루프

배포는 push로 끝나지 않는다.

1. `docs/render-release-checklist.md`를 읽는다.
2. 기준 SHA, dirty baseline, migration 선행조건을 확인한다.
3. `npm run verify:release`를 통과한다.
4. 사용자가 승인한 범위에서 commit·push·deploy한다.
5. 배포 상태가 live인지 확인한다.
6. `/healthz`, `/api/version`, patch notes, 직접 경로를 확인한다.
7. 동일 브라우저 세션에서 로그인·역할이 유지되는지 확인한다.
8. Render 로그가 요청을 실제 서버까지 전달했는지 확인한다.
9. 생성 기능이면 job 시작, SSE 단계, 출력 저장, 다운로드 준비까지 확인한다.
10. 운영 mutation이 포함되면 별도 권한 경계와 복구 방법을 기록한다.

플랫폼 404와 앱 404를 구분한다. 요청이 서버 로그에 도달했는지, platform routing header가 있는지, 동시 부하에서만 재현되는지를 따로 확인한다.

## 9. 보안·권한 경계

- 실제 계정은 읽기 전용 검증에 우선 사용한다.
- 비밀번호, session cookie, Supabase key, provider key를 문서·명령 인자·체크포인트에 복사하지 않는다.
- 결제, 삭제, 이메일, 토큰 발급, 권한 변경은 local/mock/staging fixture를 우선한다.
- 운영 SQL, 키 회전, 외부 메시지, production write는 코드 배포와 별도 승인 경계다.
- 보안 도구가 위험한 공격 재현을 막으면 우회하지 않는다. 코드 근거, adversarial local fixture, safe smoke로 대체한다.
- parser 보안은 문자열 regex 하나로 끝내지 않는다. lexical gate → parser → normalized AST/schema → renderer 각 경계에 fixture를 둔다.
- 민감 보안 보고서와 공격 payload는 공개 저장소에 커밋하지 않는다.

공개 릴리스에서는 과거 비공개 Git 이력을 공개 원격에 연결하지 않는다. 정제된 현재
스냅샷만 기존 공개 이력 위에 반영하고, `npm run release:oss-check`와 Gitleaks를
모두 통과시킨다. 라이선스·권리 제한 경로 검사는 비밀값 검사를 대신하지 않으며,
두 결과를 따로 기록한다.

## 10. 체크포인트와 중단 조건

```bash
npm run harness:checkpoint -- <run-id> \
  --status in_progress \
  --next "관련 브라우저 spec 실행" \
  --note "실패 재현 fixture 추가"
```

작업 완료 시에는 규칙 검토가 필수다.

```bash
# 재사용 가능한 새 교훈을 공통 메모리에 반영한 경우
npm run harness:checkpoint -- <run-id> \
  --status complete \
  --rule-review "운영 404와 앱 404를 로그 도달 여부로 구분해야 함" \
  --promoted-rule "404 경계 판별 절차" \
  --changed docs/engineering/agent-memory.md

# 새 공통 교훈이 없는 경우에도 근거를 기록
npm run harness:checkpoint -- <run-id> \
  --status complete \
  --rule-review "기존 인증 세션 규칙이 이번 사례를 이미 완전히 포함함"
```

공통 규칙은 작업 일지가 아니다. 다음 조건을 모두 만족하는 교훈만 승격한다.

- 이후 Quilo 작업에서도 재사용할 수 있다.
- 관찰 증거나 회귀 테스트가 있다.
- 비밀정보, 개인정보, 원문 대화, 임시 commit·deploy·job·PID를 포함하지 않는다.

`complete`에는 비어 있지 않은 `ruleReview`가 필요하다. `promotedRules`가 있으면 `.harness/config.json`의 `learning.durableSources` 중 하나가 변경 파일에 포함되어야 한다. 따라서 에이전트가 규칙 검토를 생략하거나 “나중에 메모하겠다”고 하고 종료할 수 없다.

필수 상태는 `.harness/state.schema.json`에 정의한다.

완료 조건:

- 모든 acceptance criterion 충족
- 필수 focused/domain/broader gate 통과
- 실제 UI·산출물 확인
- diff와 보안 경계 검토
- 공통 규칙 검토와 필요한 승격 완료
- 배포 요청이면 라이브 확인

중단 조건:

- 사용자 즉시 중지 요청
- 실제 외부 권한 또는 소유자 판단 필요
- 파괴적이거나 법적·금융적 external action에 새 승인 필요
- 같은 실패 3회 또는 새 증거 없는 loop 2회
- 런타임이 실제 제공한 잔여 토큰 5% 이하

잔여 토큰 비율을 제공하지 않는 환경에서는 숫자를 추측하지 않는다. 8회 반복마다 진행 중이어도 체크포인트와 재계획을 수행한다. flaky test는 원인 조사 뒤 한 번만 재실행하며, 두 번째 통과로 첫 실패를 지우지 않는다.

macOS 장기 실행에서 `caffeinate`를 쓸 때는 시작 PID와 소유자를 체크포인트에 기록하고, 모든 종료 경로에서 자신이 시작한 PID만 정리한다.

## 11. 완료 보고 형식

완료 보고는 다음을 분리한다.

- 완료된 동작
- 실행한 검증과 pass/fail 수
- 실제 브라우저·산출물·운영 증거
- 배포 commit과 live 상태
- 미검증 항목·잔여 risk·외부 확인 필요 항목
- 체크포인트와 정확한 다음 명령

“코드상 가능”, “로컬 fixture 통과”, “운영에서 확인”은 서로 다른 증거 등급이다. 섞어서 보고하지 않는다.
