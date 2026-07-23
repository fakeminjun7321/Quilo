"use strict";

// Clean-reading PDF reflow orchestration:
// translated PDF -> fresh DOCX (pdf2docx IR + python-docx) -> LibreOffice PDF.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { assertGeneratedOutputMagic } = require("../../output-validate");
const { convertOfficeToPdf } = require("./libreoffice-pdf");
const { createFifoSemaphore, parseConcurrency } = require("./resource-gate");

const BUILDER_SCRIPT = path.join(__dirname, "libreoffice-docx.py");
const DEFAULT_BUILD_TIMEOUT_MS = 20 * 60 * 1000;
const LOG_TAIL_LIMIT = 64 * 1024;
let processWideLibreOfficeGate = null;

function getLibreOfficeGate() {
  if (!processWideLibreOfficeGate) {
    processWideLibreOfficeGate = createFifoSemaphore(parseConcurrency(
      process.env.PDF_LIBREOFFICE_GLOBAL_CONCURRENCY,
      1,
    ));
  }
  return processWideLibreOfficeGate;
}

class LibreOfficeGenerationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "LibreOfficeGenerationError";
    this.code = code;
    this.details = details;
  }
}

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(__dirname, "../../../.venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.resolve(__dirname, "../../../.venv/bin/python"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "python3";
}

function normalizeTimeout(value) {
  const configured = value == null
    ? process.env.PDF_LIBREOFFICE_DOCX_TIMEOUT_MS
    : value;
  if (configured == null || String(configured).trim() === "") return DEFAULT_BUILD_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new LibreOfficeGenerationError(
      "LibreOffice DOCX 빌드 제한 시간은 0보다 큰 밀리초 값이어야 합니다.",
      "LIBREOFFICE_DOCX_TIMEOUT_INVALID",
      { timeoutMs: configured },
    );
  }
  return Math.floor(parsed);
}

function normalizePageRange(options) {
  // Public API is zero-based and end-exclusive: [startPage, endPage).
  const startPage = options.startPage == null ? 0 : Number(options.startPage);
  const endPage = options.endPage == null ? null : Number(options.endPage);
  if (!Number.isSafeInteger(startPage) || startPage < 0) {
    throw new LibreOfficeGenerationError(
      "startPage는 0 이상의 정수여야 합니다(0-based).",
      "LIBREOFFICE_PAGE_RANGE_INVALID",
      { startPage: options.startPage },
    );
  }
  if (endPage != null && (!Number.isSafeInteger(endPage) || endPage <= startPage)) {
    throw new LibreOfficeGenerationError(
      "endPage는 startPage보다 큰 정수여야 합니다(0-based, exclusive).",
      "LIBREOFFICE_PAGE_RANGE_INVALID",
      { startPage, endPage: options.endPage },
    );
  }
  return { startPage, endPage };
}

function createAbortError(signal) {
  const reason = signal && signal.reason;
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : "LibreOffice 재조판 작업이 취소되었습니다.",
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

function appendTail(previous, chunk) {
  const next = Buffer.concat([previous, Buffer.from(chunk)]);
  return next.length <= LOG_TAIL_LIMIT ? next : next.subarray(next.length - LOG_TAIL_LIMIT);
}

function killProcessTree(child) {
  if (!child) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to direct child kill.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // close/error owns settlement
  }
}

function inputBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

async function readTranslatedPdf(input) {
  const direct = inputBuffer(input);
  let buffer;
  if (direct) {
    buffer = direct;
  } else if (typeof input === "string" && input.trim()) {
    const sourcePath = path.resolve(input);
    let stat;
    try {
      stat = await fsp.stat(sourcePath);
    } catch (error) {
      throw new LibreOfficeGenerationError(
        `번역 PDF를 읽을 수 없습니다: ${error.message}`,
        "LIBREOFFICE_SOURCE_UNREADABLE",
        { sourcePath },
      );
    }
    if (!stat.isFile()) {
      throw new LibreOfficeGenerationError(
        "번역 PDF 입력 경로는 일반 파일이어야 합니다.",
        "LIBREOFFICE_SOURCE_INVALID",
        { sourcePath },
      );
    }
    buffer = await fsp.readFile(sourcePath);
  } else {
    throw new LibreOfficeGenerationError(
      "번역 PDF 버퍼 또는 파일 경로가 필요합니다.",
      "LIBREOFFICE_SOURCE_MISSING",
    );
  }
  try {
    return assertGeneratedOutputMagic(buffer, "pdf", "LibreOffice reflow source PDF");
  } catch (error) {
    throw new LibreOfficeGenerationError(
      `번역 PDF 입력이 올바르지 않습니다: ${error.message}`,
      "LIBREOFFICE_SOURCE_INVALID",
      { cause: error.message },
    );
  }
}

