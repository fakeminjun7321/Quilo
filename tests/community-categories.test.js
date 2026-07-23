"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const community = require("../lib/community");

test("community accepts only current categories for new posts and keeps legacy filters readable", () => {
  assert.deepEqual(community.NEW_POST_CATEGORIES, ["general", "question", "tip", "showcase"]);
  assert.equal(community.normalizeNewPostCategory("general"), "general");
  assert.equal(community.normalizeNewPostCategory("feature"), null);
  assert.equal(community.normalizeReadablePostCategory("feature"), "feature");
  assert.equal(community.normalizeReadablePostCategory("suggestion"), "suggestion");
});

test("community category migration permits current and legacy stored values", () => {
  const sql = fs.readFileSync(
    path.join(__dirname, "../db/migrations/20260715_expand_community_categories.sql"),
    "utf8",
  );
  for (const category of [...community.NEW_POST_CATEGORIES, ...community.LEGACY_POST_CATEGORIES]) {
    assert.match(sql, new RegExp(`'${category}'`));
  }
  assert.match(sql, /validate constraint community_posts_category_check/i);
});
