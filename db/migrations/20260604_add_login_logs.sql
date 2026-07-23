-- 로그인 기록 테이블 (관리자 전용 — AI 관리자 보조가 읽음)
-- Supabase Dashboard → SQL Editor에 붙여넣고 Run.

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
