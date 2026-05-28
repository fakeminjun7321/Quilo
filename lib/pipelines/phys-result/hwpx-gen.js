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

function cloneForHwpx(content) {
  const payload = JSON.parse(JSON.stringify(content));
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

  const sourceExperiments = Array.isArray(content.experiments)
    ? content.experiments
    : [];
  const targetExperiments = Array.isArray(payload.experiments)
    ? payload.experiments
    : [];
  sourceExperiments.forEach((exp, idx) => {
    if (exp?.chart?.pngBuffer && targetExperiments[idx]?.chart) {
      targetExperiments[idx].chart.png_base64 = toBase64(exp.chart.pngBuffer);
    }
  });

  return payload;
}

function generateHwpx(content) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [PY_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];

    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    proc.on("error", (err) => {
      reject(
        new Error(
          `phys-result hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
        ),
      );
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        reject(
          new Error(
            `phys-result hwpx-gen.py 종료 코드 ${code}\n${stderr.slice(0, 1000)}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks));
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
