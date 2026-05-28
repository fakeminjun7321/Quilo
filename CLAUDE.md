# CLAUDE.md

이 문서는 Render에서 실제 운영 중인 보고서 생성 기능을 수정하거나 점검할 때 따라야 하는 기준서이다. 공개 저장소는 웹/Render 서버 파이프라인만 다룬다.

각 보고서 파이프라인의 전체 세부 구현, 배포 전 점검, HWPX/DOCX 렌더링 흐름은 아래 문서를 먼저 읽는다.

- 화학 사전보고서: `docs/chem-pre-pipeline.md`
- 화학 결과보고서: `docs/chem-result-pipeline.md`
- 물리 결과보고서: `docs/phys-result-pipeline.md`

## 범위

- 대상 기능: 웹사이트의 `화학 사전보고서`, `화학 결과보고서`, `물리 결과보고서` 생성
- 요청 타입: `type=chem-pre`, `type=chem-result`, `type=phys-result`
- 엔드포인트: `POST /api/generate`
- 서버 엔트리: `server.js`
- 핵심 파이프라인: `lib/pipelines/chem-pre/`, `lib/pipelines/chem-result/`, `lib/pipelines/phys-result/`
- 출력 형식: `.docx`, `.hwpx`
- 현재 허용 모델: `claude-opus-4-7`

## 핵심 파일

- `server.js`
  - `PIPELINES["chem-pre"]`, `PIPELINES["chem-result"]`, `PIPELINES["phys-result"]`에서 입력 검증, 업로드 필드 정규화, 파일명 규칙, docx/hwpx generator 연결을 정의한다.
  - `/api/generate`에서 로그인, 약관 동의, 학번, 크레딧, rate limit, job 생성, SSE 진행 로그, 파일 저장을 처리한다.
- `public/index.html`
  - 세 보고서 폼 UI, 클라이언트 입력 검증, `FormData` 구성, 비용 추정, 진행 로그 스트리밍을 처리한다.
- `lib/pipelines/chem-pre/generate.js`
  - 화학 사전보고서 Claude 입력 구성, web search, JSON 파싱, 시약·절차 후처리를 수행한다.
- `lib/pipelines/chem-pre/prompt.md`
  - 화학 사전보고서의 system prompt 원문이다.
  - 학교 작성요령 풀버전과 minimal 모드, 시약 물성, 그림 placeholder, 금지 패턴을 정의한다.
- `lib/pipelines/chem-result/generate.js`
  - 화학 결과보고서 Claude 입력 구성, 데이터/사진 처리, JSON 파싱, 차트 PNG 렌더링을 수행한다.
- `lib/pipelines/chem-result/prompt.md`
  - 화학 결과보고서의 system prompt 원문이다.
  - 사전보고서 뒤에 붙일 5번 이후 추가 작성분, 데이터 처리, 차트 spec, PCEI 규칙을 정의한다.
- `lib/pipelines/chem-result/chart-gen.js`
  - 화학 결과보고서와 물리 결과보고서에서 쓰는 Chart.js PNG 렌더러이다.
- `lib/pipelines/phys-result/generate.js`
  - Render 물리 결과보고서의 중심 로직이다.
  - `.cap`, 엑셀/CSV/텍스트, 매뉴얼 PDF, 이미지, 사용자 메모를 Claude 메시지로 구성한다.
  - Claude JSON 응답 파싱, sanitize, 사용자 메모 과대 반영 방지, 구조화 데이터 보정, 차트 PNG 렌더링을 수행한다.
- `lib/pipelines/phys-result/prompt.md`
  - 물리 결과보고서의 system prompt 원문이다.
  - 보고서 구조, 평가기준, JSON 스키마, 분량, 스타일, 실험 파트 수 규칙을 정의한다.
- `lib/pipelines/phys-result/cap-parser.js`
  - PASCO Capstone `.cap` 파일을 ZIP으로 열고 `main.xml`, `data/Z_*.tmp`, 내장 이미지/텍스트/센서/데이터셋을 파싱한다.
- `lib/pipelines/phys-result/docx-gen.js`
  - Claude가 만든 JSON을 Word `.docx`로 렌더링한다.
- `lib/pipelines/phys-result/hwpx-gen.js`
  - Node에서 Python `hwpx-gen.py`를 spawn하고 JSON payload를 전달한다.
- `lib/pipelines/phys-result/hwpx-gen.py`
  - 물리 결과보고서 HWPX 생성기이다.
  - 학교 물리 결과보고서 양식 HWPX를 기반으로 제목, 실험 결과, 결론, 표, 차트, 사진, 수식을 삽입한다.
