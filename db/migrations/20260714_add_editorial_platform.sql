-- Quilo 개발 노트 · 자료실 · 자료 요청 · 공개 프로필 데이터 계층.
--
-- 애플리케이션은 service_role 클라이언트만 이 테이블에 접근하고, 공개 읽기도
-- Express 라우터를 통해 status/소유권을 확인한 뒤 제공한다. Supabase anon/authenticated
-- 역할에 직접 정책을 열지 않는다.

alter table public.users
  add column if not exists is_staff boolean not null default false,
  add column if not exists is_developer boolean not null default false,
  add column if not exists avatar_url text,
  add column if not exists profile_bio text not null default '';

-- 기존 관리자는 운영 연속성을 위해 모두 개발 노트 작성 권한을 갖는다. 이름이
-- '구민준'인 기존 계정도 명시적으로 백필한다(표시 이름 양끝 공백은 무시).
update public.users
set is_developer = true
where is_admin = true or btrim(name) = '구민준';

create table if not exists public.editorial_posts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('developer', 'resource')),
  slug text not null,
  title text not null,
  excerpt text not null default '',
  rich_html text not null default '',
  cover_image text,
  category text not null default '',
  tags text[] not null default '{}'::text[],
  status text not null default 'draft' check (status in ('draft', 'published')),
  author_id uuid not null references public.users(id) on delete restrict,
  author_name text not null default '',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint editorial_posts_title_length check (char_length(title) between 1 and 180),
  constraint editorial_posts_excerpt_length check (char_length(excerpt) <= 600),
  constraint editorial_posts_slug_length check (char_length(slug) between 1 and 120),
  constraint editorial_posts_publish_time check (
    (status = 'draft') or (status = 'published' and published_at is not null)
  )
);

create unique index if not exists editorial_posts_slug_lower_key
  on public.editorial_posts (lower(slug));
create index if not exists editorial_posts_public_idx
  on public.editorial_posts (kind, published_at desc)
  where status = 'published';
create index if not exists editorial_posts_author_idx
  on public.editorial_posts (author_id, updated_at desc);
create index if not exists editorial_posts_tags_idx
  on public.editorial_posts using gin (tags);

create table if not exists public.editorial_attachments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.editorial_posts(id) on delete cascade,
  uploaded_by uuid not null references public.users(id) on delete restrict,
  filename text not null,
  mime_type text not null,
  size_bytes integer not null,
  data_base64 text not null,
  created_at timestamptz not null default now(),
  constraint editorial_attachments_size check (size_bytes between 1 and 8388608),
  constraint editorial_attachments_filename check (char_length(filename) between 1 and 180),
  constraint editorial_attachments_base64_length check (char_length(data_base64) <= 11184812)
);

create index if not exists editorial_attachments_post_idx
  on public.editorial_attachments (post_id, created_at asc);

create table if not exists public.resource_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  author_name text not null default '',
  title text not null,
  details text not null default '',
  category text not null default '',
  status text not null default 'open'
    check (status in ('open', 'reviewing', 'planned', 'fulfilled', 'declined')),
  staff_note text not null default '',
  linked_post_id uuid references public.editorial_posts(id) on delete set null,
  handled_by uuid references public.users(id) on delete set null,
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resource_requests_title_length check (char_length(title) between 1 and 180),
  constraint resource_requests_details_length check (char_length(details) <= 5000)
);

create index if not exists resource_requests_public_idx
  on public.resource_requests (status, created_at desc);
create index if not exists resource_requests_user_idx
  on public.resource_requests (user_id, created_at desc);

-- db/schema.sql 의 공통 set_updated_at() 함수를 재사용한다.
drop trigger if exists trg_editorial_posts_updated_at on public.editorial_posts;
create trigger trg_editorial_posts_updated_at
  before update on public.editorial_posts
  for each row execute function public.set_updated_at();

drop trigger if exists trg_resource_requests_updated_at on public.resource_requests;
create trigger trg_resource_requests_updated_at
  before update on public.resource_requests
  for each row execute function public.set_updated_at();

alter table public.editorial_posts enable row level security;
alter table public.editorial_attachments enable row level security;
alter table public.resource_requests enable row level security;

revoke all on table
  public.editorial_posts,
  public.editorial_attachments,
  public.resource_requests
from anon, authenticated;

grant select, insert, update, delete on table
  public.editorial_posts,
  public.editorial_attachments,
  public.resource_requests
to service_role;

-- 프로필 이미지는 서버가 검증·리사이즈한 뒤 WebP로만 기록한다. 브라우저가 공개 URL로
-- 표시할 수 있어야 하므로 이 버킷만 public이며, 쓰기/삭제는 service_role 서버가 담당한다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-images',
  'profile-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
