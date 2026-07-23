# PDF 통번역 렌더러와 Drive/Colab 확장 설계

## 목표

PDF 통번역의 번역 결과와 출력 프로그램을 분리한다. 번역 모델의 검증된 결과를 한 번만
만들고, 같은 결과를 PyMuPDF, Tectonic, LibreOffice 등 여러 렌더러가 소비하게 한다.
렌더러가 바뀌어도 숫자, 단위, 수식, 표, 그림, 링크 검증은 약해지지 않아야 한다.

```text
원본 PDF
  -> 원본 구조 manifest
  -> 검증된 translation-map.json
  -> renderer-neutral document model
  -> PyMuPDF | Tectonic | LibreOffice
  -> 렌더러별 postflight
  -> 최종 PDF
```

## 렌더러 계약

`mode`와 `renderer`는 서로 다른 축이다.

- `mode=auto|inplace|retypeset`: 원본 배치 유지 또는 재조판이라는 문서 정책
- `renderer=auto|tectonic|libreoffice`: 재조판 결과를 실제 PDF로 만드는 프로그램
- `inplace`의 유효 렌더러는 항상 `pymupdf`
- `retypeset + auto`는 기존 동작을 보존하기 위해 `tectonic`
- `retypeset + libreoffice`만 LibreOffice Writer 경로를 사용
- 명시한 렌더러가 없거나 실패하면 다른 렌더러로 조용히 강등하지 않는다

LibreOffice는 PDF를 Draw로 직접 다시 여는 도구로 사용하지 않는다. 번역된 문서 모델로
DOCX 또는 ODT를 만든 뒤 Writer의 `writer_pdf_Export`로 PDF를 생성한다. 각 작업은 서로
다른 LibreOffice 프로필과 임시 디렉터리를 사용한다.

## renderer-neutral document model

새 번역 작업은 렌더링 전에 아래 정보를 원자적으로 저장한다.

```json
{
  "schema_version": 1,
  "source_sha256": "...",
  "pages": 548,
  "blocks": [
    {
      "id": "137",
      "page": 23,
      "source": "...",
      "target": "...",
      "bbox": [51, 72, 246, 190],
      "column": 0,
      "reading_order": 31,
      "role": "paragraph",
      "style": { "font_size": 9.5, "bold": false },
      "table_ref": null,
      "figure_ref": null,
      "formula_refs": []
    }
  ]
}
```

표는 셀/행/열 구조와 폭을 저장하고, 복잡한 수식과 회전 표는 원본 PDF의 해시 결합 crop을
시각 자산으로 보존한다. 단순 위첨자·아래첨자는 DOCX native run으로 만든다.

## Google Drive 작업공간 - 후속 단계

Drive는 실행 환경이 아니라 영속 작업공간으로 사용한다.

```text
Quilo/PDF-Translation/<job-id>/
  source.pdf
  request.json
  source-manifest.json
  translation-map.json
  document-model.json.zst
  assets.zip
  checkpoints/
  output-ko.docx
  output-ko.pdf
  attestation.json
```

대형 PDF와 작업 묶음은 Drive API의 resumable upload를 사용한다. Google 공식 문서도
5MB를 넘는 파일과 네트워크 중단 가능성이 있는 작업에는 resumable upload를 권장한다.
현재 multipart 메모리 업로드를 대형 교재의 기준 경로로 사용하지 않는다.

Drive 마운트를 수천 개의 작은 파일에 직접 사용하는 대신, 한 작업의 시각 자산은 ZIP
또는 압축 manifest로 묶는다. 모든 파일은 `job_id`, 사용자, source SHA-256에 결합하며,
다른 사용자의 작업 폴더나 공유 링크를 입력으로 신뢰하지 않는다.

## Google Colab GPU 보조 작업자 - 후속 단계

일반 Colab은 상시 서버가 아니다. 무료/일반 런타임은 대화형 사용을 우선하며 유휴 종료와
최대 실행 시간이 있으므로, 사용자가 직접 시작하는 선택적 GPU 가속기로만 사용한다.

Colab에 적합한 작업:

- 페이지 레이아웃 및 읽기 순서 분석
- 표 구조 인식
- 수식 영역 탐지와 OCR 후보 생성
- 스캔 페이지 OCR 후보 생성
- 도판/캡션 영역 분리
- 렌더링 전후 시각 임베딩 비교용 후보 생성

Colab이 맡지 않는 작업:

- 사용자 인증과 과금
- 번역 API 키 보관
- canonical 번역 최종 승인
- 최종 파일 공개 여부 결정
- 품질검사 우회 또는 결과 자동 신뢰

### 작업 묶음 계약

1. Quilo가 Drive에 입력 묶음과 `request.json`을 기록한다.
2. Colab은 `lease.json`을 만들고 입력 SHA-256을 검증한다.
3. GPU 전처리를 수행하고 `result.json`, 자산 ZIP, 실행 환경 정보를 기록한다.
4. 결과 manifest에 입력 해시, 모델/가중치 해시, 페이지 범위, 출력 해시를 넣는다.
5. Quilo가 결과를 다시 검증하고 canonical 파이프라인에 선택적으로 반영한다.
6. lease가 만료되거나 일부 페이지만 끝났다면 해당 구간만 재실행한다.

Colab 노트북에는 OpenAI/Anthropic 키를 넣지 않는다. 번역은 Quilo 서버에서 수행하고,
Colab에는 OCR/구조 분석에 필요한 최소 파일만 전달한다.

## 운영형 선택지

자동 실행이 필요하면 일반 Colab 대신 다음 중 하나를 사용한다.

- Colab Enterprise 예약 실행: 런타임 템플릿과 서비스 계정/IAM 사용
- Cloud Run Jobs 또는 GPU VM: 서버가 작업을 직접 제출하고 상태를 추적

Colab Enterprise 예약 실행의 결과 저장소는 공식 흐름상 Cloud Storage가 중심이다. 따라서
운영형에서는 Drive를 사용자 입출력 공간으로, Cloud Storage를 작업자 내부 저장소로 나누는
편이 안정적이다.

## 단계별 적용

1. **현재 단계**: LibreOffice 격리 실행기, DOCX 생성기, renderer 계약, 천문학 샘플 검증
2. 완전한 `translation-map.json` 및 문서 모델을 모든 새 작업에서 저장
3. Drive resumable upload와 작업 폴더/체크포인트 연결
4. 사용자가 실행하는 Colab OCR 가속 노트북 제공
5. 수요가 확인되면 Colab Enterprise/Cloud Run Jobs로 자동 작업자 전환

## 공식 참고자료

- Google Drive API 업로드 방식: https://developers.google.com/workspace/drive/api/guides/manage-uploads
- Google Colab FAQ와 런타임 제한: https://research.google.com/colaboratory/faq.html
- Colab Enterprise 예약 실행: https://cloud.google.com/colab/docs/schedule-notebook-run
