-- 학생 인증(2단계) + 아이디/이름 분리.
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.
--
-- 요약
--  1) 로그인 식별자 username(아이디)을 name(이름)과 분리. 기존 계정은 username = name 으로 백필.
--  2) 학교 이메일 인증(email_verified) + 관리자 승인(approved) 2단계 게이트.
--     - 보고서 생성(/api/generate)은 관리자이거나 (email_verified AND approved) 인 계정만 가능.
--     - 기존 계정도 재인증 대상(email_verified=false, approved=false 로 시작). 관리자는 자동 승인.
--  3) 이메일은 학교 도메인만 허용(서버의 ALLOWED_EMAIL_DOMAINS, 기본 ts.hs.kr).
--
-- ⚠ 실행 전 점검(대소문자만 다른 동명 계정이 있으면 username 고유 인덱스가 실패):
--     select lower(name) as u, count(*) from users group by 1 having count(*) > 1;
--   결과가 있으면 해당 계정들의 이름을 먼저 정리한 뒤 실행하세요.
--
-- 전체를 하나의 트랜잭션으로 감싸 중간 실패 시 깨끗하게 롤백 + 재실행 가능하게 한다.

begin;

-- ── 1) 컬럼 추가 ─────────────────────────────────────────────────────────────
alter table users
  add column if not exists username text,
  add column if not exists email text,
  add column if not exists email_verified boolean not null default false,
  add column if not exists approved boolean not null default false,
  add column if not exists email_verify_token_hash text,
  add column if not exists email_verify_email text,
  add column if not exists email_verify_expires_at timestamptz,
  add column if not exists email_verify_sent_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references users(id) on delete set null;

-- ── 2) 기존 계정 백필: username = name(앞뒤 공백 정리) ─────────────────────────
update users
  set username = nullif(btrim(name), '')
  where username is null or btrim(username) = '';

-- ── 3) 충돌 사전 검사: 대소문자 무시 username 중복이면 명확히 실패(파괴적 단계 전에) ──
do $$
declare
  dup_count int;
begin
  select count(*) into dup_count from (
    select lower(username) lu from users
    where username is not null
    group by 1 having count(*) > 1
  ) t;
  if dup_count > 0 then
    raise exception
      '대소문자만 다른 동일 아이디(username)가 % 건 있어 고유 인덱스를 만들 수 없습니다. 위 점검 쿼리로 확인 후 이름을 정리하고 다시 실행하세요.',
      dup_count;
  end if;
end $$;

-- ── 4) 관리자 자동 승인(관리자는 게이트 면제이지만 데이터 정합성 위해 표시) ──────
update users
  set email_verified = true,
      approved = true,
      approved_at = coalesce(approved_at, now())
  where is_admin = true;

-- ── 5) name 의 unique 제약 제거 (이제 이름은 중복 가능, 아이디만 고유) ──────────
-- "name text not null unique" 가 자동 생성하는 제약 이름은 보통 users_name_key.
alter table users drop constraint if exists users_name_key;
drop index if exists users_name_key;

-- ── 6) username 고유(대소문자 무시) + not null ──────────────────────────────
create unique index if not exists users_username_lower_key
  on users (lower(username));
alter table users alter column username set not null;

-- 이름 조회용 인덱스(비고유)는 유지.
create index if not exists users_name_idx on users (lower(name));

-- ── 7) 학교 이메일은 계정당 1개(검증 완료된 이메일만 고유) ──────────────────────
create unique index if not exists users_email_lower_key
  on users (lower(email))
  where email is not null and email <> '';

-- 인증 토큰 해시로 빠른 조회.
create index if not exists users_email_verify_token_idx
  on users (email_verify_token_hash)
  where email_verify_token_hash is not null;

commit;

-- ── 끝 ─────────────────────────────────────────────────────────────────────
