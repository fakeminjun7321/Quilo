"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PDF_TRANSLATION_RENDERERS,
  EFFECTIVE_PDF_TRANSLATION_RENDERERS,
  LIBREOFFICE_RENDERER_ENABLE_ENV,
  assertLibreOfficeRendererAvailable,
  getPdfTranslationRendererCapabilities,
  isLibreOfficeRendererConfigured,
  normalizeRequestedRenderer,
  probeLibreOfficeRenderer,
  assertEffectivePdfTranslationRenderer,
  resolvePdfTranslationRenderer,
} = require("../../lib/pipelines/pdf-translate/renderer-contract");

test("renderer enums are stable and independent from translation modes", () => {
  assert.deepEqual(PDF_TRANSLATION_RENDERERS, ["auto", "tectonic", "libreoffice"]);
  assert.deepEqual(EFFECTIVE_PDF_TRANSLATION_RENDERERS, [
    "pymupdf",
    "tectonic",
    "libreoffice",
  ]);
});

test("requested renderer normalization preserves the legacy auto default", () => {
  assert.equal(normalizeRequestedRenderer(), "auto");
  assert.equal(normalizeRequestedRenderer("LibreOffice"), "libreoffice");
  assert.equal(normalizeRequestedRenderer("tectonic"), "tectonic");
  assert.equal(normalizeRequestedRenderer("unknown"), "auto");
  assert.equal(normalizeRequestedRenderer("unknown", "libreoffice"), "libreoffice");
});

test("in-place mode always resolves to the PyMuPDF renderer", () => {
  for (const requestedRenderer of PDF_TRANSLATION_RENDERERS) {
    const result = resolvePdfTranslationRenderer({
      requestedRenderer,
      effectiveMode: "inplace",
    });
    assert.equal(result.effectiveRenderer, "pymupdf");
    assert.equal(result.effectiveMode, "inplace");
    assert.equal(result.applies, false);
  }
});

test("retypeset mode keeps Tectonic as default and supports explicit LibreOffice", () => {
  assert.equal(
    resolvePdfTranslationRenderer({ effectiveMode: "retypeset" }).effectiveRenderer,
    "tectonic",
  );
  assert.equal(
    resolvePdfTranslationRenderer({
      requestedRenderer: "tectonic",
      effectiveMode: "retypeset",
    }).effectiveRenderer,
    "tectonic",
  );
  assert.equal(
    resolvePdfTranslationRenderer({
      requestedRenderer: "libreoffice",
      effectiveMode: "retypeset",
    }).effectiveRenderer,
    "libreoffice",
  );
});

test("invalid effective mode and renderer fail closed", () => {
  assert.throws(
    () => resolvePdfTranslationRenderer({ effectiveMode: "auto" }),
    (error) => error.details.kind === "invalid_effective_mode",
  );
  assert.throws(
    () => assertEffectivePdfTranslationRenderer("writer"),
    (error) => error.details.kind === "invalid_effective_renderer",
  );
});

test("LibreOffice capability defaults off and does not probe the host", () => {
  let probes = 0;
  const capability = probeLibreOfficeRenderer({
    env: {},
    findLibreOfficeBinary() {
      probes += 1;
      return "/usr/bin/libreoffice";
    },
  });

  assert.equal(LIBREOFFICE_RENDERER_ENABLE_ENV, "PDF_TRANSLATE_LIBREOFFICE_ENABLED");
  assert.equal(isLibreOfficeRendererConfigured({}), false);
  assert.deepEqual(capability, {
    available: false,
    reason: "disabled_by_configuration",
    binary: null,
  });
  assert.equal(probes, 0);
});

test("LibreOffice capability needs both an explicit flag and a binary", () => {
  const env = { PDF_TRANSLATE_LIBREOFFICE_ENABLED: "true" };
  assert.equal(isLibreOfficeRendererConfigured(env), true);
  assert.deepEqual(
    probeLibreOfficeRenderer({
      env,
      findLibreOfficeBinary() {
        throw new Error("missing");
      },
    }),
    { available: false, reason: "binary_unavailable", binary: null },
  );

  const capability = getPdfTranslationRendererCapabilities({
    env,
    findLibreOfficeBinary: () => "/usr/bin/libreoffice",
  });
  assert.equal(capability.renderers.libreoffice.available, true);
  assert.deepEqual(capability.renderers.libreoffice, { available: true });
  assert.equal(JSON.stringify(capability).includes("/usr/bin/libreoffice"), false);
});

test("explicit LibreOffice assertion fails closed with a stable server error", () => {
  assert.throws(
    () => assertLibreOfficeRendererAvailable({
      env: {},
      findLibreOfficeBinary: () => "/usr/bin/libreoffice",
    }),
    (error) => {
      assert.equal(error.code, "PDF_TRANSLATION_RENDERER_UNAVAILABLE");
      assert.equal(error.statusCode, 503);
      assert.equal(error.details.reason, "disabled_by_configuration");
      return true;
    },
  );
  assert.equal(
    assertLibreOfficeRendererAvailable({
      env: { PDF_TRANSLATE_LIBREOFFICE_ENABLED: "1" },
      findLibreOfficeBinary: () => "/opt/libreoffice/soffice",
    }),
    "/opt/libreoffice/soffice",
  );
});
