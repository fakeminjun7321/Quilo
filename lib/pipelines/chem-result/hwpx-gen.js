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

  if (Array.isArray(content.__photos)) {
    payload.__photos = content.__photos.map((photo) => ({
      name: photo.name || "",
      mimetype: photo.mimetype || "",
      data_base64: Buffer.from(photo.buffer || []).toString("base64"),
    }));
  }

  const sourceCharts = Array.isArray(content.data?.charts)
    ? content.data.charts
    : [];
  const targetCharts = Array.isArray(payload.data?.charts)
    ? payload.data.charts
    : [];
  sourceCharts.forEach((chart, idx) => {
    if (chart?.pngBuffer && targetCharts[idx]) {
      targetCharts[idx].png_base64 = Buffer.from(chart.pngBuffer).toString("base64");
    }
  });

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
          `chem-result hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
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
            `chem-result hwpx-gen.py 종료 코드 ${code}\n${stderr.slice(0, 1000)}`,
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
          `chem-result hwpx-gen.py stdin 쓰기 실패(EPIPE 등): ${err.message}`,
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
