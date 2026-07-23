alter table users
  add column if not exists student_id text not null default '';
