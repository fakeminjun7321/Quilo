"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const Keygrip = require("keygrip");

const { hashPassword } = require("../lib/auth");

const SERVER_PATH = require.resolve("../server");
const SUPABASE_PATH = require.resolve("../lib/supabase");

function cookieHeader(response) {
  const values = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter(Boolean);
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function markerlessCookie(cookieHeaderValue, secret) {
  const pairs = new Map(
    cookieHeaderValue.split(/;\s*/).map((pair) => {
      const separator = pair.indexOf("=");
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
  const encoded = pairs.get("quilo.sid");
  assert.ok(encoded, "login must issue the main session cookie");
  const body = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  assert.ok(body.userInfo?.pwMark, "new sessions must carry a password marker");
  delete body.userInfo.pwMark;
  const legacyValue = Buffer.from(JSON.stringify(body)).toString("base64");
  const legacySignature = new Keygrip([secret]).sign(`quilo.sid=${legacyValue}`);
  return `quilo.sid=${legacyValue}; quilo.sid.sig=${legacySignature}`;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("signed browser sessions survive a restart but fail closed after security state changes", async () => {
  const trackedSignals = ["uncaughtException", "unhandledRejection", "SIGTERM", "SIGINT"];
  const originalListeners = new Map(
    trackedSignals.map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  const originalEnv = Object.fromEntries(
    [
      "NODE_ENV",
      "SESSION_SECRET",
      "QUILO_JOB_MEMORY_TEST_HOOKS",
      "DEV_FAKE_AUTH",
      "PUBLIC_BASE_URL",
      "APP_BASE_URL",
      "GPT_API_KEY",
      "GPT_API_BASE",
    ].map((name) => [name, process.env[name]]),
  );
  const supa = require(SUPABASE_PATH);
  const originalSupa = {
    isEnabled: supa.isEnabled,
    authenticate: supa.authenticate,
    findUserById: supa.findUserById,
    recordLogin: supa.recordLogin,
  };
  const initialPasswordHash = hashPassword("restart-test-password");
  const user = {
    id: "11111111-2222-4333-8444-555555555555",
    name: "Restart Test Admin",
    username: "restart-admin",
    student_id: "",
    password_hash: initialPasswordHash,
    is_admin: true,
    is_staff: false,
    is_developer: false,
    unlimited: false,
    restricted_model: null,
    email_verified: true,
    approved: true,
    analytics_consent: false,
    analytics_consent_version: "",
    avatar_url: null,
    profile_bio: "",
  };
  const stableSecret = "restart-contract-secret-that-is-longer-than-32-characters";
  const openedServers = [];

  function loadApp(secret) {
    process.env.NODE_ENV = "test";
    process.env.SESSION_SECRET = secret;
    process.env.QUILO_JOB_MEMORY_TEST_HOOKS = "1";
    delete process.env.DEV_FAKE_AUTH;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.APP_BASE_URL;
    process.env.GPT_API_KEY = "paid-write-assist-regression-test-key";
    process.env.GPT_API_BASE = "http://127.0.0.1:1/v1";
    delete require.cache[SERVER_PATH];
    const nativeSetInterval = global.setInterval;
    global.setInterval = (...args) => {
      const timer = nativeSetInterval(...args);
      timer.unref?.();
      return timer;
    };
    try {
      return require(SERVER_PATH).app;
    } finally {
      global.setInterval = nativeSetInterval;
    }
  }

  try {
    supa.isEnabled = () => true;
    supa.authenticate = async (username, password) => (
      username === user.username && password === "restart-test-password"
        ? { ...user }
        : null
    );
    supa.findUserById = async (id) => (id === user.id ? { ...user } : null);
    supa.recordLogin = () => Promise.resolve();

    const first = await listen(loadApp(stableSecret));
    openedServers.push(first.server);
    const login = await fetch(`${first.origin}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: first.origin,
      },
      body: JSON.stringify({
        username: user.username,
        password: "restart-test-password",
        remember: true,
      }),
    });
    assert.equal(login.status, 200);
    const signedCookie = cookieHeader(login);
    assert.match(signedCookie, /quilo\.sid=/);
    assert.match(signedCookie, /quilo\.sid\.sig=/);
    const stolenMarkerlessCookie = markerlessCookie(signedCookie, stableSecret);
    await close(first.server);
    openedServers.splice(openedServers.indexOf(first.server), 1);

    // A fresh Express app models a new Node process. The same signing key must
    // accept the old stateless cookie and refresh its identity from the DB.
    const restarted = await listen(loadApp(stableSecret));
    openedServers.push(restarted.server);
    const persisted = await fetch(`${restarted.origin}/api/me`, {
      headers: { Cookie: signedCookie },
    });
    assert.equal(persisted.status, 200);
    assert.equal((await persisted.json()).id, user.id);

    // A signed cookie is not an authorization snapshot: role removal in the DB
    // must win immediately on the next privileged request.
    user.is_admin = false;
    const demoted = await fetch(`${restarted.origin}/api/admin/users`, {
      headers: { Cookie: signedCookie },
      redirect: "manual",
    });
    assert.equal(demoted.status, 403);

    // Password changes invalidate replay of a copied cookie through pwMark.
    user.is_admin = true;
    user.password_hash = hashPassword("changed-after-cookie-was-stolen");
    // A legacy markerless cookie has no verifiable password-version metadata.
    // Auto-populating its marker from the current DB hash would launder a cookie
    // stolen before this password change, so it must instead require re-login.
    const markerlessAfterPasswordChange = await fetch(`${restarted.origin}/api/me`, {
      headers: { Cookie: stolenMarkerlessCookie },
    });
    assert.equal(markerlessAfterPasswordChange.status, 401);

    const staleModels = await fetch(`${restarted.origin}/api/write-assist/models`, {
      headers: { Cookie: signedCookie },
    });
    assert.equal(staleModels.status, 200);
    assert.equal((await staleModels.json()).loggedIn, false);

    // The fake provider base would produce 502 if provider routing happened
    // before the stale password marker was rejected.
    const stalePaidChat = await fetch(`${restarted.origin}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: signedCookie },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        assistKind: "style",
        messages: [{ role: "user", content: "내 문체를 정리해줘" }],
      }),
    });
    assert.equal(stalePaidChat.status, 401);

    const stolenAfterPasswordChange = await fetch(`${restarted.origin}/api/me`, {
      headers: { Cookie: signedCookie },
    });
    assert.equal(stolenAfterPasswordChange.status, 401);

    // Browser sessions also fail closed when the canonical account row has no
    // password hash; bearer API identities keep their separate scope contract.
    user.password_hash = null;
    const missingPasswordHash = await fetch(`${restarted.origin}/api/me`, {
      headers: { Cookie: signedCookie },
    });
    assert.equal(missingPasswordHash.status, 401);
    await close(restarted.server);
    openedServers.splice(openedServers.indexOf(restarted.server), 1);

    // Key rotation is intentionally fail-closed. Operationally, keeping the
    // Render SESSION_SECRET stable is therefore part of the availability contract.
    user.password_hash = initialPasswordHash;
    const rotated = await listen(loadApp(`${stableSecret}-rotated`));
    openedServers.push(rotated.server);
    const oldCookieAfterRotation = await fetch(`${rotated.origin}/api/me`, {
      headers: { Cookie: signedCookie },
    });
    assert.equal(oldCookieAfterRotation.status, 401);
  } finally {
    await Promise.allSettled(openedServers.map((server) => close(server)));
    Object.assign(supa, originalSupa);
    delete require.cache[SERVER_PATH];
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const signal of trackedSignals) {
      const before = originalListeners.get(signal);
      for (const listener of process.listeners(signal)) {
        if (!before.has(listener)) process.removeListener(signal, listener);
      }
    }
  }
});
