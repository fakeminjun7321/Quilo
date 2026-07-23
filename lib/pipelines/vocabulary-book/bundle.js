"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const JSZip = require("jszip");
const { pythonBin } = require("./extract");

const RENDERER = path.join(__dirname, "render.py");

function safeName(value, fallback = "단어장") {
  const name = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return name || fallback;
}

function publicJson(content) {
  return JSON.parse(
    JSON.stringify(content, (key, value) => {
      if (key.startsWith("__")) return undefined;
      if (Buffer.isBuffer(value)) return undefined;
      return value;
    }),
  );
}

function renderPdf(inputPath, outputPath, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonBin(),
      [RENDERER, inputPath, outputPath, "--repo-root", process.cwd()],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const abort = () => child.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("작업이 중단되었습니다."));
      if (code !== 0) return reject(new Error(`단어장 PDF 조판 실패: ${stderr.trim() || stdout.trim()}`));
      resolve();
    });
  });
}

async function generateBundle(content, ctx = {}) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "quilo-vocab-bundle-"));
  const clean = publicJson(content);
  const base = safeName(clean.title || clean.book?.title || ctx.sourceFilename?.replace(/\.pdf$/i, ""));
  const jsonName = `${base}_vocabulary.json`;
  const pdfName = `${base}_vocabulary_book.pdf`;
  const jsonPath = path.join(tempDir, "data.json");
  const pdfPath = path.join(tempDir, "book.pdf");
  try {
    ctx.onProgress?.("🧾 단어장 PDF 조판 중 · 목차·발음 링크·색인 연결...");
    await fs.promises.writeFile(jsonPath, JSON.stringify(clean, null, 2) + "\n", "utf8");
    await renderPdf(jsonPath, pdfPath, { signal: ctx.signal });
    const pdf = await fs.promises.readFile(pdfPath);
    if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error("생성된 파일이 올바른 PDF가 아닙니다.");
    }
    const zip = new JSZip();
    zip.file(pdfName, pdf);
    zip.file(jsonName, JSON.stringify(clean, null, 2) + "\n");
    zip.file(
      "README.txt",
      [
        "Quilo 단어장 메이커",
        "",
        `- ${pdfName}: 목차, 단원 이동, 발음 링크, 단원 평가, 색인이 포함된 학습용 PDF`,
        `- ${jsonName}: 플래시카드 등에서 다시 사용할 수 있는 구조화 학습 데이터`,
        "",
        "업로드 원문에 실제로 나타난 표현만 서버 검증을 통과해 수록됩니다.",
      ].join("\n"),
    );
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    return { buffer, filename: `${base}_단어장.zip` };
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { safeName, publicJson, generateBundle };
