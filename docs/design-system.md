# Quilo 프론트엔드 디자인 시스템

이 문서는 Quilo 웹 프론트엔드의 현재 구조와 변경 계약을 정의한다. 새 화면을 만들거나 기존 화면을 수정할 때는 이 문서와 `tests/QA/frontend-rewrite-contract.spec.js`를 기준으로 삼는다.

## 1. 기본 원칙

- `public/ui/foundation.css`가 전 페이지의 유일한 기반 토큰과 reset을 제공한다.
- 페이지는 용도에 맞는 surface stylesheet만 추가로 로드한다.
- 마케팅, 인증, 보고서 작업공간, 관리자, 독립 앱 화면은 서로 다른 shell을 사용하되 같은 foundation 토큰을 공유한다.
- UI 상태는 `hidden`, ARIA 속성, 의미가 분명한 상태 클래스(`is-active`, `is-loading`, `open`)로 표현한다.
- 정적 HTML에는 정확히 하나의 `<main>`과 명확한 페이지 제목(`<h1>` 또는 `main`의 ARIA 이름)이 있어야 한다.
- 사용자 데이터와 보고서 생성 파이프라인은 프론트 리팩터링 과정에서 변경하지 않는다.

## 2. 스타일 아키텍처

### 2.1 로드 순서

모든 화면은 foundation을 먼저 로드하고, 아래 표의 surface stylesheet를 이어서 로드한다.

| 화면군 | 필수 stylesheet | 런타임 |
|---|---|---|
| 공개·마케팅·가이드·도구·앱 소개 | `/ui/foundation.css` → `/ui/shell.css` → `/ui/pages.css` | `/ui/shell.js` |
| 로그인·회원가입·이메일 인증 | `/ui/foundation.css` → `/ui/auth.css` | 페이지 인증 스크립트 |
| 메인·보고서 작업공간 | `/ui/foundation.css` → `/ui/workspace.css` → `/ui/shell.css` → `/ui/forms.css` → `/ui/generation.css` | `/ui/shell.js` → `/workspace/bootstrap.js` |
| 관리자 콘솔 | `/ui/foundation.css` → `/ui/admin.css` | 관리자 페이지 스크립트 |
| 독립 작업 앱 | `/ui/foundation.css` → `/ui/app-shell.css` | 페이지별 스크립트 |
| Quilo Bot | 위 화면의 stylesheet + loader가 추가하는 `/ui/chat.css` | `/chat-widget.js` → `/chat/index.js` |

한 페이지에서 서로 다른 shell stylesheet를 섞지 않는다. 예를 들어 공개 페이지에 `workspace.css`를 추가하거나 독립 앱에 `shell.css`를 추가하지 않는다.

### 2.2 파일 역할

| 파일 | 책임 |
|---|---|
| `public/ui/foundation.css` | 의미론 색상, 폰트, box sizing, 기본 요소, 라이트·다크 토큰 |
| `public/ui/shell.css` | 공개 사이트 헤더, 단일 메가 패널, 컴팩트 메뉴, 푸터, skip link |
| `public/ui/pages.css` | 공개 페이지의 버튼, 입력, 카드, 법적 문서, 도구, 앱 소개 레이아웃 |
| `public/ui/auth.css` | 인증 전용 header, 카드, 폼, 상태 안내 |
| `public/ui/workspace.css` | 메인 상단바, 랜딩 hero, 보고서 선택·작업공간 shell |
| `public/ui/forms.css` | 보고서 단계, 섹션, 업로드, 옵션, 정책 동의, 제출 영역 |
| `public/ui/generation.css` | 생성 진행 단계, 로그, 중단·완료·다운로드 상태 |
| `public/ui/admin.css` | 관리자 command bar, sidebar, 운영 테이블·카드·상태 |
| `public/ui/app-shell.css` | 편집기·스튜디오·번역·학습 등 CompactAppShell 화면 |
| `public/ui/chat.css` | 인라인·floating 채팅, composer, 음성 상태, 피드백 액션 |

## 3. 토큰

### 3.1 Foundation 토큰

새 규칙은 가능한 한 아래 `--ui-*` 토큰만 사용한다.

| 토큰 | 의미 |
|---|---|
| `--ui-bg` | 페이지 canvas |
| `--ui-surface` | 기본 카드·패널·입력 표면 |
| `--ui-surface-subtle` | 보조·hover·함몰 표면 |
| `--ui-text` | 기본 텍스트 |
| `--ui-muted` | 보조 설명·라벨 |
| `--ui-faint` | 3차 메타데이터 |
| `--ui-line` | 기본 구분선 |
| `--ui-line-strong` | 입력·강조 구분선 |
| `--ui-brand` | 기본 액센트 |
| `--ui-brand-hover` | 액센트 hover |
| `--ui-danger`, `--ui-danger-soft` | 오류·파괴 상태 |
| `--ui-success`, `--ui-success-soft` | 성공·완료 상태 |
| `--ui-navy`, `--ui-navy-soft` | 고신뢰 어두운 브랜드 surface |
| `--ui-ring` | 키보드·입력 focus ring |
| `--ui-font` | 공통 sans-serif 스택 |

