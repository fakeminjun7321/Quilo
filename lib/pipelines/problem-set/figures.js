// problem-set 그림 추출 — Node ↔ Python(figures.py) 브리지.
//
// 소스 교재 PDF 에서 그림/도표/그래프를 잘라낸다. PyMuPDF(fitz) 만 쓰므로
// poppler 의존이 없다(Render 에 이미 설치된 pymupdf 사용).
//
// detect: 페이지의 내장 래스터 + 벡터 도형 군집을 후보 그림으로 잘라낸다.
//   → Claude 가 "이 후보 중 무엇이 N번 문제의 그림인지" 연결한다(정확 크롭).
// crop:   Claude 가 준 "페이지 + 분수 bbox" 영역만 잘라낸다(후보에 없을 때 폴백).

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const PY_SCRIPT = path.join(__dirname, "figures.py");

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const a = path.resolve(process.cwd(), ".venv/bin/python3");
  if (fs.existsSync(a)) return a;
  const b = path.resolve(__dirname, "../../../.venv/bin/python3");
  if (fs.existsSync(b)) return b;
  return "python3";
}

// 큰 PDF(많은 쪽·그림)는 분할·렌더에 시간이 걸려 기본 5분(env 로 조절).
const FIG_PY_TIMEOUT_MS = Math.max(
  30000,
  parseInt(process.env.PROBLEMSET_FIG_TIMEOUT_MS || String(5 * 60 * 1000), 10) ||
    5 * 60 * 1000,
);

// figures.py 에 JSON payload(stdin) 를 보내고 JSON(stdout) 을 받는다.
function runPy(payload, { signal, timeoutMs = FIG_PY_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(detectPython(), [PY_SCRIPT], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return reject(new Error(`figures.py 실행 실패: ${e.message}`));
    }
    const outChunks = [];
    const errChunks = [];
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      finish(reject, new Error("figures.py 시간 초과"));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        try {
          proc.kill("SIGKILL");
        } catch {}
      } else {
        signal.addEventListener(
          "abort",
          () => {
            try {
              proc.kill("SIGKILL");
            } catch {}
          },
          { once: true },
        );
      }
    }

    proc.stdout.on("data", (c) => outChunks.push(c));
    proc.stderr.on("data", (c) => errChunks.push(c));
    proc.on("error", (e) => finish(reject, new Error(`figures.py: ${e.message}`)));
    proc.on("close", (code) => {
      const out = Buffer.concat(outChunks).toString("utf8").trim();
      const err = Buffer.concat(errChunks).toString("utf8").trim();
      if (code !== 0 && !out) {
        return finish(
          reject,
          new Error(`figures.py 종료(code ${code}): ${err.slice(-400)}`),
        );
      }
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        return finish(
          reject,
          new Error(`figures.py 출력 파싱 실패: ${(out || err).slice(-400)}`),
        );
      }
      if (!parsed.ok) {
        return finish(reject, new Error(parsed.error || "figures.py 실패"));
      }
      finish(resolve, parsed);
    });

    proc.stdin.on("error", () => {});
    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch (e) {
      finish(reject, e);
    }
  });
}

function toCandidate(c) {
  return {
    id: String(c.id),
    page: c.page | 0,
    kind: c.kind,
    bbox: c.bbox,
    w: c.w | 0,
    h: c.h | 0,
    buffer: Buffer.from(c.png_base64 || "", "base64"),
  };
}

/**
 * 소스 PDF 에서 후보 그림을 자동 검출해 PNG 버퍼로 돌려준다.
 * @returns {Promise<{pageCount:number, candidates:Array<{id,page,kind,bbox,w,h,buffer}>}>}
 */
async function detectFigures(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return { pageCount: 0, candidates: [] };
  }
  const res = await runPy(
    {
      mode: "detect",
      pdf_b64: pdfBuffer.toString("base64"),
      dpi: opts.dpi || 200,
      max_candidates: opts.maxCandidates || 28,
    },
    opts,
  );
  return {
    pageCount: res.page_count || 0,
    candidates: (res.candidates || []).map(toCandidate),
  };
}

/**
 * Claude 가 준 {id,page,bbox(분수 L,T,R,B)} 영역만 잘라 PNG 버퍼로 돌려준다.
 * @returns {Promise<Array<{id,page,w,h,buffer}>>}
 */
async function cropRegions(pdfBuffer, regions, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || !Array.isArray(regions) || !regions.length) {
    return [];
  }
  const res = await runPy(
    {
      mode: "crop",
      pdf_b64: pdfBuffer.toString("base64"),
      dpi: opts.dpi || 220,
      regions,
    },
    opts,
  );
  return (res.crops || []).map((c) => ({
    id: String(c.id),
    page: c.page | 0,
    w: c.w | 0,
    h: c.h | 0,
    buffer: Buffer.from(c.png_base64 || "", "base64"),
  }));
}

/**
 * 병렬 추출용: 소스 PDF 를 chunk_pages 쪽씩 잘라 sub-PDF + chunk별 후보 그림으로.
 * @returns {Promise<{pageCount:number, chunkPages:number, chunks:Array<{
 *   index:number, start:number, end:number, pdfB64:string, pdfBuffer:Buffer,
 *   candidates:Array<{id,page,globalPage,kind,bbox,w,h,buffer}> }>}>}
 */
async function prepareChunks(pdfBuffer, opts = {}) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    return { pageCount: 0, chunkPages: 0, chunks: [] };
  }
  const res = await runPy(
    {
      mode: "prepare",
      pdf_b64: pdfBuffer.toString("base64"),
      chunk_pages: opts.chunkPages || 4,
      dpi: opts.dpi || 200,
      max_candidates: opts.maxCandidates || 8,
    },
    opts,
  );
  return {
    pageCount: res.page_count || 0,
    chunkPages: res.chunk_pages || 0,
    chunks: (res.chunks || []).map((ch) => ({
      index: ch.index | 0,
      start: ch.start | 0,
      end: ch.end | 0,
      pdfB64: ch.pdf_b64 || "",
      pdfBuffer: Buffer.from(ch.pdf_b64 || "", "base64"),
      candidates: (ch.candidates || []).map((c) => ({
        id: String(c.id),
        page: c.page | 0,
        globalPage: c.global_page | 0,
        kind: c.kind,
        bbox: c.bbox,
        w: c.w | 0,
        h: c.h | 0,
        buffer: Buffer.from(c.png_base64 || "", "base64"),
      })),
    })),
  };
}

module.exports = { detectFigures, cropRegions, prepareChunks };
