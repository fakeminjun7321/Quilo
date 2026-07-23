alter table users
  add column if not exists pre_credits_usd numeric(10, 4) not null default 0,
  add column if not exists result_credits_usd numeric(10, 4) not null default 0;

create table if not exists report_files (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id text,
  report_type text,
  filename text not null,
  bucket text not null default 'generated-reports',
  object_path text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  meta jsonb,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now()
);

create index if not exists report_files_user_created_idx
  on report_files (user_id, created_at desc);

create index if not exists report_files_expires_idx
  on report_files (expires_at);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-reports',
  'generated-reports',
  false,
  52428800,
  array[
    'application/hwp+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table report_files enable row level security;
