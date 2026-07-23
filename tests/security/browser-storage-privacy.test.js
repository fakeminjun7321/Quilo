"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class MemoryStorage {
  constructor(entries = {}) { this.values = new Map(Object.entries(entries)); }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
}

function loadPrivacy() {
  const localStorage = new MemoryStorage({
    theme: "dark",
    studentId: "2401",
    "quiloDraft:v1:chem-pre": "secret draft",
  });
  const sessionStorage = new MemoryStorage({ "quiloChat:v2": "secret chat" });
  const window = { localStorage, sessionStorage };
  const document = { querySelector: () => null };
  const source = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "ui", "shell.js"),
    "utf8",
  );
  vm.runInNewContext(source, { window, document, localStorage, sessionStorage });
  return { privacy: window.QuiloStoragePrivacy, localStorage, sessionStorage };
}

test("first principal claim removes legacy account data but preserves device theme", () => {
  const { privacy, localStorage, sessionStorage } = loadPrivacy();
  privacy.protect("user-1");
  assert.equal(localStorage.getItem("studentId"), null);
  assert.equal(localStorage.getItem("quiloDraft:v1:chem-pre"), null);
  assert.equal(sessionStorage.getItem("quiloChat:v2"), null);
  assert.equal(localStorage.getItem("theme"), "dark");
  assert.equal(localStorage.getItem("quilo.browser.principal.v1"), "user-1");
});

test("same principal keeps drafts, account switch and logout remove them", () => {
  const { privacy, localStorage } = loadPrivacy();
  privacy.protect("user-1");
  localStorage.setItem("quiloDraft:v1:phys-result", "mine");
  privacy.protect("user-1");
  assert.equal(localStorage.getItem("quiloDraft:v1:phys-result"), "mine");
  privacy.protect("user-2");
  assert.equal(localStorage.getItem("quiloDraft:v1:phys-result"), null);
  localStorage.setItem("ceFiles", "private code");
  privacy.signOut();
  assert.equal(localStorage.getItem("ceFiles"), null);
  assert.equal(localStorage.getItem("quilo.browser.principal.v1"), null);
});

test("standalone login clears any expired-session principal before reading username", () => {
  const login = fs.readFileSync(
    path.join(__dirname, "..", "..", "public", "login.html"),
    "utf8",
  );
  assert.match(login, /<script src="\/ui\/shell\.js"><\/script>/);
  assert.ok(
    login.indexOf("QuiloStoragePrivacy?.signOut?.()") <
      login.indexOf('localStorage.getItem("lastUsername")'),
  );
});
