"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const dropbox = require("../lib/cloud/dropbox");

test("Dropbox compensation delete uses the scoped API and is idempotent", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  assert.equal(await dropbox.deleteFile({ accessToken: "access", path: "" }), false);

  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ metadata: { id: "id:1" } }), { status: 200 });
  };
  assert.equal(await dropbox.deleteFile({ accessToken: "access", path: "id:1" }), true);
  assert.equal(request.url, "https://api.dropboxapi.com/2/files/delete_v2");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer access");
  assert.deepEqual(JSON.parse(request.options.body), { path: "id:1" });

  globalThis.fetch = async () => new Response(
    JSON.stringify({ error_summary: "path_lookup/not_found/.." }),
    { status: 409 },
  );
  assert.equal(await dropbox.deleteFile({ accessToken: "access", path: "/gone.docx" }), true);
});

test("Dropbox compensation delete surfaces permission and transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("forbidden", { status: 403 });
  await assert.rejects(
    () => dropbox.deleteFile({ accessToken: "access", path: "id:1" }),
    /Dropbox delete 403/,
  );

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error_summary: "path_lookup/restricted_content/..",
      error: { ".tag": "path_lookup", path_lookup: { ".tag": "restricted_content" } },
    }),
    { status: 409 },
  );
  await assert.rejects(
    () => dropbox.deleteFile({ accessToken: "access", path: "id:restricted" }),
    /Dropbox delete 409/,
  );
});
