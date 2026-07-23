# Classbot backend operations

## Notification delivery state

Kakao Event API의 POST `SUCCESS`는 접수 성공일 뿐 실제 발송 성공이 아니다. 서버는 `taskId`로 결과를 조회하고 다음과 같이 저장한다.

- 결과 준비 전: `reserved`
- 사용자 발송 성공 확인: `sent`
- 사용자별 실패 또는 POST 실패: `failed`
- 10분 이상 `taskId`가 없는 예약: `failed`로 전환하고 Cron 응답의 `orphanCount`, `orphans`에 노출

`failed` 알림은 자동 재시도하지 않는다. 친구 해제, 잘못된 키, 결제/쿼터 문제에서 자동 재시도하면 같은 메시지의 중복 발송과 추가 과금이 발생할 수 있기 때문이다.

관리자가 원인을 확인한 뒤 `POST /api/admin/notifications/:id/retry`를 명시적으로 호출할 수 있다. 이 요청에는 8~128자의 `Idempotency-Key`가 필수이며, 같은 키를 다시 사용하면 새 발송을 만들지 않는다.

일정 알림의 중복 방지 키에는 `event.id`, 현재 `due_at`, reminder offset, member id가 포함된다. 따라서 같은 마감 revision은 한 번만 발송되고, 관리자가 마감을 변경하면 새 일정에 맞춰 다시 예약할 수 있다.

## Production requirements

운영 환경은 `CLASSBOT_STORAGE=supabase`만 허용한다. 메모리 저장소는 재시작 시 데이터와 중복 방지 기록을 잃으므로 로컬 개발 전용이다. 세션·Cron·카카오 스킬 secret은 각각 32자 이상, 관리자 비밀번호는 16자 이상이어야 한다. 카카오 스킬 secret은 스킬 URL의 `?secret=` 또는 `X-Classbot-Skill-Secret` 헤더로 전달한다.

구성원 생성, 반 시간표 요일 교체, 개인별 시간표 전체 교체는 Supabase RPC 안에서 대상 행을 잠그고 처리한다. 개인별 시간표 테이블은 RLS를 켜고 anon/authenticated 정책을 만들지 않는다. 관리자 API의 구성원 DTO와 audit JSON에는 `kakao_user_key` 원문을 반환하거나 기록하지 않는다.

학생 포털은 부모 Quilo 서버가 매 요청 새로 검증한 불변 사용자 ID를, 1회용 초대 코드로 명단 한 항목에 연결한다. 표시 이름은 인증에 사용하지 않고 하위 앱에는 Quilo API 토큰을 넘기지 않으며, 학생 요청의 `member_id`는 연결된 구성원으로 서버에서 강제한다. 학생은 다른 구성원 개인 일정·개인 시간표·자료를 조회하거나 수정할 수 없고, 관리자 역할만 반 전체 일정을 관리할 수 있다. 카카오 가입도 관리자가 발급한 1회용 초대 코드만 허용하며 이름만으로는 계정을 연결할 수 없다.
