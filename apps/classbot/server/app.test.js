import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { hashInviteCode } from "./security.js";
import { createFileToken } from "./services/file-tokens.js";
import { MemoryStore } from "./store/memory-store.js";

const config = {
  nodeEnv: "test",
  production: false,
  port: 0,
  allowedOrigin: "http://localhost:5173",
  sessionSecret: "test-session-secret-that-is-long-enough",
  adminPassword: "correct horse battery staple",
  cronSecret: "cron-test-secret",
  kakaoSkillSecret: "",
  storage: "memory",
  classCode: "2-4",
  className: "2학년 4반",
  timezone: "Asia/Seoul",
  kakao: { enabled: false, botId: "", restApiKey: "", eventName: "quilo_schedule_notification", apiBase: "https://bot-api.kakao.com" },
};

async function fixture() {
  const store = new MemoryStore(config);
  const app = await createApp({
    config,
    store,
    now: () => new Date("2026-07-15T03:00:00.000Z"),
  });
  return { app, store, agent: request.agent(app) };
}

async function login(agent) {
  const response = await agent.post("/api/admin/login").send({ password: config.adminPassword });
  assert.equal(response.status, 200);
}

async function issuePortalInvite(store, member, code = "ABCD-EFGH") {
  await store.createInvite({
    memberId: member.id,
    codeHash: hashInviteCode(code),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  return code;
}

async function loginPortal(agent, store, member, code = "ABCD-EFGH") {
  await issuePortalInvite(store, member, code);
  return agent.post("/api/portal/login").send({ display_name: member.display_name, invite_code: code });
}

test("관리자 세션이 보호되고 로그인 후 overview를 조회한다", async () => {
  const { app, agent } = await fixture();
  assert.equal((await request(app).get("/api/admin/overview")).status, 401);
  assert.equal((await agent.post("/api/admin/login").send({ password: "wrong-password" })).status, 401);
  await login(agent);
  const response = await agent.get("/api/admin/overview");
  assert.equal(response.status, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.match(response.headers["content-security-policy"], /default-src 'self'/);
  assert.doesNotMatch(response.headers["content-security-policy"], /upgrade-insecure-requests/);
  assert.equal(response.body.classroom.name, "2학년 4반");
  assert.equal(response.body.stats.memberCount, 13);
  assert.equal(Array.isArray(response.body.notices), true);
});

test("학생 포털은 초대 코드로 최초 로그인하고 HMAC 쿠키 세션을 유지·해제한다", async () => {
  const { app, store } = await fixture();
  const member = (await store.listMembers()).find((item) => item.role === "student");
  const code = await issuePortalInvite(store, member);

  const anonymous = await request(app).get("/api/portal/session");
  assert.deepEqual(anonymous.body, { authenticated: false });
  assert.equal((await request(app).get("/api/portal/overview")).status, 401);
  assert.equal((await request(app).get("/api/portal/files")).status, 401);

  const wrongCase = await request(app)
    .post("/api/portal/login")
    .send({ display_name: `${member.display_name}님`, invite_code: code });
  assert.equal(wrongCase.status, 401);
  assert.equal(wrongCase.body.error, "이름을 확인할 수 없습니다.");

  const agent = request.agent(app);
  const response = await agent
    .post("/api/portal/login")
    .send({ display_name: member.display_name, invite_code: code });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.member, { id: member.id, display_name: member.display_name, role: "student" });
  const cookie = response.headers["set-cookie"].find((item) => item.startsWith("classbot_portal="));
  assert.match(cookie, /; Path=\/;/);
  assert.match(cookie, /; HttpOnly/);
  assert.match(cookie, /; SameSite=Lax/);
  assert.doesNotMatch(cookie, /; Secure/);

  const session = await agent.get("/api/portal/session");
  assert.deepEqual(session.body, { authenticated: true, member: response.body.member });
  const reused = await request(app)
    .post("/api/portal/login")
    .send({ display_name: member.display_name, invite_code: code });
  assert.equal(reused.status, 401);
  assert.equal(reused.body.error, wrongCase.body.error);

  assert.equal((await agent.post("/api/portal/logout")).status, 200);
  assert.deepEqual((await agent.get("/api/portal/session")).body, { authenticated: false });
});

test("같은 초대 코드는 카카오와 웹 포털에서 채널별로 한 번씩 사용할 수 있다", async () => {
  const { app, store } = await fixture();
  const [first, second] = (await store.listMembers()).filter((item) => item.role === "student").slice(0, 2);

  const portalFirstCode = await issuePortalInvite(store, first, "PORT-AL01");
  assert.equal((await request(app).post("/api/portal/login").send({ display_name: first.display_name, invite_code: portalFirstCode })).status, 200);
  const kakaoAfterPortal = await store.claimInvite({ code: portalFirstCode, userKey: "kakao-after-portal" });
  assert.equal(kakaoAfterPortal.id, first.id);
  await assert.rejects(() => store.claimInvite({ code: portalFirstCode, userKey: "kakao-reuse" }), /올바르지 않거나 만료/);

  const kakaoFirstCode = await issuePortalInvite(store, second, "KAKA-O001");
  const kakaoFirst = await store.claimInvite({ code: kakaoFirstCode, userKey: "kakao-before-portal" });
  assert.equal(kakaoFirst.id, second.id);
  assert.equal((await request(app).post("/api/portal/login").send({ display_name: second.display_name, invite_code: kakaoFirstCode })).status, 200);
  assert.equal((await request(app).post("/api/portal/login").send({ display_name: second.display_name, invite_code: kakaoFirstCode })).status, 401);
});

test("학생 포털 로그인 실패는 이름 사칭·중복·비활성 여부를 같은 오류로 숨기고 요청 횟수를 제한한다", async () => {
  const { app, store } = await fixture();
  const members = await store.listMembers();
  const first = members.find((item) => item.role === "student");
  const second = members.find((item) => item.role === "student" && item.id !== first.id);
  const code = await issuePortalInvite(store, first, "JKLM-NPQR");

  const impersonation = await request(app)
    .post("/api/portal/login")
    .send({ display_name: second.display_name, invite_code: code });
  assert.equal(impersonation.status, 401);
  assert.deepEqual(impersonation.body, { error: "이름을 확인할 수 없습니다." });
  assert.equal(JSON.stringify(impersonation.body).includes(first.display_name), false);
  assert.equal(JSON.stringify(impersonation.body).includes(second.display_name), false);

  store.members.find((item) => item.id === second.id).display_name = first.display_name;
  const duplicate = await request(app)
    .post("/api/portal/login")
    .send({ display_name: first.display_name, invite_code: code });
  assert.equal(duplicate.status, 401);
  assert.deepEqual(duplicate.body, impersonation.body);

  const limitedFixture = await fixture();
  for (let index = 0; index < 10; index += 1) {
    const failed = await request(limitedFixture.app)
      .post("/api/portal/login")
      .send({ display_name: `없는 학생 ${index}`, invite_code: "BAD-CODE" });
    assert.equal(failed.status, 401);
  }
  const limited = await request(limitedFixture.app)
    .post("/api/portal/login")
    .send({ display_name: "없는 학생", invite_code: "BAD-CODE" });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /로그인 시도가 너무 많습니다/);
  assert.equal(JSON.stringify(limited.body).includes("학생 1"), false);
});

test("학생 포털 overview는 반 전체와 본인 일정·게시 공지만 반환하고 구성원별 시간표 adapter를 사용한다", async () => {
  const { app, store } = await fixture();
  const students = (await store.listMembers()).filter((item) => item.role === "student");
  const member = students[0];
  const other = students[1];
  await store.createEvent({ category: "class", title: "반 전체 행사", due_at: "2026-07-20T10:00:00" });
  await store.createEvent({ member_id: member.id, category: "assignment", title: "내 개인 일정", due_at: "2026-07-21T10:00:00" });
  await store.createEvent({ member_id: other.id, category: "assignment", title: "다른 학생 비밀 일정", due_at: "2026-07-22T10:00:00" });
  await store.createNotice({ title: "초안 공지", body: "노출 금지", status: "draft" });
  let timetableOptions;
  store.listMemberTimetable = async (memberId, options) => {
    timetableOptions = options;
    return [{ period: 1, subject: "개인 선택", member_id: memberId }];
  };

  const agent = request.agent(app);
  assert.equal((await loginPortal(agent, store, member)).status, 200);
  const response = await agent.get("/api/portal/overview?from=2026-07-20&to=2026-07-22");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.member, { id: member.id, display_name: member.display_name, role: "student" });
  assert.deepEqual(response.body.timetable, [{ period: 1, subject: "개인 선택", member_id: member.id }]);
  assert.equal(timetableOptions.date, "2026-07-19T15:00:00.000Z");
  const titles = response.body.events.map((item) => item.title);
  assert.equal(titles.includes("반 전체 행사"), true);
  assert.equal(titles.includes("내 개인 일정"), true);
  assert.equal(titles.includes("다른 학생 비밀 일정"), false);
  assert.equal(response.body.notices.every((item) => item.status === "published"), true);
  assert.equal(response.body.notices.some((item) => item.title === "초안 공지"), false);
  assert.equal((await agent.get("/api/portal/overview?from=2026-07-23&to=2026-07-20")).status, 400);
  assert.equal((await agent.get("/api/portal/overview?from=not-a-date")).status, 400);
});

