# Third-Party Notices

Quilo 본체는 별도 고지가 없는 한 `AGPL-3.0-or-later`로 배포됩니다. 아래
제3자 소프트웨어와 자산은 각자의 라이선스를 따릅니다. 전체 직접 의존성 검토는
`docs/open-source/license-audit.md`에 기록합니다.

## Python and npm dependencies

패키지 관리자로 설치되는 의존성의 저작권·라이선스 파일은 배포물에서 보존해야
합니다. 특히 다음 경계를 확인했습니다.

- **PyMuPDF / MuPDF** — GNU Affero General Public License v3 또는 Artifex
  Commercial License. Quilo 공개본은 AGPL 경로를 선택합니다.
- **JSZip** — MIT 또는 GPL-3.0-or-later 중 MIT 조건으로 사용합니다.
- **sharp와 플랫폼 바이너리** — sharp는 Apache-2.0이며 설치되는 libvips 관련
  바이너리·선택 패키지의 notice도 실제 배포 artifact에서 보존해야 합니다.
- **Quilo schedule 웹 앱** — React, Express, Helmet, Supabase SDK, Lucide 등
  별도 lockfile의 직접 의존성은 감사 시점 MIT, ISC 또는 BSD-2-Clause입니다.
- 나머지 직접 의존성은 감사 시점 MIT, Apache-2.0, BSD 계열이었습니다.

버전과 전이 의존성은 lockfile·플랫폼에 따라 바뀌므로 릴리스마다 재검사합니다.

브라우저에서 직접 사용하는 `public/tools/vendor/` 번들은 각 파일의 원래 라이선스
배너를 보존합니다.

- Chart.js 4.4.1 — MIT
- JSZip 3.10.1 — MIT 선택
- pdf-lib — MIT
- Mozilla PDF.js — Apache-2.0
- SheetJS Community Edition 0.18.5 — Apache-2.0

## Fonts

다음 폰트는 SIL Open Font License 1.1에 따라 포함됩니다.

- Nanum Gothic (`lib/fonts/NanumGothic-Regular.ttf`)
- Pretendard 계열
- STIX Two Math 계열

폰트 파일과 함께 제공되는 upstream license·copyright 파일을 보존하고,
Reserved Font Name 조건이 있는 폰트를 수정할 때는 OFL의 이름 변경 규칙을
따릅니다.

Nanum Gothic copyright:

- Copyright (c) 2010, NHN Corporation.
- Font designed by Sandoll Communications Inc.

## Separately licensed SDKs

`sdk/javascript/`와 `sdk/python/`은 각 디렉터리의 MIT License에 따라 별도
배포됩니다.

## Excluded non-open-source component

과거 Quilo는 Shin Mingyu의 LaTeX → HWP 변환 코드를
`Non-Commercial & Attribution` 조건과 서비스 사용 허락 아래 사용했습니다.
상업적 이용을 제한하는 조건은 OSI 오픈소스 정의와 맞지 않으며, 기존 허락이
공개 재배포·재라이선스 권리를 뜻하지도 않습니다.

따라서 다음 구현과 파생 규칙은 공개 저장소에서 제외합니다.

- `lib/equation/vendor/`
- `public/equation/src/`
- `public/equation/CONVERSION_RULES.md`

서버 문서 생성 경로는 vendor 파일이 없으면
`lib/equation/hwpx_equation_tool.py`의 builtin 변환기로 폴백합니다.
브라우저 변환기는 재라이선스 또는 clean-room 독립 구현 전까지 안내 페이지만
제공합니다.

## Document templates and samples

학교·기관 전용 HWPX/PDF 템플릿과 사용자 업로드·보고서는 공개 저장소에 포함하지
않습니다. 배포자는 자신이 재배포할 권리가 있는 템플릿을 별도로 제공해야 합니다.

`public/examples/samples/*.docx`는 외부 API나 사용자 저장소를 사용하지 않고
합성 fixture에서 생성합니다. 공개 생성 스크립트는 학번·이름·이메일과 문서 작성자
메타데이터를 제거해야 합니다.
