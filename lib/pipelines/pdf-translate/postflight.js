// Shared fail-closed postflight for PDF translation output.
//
// Both HTTP entry points can call this module after producing the final PDF.
// It materializes the source/output buffers in a private temporary directory,
// runs the deterministic Python verifier, and only returns a validated report.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const {
  PDF_TRANSLATION_QUALITY_ERROR,
  qualityFailure,
} = require("./quality-gate");
const {
  hashArtifact,
  prepareSourceSegment,
  validateRetypesetOcrEvidence,
} = require("./provenance");
const { sha256Hex } = require("./invariants");
const {
  ocrPageRequiresKorean,
  ocrPageTranslatableText,
  validateOcrSemanticReview,
  validateVisualReview,
} = require("./ocr-semantic-review");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "verify_translation.py");
// 수백 쪽 결과는 페이지 렌더·원본 대조 자체가 수 분 걸린다. 검증을 생략하지 않고
// 충분히 끝낼 수 있도록 파일 작업 timeout(90분) 안에서 별도 20분 예산을 준다.
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const OUTPUT_TAIL_BYTES = 64 * 1024;
const TIMEOUT_ERROR_CODE = "PDF_TRANSLATION_POSTFLIGHT_TIMEOUT";
const VERIFIER_SCHEMA_VERSION = 2;
const VALID_GATE_STATUSES = new Set(["pass", "fail", "skip"]);
const REQUIRED_SOURCE_BACKED_GATES = Object.freeze([
  "pdf_open",
  "source_pdf_open",
  "page_correspondence",
  "page_render",
  "blank_pages",
  "black_pages",
  "content_coverage",
  "page_order",
  "semantic_correspondence",
  "text_preservation",
  "raw_markers",
  "garbling",
  "untranslated_text",
  "number_preservation",
  "unit_preservation",
  "chemical_formula_preservation",
  "url_preservation",
  "image_duplicates",
  "image_preservation",
  "nontext_visual_preservation",
  "vector_provenance",
  "link_preservation",
]);
const REQUIRED_SOURCE_BACKED_GATE_SET = new Set(REQUIRED_SOURCE_BACKED_GATES);

function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.join(REPO_ROOT, ".venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.join(REPO_ROOT, ".venv/bin/python"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || "python3";
}

