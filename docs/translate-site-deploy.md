# PDF 통번역 독립 사이트 배포 가이드

메인 보고서 사이트(`server.js`)와 **같은 repo·별도 Render 서비스**로 돌아가는
PDF 통번역 전용 사이트다. 메인 사이트 코드는 건드리지 않는다.

- 엔트리: `translate-server.js` (start: `node translate-server.js` 또는 `npm run start:translate`)
- UI: `public/translate-app.html`
- 엔진: `lib/pipelines/pdf-translate/*` 를 메인과 **공유**(단일 소스)
- 접근: 비밀번호/초대코드(`TRANSLATE_ACCESS_CODES`)

## Render에 새 서비스 만들기

1. Render → **New +** → **Web Service** → 이 repo 선택(메인과 같은 repo).
2. 설정:
   - **Build Command**: `npm install`
     (postinstall이 메인과 동일하게 python venv + PyMuPDF + Tectonic + pandoc 설치 — 재조판/OCR에 필요)
   - **Start Command**: `node translate-server.js`
   - **Instance Type**: 메인과 동일 이상(PyMuPDF/Tectonic 메모리 때문에 무료티어는 빠듯할 수 있음)
3. **Environment** 변수:

   | 키 | 값 | 필수 |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | Claude 키 | ✅ |
   | `GPT_API_KEY` | OpenAI 키(= GPT 모델 쓸 때) | 선택 |
   | `MISTRAL_API_KEY` | strict OCR source evidence + 최종 의미·시각 독립 검토 키 | 스캔·숨은 OCR·깨진 텍스트 PDF 처리 시 ✅ |
   | `TRANSLATE_ACCESS_CODES` | `code1,code2` (쉼표구분 초대코드) | ✅(프로덕션) |
   | `TRANSLATE_SESSION_SECRET` | 쿠키 서명용 랜덤 문자열 | 권장 |
   | `NODE_ENV` | `production` | 권장 |
   | `PORT` | (Render가 자동 주입) | — |

   > `TRANSLATE_ACCESS_CODES` 미설정 + `NODE_ENV=production` 이면 **모든 접근이 차단**된다(안전 기본값). 로컬도 코드 없이 열려면 `TRANSLATE_ALLOW_OPEN_DEV=1`을 명시해야 한다.

   > strict OCR은 `MISTRAL_API_KEY`가 없을 때 기존 비전 OCR로 조용히 폴백하지 않는다.
   > 저신뢰 숫자·단위·URL·수식은 OCR 원문 확정 전 별도 visual adjudicator가
   > 페이지·타일·실제 이미지 바이트 예산으로 나누어 확인한다. 각 배치의 exact
   > token coverage와 입력 digest를 검증한 뒤 전체 commitment로 봉인한다. 최종
   > source/output 시각 검토도 별도로 수행한다.

4. 배포 후 사이트 접속 → 초대코드 입력 → PDF 업로드 → 번역.

## 튜닝 환경변수(선택, 메인과 공유)

`PDF_TRANSLATE_TIMEOUT_MS`(기본 90분), `PDF_TRANSLATE_MAX_PAGES`(메인/독립 700, 관리자는 페이지 수 검사 면제),
`PDF_TRANSLATE_LIBREOFFICE_ENABLED`(기본 비활성화; LibreOffice 실행 파일과 전용 reflow 검증이 준비된 환경에서만 `1`),
`PDF_OCR_MAX_PAGES`(폐기됨·값이 남아 있어도 무시),
`PDF_OCR_PROVIDER_BATCH_PAGES`(기본 50), `PDF_OCR_PROVIDER_CONCURRENCY`(기본 2),
`PDF_OCR_RISK_VISUAL_BATCH_PAGES`(기본 4, 최대 8),
`PDF_OCR_RISK_VISUAL_BATCH_TILES`(기본 12, 최대 24),
`PDF_OCR_RISK_VISUAL_BATCH_BYTES`(기본 8MiB, 최대 24MiB),
`PDF_OCR_RISK_VISUAL_BATCH_TOKENS`(기본 20, 최대 40),
`MISTRAL_OCR_INLINE_MAX_MB`(기본 45MB, 초과 시 임시 파일 URL 후 즉시 삭제),
`MISTRAL_OCR_MAX_FILE_MB`(기본 512MB), `MISTRAL_OCR_CLEANUP_TIMEOUT_MS`(기본 20초), `PDF_AUTO_MATH_THRESHOLD`(12),
`PDF_RETYPESET_CHUNK_PAGES`(5), `PDF_TRANSLATE_CONCURRENCY`,
`PDF_RETYPESET_CONCURRENCY`, `PDF_TRANSLATE_MODEL`(기본 모델),
`PDF_TRANSLATE_MIN_FONT_PT`(기본 6pt, `0`이면 최소 글꼴 검증 비활성화),
`PDF_OCR_SEMANTIC_JUDGE_MODEL`, `PDF_OCR_SEMANTIC_BATCH_PAGES`(기본 20),
`PDF_OCR_SEMANTIC_CONCURRENCY`(기본 2),
`PDF_OCR_VISUAL_JUDGE_MODEL`(기본 `mistral-medium-3-5`),
`PDF_OCR_RISK_VISUAL_MODEL`(기본 `mistral-medium-3-5`),
`PDF_OCR_VISUAL_BATCH_PAGES`(기본 8), `PDF_OCR_VISUAL_MAX_IMAGES`(최대 60),
`PDF_OCR_VISUAL_MAX_RAW_IMAGE_BYTES`(하드 상한 32MiB),
`PDF_TRANSLATE_POSTFLIGHT_TIMEOUT_MS`(기본 20분).

빠른 번역은 이미 한국어인 구간과 문서 안에서 텍스트가 완전히 같은 반복
머리글·꼬리글·섹션명을 모델에 중복 전송하지 않는다. 한국어 구간은 기존 문자·숫자·URL·
수식 검증을 그대로 통과한 경우에만 직접 재사용하고, 반복 구간은 대표 번역이 품질 검증을
통과한 뒤에만 나머지 ID로 복제한다. 대표 번역이 실패하면 전체 누락 검증도 기존처럼
fail-closed한다.

## 도메인

Render 서비스에 커스텀 도메인 연결 가능(서비스 → Settings → Custom Domains).

## 로컬 점검

```bash
# 게이트 없이(개발):
TRANSLATE_ALLOW_OPEN_DEV=1 TRANSLATE_PORT=4100 node translate-server.js
# 코드 게이트:
NODE_ENV=production TRANSLATE_ACCESS_CODES=hunter2 TRANSLATE_PORT=4100 node translate-server.js
```

## 메인 사이트 영향

보고서 생성 파이프라인과 기존 `node server.js` 시작 방식은 그대로다. 다만
PDF 통번역 엔진(`lib/pipelines/pdf-translate/`)과 최종 검증 오케스트레이션은
독립 사이트와 메인 사이트가 공유한다. 따라서 OCR·재조판·postflight 정책을
변경하면 `translate-server.js`와 `server.js`의 PDF 통번역 경로에 모두 반영된다.
