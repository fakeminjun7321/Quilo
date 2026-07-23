import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = fs.readFileSync(path.resolve(here, "../../db/schema.sql"), "utf8");
const storeSource = fs.readFileSync(path.resolve(here, "supabase-store.js"), "utf8");

test("구성원 정원과 시간표 교체는 DB lock 기반 RPC로 원자화한다", () => {
  const memberFunction = schema.match(/create or replace function public\.classbot_create_member[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(memberFunction, /for update/);
  assert.match(memberFunction, /status <> 'left'/);
  assert.match(memberFunction, /selected_class\.max_members/);
  assert.match(storeSource, /\.rpc\("classbot_create_member"/);

  const timetableFunction = schema.match(/create or replace function public\.classbot_replace_timetable_day[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(timetableFunction, /for update/);
  assert.match(timetableFunction, /delete from public\.classbot_timetable/);
  assert.match(storeSource, /\.rpc\("classbot_replace_timetable_day"/);
});

test("초대 claim RPC와 단건 store 조작은 class_id scope를 사용한다", () => {
  const claimFunction = schema.match(/create or replace function public\.classbot_claim_invite[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(claimFunction, /class_id = p_class_id and code_hash/);
  assert.match(storeSource, /classbot_members"\)\.update\(allowed\)\.eq\("class_id", classroom\.id\)\.eq\("id", memberId\)/);
  assert.match(storeSource, /classbot_events"\)\.select\("\*"\)\.eq\("class_id", classroom\.id\)\.eq\("id", eventId\)/);
  assert.match(storeSource, /classbot_events"\)\.update\(allowed\)\.eq\("class_id", classroom\.id\)\.eq\("id", eventId\)/);
  assert.match(storeSource, /classbot_notifications"\)\.update\(changes\)\.eq\("class_id", classroom\.id\)/);
});

test("스키마 버전 health RPC와 전체 RLS가 운영 준비 상태를 검증한다", () => {
  assert.match(schema, /create table if not exists public\.classbot_schema_meta/);
  assert.match(schema, /create or replace function public\.classbot_health_check\(\)/);
  assert.match(schema, /grant execute on function public\.classbot_health_check\(\) to service_role/);
  assert.match(schema, /values \(1, 7, now\(\)\)/);
  for (const table of ["schema_meta", "classes", "members", "invites", "timetable", "member_timetable", "events", "notices", "files", "kakao_states", "kakao_pending_actions", "notifications", "audit_logs"]) {
    assert.match(schema, new RegExp(`alter table public\\.classbot_${table} enable row level security`));
  }
  assert.match(storeSource, /\.rpc\("classbot_health_check"\)/);
  assert.match(storeSource, /result\.error\.code === "23505"/);
});

test("개인별 시간표는 학급-구성원 복합 경계와 원자적 전체 교체 RPC를 사용한다", () => {
  assert.match(schema, /create table if not exists public\.classbot_member_timetable/);
  assert.match(schema, /foreign key \(class_id, member_id\)[\s\S]*references public\.classbot_members\(class_id, id\)/);
  assert.match(schema, /unique \(class_id, member_id, weekday, period, effective_from\)/);
  assert.match(schema, /classbot_member_timetable_lookup_idx/);
  const replaceFunction = schema.match(/create or replace function public\.classbot_replace_member_timetable[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(replaceFunction, /class_id = p_class_id[\s\S]*id = p_member_id[\s\S]*for update/);
  assert.match(replaceFunction, /delete from public\.classbot_member_timetable/);
  assert.match(storeSource, /\.rpc\("classbot_replace_member_timetable"/);
  assert.match(storeSource, /Number\(version\) !== 7/);
});

test("Quilo 포털 가입 RPC는 초대 코드와 불변 사용자 ID를 원자적으로 묶는다", () => {
  const claimFunction = schema.match(/create or replace function public\.classbot_claim_quilo_invite[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(claimFunction, /class_id = p_class_id[\s\S]*code_hash = p_code_hash[\s\S]*for update/);
  assert.match(claimFunction, /portal_used_at is not null/);
  assert.match(claimFunction, /quilo_user_id = trim\(p_quilo_user_id\)[\s\S]*id <> selected_invite\.member_id/);
  assert.match(claimFunction, /set quilo_user_id = trim\(p_quilo_user_id\)/);
  assert.match(schema, /drop function if exists public\.classbot_claim_member_by_name/);
  assert.match(storeSource, /\.rpc\("classbot_claim_quilo_invite"/);
});

test("카카오 파일 후보 상태는 구성원 경계·최대 3개·만료 시각과 RLS를 강제한다", () => {
  assert.match(schema, /create table if not exists public\.classbot_kakao_states/);
  assert.match(schema, /foreign key \(class_id, member_id\)[\s\S]*references public\.classbot_members\(class_id, id\)/);
  assert.match(schema, /cardinality\(pending_file_ids\) between 1 and 3/);
  assert.match(schema, /pending_expires_at timestamptz not null/);
  assert.match(storeSource, /from\("classbot_kakao_states"\)[\s\S]*pending_expires_at/);
});

test("카카오 일정 변경은 구성원별 10분 pending 상태와 작업 종류를 DB 경계에 둔다", () => {
  assert.match(schema, /create table if not exists public\.classbot_kakao_pending_actions/);
  assert.match(schema, /action text not null check \(action in \('create', 'update', 'complete', 'delete'\)\)/);
  assert.match(schema, /payload jsonb not null check \(jsonb_typeof\(payload\) = 'object'\)/);
  assert.match(schema, /foreign key \(class_id, member_id\)[\s\S]*references public\.classbot_members\(class_id, id\)/);
  assert.match(schema, /check \(\(action = 'create' and event_id is null\) or \(action <> 'create' and event_id is not null\)\)/);
  assert.match(storeSource, /from\("classbot_kakao_pending_actions"\)[\s\S]*expires_at/);
});

test("카카오와 학생 포털은 같은 초대 코드의 일회성 사용 상태를 채널별로 분리한다", () => {
  assert.match(schema, /portal_used_at timestamptz/);
  assert.match(storeSource, /update\(\{ portal_used_at: usedAt \}\)/);
  assert.match(storeSource, /\.is\("portal_used_at", null\)/);
});

test("자료실은 비공개 서버 경계와 대상별 별칭 중복 방지를 스키마에 둔다", () => {
  assert.match(schema, /create table if not exists public\.classbot_files/);
  assert.match(schema, /mime_type in \('application\/pdf', 'image\/jpeg', 'image\/png', 'image\/webp', 'image\/gif'\)/);
  assert.match(schema, /size_bytes between 1 and 20971520/);
  assert.match(schema, /classbot_files_class_alias_idx/);
  assert.match(schema, /classbot_files_member_alias_idx/);
  assert.match(storeSource, /storage\.createBucket\(FILE_BUCKET/);
  assert.match(storeSource, /public: false/);
});

test("개인 일정은 nullable member FK와 대상별 반 전체 포함 조회를 사용한다", () => {
  assert.match(schema, /classbot_events[\s\S]*member_id uuid references public\.classbot_members\(id\) on delete cascade/);
  assert.match(schema, /classbot_events_member_due_idx/);
  assert.match(storeSource, /targetMemberId[\s\S]*member_id\.is\.null,member_id\.eq/);
  assert.match(storeSource, /member_id: input\.member_id \|\| null/);
});

test("초기 명단 RPC는 학급 lock 뒤 구성원이 0명일 때만 invited로 일괄 생성한다", () => {
  const seedFunction = schema.match(/create or replace function public\.classbot_seed_members_if_empty[\s\S]*?\$\$;/)?.[0] || "";
  assert.match(seedFunction, /for update/);
  assert.match(seedFunction, /if exists \(select 1 from public\.classbot_members where class_id = p_class_id\)[\s\S]*return 0/);
  assert.match(seedFunction, /member_data\.role, 'invited'/);
  assert.match(storeSource, /\.rpc\("classbot_seed_members_if_empty"/);
});