`html[data-theme="dark"]`이 동일한 의미론 토큰을 재정의한다. 컴포넌트에서 테마별 색을 직접 분기하지 말고 토큰을 사용한다.

### 3.2 호환 별칭

`pages.css`, `admin.css`, `app-shell.css`, `workspace.css`에는 기존 동적 렌더러를 위한 `--surface`, `--text`, `--accent`, `--q-*` 등의 별칭이 있다. 별칭은 해당 surface 내부 호환용이며 새로운 전역 토큰을 만드는 근거가 아니다.

## 4. Shell과 페이지군

### 4.1 공개 사이트 shell

- 루트: `[data-ui-shell]`
- 데스크톱: `.ui-site-nav`, `.ui-site-actions`
- 데스크톱 메가 패널: `#uiSiteMega`, `[data-ui-menu-trigger]`
- 컴팩트 메뉴: `[data-ui-mobile-trigger]`, `#uiMobilePanel`
- 모든 공개 페이지는 동일한 header/footer 목적지와 skip link를 유지한다.
- 메가 패널은 하나만 존재하며 메뉴 그룹을 바꾸면 같은 패널의 내용이 전환된다.
- 메가 패널은 바깥 클릭과 `Escape`로 닫히며 focus를 마지막 메뉴 버튼으로 돌려준다.
- 기능은 숨기지 않고 Public, Free, Pro, Max, 준비 중 상태를 함께 표시한다.
- 비로그인 상태에서만 `로그인`과 `무료로 시작하기`를 표시하고, 로그인 후에는 계정 동작만 표시한다.

대상: 가이드, 예시, 업데이트, 커뮤니티, 개발자, 학교 도입, 약관·개인정보·환불, 브라우저 도구, 앱 소개 페이지.

### 4.2 인증 shell

`login.html`, `signup.html`, `verify-email.html`은 `.auth-page`와 `.auth-header`를 사용한다. 인증 화면에는 공개 사이트의 복잡한 메뉴를 삽입하지 않는다.

### 4.3 보고서 작업공간

메인 화면은 랜딩과 실제 보고서 작업공간을 한 문서에서 전환한다.

- `workspace.css`: 상단바, 랜딩, 보고서 선택, workspace column
- `forms.css`: 업로드 → 정보 → 설정 → 확인 단계
- `generation.css`: 생성 요청 이후 진행 로그와 결과 파일

폼의 기존 `id`, `name`, `FormData` 필드, `/api/generate` 계약은 시각 리팩터링 중 변경하지 않는다.

### 4.4 관리자 shell

관리자는 `body.operations-shell`과 `/ui/admin.css`만 사용한다. 최소 데스크톱 폭을 유지하며 사용자·크레딧·구독·베타·학교·로그·공지·해명·편집 기능을 같은 운영 shell 안에 둔다.

### 4.5 CompactAppShell

독립 작업 화면은 `body[data-app-shell].app-shell`과 `.app-commandbar`를 사용한다.

대상: `create`, `editor`, `exam-prep`, `filechat`, `physics-studio`, `studio`, `study`, `translate-app`, `translate`, `vibe-coding`.

페이지 전용 규칙은 `app-shell.css`의 `@scope (body.app-shell--*)` 안에 둔다. 새 페이지별 `<style>` 블록을 만들지 않는다.

## 5. 공통 컴포넌트 계약

### 버튼과 링크

- 보통 버튼과 버튼형 링크는 최소 높이 44px을 유지한다.
- 주요 행동은 brand 채움, 보조 행동은 surface + strong line을 사용한다.
- 파괴 행동은 danger 토큰을 사용하며 일반 primary와 혼동하지 않는다.
- icon-only 버튼은 `aria-label`과 focus-visible 상태가 필수다.

### 입력과 폼

- `label`과 입력의 `for`/`id`를 연결한다.
- 오류 메시지는 입력과 가까운 `aria-live` 또는 설명 요소에 표시한다.
- 드롭존은 click뿐 아니라 키보드와 drag state를 지원한다.
- 표시 상태 변경은 `hidden` 또는 상태 클래스로 처리한다. `element.style.display`는 사용하지 않는다.

### 카드와 상태

- 기본 카드: `--ui-surface`, `--ui-line`, 작은 그림자 또는 그림자 없음.
- 정보 위계는 큰 그림자보다 여백·타이포·구분선으로 만든다.
- loading, success, error, disabled 상태는 텍스트와 ARIA 상태를 함께 제공한다.

## 6. Quilo Bot 모듈

`public/chat-widget.js`는 20줄 이하의 호환 loader다. `/ui/chat.css`를 중복 없이 연결하고 `/chat/index.js`를 한 번만 동적 import한다.