function resolveTimeoutMs(value) {
  const candidate = value == null
    ? process.env.PDF_TRANSLATE_POSTFLIGHT_TIMEOUT_MS
    : value;
  if (candidate == null || String(candidate).trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(candidate);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TIMEOUT_MS;
}

function createAbortError(signal) {
  const reason = signal && signal.reason;
  const suffix = reason instanceof Error && reason.message
    ? `: ${reason.message}`
    : "";
  const error = new Error(`PDF 번역 최종 품질 검증이 취소되었습니다${suffix}`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

function isAbortError(error) {
  return Boolean(error) && (error.name === "AbortError" || error.code === "ABORT_ERR");
}

function outputTail(previous, chunk) {
  const next = Buffer.concat([previous, Buffer.from(chunk)]);
  return next.length <= OUTPUT_TAIL_BYTES
    ? next
    : next.subarray(next.length - OUTPUT_TAIL_BYTES);
}

function hardFailure(message, kind, hardFailures, details = {}, cause = null) {
  const failures = [...new Set((hardFailures || []).map(String).filter(Boolean))];
  const error = qualityFailure(message, {
    ...details,
    kind,
    hard_failures: failures.length ? failures : [kind],
  });
  if (cause) error.cause = cause;
  return error;
}

function validateReport(report, { mode, intent }) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("report is not a JSON object");
  }
  if (report.schema_version !== VERIFIER_SCHEMA_VERSION) {
    throw new Error(
      `report.schema_version must be exactly ${VERIFIER_SCHEMA_VERSION}`,
    );
  }
  if (report.mode !== mode || report.intent !== intent) {
    throw new Error(
      `report policy mismatch (expected ${mode}/${intent}, got ${report.mode}/${report.intent})`,
    );
  }
  if (typeof report.passed !== "boolean") {
    throw new Error("report.passed must be boolean");
  }
  if (!Array.isArray(report.hard_failures) || !report.hard_failures.every((item) => typeof item === "string")) {
    throw new Error("report.hard_failures must be a string array");
  }
  if (!Number.isInteger(report.exit_code)) {
    throw new Error("report.exit_code must be an integer");
  }
  if (!report.gates || typeof report.gates !== "object" || Array.isArray(report.gates)) {
    throw new Error("report.gates must be an object");
  }

  const missingGates = REQUIRED_SOURCE_BACKED_GATES.filter(
    (name) => !Object.prototype.hasOwnProperty.call(report.gates, name),
  );
  if (missingGates.length) {
    throw new Error(`report.gates is missing required gates: ${missingGates.join(", ")}`);
  }
  const unexpectedGates = Object.keys(report.gates).filter(
    (name) => !REQUIRED_SOURCE_BACKED_GATE_SET.has(name),
  );
  if (unexpectedGates.length) {
    throw new Error(`report.gates contains unexpected gates: ${unexpectedGates.join(", ")}`);
  }

  const expectedHardFailures = [];
  for (const [name, gate] of Object.entries(report.gates)) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new Error(`report.gates.${name} must be an object`);
    }
    if (!VALID_GATE_STATUSES.has(gate.status)) {
      throw new Error(`report.gates.${name}.status is invalid`);
    }
    if (typeof gate.hard !== "boolean") {
      throw new Error(`report.gates.${name}.hard must be boolean`);
    }
    if (REQUIRED_SOURCE_BACKED_GATE_SET.has(name) && gate.hard !== true) {
      throw new Error(`report.gates.${name}.hard must be true`);
    }
    const expectedPassed = gate.status === "skip" ? null : gate.status === "pass";
    if (gate.passed !== expectedPassed) {
      throw new Error(
        `report.gates.${name}.passed is inconsistent with status ${gate.status}`,
      );
    }
    if (typeof gate.summary !== "string" || gate.summary.length === 0) {
      throw new Error(`report.gates.${name}.summary must be a non-empty string`);
    }
    if (!gate.details || typeof gate.details !== "object" || Array.isArray(gate.details)) {
      throw new Error(`report.gates.${name}.details must be an object`);
    }
    if (gate.hard && gate.status === "fail") expectedHardFailures.push(name);
  }

  const expectedSkips = new Set([
    ...(mode === "retypeset" ? ["nontext_visual_preservation"] : []),
    ...(mode === "retypeset" && intent === "translate" ? [] : ["semantic_correspondence"]),
    ...(intent === "translate" ? ["text_preservation"] : ["untranslated_text"]),
  ]);
  for (const name of REQUIRED_SOURCE_BACKED_GATES) {
    const status = report.gates[name].status;
    if (expectedSkips.has(name) && status !== "skip") {
      throw new Error(`report.gates.${name}.status must be skip for ${mode}/${intent}`);
    }
    if (!expectedSkips.has(name) && status === "skip") {
      throw new Error(`report.gates.${name}.status must not be skip for ${mode}/${intent}`);
    }
  }

  if (
    report.hard_failures.length !== expectedHardFailures.length ||
    report.hard_failures.some((name, index) => name !== expectedHardFailures[index])
  ) {
    throw new Error(
      "report.hard_failures must exactly match hard gates whose status is fail",
    );
  }

  const expectedPassed = expectedHardFailures.length === 0;
  if (report.passed !== expectedPassed) {
    throw new Error("report.passed is inconsistent with hard gate failures");
  }
  const expectedExitCode = expectedPassed ? 0 : 1;
  if (report.exit_code !== expectedExitCode) {
    throw new Error(
      `report.exit_code must be ${expectedExitCode} when report.passed is ${expectedPassed}`,
    );
  }
  return report;
}

