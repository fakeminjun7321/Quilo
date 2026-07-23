-- Quilo 서비스 품질 관측·선택형 제품 분석.
-- 원문 입력, 업로드 파일명/내용, 사용자 메모, 생성 보고서 본문은 저장하지 않는다.

alter table users
  add column if not exists analytics_consent boolean not null default false,
  add column if not exists analytics_consent_at timestamptz,
  add column if not exists analytics_consent_version text;

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
  file_count integer not null default 0 check (file_count >= 0),
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

create index if not exists generation_runs_created_idx
  on generation_runs (created_at desc);
create index if not exists generation_runs_user_created_idx
  on generation_runs (user_id, created_at desc);
create index if not exists generation_runs_type_created_idx
  on generation_runs (report_type, created_at desc);

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

create index if not exists product_events_user_received_idx
  on product_events (user_id, received_at desc);
create index if not exists product_events_name_received_idx
  on product_events (event_name, received_at desc);

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

create index if not exists report_quality_feedback_created_idx
  on report_quality_feedback (created_at desc);

create table if not exists privacy_consent_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  consent_type text not null default 'product_analytics',
  granted boolean not null,
  policy_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists privacy_consent_logs_user_created_idx
  on privacy_consent_logs (user_id, created_at desc);

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

create index if not exists admin_audit_logs_actor_created_idx
  on admin_audit_logs (actor_user_id, created_at desc);
create index if not exists admin_audit_logs_created_idx
  on admin_audit_logs (created_at desc);

drop trigger if exists trg_generation_runs_updated_at on generation_runs;
create trigger trg_generation_runs_updated_at
  before update on generation_runs
  for each row execute function set_updated_at();

drop trigger if exists trg_report_quality_feedback_updated_at on report_quality_feedback;
create trigger trg_report_quality_feedback_updated_at
  before update on report_quality_feedback
  for each row execute function set_updated_at();

create or replace function record_generation_delivery(
  p_job_id text,
  p_kind text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_kind = 'download' then
    update generation_runs
      set download_count = download_count + 1,
          first_download_at = coalesce(first_download_at, now()),
          last_download_at = now()
      where job_id = p_job_id;
  elsif p_kind = 'preview' then
    update generation_runs
      set preview_count = preview_count + 1,
          first_preview_at = coalesce(first_preview_at, now()),
          last_preview_at = now()
      where job_id = p_job_id;
  else
    return false;
  end if;
  return found;
end;
$$;

create or replace function cleanup_product_telemetry()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_generation integer := 0;
  deleted_events integer := 0;
  deleted_feedback integer := 0;
  deleted_admin integer := 0;
  deleted_login integer := 0;
  deleted_api integer := 0;
begin
  delete from generation_runs where created_at < now() - interval '90 days';
  get diagnostics deleted_generation = row_count;
  delete from product_events where received_at < now() - interval '90 days';
  get diagnostics deleted_events = row_count;
  delete from report_quality_feedback where created_at < now() - interval '180 days';
  get diagnostics deleted_feedback = row_count;
  delete from admin_audit_logs where created_at < now() - interval '365 days';
  get diagnostics deleted_admin = row_count;
  delete from login_logs where created_at < now() - interval '30 days';
  get diagnostics deleted_login = row_count;

  if to_regclass('public.api_request_logs') is not null then
    execute 'delete from public.api_request_logs where created_at < now() - interval ''90 days''';
    get diagnostics deleted_api = row_count;
  end if;

  return jsonb_build_object(
    'generationRuns', deleted_generation,
    'productEvents', deleted_events,
    'qualityFeedback', deleted_feedback,
    'adminAudit', deleted_admin,
    'loginLogs', deleted_login,
    'apiRequestLogs', deleted_api
  );
end;
$$;

alter table login_logs enable row level security;
alter table generation_runs enable row level security;
alter table product_events enable row level security;
alter table report_quality_feedback enable row level security;
alter table privacy_consent_logs enable row level security;
alter table admin_audit_logs enable row level security;

revoke all on table login_logs, generation_runs, product_events,
  report_quality_feedback, privacy_consent_logs, admin_audit_logs
  from anon, authenticated;
grant select, insert, update, delete on table login_logs, generation_runs,
  product_events, report_quality_feedback, privacy_consent_logs, admin_audit_logs
  to service_role;
revoke all on function record_generation_delivery(text, text) from public, anon, authenticated;
grant execute on function record_generation_delivery(text, text) to service_role;
revoke all on function cleanup_product_telemetry() from public, anon, authenticated;
grant execute on function cleanup_product_telemetry() to service_role;