- `lib/pipelines/phys-result/templates/result-report-template.hwpx`
  - 물리 결과보고서 HWPX 출력의 기준 템플릿이다.
  - 공개 저장소에는 포함하지 않는다. 배포자가 권한을 가진 템플릿을 별도로 넣으면 템플릿 기반 출력이 활성화된다.
- `lib/pipelines/phys-result/form.pdf`
  - Claude 입력에 자동 첨부되는 결과보고서 양식 PDF이다.
  - 공개 저장소에는 포함하지 않는다. 없으면 첨부 없이 graceful fallback 한다.
- `lib/equation/hwpx_equation_tool.py`
  - `{{EQ:...}}`, `{{EQ-LATEX:...}}` 같은 수식 placeholder를 실제 HWPX 한글 수식 객체로 바꾼다.
- `lib/excel-parser.js`
  - 엑셀/CSV를 Markdown table 및 구조화 table로 파싱한다.
- `lib/anthropic-media.js`
  - 이미지가 Claude 제한을 넘지 않도록 리사이즈/압축하고 vision block으로 변환한다.

## 업로드 필드

화학 사전보고서와 화학 결과보고서의 세부 업로드 필드는 각각 `docs/chem-pre-pipeline.md`, `docs/chem-result-pipeline.md`를 우선 확인한다. 아래는 물리 결과보고서의 입력 요약이다.

물리 결과보고서는 아래 입력 중 하나 이상이 반드시 있어야 한다.

- `cap`: PASCO Capstone `.cap` 파일, 선택
- `data`: `.xlsx`, `.xls`, `.csv`, `.txt`, `.md`, 여러 개 가능
- `manual`: 실험 매뉴얼 PDF, 선택
- `photos`: 실험 사진, 데이터 표 스크린샷, 그래프 스크린샷, 여러 장 가능

추가 폼 값:

- `date`: 보고서 날짜
- `studentId`: 학번, 물리 결과보고서는 필수
- `format`: `docx` 또는 `hwpx`
- `fontFace`: 출력 글꼴
- `userNotes`: AI 참고 메모 / 실험자 의견
- `model`: 현재 `claude-opus-4-7`만 허용

## 서버 실행 흐름

1. `public/index.html`이 `FormData`를 만들어 `/api/generate`로 보낸다.
2. `server.js`의 `/api/generate`가 로그인, 약관 동의, pipeline type, rate limit, 크레딧, 학번을 검증한다.
3. `PIPELINES["phys-result"].prepareInput()`이 파일을 검증하고 `generateReportContent()` 입력 객체로 정리한다.
4. `runGeneration()`이 job을 만들고 SSE 진행 로그를 보낸다.
5. `lib/pipelines/phys-result/generate.js`가 Claude 입력을 구성한다.
6. Claude가 JSON 코드 블록 하나를 반환한다.
7. 서버가 JSON을 lenient parse하고 sanitize한다.
8. 사용자 메모 과대 반영 표현을 정리한다.
9. 구조화 엑셀/CSV 데이터가 있으면 canonical data 기준으로 표와 일부 서술을 보정한다.
10. 각 실험 파트의 chart spec을 PNG로 렌더링한다.
11. `format=hwpx`이면 `phys-result/hwpx-gen.js -> hwpx-gen.py`를 거쳐 HWPX를 만든다.
12. `format=docx`이면 `phys-result/docx-gen.js`가 DOCX를 만든다.
13. 결과 파일은 다운로드 job에 저장되고, Supabase가 켜져 있으면 24시간 파일함에 저장된다.

## Claude 입력 구성 규칙

`generate.js`는 사용자 파일을 그대로 Claude에 던지지 않고, 서버에서 최대한 구조화한 뒤 전달한다.

- `.cap`
  - `parseCap()`으로 파싱한다.
  - `summarizeForPrompt()` 결과를 텍스트 block으로 넣는다.
  - 캡스톤 사용자 입력 표가 있으면 최우선 데이터로 쓰라고 명시한다.
  - `Ipivot`, `Icm`, `%Diff`처럼 Capstone 계산 column이 저장되지 않는 경우 직접 계산하라고 지시한다.
  - Workbook/Page 안의 Questions/Answer 문항은 결과·분석·결론에 자연스럽게 반영하라고 지시한다.
- 엑셀/CSV
  - `parseToMarkdown()` 결과를 Claude 입력에 넣는다.
  - `parseToTables()` 결과를 canonical data 보정용으로 따로 보관한다.
  - `.cap`과 정리 파일이 충돌하면 정리 파일을 우선하되, 이유 없는 데이터 제외/평균 선택은 지어내면 안 된다.
