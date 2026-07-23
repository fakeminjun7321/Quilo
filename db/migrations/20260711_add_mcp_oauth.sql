-- ChatGPT/remote MCP OAuth 2.1 (DCR + Authorization Code/PKCE) state.
-- Access tokens are stored in user_access_tokens, so the same scope checks apply
-- to REST and MCP calls. Authorization codes and refresh tokens are hash-only.

alter table user_access_tokens add column if not exists audience text;

create table if not exists mcp_oauth_clients (
  client_id text primary key,
  client_name text not null check (char_length(client_name) between 1 and 120),
  redirect_uris jsonb not null default '[]'::jsonb,
  grant_types jsonb not null default '["authorization_code","refresh_token"]'::jsonb,
  response_types jsonb not null default '["code"]'::jsonb,
  token_endpoint_auth_method text not null default 'none' check (token_endpoint_auth_method = 'none'),
  created_at timestamptz not null default now()
);

create table if not exists mcp_oauth_codes (
  code_hash text primary key check (char_length(code_hash) = 64),
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes jsonb not null default '[]'::jsonb,
  resource text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_codes_active_idx
  on mcp_oauth_codes (client_id, expires_at)
  where used_at is null;

create table if not exists mcp_oauth_refresh_tokens (
  token_hash text primary key check (char_length(token_hash) = 64),
  user_id uuid not null references users(id) on delete cascade,
  client_id text not null references mcp_oauth_clients(client_id) on delete cascade,
  scopes jsonb not null default '[]'::jsonb,
  resource text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_refresh_active_idx
  on mcp_oauth_refresh_tokens (client_id, expires_at)
  where revoked_at is null;

alter table mcp_oauth_clients enable row level security;
alter table mcp_oauth_codes enable row level security;
alter table mcp_oauth_refresh_tokens enable row level security;
revoke all on table mcp_oauth_clients, mcp_oauth_codes, mcp_oauth_refresh_tokens from anon, authenticated;
grant select, insert, update, delete on table mcp_oauth_clients, mcp_oauth_codes, mcp_oauth_refresh_tokens to service_role;
