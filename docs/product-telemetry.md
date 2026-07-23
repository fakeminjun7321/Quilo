# 제품 텔레메트리·개인정보 운영 기준

시행 기준일: 2026-07-15

이 문서는 Quilo의 서비스 품질 관측, 선택형 제품 분석, 품질평가, 관리자 감사 로그의 운영 기준이다. 배포 전 Supabase SQL Editor에서 `db/migrations/20260715_add_product_telemetry.sql`을 실행해야 한다. 마이그레이션 전에도 보고서 생성은 계속 동작하지만 새 기록과 선택 동의 저장은 비활성 또는 오류 안내로 처리된다.

## 데이터 경계

항상 수집하는 운영 데이터는 생성 요청의 접수·거절·실행·완료·실패 상태, 처리 단계별 시간, 보고서 종류, 모델, 제공자, 출력 형식, 업로드 개수·확장자·용량 구간, 산출물 검사 코드, 경고 개수, 결과 용량 구간, 다운로드·미리보기 횟수다. 장애 대응, 보안, 비용·용량 계획과 품질 검증에 사용한다.

선택형 제품 분석은 `users.analytics_consent=true`이고 `analytics_consent_version`이 현재 서버 버전과 일치할 때만 받는다. 서버는 이벤트 요청마다 DB의 최신 동의를 다시 확인한다. 동의를 철회하면 클라이언트 큐를 비우고 서버가 이후 이벤트를 거부한다.

다음 값은 운영·제품 분석에 절대 넣지 않는다.

- 업로드 파일명과 파일 본문
- 사용자 메모, 프롬프트, 자유서술 입력
- 보고서 제목, 생성 JSON, 생성 보고서 본문
- 학번, 이메일, 표시 이름의 중복 사본
- 전체 URL과 쿼리 문자열
- 쿠키, 비밀번호, API 키, OAuth 토큰
- 오류 원문과 스택 트레이스

## 테이블

- `generation_runs`: 접수·거절·단계별 시간·비내용 품질 신호. 90일.
- `product_events`: 별도 동의한 사용자의 코드형 이용 흐름. 90일.
- `report_quality_feedback`: 1~5점, 수정 정도, 허용된 문제 태그. 180일.
- `privacy_consent_logs`: 동의·철회 시점과 정책 버전. 계정 삭제까지.
- `admin_audit_logs`: 관리자 API 경로·메서드·상태·소요시간. 요청·응답 본문 없이 365일.
- `login_logs`: 로그인 보안 확인용 IP·User-Agent. 30일.
- `api_request_logs`: 외부 API 경로·상태·시간·오류 코드. 90일.

`cleanup_product_telemetry()`가 위 기간이 지난 행을 삭제한다. 서버는 시작 30초 후 한 번, 이후 24시간마다 이 함수를 호출한다.

## 선택형 이벤트 사전

허용 이벤트는 다음으로 고정한다.

- `workspace_viewed`
- `feature_selected`
- `form_started`
- `generation_submitted`
- `generation_accepted`
- `generation_rejected`
- `job_stream_opened`
- `generation_completed`
- `generation_failed`
- `preview_clicked`
- `download_clicked`
- `retry_clicked`
- `abort_clicked`
- `quality_feedback_submitted`

속성도 서버 허용목록을 사용한다. 보고서 종류·모델·형식·스타일, 백그라운드·Drive 저장 여부, 파일 개수·확장자·용량 구간, HTTP 상태·오류 코드, 파일 인덱스, 평점·수정 정도·문제 태그와 사전에 정의된 `source`만 허용한다. 임의 키와 자유문자열은 폐기한다.

## 품질평가

평가는 생성 작업 소유자만 제출할 수 있다. 자유서술을 받지 않고 다음 구조만 저장한다.

- 점수: 1~5
- 사용 결과: `as_is`, `minor_edits`, `major_edits`, `not_used`
- 문제 태그: `data_error`, `missing_content`, `format_broken`, `equation_error`, `chart_error`, `too_verbose`, `too_short`, `style_mismatch`, `other`

## 관리자 접근

`GET /api/admin/analytics-summary`는 사용자별 원시 이벤트가 아니라 기간 집계만 반환한다. 관리자 API 접근은 `admin_audit_logs`에 남기며 URL 쿼리, 본문, 응답 데이터는 기록하지 않는다. 새 분석 원시 데이터를 관리자 AI 도우미에 직접 제공하지 않는다.

## 배포 점검

1. Supabase에 `20260715_add_product_telemetry.sql`을 적용한다.
2. Render에서 `PRODUCT_TELEMETRY_ENABLED=1`, `PRODUCT_ANALYTICS_CONSENT_VERSION=2026-07-15`를 확인한다.
3. 미동의 계정의 `/api/telemetry/events`가 403인지 확인한다.
4. 동의 후 이벤트가 저장되고, 철회 후 새 이벤트가 거부되는지 확인한다.
5. 생성 성공·실패·거절, 미리보기·다운로드, 품질평가가 집계되는지 확인한다.
6. DB 행에 파일명·메모·보고서 제목·본문·오류 원문이 없는지 표본 검사한다.
7. `select cleanup_product_telemetry();`를 실행해 정리 함수 권한과 결과를 확인한다.
