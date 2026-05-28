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
          `hwpx-gen.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`,
        ),
      );
    });

    proc.on("close", (code) => {
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
