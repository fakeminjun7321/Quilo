-- 프리미엄(백그라운드 실행) 입금 신청 큐.
-- 자동결제 없이: 사용자가 입금 후 '신청' → 관리자가 입금 확인하고 '승인'하면
-- 즉시 background_subscriptions 에 구독이 부여된다(period_days 만큼, 활성이면 연장).
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.

create table if not exists premium_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  depositor_name text not null default '',
  amount integer,
  period_days integer not null default 30,
  status text not null default 'pending',   -- pending | approved | rejected
  note text not null default '',
  decided_by uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- 대기 신청 목록(최근순) 조회를 빠르게.
create index if not exists premium_requests_status_idx
  on premium_requests (status, created_at desc);

alter table premium_requests enable row level security;
revoke all on table premium_requests from anon, authenticated;
grant select, insert, update, delete on table premium_requests to service_role;