- 텍스트 파일
  - UTF-8 우선, 필요 시 EUC-KR 디코딩을 시도한다.
  - 측정값, 계산 기록, 그래프 해석, 실험 메모인지 Claude가 판단하게 한다.
  - 텍스트에 없는 값은 만들면 안 된다.
- 이미지
  - `prepareImageForAnthropic()`으로 Claude 이미지 제한에 맞게 압축/리사이즈한다.
  - 표/그래프 스크린샷이면 숫자, 축, 단위, 추세를 읽되 보이지 않는 값은 추정하지 말라고 지시한다.
- 사용자 메모
  - `buildUserNotesBlock()`이 별도 block으로 구성한다.
  - 메모는 보조 맥락이며 데이터보다 앞서면 안 된다.
  - 같은 사실은 최대 2회 정도만 반영한다.
  - 메모에 없는 장비 조정, 제외 기준, 개선 효과, 수치 변화는 만들면 안 된다.

## 데이터 보정의 의미

진행 로그에 아래 문구가 나올 수 있다.

- `🧮 데이터 충돌 기반 서술 N곳 보정`
- `🧮 엑셀 원본 기준 데이터 표 N개 보정`

이것은 데이터를 조작하는 기능이 아니다. Claude가 JSON에서 엑셀/CSV 원본과 다른 수치를 쓰거나 서로 충돌하는 서술을 만든 경우, 서버가 업로드 원본에서 파싱한 canonical table을 기준으로 출력 표/서술을 되돌리는 방어 로직이다.

주의:

- 보정 로직은 원본 파일에 없는 새 데이터를 만들면 안 된다.
- 충돌이 확인된 값만 고쳐야 한다.
- 일반 실험 전체에 무리하게 적용하지 말고, `classifyPhysicsTable()`과 `buildCanonicalPhysicsData()`가 인식하는 범위 안에서만 작동해야 한다.

## HWPX 생성 규칙

물리 HWPX는 단순 새 문서가 아니라 `templates/result-report-template.hwpx`를 기준으로 만든다.

중요 규칙:

- 첫 페이지의 `실험 주제` 박스는 템플릿 구조를 유지한다.
- 제목 박스를 header에서 body로 무리하게 이동하지 않는다. macOS/Windows 한컴에서 열리지 않는 문제가 생긴 적이 있다.
- 템플릿 안의 결과/결론 cell을 찾으면 그 안을 비우고 내용을 채운다.
- 결과/결론 cell을 못 찾으면 body placeholder만 제거하고 일반 방식으로 생성한다.
- 차트 PNG, 업로드 사진, 표는 HWPX package 안에 실제 binary item으로 들어가야 한다.
- 생성 후 `ensure_embedded_bindata_items()`를 호출해 `content.hpf`에 이미지 item 누락이 없게 한다.
- `Preview/PrvText.txt`도 갱신한다.

수식 처리:

- 물리 문장 안의 `I_{pivot} = mgdT^{2}/(4π^{2})` 같은 인라인 식은 `normalize_physics_equation_markers()`가 `{{EQ-LATEX:...}}`로 감싼다.
- 이후 `chem-pre/hwpx-gen.py`의 공통 수식 후처리와 `lib/equation/hwpx_equation_tool.py`가 실제 HWPX 수식 객체로 변환한다.
- `{{MATH:...}}`, `{{FORMULA:...}}`, `[[수식]]` 같은 wiki식 마커는 금지한다.
- 수식 변환 실패를 무시하면 사용자에게 raw marker가 보이므로, HWPX 수식 postprocess 실패는 fatal로 보는 것이 맞다.

## 보고서 품질 기준

`phys-result/prompt.md`의 기준을 최우선으로 따른다.

- 보고서 구조는 `1. 실험 결과`, `2. 결론`이다.
- `experiments[]` 개수는 `.cap` 워크북 Part 구조와 맞아야 한다.
- Part I/Part II가 있으면 experiments도 그 수에 맞추고, 하위 분석은 `가.`, `나.` 안에서 분리한다.
- 모든 실험 파트에는 표, 그래프, 분석이 있어야 한다.
- 분석은 경향성, 정량값, 이론값 비교, 그래프 형태, 물리적 해석을 포함해야 한다.
- 결론에는 결과 요약, 오차 분석, 문제 인식 및 해결, 물리적 고찰이 보여야 한다.
- 사용자 본인의 기존 물리 결과보고서 스타일을 1순위로 참고하고, 선배 보고서는 보조 참고로만 본다.

## 수정 시 주의할 점

