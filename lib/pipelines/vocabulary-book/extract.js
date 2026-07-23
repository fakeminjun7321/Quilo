"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const SCRIPT = path.join(__dirname, "extract.py");
const MAX_STDOUT = 24 * 1024 * 1024;

function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const local = path.join(process.cwd(), ".venv", "bin", "python3");
  return fs.existsSync(local) ? local : "python3";
}

function runPython(args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [SCRIPT, ...args], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => child.kill("SIGTERM");
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_STDOUT) {
        child.kill("SIGKILL");
        finish(new Error("PDF 텍스트가 너무 큽니다. 페이지 범위를 줄여 주세요."));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (settled) return;
      if (signal?.aborted) return finish(new Error("작업이 중단되었습니다."));
      let parsed;
      try {
        parsed = JSON.parse(stdout.trim() || "{}");
      } catch {
        return finish(new Error(`PDF 텍스트 추출 결과를 읽지 못했습니다. ${stderr.trim()}`));
      }
      if (code !== 0 || !parsed.ok) {
        return finish(new Error(parsed.error || stderr.trim() || "PDF 텍스트 추출에 실패했습니다."));
      }
      return finish(null, parsed);
    });
  });
}

async function extractPdfText(buffer, { pageRange = "", maxPages = 80, signal } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error("올바른 PDF 파일이 아닙니다.");
  }
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "quilo-vocab-extract-"));
  const inputPath = path.join(tempDir, "source.pdf");
  try {
    await fs.promises.writeFile(inputPath, buffer);
    return await runPython(
      [inputPath, "--pages", String(pageRange || ""), "--max-pages", String(maxPages)],
      { signal },
    );
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { extractPdfText, pythonBin };
