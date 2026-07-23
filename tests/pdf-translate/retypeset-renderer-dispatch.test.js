"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  finalizeRetypesetRenderer,
} = require("../../lib/pipelines/pdf-translate/latex-gen");

test("Tectonic remains the backward-compatible retypeset renderer", async () => {
  const input = Buffer.from("%PDF-tectonic");
  const result = await finalizeRetypesetRenderer(input);
  assert.equal(result.buffer, input);
  assert.equal(result.effectiveRenderer, "tectonic");
  assert.equal(result.docxBuffer, null);
});

test("explicit LibreOffice renderer returns both PDF and editable DOCX", async () => {
  const input = Buffer.from("%PDF-intermediate");
  const output = Buffer.from("%PDF-libreoffice");
  const docx = Buffer.from("PK-docx");
  let received = null;
  const result = await finalizeRetypesetRenderer(input, {
    renderer: "libreoffice",
    signal: new AbortController().signal,
    libreOfficeGenerator: async (buffer, options) => {
      received = { buffer, options };
      return { buffer: output, docxBuffer: docx, metadata: { builder: "test" } };
    },
  });
  assert.equal(received.buffer, input);
  assert.equal(result.buffer, output);
  assert.equal(result.docxBuffer, docx);
  assert.equal(result.effectiveRenderer, "libreoffice");
  assert.deepEqual(result.rendererMetadata, { builder: "test" });
});

test("unknown or incomplete renderer output fails closed", async () => {
  await assert.rejects(
    () => finalizeRetypesetRenderer(Buffer.from("%PDF-x"), { renderer: "draw" }),
    /지원하지 않는/,
  );
  await assert.rejects(
    () => finalizeRetypesetRenderer(Buffer.from("%PDF-x"), {
      renderer: "libreoffice",
      libreOfficeGenerator: async () => ({ buffer: Buffer.from("%PDF-y") }),
    }),
    /출력 계약이 불완전/,
  );
});
