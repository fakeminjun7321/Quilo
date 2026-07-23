"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { getFeature, listFeatures } = require("../lib/quilo-catalog");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("print PDF restoration is registered as an admin-only PDF beta", () => {
  const feature = getFeature("print-pdf-restore");
  assert.ok(feature);
  assert.equal(feature.status, "beta");
  assert.equal(feature.audience, "admin");
  assert.deepEqual(feature.formats, ["pdf"]);
  assert.equal(feature.path, "/?report=print-pdf-restore");
  assert.equal(feature.api, "reports:write");
  assert.ok(listFeatures({ query: "사진 PDF 복원" }).some((item) => item.id === feature.id));
});

test("admin restoration form keeps originals, fixes PDF output, and declares the QA gate", () => {
  const html = read("public/index.html");
  assert.match(html, /id="rtPrintPdfRestore" hidden/);
  assert.match(html, /id="printPdfRestoreForm"[^>]+data-report-form="print-pdf-restore"[^>]+hidden/);
  assert.match(html, /id="pprPhotos" name="photos"[^>]+multiple required/);
  assert.match(html, /id="pprReference" name="reference"[^>]+application\/pdf/);
  assert.match(html, /name="format" value="pdf"/);
  assert.match(html, /name="qualityGate" value="ocr-visual-300dpi"/);
  assert.match(html, /맥락·축·라벨·물리적 의미/);
  assert.match(html, /300dpi[^<]*OCR/);
});

test("frontend exposes and submits restoration only for a real admin session", () => {
  const shellController = read("public/workspace/shell-controller.js");
  const accountController = read("public/workspace/account-controller.js");
  const runtime = read("public/workspace/report-runtime.js");
  const formController = read("public/workspace/forms/controller.js");
  const siteShell = read("public/ui/shell.js");
  const developers = read("public/developers.js");

  assert.match(shellController, /state\.get\(\)\.user\?\.isAdmin === true/);
  assert.match(shellController, /reveal\("rtPrintPdfRestore"\)/);
  assert.match(accountController, /radio\.value === "print-pdf-restore"/);
  assert.match(accountController, /adminOnly && !isAdmin/);
  assert.match(accountController, /applyReportAccess\(user\.isAdmin \? \[\] : user\.blockedReportTypes, user\.isAdmin === true\)/);
  assert.match(runtime, /get isAdmin\(\).*isAdmin === true/);
  assert.match(formController, /if \(!runtime\.isAdmin\)/);
  for (const field of ["type", "photos", "reference", "pageOrder", "promptText", "layoutMode", "semanticRedraw", "qualityGate", "format"]) {
    assert.match(formController, new RegExp(`formData\\.append\\(\\"${field}\\"`), `missing ${field} FormData field`);
  }
  assert.match(siteShell, /item\.audience !== "admin" \|\| adminViewer/);
  assert.match(developers, /item\.audience !== "admin" \|\| state\.isAdmin/);
});
