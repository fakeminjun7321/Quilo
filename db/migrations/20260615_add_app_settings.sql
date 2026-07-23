-- 범용 앱 설정(KV) 테이블 — 관리자 페이지에서 설정하는 운영 값을 영구 보관.
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.
--
-- 적용 안 해도 동작함: 서버는 app_settings 가 없으면 in-memory 기본값을 쓴다
-- (예: 문제집 메이커 최대 문제 수 기본 120). 적용하면 재시작 후에도 값이 유지된다.
--
-- 현재 사용 키:
--   problem_set_max_problems  (jsonb number) — 문제집 메이커가 한 번에 만들 수 있는
--                                              최대 문제 수. 관리자는 면제.

create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_settings enable row level security;
revoke all on table public.app_settings from anon, authenticated;
grant select, insert, update, delete on table public.app_settings to service_role;
