const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "hwpx-gen.py");

// Render 빌드 시 package.json postinstall이 프로젝트 루트에 .venv를 만들고
// python-hwpx + lxml을 거기 설치한다. 그 venv의 python을 우선 사용하고,
// 없으면 PYTHON_BIN 환경변수, 마지막엔 system python3로 폴백.
function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  // server.js가 프로젝트 루트에서 실행된다고 가정
  const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  // hwpx-gen.js 기준 상대경로로도 한 번 더
  const venvPython2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venvPython2)) return venvPython2;
  return "python3";
}

const PYTHON = detectPython();

function cloneForHwpx(content) {
  const payload = JSON.parse(JSON.stringify(content));
  payload.__style = content.__style || content.style || "default";
  payload.__fontFace = content.__fontFace || content.font_face;
  payload.__allowHighlights = content.__allowHighlights !== false;
  // AI 생성 개념도(__figures)는 비열거 Buffer 라 JSON.stringify 로 빠진다 — base64 로 직접 옮긴다.
  if (Array.isArray(content.__figures)) {
    payload.__figures = content.__figures
      .filter((f) => f && Buffer.isBuffer(f.buffer) && f.buffer.length)
      .map((f) => ({
        caption: f.caption || "",
        data_base64: f.buffer.toString("base64"),
      }));
  }
  return payload;
}

/**
 * Generate an HWPX buffer from report content by spawning hwpx-gen.py.
 *
 * The python script reads JSON from stdin and writes raw HWPX bytes to
 * stdout. Stderr carries python-hwpx's manifest fallback notices — they
 * are non-fatal and only logged when the process exits non-zero.
 *
 * @param {Object} content  Report JSON (same shape as docx-gen.js consumes)
 * @returns {Promise<Buffer>}
 */
function generateHwpx(content, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [PY_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const killOnAbort = () => proc.kill("SIGKILL");
    if (signal) {
      if (signal.aborted) killOnAbort();
      else signal.addEventListener("abort", killOnAbort, { once: true });
    }

    proc.on("error", (err) => {
      reject(
        new Error(
          `hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
        ),
      );
    });

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", killOnAbort);
      if (signal?.aborted) {
        reject(new Error("HWPX generation aborted."));
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(
          new Error(
            `hwpx-gen.py 종료 코드 ${code}\n${stderr.slice(0, 1000)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });

    // stdin 'error'(EPIPE 등)는 비동기 이벤트라 아래 try/catch로 안 잡힌다.
    // 핸들러가 없으면 uncaughtException으로 서버 전체가 죽으므로 반드시 등록한다.
    proc.stdin.on("error", (err) => {
      reject(
        new Error(
          `chem-pre hwpx-gen.py stdin 쓰기 실패(EPIPE 등): ${err.message}`,
        ),
      );
    });

    // feed the JSON to stdin
    try {
      proc.stdin.write(JSON.stringify(cloneForHwpx(content)));
      proc.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generateHwpx };
