"use strict";

// DOCX/ODT -> PDF renderer backed by LibreOffice Writer.
//
// Every conversion gets its own input/output directories and LibreOffice user
// profile.  This is important in a server: sharing the default profile lets
// concurrent soffice processes attach to one another, makes output ownership
// ambiguous, and can leave a locked profile after cancellation.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { assertGeneratedOutputMagic } = require("../../output-validate");

const SUPPORTED_INPUT_FORMATS = new Set(["docx", "odt"]);
const DEFAULT_TIMEOUT_MS = 3 * 60 * 1000;
const LOG_TAIL_LIMIT = 64 * 1024;
const BUNDLED_FONT_DIR = path.resolve(__dirname, "../../fonts");

const COMMON_BINARIES = {
  darwin: [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/LibreOffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/opt/homebrew/bin/libreoffice",
    "/usr/local/bin/libreoffice",
  ],
  linux: [
    "/usr/bin/libreoffice",
    "/usr/bin/soffice",
    "/usr/local/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/snap/bin/libreoffice",
  ],
};

class LibreOfficePdfError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "LibreOfficePdfError";
    this.code = code;
    this.details = details;
  }
}

function isExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(command, env = process.env) {
  const entries = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const entry of entries) {
    const candidate = path.join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveConfiguredBinary(configured, env) {
  if (!configured) return null;
  if (configured.includes("/") || configured.includes(path.sep)) {
    const absolute = path.resolve(configured);
    if (isExecutable(absolute)) return absolute;
    throw new LibreOfficePdfError(
      `LIBREOFFICE_BIN 실행 파일을 사용할 수 없습니다: ${absolute}`,
      "LIBREOFFICE_BINARY_INVALID",
      { configured: absolute },
    );
  }
  const found = findOnPath(configured, env);
  if (found) return found;
  throw new LibreOfficePdfError(
    `LIBREOFFICE_BIN 명령을 PATH에서 찾을 수 없습니다: ${configured}`,
    "LIBREOFFICE_BINARY_INVALID",
    { configured },
  );
}

/**
 * Resolve LibreOffice in deterministic priority order:
 * LIBREOFFICE_BIN -> common macOS/Linux locations -> PATH.
 */
function findLibreOfficeBinary({ env = process.env, platform = process.platform } = {}) {
  if (env.LIBREOFFICE_BIN) {
    return resolveConfiguredBinary(String(env.LIBREOFFICE_BIN).trim(), env);
  }
  for (const candidate of COMMON_BINARIES[platform] || []) {
    if (isExecutable(candidate)) return candidate;
  }
  for (const command of ["soffice", "libreoffice"]) {
    const found = findOnPath(command, env);
    if (found) return found;
  }
  throw new LibreOfficePdfError(
    "LibreOffice 실행 파일을 찾을 수 없습니다. LIBREOFFICE_BIN을 설정하거나 LibreOffice를 설치하세요.",
    "LIBREOFFICE_BINARY_MISSING",
  );
}

function normalizeFormat(input, options) {
  const explicit = String(options.inputFormat || options.format || "")
    .replace(/^\./, "")
    .toLowerCase();
  const named = typeof input === "string"
    ? path.extname(input).slice(1).toLowerCase()
    : path.extname(String(options.filename || "")).slice(1).toLowerCase();
  const format = explicit || named;
  if (!SUPPORTED_INPUT_FORMATS.has(format)) {
    throw new LibreOfficePdfError(
      "LibreOffice PDF 입력 형식은 DOCX 또는 ODT여야 합니다.",
      "LIBREOFFICE_INPUT_FORMAT_UNSUPPORTED",
      { format: format || null },
    );
  }
  if (explicit && named && explicit !== named) {
    throw new LibreOfficePdfError(
      `입력 파일 확장자(.${named})와 지정 형식(${explicit})이 일치하지 않습니다.`,
      "LIBREOFFICE_INPUT_FORMAT_MISMATCH",
      { explicit, named },
    );
  }
  return format;
}

function normalizeTimeout(value) {
  const fromEnv = Number.parseInt(process.env.PDF_LIBREOFFICE_TIMEOUT_MS || "", 10);
  const timeoutMs = value == null
    ? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS)
    : Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new LibreOfficePdfError(
      "LibreOffice 변환 제한 시간은 0보다 큰 밀리초 값이어야 합니다.",
      "LIBREOFFICE_TIMEOUT_INVALID",
      { timeoutMs: value },
    );
  }
  return Math.floor(timeoutMs);
}

function inputBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function validateOfficeBuffer(buffer, label) {
  if (!buffer || buffer.length === 0) {
    throw new LibreOfficePdfError(
      `${label}이 비어 있습니다.`,
      "LIBREOFFICE_INPUT_EMPTY",
    );
  }
  // DOCX and ODT are both ZIP containers. Rejecting other magic bytes prevents
  // LibreOffice from silently importing an unrelated file through content sniffing.
  if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new LibreOfficePdfError(
      `${label}이 정상적인 DOCX/ODT ZIP 문서가 아닙니다.`,
      "LIBREOFFICE_INPUT_INVALID",
    );
  }
  return buffer;
}

function createAbortError(reason) {
  const error = new Error(
    reason instanceof Error && reason.message
      ? reason.message
      : "LibreOffice PDF 변환이 취소되었습니다.",
  );
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function appendTail(current, chunk) {
  const next = Buffer.concat([current, Buffer.from(chunk)]);
  return next.length <= LOG_TAIL_LIMIT ? next : next.subarray(next.length - LOG_TAIL_LIMIT);
}

function killProcessTree(child) {
  if (!child || child.killed) return;
  // detached=true creates a process group on macOS/Linux. LibreOffice may fork
  // helper processes, so kill the group first and the direct child as fallback.
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall through to the direct child.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // The close/error handler will settle the promise if it already exited.
  }
}

