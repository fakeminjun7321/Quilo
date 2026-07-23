"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PYTHON = process.env.PYTHON_BIN || path.join(process.cwd(), ".venv", "bin", "python3");
const SCRIPT = path.join(__dirname, "..", "equation", "hwpx_batch_convert.py");

function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function safeOutputName(name) {
  const base = path.basename(String(name || "document.hwpx")).replace(/\.hwpx$/i, "");
  const safe = base.replace(/[\\/:*?"<>|]+/g, "_").trim() || "document";
  return `${safe}_수식변환.hwpx`;
}

async function convertHwpxEquations(buffer, { filename = "document.hwpx", mode = "all" } = {}) {
  if (!isZip(buffer)) throw new Error("올바른 HWPX(ZIP) 파일이 아닙니다.");
  if (!/\.hwpx$/i.test(filename)) throw new Error(".hwpx 파일만 지원합니다.");
  const normalizedMode = ["all", "latex", "placeholders"].includes(mode) ? mode : "all";
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quilo-hwpx-eq-"));
  const inputPath = path.join(tempDir, "input.hwpx");
  const outputPath = path.join(tempDir, "output.hwpx");
  try {
    await fs.writeFile(inputPath, buffer);
    const { stdout } = await execFileAsync(
      PYTHON,
      [SCRIPT, inputPath, outputPath, "--mode", normalizedMode],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
    );
    const result = JSON.parse(String(stdout || "{}").trim());
    const output = await fs.readFile(outputPath);
    if (!isZip(output)) throw new Error("변환 결과가 올바른 HWPX 파일이 아닙니다.");
    return {
      buffer: output,
      filename: safeOutputName(filename),
      stats: {
        detected: Number(result.detected) || 0,
        equations: Number(result.equations) || 0,
        sectionsChanged: Number(result.sections_changed) || 0,
      },
    };
  } catch (error) {
    const detail = String(error.stderr || error.message || error).trim().slice(0, 800);
    throw new Error(`HWPX 수식 변환 실패: ${detail}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

module.exports = { convertHwpxEquations, safeOutputName };
