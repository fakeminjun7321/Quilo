"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const express = require("express");

const history = require("../lib/development-history.json");
const legacy = require("../lib/lab-content.json");
const createLabRouter = require("../lib/lab-routes");

test("development history is factual, unique, and ships its local cover images", () => {
  assert.ok(history.length >= 11);
  const entries = [...history, ...legacy];
  const ids = entries.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const entry of entries) {
    if (history.includes(entry)) assert.equal(entry.archive_kind, "development_history");
    assert.match(entry.date, /^2026-\d{2}-\d{2}$/);
    assert.ok(entry.title.length >= 12);
    assert.ok(entry.summary.length >= 40);
    assert.ok(entry.body_markdown.length >= 900);
    assert.match(entry.cover_image, /^\/assets\/developer-notes\/[a-z0-9-]+\.(?:webp|png|svg)$/);
    const file = path.join(__dirname, "..", "public", entry.cover_image.replace(/^\//, ""));
    assert.ok(fs.existsSync(file), `${entry.cover_image} must exist`);
  }
});

test("lab API exposes migrated Lab posts and new history cover metadata", async (t) => {
  const app = express();
  app.use("/api/lab", createLabRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const listResponse = await fetch(`${base}/api/lab/entries`);
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.entries.length, createLabRouter.publicEntries.length);
  assert.equal(list.entries[0].id, history[0].id);
  assert.equal(list.entries[0].coverImage, history[0].cover_image);
  const visibleLegacy = legacy.find((entry) => !createLabRouter.isRetiredLabEntry(entry));
  assert.ok(visibleLegacy);
  assert.ok(list.entries.some((entry) => entry.id === visibleLegacy.id));

  const detailResponse = await fetch(`${base}/api/lab/entry/${history[0].id}`);
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.coverImage, history[0].cover_image);
  assert.match(detail.body_markdown, new RegExp(history[0].cover_image.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  for (const hidden of [...history, ...legacy].filter(createLabRouter.isRetiredLabEntry)) {
    assert.equal(list.entries.some((entry) => entry.id === hidden.id), false);
    const hiddenDetail = await fetch(`${base}/api/lab/entry/${hidden.id}`);
    assert.equal(hiddenDetail.status, 404);
  }

  const legacyFile = await fetch(
    `${base}/api/lab/file?path=${encodeURIComponent("lib/lab-content.json")}`,
  );
  assert.equal(legacyFile.status, 404);

  const serverFile = await fetch(
    `${base}/api/lab/file?path=${encodeURIComponent("server.js")}`,
  );
  assert.equal(serverFile.status, 404);
});
