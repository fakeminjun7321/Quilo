-- 학교 도입 신청 큐 (다른 학교가 Quilo 를 도입 신청).
-- 로그인 없이 외부 학교 담당자가 제출 → 관리자 페이지에서 검토/상태관리 + 이메일 알림.
-- 업로드한 학교 양식 파일은 school_application_files 에 base64 로 보관(저용량·저빈도라 충분).
-- Supabase Dashboard → SQL Editor 에 붙여넣고 Run. idempotent.
-- 서버는 이 테이블이 없으면 자동으로 이메일 알림만으로 graceful fallback 한다.

create table if not exists school_applications (
  id                  uuid primary key default gen_random_uuid(),
  school_name         text not null default '',
  school_type         text not null default '',            -- 영재학교/과학고/자사고/일반고/기타
  contact_name        text not null default '',
  contact_email       text not null default '',
  contact_phone       text not null default '',
  student_email_domain text not null default '',           -- 예: ts.hs.kr (학생 인증 게이팅용)
  student_id_scheme   text not null default '',            -- 학번 체계 설명
  desired_reports     text not null default '',            -- 추가하고 싶은 학교 전용 보고서 종류(자유 서술)
  desired_start       text not null default '',            -- 도입 희망 시기
  budget_note         text not null default '',            -- 예산/유료 의향
  message             text not null default '',            -- 자유 문의
  status              text not null default 'new',         -- new | reviewing | contacted | approved | rejected | archived
  admin_note          text not null default '',
  decided_by          uuid references users(id) on delete set null,
  decided_at          timestamptz,
  created_at          timestamptz not null default now()
);

create index if not exists school_applications_status_idx
  on school_applications (status, created_at desc);

create table if not exists school_application_files (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references school_applications(id) on delete cascade,
  filename       text not null default '',
  mime           text not null default '',
  size_bytes     integer not null default 0,
  data_base64    text not null default '',
  created_at     timestamptz not null default now()
);

create index if not exists school_application_files_app_idx
  on school_application_files (application_id);

alter table school_applications enable row level security;
alter table school_application_files enable row level security;
revoke all on table school_applications from anon, authenticated;
revoke all on table school_application_files from anon, authenticated;
grant select, insert, update, delete on table school_applications to service_role;
grant select, insert, update, delete on table school_application_files to service_role;
