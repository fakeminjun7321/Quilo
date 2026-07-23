-- Classbot schema v5: short-lived pending file candidates used by the
-- conversational file confirmation flow. Name-only member claiming was
-- removed in schema v7 because a mutable display name is not authentication.
drop function if exists public.classbot_claim_member_by_name(uuid, text, text, text);

create table if not exists public.classbot_kakao_states (
  member_id uuid primary key references public.classbot_members(id) on delete cascade,
  class_id uuid not null references public.classbot_classes(id) on delete cascade,
  pending_file_ids text[] not null check (cardinality(pending_file_ids) between 1 and 3),
  pending_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (class_id, member_id)
    references public.classbot_members(class_id, id) on delete cascade
);

create index if not exists classbot_kakao_states_expiry_idx
  on public.classbot_kakao_states(class_id, pending_expires_at);

drop trigger if exists set_updated_at on public.classbot_kakao_states;
create trigger set_updated_at
before update on public.classbot_kakao_states
for each row execute function public.classbot_set_updated_at();

alter table public.classbot_kakao_states enable row level security;

insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 5, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;