function builderArgs(inputPath, docxPath, metadataPath, options, pageRange) {
  const args = [
    BUILDER_SCRIPT,
    inputPath,
    docxPath,
    "--metadata",
    metadataPath,
    "--page-size",
    String(options.pageSize || "source"),
    "--font-face",
    String(options.fontFace || "NanumGothic"),
    "--start-page",
    String(pageRange.startPage),
  ];
  if (pageRange.endPage != null) args.push("--end-page", String(pageRange.endPage));
  if (options.pageWidthPt != null) args.push("--page-width-pt", String(options.pageWidthPt));
  if (options.pageHeightPt != null) args.push("--page-height-pt", String(options.pageHeightPt));
  if (options.marginPt != null) args.push("--margin-pt", String(options.marginPt));
  if (options.bodySizePt != null) args.push("--body-size-pt", String(options.bodySizePt));
  if (options.clipDpi != null) args.push("--clip-dpi", String(options.clipDpi));
  if (options.maxPages != null) args.push("--max-pages", String(options.maxPages));
  return args;
}

function runBuilder(args, { cwd, homeDir, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(createAbortError(signal));
    const python = detectPython();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let child;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
    };

    try {
      child = spawn(python, args, {
        cwd,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          HOME: homeDir,
          TMPDIR: cwd,
          XDG_CACHE_HOME: path.join(homeDir, ".cache"),
          XDG_CONFIG_HOME: path.join(homeDir, ".config"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      return reject(new LibreOfficeGenerationError(
        `DOCX 빌더 실행에 실패했습니다: ${error.message}`,
        "LIBREOFFICE_DOCX_SPAWN_FAILED",
        { python },
      ));
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    child.stdout.on("data", (chunk) => {
      stdout = appendTail(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk);
    });
    child.once("error", (error) => {
      settle(reject, new LibreOfficeGenerationError(
        `DOCX 빌더 실행에 실패했습니다: ${error.message}`,
        "LIBREOFFICE_DOCX_SPAWN_FAILED",
        { python },
      ));
    });
    child.once("close", (code, closeSignal) => {
      const logs = {
        stdout: stdout.toString("utf8").trim().slice(-2000),
        stderr: stderr.toString("utf8").trim().slice(-2000),
      };
      if (aborted) return settle(reject, createAbortError(signal));
      if (timedOut) {
        return settle(reject, new LibreOfficeGenerationError(
          `LibreOffice DOCX 빌드가 제한 시간(${timeoutMs}ms)을 초과했습니다.`,
          "LIBREOFFICE_DOCX_TIMEOUT",
          { timeoutMs, ...logs },
        ));
      }
      if (code !== 0) {
        return settle(reject, new LibreOfficeGenerationError(
          `LibreOffice DOCX 빌드가 실패했습니다 (code ${code}${closeSignal ? `, signal ${closeSignal}` : ""}).`,
          "LIBREOFFICE_DOCX_BUILD_FAILED",
          { exitCode: code, signal: closeSignal || null, ...logs },
        ));
      }
      settle(resolve, { exitCode: code, python, logs });
    });
  });
}

async function readBuilderOutput(docxPath, metadataPath) {
  let docxBuffer;
  try {
    docxBuffer = assertGeneratedOutputMagic(
      await fsp.readFile(docxPath),
      "docx",
      "LibreOffice clean-reading DOCX",
    );
  } catch (error) {
    throw new LibreOfficeGenerationError(
      `DOCX 빌더 출력이 없거나 올바르지 않습니다: ${error.message}`,
      "LIBREOFFICE_DOCX_OUTPUT_INVALID",
      { cause: error.message },
    );
  }
  let metadata;
  try {
    metadata = JSON.parse(await fsp.readFile(metadataPath, "utf8"));
  } catch (error) {
    throw new LibreOfficeGenerationError(
      `DOCX 빌더 메타데이터가 없거나 올바르지 않습니다: ${error.message}`,
      "LIBREOFFICE_DOCX_METADATA_INVALID",
      { cause: error.message },
    );
  }
  if (
    !metadata ||
    metadata.builder !== "pdf2docx-clean-reading-v1" ||
    !Number.isSafeInteger(metadata.processed_pages) ||
    metadata.processed_pages <= 0 ||
    metadata.docx_bytes !== docxBuffer.length
  ) {
    throw new LibreOfficeGenerationError(
      "DOCX 빌더 메타데이터 계약이 출력과 일치하지 않습니다.",
      "LIBREOFFICE_DOCX_METADATA_INVALID",
      { metadata },
    );
  }
  return { docxBuffer, metadata };
}

/**
 * Reflow an already-translated PDF into a clean-reading DOCX and PDF.
 *
 * Page range is zero-based and end-exclusive: startPage=7, endPage=10 processes
 * local pages 7, 8, and 9 (human-visible pages 8-10).
 */
async function generateLibreOfficePdfUnlocked(translatedPdf, options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  if (signal?.aborted) throw createAbortError(signal);
  const buildTimeoutMs = normalizeTimeout(options.buildTimeoutMs ?? options.timeoutMs);
  const pageRange = normalizePageRange(options);
  const sourceBuffer = await readTranslatedPdf(translatedPdf);
  const tempParent = path.resolve(options.tempRoot || os.tmpdir());
  await fsp.mkdir(tempParent, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(tempParent, "quilo-lo-gen-"));
  const homeDir = path.join(directory, "home");
  const inputPath = path.join(directory, "translated.pdf");
  const docxPath = path.join(directory, "clean-reading.docx");
  const metadataPath = path.join(directory, "build-metadata.json");
  const cleanup = async () => {
    try {
      await fsp.rm(directory, { recursive: true, force: true });
    } catch {
      // best effort; never hide the generation result
    }
  };

  try {
    await fsp.mkdir(homeDir, { recursive: true });
    await fsp.writeFile(inputPath, sourceBuffer, { mode: 0o600 });
    options.onProgress?.("PDF 읽기 구조를 분석하고 DOCX를 재조판하는 중...");
    const args = builderArgs(inputPath, docxPath, metadataPath, options, pageRange);
    const processResult = await runBuilder(args, {
      cwd: directory,
      homeDir,
      signal,
      timeoutMs: buildTimeoutMs,
    });
    const built = await readBuilderOutput(docxPath, metadataPath);
    if (signal?.aborted) throw createAbortError(signal);
    options.onProgress?.("재조판 DOCX를 LibreOffice PDF로 변환하는 중...");
    const converted = await convertOfficeToPdf(built.docxBuffer, {
      inputFormat: "docx",
      signal,
      timeoutMs: options.libreOfficeTimeoutMs,
      tempRoot: directory,
      onProgress: options.onProgress,
    });
    return {
      buffer: converted.buffer,
      docxBuffer: built.docxBuffer,
      metadata: {
        renderer: "libreoffice-clean-reading",
        durationMs: Date.now() - startedAt,
        pageRange: {
          basis: "zero-based-end-exclusive",
          startPage: pageRange.startPage,
          endPage: pageRange.endPage,
        },
        build: built.metadata,
        builderProcess: {
          python: processResult.python,
          exitCode: processResult.exitCode,
          timeoutMs: buildTimeoutMs,
        },
        libreOffice: converted.metadata,
      },
    };
  } finally {
    await cleanup();
  }
}

function generateLibreOfficePdf(translatedPdf, options = {}) {
  return getLibreOfficeGate().run(
    () => generateLibreOfficePdfUnlocked(translatedPdf, options),
    { signal: options.signal },
  );
}

module.exports = {
  DEFAULT_BUILD_TIMEOUT_MS,
  LibreOfficeGenerationError,
  detectPython,
  getLibreOfficeGate,
  generateLibreOfficePdf,
};