test("관리자 API는 구성원 개인 시간표를 조회하고 원자적으로 교체한다", async () => {
  const { app, agent, store } = await fixture();
  const member = (await store.listMembers()).find((item) => item.role === "student");
  await login(agent);
  const saved = await agent.put(`/api/admin/members/${member.id}/timetable`).send({ rows: [{
    weekday: 1,
    period: 1,
    subject: "개인 선택 과목",
    teacher: "담당 교사",
    room: "선택 강의실",
    effective_from: "2026-08-01",
  }] });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.items[0].member_id, member.id);
  const listed = await agent.get(`/api/admin/members/${member.id}/timetable?weekday=1&date=2026-08-01`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].subject, "개인 선택 과목");
  assert.equal((await request(app).put(`/api/admin/members/${member.id}/timetable`).send({ rows: [] })).status, 401);
  assert.equal((await agent.put(`/api/admin/members/${member.id}/timetable`).send({ rows: "invalid" })).status, 400);
});

test("학생 포털 파일 목록은 반 전체와 본인 자료만 15분 열기·다운로드 URL로 제공한다", async () => {
  const { app, store } = await fixture();
  const students = (await store.listMembers()).filter((item) => item.role === "student");
  const member = students[0];
  const classFile = await store.createFile({
    alias: "반 전체 안내",
    filename: "guide.pdf",
    description: "공개 자료",
    mime_type: "application/pdf",
  }, Buffer.from("%PDF-1.4\n%%EOF"));
  const privateFile = await store.createFile({
    member_id: member.id,
    alias: "개인 비밀 자료",
    filename: "private.pdf",
    description: "노출 금지",
    mime_type: "application/pdf",
  }, Buffer.from("%PDF-1.4\nprivate\n%%EOF"));
  const otherPrivateFile = await store.createFile({
    member_id: students[1].id,
    alias: "다른 학생 비밀 자료",
    filename: "other-private.pdf",
    description: "다른 학생에게만 공개",
    mime_type: "application/pdf",
  }, Buffer.from("%PDF-1.4\nother-private\n%%EOF"));

  const agent = request.agent(app);
  assert.equal((await loginPortal(agent, store, member)).status, 200);
  const response = await agent.get("/api/portal/files");
  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  const item = response.body.items.find((entry) => entry.id === classFile.id);
  const personalItem = response.body.items.find((entry) => entry.id === privateFile.id);
  assert.equal(personalItem.member_id, member.id);
  assert.equal(personalItem.visibility, "private");
  assert.equal(JSON.stringify(response.body).includes(otherPrivateFile.id), false);
  assert.equal(JSON.stringify(response.body).includes("다른 학생 비밀 자료"), false);
  for (const hidden of ["bucket", "object_path", "status", "created_by"]) {
    assert.equal(hidden in item, false);
  }
  const openUrl = new URL(item.open_url);
  const downloadUrl = new URL(item.download_url);
  assert.match(openUrl.pathname, /^\/api\/files\//);
  assert.equal(openUrl.search, "");
  assert.equal(downloadUrl.pathname, openUrl.pathname);
  assert.equal(downloadUrl.searchParams.get("download"), "1");

  const opened = await request(app).get(`${openUrl.pathname}${openUrl.search}`).buffer(true);
  assert.equal(opened.status, 200);
  assert.match(opened.headers["content-disposition"], /^inline/);
  const downloaded = await request(app).get(`${downloadUrl.pathname}${downloadUrl.search}`).buffer(true);
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers["content-disposition"], /^attachment/);
});

