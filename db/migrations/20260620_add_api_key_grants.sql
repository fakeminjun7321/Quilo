-- API 키 위임(grant): 관리자가 지정한 사용자에게 일정 기간 "관리자 키"로 무료 사용 권한 부여.
-- 효과 — 위임이 살아 있는 동안 그 사용자의 보고서 생성 + 파일 챗봇이
--        크레딧 차감 없이 서버(관리자) 키로 실행된다. (개인 키 저장은 하지 않는다.)
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.

create table if not exists api_key_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  expires_at timestamptz not null,
  note text not null default '',
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- 활성 위임 조회(user_id + 만료 안 됨 + 회수 안 됨)를 빠르게.
create index if not exists api_key_grants_user_idx
  on api_key_grants (user_id, expires_at);

-- service_role 키는 RLS 우회. anon 노출 방지를 위해 RLS 켜두고 공개 정책 없음.
alter table api_key_grants enable row level security;

-- 파일 챗봇 베타 플래그(관리자·위임 사용자 외에 테스터에게도 열 수 있게).
-- beta_features 테이블이 있어야 함(20260603_add_beta_features.sql 선행).
insert into beta_features (key, label, enabled)
values ('file-chat', '파일 챗봇', true)
on conflict (key) do nothing;
