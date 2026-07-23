// phys-inquiry HWPX 생성: Node에서 Python hwpx-gen.py 를 spawn 하고 JSON payload 전달.
// (phys-result/hwpx-gen.js 와 동일한 골격 — 차트·사진 클론 로직만 제거)

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "hwpx-gen.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  const venvPython2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venvPython2)) return venvPython2;
  return "python3";
}

const PYTHON = detectPython();

function cloneForHwpx(content) {
  const payload = JSON.parse(JSON.stringify(content));
  payload.__style = content.__style || "default";
  payload.__fontFace = content.__fontFace || content.font_face;
  payload.__allowHighlights = content.__allowHighlights !== false;
  return payload;
}

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
          `phys-inquiry hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
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
            `phys-inquiry hwpx-gen.py 종료 코드 ${code}\n${stderr.slice(0, 1000)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
    });

    // stdin 'error'(EPIPE 등)는 비동기 이벤트라 try/catch 로 안 잡힌다.
    // 핸들러가 없으면 uncaughtException 으로 서버가 죽으므로 반드시 등록.
    proc.stdin.on("error", (err) => {
      reject(
        new Error(
          `phys-inquiry hwpx-gen.py stdin 쓰기 실패(EPIPE 등): ${err.message}`,
        ),
      );
    });

    try {
      proc.stdin.write(JSON.stringify(cloneForHwpx(content)));
      proc.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { generateHwpx };
