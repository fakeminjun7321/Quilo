insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 7, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;

alter table public.classbot_members add column if not exists quilo_user_id text;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'classbot_members_class_quilo_user_key'
       and conrelid = 'public.classbot_members'::regclass
  ) then
    alter table public.classbot_members
      add constraint classbot_members_class_quilo_user_key unique (class_id, quilo_user_id);
  end if;
end;
$$;

create or replace function public.classbot_claim_quilo_invite(
  p_class_id uuid,
  p_code_hash text,
  p_quilo_user_id text
)
returns setof public.classbot_members
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_invite public.classbot_invites%rowtype;
  selected_member public.classbot_members%rowtype;
begin
  if coalesce(trim(p_quilo_user_id), '') = ''
     or char_length(trim(p_quilo_user_id)) > 300
     or trim(p_quilo_user_id) !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'Quilo 사용자 식별값이 올바르지 않습니다.';
  end if;

  select *
    into selected_invite
    from public.classbot_invites
   where class_id = p_class_id
     and code_hash = p_code_hash
   for update;
  if not found
     or selected_invite.portal_used_at is not null
     or selected_invite.expires_at <= now() then
    raise exception '초대 코드가 올바르지 않거나 만료되었습니다.';
  end if;

  if exists (
    select 1 from public.classbot_members
     where class_id = p_class_id
       and quilo_user_id = trim(p_quilo_user_id)
       and id <> selected_invite.member_id
  ) then
    raise exception '이미 다른 구성원에 연결된 Quilo 계정입니다.';
  end if;

  update public.classbot_members
     set quilo_user_id = trim(p_quilo_user_id),
         status = 'active',
         joined_at = coalesce(joined_at, now()),
         updated_at = now()
   where class_id = p_class_id
     and id = selected_invite.member_id
     and status not in ('disabled', 'left')
   returning * into selected_member;
  if not found then
    raise exception '초대 대상 구성원을 찾을 수 없습니다.';
  end if;

  update public.classbot_invites
     set portal_used_at = now()
   where class_id = p_class_id and id = selected_invite.id;
  return next selected_member;
end;
$$;

revoke all on function public.classbot_claim_quilo_invite(uuid, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.classbot_claim_quilo_invite(uuid, text, text) to service_role';
  end if;
end;
$$;

drop function if exists public.classbot_claim_member_by_name(uuid, text, text, text);
