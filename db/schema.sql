-- chem-pre-lab-web: 사용자 등록 + 한도 시스템 DB 스키마
-- Supabase Dashboard → SQL Editor에 통째로 붙여넣고 Run.

-- ── 사용자 테이블 ────────────────────────────────────────────────────────────
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  -- name = 표시용 이름(이름, 중복 가능), username = 로그인 아이디(고유)
  name text not null,
  username text,
  student_id text not null default '',
  password_hash text not null,
  -- 학생 인증(2단계): 학교 이메일 인증 + 관리자 승인. 보고서 생성 게이트.
  email text,
  recovery_email text,
  email_verified boolean not null default false,
  approved boolean not null default false,
  email_verify_token_hash text,
  email_verify_email text,
  email_verify_expires_at timestamptz,
  email_verify_sent_at timestamptz,
  password_reset_token_hash text,
  password_reset_expires_at timestamptz,
  password_reset_sent_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references users(id) on delete set null,
  -- 선택형 서비스 개선 분석 동의. 미동의여도 보고서 생성 등 핵심 기능은 동일하다.
  analytics_consent boolean not null default false,
  analytics_consent_at timestamptz,
  analytics_consent_version text,
  budget_usd numeric(10, 4) not null default 0,
  spent_usd numeric(10, 4) not null default 0,
  pre_credits_usd numeric(10, 4) not null default 0,
  result_credits_usd numeric(10, 4) not null default 0,
  -- 통합 크레딧 포인트제 (모델별 과금: Opus 3 / Sonnet 1). 위 *_usd는 레거시(보존).
  credits integer not null default 0,
  -- 특수 계정: unlimited=차감 없이 무제한, restricted_model=해당 모델만 사용 가능(null=제한 없음)
  unlimited boolean not null default false,
  restricted_model text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists users_name_idx on users (lower(name));
-- 로그인 아이디(username)는 대소문자 무시 고유.
create unique index if not exists users_username_lower_key on users (lower(username));
-- 학교 이메일은 계정당 1개(검증 완료된 이메일만 고유).
create unique index if not exists users_email_lower_key
  on users (lower(email)) where email is not null and email <> '';
create index if not exists users_email_verify_token_idx
  on users (email_verify_token_hash) where email_verify_token_hash is not null;
create unique index if not exists users_password_reset_token_idx
  on users (password_reset_token_hash) where password_reset_token_hash is not null;

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

-- ── 로그인 기록 (관리자 전용 — AI 관리자 보조가 읽음) ────────────────────────
create table if not exists login_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete set null,
  user_name text not null default '',
  ip text not null default '',
  user_agent text not null default '',
  success boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists login_logs_created_idx on login_logs (created_at desc);

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
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf'
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
alter table login_logs enable row level security;
alter table report_files enable row level security;
alter table feedback_reports enable row level security;

-- ── 서비스 품질 관측 + 선택형 제품 분석 ────────────────────────────────────
-- 이 테이블에는 입력 원문·파일명·사용자 메모·생성 보고서 본문을 넣지 않는다.
create table if not exists generation_runs (
  id uuid primary key default gen_random_uuid(),
  request_id text not null unique,
  job_id text unique,
  user_id uuid references users(id) on delete set null,
  accepted boolean not null default true,
  status text not null default 'running'
    check (status in ('rejected', 'queued', 'running', 'done', 'error', 'aborted')),
  report_type text not null default 'unknown',
  model text not null default 'unknown',
  provider text not null default 'unknown',
  output_format text not null default 'unknown',
  background boolean not null default false,
  save_to_google_drive boolean not null default false,
  file_count integer not null default 0,
  file_extensions text[] not null default '{}',
  file_size_buckets jsonb not null default '{}'::jsonb,
  total_bytes_bucket text not null default 'lt_100kb',
  release_version text,
  release_commit text,
  queue_ms integer,
  generation_ms integer,
  build_ms integer,
  validation_ms integer,
  storage_ms integer,
  total_ms integer,
  warning_count integer not null default 0,
  artifact_ok boolean,
  artifact_rule_codes text[] not null default '{}',
  generated_image_count integer not null default 0,
  output_size_bucket text,
  error_phase text,
  error_code text,
  preview_count integer not null default 0,
  download_count integer not null default 0,
  first_preview_at timestamptz,
  last_preview_at timestamptz,
  first_download_at timestamptz,
  last_download_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null,
  event_name text not null,
  page_path text not null default '/',
  properties jsonb not null default '{}'::jsonb,
  consent_version text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now()
);

create table if not exists report_quality_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  job_id text not null,
  report_type text not null default 'unknown',
  score smallint not null check (score between 1 and 5),
  disposition text not null
    check (disposition in ('as_is', 'minor_edits', 'major_edits', 'not_used')),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, job_id)
);

create table if not exists privacy_consent_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  consent_type text not null default 'product_analytics',
  granted boolean not null,
  policy_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references users(id) on delete set null,
  actor_role text not null default 'admin',
  request_id text not null,
  action text not null,
  method text not null,
  path text not null,
  status integer not null,
  duration_ms integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists generation_runs_created_idx on generation_runs (created_at desc);
create index if not exists generation_runs_user_created_idx on generation_runs (user_id, created_at desc);
create index if not exists product_events_name_received_idx on product_events (event_name, received_at desc);
create index if not exists report_quality_feedback_created_idx on report_quality_feedback (created_at desc);
create index if not exists privacy_consent_logs_user_created_idx on privacy_consent_logs (user_id, created_at desc);
create index if not exists admin_audit_logs_actor_created_idx on admin_audit_logs (actor_user_id, created_at desc);

alter table generation_runs enable row level security;
alter table product_events enable row level security;
alter table report_quality_feedback enable row level security;
alter table privacy_consent_logs enable row level security;
alter table admin_audit_logs enable row level security;

-- ── 베타 기능 플래그 + 테스터 지정 ──────────────────────────────────────────
create table if not exists beta_features (
  key text primary key,
  label text not null default '',
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists beta_testers (
  feature_key text not null references beta_features(key) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (feature_key, user_id)
);

create index if not exists beta_testers_user_idx on beta_testers (user_id);

alter table beta_features enable row level security;
alter table beta_testers enable row level security;

insert into beta_features (key, label, enabled)
values ('pdf-translate', 'PDF 통번역', true)
on conflict (key) do nothing;

-- ── 끝 ─────────────────────────────────────────────────────────────────────
