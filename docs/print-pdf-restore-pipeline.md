# 프린트 PDF 복원 파이프라인

`type=print-pdf-restore`는 종이 프린트 사진을 원문 구조에 가까운 벡터 PDF로 재구성하는 관리자 전용 베타 기능이다. 일반 회원·Pro 회원·외부 API 토큰에는 노출하거나 허용하지 않는다.

## 입력과 출력

- 필수 업로드: `photos` 이미지 1~40장 (`png`, `jpg`, `jpeg`, `webp`, `gif`)
- 선택 업로드: `reference` PDF 1개
- 선택 값: `pageOrder`, `promptText`, `layoutMode`, `semanticRedraw`
- 고정 출력: `application/pdf`

`reference`는 글꼴, 여백, 머리말, 워터마크 같은 공통 양식만 판단하는 근거다. 사진에서 판독할 수 없는 본문이나 수치를 참고 PDF로 채워 넣지 않는다.

## 생성 흐름

1. 각 원본 사진을 별도 vision 요청으로 읽어 페이지 JSON을 만든다.
2. 원문, 수식, 표, 레이아웃과 도형의 의미를 제한된 스키마로 검증한다.
3. 그래프·회로·산란도·에너지 준위 등은 축, 라벨, 방향, 관계를 semantic primitive로 표현한다.
4. 학교 로고·워터마크·실제 사진·복잡한 삽화만 원본 crop을 raster asset으로 사용할 수 있다.
5. 서버가 고정 LaTeX/TikZ 템플릿으로 벡터 PDF를 컴파일한다. 모델이 임의 TeX나 파일 명령을 실행할 수 없다.
6. 결과 PDF 전체를 PyMuPDF로 A4 300dpi 렌더한다.
7. 생성에 쓰인 요청과 분리된 두 번째 vision 요청이 원본 사진과 렌더를 다시 OCR하고 레이아웃·그림 의미·겹침·잘림을 비교한다.
8. Tesseract가 설치되어 있으면 독립 보조 OCR로 한 번 더 대조한다.

## fail-closed 품질 게이트

아래 조건 중 하나라도 만족하지 않으면 결과를 저장하거나 다운로드시키지 않는다.

- 모델 분석 confidence 미달 또는 `unreadable` 항목 존재
- 출력 페이지 수와 원본 사진 수 불일치
- 300dpi A4 렌더 실패 또는 빈 페이지
- source/output OCR 전사가 지나치게 짧음
- OCR 전사 Dice, vision 텍스트 유사도, 레이아웃 유사도 기준 미달
- 원문 대비 출력 전사 길이 coverage 범위 이탈
- 그래프·도해의 방향, 라벨 귀속, 곡선 topology 등 의미 관계 불일치
- 글자·도형 겹침이나 페이지 잘림
- `%PDF-` 또는 후미 `%%EOF`가 없는 불완전 PDF
- QA 결과의 `ok`, `visualPassed`, `renderedDpi`, `pageCount`, `ocrCoverage` 서버 계약 불충족

## 관리자 공개 경계

- 카탈로그 엔트리는 `audience: "admin"`, `status: "beta"`다.
- UI는 `/api/me`의 실제 `isAdmin` 값이 참일 때만 표시한다.
- `POST /api/generate`는 업로드 처리 전과 최신 프로필 재조회 후에 관리자 권한을 각각 확인한다.
- API 토큰 사용자는 관리자 계정과 연결돼 있어도 이 기능을 호출할 수 없다.

## 주요 파일

- `server.js`: 관리자 권한, PDF 고정 출력, job/SSE/저장 전 QA 게이트
- `lib/pipelines/print-pdf-restore/generate.js`: 입력 정규화, 페이지 분석, 생성 오케스트레이션
- `lib/pipelines/print-pdf-restore/schema.js`: 페이지·도형 스키마와 실행 가능한 TeX 차단
- `lib/pipelines/print-pdf-restore/semantic-renderer.js`: 결정론적 TikZ/Tectonic 렌더러
- `lib/pipelines/print-pdf-restore/qa.js`: 300dpi 렌더, 독립 vision OCR·시각 QA, Tesseract 보조 검사

## 로컬 검증

```bash
node -c server.js
node -c lib/pipelines/print-pdf-restore/generate.js
node -c lib/pipelines/print-pdf-restore/qa.js
node -c lib/pipelines/print-pdf-restore/schema.js
node -c lib/pipelines/print-pdf-restore/semantic-renderer.js
python3 -m py_compile lib/pipelines/print-pdf-restore/render_pdf.py
node --test tests/print-pdf-restore-server.test.js \
  tests/print-pdf-restore-admin-ui.test.js \
  lib/pipelines/print-pdf-restore/pipeline.test.js
```
