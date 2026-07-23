-- 베타 기능 플래그 + 테스터 지정 (관리자탭에서 여러 베타를 동시에 운영)
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.

-- 베타 기능 목록 (key = 코드에서 쓰는 식별자, 예: 'pdf-translate')
create table if not exists beta_features (
  key text primary key,
  label text not null default '',
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

-- 기능별 허용 테스터 (지정된 사용자에게만 노출)
create table if not exists beta_testers (
  feature_key text not null references beta_features(key) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (feature_key, user_id)
);

create index if not exists beta_testers_user_idx on beta_testers (user_id);

-- service_role 키는 RLS 우회. anon 노출 방지를 위해 RLS 켜두고 공개 정책 없음.
alter table beta_features enable row level security;
alter table beta_testers enable row level security;

-- 시드: PDF 통번역 베타 (enabled=true; 테스터로 지정된 계정 + 관리자만 사용 가능)
insert into beta_features (key, label, enabled)
values ('pdf-translate', 'PDF 통번역', true)
on conflict (key) do nothing;
