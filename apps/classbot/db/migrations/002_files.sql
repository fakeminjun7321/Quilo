begin;

create table if not exists public.classbot_files (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.classbot_classes(id) on delete cascade,
  member_id uuid references public.classbot_members(id) on delete cascade,
  alias text not null check (char_length(alias) between 1 and 60),
  filename text not null check (char_length(filename) between 1 and 180),
  description text not null default '' check (char_length(description) <= 1000),
  mime_type text not null check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif')),
  size_bytes bigint not null check (size_bytes between 1 and 20971520),
  bucket text not null,
  object_path text not null unique,
  status text not null default 'active' check (status in ('active', 'deleted')),
  created_by text not null default 'admin',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists classbot_files_class_alias_idx
  on public.classbot_files(class_id, lower(alias))
  where member_id is null and status = 'active';

create unique index if not exists classbot_files_member_alias_idx
  on public.classbot_files(class_id, member_id, lower(alias))
  where member_id is not null and status = 'active';

create index if not exists classbot_files_list_idx
  on public.classbot_files(class_id, status, created_at desc);

drop trigger if exists set_updated_at on public.classbot_files;
create trigger set_updated_at
before update on public.classbot_files
for each row execute function public.classbot_set_updated_at();

alter table public.classbot_files enable row level security;

insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 2, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;

commit;