test("학생 포털 일정 쓰기는 본인 소유를 강제하고 포털 admin만 반 전체 일정을 관리한다", async () => {
  const { app, store } = await fixture();
  const members = await store.listMembers();
  const student = members.find((item) => item.role === "student");
  const other = members.find((item) => item.role === "student" && item.id !== student.id);
  const portalAdmin = members.find((item) => item.role === "admin");
  const studentAgent = request.agent(app);
  const adminAgent = request.agent(app);
  assert.equal((await loginPortal(studentAgent, store, student, "STUD-ENT2")).status, 200);
  assert.equal((await loginPortal(adminAgent, store, portalAdmin, "ADMN-PORT")).status, 200);

  const own = await studentAgent.post("/api/portal/events").send({
    scope: "personal",
    category: "assignment",
    title: "학생 본인 일정",
    due_at: "2026-07-25T18:00:00",
  });
  assert.equal(own.status, 201);
  assert.equal(own.body.item.member_id, student.id);
  const classDenied = await studentAgent.post("/api/portal/events").send({
    scope: "class",
    category: "class",
    title: "학생의 반 일정 사칭",
    due_at: "2026-07-25T19:00:00",
  });
  assert.equal(classDenied.status, 403);
  const impersonation = await studentAgent.post("/api/portal/events").send({
    member_id: other.id,
    category: "assignment",
    title: "다른 학생 일정 사칭",
    due_at: "2026-07-25T20:00:00",
  });
  assert.equal(impersonation.status, 403);

  const classEvent = await adminAgent.post("/api/portal/events").send({
    scope: "class",
    category: "class",
    title: "포털 관리자 반 일정",
    due_at: "2026-07-26T09:00:00",
  });
  assert.equal(classEvent.status, 201);
  assert.equal(classEvent.body.item.member_id, null);
  assert.equal((await studentAgent.patch(`/api/portal/events/${classEvent.body.item.id}`).send({ title: "학생 변조" })).status, 404);
  assert.equal((await studentAgent.delete(`/api/portal/events/${classEvent.body.item.id}`)).status, 404);

  const ownUpdated = await studentAgent.patch(`/api/portal/events/${own.body.item.id}`).send({ title: "학생 본인 일정 수정" });
  assert.equal(ownUpdated.status, 200);
  const ownDeleted = await studentAgent.delete(`/api/portal/events/${own.body.item.id}`);
  assert.equal(ownDeleted.status, 200);
  assert.equal(ownDeleted.body.item.status, "cancelled");

  const classUpdated = await adminAgent.patch(`/api/portal/events/${classEvent.body.item.id}`).send({ title: "관리자 반 일정 수정" });
  assert.equal(classUpdated.status, 200);
  const classDeleted = await adminAgent.delete(`/api/portal/events/${classEvent.body.item.id}`);
  assert.equal(classDeleted.status, 200);
  assert.equal(classDeleted.body.item.status, "cancelled");
});

