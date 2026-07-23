-- One-time operation for an existing admin account that has no stored recovery email.
-- 1) Replace both REPLACE_* values below.
-- 2) Run the whole file in Supabase SQL Editor.
-- 3) Do not commit real usernames or email addresses into this file.

do $$
declare
  target_login_id text := 'REPLACE_WITH_LOGIN_ID';
  target_email text := 'REPLACE_WITH_VERIFIED_EMAIL';
  affected integer;
begin
  if target_login_id like 'REPLACE_%' or target_email like 'REPLACE_%' then
    raise exception 'Replace target_login_id and target_email before running';
  end if;
  if target_email !~* '^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z0-9\-]+$' then
    raise exception 'target_email is not a valid email address';
  end if;

  update users
  set recovery_email = lower(target_email),
      email_verified = true,
      updated_at = now()
  where lower(username) = lower(target_login_id)
    and is_admin = true
    and recovery_email is null;

  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'Expected exactly one admin account, updated % rows', affected;
  end if;
end $$;
