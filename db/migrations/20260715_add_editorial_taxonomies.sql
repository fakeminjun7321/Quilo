-- Quilo 개발 노트·자료실의 관리자 관리형 주제/분류.
-- 기존 editorial_posts.category/tags는 문자열 그대로 유지하고, 이 테이블은 편집기에서
-- 선택할 수 있는 활성 어휘 목록을 제공한다. 따라서 과거 글을 깨뜨리는 FK는 두지 않는다.

create table if not exists public.editorial_taxonomies (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('developer', 'resource')),
  type text not null check (type in ('category', 'topic')),
  slug text not null,
  name text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editorial_taxonomies_slug_length check (char_length(slug) between 1 and 80),
  constraint editorial_taxonomies_slug_shape check (
    slug = btrim(slug)
    and slug !~ '[[:space:]/?#]'
    and slug not like '-%'
    and slug not like '%-'
    and slug not like '%--%'
  ),
  constraint editorial_taxonomies_name_length check (char_length(name) between 1 and 60),
  constraint editorial_taxonomies_name_shape check (name = btrim(name) and name !~ '[[:cntrl:]]'),
  constraint editorial_taxonomies_sort_order check (sort_order between -100000 and 100000)
);

create unique index if not exists editorial_taxonomies_slug_lower_key
  on public.editorial_taxonomies (kind, type, lower(slug));
create unique index if not exists editorial_taxonomies_name_lower_key
  on public.editorial_taxonomies (kind, type, lower(name));
create index if not exists editorial_taxonomies_public_idx
  on public.editorial_taxonomies (kind, type, sort_order, lower(name))
  where is_active = true;

drop trigger if exists trg_editorial_taxonomies_updated_at on public.editorial_taxonomies;
create trigger trg_editorial_taxonomies_updated_at
  before update on public.editorial_taxonomies
  for each row execute function public.set_updated_at();

alter table public.editorial_taxonomies enable row level security;
revoke all on table public.editorial_taxonomies from anon, authenticated;
grant select, insert, update, delete on table public.editorial_taxonomies to service_role;

-- 첫 배포부터 빈 관리 화면이 되지 않도록 현재 Quilo 정보 구조를 기본 어휘로 넣는다.
-- 관리자는 배포 후 이름·순서·활성 상태를 자유롭게 바꿀 수 있다.
insert into public.editorial_taxonomies (kind, type, slug, name, sort_order, is_active)
values
  ('developer', 'category', 'quilo-usage', 'Quilo 활용', 10, true),
  ('developer', 'category', 'development', '개발', 20, true),
  ('developer', 'category', 'report-writing', '보고서 작성', 30, true),
  ('developer', 'category', 'news', '새 소식', 40, true),
  ('developer', 'topic', 'getting-started', '시작하기', 10, true),
  ('developer', 'topic', 'document-engine', '문서 엔진', 20, true),
  ('developer', 'topic', 'data-trust', '데이터 신뢰성', 30, true),
  ('developer', 'topic', 'api', 'API', 40, true),
  ('developer', 'topic', 'operations', '운영', 50, true),
  ('resource', 'category', 'chemistry', '화학', 10, true),
  ('resource', 'category', 'physics', '물리', 20, true),
  ('resource', 'category', 'report-templates', '보고서 양식', 30, true),
  ('resource', 'category', 'learning-materials', '학습 자료', 40, true),
  ('resource', 'category', 'tools', '도구', 50, true),
  ('resource', 'topic', 'experiment-data', '실험 데이터', 10, true),
  ('resource', 'topic', 'document-templates', '문서 템플릿', 20, true),
  ('resource', 'topic', 'reference-material', '참고 자료', 30, true)
on conflict do nothing;

-- 기존 글의 고정 category/tag 값을 관리 화면에 즉시 나타낸다. 이름은 그대로 보존하고,
-- 안정적인 legacy slug만 생성한다. 이후 관리자가 읽기 좋은 slug로 바꿀 수 있다.
insert into public.editorial_taxonomies (kind, type, slug, name, sort_order, is_active)
select distinct
  p.kind,
  'category',
  'legacy-' || substr(md5(p.kind || E'\x1fcategory\x1f' || btrim(p.category)), 1, 16),
  btrim(p.category),
  1000,
  true
from public.editorial_posts p
where p.kind in ('developer', 'resource') and btrim(coalesce(p.category, '')) <> ''
on conflict do nothing;

