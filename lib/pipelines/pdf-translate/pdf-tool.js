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

function parseJsonObjectAt(s, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
      if (depth < 0) {
        return null;
      }
    }
  }
  return null;
}

function extractLastJsonObject(s) {
  let last = null;
  let lastError = null;

  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== "{") continue;
    const candidate = parseJsonObjectAt(s, i);
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        last = value;
        i += candidate.length - 1;
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (last) return last;
  throw new Error(
    lastError
      ? `완성된 JSON 객체 후보를 찾았지만 파싱에 실패했습니다(${lastError.message}).`
      : "완성된 JSON 객체를 찾지 못했습니다.",
  );
}

function previewOutput(s) {
  if (s.length <= 420) return s;
  return `${s.slice(0, 240)} ... ${s.slice(-160)}`;
}

// Python(translate_pdf.py) 출력 JSON 파싱. 기본은 stdout 전체를 엄격하게 파싱하고,
// MuPDF native 경고가 stdout 에 섞인 경우 마지막 완성 JSON 객체만 quote/escape-aware 로 복구한다.
function parsePyJson(out, cmd) {
  const s = String(out || "").trim();
  if (!s) {
    throw new Error(
      `translate_pdf.py ${cmd}: 출력이 비어 있습니다(Python 실행/환경 문제일 수 있음).`,
    );
  }
  try {
    return JSON.parse(s);
  } catch (strictError) {
    try {
      return extractLastJsonObject(s);
    } catch (extractError) {
      throw new Error(
        `translate_pdf.py ${cmd}: JSON 파싱 실패(${strictError.message}); ` +
          `stdout 오염 복구 실패(${extractError.message}). 출력 미리보기: ${previewOutput(s)}`,
      );
    }
  }
}

// PDF 에서 번역 대상 문단을 추출한다.
// → { page_count, scanned, page_block_count,
//     blocks: [{ id, page, text, kind? }] }
// kind=outline/metadata entries are deterministic virtual reader-UI blocks.
async function extractBlocks(pdfPath, opts = {}) {
  const out = await runPy(["extract", pdfPath], opts);
  return parsePyJson(out, "extract");
}

// 번역문(id→한국어)을 원본 레이아웃에 끼워넣어 outPath 에 저장한다.
// → { ok, expected, replaced, drawn, page_expected, font_expected,
//     virtual_replaced, shrunk, overflow, failed, overflow_ids, failed_ids,
//     min_font(base), min_glyph_font(sub/sup 실제 포함) }
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

// 페이지별 텍스트층 덤프 — 스캔본의 '숨은' OCR 텍스트층을 비전 OCR 의 참고 힌트로.
// → { page_count, pages: [{ page, text }] }
async function extractPageTexts(pdfPath, opts = {}) {
  const out = await runPy(["pagetext", pdfPath], opts);
  return parsePyJson(out, "pagetext");
}

// 페이지를 가독 PNG 타일로 렌더링(세로로 긴 페이지는 잘라서) outDir 에 저장.
// → { page_count, rendered_pages, tiles, truncated, files: [absPath...],
//     pages: [{ index, width, height, rotation,
//               tiles: [{ index, bbox, width, height, file }] }] }
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
// 전체 문서에 한 번만 존재하는 목차/문서정보 번역 블록은 chunk 밖으로 분리한다.
// → { page_count, chunks: [{ path, start, end }], virtual_blocks: [...] }
async function splitPdf(pdfPath, outDir, opts = {}) {
  const per = parseInt(opts.pagesPerChunk || 5, 10);
  const out = await runPy(["split", pdfPath, outDir, String(per)], opts);
  return parsePyJson(out, "split");
}

