-- Quilo 계정 비밀번호 재설정 토큰
-- Supabase Dashboard → SQL Editor에 통째로 붙여넣고 Run.

begin;

alter table users
  add column if not exists recovery_email text,
  add column if not exists password_reset_token_hash text,
  add column if not exists password_reset_expires_at timestamptz,
  add column if not exists password_reset_sent_at timestamptz;

create unique index if not exists users_password_reset_token_idx
  on users (password_reset_token_hash)
  where password_reset_token_hash is not null;

comment on column users.password_reset_token_hash is
  'SHA-256 hash of the single-use password reset token; raw token is never stored';
comment on column users.password_reset_expires_at is
  'Expiry for the single-use password reset token';
comment on column users.password_reset_sent_at is
  'Last password reset email issue time for per-account cooldown';

-- 기존에 저장된 인증 이메일은 그대로 복구 이메일로 사용한다. Quilo 조직처럼 같은
-- 이메일을 여러 계정이 인증할 수 있는 경우를 위해 recovery_email에는 unique를 걸지 않는다.
update users
set recovery_email = email
where recovery_email is null
  and email_verified = true
  and email is not null
  and email <> '';

comment on column users.recovery_email is
  'Verified email used for account recovery; may repeat for explicitly multi-verify organization addresses';

commit;
