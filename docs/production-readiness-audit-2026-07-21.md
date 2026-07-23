# Quilo 정식 출시 준비 점검 기록 — 2026-07-21

이 문서는 현재 작업 트리의 출시 준비 상태와, 코드만으로 완료할 수 없는 운영 검증을
구분해 남기는 작업 메모다. 실제 사용자 업로드나 운영 계정 데이터는 점검에 사용하지
않았다.

## 현재 결론

코드 기준의 주요 보안·신뢰성 위험은 보강했지만, 아래 **배포 차단 조건**을 운영에서
확인하기 전에는 정식 출시 완료로 판정하지 않는다.

1. Render에 32자 이상의 별도 `SESSION_SECRET`, Supabase service key, AI 공급자 키를
   설정하고 시작 실패가 없는지 확인한다.
2. Supabase 파일함 장애 시 생성 작업이 `done` 또는 크레딧 정산으로 넘어가지 않고
   환불되는지 스테이징에서 확인한다.
3. 실제 생성한 DOCX/HWPX의 macOS 한글 검증은 완료했다. 동일 파일을 Windows 한컴에서
   열어 표·수식·이미지와 첫 페이지 제목 박스를 최종 확인한다.

`20260705_add_artifact_owner_id.sql`과 `20260721_add_credit_reservation_ledger.sql`은
운영 Supabase에 적용됐으며, `artifacts.owner_id`, `credit_reservations`, 예약·갱신·정산·
환불 RPC 5개가 운영 service-role의 실제 PostgREST schema에 노출되는 것을 확인했다.

## 완료된 보강

### 생성·결제·파일

- 유료 생성은 DB 원장에 크레딧을 먼저 예약하고, 완료 시 정산하며 실패·중단 시 환불한다.
- 결과 파일은 운영 저장소의 식별자를 확인한 뒤에만 완료·정산한다. 저장 실패는
  `ARTIFACT_PERSISTENCE_FAILED`로 fail-closed 처리한다.
- 파일함 저장은 제한된 지수 backoff로 재시도하고, 영구 오류는 즉시 중단한다.
- 다중 PDF 결과의 보상 삭제는 `job.fileId`뿐 아니라 모든 `files[].fileId`를 정리한다.
- 완료 파일의 메모리 TTL/LRU, 사용자별 소유권, 24시간 저장 fallback을 보강했다.
- 생성 동시성·대기열 길이·대기시간·전체 multipart RAM 예산을 제한했다.
- 공유 multipart RAM 예산의 반납 훅을 `/api` 공통 경계에 설치해 학교 도입 신청,
  변환 도구, 파일 챗, 보고서 생성 등 모든 `makeUpload()` 소비자가 응답 종료 시 lease를
  반납한다. 장기 생성 작업은 기존처럼 job으로 소유권을 넘긴 뒤 작업 종료 시 반납한다.
- 바이브 이미지 생성은 공급자 호출 전에 크레딧을 예약하고 사용자별 동시 실행을 제한한다.
- 장시간 Studio 생성은 4분마다 durable credit reservation lease를 갱신하고 모델 호출이
  끝나면 heartbeat를 해제한다.

### 인증·권한·외부 연동

- 운영 세션 비밀값 누락·짧은 값은 서버 시작 단계에서 거부한다.
- 관리자도 일반 `users` 계정과 같은 로그인·비밀번호 재설정 흐름을 사용하고, 권한은
  최신 `is_admin` 값으로만 판정한다. 서버 시작 시 환경변수로 관리자 생성·승격·비밀번호
  변경을 하지 않는다. 손상된 password hash는 500이 아니라 인증 실패로 안전하게 처리한다.
- 로그인 요청에 동일 출처 검사를 적용하고, 운영 권한 조회 실패는 허용하지 않는다.
- `/api/me`와 로그인 응답은 표시 이름이 아닌 불변 사용자 ID를 제공한다.
- 레거시 `owner_id=null` 산출물은 이름 일치만으로 일반 사용자에게 공개하지 않는다.
- OAuth redirect URI는 완전 일치 HTTPS URL만 허용하고 동적 클라이언트 등록에 제한을 둔다.
- 연동 상태 조회와 실제 Drive/Dropbox 데이터 접근 scope를 분리했다.
- 액세스 토큰 폐기 시 같은 사용자·리소스의 refresh token family도 함께 폐기한다.
- MCP 액세스 토큰 폐기 시 같은 사용자·리소스의 기존 access token sibling도 함께
  폐기해, refresh token을 여러 번 사용해 발급된 토큰이 남지 않게 했다.
