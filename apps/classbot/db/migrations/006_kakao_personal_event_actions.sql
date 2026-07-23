-- Classbot schema v6: short-lived, confirmation-gated Kakao personal event actions.

create table if not exists public.classbot_kakao_pending_actions (
  member_id uuid primary key references public.classbot_members(id) on delete cascade,
  class_id uuid not null references public.classbot_classes(id) on delete cascade,
  action text not null check (action in ('create', 'update', 'complete', 'delete')),
  event_id uuid references public.classbot_events(id) on delete cascade,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (class_id, member_id)
    references public.classbot_members(class_id, id) on delete cascade,
  check ((action = 'create' and event_id is null) or (action <> 'create' and event_id is not null))
);

create index if not exists classbot_kakao_pending_actions_expiry_idx
  on public.classbot_kakao_pending_actions(class_id, expires_at);

drop trigger if exists set_updated_at on public.classbot_kakao_pending_actions;
create trigger set_updated_at
before update on public.classbot_kakao_pending_actions
for each row execute function public.classbot_set_updated_at();

alter table public.classbot_kakao_pending_actions enable row level security;

insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 6, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;
