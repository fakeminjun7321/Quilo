"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { createTokenRouter } = require("../lib/external-api");

async function listen(app, t) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test("revoking an MCP access token also revokes its refresh family", async (t) => {
  const operations = [];
  const client = {
    from(table) {
      const operation = { table, filters: [], update: null, select: null };
      operations.push(operation);
      const chain = {
        update(value) { operation.update = value; return this; },
        eq(column, value) { operation.filters.push(["eq", column, value]); return this; },
        is(column, value) { operation.filters.push(["is", column, value]); return this; },
        select(value) { operation.select = value; return this; },
        maybeSingle() {
          return Promise.resolve({
            data: { id: "token-1", audience: "https://quilo.example/mcp" },
            error: null,
          });
        },
        then(resolve) { return Promise.resolve(resolve({ data: null, error: null })); },
      };
      return chain;
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/integrations", createTokenRouter({
    supa: { getClient: () => client },
    getSessionUser: () => ({ id: "user-1" }),
  }));
  const origin = await listen(app, t);
  const response = await fetch(`${origin}/api/integrations/tokens/token-1`, {
    method: "DELETE",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(operations.length, 3);
  assert.equal(operations[0].table, "user_access_tokens");
  assert.equal(operations[0].select, "id, audience");
  assert.equal(operations[1].table, "mcp_oauth_refresh_tokens");
  assert.ok(operations[1].filters.some((entry) => entry[1] === "user_id" && entry[2] === "user-1"));
  assert.ok(operations[1].filters.some((entry) => entry[1] === "resource" && entry[2] === "https://quilo.example/mcp"));
  assert.equal(operations[1].update.revoked_at, operations[0].update.revoked_at);
  assert.equal(operations[2].table, "user_access_tokens");
  assert.ok(operations[2].filters.some((entry) => entry[1] === "user_id" && entry[2] === "user-1"));
  assert.ok(operations[2].filters.some((entry) => entry[1] === "audience" && entry[2] === "https://quilo.example/mcp"));
  assert.equal(operations[2].update.revoked_at, operations[0].update.revoked_at);
});
