-- 커뮤니티를 일반 게시판으로 전환하면서 새 글 분류를 확장한다.
-- 기존 feature/suggestion 글은 고객센터의 읽기 전용 이전 요청 보관함에서
-- 계속 보여야 하므로 저장된 레거시 값도 CHECK 허용 목록에 남긴다.

do $$
declare
  old_constraint record;
begin
  -- 초기 community_posts 마이그레이션의 CHECK 이름이 환경마다 달랐을 수 있다.
  -- category에 feature/suggestion만 허용하던 레거시 CHECK만 골라 제거하고,
  -- 다른 무관한 CHECK 또는 이미 확장된 CHECK는 건드리지 않는다.
  for old_constraint in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'community_posts'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%category%'
      and pg_get_constraintdef(con.oid) ilike '%feature%'
      and pg_get_constraintdef(con.oid) ilike '%suggestion%'
      and pg_get_constraintdef(con.oid) not ilike '%general%'
      and pg_get_constraintdef(con.oid) not ilike '%question%'
      and pg_get_constraintdef(con.oid) not ilike '%tip%'
      and pg_get_constraintdef(con.oid) not ilike '%showcase%'
  loop
    execute format(
      'alter table public.community_posts drop constraint %I',
      old_constraint.conname
    );
  end loop;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'community_posts'
      and con.conname = 'community_posts_category_check'
  ) then
    alter table public.community_posts
      add constraint community_posts_category_check
      check (
        category in (
          'general',
          'question',
          'tip',
          'showcase',
          'feature',
          'suggestion'
        )
      ) not valid;
  end if;
end;
$$;

-- NOT VALID로 잠금 시간을 줄여 추가한 뒤, 현재 데이터까지 명시적으로 검증한다.
alter table public.community_posts
  validate constraint community_posts_category_check;