| 모듈 | 책임 |
|---|---|
| `/chat/api.js` | status/model 조회, 스트리밍 chat, feedback 요청 |
| `/chat/voice.js` | `SpeechRecognition`, `ko-KR`, 권한·종료 상태, composer 입력 |
| `/chat/view.js` | DOM 생성, ChatGPT형 메시지·composer·chip 렌더링 |
| `/chat/index.js` | help/memo/style 모드, 저장소, inline↔floating, 전체 오케스트레이션 |

보존해야 할 공개 계약:

- `window.Quilo.openMemo(targetId, kind)`
- `window.Quilo.openStyle(targetId)`
- `#qc-panel`, `#qc-msgs`, `#qc-in`, `#qc-mic`, `#qc-send` 등 기존 DOM ID
- `sessionStorage.quiloChat`, `localStorage.quiloWaModel`
- 한글 IME composition 및 `keyCode === 229` Enter 보호
- 음성 입력은 composer만 채우고 자동 전송하지 않음

## 7. 앱 다운로드

앱 소개 페이지는 외부 다운로드 페이지로 보내지 않고 Quilo의 first-party endpoint를 사용한다.

```text
GET /api/apps/quilo/download?platform=mac
GET /api/apps/quilo/download?platform=windows
GET /api/apps/live-translator/download?platform=mac
GET /api/apps/live-translator/download?platform=windows
```

버튼에는 `data-app-download`, `data-app`, `data-platform`을 둔다. 지원하지 않는 앱은 404, 지원하지 않는 platform은 400이다.

## 8. 금지 규칙

- 삭제된 레거시 stylesheet 또는 shell loader를 다시 연결하지 않는다.
- HTML 안에 `<style>` 또는 `style="..."`를 추가하지 않는다.
- JavaScript에서 거대한 CSS 문자열을 만들거나 `<style>`을 주입하지 않는다.
- 일반 UI 표시 전환에 `.style.display`를 사용하지 않는다. `hidden`이나 상태 클래스를 사용한다.
- 색·테두리·그림자를 raw hex로 페이지마다 재정의하지 않는다.
- 같은 문서에 중복 `id`, 두 개 이상의 `<main>`, 이름 없는 주요 화면을 만들지 않는다.
- 마케팅 shell과 app/admin/workspace shell을 한 페이지에 혼합하지 않는다.
- 앱 다운로드를 임의의 외부 릴리스 URL에 직접 연결하지 않는다.

런타임 inline style은 progress 폭, drag 위치, 편집기 geometry처럼 계산된 값 또는 검증된 서드파티 편집기 출력에만 제한한다.

## 9. 접근성·반응형

- 모든 화면은 1440×933에서 수평 overflow가 없어야 한다.
- 공개 shell은 933px에서도 데스크톱 내비게이션 계약을 유지하고, 760px 이하에서 모바일 메뉴로 전환한다.
- 인증·공개 화면은 390px에서도 content overflow가 없어야 한다.
- CompactAppShell의 지원 viewport는 전용 matrix 테스트를 기준으로 한다.
- `prefers-reduced-motion`에서 장식 animation과 transition을 최소화한다.
- 색만으로 상태를 전달하지 않고 텍스트·아이콘·ARIA를 함께 사용한다.

## 10. QA gate

필수 검사:

```bash
npx --yes -p @playwright/test playwright test tests/QA/chat-widget.spec.js
npx --yes -p @playwright/test playwright test tests/QA/site-shell.spec.js
npx --yes -p @playwright/test playwright test tests/QA/frontend-shell-matrix.spec.js
npx --yes -p @playwright/test playwright test tests/QA/frontend-rewrite-contract.spec.js
npx --yes -p @playwright/test playwright test tests/QA/auth-redesign.spec.js
npx --yes -p @playwright/test playwright test tests/QA/admin-redesign.spec.js
git diff --check
```

`frontend-rewrite-contract`는 사용자 HTML 라우트의 다음 조건을 검사한다.

- HTTP 200
- 정확히 하나의 `<main>`과 페이지 이름
- 중복 ID 없음
- 레거시 CSS·shell 로드 없음
- authored inline style 없음
- 로컬 asset 누락 없음
- desktop horizontal overflow 없음
- 앱 다운로드 endpoint 계약

## 11. 변경 체크리스트

1. 페이지군에 맞는 stylesheet만 로드했는가?
2. foundation 토큰을 사용했는가?
3. 기존 input/button ID와 서버 요청 필드를 보존했는가?
4. `hidden`, ARIA, 상태 클래스가 실제 UI 상태와 일치하는가?
5. keyboard focus와 icon-only label이 있는가?
6. 1440, 933, 390 viewport에서 주요 흐름을 확인했는가?
7. 해당 QA와 전체 frontend contract를 실행했는가?
