-- H1 (보안): 아티팩트 소유권을 '표시명(owner=users.name, 중복 가능)' 이 아니라
-- 불변 user id(owner_id) 로 키잉한다. 표시명 충돌만으로 타인의 비공개 아티팩트를
-- 읽기/덮어쓰기/삭제할 수 있던 IDOR 를 닫는다.
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run. idempotent(여러 번 실행 안전).
-- 코드는 owner_id 없는 레거시 행을 일반 사용자에게 귀속하지 않는다. 모호한 행은
-- 관리자만 처리할 수 있으므로, 이 마이그레이션을 운영 배포 전에 반드시 적용한다.

alter table artifacts add column if not exists owner_id uuid;
create index if not exists artifacts_owner_id_idx on artifacts (owner_id);

-- 기존 행 backfill: owner(표시명)이 '유일하게' 매칭되는 사용자일 때만 안전하게 연결한다.
-- (표시명이 중복인 행은 모호하므로 null 로 남겨 두고 관리자 검토 대상으로 둔다.)
update artifacts a
   set owner_id = u.id
  from users u
 where a.owner_id is null
   and a.owner = u.name
   and (select count(*) from users u2 where u2.name = a.owner) = 1;

-- 기존의 모호한 null 행은 보존하되 새 행은 반드시 불변 사용자 ID를 가져야 한다.
-- NOT VALID 제약은 기존 행 검증을 미루면서도 이후 INSERT/UPDATE에는 즉시 적용된다.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'artifacts_owner_id_required'
       and conrelid = 'public.artifacts'::regclass
  ) then
    alter table public.artifacts
      add constraint artifacts_owner_id_required
      check (owner_id is not null) not valid;
  end if;
end $$;