test("관리자는 실제 PDF·이미지만 자료실에 올리고 비공개 링크로 내려받는다", async () => {
  const { app, agent, store } = await fixture();
  await login(agent);
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF");
  const uploaded = await agent
    .post("/api/admin/files")
    .field("alias", "화학 실험 안내")
    .field("description", "실험 전 읽을 자료")
    .field("visibility", "class")
    .attach("file", pdf, { filename: "화학안내.pdf", contentType: "application/pdf" });
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.item.alias, "화학 실험 안내");
  assert.equal(uploaded.body.item.visibility, "class");
  assert.equal("bucket" in uploaded.body.item, false);
  assert.equal("object_path" in uploaded.body.item, false);

  const listed = await agent.get("/api/admin/files");
  assert.equal(listed.body.items.length, 1);
  const adminDownload = await agent.get(`/api/admin/files/${uploaded.body.item.id}/download`).buffer(true);
  assert.equal(adminDownload.status, 200);
  assert.match(adminDownload.headers["content-disposition"], /attachment/);

  const token = createFileToken(uploaded.body.item.id, config.sessionSecret, {
    now: new Date("2026-07-15T03:00:00.000Z"),
    ttlSeconds: 60,
  });
  const publicDownload = await request(app).get(`/api/files/${encodeURIComponent(token)}`).buffer(true);
  assert.equal(publicDownload.status, 200);
  assert.match(publicDownload.headers["content-disposition"], /inline/);
  assert.equal(publicDownload.headers["x-content-type-options"], "nosniff");

  const rejected = await agent
    .post("/api/admin/files")
    .field("alias", "가짜 PDF")
    .field("visibility", "class")
    .attach("file", Buffer.from("<html>not a pdf</html>"), { filename: "fake.pdf", contentType: "application/pdf" });
  assert.equal(rejected.status, 400);
  assert.equal((await store.listFiles({ all: true })).length, 1);

  const removed = await agent.delete(`/api/admin/files/${uploaded.body.item.id}`);
  assert.equal(removed.status, 200);
  assert.equal((await request(app).get(`/api/files/${encodeURIComponent(token)}`)).status, 404);
});

