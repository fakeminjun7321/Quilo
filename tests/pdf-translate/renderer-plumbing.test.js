"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { buildOpenApiDocument } = require("../../lib/api-v1/openapi");

const ROOT = path.resolve(__dirname, "../..");

test("PDF translation OpenAPI exposes a renderer axis separate from mode", () => {
  const document = buildOpenApiDocument({ serverUrl: "https://example.test" });
  const schema = document.paths["/api/v1/pdf-translations"].post
    .requestBody.content["multipart/form-data"].schema;

  assert.deepEqual(schema.properties.mode.enum, ["auto", "inplace", "retypeset"]);
  assert.deepEqual(schema.properties.renderer.enum, ["auto", "tectonic", "libreoffice"]);
  assert.equal(schema.properties.renderer.default, "auto");
  assert.match(schema.properties.renderers.description, /같은 순서/);
});

test("translation UI submits common and per-file renderer selections", () => {
  const source = fs.readFileSync(path.join(ROOT, "public/translate.html"), "utf8");

  assert.match(source, /id="trRenderer" name="renderer"/);
  assert.match(source, /value="libreoffice" hidden disabled/);
  assert.match(source, /fetch\("\/api\/translate-pdf\/capabilities"/);
  assert.match(source, /capabilities\?\.renderers\?\.libreoffice\?\.available === true/);
  assert.match(source, /option\.remove\(\)/);
  assert.match(source, /fd\.append\("renderer", chosenRenderer\)/);
  assert.match(source, /fd\.append\("renderers", JSON\.stringify\(list\.map/);
  assert.match(source, /빠른 번역은 원본 배치를 유지하는 PyMuPDF 엔진으로 고정/);
});

test("main and standalone orchestrators report effectiveRenderer over SSE", () => {
  for (const filename of ["server.js", "translate-server.js"]) {
    const source = fs.readFileSync(path.join(ROOT, filename), "utf8");
    assert.match(source, /resolvePdfTranslationRenderer\(/, filename);
    assert.match(source, /assertLibreOfficeRendererAvailable\(/, filename);
    assert.match(source, /app\.get\("\/api\/translate-pdf\/capabilities"/, filename);
    assert.match(source, /getPdfTranslationRendererCapabilities\(/, filename);
    assert.match(source, /effectiveRenderer:\s*job\.effectiveRenderer/, filename);
    assert.match(source, /renderer:\s*effectiveRenderer/, filename);
  }
});

test("both submission routes reject unavailable explicit LibreOffice before creating a job", () => {
  for (const filename of ["server.js", "translate-server.js"]) {
    const source = fs.readFileSync(path.join(ROOT, filename), "utf8");
    const routeStart = source.indexOf('"/api/translate-pdf",');
    assert.notEqual(routeStart, -1, filename);
    const assertion = source.indexOf("assertRequestedPdfRenderersAvailable", routeStart);
    const jobCreation = source.indexOf("const job = createJob", routeStart);
    assert.ok(assertion > routeStart, `${filename}: renderer assertion missing in submission route`);
    assert.ok(jobCreation > assertion, `${filename}: job was created before renderer assertion`);

    const coreStart = filename === "server.js"
      ? source.indexOf("async function translateOnePdfCore")
      : source.indexOf("async function runPdfTranslation");
    const coreAssertion = source.indexOf("assertLibreOfficeRendererAvailable", coreStart);
    const modelRouting = source.indexOf("prepareScannedRouting", coreStart);
    assert.ok(coreAssertion > coreStart, `${filename}: core assertion missing`);
    assert.ok(modelRouting > coreAssertion, `${filename}: model routing occurs before core assertion`);
  }
});
