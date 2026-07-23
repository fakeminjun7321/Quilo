-- Quilo 개발자 플랫폼: 서명 Webhook endpoint 및 전송 기록.

create table if not exists api_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  url text not null,
  description text not null default '',
  events jsonb not null default '["job.completed"]'::jsonb,
  secret_ciphertext text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, url)
);

create index if not exists api_webhook_endpoints_user_enabled_idx
  on api_webhook_endpoints (user_id, created_at desc)
  where enabled = true;

create table if not exists api_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references api_webhook_endpoints(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  event text not null,
  event_id text not null unique,
  status text not null check (status in ('delivered', 'failed')),
  attempt_count integer not null default 1 check (attempt_count between 1 and 3),
  response_status integer,
  error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists api_webhook_deliveries_user_created_idx
  on api_webhook_deliveries (user_id, created_at desc);
create index if not exists api_webhook_deliveries_endpoint_created_idx
  on api_webhook_deliveries (endpoint_id, created_at desc);

alter table api_webhook_endpoints enable row level security;
alter table api_webhook_deliveries enable row level security;
revoke all on table api_webhook_endpoints, api_webhook_deliveries from anon, authenticated;
grant select, insert, update, delete on table api_webhook_endpoints, api_webhook_deliveries to service_role;