- Webhook은 DNS 해석 결과를 검증한 뒤 그 IP로 연결하고 redirect를 거부해 SSRF 재바인딩을 막는다.
- Webhook 생성의 사용자별 count/insert 구간을 현재 단일 프로세스 안에서 직렬화했다.
  Render를 수평 확장할 때는 이 제약을 DB 원자 RPC로 옮겨야 한다.

### 업로드·파서·실행 격리

- PDF, Office ZIP, HWPX, CAP, XLS, 이미지의 실제 파일 시그니처를 확장자와 함께 검증한다.
- DOCX, XLSX, HWPX ZIP은 entry 수, 실제 inflate byte, 총 압축 해제량, 압축비를 제한한다.
- 스프레드시트는 한 번의 bounded parse 결과를 Markdown과 canonical table에 재사용한다.
- BYOK Anthropic Files API 업로드와 삭제에 같은 활성 사용자 키를 사용한다.
- 브라우저 코드 실행은 메인 페이지 `eval` 대신 시간·출력·API가 제한된 Worker에서 수행한다.
- 계정 전환·로그아웃 시 보고서 초안, 학번, 편집기 코드 등 민감한 브라우저 저장값을 지운다.

### 프론트엔드·운영 품질

- 모델 가용성·권한과 실제 선택 가능한 옵션을 동기화하고 서버 정책으로 재검증한다.
- 390px 모바일 보고서 진입 시 긴 상태 요약보다 단계 안내와 활성 입력 폼을 먼저
  배치해 작업 시작점이 첫 화면에 보이도록 했다.
- 채팅 제공자가 비활성인 환경에서도 홈의 큰 fallback 카드가 물리 결과보고서로
  실제 이동하도록 바꿨고, 메모 첨부 파일 입력을 기존 폼 토큰으로 정리했다.
- SSE 재연결, 취소, 비용 표시, 실패 상태를 보강했다.
- `/api/version` 기본 응답을 최소화하고 상세 노트는 명시적 요청에서만 제공한다.
- 보안 헤더, sitemap, 키보드 접근성, dropzone 상태, 공통 shell 일관성을 개선했다.
- 공급망 빌드·배포 구성은 별도 점검 결과와 함께 최종 회귀 테스트로 확정한다.
- Render가 넓은 `>=18` 범위에서 Node 26 Current를 선택하지 않도록, 로컬에서 최종
  회귀한 Node `24.18.0`과 `24.x` LTS 계열을 `.node-version`과 package engine에 고정했다.
- Studio 팝아웃은 생성 HTML을 `document.write`의 script 파서 문맥에 넣지 않고, 정적
  wrapper를 만든 뒤 sandboxed iframe의 `srcdoc` DOM 속성으로만 전달한다.
- Dropbox 보상 삭제는 `path_lookup/not_found`만 이미 삭제된 성공으로 보고, 권한·제한·
  충돌을 포함한 다른 409는 retry handle을 보존하도록 실패 처리한다.

## 검증 근거

- 업로드 위장 파일, ZIP forged-size/과도한 entry/실제 inflate 초과 PoC가 거부된다.
- 정상 XLSX/XLS/CSV와 저장소에서 생성한 HWPX는 강화된 파서를 통과했다.
- 결제 원장, 예약 보상, 영속 저장, 다중 파일 정리, OAuth scope·폐기, webhook SSRF,
  브라우저 저장소 격리, Worker 격리 테스트를 추가했다.
- 병렬 최종 회귀에서 Root Node·보안·파이프라인·PDF 번역·Classbot·JS/Python SDK를 합쳐
  `963/963`, Playwright QA `523/523`이 통과했다. 실패·skip은 0개다.
- Playwright QA는 안정적인 단일 worker 실행에서 통과했다. 공개 route,
  1440/933/390px shell, 보고서 모델 선택, mocked 생성/SSE 재연결, 인증, 관리자,
  PDF·OCR, 외부 연동 흐름을 실제 Chromium으로 확인했다.
- 홈과 화학 사전보고서의 데스크톱·모바일 화면을 같은 뷰포트에서 전후 비교했고,
  브라우저 page error·console error와 가로 overflow가 없음을 확인했다. 비교 기록은
  `design-qa.md`와 외부 시각화 폴더에 남겼다.
- Root와 Classbot의 production `npm audit`는 모두 취약점 0개이며,
  `git diff --check`도 통과했다.
- Linux amd64 HF Docker 이미지를 실제로 빌드·실행해 uid 1000, Node 의존성,
  PyMuPDF/fontTools/lxml, Tectonic을 확인했고 SDK wheel/sdist도 실제 빌드했다.
