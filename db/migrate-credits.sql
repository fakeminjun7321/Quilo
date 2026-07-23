-- ============================================================================
-- 통합 크레딧 포인트제 전환 — 1회성 마이그레이션
-- Supabase Dashboard → SQL Editor에 붙여넣고 "한 번만" Run.
-- 반드시 코드 배포 "전에" 실행할 것 (컬럼이 없으면 신규 코드가 모든 사용자를
-- 0크레딧으로 인식해 생성이 막힘).
-- db/credit-rpc.sql 의 spend_credits 함수도 함께 적용할 것.
--
-- 공개 이력 보존용 과거 migration이다. 새 배포에서는 현재 db/migrations/의
-- 순서화된 migration을 우선하고, 적용 전 대상 스키마와 백업을 직접 확인한다.
-- ============================================================================

-- 1) 새 컬럼 추가 (기존 *_credits_usd 레거시 컬럼은 보존). 재실행 안전.
alter table users add column if not exists credits integer not null default 0;
alter table users add column if not exists unlimited boolean not null default false;
alter table users add column if not exists restricted_model text;

-- 2) 기존 사용자 잔액 → 크레딧 전환:
--    (사전 보고서 건수 + 결과 보고서 건수) × 3.
--    건수 = round(잔액USD / 보고서당 USD단가). 단가는 pricing.js 현재값 기준
--    (chem-pre ≈ $0.81, result ≈ $1.02). 환율이 크게 바뀌었으면 아래 숫자만 조정.
--    이미 credits>0 인 사용자는 건드리지 않음 → 우발적 재실행에도 잔액 보존.
update users
set credits = (
      round(coalesce(pre_credits_usd, 0) / 0.81)
    + round(coalesce(result_credits_usd, 0) / 1.02)
  )::int * 3
where coalesce(is_admin, false) = false
  and coalesce(credits, 0) = 0;

-- 3) 공개 저장소에는 알려진 비밀번호/무제한 계정 seed를 두지 않는다.
--    이미 과거 스크립트를 운영 DB에 적용했다면 아래 정리 SQL을 1회 실행:
--
-- update users
-- set unlimited = false,
--     restricted_model = null,
--     credits = 0
-- where name = 'testtest'
--   and student_id = 'beta';

-- 끝. (원자적 차감 함수는 db/credit-rpc.sql 의 spend_credits 를 적용)
