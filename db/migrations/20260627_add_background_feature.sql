-- 백그라운드 실행 구독 + 백그라운드 작업 영속화.
--
-- (1) background_subscriptions
--     관리자가 지정한 사용자에게 일정 기간 "백그라운드 실행" 권한을 부여한다.
--     백그라운드 실행 = 보고서를 제출한 뒤 탭/창을 닫아도 서버가 끝까지 생성하고,
--     '내 파일'과 완료 이메일로 받을 수 있는 기능. api_key_grants 와 동일한
--     기간 한정 per-user 권한 구조 — 나중에 월 결제 웹훅이 createBackgroundSub
--     ({ expiresAt: now + 30d }) 만 호출하면 그대로 구독제로 확장된다.
--
-- (2) report_jobs
--     백그라운드 보고서 작업의 상태를 영속화한다. id 는 서버 job.id(hex 문자열)와 같다.
--     재배포/재시작으로 in-memory job 이 사라져도 '내 작업'에서 진행/완료/중단을 추적할 수 있고,
--     부팅 시 reconcileRunningJobs() 가 이전 프로세스의 running 작업을 interrupted 로 정리한다.
--
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.

create table if not exists background_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  note text not null default '',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- 활성 구독 조회(user_id + 만료 안 됨 + 회수 안 됨)를 빠르게.
create index if not exists background_subscriptions_user_idx
  on background_subscriptions (user_id, expires_at);

-- service_role 키는 RLS 우회. anon/authenticated 직접 접근은 명시적으로 차단한다
-- (app_settings 마이그레이션과 동일한 패턴 — 백엔드 service_role 만 접근).
alter table background_subscriptions enable row level security;
revoke all on table background_subscriptions from anon, authenticated;
grant select, insert, update, delete on table background_subscriptions to service_role;

-- 백그라운드 작업 영속화. status: running | done | error | interrupted
create table if not exists report_jobs (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  report_type text not null default '',
  model text not null default '',
  status text not null default 'running',
  filename text,
  file_id uuid,                              -- report_files.id (있으면 파일함에서 다운로드)
  error text,
  progress jsonb not null default '[]'::jsonb,
  background boolean not null default true,
  notify_email boolean not null default false,
  notified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- '내 작업' 목록(최근순) 조회를 빠르게.
create index if not exists report_jobs_user_idx
  on report_jobs (user_id, created_at desc);

alter table report_jobs enable row level security;
revoke all on table report_jobs from anon, authenticated;
grant select, insert, update, delete on table report_jobs to service_role;
