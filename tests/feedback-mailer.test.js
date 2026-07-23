const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CATEGORY_LABELS,
  categoryLabel,
  resolveFeedbackRecipient,
} = require("../lib/feedback-mailer");

test("support feedback categories cover the public inquiry form and legacy data key", () => {
  assert.equal(categoryLabel("bug"), "버그");
  assert.equal(categoryLabel("feature"), "기능 제안");
  assert.equal(categoryLabel("account"), "계정");
  assert.equal(categoryLabel("billing"), "결제");
  assert.equal(categoryLabel("report-quality"), "보고서 품질");
  assert.equal(categoryLabel("data"), "데이터");
  assert.equal(categoryLabel("data-processing"), "데이터");
  assert.equal(categoryLabel("format"), "문서형식");
  assert.equal(categoryLabel("school"), "학교도입");
  assert.equal(categoryLabel("unknown"), CATEGORY_LABELS.other);
});

test("support feedback always uses the official inbox unless SUPPORT_EMAIL_TO explicitly overrides it", () => {
  assert.equal(resolveFeedbackRecipient({ SUPPORT_EMAIL_TO: "support@example.com", FEEDBACK_EMAIL_TO: "feedback@example.com", ADMIN_EMAIL: "admin@example.com" }), "support@example.com");
  assert.equal(resolveFeedbackRecipient({ FEEDBACK_EMAIL_TO: "feedback@example.com", ADMIN_EMAIL: "admin@example.com" }), "fakeminjun7321@quilolab.com");
  assert.equal(resolveFeedbackRecipient({ ADMIN_EMAIL: "admin@example.com" }), "fakeminjun7321@quilolab.com");
  assert.equal(resolveFeedbackRecipient({}), "fakeminjun7321@quilolab.com");
});
