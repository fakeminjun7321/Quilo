-- 사용자별 보고서 종류 접근 제한 (ACL)
-- blocked_report_types: 차단된 보고서 종류 key 배열 (예: ["chem-pre"]). 빈 배열 = 제한 없음.
-- 유효 key: chem-pre, chem-result, phys-result
--
-- 적용 전: 코드가 fail-open (컬럼 없으면 제한 없음으로 동작) — 미적용 상태에서도 앱은 정상.
-- 적용 후: 관리자 페이지 사용자 목록의 '보고서' 버튼으로 종류별 차단 가능.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS blocked_report_types jsonb NOT NULL DEFAULT '[]'::jsonb;
