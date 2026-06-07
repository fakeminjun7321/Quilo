// translate_pdf.py 를 spawn 하는 Node 래퍼.
// hwpx-gen.js 와 동일한 Python 탐지 규칙(.venv 우선, PYTHON_BIN 존중)을 따른다.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "translate_pdf.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(venvPython)) return venvPython;
  const venvPython2 = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(venvPython2)) return venvPython2;
  return "python3";
}

const PYTHON = detectPython();

function runPy(args, { stdin = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [PY_SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out = [];
    const err = [];
    proc.stdout.on("data", (c) => out.push(c));
    proc.stderr.on("data", (c) => err.push(c));

    proc.on("error", (e) =>
      reject(
        new Error(
          `translate_pdf.py 실행 실패: ${e.message} (PYTHON_BIN=${PYTHON})`,
        ),
      ),
    );

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(err).toString("utf8").trim();
        return reject(
          new Error(
            `translate_pdf.py ${args[0]} 실패 (code ${code})${stderr ? ": " + stderr.slice(0, 600) : ""}`,
          ),
        );
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });

    if (signal) {
      if (signal.aborted) proc.kill("SIGKILL");
      else
        signal.addEventListener("abort", () => proc.kill("SIGKILL"), {
          once: true,
        });
    }

    try {
      if (stdin != null) proc.stdin.write(stdin);
    } catch {
      /* EPIPE if process already gone — close handler reports the real error */
    }
    proc.stdin.end();
  });
}

// Python(translate_pdf.py) 출력 JSON 파싱. 빈 출력/비-JSON 이면 "Unexpected end of
// JSON input" 같은 모호한 에러 대신 어느 명령에서 무엇이 왔는지 분명히 알려준다.
function parsePyJson(out, cmd) {
  const s = String(out || "").trim();
  if (!s) {
    throw new Error(
      `translate_pdf.py ${cmd}: 출력이 비어 있습니다(Python 실행/환경 문제일 수 있음).`,
    );
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    throw new Error(
      `translate_pdf.py ${cmd}: JSON 파싱 실패(${e.message}). 출력 앞부분: ${s.slice(0, 200)}`,
    );
  }
}

// PDF 에서 번역 대상 문단을 추출한다.
// → { page_count, scanned, blocks: [{ id, page, text }] }
async function extractBlocks(pdfPath, opts = {}) {
  const out = await runPy(["extract", pdfPath], opts);
  return parsePyJson(out, "extract");
}

// 번역문(id→한국어)을 원본 레이아웃에 끼워넣어 outPath 에 저장한다.
// → { ok, replaced, shrunk }
async function renderTranslated(pdfPath, outPath, fontPath, translations, opts = {}) {
  const out = await runPy(["render", pdfPath, outPath, fontPath], {
    ...opts,
    stdin: JSON.stringify({ translations }),
  });
  return parsePyJson(out, "render");
}

// 텍스트 레이어 유무만 빠르게 판정(스캔/이미지 PDF 라우팅용).
// → { page_count, text_chars, scanned }
async function analyzePdf(pdfPath, opts = {}) {
  const out = await runPy(["analyze", pdfPath], opts);
  return parsePyJson(out, "analyze");
}

// 페이지를 가독 PNG 타일로 렌더링(세로로 긴 페이지는 잘라서) outDir 에 저장.
// → { page_count, rendered_pages, tiles, truncated, files: [absPath...] }
async function rasterizePages(pdfPath, outDir, opts = {}) {
  const targetWidth = parseInt(opts.targetWidth || 1400, 10);
  const maxPages = parseInt(opts.maxPages || 20, 10);
  const out = await runPy(
    ["rasterize", pdfPath, outDir, String(targetWidth), String(maxPages)],
    opts,
  );
  return parsePyJson(out, "rasterize");
}

// 텍스트 PDF 를 페이지 범위 sub-PDF 들로 분할(재조판 병렬화용).
// → { page_count, chunks: [{ path, start, end }] }
async function splitPdf(pdfPath, outDir, opts = {}) {
  const per = parseInt(opts.pagesPerChunk || 5, 10);
  const out = await runPy(["split", pdfPath, outDir, String(per)], opts);
  return parsePyJson(out, "split");
}

// 텍스트 PDF 의 그림/도표 영역을 PNG 로 잘라 outDir 에 저장(재조판 시 그림 복원용).
// → { page_count, figures: [{ n, page, bbox, caption, file, w, h }] }
async function extractFigures(pdfPath, outDir, opts = {}) {
  const zoom = opts.zoom ? String(opts.zoom) : "3";
  const out = await runPy(["figures", pdfPath, outDir, zoom], opts);
  return parsePyJson(out, "figures");
}

module.exports = {
  extractBlocks,
  renderTranslated,
  analyzePdf,
  rasterizePages,
  splitPdf,
  extractFigures,
  PYTHON,
};