test("health check는 저장소 연결 실패를 503으로 노출하되 내부 오류는 숨긴다", async () => {
  const store = new MemoryStore(config);
  store.healthCheck = async () => { throw new Error("database password should not leak"); };
  const app = await createApp({ config, store });
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    storage: "memory",
    kakaoEnabled: false,
    reason: "storage_unavailable",
  });
  assert.equal(JSON.stringify(response.body).includes("password"), false);
});

test("빌드된 관리자 화면의 동일 출처 로그인은 허용하고 외부 출처는 차단한다", async () => {
  const { app } = await fixture();
  const sameOrigin = await request(app)
    .post("/api/admin/login")
    .set("Origin", "http://localhost:4310")
    .set("Host", "localhost:4310")
    .send({ password: config.adminPassword });
  assert.equal(sameOrigin.status, 200);

  const foreignOrigin = await request(app)
    .post("/api/admin/login")
    .set("Origin", "https://attacker.example")
    .set("Host", "localhost:4310")
    .send({ password: config.adminPassword });
  assert.equal(foreignOrigin.status, 403);
});

test("동일 Idempotency-Key 일정 생성은 한 번만 저장한다", async () => {
  const { agent, store } = await fixture();
  await login(agent);
  const payload = {
    category: "assessment",
    subject: "물리학",
    title: "단진자 보고서",
    due_at: "2026-07-20T18:00:00",
    reminder_offsets: [1440, 0, 1440],
  };
  const first = await agent.post("/api/admin/events").set("Idempotency-Key", "event:test:0001").send(payload);
  const second = await agent.post("/api/admin/events").set("Idempotency-Key", "event:test:0001").send(payload);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.item.id, second.body.item.id);
  assert.equal((await store.listEvents()).filter((item) => item.title === payload.title).length, 1);
  assert.deepEqual(first.body.item.reminder_offsets, [1440, 0]);
});

test("시간표 중복 교시와 잘못된 일정 날짜를 거부한다", async () => {
  const { agent } = await fixture();
  await login(agent);
  const duplicate = await agent.put("/api/admin/timetable/3").send({
    rows: [
      { period: 1, subject: "수학" },
      { period: 1, subject: "영어" },
    ],
  });
  assert.equal(duplicate.status, 409);
  const invalidDate = await agent.post("/api/admin/events").send({ title: "잘못된 일정", due_at: "not-a-date" });
  assert.equal(invalidDate.status, 400);

  const frontendShape = await agent.put("/api/admin/timetable/4").send({ items: [{ period: 1, subject: "화학" }] });
  assert.equal(frontendShape.status, 200);
  assert.equal(frontendShape.body.items[0].subject, "화학");
});

