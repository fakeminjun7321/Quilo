// DOCX → HWPX 변환. pypandoc-hwpx(MIT, Pandoc AST 기반)를 spawn 한다.
//   docx → (pandoc) → AST → HWPX. 텍스트·제목·표(셀병합)·목록·이미지·굵게/기울임 보존.
//   레이아웃 정밀 재현이 아니라 '내용' 변환이며, HWPX 는 한컴오피스에서 열리고
//   거기서 .hwp 로 저장할 수 있다(HWP 바이너리 직접 출력은 오픈소스가 없음).
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { assertGeneratedOutputMagic } = require("../output-validate");
const DOCX_TO_HWPX_TIMEOUT_MS = Math.max(
  5000,
  parseInt(process.env.DOCX_TO_HWPX_TIMEOUT_MS || String(2 * 60 * 1000), 10),
);

// hwpx-gen.js / pdf-tool.js 와 동일한 Python 탐지(.venv 우선, PYTHON_BIN 존중).
function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const v1 = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(v1)) return v1;
  const v2 = path.resolve(__dirname, "../../.venv/bin/python3");
  if (fs.existsSync(v2)) return v2;
  return "python3";
}

// pandoc: 빌드 시 install-pandoc.sh 가 bin/pandoc 에 둔다. 없으면 PATH 의 pandoc.
function detectPandoc() {
  for (const p of [
    process.env.PANDOC_BIN,
    path.resolve(process.cwd(), "bin/pandoc"),
    path.resolve(__dirname, "../../bin/pandoc"),
  ]) {
    if (p && fs.existsSync(p)) return p;
  }
  return null; // PATH 에 의존
}

/**
 * DOCX 버퍼를 HWPX 버퍼로 변환한다.
 * @param {Buffer} docxBuffer
 * @returns {Promise<Buffer>} hwpx 바이트
 */
function convertDocxToHwpx(docxBuffer, { signal, timeoutMs = DOCX_TO_HWPX_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2h-"));
    const inPath = path.join(dir, "in.docx");
    const outPath = path.join(dir, "out.hwpx");
    const cleanup = () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    };
    try {
      fs.writeFileSync(
        inPath,
        assertGeneratedOutputMagic(docxBuffer, "docx", "DOCX input"),
      );
    } catch (e) {
      cleanup();
      return reject(e);
    }

    const env = { ...process.env };
    const pandoc = detectPandoc();
    if (pandoc) env.PYPANDOC_PANDOC = pandoc; // pypandoc/드라이버가 이 경로의 pandoc 사용

    // 수식 보존 드라이버: pandoc AST 의 수식을 {{EQ-LATEX:...}} 마커로 바꿔 pypandoc-hwpx
    // 에 넘기고, hwpx_equation_tool 로 한컴 수식 객체로 변환한다(수식이 빠지지 않게).
    const driver = path.resolve(__dirname, "docx_to_hwpx.py");
    const proc = spawn(detectPython(), [driver, inPath, outPath], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    const abort = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    };
    const err = [];
    proc.stdout.on("data", () => {});
    proc.stderr.on("data", (c) => err.push(c));
    proc.on("error", (e) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", abort);
      cleanup();
      reject(
        new Error(
          `변환기 실행 실패: ${e.message} (pandoc/pypandoc-hwpx 설치 확인)`,
        ),
      );
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener?.("abort", abort);
      if (timedOut) {
        cleanup();
        return reject(
          new Error(`DOCX→HWPX 변환이 제한 시간(${Math.round(timeoutMs / 1000)}초)을 초과했습니다.`),
        );
      }
      if (code !== 0 || !fs.existsSync(outPath)) {
        const log = Buffer.concat(err).toString("utf8").trim();
        cleanup();
        return reject(
          new Error(
            `DOCX→HWPX 변환 실패${log ? ": " + log.slice(-500) : " (code " + code + ")"}`,
          ),
        );
      }
      let buf;
      try {
        buf = assertGeneratedOutputMagic(
          fs.readFileSync(outPath),
          "hwpx",
          "DOCX→HWPX output",
        );
      } catch (e) {
        cleanup();
        return reject(e);
      }
      cleanup();
      resolve(buf);
    });
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
}

module.exports = { convertDocxToHwpx, detectPandoc };