// 텍스트 PDF 의 그림/도표 영역을 PNG 로 잘라 outDir 에 저장(재조판 시 그림 복원용).
// → { page_count, figures: [{ id, n, page, bbox, caption, file, w, h }],
//     figure_manifest: { complete, candidate_ids, discovered_ids, emitted_ids,
//                        truncated_ids, failed_ids, failures } }
function assertCompleteFigureExtraction(meta, context = "텍스트 PDF 그림 추출") {
  const fail = (message, details = {}) => {
    const error = new Error(`${context}: ${message}`);
    error.code = "PDF_FIGURE_EXTRACTION_INCOMPLETE";
    error.details = details;
    throw error;
  };
  if (!meta || typeof meta !== "object") {
    fail("결과 JSON 객체가 없습니다.");
  }
  const manifest = meta.figure_manifest;
  if (!manifest || typeof manifest !== "object") {
    fail("완전성 manifest가 없어 누락 여부를 판정할 수 없습니다.");
  }
  const keys = [
    "candidate_ids",
    "discovered_ids",
    "emitted_ids",
    "truncated_ids",
    "failed_ids",
  ];
  for (const key of keys) {
    if (!Array.isArray(manifest[key])) {
      fail(`manifest.${key}가 배열이 아닙니다.`, { manifest });
    }
  }
  const normalized = Object.fromEntries(
    keys.map((key) => [key, manifest[key].map((id) => String(id))]),
  );
  const duplicateIds = Object.fromEntries(
    keys.map((key) => {
      const seen = new Set();
      const dup = [];
      for (const id of normalized[key]) {
        if (seen.has(id) && !dup.includes(id)) dup.push(id);
        seen.add(id);
      }
      return [key, dup];
    }),
  );
  const duplicateSummary = Object.entries(duplicateIds).filter(
    ([, ids]) => ids.length,
  );
  if (duplicateSummary.length) {
    fail("manifest에 중복 occurrence ID가 있습니다.", { duplicateIds });
  }

  const candidate = new Set(normalized.candidate_ids);
  const discovered = new Set(normalized.discovered_ids);
  const emitted = new Set(normalized.emitted_ids);
  const figures = Array.isArray(meta.figures) ? meta.figures : null;
  if (!figures) fail("figures가 배열이 아닙니다.", { manifest });
  const figureIds = figures.map((f) => String(f && f.id));
  const missingCandidateIds = [...discovered].filter((id) => !candidate.has(id));
  const unresolvedIds = [...discovered].filter((id) => !emitted.has(id));
  const unexpectedEmittedIds = [...emitted].filter((id) => !discovered.has(id));
  const missingFigureRecords = [...emitted].filter((id) => !figureIds.includes(id));
  const unexpectedFigureRecords = figureIds.filter((id) => !emitted.has(id));
  const badFigureRecords = figures
    .filter(
      (f) =>
        !f ||
        f.id == null ||
        !Number.isInteger(Number(f.n)) ||
        Number(f.n) <= 0 ||
        !String(f.file || "").trim(),
    )
    .map((f) => (f && f.id != null ? String(f.id) : "unknown"));
  const truncatedIds = normalized.truncated_ids;
  const failedIds = normalized.failed_ids;
  if (
    manifest.complete !== true ||
    truncatedIds.length ||
    failedIds.length ||
    missingCandidateIds.length ||
    unresolvedIds.length ||
    unexpectedEmittedIds.length ||
    missingFigureRecords.length ||
    unexpectedFigureRecords.length ||
    badFigureRecords.length ||
    figures.length !== emitted.size
  ) {
    const ids = [...new Set([...truncatedIds, ...failedIds, ...unresolvedIds])];
    fail(
      `불완전한 그림 추출을 감지했습니다${ids.length ? ` (ID: ${ids.join(", ")})` : ""}. ` +
        "부분 그림만 넣은 재조판본은 생성하지 않습니다.",
      {
        manifest,
        missingCandidateIds,
        unresolvedIds,
        unexpectedEmittedIds,
        missingFigureRecords,
        unexpectedFigureRecords,
        badFigureRecords,
      },
    );
  }
  return meta;
}

async function extractFigures(pdfPath, outDir, opts = {}) {
  const zoom = opts.zoom ? String(opts.zoom) : "3";
  const maxFigures = opts.maxFigures ? String(opts.maxFigures) : "80";
  const out = await runPy(["figures", pdfPath, outDir, zoom, maxFigures], opts);
  return assertCompleteFigureExtraction(
    parsePyJson(out, "figures"),
    "translate_pdf.py figures",
  );
}

// 여러 sub-PDF 를 partPaths 순서대로 이어붙여 outPath 에 저장(대용량 병렬 번역 결과 병합).
// sourcePdf를 주면 원본 페이지 object identity를 유지한 채 번역 page dictionary만 교체하고,
// 원본 outline/문서정보를 translations로 한 번만 번역·복원한 뒤 reopen 검증한다.
// → { ok, page_count, parts, structure_restored, virtual_replaced, ... }
async function mergePdf(outPath, partPaths, opts = {}) {
  const {
    sourcePdf = null,
    translations = null,
    partManifest = null,
    ...runOptions
  } = opts;
  const stdin = sourcePdf
    ? JSON.stringify({
        source_pdf: sourcePdf,
        translations: translations || {},
        part_manifest: partManifest,
      })
    : null;
  const out = await runPy(["merge", outPath, ...partPaths], {
    ...runOptions,
    stdin,
  });
  return parsePyJson(out, "merge");
}

module.exports = {
  extractBlocks,
  renderTranslated,
  analyzePdf,
  extractPageTexts,
  rasterizePages,
  splitPdf,
  extractFigures,
  assertCompleteFigureExtraction,
  mergePdf,
  PYTHON,
};