test("초대 코드 가입, 카카오 알림 설정, 공지 조회가 이어진다", async () => {
  const { app, agent, store } = await fixture();
  await login(agent);
  const [member] = await store.listMembers();
  const invitation = await agent.post(`/api/admin/members/${member.id}/invite`).send({ expires_in_hours: 24 });
  assert.equal(invitation.status, 201);

  const user = { properties: { botUserKey: "kakao-user-1", isFriend: "false" } };
  const join = await request(app).post("/api/kakao/skill").send({
    userRequest: { utterance: `가입 ${invitation.body.code}`, user },
  });
  assert.equal(join.status, 200);
  assert.match(join.body.template.outputs[0].simpleText.text, /가입이 완료/);
  assert.match(join.body.template.outputs[0].simpleText.text, /친구 추가/);

  const disable = await request(app).post("/api/kakao/skill").send({
    userRequest: { utterance: "알림 끄기", user },
  });
  assert.match(disable.body.template.outputs[0].simpleText.text, /알림을 껐습니다/);
  assert.equal((await store.findMemberByUserKey("kakao-user-1")).notification_enabled, false);
  const memberResponse = await agent.get("/api/admin/members");
  const joinedMember = memberResponse.body.items.find((item) => item.id === member.id);
  assert.equal(joinedMember.kakao_connected, true);
  assert.equal("kakao_user_key" in joinedMember, false);
  assert.equal(JSON.stringify(store.auditLogs).includes("kakao-user-1"), false);

  const notice = await agent
    .post("/api/admin/notices")
    .set("Idempotency-Key", "notice:test:0001")
    .send({ title: "준비물 안내", body: "내일 실내화를 가져오세요.", status: "published" });
  assert.equal(notice.status, 201);
  assert.equal(notice.body.delivery.dryRun, true);

  const kakaoNotice = await request(app).post("/api/kakao/skill").send({ userRequest: { utterance: "공지", user } });
  assert.match(kakaoNotice.body.template.outputs[0].simpleText.text, /준비물 안내/);

  const draft = await agent.post("/api/admin/notices").send({ title: "게시 대기", body: "게시 버튼 테스트" });
  const sent = await agent.post(`/api/admin/notices/${draft.body.item.id}/send`).send({});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.item.status, "published");
  assert.equal(sent.body.delivery.dryRun, true);
});

test("이름이 맨 뒤인 시간표와 오늘·내일·주간 일정 질의는 요청자 가입 없이 조회한다", async () => {
  const { app, agent, store } = await fixture();
  await login(agent);
  await store.createEvent({
    category: "assessment",
    subject: "영어",
    title: "단어 시험",
    due_at: "2026-07-15T16:00:00",
  });
  await store.createEvent({
    category: "assignment",
    subject: "수학",
    title: "문제집 제출",
    due_at: "2026-07-16T09:00:00",
  });
  const [member] = await store.listMembers();
  const invitation = await agent.post(`/api/admin/members/${member.id}/invite`).send({ expires_in_hours: 24 });
  const user = { properties: { botUserKey: "kakao-schedule-user", isFriend: "true" } };
  await request(app).post("/api/kakao/skill").send({
    userRequest: { utterance: `가입 ${invitation.body.code}`, user },
  });

  const missingTarget = await request(app)
    .post("/api/kakao/skill")
    .send({ userRequest: { utterance: "오늘 시간표", user: { id: "anonymous" } } });
  assert.match(missingTarget.body.template.outputs[0].simpleText.text, /이름.*맨 뒤/);

  const anonymousNatural = await request(app)
    .post("/api/kakao/skill")
    .send({ userRequest: { utterance: `오늘 뭐 있어 ${member.display_name}?`, user: { id: "anonymous" } } });
  assert.match(anonymousNatural.body.template.outputs[0].simpleText.text, /단어 시험/);

  const expected = new Map([
    [`오늘 일정 알려줘 ${member.display_name}`, /단어 시험/],
    [`내일 뭐 있어 ${member.display_name}?`, /문제집 제출/],
    [`일정 ${member.display_name}`, /앞으로 30일 일정/],
    [`이번 주 일정 ${member.display_name}`, /이번 주 일정/],
    [`이번 주 수행평가 ${member.display_name}`, /단어 시험/],
  ]);
  for (const [utterance, pattern] of expected) {
    const response = await request(app).post("/api/kakao/skill").send({ userRequest: { utterance, user } });
    assert.equal(response.status, 200);
    assert.equal(response.body.version, "2.0");
    assert.match(response.body.template.outputs[0].simpleText.text, pattern);
    assert.ok(response.body.template.outputs[0].simpleText.text.length > 10);
    assert.equal(response.body.template.quickReplies.some((item) => item.label === `오늘 일정 ${member.display_name}`), true);
  }

  for (const utterance of ["오늘 시간표", "내일 시간표", "수행평가"]) {
    const response = await request(app).post("/api/kakao/skill").send({ userRequest: { utterance: `${utterance} ${member.display_name}`, user } });
    assert.equal(response.status, 200);
    assert.equal(response.body.version, "2.0");
  }
});

