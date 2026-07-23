# Quilo 일정 관리 외부 연동 기준

기준일: 2026-07-16

## 카카오톡 챗봇

Quilo의 자동 알림은 카카오 챗봇 Event API를 사용한다.

- 발송: `POST https://bot-api.kakao.com/v2/bots/{botId}/talk`
- 결과 조회: `GET https://bot-api.kakao.com/v1/tasks/{taskId}`
- 인증: 카카오 디벨로퍼스 앱의 REST API 키 (`Authorization: KakaoAK ...`)
- 발송 대상: 채널을 친구 추가한 사용자 중 스킬 요청에서 식별키를 확보한 사용자
- 허용 식별키: `botUserKey`, `plusfriendUserKey`, `appUserId`
- 요청당 최대 100명, 중복 사용자 불가
- 실제 전송 성공 1건당 15원(VAT 별도)

POST 응답의 `SUCCESS`는 작업 접수 성공이다. 실제 사용자별 성공 여부는 반드시
`taskId` 결과 조회로 확인한다. 결과 조회 전에는 알림 기록을 성공으로 확정하지 않는다.
채널 미추가, 차단, 잘못된 사용자 키, 스킬 서버 오류는 일부 사용자에게만 발생할 수 있다.

운영 전에는 비즈니스 인증 채널과 비즈앱 연결, 카카오 로그인 활성화, 챗봇 채널 연결,
월렛 연결, Event 블록의 이벤트명 설정, 블록 및 봇 배포가 완료되어야 한다. 관리자센터의
이벤트명과 `KAKAO_EVENT_NAME`은 정확히 같아야 한다.

공식 문서:

- [Event API](https://kakaobusiness.gitbook.io/main/tool/chatbot/main_notions/event-api)
- [챗봇 월렛](https://kakaobusiness.gitbook.io/main/tool/chatbot/main_notions/wallet)
- [스킬 요청/응답 형식](https://kakaobusiness.gitbook.io/main/tool/chatbot/skill_guide/answer_json_format)

## 열품타

2026-07-16 현재 일반 개발자가 사용할 수 있는 공식 공개 API, 웹훅, OAuth 또는 ICS
내보내기 문서는 확인되지 않았다. 따라서 다음 방식은 구현하지 않는다.

- 비공개 앱 API 역공학
- 토큰·쿠키 추출 또는 계정 세션 공유
- 에뮬레이터/UI 자동화
- 앱 화면 상시 스크래핑

이 방식들은 앱 변경에 취약하고, 학생 개인정보 및 계정 정지 위험이 있다.

현재 운영 원칙은 Quilo를 학급 일정의 원본으로 사용하고 열품타 Todo는 학생이 필요한
항목만 직접 옮기는 것이다. 자동 연동이 꼭 필요하면 열품타 공식 제휴 창구를 통해 파트너
API와 데이터 사용 허가를 서면으로 받은 뒤 별도 검토한다. 열품타가 공식 내보내기 기능을
제공하게 되면 사용자가 직접 내보낸 자기 데이터만 가져오며, 다른 학생의 이름과 통계는
제외하거나 가린다.

확인한 공식 공개면:

- [열품타 공식 홈페이지](https://yeolpumta.com/)
- [Google Play 공식 앱 페이지](https://play.google.com/store/apps/details?id=com.pallo.passiontimerscoped)
- [App Store 공식 앱 페이지](https://apps.apple.com/kr/app/%EC%97%B4%ED%92%88%ED%83%80/id1441909643)
