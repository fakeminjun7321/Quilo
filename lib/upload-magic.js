"use strict";

const ZIP_SIGNATURES = [
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from([0x50, 0x4b, 0x05, 0x06]),
  Buffer.from([0x50, 0x4b, 0x07, 0x08]),
];
const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function extensionOf(name) {
  const match = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : "";
}

function startsWith(buffer, signature) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= signature.length &&
    buffer.subarray(0, signature.length).equals(signature);
}

function isZip(buffer) {
  return ZIP_SIGNATURES.some((signature) => startsWith(buffer, signature));
}

function isPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return false;
  return buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf("%PDF-") >= 0;
}

function isJpeg(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 3 &&
    buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function isGif(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6) return false;
  const signature = buffer.subarray(0, 6).toString("ascii");
  return signature === "GIF87a" || signature === "GIF89a";
}

function isWebp(buffer) {
  return Buffer.isBuffer(buffer) &&
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
}

const BINARY_CHECKS = new Map([
  ["pdf", isPdf],
  ["docx", isZip],
  ["xlsx", isZip],
  ["hwpx", isZip],
  ["cap", isZip],
  ["zip", isZip],
  ["xls", (buffer) => startsWith(buffer, OLE_SIGNATURE)],
  ["png", (buffer) => startsWith(buffer, PNG_SIGNATURE)],
  ["jpg", isJpeg],
  ["jpeg", isJpeg],
  ["gif", isGif],
  ["webp", isWebp],
]);

function assertUploadMagic(file) {
  const ext = extensionOf(file?.originalname || file?.name);
  const check = BINARY_CHECKS.get(ext);
  if (!check || check(file?.buffer)) return;

  const error = new Error(
    `파일 내용과 확장자가 일치하지 않습니다: ${String(file?.originalname || file?.name || "파일")}`,
  );
  error.code = "INVALID_UPLOAD_MAGIC";
  error.status = 400;
  error.expose = true;
  throw error;
}

function assertUploadsMagic(files) {
  for (const file of files || []) assertUploadMagic(file);
}

module.exports = {
  assertUploadMagic,
  assertUploadsMagic,
  extensionOf,
};