- 실제 OpenAI `gpt-5.4-mini`를 사용해 화학 사전·화학 결과·물리 결과의 DOCX/HWPX
  6개 canary를 생성했고 구조 검증을 통과했다. 이 점검 비용은 약 USD 0.143이었다.
- 실제 `.cap + CSV + 이미지` 물리 입력으로 DOCX/HWPX를 추가 생성하고, `.cap`의 8개
  페이지·1개 센서·6개 dataset·3개 graph definition과 내장 이미지 6개가 파서와 vision
  경로를 통과하는 것을 확인했다. 같은 실험의 graph PNG canary도 별도로 생성했으며
  추가 공급자 비용은 약 USD 0.071이었다.
- 추가 생성한 DOCX는 호환 Fontconfig를 적용한 LibreOffice PDF 렌더에서 3쪽 전체의
  한글·표·그래프·페이지 나눔을 확인했다. HWPX는 ZIP/BinData 무결성과 raw 수식 marker·
  Markdown table pipe 부재를 검사한 뒤 macOS 한컴에서 직접 열어 3쪽 전체의 제목 박스,
  표, 그래프, 실제 수식 객체와 페이지 나눔을 확인했다.
- 운영 Render one-off job에서 환경변수 값을 출력하지 않고 대상 관리자 한 행만
  `is_admin=true`와 새 scrypt hash로 복구했다. 동일 환경변수 자격증명의 실제 운영
  `/api/login` 요청이 이후 200과 `admin=true` 로그를 남기는 것을 확인했다.
- Codex Security diff scan은 변경 파일 worklist `99/99`에 완료 receipt를 남겼고,
  최종 medium/P2 2건(공유 업로드 lease 미반납, MCP access sibling 폐기 누락)을
  수정했다. 나머지 후보 5건은 attack-path 기준으로 rejected/not-applicable 처리했지만
  안전한 hardening은 함께 반영했다.
- macOS 차트 테스트에서 `sharp`와 `canvas`가 로드하는 GLib 클래스 중복 경고가 한 번
  발생했으나 실패·크래시는 없었다. Linux/Render에서는 배포 후 차트 생성을 별도로 확인한다.

## 남은 수동·외부 검증

- 별도 Supabase와 실제 AI 공급자 키를 주입한 Render 스테이징에서 `.cap`,
  `.cap + Excel`, 이미지 포함 DOCX/HWPX 생성과 파일함 연동 확인
- 위 Render 스테이징 생성 파일의 원본 데이터 일치와 raw `{{EQ...}}`, Markdown pipe
  잔존 여부 확인. 동일 입력의 로컬 실제 공급자 canary는 이 검증을 통과했다.
- Render 환경의 큐 포화, 업로드 메모리 한도, 파일함 장애, 프로세스 재시작 시나리오
- 로컬에서 검증한 동일 HWPX를 Windows 한컴에서 교차 열기
- 공개 저장소에 포함하지 않는 학교 템플릿의 사용 권한과 배포 경로 확인

## 점검 도구 제약

- Codex Security diff scan 자체는 완료·봉인했다. 다만 공격 재현용 validation worker는
  플랫폼 보안 필터에 차단되어, 사용자의 지시에 따라 destructive live 재현을 생략하고
  정적 source/control/dataflow 증거와 안전한 회귀 테스트로 판정했다. 운영 서비스에는
  DoS 반복 요청이나 실제 탈취 토큰을 사용하지 않았다.
- 앱 내 브라우저 제어 연결은 `Transport closed`로 반복 종료됐다. 사용자의 명시적
  허가 후 standalone Playwright Chromium으로 fallback해 최신 화면 캡처·상호작용·전후
  비교를 완료했으므로 화면 점검 결과에는 이 대체 경로를 명시한다.

## 전체 프론트엔드·권한 재검사 및 연결 센터 개편

- 운영 공개 경로 64개를 데스크톱과 모바일에서 각각 열어 `128/128` 기본 화면 상태를
  확인했다. 문서 4xx/5xx, page error, 예상 밖 failed response, 깨진 가시 이미지,
  가로 overflow, 이름 없는 가시 control은 발견되지 않았다.
- 로컬 격리 환경에서 anonymous/member/Pro/admin/API developer의 92개 route-role 상태와
  Max, 단일 beta, developer, restricted-model, approval-pending, API Test/Live scope,
  Bearer 비관리자 권한 상승 방지 등 7개 특수 권한 시나리오를 통과했다.
- 클릭형 광역 crawler의 632개 timeout은 닫힌 overlay·클릭 후 DOM 교체·비동기 detach에서
  발생한 탐색 잡음으로 분류했다. 각 경로의 기능 단위 테스트와 상태 전이는 별도
  persistent QA로 검증했으며, 원시 ledger는 삭제하지 않았다.
