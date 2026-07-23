-- 생성(비용 남용) 정지 — 시간당 API 비용이 등급 한도를 넘은 사용자를 정지시키고,
-- 커뮤니티 욕설 제재와 동일한 소명(community_appeals) 흐름으로 관리자가 검토·해제한다.
--
-- 적용: Supabase SQL 에디터에서 1회 실행. (community_banned_until 과 같은 패턴)

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS generation_banned_until timestamptz;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS generation_ban_reason text;

-- community_appeals.kind 에 'generation' 값을 함께 쓴다. 컬럼이 자유 텍스트면 추가 작업
-- 불필요. 혹시 CHECK 제약(kind in ('post','comment'))이 걸려 있으면 아래를 함께 실행:
--   ALTER TABLE community_appeals DROP CONSTRAINT IF EXISTS community_appeals_kind_check;
--   ALTER TABLE community_appeals ADD CONSTRAINT community_appeals_kind_check
--     CHECK (kind IN ('post','comment','generation'));
