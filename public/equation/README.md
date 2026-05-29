# HWPX LaTeX → 한글 수식 변환기

HWPX(`.hwpx`) 문서 안에 텍스트로 들어 있는 **LaTeX 수식만** 한컴오피스 한글(HWP) **수식 개체**로 바꿔, 새 `.hwpx` 파일로 내려받는 **정적 웹 도구**입니다. 모든 처리는 **브라우저 안에서** 이루어지며 파일은 서버로 전송되지 않습니다.

AI(ChatGPT, Claude 등)가 만든 `$…$`, `$$…$$`, `\(…\)`, `\[…\]` 형태의 LaTeX가 한글에서 그대로 렌더링됩니다.

## 사용법

`index.html`을 브라우저로 열고 **`.hwp` 또는 `.hwpx`** 파일을 끌어다 놓거나 선택한 뒤 **수식 변환**을 누르면, 변환된 `*_hwp_equations.hwpx`를 내려받습니다.

정적 파일이라 GitHub Pages 등 정적 호스팅에 그대로 올릴 수 있습니다. (CDN 없이 동작 — `vendor/jszip.min.js` 동봉)

### HWP(.hwp) 입력

`.hwp`는 이진(바이너리) 형식이라 직접 다루지 않고, 오픈소스 [rhwp](https://github.com/edwardkim/rhwp)(Rust + WebAssembly)의 공개 인스턴스를 숨긴 iframe으로 불러와 **브라우저 안에서 `.hwpx`로 먼저 변환**한 뒤 동일한 수식 변환 파이프라인을 태웁니다(서버 업로드 없음). **결과물은 `.hwpx`로 내려받습니다.** rhwp 인스턴스가 닫혀 있거나 변환이 실패할 수 있으니, 가능하면 한글에서 `.hwpx`로 저장 후 사용하는 것이 가장 안정적입니다.

## 동작 방식

원본 HWPX(ZIP) 구조를 최대한 보존하고 `Contents/section*.xml`의 텍스트 LaTeX 구간만 `<hp:equation><hp:script>…</hp:script></hp:equation>` 개체로 바꿉니다.

1. ZIP 해제 (JSZip)
2. `Contents/section*.xml`을 DOMParser로 파싱
3. 텍스트 런(`hp:t`)에서 LaTeX 구간 탐지 — `$100$`처럼 숫자뿐인 달러 표기는 금액으로 보고 제외
4. 각 구간을 `converter.js`로 한글 수식 script로 변환해 수식 개체로 치환
5. ZIP 재압축 (mimetype은 첫 항목·비압축으로 보존) → 내려받기

> 이 도구는 [latex-to-hwp](https://github.com/minigu5/latex-to-hwp)의 변환 엔진(`src/converter.js`)과 파이썬 CLI(`tools/hwpx_latex_to_hwp.py`)의 HWPX 처리 로직을 **브라우저용으로 포팅**한 것입니다.

## 구성

```
index.html              드래그드롭 UI
src/converter.js        LaTeX → 한글 수식 변환 엔진 (© Shin Mingyu)
src/hwpx-convert.js     HWPX(zip/xml) 처리 — 브라우저/Node 공용
vendor/jszip.min.js     ZIP 처리 (동봉, CDN 불필요)
CONVERSION_RULES.md     변환 규칙 (한컴 공식 명세 기반)
test/                   Node 테스트 (@xmldom/xmldom + jszip 주입)
```

## 테스트

```bash
npm install   # 테스트용 devDependencies (@xmldom/xmldom, jszip)
npm test      # node --test
```

E2E 테스트는 변환 결과가 원본 파이썬 CLI 출력과 **동일한 수식 script**를 내는지, 출력 ZIP의 mimetype이 첫 항목·비압축인지 검증합니다.

## 한계 / 확인 필요

- 한글 수식 문법은 공식 레퍼런스가 빈약해, 복잡한 수식은 한글에서 직접 열어 확인하길 권합니다.
- 미확인 LaTeX 명령은 임의로 버리지 않고 이름을 보존합니다.
- 이미 수식 개체이거나 이미지로 들어간 수식은 변환 대상이 아닙니다.

## 라이선스 / 출처 표시

이 프로젝트는 [latex-to-hwp](https://github.com/minigu5/latex-to-hwp) (© 2026 **Shin Mingyu**, [@minigu5](https://github.com/minigu5))의 **변환 엔진(`src/converter.js`)과 변환 규칙(`CONVERSION_RULES.md`)을 포함**하고, 그 파이썬 CLI의 HWPX 처리 로직을 브라우저로 **포팅(`src/hwpx-convert.js`)**한 2차적 저작물입니다.

원본 라이선스는 **Custom License (Non-Commercial & Attribution)** 이며, 다음을 의미합니다.

- **출처 표시(Attribution):** 저작권 고지와 허가 문구를 모든 복제본에 포함해야 합니다. 본 저장소는 [`LICENSE`](./LICENSE)에 원문을, [`NOTICE`](./NOTICE)에 상세 출처를 담고 있습니다.
- **비영리(Non-Commercial):** 본 소프트웨어와 그 **파생물은 판매·영리 목적 사용이 금지**됩니다. 본 결합 저작물 전체가 이 조건의 적용을 받으며, 이 사이트는 무료로만 제공됩니다.

신규 코드(브라우저 포팅·UI·테스트)는 © 2026 **구민준**([@fakeminjun7321](https://github.com/fakeminjun7321))이 작성했으나, 위 엔진을 포함·파생하므로 저장소 전체가 동일한 Non-Commercial & Attribution 조건을 따릅니다.

런타임 의존성 **JSZip v3.10.1**(© Stuart Knightley, MIT)은 `vendor/jszip.min.js`에 라이선스 배너를 보존한 채 동봉했습니다. 변환 규칙은 한글과컴퓨터 공개 명세 「한글 문서 파일 형식 - 수식」(rev. 1.2)을 참고했습니다.

영리적 이용 등 위 조건을 벗어난 사용은 원저작자 Shin Mingyu([@minigu5](https://github.com/minigu5))의 별도 허락이 필요합니다. (본 안내는 법률 자문이 아닙니다.)