- 개발자 페이지를 일반 사용자도 이해할 수 있는 `Quilo 연결 센터`로 개편했다.
  ChatGPT OAuth, Codex Test token, 직접 API의 세 작업 경로, Test/Live의 정확한 차이,
  역할/요금제와 scope의 경계, 첫 요청, token 수명, idempotency, request ID를 단계적으로
  안내한다.
- 범위 선택 preset, 동적 scope/endpoint 수, catalog category 접기, paused 항목 비활성,
  clipboard 실패 표시, 요청 로그 loading/disable 상태를 추가했다. 죽은
  `navBetaTranslate` reveal target도 제거했다.
- 개발자 페이지 집중 Playwright `6/6`, 최종 전체 Playwright `523/523`이 통과했다. 같은 상태와
  viewport의 선택 시안·실제 구현을 한 화면에서 비교한 기록은 `design-qa.md`에 추가했다.
- 상세 경로·권한 결과는 외부 점검 산출물
  `/Users/minjun/.codex/visualizations/2026/07/21/019f83bd-c9ff-7ab0-abbd-53238b8e0365/quilo-exhaustive-frontend/combined-summary.md`
  와 JSON ledger 세 개에 남겼다.

## Render 스테이징 판정

- Render CLI 인증 후 운영 서비스 `srv-d7m9t4gsfn5c73de7tu0`을 읽기 전용으로 확인했고,
  운영과 분리된 `quilo-launch-audit-0721` 스테이징 서비스를 만들었다. 스테이징은
  `codex/launch-audit-staging`의 commit `e02f61e625edc46a6f62622a6807aa7bf86addec`, Singapore,
  auto-deploy off, `/healthz`, 별도 64자 `SESSION_SECRET`으로 구성했다.
- 스테이징에는 운영 Supabase/AI 공급자 key를 복사하지 않았다. `QUILO_STAGING=1`은
  내장 일정 서비스를 메모리 저장소와 파생 비밀값으로 격리하며, 공개 편집 콘텐츠 저장소가
  비활성인 경우 익명 조회는 빈 목록으로 안전하게 fallback한다.
- 로컬의 동일 staging 환경은 공개 경로 64개를 1440px/390px에서 `128/128` 통과했고,
  `/schedule/`과 공개 editorial API도 200을 반환했다. Render 서비스도 build, health check,
  시작까지 성공했으며 재배포 직후 동일 경로 30회는 모두 200이었다.
- 서비스 생성 직후 첫 Chromium 전수 검사에서는 일부 edge가 `x-render-routing: no-server`
  404를 반환했다. 이 응답에는 `x-request-id`, `rndr-id`, 애플리케이션 보안 헤더가 없었고
  앱 로그에도 도달하지 않아 코드/Express 404가 아닌 신규 서비스 라우팅 전파 상태로
  분류했다.
- 전파 안정화 뒤 `/healthz` 20회 연속 200을 확인하고 같은 Chromium 전수 검사를 다시
  실행했다. 공개 경로 64개의 1440px/390px 상태가 `128/128` 통과했으며 문서 4xx/5xx,
  page error, 예상 밖 console/response 오류, 깨진 이미지, overflow, 이름 없는 가시 control은
  모두 0이었다. 현재 스테이징의 간헐적 404는 재현되지 않는다.
- Render [공식 Free 인스턴스 안내](https://render.com/docs/free)는 Free 인스턴스가 15분
  유휴 후 sleep하고 운영 용도가 아니라고 명시한다. 따라서 현재 무료 스테이징은 기능
  미리보기와 공개 경로 회귀용으로만 유지한다. 별도 Supabase와 실제 공급자 key로 생성
  canary를 마치기 전에는 운영에 배포하지 않는다. HWPX/DOCX의 macOS 한글 직접 열기는
  통과했으며, Windows 한컴 교차 열기는 출시 차단 조건으로 유지한다.
- origin/main 통합과 보안 보강을 포함한 commit `53cb168002a35db6b3f42975cef3862ac959dda4`를
  스테이징에 최종 배포했다. Render 빌드·health check가 성공했고 `.node-version`의
  Node `24.18.0`을 사용한 사실을 배포 로그에서 확인했다. `/healthz` 20회 연속 200 뒤
  공개 64개 경로를 1440px/390px에서 재검사해 `128/128`을 통과했다. 문서 4xx/5xx,
  page error, 예상 밖 failed response, 깨진 이미지, overflow, 이름 없는 가시 control은
  모두 0이었다.
