# CLAUDE.md

@AGENTS.md
@docs/engineering/agent-harness.md
@docs/engineering/agent-memory.md

## Claude Code adapter

- `AGENTS.md`가 Quilo의 공통 규칙 단일 원본이다. 이 파일에 같은 규칙을 복사하지 않는다.
- 세션 시작 시 위 import가 실제로 로드됐는지 `/memory`로 확인한다.
- Claude auto-memory에는 개인적인 도구 힌트만 남긴다. 제품 규칙, 테스트 게이트, 운영 경계, 완료 조건은 저장소 문서와 `.harness/config.json`에만 둔다.
- 장기 작업은 `npm run harness:init`, 재개 작업은 `npm run harness:resume`으로 상태를 확인한 뒤 진행한다.
- 자동 메모리나 대화 요약보다 Git diff, `.harness/runs/<run-id>/state.json`, 실제 테스트 결과를 우선한다.
