"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
const retired = [
  "phys-inquiry",
  "math-inquiry",
  "eng-exam-prep",
  "korean-lit-exam",
  "phys-mock-exam",
];

test("retired report types stay blocked before generation", () => {
  const declaration = source.match(/const RETIRED_TYPES = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  assert.ok(declaration, "RETIRED_TYPES declaration missing");
  for (const id of retired) assert.match(declaration, new RegExp(`"${id}"`));
  assert.match(source, /if \(RETIRED_TYPES\.has\(reportType\)\)/);
});

test("startup never seeds retired beta feature rows", () => {
  const startup = source.slice(source.indexOf("const httpServer ="));
  for (const id of retired) {
    assert.doesNotMatch(
      startup,
      new RegExp(`ensureBetaFeature\\(\\s*["']${id}["']`),
      `${id} must not be auto-seeded`,
    );
  }
});

test("all server catalog boundaries exclude retired feature ids", () => {
  assert.match(source, /createCatalogRouter\(\{ excludeFeatureIds: RETIRED_TYPES \}\)/);
  assert.match(source, /createMcpRouter\(\{[\s\S]*?excludeFeatureIds: RETIRED_TYPES/);

  const memberCatalog = source.slice(
    source.indexOf('app.get("/api/me/beta"'),
    source.indexOf("// 문제집 메이커 최대 문제 수"),
  );
  assert.match(memberCatalog, /visibleBetaFeatures\(await supa\.listBetaFeatures\(\)\)/);
  assert.match(memberCatalog, /visibleBetaKeys\(assignedKeys\)/);

  const adminCatalog = source.slice(
    source.indexOf('app.get("/api/admin/beta"'),
    source.indexOf('app.post("/api/admin/beta"'),
  );
  assert.match(adminCatalog, /visibleBetaFeatures\(await supa\.listBetaFeatures\(\)\)/);

  const chatCatalog = source.slice(
    source.indexOf('if (name === "get_beta_status")'),
    source.indexOf('if (name === "get_rate_limit_status")'),
  );
  assert.match(chatCatalog, /visibleBetaFeatures\(await supa\.listBetaFeatures\(\)\)/);
});

test("retired beta keys cannot be recreated, reopened, edited, or assigned", () => {
  const adminRoutes = source.slice(
    source.indexOf('app.post("/api/admin/beta/:key/open"'),
    source.indexOf("// ── DOCX → HWPX 변환"),
  );
  assert.equal(
    (adminRoutes.match(/rejectRetiredBetaKey\(res,/g) || []).length,
    6,
    "every beta mutation route must reject retired keys",
  );
});
