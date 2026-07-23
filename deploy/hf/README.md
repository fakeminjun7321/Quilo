---
title: PDF 통번역
emoji: 📄
colorFrom: indigo
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: DeepL식 PDF 문서 번역 (그림·레이아웃 유지, 텍스트만 한국어)
---

# PDF 통번역

그림·표·레이아웃을 최대한 보존하며 **텍스트를 한국어로** 바꾼 PDF를 돌려줍니다.
수식 많은 논문·스캔본은 자동으로 재조판/OCR 처리합니다. 빠른 번역은 추출 텍스트를,
재조판·OCR은 PDF 또는 페이지 이미지를 번역 제공자 및 설정된 OCR 제공자에 전송할 수 있습니다.
재조판 출력 엔진은 기본 Tectonic과 선택형 LibreOffice Writer를 지원합니다. LibreOffice
경로도 검증된 번역을 먼저 Tectonic 중간 PDF로 만든 뒤 Writer용 DOCX로 재조판하며,
Writer 변환이나 최종 품질검사가 실패하면 다른 렌더러로 조용히 강등하지 않습니다.
따라서 Tectonic 설치 또는 실행 확인이 실패하면 Docker 빌드도 실패하도록 구성됩니다.

접근은 **초대코드**(`TRANSLATE_ACCESS_CODES`)로 제한됩니다.

LibreOffice 실행 파일은 이미지에 포함되지만 렌더러는 운영 플래그
`PDF_TRANSLATE_LIBREOFFICE_ENABLED=1`이 있어야 노출됩니다. reflow 전용 최종 검증이
배포되기 전에는 이 플래그를 설정하지 않습니다.

## 필요한 Secrets (Space → Settings → Variables and secrets)

| 키 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 키 (필수) |
| `GPT_API_KEY` | OpenAI 키 (GPT 모델 쓸 때, 선택) |
| `MISTRAL_API_KEY` | strict OCR source evidence와 최종 의미·시각 독립 검토 키 (스캔·숨은 OCR·깨진 텍스트 PDF 처리 시 필수) |
| `TRANSLATE_ACCESS_CODES` | 초대코드 `code1,code2` (필수) |
| `TRANSLATE_SESSION_SECRET` | 쿠키 서명용 랜덤 문자열 (권장) |

`MISTRAL_API_KEY`가 없으면 스캔 계열 입력을 비전 추정으로 강등하지 않고
`OCR_NOT_CONFIGURED`로 중단합니다. 숫자·단위·URL·수식의 OCR confidence가 기준보다
낮으면 OCR 원문 확정 전의 별도 visual adjudicator가 필요합니다. 현재 공개 배포
번들에는 이 저신뢰 토큰 adjudicator가 연결되어 있지 않으므로 추측한 결과를
내보내지 않고 fail-closed로 중단합니다.

스캔 번역이 성공하면 서버는 최종 PDF를 canonical OCR과 의미 대조하고,
원문·결과 페이지를 다시 렌더링해 텍스트·그림·표 구조를 독립 비전 모델로
검토합니다. 기본 시각 검토 모델은 `mistral-medium-3-5`이며,
`PDF_OCR_VISUAL_JUDGE_MODEL`로 지원 중인 다른 Mistral 비전 모델을 지정할 수 있습니다.
