# Quilo API·ChatGPT·Codex 운영 설정

Quilo의 공개 기능 카탈로그, REST API v1, 로컬 Codex 플러그인, ChatGPT 원격 MCP는 같은 기능·권한·작업 소유권 규칙을 사용한다.

## 배포 전 SQL

Supabase SQL Editor에서 순서대로 실행한다. 각 파일은 재실행 가능한 형태다.

1. `db/migrations/20260710_add_user_access_tokens.sql`
2. `db/migrations/20260711_add_api_platform.sql`
3. `db/migrations/20260711_add_api_webhooks.sql`
4. `db/migrations/20260711_add_mcp_oauth.sql`

## Render 환경변수

기존 서버 환경변수에 아래 값을 추가한다.

- `CLOUD_TOKEN_SECRET`: Dropbox·Google·Notion 장기 토큰을 AES-256-GCM으로 암호화하는 충분히 긴 랜덤 비밀값
- `PUBLIC_BASE_URL=https://quilolab.com`: OAuth issuer·resource·callback의 정규 공개 주소
- `WEBHOOK_SECRET_KEY`: Webhook endpoint secret 암호화 키. 없으면 서버 세션 비밀값을 사용하지만 운영에서는 별도 값을 권장한다.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Google OAuth 웹 애플리케이션
- `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`: Notion public integration OAuth

OAuth redirect URI:

- `https://quilolab.com/api/cloud/google/callback`
- `https://quilolab.com/api/cloud/notion/callback`

Dropbox는 기존 `DROPBOX_APP_KEY`와 `CLOUD_TOKEN_SECRET`을 사용한다.

## 엔드포인트

- 기능 카탈로그: `GET /api/catalog`
- OpenAPI: `GET /api/openapi.json`
- REST API: `/api/v1/*`
- ChatGPT 원격 MCP: `POST /mcp`
- MCP protected resource metadata: `GET /.well-known/oauth-protected-resource/mcp`
- OAuth authorization server metadata: `GET /.well-known/oauth-authorization-server`

## ChatGPT 연결

ChatGPT Developer Mode에서 `https://quilolab.com/mcp`를 개발자 앱 URL로 등록한다. Quilo는 DCR, Authorization Code + PKCE, 명시적 사용자 동의, scope 제한, MCP audience 제한 access token을 사용한다.

## 안전 경계

- REST와 MCP 모두 기존 사용자·Pro/Max·크레딧·rate limit·job ownership 검사를 재사용한다.
- Test 토큰의 쓰기 API는 실제 모델·크레딧을 사용하지 않는 sandbox 응답을 반환한다.
- 보고서와 PDF 작업 생성은 `Idempotency-Key`를 요구해 중복 실행과 중복 과금을 막는다.
- BYOK API는 provider와 마스킹된 hint만 반환하며 키 원문을 반환하지 않는다.
- Google/Notion/Dropbox 장기 토큰과 Webhook secret은 평문으로 저장하지 않는다.
