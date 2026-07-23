-- BYOK: 사용자 본인 API 키 등록.
-- 등록된 제공자(anthropic/openai)의 AI 생성은 크레딧 차감 없이 본인 키로 실행된다
-- (등급 내 기능·모델 화이트리스트는 그대로 적용).
-- 키는 서버(lib/byok.js)에서 AES-256-GCM 으로 암호화되어 key_enc 에 저장된다 — 평문 저장 금지.
-- hint 는 표시용 끝 4자리만 보관한다.
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.

create table if not exists user_api_keys (
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('anthropic', 'openai')),
  key_enc text not null,
  hint text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

-- service_role 키는 RLS 우회. anon 노출 방지를 위해 RLS 켜두고 공개 정책 없음.
alter table user_api_keys enable row level security;