async function readSinglePdf(outputDir, expectedName) {
  const entries = await fsp.readdir(outputDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  if (entries.length === 0) {
    throw new LibreOfficePdfError(
      "LibreOffice가 PDF 파일을 생성하지 않았습니다.",
      "LIBREOFFICE_OUTPUT_MISSING",
    );
  }
  if (entries.length !== 1 || files.length !== 1) {
    throw new LibreOfficePdfError(
      `LibreOffice 출력은 PDF 1개여야 하지만 ${entries.length}개 항목이 생성되었습니다.`,
      "LIBREOFFICE_OUTPUT_MULTIPLE",
      { entries: entries.map((entry) => entry.name).sort() },
    );
  }
  const actualName = files[0].name;
  if (actualName !== expectedName || path.extname(actualName).toLowerCase() !== ".pdf") {
    throw new LibreOfficePdfError(
      `LibreOffice가 예상하지 않은 출력 파일을 생성했습니다: ${actualName}`,
      "LIBREOFFICE_OUTPUT_WRONG",
      { expectedName, actualName },
    );
  }
  const outputPath = path.join(outputDir, actualName);
  const stat = await fsp.stat(outputPath);
  if (!stat.isFile() || stat.size === 0) {
    throw new LibreOfficePdfError(
      "LibreOffice가 생성한 PDF가 비어 있습니다.",
      "LIBREOFFICE_OUTPUT_EMPTY",
    );
  }
  let pdf;
  try {
    pdf = assertGeneratedOutputMagic(
      await fsp.readFile(outputPath),
      "pdf",
      "LibreOffice PDF",
    );
  } catch (error) {
    throw new LibreOfficePdfError(
      `LibreOffice 출력이 정상적인 PDF가 아닙니다: ${error.message}`,
      "LIBREOFFICE_OUTPUT_INVALID",
      { cause: error.message },
    );
  }
  return pdf;
}

/**
 * Convert a DOCX/ODT Buffer, Uint8Array, or file path to a PDF.
 *
 * Buffer input requires inputFormat (or a filename with .docx/.odt).
 * Returns { buffer, metadata }; all temporary inputs, outputs, and profiles are
 * removed before the promise settles.
 */
async function convertOfficeToPdf(input, options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  if (signal?.aborted) throw createAbortError(signal.reason);

  const format = normalizeFormat(input, options);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const libreOfficeBin = findLibreOfficeBinary();
  const tempParent = path.resolve(options.tempRoot || os.tmpdir());
  await fsp.mkdir(tempParent, { recursive: true });
  const directory = await fsp.mkdtemp(path.join(tempParent, "quilo-lo-pdf-"));
  const inputDir = path.join(directory, "input");
  const outputDir = path.join(directory, "output");
  const profileDir = path.join(directory, "profile");
  const homeDir = path.join(directory, "home");
  const inputName = `document.${format}`;
  const expectedName = "document.pdf";
  const stagedInput = path.join(inputDir, inputName);

  const cleanup = async () => {
    try {
      await fsp.rm(directory, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort and must not mask the conversion result/error.
    }
  };

  try {
    await Promise.all([
      fsp.mkdir(inputDir, { recursive: true }),
      fsp.mkdir(outputDir, { recursive: true }),
      fsp.mkdir(profileDir, { recursive: true }),
      fsp.mkdir(homeDir, { recursive: true }),
    ]);

    const directBuffer = inputBuffer(input);
    let sourceBytes;
    if (directBuffer) {
      sourceBytes = validateOfficeBuffer(directBuffer, `${format.toUpperCase()} 입력`);
    } else if (typeof input === "string" && input.trim()) {
      const sourcePath = path.resolve(input);
      let stat;
      try {
        stat = await fsp.stat(sourcePath);
      } catch (error) {
        throw new LibreOfficePdfError(
          `LibreOffice 입력 파일을 읽을 수 없습니다: ${error.message}`,
          "LIBREOFFICE_INPUT_UNREADABLE",
          { sourcePath },
        );
      }
      if (!stat.isFile()) {
        throw new LibreOfficePdfError(
          "LibreOffice 입력 경로는 일반 파일이어야 합니다.",
          "LIBREOFFICE_INPUT_INVALID",
          { sourcePath },
        );
      }
      sourceBytes = validateOfficeBuffer(
        await fsp.readFile(sourcePath),
        `${format.toUpperCase()} 입력`,
      );
    } else {
      throw new LibreOfficePdfError(
        "LibreOffice 변환에는 DOCX/ODT 버퍼 또는 파일 경로가 필요합니다.",
        "LIBREOFFICE_INPUT_MISSING",
      );
    }
    await fsp.writeFile(stagedInput, sourceBytes, { mode: 0o600 });

    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      "--headless",
      "--invisible",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      "--nolockcheck",
      "--norestore",
      "--convert-to",
      "pdf:writer_pdf_Export",
      "--outdir",
      outputDir,
      stagedInput,
    ];
    options.onProgress?.("LibreOffice로 PDF를 생성하는 중...");

    const result = await new Promise((resolve, reject) => {
      let child;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let aborted = false;
      let settled = false;

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
        child = spawn(libreOfficeBin, args, {
          cwd: inputDir,
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            HOME: homeDir,
            TMPDIR: directory,
            XDG_CACHE_HOME: path.join(homeDir, ".cache"),
            XDG_CONFIG_HOME: path.join(homeDir, ".config"),
            // Keep Writer typography deterministic without installing fonts
            // into the host user's profile. LibreOffice/fontconfig honors this
            // private search path on macOS and Linux.
            SAL_FONTPATH: [BUNDLED_FONT_DIR, process.env.SAL_FONTPATH]
              .filter(Boolean)
              .join(path.delimiter),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        return reject(new LibreOfficePdfError(
          `LibreOffice 실행에 실패했습니다: ${error.message}`,
          "LIBREOFFICE_SPAWN_FAILED",
          { binary: libreOfficeBin },
        ));
      }

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener?.("abort", onAbort, { once: true });
      // Close the small race between the preflight aborted check and listener registration.
      if (signal?.aborted) onAbort();

      child.stdout.on("data", (chunk) => {
        stdout = appendTail(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendTail(stderr, chunk);
      });
      child.once("error", (error) => {
        settle(reject, new LibreOfficePdfError(
          `LibreOffice 실행에 실패했습니다: ${error.message}`,
          "LIBREOFFICE_SPAWN_FAILED",
          { binary: libreOfficeBin },
        ));
      });
      child.once("close", (code, closeSignal) => {
        const logs = {
          stdout: stdout.toString("utf8").trim().slice(-2000),
          stderr: stderr.toString("utf8").trim().slice(-2000),
        };
        if (aborted) return settle(reject, createAbortError(signal?.reason));
        if (timedOut) {
          return settle(reject, new LibreOfficePdfError(
            `LibreOffice PDF 변환이 제한 시간(${timeoutMs}ms)을 초과했습니다.`,
            "LIBREOFFICE_TIMEOUT",
            { timeoutMs, ...logs },
          ));
        }
        if (code !== 0) {
          return settle(reject, new LibreOfficePdfError(
            `LibreOffice PDF 변환에 실패했습니다 (code ${code}${closeSignal ? `, signal ${closeSignal}` : ""}).`,
            "LIBREOFFICE_EXIT_FAILED",
            { exitCode: code, signal: closeSignal || null, ...logs },
          ));
        }
        settle(resolve, { exitCode: code, logs });
      });
    });

    const pdf = await readSinglePdf(outputDir, expectedName);
    const durationMs = Date.now() - startedAt;
    options.onProgress?.("LibreOffice PDF 생성 완료");
    return {
      buffer: pdf,
      metadata: {
        renderer: "libreoffice",
        inputFormat: format,
        outputFilename: expectedName,
        outputBytes: pdf.length,
        durationMs,
        timeoutMs,
        binary: libreOfficeBin,
        filter: "writer_pdf_Export",
        exitCode: result.exitCode,
      },
    };
  } finally {
    await cleanup();
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  LibreOfficePdfError,
  findLibreOfficeBinary,
  convertOfficeToPdf,
};