function runVerifierProcess(python, args, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(createAbortError(signal));
      return;
    }

    let child;
    try {
      child = spawn(python, args, {
        cwd: REPO_ROOT,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdoutTail = Buffer.alloc(0);
    let stderrTail = Buffer.alloc(0);
    let settled = false;
    let terminationError = null;

    const cleanupListeners = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanupListeners();
      if (error) reject(error);
      else resolve(value);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try {
        if (!child.kill("SIGKILL")) finish(error);
      } catch {
        finish(error);
      }
    };
    const onAbort = () => terminate(createAbortError(signal));
    const timer = setTimeout(() => {
      const error = new Error(`PDF verifier exceeded ${timeoutMs}ms`);
      error.code = TIMEOUT_ERROR_CODE;
      terminate(error);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutTail = outputTail(stdoutTail, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrTail = outputTail(stderrTail, chunk);
    });
    child.once("error", (error) => finish(terminationError || error));
    child.once("close", (code, closeSignal) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      finish(null, {
        code,
        signal: closeSignal,
        stdout: stdoutTail.toString("utf8"),
        stderr: stderrTail.toString("utf8"),
      });
    });

    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateInputBuffer(value, name) {
  if (!Buffer.isBuffer(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty Buffer`);
  }
}

function visualReviewVerifierSummary(review, generationProvider, intent) {
  return {
    schema_version: 1,
    task: review.task,
    intent,
    provider: review.provider,
    model: review.model,
    request_id: review.request_id,
    generation_provider: String(generationProvider || ""),
    source_pdf_sha256: review.source_pdf_sha256,
    output_pdf_sha256: review.output_pdf_sha256,
    ocr_evidence_sha256: review.ocr_evidence_sha256,
    ocr_render_manifest_sha256: review.ocr_render_manifest_sha256,
    input_digest: review.input_digest,
    review_sha256: review.review_sha256,
  };
}

/**
 * Run the strict PDF translation postflight.
 *
 * @param {object} options
 * @param {Buffer} options.originalBuffer source PDF
 * @param {Buffer} options.resultBuffer translated PDF
 * @param {"inplace"|"retypeset"} [options.mode="inplace"]
 * @param {"translate"|"restore"} [options.intent="translate"]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.tempRoot] internal/test override for temp parent
 * @param {object} [options.ocrEvidence] canonical OCR source evidence
 * @param {object} [options.ocrRenderManifest] exact raster/model-input coverage
 * @param {object} [options.ocrSemanticReview] independently judged, artifact-bound review
 * @param {object} [options.ocrRestoreVisualReview] independently judged restore visual review
 * @returns {Promise<object>} the validated verifier report
 */
async function verifyPdfTranslationPostflight({
  originalBuffer,
  resultBuffer,
  mode = "inplace",
  intent = "translate",
  signal,
  timeoutMs,
  tempRoot,
  ocrEvidence = null,
  ocrRenderManifest = null,
  ocrSemanticReview = null,
  ocrRestoreVisualReview = null,
  ocrGenerationProvider = null,
  requireOcrEvidence = false,
} = {}) {
  validateInputBuffer(originalBuffer, "originalBuffer");
  validateInputBuffer(resultBuffer, "resultBuffer");
  if (mode !== "inplace" && mode !== "retypeset") {
    throw new TypeError("mode must be 'inplace' or 'retypeset'");
  }
  if (intent !== "translate" && intent !== "restore") {
    throw new TypeError("intent must be 'translate' or 'restore'");
  }
  if (signal && signal.aborted) throw createAbortError(signal);

  let ocrBinding = null;
  let semanticBinding = null;
  let restoreVisualBinding = null;
  if (requireOcrEvidence || ocrEvidence != null || ocrRenderManifest != null) {
    if (mode !== "retypeset" || ocrEvidence == null || ocrRenderManifest == null) {
      throw hardFailure(
        "스캔 재조판 OCR 증거 또는 렌더 페이지 증거가 누락되었습니다. 결과를 제공하지 않습니다.",
        "ocr_evidence_missing",
        ["ocr_evidence_missing"],
        { mode, requireOcrEvidence: !!requireOcrEvidence },
      );
    }
    try {
      ocrBinding = validateRetypesetOcrEvidence({
        ocrEvidence,
        ocrRenderManifest,
        sourcePdf: originalBuffer,
      });
    } catch (error) {
      throw hardFailure(
        "스캔 재조판 OCR provenance 검증에 실패했습니다. 결과를 제공하지 않습니다.",
        "ocr_evidence_invalid",
        ["ocr_evidence_invalid"],
        {
          validation_code: typeof error?.code === "string" ? error.code : null,
        },
        error,
      );
    }
  }
  if (ocrBinding && intent === "translate") {
    if (ocrSemanticReview == null || typeof ocrSemanticReview !== "object") {
      throw hardFailure(
        "스캔 재조판 번역의 독립 의미 검토 증거가 누락되었습니다. 결과를 제공하지 않습니다.",
        "ocr_semantic_review_missing",
        ["semantic_correspondence"],
        { mode, intent },
      );
    }
    try {
      semanticBinding = validateOcrSemanticReview(ocrSemanticReview, {
        ocrEvidence: ocrBinding.evidence,
        ocrRenderManifest: ocrBinding.renderManifest,
        sourcePdf: originalBuffer,
        outputPdf: resultBuffer,
      });
    } catch (error) {
      throw hardFailure(
        "스캔 재조판 번역의 독립 의미 검토 provenance 검증에 실패했습니다. 결과를 제공하지 않습니다.",
        "ocr_semantic_review_invalid",
        ["semantic_correspondence"],
        { validation_code: typeof error?.code === "string" ? error.code : null },
        error,
      );
    }
  } else if (ocrBinding && intent === "restore") {
    if (
      ocrRestoreVisualReview == null ||
      typeof ocrRestoreVisualReview !== "object" ||
      !String(ocrGenerationProvider || "").trim()
    ) {
      throw hardFailure(
        "스캔 재조판 복원의 독립 시각 보존 검토 증거가 누락되었습니다. 결과를 제공하지 않습니다.",
        "ocr_restore_visual_review_missing",
        ["image_preservation"],
        { mode, intent },
      );
    }
    try {
      restoreVisualBinding = validateVisualReview(ocrRestoreVisualReview, {
        sourcePdf: originalBuffer,
        outputPdf: resultBuffer,
        ocrEvidence: ocrBinding.evidence,
        ocrRenderManifest: ocrBinding.renderManifest,
        generationProvider: ocrGenerationProvider,
        intent: "restore",
      });
    } catch (error) {
      throw hardFailure(
        "스캔 재조판 복원의 독립 시각 보존 검토 provenance 검증에 실패했습니다. 결과를 제공하지 않습니다.",
        "ocr_restore_visual_review_invalid",
        ["image_preservation"],
        { validation_code: typeof error?.code === "string" ? error.code : null },
        error,
      );
    }
  }

  const parent = tempRoot || os.tmpdir();
  const effectiveTimeoutMs = resolveTimeoutMs(timeoutMs);
  let directory = null;
  let report = null;
  let pendingError = null;

  try {
    directory = await fsp.mkdtemp(path.join(parent, "pdf-postflight-"));
    const originalPath = path.join(directory, "original.pdf");
    const resultPath = path.join(directory, "translated.pdf");
    const reportPath = path.join(directory, "report.json");
    const ocrSourcePath = path.join(directory, "ocr-source.json");
    await Promise.all([
      fsp.writeFile(originalPath, originalBuffer, { mode: 0o600 }),
      fsp.writeFile(resultPath, resultBuffer, { mode: 0o600 }),
    ]);

    let ocrVerifierBundle = null;
    if (ocrBinding) {
      if (semanticBinding) {
        ocrVerifierBundle = {
          ...semanticBinding.verifierBundle,
          visual_review: visualReviewVerifierSummary(
            ocrSemanticReview.visual_review,
            semanticBinding.evidence.translation.provider,
            "translate",
          ),
        };
      } else {
        const sourcePdfSha256 = hashArtifact(originalBuffer, "originalBuffer");
        ocrVerifierBundle = {
          schema_version: 1,
          task: "ocr-postflight-source",
          source_pdf_sha256: sourcePdfSha256,
          ocr_evidence_sha256: ocrBinding.evidence.evidence_sha256,
          pages: ocrBinding.evidence.pages.map((page) => {
            const prepared = prepareSourceSegment({
              documentSha256: sourcePdfSha256,
              page: page.index + 1,
              order: 1,
              kind: "ocr_page",
              sourceText: page.text,
            });
            return {
              page: page.index + 1,
              segment_id: prepared.source.segment_id,
              text: page.text,
              text_sha256: sha256Hex(page.text.normalize("NFC")),
              source_sha256: prepared.source.source_sha256,
              requires_korean_translation: ocrPageRequiresKorean(page),
              translatable_text: ocrPageTranslatableText(page),
              translatable_text_sha256: sha256Hex(
                ocrPageTranslatableText(page).normalize("NFC"),
              ),
            };
          }),
          semantic_review: null,
          visual_review: restoreVisualBinding
              ? visualReviewVerifierSummary(
                  restoreVisualBinding,
                  ocrGenerationProvider,
                  "restore",
                )
            : null,
        };
      }
      await fsp.writeFile(ocrSourcePath, JSON.stringify(ocrVerifierBundle), {
        mode: 0o600,
      });
    }

    const python = detectPython();
    let processResult;
    try {
      processResult = await runVerifierProcess(
        python,
        [
          VERIFY_SCRIPT,
          resultPath,
          "--original",
          originalPath,
          "--mode",
          mode,
          "--intent",
          intent,
          "--json",
          reportPath,
          ...(ocrVerifierBundle ? ["--ocr-source-json", ocrSourcePath] : []),
        ],
        { signal, timeoutMs: effectiveTimeoutMs },
      );
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error && error.code === TIMEOUT_ERROR_CODE) {
        throw hardFailure(
          `PDF 번역 최종 품질 검증이 ${effectiveTimeoutMs}ms 제한 시간을 초과했습니다. 결과를 제공하지 않습니다.`,
          "postflight_timeout",
          ["verifier_timeout"],
          { timeoutMs: effectiveTimeoutMs },
          error,
        );
      }
      throw hardFailure(
        `PDF 번역 최종 품질 검증기를 실행할 수 없습니다. 결과를 제공하지 않습니다: ${error.message}`,
        "postflight_execution",
        ["verifier_unavailable"],
        { python },
        error,
      );
    }

    let rawReport;
    try {
      rawReport = await fsp.readFile(reportPath, "utf8");
    } catch (error) {
      throw hardFailure(
        "PDF 번역 최종 품질 검증기가 JSON 보고서를 만들지 못했습니다. 결과를 제공하지 않습니다.",
        "postflight_report_missing",
        ["verifier_report_missing"],
        {
          verifierExitCode: processResult.code,
          stderr: processResult.stderr.slice(-2000),
          stdout: processResult.stdout.slice(-2000),
        },
        error,
      );
    }

    try {
      report = validateReport(JSON.parse(rawReport), { mode, intent });
    } catch (error) {
      throw hardFailure(
        `PDF 번역 최종 품질 검증 보고서가 잘못되었습니다: ${error.message}`,
        "postflight_report_invalid",
        ["verifier_report_invalid"],
        {
          verifierExitCode: processResult.code,
          reportPreview: rawReport.slice(0, 2000),
        },
        error,
      );
    }

    const reportFailures = report.hard_failures.length
      ? report.hard_failures
      : ["verifier_rejected_output"];
    if (
      processResult.code !== 0 ||
      report.passed !== true ||
      report.exit_code !== 0 ||
      report.hard_failures.length !== 0
    ) {
      throw hardFailure(
        `PDF 번역 최종 품질 검증 실패: ${reportFailures.join(", ")}. 결함 가능성이 있는 결과를 제공하지 않습니다.`,
        "postflight_verification",
        reportFailures,
        {
          verifierExitCode: processResult.code,
          report,
          stderr: processResult.stderr.slice(-2000),
        },
      );
    }
  } catch (error) {
    pendingError = error;
  }

  if (directory) {
    try {
      await fsp.rm(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      if (pendingError) {
        pendingError.cleanupError = cleanupError;
      } else {
        pendingError = hardFailure(
          "PDF 번역 최종 품질 검증 임시 파일을 정리하지 못했습니다.",
          "postflight_cleanup",
          ["temp_cleanup_failed"],
          { directory },
          cleanupError,
        );
      }
    }
  }

  if (pendingError) {
    if (isAbortError(pendingError) || pendingError.code === PDF_TRANSLATION_QUALITY_ERROR) {
      throw pendingError;
    }
    throw hardFailure(
      `PDF 번역 최종 품질 검증 중 오류가 발생했습니다. 결과를 제공하지 않습니다: ${pendingError.message}`,
      "postflight_internal",
      ["verifier_internal_error"],
      {},
      pendingError,
    );
  }
  return ocrBinding
    ? {
        ...report,
        ocr_evidence_summary: ocrBinding.summary,
        ...(semanticBinding
          ? { ocr_semantic_review_summary: semanticBinding.summary }
          : {}),
        ...(restoreVisualBinding
          ? {
              ocr_restore_visual_review_summary:
                visualReviewVerifierSummary(
                  restoreVisualBinding,
                  ocrGenerationProvider,
                  "restore",
                ),
            }
          : {}),
      }
    : report;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  VERIFY_SCRIPT,
  detectPython,
  resolveTimeoutMs,
  verifyPdfTranslationPostflight,
};
