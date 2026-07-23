"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

function readPublic(relativePath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relativePath), "utf8");
}

function staticMarkup(relativePath) {
  return readPublic(relativePath).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function countHeadings(markup, level) {
  return (markup.match(new RegExp(`<h${level}\\b`, "gi")) || []).length;
}

test("core AI textareas expose stable accessible names", () => {
  const cases = [
    ["studio.html", "prompt", "스튜디오 AI 요청"],
    ["editor.html", "agentPrompt", "코드 Agent 요청"],
    ["admin.html", "aaInput", "AI 관리자 보조 질문"],
    ["admin.html", "ceArea", "코드 편집기"],
    ["admin.html", "caPrompt", "코드 AI 도우미 요청"],
    ["index.html", "settingsStyleNote", "내 기본 글 스타일"],
  ];

  for (const [file, id, label] of cases) {
    const source = readPublic(file);
    const textarea = source.match(new RegExp(`<textarea\\b[^>]*\\bid="${id}"[^>]*>`))?.[0] || "";
    assert.match(textarea, new RegExp(`\\baria-label="${label}"`), `${file}#${id}`);
  }

  const index = readPublic("index.html");
  const memoPrompts = index.match(/<textarea\b[^>]*class="memo-guide-prompt"[^>]*>/g) || [];
  // 퇴역한 보고서 폼은 공개 HTML에서 완전히 제거한다. 현재 공개 폼의
  // 메모 가이드만 접근 가능한 이름을 가져야 한다.
  assert.equal(memoPrompts.length, 3);
  for (const prompt of memoPrompts) {
    assert.match(prompt, /\baria-label="[^"]+"/);
  }
});

test("school application errors use unique ids and runtime aria-errormessage wiring", () => {
  const html = readPublic("school-apply.html");
  const script = readPublic("ui/school-apply.js");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "school-apply.html must not contain duplicate ids");

  for (const fieldId of ["schoolName", "contactName", "contactEmail", "studentEmailDomain", "consent"]) {
    assert.match(
      html,
      new RegExp(`<small\\b[^>]*id="${fieldId}Error"[^>]*data-error-for="${fieldId}"[^>]*>`),
      fieldId,
    );
  }
  assert.match(script, /input\.setAttribute\("aria-errormessage", error\.id\)/);
  assert.match(script, /input\.removeAttribute\("aria-invalid"\)/);
  assert.match(script, /input\.removeAttribute\("aria-errormessage"\)/);
});

test("school application dropzone has one keyboard-operable file picker", () => {
  const html = readPublic("school-apply.html");
  const script = readPublic("ui/school-apply.js");
  const dropzone = html.match(/<div\b[^>]*\bid="fileDropzone"[^>]*>/)?.[0] || "";
  const trigger = html.match(/<button\b[^>]*\bdata-file-trigger[^>]*>/)?.[0] || "";
  const input = html.match(/<input\b[^>]*\bid="files"[^>]*>/)?.[0] || "";

  assert.match(dropzone, /\brole="group"/);
  assert.match(dropzone, /\baria-labelledby="filesLabel"/);
  assert.doesNotMatch(dropzone, /\brole="button"|\btabindex=/);
  assert.match(trigger, /\btype="button"/);
  assert.match(trigger, /\baria-controls="files"/);
  assert.match(trigger, /\baria-describedby="filesHint"/);
  assert.match(input, /\bmultiple\b/);
  assert.match(input, /\btabindex="-1"/);

  assert.match(script, /\[data-file-trigger\][\s\S]*?addEventListener\("click", \(\) => fileInput\.click\(\)\)/);
  assert.doesNotMatch(script, /dropzone\.addEventListener\("(?:click|keydown)"/);
  assert.match(script, /dropzone\.addEventListener\("drop", \(event\) => addFiles\(event\.dataTransfer\?\.files\)\)/);
  assert.match(script, /selectedFiles\.length < 8/);
});

test("authentication pages expose one page-level heading without changing the context title styling", () => {
  const cases = [
    ["login.html", "loginTitle"],
    ["password-reset.html", "resetTitle"],
    ["signup.html", "signupTitle"],
    ["verify-email.html", "verifyPageTitle"],
  ];

  for (const [file, titleId] of cases) {
    const markup = staticMarkup(file);
    assert.equal(countHeadings(markup, 1), 1, `${file} must expose exactly one static h1`);
    assert.match(markup, new RegExp(`<h1\\b[^>]*\\bid="${titleId}"[^>]*>`), `${file} page title`);
    assert.match(markup, /<p\b[^>]*\bclass="auth-context__title"[^>]*>/, `${file} context title`);
  }

  const css = readPublic("ui/auth.css");
  assert.match(css, /\.auth-context__title\s*\{/);
  assert.doesNotMatch(css, /\.auth-context\s+h1\s*\{/);
});

test("admin and gallery surfaces keep a single h1 with ordered section headings", () => {
  const admin = staticMarkup("admin.html");
  const adminMain = admin.match(/<main\b[^>]*>[\s\S]*?<\/main>/i)?.[0] || "";
  assert.equal(countHeadings(adminMain, 1), 1, "admin main must start its hierarchy with one h1");
  assert.match(adminMain, /<h1\b[^>]*\bid="adminMainTitle"[^>]*>Quilo 관리자 — 운영 개요<\/h1>/);
  assert.match(readPublic("admin.html"), /mainTitle\.textContent = "Quilo 관리자 — " \+ \(titles\[tab\]/);

  const create = staticMarkup("create.html");
  assert.equal(countHeadings(create, 1), 1, "create gallery must have one h1");
  assert.equal(countHeadings(create, 2), 4, "create launch and gallery section titles must be h2");
  assert.equal(countHeadings(create, 3), 0, "create gallery must not skip directly to h3");

  const tools = staticMarkup("tools/index.html");
  assert.equal(countHeadings(tools, 1), 1, "tools index must have one h1");
  assert.equal(countHeadings(tools, 2), 3, "tool card titles must follow the page h1 as h2");
  assert.equal(countHeadings(tools, 3), 0, "tools index must not skip from h1 to h3");
});

test("admin links that open a new tab protect the opener context", () => {
  const admin = staticMarkup("admin.html");
  const newTabLinks = admin.match(/<a\b[^>]*\btarget="_blank"[^>]*>/gi) || [];
  assert.ok(newTabLinks.length > 0, "expected at least one admin new-tab link");
  for (const link of newTabLinks) {
    assert.match(link, /\brel="[^"]*\bnoopener\b[^"]*"/i, link);
  }
});
