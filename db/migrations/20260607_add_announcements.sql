-- 상단 공지 티커용 공지사항 테이블.
-- 적용 전에는 서버가 메모리에 임시 보관(재시작 시 초기화). 적용하면 영구 저장.

create table if not exists announcements (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    text not null default '공지',
  link        text default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists announcements_active_created_idx
  on announcements (active, created_at desc);
