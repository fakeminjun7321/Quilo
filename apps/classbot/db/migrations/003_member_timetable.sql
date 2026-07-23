-- Classbot schema v3: per-member timetables.
-- Run with the Supabase service/database owner role. This migration contains
-- no roster or timetable data and is safe to re-run.

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'classbot_members_class_id_id_key'
       and conrelid = 'public.classbot_members'::regclass
  ) then
    alter table public.classbot_members
      add constraint classbot_members_class_id_id_key unique (class_id, id);
  end if;
end;
$$;

create table if not exists public.classbot_member_timetable (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null,
  member_id uuid not null,
  weekday integer not null check (weekday between 1 and 5),
  period integer not null check (period between 1 and 12),
  subject text not null check (char_length(trim(subject)) between 1 and 100),
  activity text not null default '' check (char_length(activity) <= 300),
  teacher text not null default '' check (char_length(teacher) <= 100),
  room text not null default '' check (char_length(room) <= 100),
  memo text not null default '' check (char_length(memo) <= 500),
  effective_from date not null default current_date,
  effective_to date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint classbot_member_timetable_member_fkey
    foreign key (class_id, member_id)
    references public.classbot_members(class_id, id)
    on delete cascade,
  constraint classbot_member_timetable_effective_dates_check
    check (effective_to is null or effective_to >= effective_from),
  constraint classbot_member_timetable_slot_key
    unique (class_id, member_id, weekday, period, effective_from)
);

create index if not exists classbot_member_timetable_lookup_idx
  on public.classbot_member_timetable(class_id, member_id, weekday, effective_from, effective_to, period);

create or replace function public.classbot_replace_member_timetable(
  p_class_id uuid,
  p_member_id uuid,
  p_rows jsonb
)
returns setof public.classbot_member_timetable
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception '개인 시간표 데이터는 배열이어야 합니다.';
  end if;

  perform 1
    from public.classbot_members
   where class_id = p_class_id
     and id = p_member_id
     and status <> 'left'
   for update;
  if not found then
    raise exception '개인 시간표를 등록할 구성원을 찾을 수 없습니다.';
  end if;

  if exists (
    select 1
      from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
        weekday integer,
        period integer,
        subject text,
        activity text,
        teacher text,
        room text,
        memo text,
        effective_from date,
        effective_to date
      )
     where row_data.weekday is null
        or row_data.weekday < 1
        or row_data.weekday > 5
        or row_data.period is null
        or row_data.period < 1
        or row_data.period > 12
        or nullif(trim(row_data.subject), '') is null
        or char_length(trim(row_data.subject)) > 100
        or char_length(coalesce(row_data.activity, '')) > 300
        or char_length(coalesce(row_data.teacher, '')) > 100
        or char_length(coalesce(row_data.room, '')) > 100
        or char_length(coalesce(row_data.memo, '')) > 500
        or (
          row_data.effective_to is not null
          and row_data.effective_to < coalesce(row_data.effective_from, current_date)
        )
  ) then
    raise exception '개인 시간표 행 형식이 올바르지 않습니다.';
  end if;

  delete from public.classbot_member_timetable
   where class_id = p_class_id and member_id = p_member_id;

  return query
  with inserted as (
    insert into public.classbot_member_timetable(
      class_id, member_id, weekday, period, subject, activity, teacher, room, memo, effective_from, effective_to
    )
    select
      p_class_id,
      p_member_id,
      row_data.weekday,
      row_data.period,
      trim(row_data.subject),
      coalesce(trim(row_data.activity), ''),
      coalesce(trim(row_data.teacher), ''),
      coalesce(trim(row_data.room), ''),
      coalesce(trim(row_data.memo), ''),
      coalesce(row_data.effective_from, current_date),
      row_data.effective_to
    from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
      weekday integer,
      period integer,
      subject text,
      activity text,
      teacher text,
      room text,
      memo text,
      effective_from date,
      effective_to date
    )
    returning *
  )
  select * from inserted order by weekday, period, effective_from desc;
end;
$$;

revoke all on function public.classbot_replace_member_timetable(uuid, uuid, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.classbot_replace_member_timetable(uuid, uuid, jsonb) to service_role';
  end if;
end;
$$;

drop trigger if exists set_updated_at on public.classbot_member_timetable;
create trigger set_updated_at
before update on public.classbot_member_timetable
for each row execute function public.classbot_set_updated_at();

alter table public.classbot_member_timetable enable row level security;

insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 3, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;
