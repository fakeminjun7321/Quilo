-- @quilolab.com 조직 메일을 실제로 인증한 계정에 스탭 역할을 자동 부여한다.
-- 부분 일치나 하위 도메인은 허용하지 않고, email_verified=true인 확정 주소만 본다.

alter table public.users
  add column if not exists is_staff boolean not null default false;

create or replace function public.apply_quilolab_staff_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.email_verified is true
     -- 전체 문자열을 anchored 검증한다. split_part(..., 2)는
     -- a@quilolab.com@evil.com도 두 번째 조각이 quilolab.com이므로 사용하면 안 된다.
     and coalesce(new.email, '') ~* '^[a-z0-9_%+-]+([.][a-z0-9_%+-]+)*@quilolab[.]com$'
     and position('@' in coalesce(new.email, '')) between 2 and 65
     and char_length(coalesce(new.email, '')) <= 254 then
    new.is_staff := true;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_quilolab_staff_role on public.users;
create trigger trg_users_quilolab_staff_role
  before insert or update of email, email_verified on public.users
  for each row execute function public.apply_quilolab_staff_role();

-- 이 기능 배포 전에 이미 조직 이메일 인증을 끝낸 계정도 즉시 반영한다.
update public.users
set is_staff = true
where email_verified is true
  and coalesce(email, '') ~* '^[a-z0-9_%+-]+([.][a-z0-9_%+-]+)*@quilolab[.]com$'
  and position('@' in coalesce(email, '')) between 2 and 65
  and char_length(coalesce(email, '')) <= 254;

revoke all on function public.apply_quilolab_staff_role() from public, anon, authenticated;
