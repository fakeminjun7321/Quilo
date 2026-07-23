// 독서활동 기록지 병합: 단권 .hwpx 버퍼 배열 → 멀티섹션 .hwpx 하나.
// Node에서 Python hwpx-merge.py 를 spawn 하고 base64 JSON 을 stdin 으로 넘긴다.
// (hwpx-gen.js 와 동일 골격 — 구글폼 '교사 기준 하나의 파일 제출' 요건용)

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "hwpx-merge.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  const venvPython2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venvPython2)) return venvPython2;
  return "python3";
}

const PYTHON = detectPython();

function mergeHwpx(buffers, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (!Array.isArray(buffers) || !buffers.length) {
      reject(new Error("병합할 hwpx 버퍼가 없습니다."));
      return;
    }
    const proc = spawn(PYTHON, [PY_SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    const killOnAbort = () => proc.kill("SIGKILL");
    if (signal) {
      if (signal.aborted) killOnAbort();
      else signal.addEventListener("abort", killOnAbort, { once: true });
    }

    proc.on("error", (err) => {
      reject(new Error(`hwpx-merge.py 실행 실패: ${err.message} (PYTHON_BIN=${PYTHON})`));
    });
    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", killOnAbort);
      if (signal?.aborted) return reject(new Error("HWPX merge aborted."));
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        return reject(new Error(`hwpx-merge.py 종료 코드 ${code}\n${stderr.slice(0, 800)}`));
      }
      resolve(Buffer.concat(stdoutChunks));
    });
    proc.stdin.on("error", (err) => {
      reject(new Error(`hwpx-merge.py stdin 쓰기 실패: ${err.message}`));
    });
    try {
      proc.stdin.write(
        JSON.stringify({ files: buffers.map((b) => b.toString("base64")) }),
      );
      proc.stdin.end();
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { mergeHwpx };
