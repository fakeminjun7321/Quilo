-- Classbot schema v4: one invite may be claimed once by Kakao and once by the
-- student web portal. The two channels retain independent one-time markers.

alter table public.classbot_invites
  add column if not exists portal_used_at timestamptz;

insert into public.classbot_schema_meta(id, version, applied_at)
values (1, 4, now())
on conflict (id) do update set version = excluded.version, applied_at = excluded.applied_at;
