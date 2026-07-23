# Quilo Codex 플러그인·외부 API

Quilo는 보고서 생성기만 노출하지 않는다. 플러그인의 기능 검색 원본은 `lib/quilo-catalog.js`이며, 보고서·번역·학습·창작·코딩·브라우저 도구·커뮤니티·Lab·내 작업·파일·연동을 함께 설명한다.

## 구성

- `GET /api/catalog` — 공개 전체 기능 검색
- `GET /api/catalog/:id` — 기능 상세
- `GET /api/openapi.json` — OpenAPI 3.1 명세
- `/developers.html` — 전체 기능 디렉터리와 사용자 토큰 관리
- `/api/integrations/tokens` — 브라우저 로그인 세션에서 토큰 생성·목록·폐기
- `/api/v1/*` — 범위 제한 Bearer API
- `~/plugins/quilo` — 개인 Codex 플러그인과 로컬 MCP 서버

## 배포 전 필수 작업

Supabase SQL Editor에서 다음 마이그레이션을 적용한다.

```text
db/migrations/20260710_add_user_access_tokens.sql
```

개발자 콘솔의 요청 감사 로그와 향후 idempotency 저장소에는 다음 마이그레이션도 사용한다.

```text
db/migrations/20260711_add_api_platform.sql
```

마이그레이션 전에는 카탈로그와 개발자 페이지는 동작하지만 토큰 발급은 `TOKEN_TABLE_MISSING` 또는 저장소 미사용 오류를 반환한다.

## 토큰 보안

- 토큰 원문은 생성 응답에서 한 번만 반환한다.
- 서버 DB에는 SHA-256 해시만 저장한다.
- 사용자당 활성 토큰은 최대 10개다.
- 만료는 1~365일이다.
- 토큰으로 다른 토큰을 만들거나 폐기할 수 없다.
- 관리자 계정이 발급한 토큰도 외부 API에서는 관리자 권한으로 승격되지 않는다.
- v1 화이트리스트 밖의 경로는 토큰으로 호출할 수 없다.

## API v1

| Method | Path | Scope | 기존 서버 흐름 |
|---|---|---|---|
| GET | `/api/v1/account` | `account:read` | 안전한 계정·등급·크레딧 요약 |
| GET | `/api/v1/api-requests` | `account:read` | 본인의 최근 API 요청 상태·지연·오류 코드 |
| GET | `/api/v1/jobs` | `jobs:read` | `/api/me/jobs` |
| GET | `/api/v1/jobs/:id` | `jobs:read` | 메모리 작업 우선, 이후 `report_jobs` 영속 상태 조회 |
| POST | `/api/v1/jobs/:id/abort` | `jobs:write` | `/api/jobs/:id/abort` |
| GET | `/api/v1/jobs/:id/events` | `jobs:read` | 기존 SSE 작업 스트림 |
| GET | `/api/v1/jobs/:id/download` | `files:read` | 기존 완료 작업 다운로드 |
| GET | `/api/v1/files` | `files:read` | `/api/me/files` |
| GET | `/api/v1/files/:id/download` | `files:read` | 기존 24시간 파일함 다운로드 |
| POST | `/api/v1/reports` | `reports:write` | 기존 `/api/generate` 전체 검증·과금·작업 흐름 |
| POST | `/api/v1/pdf-translations/estimate` | `translations:read` | 기존 PDF 분석·비용·시간 추정 흐름 |
| POST | `/api/v1/pdf-translations` | `translations:write` | 기존 Max 권한·월간 한도·작업·엄격검증 흐름 |
| POST | `/api/v1/conversions/docx-to-hwpx` | `conversions:write` | 기존 DOCX→HWPX 변환기 |
| GET/POST | `/api/v1/studios/vibe/*` | `studios:read/write` | 기존 Vibe Coding 권한·과금 흐름 |
| GET/POST | `/api/v1/studios/physics/*` | `studios:read/write` | 기존 물리 스튜디오 권한·과금 흐름 |
| GET/POST | `/api/v1/file-chat/*` | `chat:write` | 기존 파일 챗봇 접근·사용량·스트리밍 흐름 |
| GET | `/api/v1/knowledge/lab/*` | `knowledge:read` | 공개 Quilo Lab 화이트리스트 문서 |
| GET/POST/DELETE | `/api/v1/community/*` | `community:read/write` | 기존 커뮤니티 본인 소유권·비속어·제재 흐름 |

보고서 제출은 `multipart/form-data`이며 기존 웹 폼과 같은 field 이름을 사용한다. 외부 API라고 해서 크레딧, 관리자 승인, 이메일 인증, Pro/Max 접근, rate limit, 생성 금지, 데이터 검증을 우회하지 않는다.

## 전체 기능과 액션의 구분

모든 기능은 카탈로그에서 검색되고 올바른 웹 화면으로 연결된다. 현재 API v1에서 직접 실행되는 액션은 계정·작업·파일·보고서 생성이다.

PDF 통번역, 파일 챗봇, 창작 스튜디오, 바이브 코딩, 물리 스튜디오처럼 장시간 상호작용·복합 UI가 필요한 기능은 카탈로그와 웹 handoff를 우선 제공한다. 이후 API로 열 때는 기능별 scope와 입력 스키마를 별도로 추가하고, 기존 권한·비용 게이트를 그대로 재사용한다.

## 로컬 플러그인 연결

```bash
node ~/plugins/quilo/scripts/configure.mjs 'quilo_...'
export QUILO_UPLOAD_ROOTS="$HOME/Downloads:$HOME/Documents/Quilo"
codex plugin add quilo@personal
```

`QUILO_UPLOAD_ROOTS`를 설정하지 않으면 플러그인의 로컬 업로드·다운로드 도구는 비활성화된다. 지정한 루트 밖의 파일은 읽거나 쓰지 않는다.
