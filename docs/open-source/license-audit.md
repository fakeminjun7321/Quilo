# 오픈소스 라이선스 감사

- 감사 기준일: 2026-07-23
- 감사 범위: 공개 스냅샷의 직접 npm·Python 의존성, lockfile 라이선스 메타데이터,
  번들 폰트·SDK·문서 템플릿·vendor 코드
- 프로젝트 기본 라이선스: `AGPL-3.0-or-later`
- 성격: 공개 준비를 위한 기술적 인벤토리이며 법률 자문이 아님

## 결론

1. Quilo가 직접 호출하는 PyMuPDF는 GNU AGPL v3 또는 Artifex 상용 라이선스의
   이중 라이선스입니다. 공개 배포본은 AGPL 경로를 선택해 프로젝트 본체를
   `AGPL-3.0-or-later`로 맞췄습니다. 별도의 Artifex 상용 계약을 사용하는 배포자는
   자신의 계약 조건을 따로 검토해야 합니다.
2. 기존 브라우저·vendor 한글 수식 변환기는
   `Non-Commercial & Attribution` 조건이 있어 OSI 오픈소스가 아닙니다.
   `public/equation/src/`, `public/equation/CONVERSION_RULES.md`,
   `lib/equation/vendor/`를 공개본에서 제외했습니다.
3. 권리 확인이 필요한 학교 HWPX 템플릿 3개도 제외했습니다. 코드에는 템플릿이
   없을 때의 fallback이 남아 있습니다.
4. 직접 npm 의존성은 허용적 라이선스 또는 선택 가능한 허용적 분기를 사용합니다.
   JSZip은 `(MIT OR GPL-3.0-or-later)` 중 MIT 조건으로 사용합니다.
5. JavaScript·Python SDK는 각 디렉터리의 MIT 라이선스로 별도 배포합니다.

## 브라우저에 번들된 라이브러리

`public/tools/vendor/`의 minified 파일은 원래 라이선스 배너를 보존합니다.

| 파일 | 업스트림 | 라이선스 |
|---|---|---|
| `chart.umd.min.js` | Chart.js 4.4.1 | MIT |
| `jszip.min.js` | JSZip 3.10.1 | MIT 선택 |
| `pdf-lib.min.js` | pdf-lib | MIT |
| `pdf.min.js`, `pdf.worker.min.js` | Mozilla PDF.js | Apache-2.0 |
| `xlsx.mini.min.js` | SheetJS Community Edition 0.18.5 | Apache-2.0 |

## 직접 npm 의존성

실제 `package-lock.json`의 설치 버전을 기준으로 확인했습니다.

| 패키지 | 확인 버전 | 라이선스 |
|---|---:|---|
| `@anthropic-ai/sdk` | 0.30.1 | MIT |
| `@supabase/supabase-js` | 2.104.1 | MIT |
| `chart.js` | 4.5.1 | MIT |
| `chartjs-node-canvas` | 5.0.0 | MIT |
| `compression` | 1.8.1 | MIT |
| `cookie-session` | 2.1.1 | MIT |
| `docx` | 9.6.1 | MIT |
| `dotenv` | 16.6.1 | BSD-2-Clause |
| `express` | 4.22.2 | MIT |
| `express-session` | 1.19.0 | MIT |
| `fast-xml-parser` | 5.7.2 | MIT |
| `image-size` | 1.2.1 | MIT |
| `jszip` | 3.10.1 | MIT OR GPL-3.0-or-later; MIT 선택 |
| `multer` | 2.2.0 | MIT |
| `sharp` | 0.35.3 | Apache-2.0 |
| `xlsx` | 0.20.3 | Apache-2.0 |

`apps/classbot/package-lock.json`으로 고정되는 내장 일정 웹 앱의 직접 의존성도
별도로 확인했습니다.

| 패키지 | 확인 버전 | 라이선스 |
|---|---:|---|
| `@supabase/supabase-js` | 2.110.6 | MIT |
| `cookie-session` | 2.1.1 | MIT |
| `dotenv` | 17.4.2 | BSD-2-Clause |
| `express` | 5.2.1 | MIT |
| `helmet` | 8.3.0 | MIT |
| `lucide-react` | 0.468.0 | ISC |
| `multer` | 2.2.0 | MIT |
| `react` | 19.2.7 | MIT |
| `react-dom` | 19.2.7 | MIT |

lockfile 전체 메타데이터에는 MIT, Apache-2.0, LGPL-3.0-or-later, ISC,
BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, Zlib, WTFPL, GPL 선택지
등이 있습니다. LGPL 표시는 주로 `sharp`가 사용하는 바이너리 생태계의 선택적
패키지에서 옵니다. 실제 배포 artifact를 만들 때 포함되는 바이너리와 notice를
플랫폼별로 다시 확인해야 합니다.

## 직접 Python 의존성

PyPI 메타데이터와 각 업스트림 고지를 확인했습니다. 범위 버전은
`requirements.txt`, 확인 버전은 감사 시점 PyPI 최신 또는 고정 버전입니다.

| 패키지 | 확인 버전 | 라이선스 |
|---|---:|---|
| `python-hwpx` | 4.2.0 | Apache-2.0 |
| `lxml` | 6.1.1 | BSD-3-Clause |
| `pymupdf` | 1.28.0 | GNU AGPL v3 또는 Artifex Commercial |
| `pdf2docx` | 0.5.13 | MIT |
| `python-docx` | 1.2.0 | MIT |
| `fonttools` | 4.63.0 | MIT |
| `pypandoc-hwpx` | 0.1.1 | MIT |
| `reportlab` | 5.0.0 | BSD |

Python의 전체 전이 의존성은 환경과 플랫폼에 따라 달라집니다. 릴리스 컨테이너에서
고정된 lock 또는 SBOM을 만들기 전에는 이 표가 실제 배포 artifact 전체를
증명하지 않습니다.

## 폰트와 자산

- `NanumGothic-Regular.ttf`: SIL Open Font License 1.1
- Pretendard 계열: SIL Open Font License 1.1
- STIX Two Math 계열: SIL Open Font License 1.1
- `public/examples/samples/*.docx`: 외부 API와 사용자 자료 없이 합성 fixture로
  재생성하며 문서 작성자 메타데이터를 제거
- 학교·기관 HWPX/PDF 양식: 공개본에서 제외

## 재검사 규칙

- 의존성을 추가·갱신하면 이 문서와 `THIRD_PARTY_NOTICES.md`를 함께 갱신합니다.
- `npm run release:oss-check`는 모든 직접 의존성이 이 감사에 등장하는지,
  권리 제한 경로가 추적되지 않는지 검사합니다.
- Gitleaks는 별도로 비밀값을 검사합니다. 라이선스 게이트는 비밀값 검사를
  대체하지 않습니다.
- 실제 컨테이너·데스크톱 앱·설치 프로그램을 배포할 때는 그 artifact를 기준으로
  SBOM, 바이너리 notice, 동적·정적 링크 조건을 다시 확인합니다.
