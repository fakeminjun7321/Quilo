"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertUploadMagic,
  assertUploadsMagic,
} = require("../../lib/upload-magic");

function file(name, bytes) {
  return { originalname: name, buffer: Buffer.from(bytes) };
}

test("accepts the supported binary container and image signatures", () => {
  const fixtures = [
    file("manual.pdf", "\n%PDF-1.7\n"),
    file("report.docx", [0x50, 0x4b, 0x03, 0x04]),
    file("data.xlsx", [0x50, 0x4b, 0x05, 0x06]),
    file("capture.cap", [0x50, 0x4b, 0x07, 0x08]),
    file("legacy.xls", [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    file("plot.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    file("photo.jpg", [0xff, 0xd8, 0xff, 0xe0]),
    file("scan.gif", "GIF89a"),
    file("image.webp", "RIFF1234WEBP"),
  ];
  assert.doesNotThrow(() => assertUploadsMagic(fixtures));
});

test("rejects a filename-only PDF or image disguise before parser entry", () => {
  for (const name of ["manual.pdf", "report.docx", "photo.png", "data.xls"]) {
    assert.throws(
      () => assertUploadMagic(file(name, "plain text payload")),
      (error) => error.code === "INVALID_UPLOAD_MAGIC" && error.status === 400,
    );
  }
});

test("leaves text-based formats to their bounded text parsers", () => {
  assert.doesNotThrow(() => assertUploadsMagic([
    file("notes.txt", "hello"),
    file("table.csv", "a,b\n1,2"),
    file("readme.md", "# title"),
  ]));
});
