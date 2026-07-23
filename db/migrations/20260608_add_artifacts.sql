-- 창작(만들기) 플랫폼 — 아티팩트 저장소
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.
-- 모두 idempotent(IF NOT EXISTS) 라 여러 번 실행해도 안전합니다.
-- 이 테이블이 없으면 서버는 자동으로 '메모리 fallback' 으로 동작합니다(재시작 시 소실).
-- 영구 저장을 원하면 아래를 실행하세요.

-- 1) 아티팩트 본체 ----------------------------------------------------------
create table if not exists artifacts (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null default '',
  html        text not null default '',
  is_public   boolean not null default true,
  owner       text,
  category    text not null default '기타',
  likes       integer not null default 0,
  views       integer not null default 0,
  forked_from text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- 이전 버전 테이블이 있던 경우 누락 컬럼 보강(소셜/리믹스용)
alter table artifacts add column if not exists category    text not null default '기타';
alter table artifacts add column if not exists likes       integer not null default 0;
alter table artifacts add column if not exists views       integer not null default 0;
alter table artifacts add column if not exists forked_from text;
create index if not exists artifacts_public_idx on artifacts (is_public, updated_at desc);

-- 2) 공유 KV (QuiloDB: 투표·방명록·랭킹·세이브) -----------------------------
create table if not exists artifact_kv (
  slug       text not null,
  k          text not null,
  v          jsonb,
  updated_at timestamptz not null default now(),
  primary key (slug, k)
);

-- 3) 신고 -------------------------------------------------------------------
create table if not exists artifact_reports (
  id     bigint generated always as identity primary key,
  slug   text not null,
  reason text,
  at     timestamptz not null default now()
);

-- 4) 댓글 -------------------------------------------------------------------
create table if not exists artifact_comments (
  id     uuid primary key default gen_random_uuid(),
  slug   text not null,
  author text,
  text   text not null default '',
  at     timestamptz not null default now()
);
create index if not exists artifact_comments_slug_idx on artifact_comments (slug, at);

-- 5) 'create'(창작) 베타 기능 시드 ------------------------------------------
--    선행: 20260603_add_beta_features.sql. 서버 부팅 시 자동 등록도 되지만 명시.
insert into beta_features (key, label, enabled)
values ('create', '창작(만들기)', true)
on conflict (key) do nothing;

-- 6) 미디어 스토리지 버킷 'artifact-media'
--    서버가 자동 생성(public)하지만, 수동 생성 시:
--    Storage → New bucket → name: artifact-media, Public: ON
--
-- 참고: 위 테이블들은 service-role 키로만 접근하므로(RLS 우회) 별도 RLS 정책 불필요.
