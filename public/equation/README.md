# 한글 수식 변환 컴포넌트의 공개 범위

기존 브라우저용 LaTeX → HWP/HWPX 변환기는 제3자의
`Non-Commercial & Attribution` 코드를 포함했습니다. 상업적 이용을 제한하는
라이선스는 OSI 오픈소스가 아니므로 해당 구현과 파생 코드는 Quilo 공개 배포본에서
제외합니다.

서버 문서 생성 경로의 `lib/equation/hwpx_equation_tool.py`는 vendor 엔진이 없으면
자체 builtin 변환기를 사용합니다. 다음 파일이나 동등한 파생물을 공개 저장소에 다시
추가하지 마세요.

- `public/equation/src/`
- `public/equation/CONVERSION_RULES.md`
- `lib/equation/vendor/`

이 기능을 다시 공개하려면 아래 중 하나가 먼저 충족되어야 합니다.

1. 원저작자로부터 OSI 승인 라이선스로 재배포할 수 있는 서면 허락을 받는다.
2. 기존 코드와 변환 규칙을 보지 않은 기여자가 공개 명세와 독립 테스트만으로
   clean-room 구현을 작성한다.

관련 도움은 GitHub Issues에서 `help wanted` 라벨로 논의합니다.