- iPad 로컬 앱 코드는 공개 저장소 범위에서 제외한다.
- `chem-pre` HWPX generator는 공통 helper로 재사용되므로, 물리 HWPX만 고치려면 먼저 `phys-result/hwpx-gen.py`에서 해결할 수 있는지 본다.
- `chem-pre/hwpx-gen.py`를 수정하면 화학 사전/화학 결과/물리 HWPX 모두 영향받을 수 있다.
- `.cap` 파서 수정 시 기존 `userdata` 표, `timeseries` 데이터, Workbook text 추출이 깨지지 않아야 한다.
- 이미지 크기 제한 문제는 `lib/anthropic-media.js`에서 해결하는 것이 맞다. Claude API 요청 직전에 5MB 제한을 넘기면 안 된다.
- 사용자 메모는 추가 프롬프트이다. 시스템 프롬프트를 대체하지 않는다.
- 일반 사용자에게 highlight/밑줄 기능을 열지 않는다. `allowHighlights`는 관리자 여부와 연결되어야 한다.
- Supabase 파일 저장은 24시간 보관 정책을 유지한다.

## Render 환경 변수

필수:

- `ANTHROPIC_API_KEY`

권장/운영:

- `MAX_TOKENS` 기본값은 `32000`
- `PYTHON_BIN` 설정 시 HWPX generator가 해당 Python을 사용한다.
- Supabase 관련 환경변수는 사용자, 파일함, 크레딧, 사용량 기록에 필요하다.
- feedback 이메일은 `RESEND_API_KEY`, `FEEDBACK_EMAIL_FROM` 또는 `RESEND_FROM` 설정 여부를 확인한다.

## 로컬 점검 명령

문법/기본 실행 확인:

```bash
node -c server.js
node -c lib/pipelines/phys-result/generate.js
node -c lib/pipelines/phys-result/cap-parser.js
node -c lib/pipelines/phys-result/hwpx-gen.js
python3 -m py_compile lib/pipelines/phys-result/hwpx-gen.py
python3 -m py_compile lib/equation/hwpx_equation_tool.py
```

HWPX generator는 Python 의존성이 필요하다. Render와 맞추려면 `.venv`가 있으면 `.venv/bin/python3` 또는 `PYTHON_BIN`을 우선 사용한다.

실제 품질 검증은 최소한 아래를 확인한다.

- `.cap` 단독 생성
- `.cap + 엑셀/CSV 정리 데이터` 생성
- 엑셀/CSV/텍스트만 있는 생성
- 이미지/그래프 스크린샷 포함 생성
- `.docx` 출력
- `.hwpx` 출력
- 생성 HWPX가 macOS 한글과 Windows 한컴에서 열리는지
- raw `{{EQ...}}`, `I_{cm}`, Markdown table pipe가 남지 않는지
- 제목 박스가 첫 페이지 양식대로 보이는지
- 데이터 표가 업로드 원본과 일치하는지

## 문제 분석 순서

물리 결과보고서 오류가 들어오면 아래 순서로 본다.

1. 브라우저 로그/사용자 스크린샷에서 입력 조합을 확인한다.
2. Render 로그의 진행 단계가 어디까지 갔는지 본다.
3. `/api/generate` 입력 검증 오류인지, Claude API 오류인지, JSON 파싱 오류인지, chart 렌더 오류인지, HWPX 빌드 오류인지 나눈다.
4. 데이터 오류면 `generate.js`의 canonical data 흐름을 확인한다.
5. `.cap` 오류면 `cap-parser.js`와 `summarizeForPrompt()` 결과를 확인한다.
6. HWPX가 안 열리면 ZIP 구조, `Contents/section*.xml`, `Contents/header.xml`, `Contents/content.hpf`, BinData 등록, 수식 postprocess를 확인한다.
7. 수식 raw text가 보이면 `normalize_physics_equation_markers()`와 `hwpx_equation_tool.py`를 확인한다.
8. 표가 깨지면 JSON `data_table.headers/rows`와 `add_table()`을 확인한다.
9. 글꼴/양식이 이상하면 template 기반 분기와 `pre.apply_default_font()` 영향 범위를 확인한다.

## 절대 하지 말 것

- 원본 업로드 데이터를 조용히 평균내거나 임의로 바꾸지 않는다.
- 메모에 없는 오차 원인, 제외 기준, 해결 결과를 만들어내지 않는다.
- `.cap` 원자료보다 사용자가 직접 정리한 엑셀/CSV가 우선이라는 규칙을 제거하지 않는다.
- HWPX 수식 postprocess 실패를 무시하고 파일을 내보내지 않는다.
- 물리 결과보고서 수정 중 화학 사전/화학 결과 양식을 무심코 바꾸지 않는다.
- 사용자 개인정보나 보고서 입력과 무관한 로컬 파일을 열람하지 않는다.