test("관리자 일정 API는 개인 대상 member_id를 검증하고 반 전체 일정으로 되돌릴 수 있다", async () => {
  const { agent, store } = await fixture();
  await login(agent);
  const [member] = await store.listMembers();
  const created = await agent
    .post("/api/admin/events")
    .set("Idempotency-Key", "event:personal:0001")
    .send({
      member_id: member.id,
      category: "assignment",
      title: "개인 과제",
      due_at: "2026-07-18T18:00:00",
    });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.member_id, member.id);

  const invalid = await agent.post("/api/admin/events").send({
    member_id: "missing-member",
    category: "assignment",
    title: "잘못된 개인 과제",
    due_at: "2026-07-18T19:00:00",
  });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /구성원을 찾을 수 없습니다/);

  const classwide = await agent.patch(`/api/admin/events/${created.body.item.id}`).send({ member_id: null });
  assert.equal(classwide.status, 200);
  assert.equal(classwide.body.item.member_id, null);
});

test("초기 명단 bulk import는 관리자 인증과 빈 학급을 요구하고 가명 목록을 한 번만 넣는다", async () => {
  const { agent, store } = await fixture();
  store.members = [];
  const payload = {
    members: [
      { display_name: "홍길동", role: "admin" },
      { display_name: "김학생", role: "student" },
    ],
  };
  assert.equal((await agent.post("/api/admin/members/import").send(payload)).status, 401);
  await login(agent);
  const imported = await agent.post("/api/admin/members/import").send(payload);
  assert.equal(imported.status, 201);
  assert.equal(imported.body.created_count, 2);
  const members = await store.listMembers();
  assert.deepEqual(members.map((member) => [member.display_name, member.role, member.status]), [
    ["김학생", "student", "invited"],
    ["홍길동", "admin", "invited"],
  ]);
  const repeated = await agent.post("/api/admin/members/import").send(payload);
  assert.equal(repeated.status, 409);
  assert.equal((await store.listMembers()).length, 2);
});

test("동시 공지 게시 요청은 한 번만 새 게시와 알림을 만든다", async () => {
  const { agent } = await fixture();
  await login(agent);
  const draft = await agent.post("/api/admin/notices").send({
    title: "동시 게시 테스트",
    body: "한 번만 게시되어야 합니다.",
    notify_on_publish: true,
  });
  const [first, second] = await Promise.all([
    agent.patch(`/api/admin/notices/${draft.body.item.id}`).send({ status: "published" }),
    agent.patch(`/api/admin/notices/${draft.body.item.id}`).send({ status: "published" }),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal([first.body.delivery, second.body.delivery].filter(Boolean).length, 1);
});

test("Cron endpoint는 Bearer secret과 dry-run을 지원한다", async () => {
  const { app, store } = await fixture();
  const [reserved] = await store.reserveNotifications([{
    member_id: store.members[0].id,
    event_id: null,
    notice_id: null,
    idempotency_key: "cron:dry-run:orphan",
    kind: "test",
    scheduled_for: new Date("2026-07-15T00:00:00.000Z").toISOString(),
    payload: { message: "dry-run must not mutate" },
  }]);
  store.notifications.find((item) => item.id === reserved.id).created_at = "2026-07-14T00:00:00.000Z";
  assert.equal((await request(app).post("/api/cron/notifications")).status, 401);
  const response = await request(app)
    .post("/api/cron/notifications")
    .set("Authorization", `Bearer ${config.cronSecret}`)
    .send({ dry_run: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.dispatch.dryRun, true);
  assert.equal(response.body.reconciliation.skipped, true);
  assert.equal((await store.getNotification(reserved.id)).status, "reserved");
});

test("실패 알림 재시도 API는 관리자 Idempotency-Key를 강제한다", async () => {
  const { agent, store } = await fixture();
  await login(agent);
  const [notification] = await store.reserveNotifications([
    {
      member_id: store.members[0].id,
      event_id: null,
      notice_id: null,
      idempotency_key: "app:failed:retry:1",
      kind: "test",
      scheduled_for: new Date().toISOString(),
      payload: { message: "재시도" },
    },
  ]);
  await store.markNotifications([notification.id], { status: "failed", failure_reason: "테스트" });
  const response = await agent.post(`/api/admin/notifications/${notification.id}/retry`).send({});
  assert.equal(response.status, 400);
  assert.match(response.body.error, /Idempotency-Key/);
});
