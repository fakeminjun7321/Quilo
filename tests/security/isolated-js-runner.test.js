"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const RUNNER_PATH = path.join(ROOT, "public/ui/isolated-js-runner.js");
const runnerSource = fs.readFileSync(RUNNER_PATH, "utf8");

test("code editors delegate JavaScript to the isolated runner without main-window eval", () => {
  for (const relative of ["public/editor.html", "public/admin.html"]) {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /<script src="\/ui\/isolated-js-runner\.js"><\/script>/u, `${relative} must load the runner`);
    assert.match(source, /QuiloIsolatedJsRunner\.run\(code\)/u, `${relative} must delegate JavaScript execution`);
    assert.doesNotMatch(source, /\(\s*0\s*,\s*eval\s*\)|\beval\s*\(/u, `${relative} must not evaluate code in the page realm`);
  }
});

test("admin logout invokes the shared browser-storage privacy hook", () => {
  const source = fs.readFileSync(path.join(ROOT, "public/admin.html"), "utf8");
  assert.match(source, /<script src="\/theme\.js"><\/script>\s*<script src="\/ui\/shell\.js"><\/script>/u);
  const logoutHandler = source.match(/getElementById\("logout"\)[\s\S]*?location\.href = "\/login\.html";/u)?.[0] || "";
  assert.match(logoutHandler, /QuiloStoragePrivacy\?\.signOut\?\.\(\)/u);
  assert.ok(
    logoutHandler.indexOf("QuiloStoragePrivacy") < logoutHandler.indexOf('fetch("/api/logout"'),
    "local account data must be cleared before navigating away",
  );
});

test("worker source locks network, storage, and worker escape APIs before evaluation", () => {
  const evaluationIndex = runnerSource.indexOf("var result = evaluate(");
  const lockdownIndex = runnerSource.indexOf("blockedApis.forEach");
  assert.ok(lockdownIndex >= 0 && evaluationIndex > lockdownIndex, "lockdown must run before user code");

  for (const api of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts",
    "Worker", "SharedWorker", "BroadcastChannel", "postMessage", "indexedDB", "caches",
    "cookieStore", "localStorage", "sessionStorage", "StorageManager", "FileSystemHandle", "location",
  ]) {
    assert.match(runnerSource, new RegExp(`"${api}"`, "u"), `${api} must be locked`);
  }
  assert.match(runnerSource, /lockGlobal\("navigator"/u);
  assert.match(runnerSource, /lockGlobal\("eval"/u);
  assert.match(runnerSource, /lockGlobal\("Function"/u);
  assert.match(runnerSource, /lockConstructor\(Function\.prototype/u);
  assert.match(runnerSource, /throw securityError\("dynamic import"\)/u);
  assert.match(runnerSource, /MAX_LOG_LINES\s*=\s*120/u);
  assert.match(runnerSource, /MAX_LOG_TOTAL_CHARS\s*=\s*20000/u);
});

test("runner terminates an unresponsive worker at the bounded timeout", async () => {
  const workers = [];
  const blobs = [];

  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.options = options;
      blobs.push(this);
    }
  }

  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.terminated = false;
      this.messages = [];
      workers.push(this);
    }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }

  const window = {
    Blob: FakeBlob,
    Worker: FakeWorker,
    URL: {
      createObjectURL() { return "blob:quilo-runner-test"; },
      revokeObjectURL() {},
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(runnerSource, { window, Promise, Object, Array, String, Number, Error });

  const result = await window.QuiloIsolatedJsRunner.run("while (true) {}", { timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.match(result.error, /시간.*초과.*중지/u);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[0].messages.length, 1);
  assert.equal(workers[0].messages[0].type, "run");
  assert.equal(workers[0].messages[0].code, "while (true) {}");
  assert.equal(workers[0].options.name, "quilo-isolated-js");
  assert.match(blobs[0].parts.join(""), /blockedApis\.forEach/u);
  assert.match(blobs[0].parts.join(""), /var result = evaluate/u);
});