insert into public.editorial_taxonomies (kind, type, slug, name, sort_order, is_active)
select distinct
  p.kind,
  'topic',
  'legacy-' || substr(md5(p.kind || E'\x1ftopic\x1f' || btrim(tag.value)), 1, 16),
  btrim(tag.value),
  1000,
  true
from public.editorial_posts p
cross join lateral unnest(coalesce(p.tags, '{}'::text[])) as tag(value)
where p.kind in ('developer', 'resource') and btrim(coalesce(tag.value, '')) <> ''
on conflict do nothing;

-- 여러 항목의 순서를 한 트랜잭션에서 바꾼다. 앱 라우터가 관리자 인증과 입력 검증을
-- 선행하며, 함수도 중복/누락 ID를 거부해 부분 업데이트를 남기지 않는다.
create or replace function public.reorder_editorial_taxonomies(
  p_items jsonb,
  p_updated_by uuid default null
)
returns setof public.editorial_taxonomies
language plpgsql
set search_path = public
as $$
declare
  expected_count integer;
  matched_count integer;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'taxonomy_items_must_be_array' using errcode = '22023';
  end if;
  expected_count := jsonb_array_length(p_items);
  if expected_count < 1 or expected_count > 200 then
    raise exception 'taxonomy_items_count_invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(id uuid, sort_order integer)
    group by x.id
    having count(*) > 1
  ) then
    raise exception 'taxonomy_items_duplicate_id' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as x(id uuid, sort_order integer)
    where x.id is null or x.sort_order is null or x.sort_order < -100000 or x.sort_order > 100000
  ) then
    raise exception 'taxonomy_items_invalid' using errcode = '22023';
  end if;

  select count(*) into matched_count
  from public.editorial_taxonomies t
  join jsonb_to_recordset(p_items) as x(id uuid, sort_order integer) on x.id = t.id;
  if matched_count <> expected_count then
    raise exception 'taxonomy_not_found' using errcode = 'P0002';
  end if;

  return query
  update public.editorial_taxonomies t
  set sort_order = x.sort_order,
      updated_by = p_updated_by
  from jsonb_to_recordset(p_items) as x(id uuid, sort_order integer)
  where t.id = x.id
  returning t.*;
end;
$$;

revoke all on function public.reorder_editorial_taxonomies(jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.reorder_editorial_taxonomies(jsonb, uuid)
  to service_role;

-- 사용 중인 문자열 분류를 지우면 과거 게시글의 필터 선택지가 사라질 수 있으므로,
-- 게시글 쓰기와 경합하지 않도록 한 트랜잭션에서 사용량을 확인한다. 사용 중이면
-- hard delete 대신 비활성화하고, 미사용 항목만 실제 삭제한다.
create or replace function public.delete_editorial_taxonomy_safely(
  p_id uuid,
  p_updated_by uuid default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  target public.editorial_taxonomies%rowtype;
  changed public.editorial_taxonomies%rowtype;
  usage_count bigint;
begin
  select * into target
  from public.editorial_taxonomies
  where id = p_id
  for update;

  if not found then
    raise exception 'taxonomy_not_found' using errcode = 'P0002';
  end if;

  -- editorial_posts의 insert/update/delete와 잠시 직렬화해 count와 결정 사이의
  -- 경쟁 조건을 막는다. 문자열 기반 레거시 필드는 그대로 유지한다.
  lock table public.editorial_posts in share mode;
  if target.type = 'category' then
    select count(*) into usage_count
    from public.editorial_posts p
    where p.kind = target.kind and p.category = target.name;
  else
    select count(*) into usage_count
    from public.editorial_posts p
    where p.kind = target.kind and p.tags @> array[target.name]::text[];
  end if;

  if usage_count > 0 then
    update public.editorial_taxonomies
    set is_active = false,
        updated_by = p_updated_by
    where id = p_id
    returning * into changed;

    return jsonb_build_object(
      'taxonomy', to_jsonb(changed),
      'deleted', false,
      'deactivated', true,
      'inUseCount', usage_count
    );
  end if;

  delete from public.editorial_taxonomies
  where id = p_id
  returning * into changed;

  return jsonb_build_object(
    'taxonomy', to_jsonb(changed),
    'deleted', true,
    'deactivated', false,
    'inUseCount', 0
  );
end;
$$;

revoke all on function public.delete_editorial_taxonomy_safely(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_editorial_taxonomy_safely(uuid, uuid)
  to service_role;
