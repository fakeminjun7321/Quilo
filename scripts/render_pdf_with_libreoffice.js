#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  generateLibreOfficePdf,
} = require("../lib/pipelines/pdf-translate/libreoffice-gen");

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: node scripts/render_pdf_with_libreoffice.js " +
      "--input translated.pdf --output-pdf clean.pdf [options]\n" +
      "  --output-docx clean.docx       Editable Writer source (default: PDF basename.docx)\n" +
      "  --metadata build.json          Build metadata (default: PDF basename.json)\n" +
      "  --start-page N                 Zero-based first page (default: 0)\n" +
      "  --end-page N                   Zero-based exclusive end page\n" +
      "  --page-size source|a4|letter   Output page size (default: source)\n" +
      "  --force                        Replace existing regular output files\n",
  );
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = { force: false, pageSize: "source" };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) usage(`${flag} 값이 필요합니다.`);
    return next;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--input") options.input = value(i++, arg);
    else if (arg === "--output-pdf") options.outputPdf = value(i++, arg);
    else if (arg === "--output-docx") options.outputDocx = value(i++, arg);
    else if (arg === "--metadata") options.metadata = value(i++, arg);
    else if (arg === "--start-page") options.startPage = Number(value(i++, arg));
    else if (arg === "--end-page") options.endPage = Number(value(i++, arg));
    else if (arg === "--page-size") options.pageSize = value(i++, arg);
    else if (arg === "--force") options.force = true;
    else usage(`알 수 없는 옵션: ${arg}`);
  }
  if (!options.input || !options.outputPdf) usage("--input과 --output-pdf가 필요합니다.");
  if (!["source", "a4", "letter"].includes(options.pageSize)) {
    usage("--page-size는 source, a4, letter 중 하나여야 합니다.");
  }
  return options;
}

function regularInput(filePath) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`입력은 심볼릭 링크가 아닌 일반 파일이어야 합니다: ${resolved}`);
  }
  return resolved;
}

function outputPaths(options) {
  const pdf = path.resolve(options.outputPdf);
  const stem = pdf.replace(/\.pdf$/i, "");
  if (stem === pdf) throw new Error("--output-pdf는 .pdf 파일이어야 합니다.");
  return {
    pdf,
    docx: path.resolve(options.outputDocx || `${stem}.docx`),
    metadata: path.resolve(options.metadata || `${stem}.json`),
  };
}

function assertWritableTarget(filePath, force) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (!force || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`기존 출력 파일을 덮어쓰지 않습니다: ${filePath}`);
  }
}

function writeAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, filePath);
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = regularInput(options.input);
  const outputs = outputPaths(options);
  for (const target of Object.values(outputs)) assertWritableTarget(target, options.force);

  const result = await generateLibreOfficePdf(input, {
    startPage: options.startPage,
    endPage: options.endPage,
    pageSize: options.pageSize,
    onProgress: (message) => process.stderr.write(`${message}\n`),
  });
  const metadata = {
    ...result.metadata,
    input,
    input_sha256: sha256(fs.readFileSync(input)),
    output_pdf: outputs.pdf,
    output_pdf_sha256: sha256(result.buffer),
    output_docx: outputs.docx,
    output_docx_sha256: sha256(result.docxBuffer),
  };
  writeAtomic(outputs.pdf, result.buffer);
  writeAtomic(outputs.docx, result.docxBuffer);
  writeAtomic(outputs.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${outputs.pdf}\n${outputs.docx}\n${outputs.metadata}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, outputPaths, assertWritableTarget };
