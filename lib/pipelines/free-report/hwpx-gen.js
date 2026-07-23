// 자유 보고서 HWPX 생성: Node에서 Python hwpx-gen.py 를 spawn 하고 JSON payload 전달.
// 차트 pngBuffer → png_base64, 업로드 사진 buffer → data_base64 로 옮긴다.

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

function toBase64(buffer) {
  if (!buffer) return "";
  if (Buffer.isBuffer(buffer)) return buffer.toString("base64");
  if (buffer?.type === "Buffer" && Array.isArray(buffer.data)) {
    return Buffer.from(buffer.data).toString("base64");
  }
  return "";
}

// chart.pngBuffer 는 non-enumerable 이라 JSON 클론에 안 실린다 —
// 원본/클론 트리를 나란히 걸으며 png_base64 로 옮긴다.
function syncChartPngs(orig, clone) {
  if (Array.isArray(orig) && Array.isArray(clone)) {
    orig.forEach((v, i) => syncChartPngs(v, clone[i]));
    return;
  }
  if (!orig || !clone || typeof orig !== "object" || typeof clone !== "object") {
    return;
  }
  if (orig.chart && typeof orig.chart === "object" && orig.chart.pngBuffer && clone.chart) {
    clone.chart.png_base64 = toBase64(orig.chart.pngBuffer);
  }
  for (const key of Object.keys(orig)) {
    syncChartPngs(orig[key], clone[key]);
  }
}

function cloneForHwpx(content) {
  const payload = JSON.parse(JSON.stringify(content));
  syncChartPngs(content, payload);
  payload.__style = content.__style || "default";
  payload.__fontFace = content.__fontFace || content.font_face;
  payload.__allowHighlights = content.__allowHighlights !== false;
  if (Array.isArray(content.__photos)) {
    payload.__photos = content.__photos.map((photo) => ({
      name: photo.name || "",
      mimetype: photo.mimetype || "",
      data_base64: toBase64(photo.buffer),
    }));
  }
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
          `free-report hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
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
            `free-report hwpx-gen.py 종료 코드 ${code}\n${stderr.slice(0, 1000)}`,
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
          `free-report hwpx-gen.py stdin 쓰기 실패(EPIPE 등): ${err.message}`,
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
