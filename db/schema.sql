-- chem-pre-lab-web: 사용자 등록 + 한도 시스템 DB 스키마
-- Supabase Dashboard → SQL Editor에 통째로 붙여넣고 Run.

-- ── 사용자 테이블 ────────────────────────────────────────────────────────────
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  student_id text not null default '',
  password_hash text not null,
  budget_usd numeric(10, 4) not null default 0,
  spent_usd numeric(10, 4) not null default 0,
  pre_credits_usd numeric(10, 4) not null default 0,
  result_credits_usd numeric(10, 4) not null default 0,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_name_idx on users (lower(name));

-- ── 사용량 로그 ──────────────────────────────────────────────────────────────
create table if not exists usage_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id text,
  text_cost_usd numeric(10, 6) not null default 0,
  image_cost_usd numeric(10, 6) not null default 0,
  total_usd numeric(10, 6) not null default 0,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_logs_user_id_idx on usage_logs (user_id, created_at desc);

-- ── 생성 파일 메타데이터 (파일 본문은 Supabase Storage에 24시간 보관) ───────
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

-- ── 건의사항/버그 제보 ──────────────────────────────────────────────────────
create table if not exists feedback_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  user_name text not null default '',
  category text not null,
  title text not null,
  message text not null,
  contact_email text,
  page_url text,
  user_agent text,
  email_sent boolean not null default false,
  email_error text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists feedback_reports_created_idx
  on feedback_reports (created_at desc);
create index if not exists feedback_reports_user_created_idx
  on feedback_reports (user_id, created_at desc);

-- private bucket. 서버(service_role)가 사용자 권한 확인 후 대리 다운로드한다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'generated-reports',
  'generated-reports',
  false,
  52428800,
  array[
    'application/hwp+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ── updated_at 자동 갱신 트리거 ─────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ── RLS (Row-Level Security) ─────────────────────────────────────────────────
-- service_role 키는 RLS를 우회하므로 안전. 단, anon 키 노출 방지를 위해
-- RLS는 켜두고 공개 정책을 만들지 않음.
alter table users enable row level security;
alter table usage_logs enable row level security;
alter table report_files enable row level security;
alter table feedback_reports enable row level security;

-- ── 끝 ─────────────────────────────────────────────────────────────────────
