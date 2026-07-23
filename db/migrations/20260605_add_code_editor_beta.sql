-- Quilo Code (코드 에디터) 베타 기능 시드
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run.
-- 선행 조건: 20260603_add_beta_features.sql (beta_features / beta_testers 테이블)
--
-- 관리자는 시드 없이도 /editor.html 사용 가능(코드에서 admin 면제). 이 시드는
-- 관리자 페이지 '베타 기능' 섹션에 'code-editor' 가 보이게 하고, 테스터를 지정하기 위함.

insert into beta_features (key, label, enabled)
values ('code-editor', 'Quilo Code (코드 에디터)', true)
on conflict (key) do nothing;
