// 독립 PDF 통번역 사이트 서버 (같은 repo · 별도 Render 서비스).
//
// 메인 server.js 는 손대지 않는다(라이브 보고서 생성 보호). 번역 "엔진"은
// lib/pipelines/pdf-translate/* 를 그대로 공유하고(단일 소스), 여기서는 얇은
// 잡(job)/SSE/게이트/오케스트레이션만 둔다.
//
// 접근: 비밀번호/초대코드(TRANSLATE_ACCESS_CODES). 코드 미설정 + 비프로덕션에서도
// TRANSLATE_ALLOW_OPEN_DEV=1을 명시한 경우만 개방하며, 프로덕션은 항상 차단.
//
// 실행: node translate-server.js  (Render: 별도 서비스 start command)

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

// ── 공유 엔진 (메인 사이트와 동일 코드) ──────────────────────────────────────
const { translatePdf, makeGate } = require("./lib/pipelines/pdf-translate/translate");
const { retypesetPdf } = require("./lib/pipelines/pdf-translate/latex-gen");
const {
  assertLibreOfficeRendererAvailable,
  getPdfTranslationRendererCapabilities,
  normalizeRequestedRenderer,
  resolvePdfTranslationRenderer,
} = require("./lib/pipelines/pdf-translate/renderer-contract");
const {
  findLibreOfficeBinary,
} = require("./lib/pipelines/pdf-translate/libreoffice-pdf");
const {
  assertCompleteRasterization,
  assertCompleteChunkResults,
  qualityFailure,
} = require("./lib/pipelines/pdf-translate/quality-gate");
const {
  assertCanonicalOcrChunkSubset,
  normalizeRequestedMode,
  resolvePdfTranslationLimits,
  resolvePdfTranslationMode,
  assertPdfTranslationInputCoverage,
  finalizePdfTranslationOutput,
} = require("./lib/pipelines/pdf-translate/orchestration-contract");
const {
  analyzePdf,
  mergePdf,
  splitPdf,
  rasterizePages,
  extractFigures,
  extractPageTexts,
} = require("./lib/pipelines/pdf-translate/pdf-tool");
const {
  buildOcrRenderManifest,
  mergeOcrRenderManifests,
  mistralRiskVisualAdjudicator,
  prepareOcrModelInputs,
  prepareStrictScanOcr,
} = require("./lib/pipelines/pdf-translate/ocr-routing");
const { assertGeneratedOutputMagic } = require("./lib/output-validate");

const app = express();
app.disable("x-powered-by");
const PORT = parseInt(process.env.TRANSLATE_PORT || process.env.PORT || "4100", 10);
const IS_PROD = process.env.NODE_ENV === "production";
const PDF_TRANSLATE_TIMEOUT_MS = parseInt(
  process.env.PDF_TRANSLATE_TIMEOUT_MS || String(90 * 60 * 1000),
  10,
);
const ALLOWED_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];
const DEFAULT_MODEL = "claude-opus-4-8";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 80 * 1024 * 1024 },
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ── 비밀번호/초대코드 게이트 ─────────────────────────────────────────────────
const SECRET =
  process.env.TRANSLATE_SESSION_SECRET ||
  crypto.createHash("sha256").update("quilo-translate:" + (process.env.TRANSLATE_ACCESS_CODES || "dev")).digest("hex");
const CODES = String(
  process.env.TRANSLATE_ACCESS_CODES || process.env.TRANSLATE_ACCESS_CODE || "",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const tokenFor = (code) =>
  crypto.createHmac("sha256", SECRET).update("v1:" + code).digest("hex");
const VALID_TOKENS = new Set(CODES.map(tokenFor));
const OPEN_NO_GATE =
  CODES.length === 0 &&
  !IS_PROD &&
  process.env.TRANSLATE_ALLOW_OPEN_DEV === "1"; // 명시 opt-in 로컬 개방

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  if (OPEN_NO_GATE) return true;
  return VALID_TOKENS.has(parseCookies(req).tr);
}
function requireCode(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "코드 인증이 필요합니다." });
}

function getPdfRendererCapabilities() {
  return getPdfTranslationRendererCapabilities({
    env: process.env,
    findLibreOfficeBinary,
  });
}

function requestedRendererValues(body = {}) {
  const values = [body.renderer];
  try {
    const perFile = JSON.parse(String(body.renderers || "null"));
    if (Array.isArray(perFile)) values.push(...perFile);
  } catch (_) {
    // Malformed optional per-file input is ignored like the translation route.
  }
  return values;
}

function assertRequestedPdfRenderersAvailable(body = {}) {
  if (!requestedRendererValues(body).some(
    (value) => normalizeRequestedRenderer(value) === "libreoffice",
  )) return;
  assertLibreOfficeRendererAvailable({
    env: process.env,
    findLibreOfficeBinary,
  });
}

function sendRendererUnavailable(res, error) {
  return res.status(Number(error && error.statusCode) || 503).json({
    error: error && error.message || "요청한 PDF 출력 엔진을 사용할 수 없습니다.",
    code: error && error.code || "PDF_TRANSLATION_RENDERER_UNAVAILABLE",
  });
}

app.get("/api/me", (req, res) => {
  res.json({
    authed: isAuthed(req),
    gated: !OPEN_NO_GATE,
    configured: CODES.length > 0 || OPEN_NO_GATE,
  });
});
app.post("/api/login", (req, res) => {
  const code = String((req.body && req.body.code) || "").trim();
  if (OPEN_NO_GATE) return res.json({ ok: true });
  if (CODES.length === 0)
    return res.status(503).json({ error: "관리자가 접근 코드(TRANSLATE_ACCESS_CODES)를 설정해야 합니다." });
  if (!code || !CODES.includes(code))
    return res.status(401).json({ error: "코드가 올바르지 않습니다." });
  res.setHeader(
    "Set-Cookie",
    `tr=${tokenFor(code)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}${IS_PROD ? "; Secure" : ""}`,
  );
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "tr=; HttpOnly; Path=/; Max-Age=0");
  res.json({ ok: true });
});

// ── 얇은 잡(job)/SSE 매니저 ──────────────────────────────────────────────────
const jobs = new Map();
function createJob() {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "running", progress: [], listeners: [], createdAt: Date.now(), result: null };
  jobs.set(id, job);
  return job;
}
function sendSse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
function pushProgress(job, msg) {
  let line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  if (line.length > 500) line = line.slice(0, 500) + "…(truncated)";
  job.progress.push(line);
  if (job.progress.length > 200) job.progress.splice(0, job.progress.length - 200);
  console.log(`[job ${job.id}] ${line}`);
  job.listeners.forEach((r) => sendSse(r, "progress", line));
}
setInterval(() => {
  const cut = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cut) jobs.delete(id);
}, 60 * 60 * 1000).unref?.();

// ── 파일명 헬퍼 (server.js 와 동일 동작) ─────────────────────────────────────
function sanitizeForFilename(s) {
  return String(s || "").normalize("NFC").replace(/[\\/:*?"<>|]/g, "_").trim().slice(0, 30);
}
function normalizeUploadFilename(value) {
  const original = String(value || "");
  if (!original) return "";
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const hasHangul = /[가-힣ㄱ-ㅎㅏ-ㅣᄀ-ᇿ]/;
    const looksMojibake = /[ÃÂ]|[-]/.test(original);
    if ((hasHangul.test(decoded) && !hasHangul.test(original)) || looksMojibake) return decoded;
  } catch {
    /* keep */
  }
  return original;
}
function buildTranslatedFilename(originalName, suffix = "_KO") {
  const base = sanitizeForFilename(String(originalName || "document.pdf").replace(/\.pdf$/i, "")) || "document";
  return `${base}${suffix}.pdf`;
}

// ── 오케스트레이션 헬퍼 (server.js 와 동일 로직, 공유 엔진 호출) ─────────────
async function splitPdfToBuffers(pdfBuffer, { signal, onProgress, pagesPerChunk } = {}) {
  const per = pagesPerChunk || parseInt(process.env.PDF_RETYPESET_CHUNK_PAGES || "5", 10);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfsplit-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const meta = await splitPdf(pdfPath, tmpDir, { pagesPerChunk: per, signal });
    if (!meta.chunks || meta.chunks.length <= 1) return null;
    return meta.chunks.map((c) => ({ buffer: fs.readFileSync(c.path), start: c.start, end: c.end }));
  } catch (e) {
    onProgress(`⚠ 구간 분할 건너뜀(단일 처리): ${e.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function rasterizeBufferToBlocks(pdfBuffer, {
  maxPages,
  signal,
  manifestSourcePdf = pdfBuffer,
  pageOffset = 0,
  totalPageCount = null,
  visualAdjudicationInputSha256 = null,
} = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfras-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const meta = await rasterizePages(pdfPath, tmpDir, { maxPages, signal });
    assertCompleteRasterization(meta, { context: "OCR 페이지 렌더링" });
    if (!meta.files || !meta.files.length) throw new Error("페이지 이미지를 생성하지 못했습니다.");
    const tileBuffers = meta.files.map((file) => fs.readFileSync(file));
    const prepared = await prepareOcrModelInputs({
      rasterFiles: meta.files,
      tileBuffers,
      transformOptions: { forceCompress: true },
    });
    assertCompleteRasterization(meta, {
      preparedCount: prepared.imageBlocks.length,
      context: "OCR 모델 입력 준비",
    });
    const ocrRenderManifest = buildOcrRenderManifest({
      sourcePdf: manifestSourcePdf,
      pageCount: totalPageCount == null ? meta.page_count : totalPageCount,
      rasterFiles: meta.files,
      rasterPages: meta.pages,
      tileBuffers,
      modelInputBlocks: prepared.imageBlocks,
      modelInputProofs: prepared.modelInputProofs,
      pageOffset,
      expectedLocalPages: meta.rendered_pages,
      visualAdjudicationInputSha256,
    });
    return {
      imageBlocks: prepared.imageBlocks,
      tileBuffers,
      tiles: meta.tiles,
      pageCount: meta.page_count,
      ocrRenderManifest,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

async function extractFiguresForRetypeset(pdfBuffer, { signal, onProgress }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdffig-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    const maxFigures = Math.max(
      1,
      parseInt(process.env.PDF_RETYPESET_MAX_FIGURES || "80", 10) || 80,
    );
    const meta = await extractFigures(pdfPath, tmpDir, { signal, maxFigures });
    return (meta.figures || []).map((f) => {
      try {
        return {
          id: f.id,
          n: f.n,
          page: f.page,
          caption: f.caption || "",
          anchor: f.anchor || "",
          buffer: fs.readFileSync(f.file),
        };
      } catch (error) {
        const readError = new Error(
          `추출 그림 occurrence ${f && f.id ? f.id : "unknown"} 파일을 읽지 못했습니다: ${error.message}`,
        );
        readError.code = "PDF_FIGURE_EXTRACTION_INCOMPLETE";
        throw readError;
      }
    });
  } catch (e) {
    onProgress(`❌ 그림 추출 완전성 검증 실패: ${e.message}`);
    throw e;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}
async function prepareScannedRouting(
  pdfBuffer,
  { signal, onProgress, ocrDependencies = {}, beforeVisionModel = null } = {},
) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdftr-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    let scanned = false, garbled = false, ocrLayer = false;
    let mathDensity = 0, twoColumn = false, pageCount = 0;
    try {
      const a = await analyzePdf(pdfPath, { signal });
      scanned = !!a.scanned;
      garbled = !!a.garbled;
      ocrLayer = !!a.ocr_layer;
      mathDensity = Number(a.math_density) || 0;
      twoColumn = !!a.two_column;
      pageCount = Math.max(0, Number(a.page_count) || 0);
    } catch (e) {
      onProgress(`⚠ 텍스트 레이어 분석을 건너뜁니다: ${e.message}`);
      return { scanned: false, imageBlocks: null, mathDensity: 0, twoColumn: false, pageCount: 0 };
    }
    if (!scanned && !garbled) return { scanned: false, imageBlocks: null, mathDensity, twoColumn, pageCount };
    scanned = true;
    const { maxPages: overallMaxPages, ocrMaxPages } = resolvePdfTranslationLimits({
      defaultMaxPages: 700,
    });
    const ocrPageLimit = Math.min(overallMaxPages, ocrMaxPages);
    assertPdfTranslationInputCoverage({
      routing: { pageCount, truncated: false },
      maxPages: ocrPageLimit,
    });
    onProgress("🖼️ 텍스트 레이어가 없는 스캔/이미지 PDF 감지 → 고해상도 OCR 재조판으로 전환");
    let hiddenOcrPageTexts = null;
    if (ocrLayer) {
      const pageTextResult = await extractPageTexts(pdfPath, { signal });
      hiddenOcrPageTexts = Array.isArray(pageTextResult.pages) ? pageTextResult.pages : null;
    }
    // Fail an explicit renderer prerequisite before strict OCR/provider work.
    if (typeof beforeVisionModel === "function") beforeVisionModel();
    onProgress("🔎 strict OCR source evidence 생성·검증 중...");
    const strictOcr = await prepareStrictScanOcr({
      pdfBuffer,
      hiddenOcrPageTexts,
      signal,
      visualAdjudicator: mistralRiskVisualAdjudicator,
      ...ocrDependencies,
    });
    assertPdfTranslationInputCoverage({
      routing: { pageCount: strictOcr.evidence.page_count, truncated: false },
      maxPages: ocrPageLimit,
    });
    onProgress(`✅ strict OCR evidence ${strictOcr.evidence.page_count}쪽 검증 완료`);
    const chunkPages = Math.max(
      1,
      parseInt(process.env.PDF_OCR_CHUNK_PAGES || "10", 10),
    );
    if (pageCount > chunkPages) {
      return {
        scanned: true,
        largeVision: true,
        imageBlocks: null,
        pageCount,
        mathDensity,
        twoColumn,
        ocrLayer,
        pageTexts: strictOcr.pageTexts,
        ocrEvidence: strictOcr.evidence,
        visualAdjudicationInputSha256:
          strictOcr.visualAdjudicationInputSha256 || null,
      };
    }
    const meta = await rasterizePages(pdfPath, tmpDir, {
      maxPages: ocrPageLimit,
      signal,
    });
    assertCompleteRasterization(meta, { context: "OCR 페이지 렌더링" });
    if (!meta.files || !meta.files.length) throw new Error("페이지 이미지를 생성하지 못했습니다.");
    onProgress(`🧩 페이지를 ${meta.tiles}개 이미지 조각으로 분할(읽기 좋게)`);
    const tileBuffers = meta.files.map((f) => fs.readFileSync(f));
    const prepared = await prepareOcrModelInputs({
      rasterFiles: meta.files,
      tileBuffers,
      transformOptions: { forceCompress: true },
    });
    const blocks = prepared.imageBlocks;
    assertCompleteRasterization(meta, {
      preparedCount: blocks.length,
      context: "OCR 모델 입력 준비",
    });
    const ocrRenderManifest = buildOcrRenderManifest({
      sourcePdf: pdfBuffer,
      pageCount: meta.page_count,
      rasterFiles: meta.files,
      rasterPages: meta.pages,
      tileBuffers,
      modelInputBlocks: blocks,
      modelInputProofs: prepared.modelInputProofs,
      expectedLocalPages: meta.rendered_pages,
      visualAdjudicationInputSha256:
        strictOcr.visualAdjudicationInputSha256 || null,
    });
    return {
      scanned: true, imageBlocks: blocks, tileBuffers,
      truncated: !!meta.truncated, tiles: meta.tiles, pageCount: meta.page_count,
      mathDensity, twoColumn, ocrLayer,
      pageTexts: strictOcr.pageTexts,
      ocrEvidence: strictOcr.evidence,
      visualAdjudicationInputSha256:
        strictOcr.visualAdjudicationInputSha256 || null,
      ocrRenderManifest,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function buildOcrHint(pageTexts, startPage, endPage) {
  if (!Array.isArray(pageTexts) || !pageTexts.length) return null;
  const parts = [];
  let budget = Math.max(
    4000,
    parseInt(process.env.PDF_OCR_HINT_BUDGET_CHARS || "40000", 10),
  );
  for (const page of pageTexts) {
    if (budget < 200) break;
    const pageNumber = Number(page?.page);
    if (!pageNumber || pageNumber < startPage || pageNumber > endPage) continue;
    const text = String(page?.text || "").trim();
    if (!text) continue;
    const head = `[원본 ${pageNumber}쪽 OCR]\n`;
    let chunk = head + text;
    if (chunk.length > budget) {
      chunk = head + text.slice(0, Math.max(0, budget - head.length - 12)) + " …(잘림)";
    }
    parts.push(chunk);
    budget -= chunk.length;
  }
  return parts.length ? parts.join("\n\n") : null;
}

async function translateLargeVisionPdf({
  pdfBuffer,
  pageCount,
  model,
  effectiveRenderer,
  signal,
  onProgress,
  pageTexts,
  ocrEvidence,
  visualAdjudicationInputSha256 = null,
}) {
  const chunkPages = Math.max(
    1,
    parseInt(process.env.PDF_OCR_CHUNK_PAGES || "10", 10),
  );
  const chunks = await splitPdfToBuffers(pdfBuffer, {
    signal,
    onProgress,
    pagesPerChunk: chunkPages,
  });
  if (!chunks || chunks.length <= 1) {
    throw qualityFailure(
      "대용량 OCR 문서를 안전한 페이지 구간으로 나누지 못해 작업을 중단했습니다.",
      { kind: "ocr_chunk_split_failed", pageCount, chunkPages },
    );
  }
  onProgress(
    `📚 ${pageCount}쪽을 ${chunkPages}쪽씩 ${chunks.length}개 구간으로 나눠 OCR 재조판 후 합칩니다.`,
  );

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const cpuGate = makeGate(
    Math.max(1, parseInt(process.env.PDF_OCR_CPU_CONCURRENCY || "2", 10)),
  );
  const concurrency = Math.max(
    1,
    parseInt(process.env.PDF_OCR_CHUNK_CONCURRENCY || "6", 10),
  );
  const retries = Math.max(
    0,
    parseInt(process.env.PDF_OCR_CHUNK_RETRIES || "1", 10),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfviz-"));
  const results = new Array(chunks.length);
  let next = 0;
  let done = 0;
  let fatalError = null;

  const worker = async () => {
    for (;;) {
      if (ctrl.signal.aborted) throw new Error("작업이 중단되었습니다.");
      const index = next++;
      if (index >= chunks.length) return;
      const chunk = chunks[index];
      let blocks = null;
      let output = null;
      let lastError = null;
      let attempts = 0;
      try {
        blocks = await cpuGate(() => rasterizeBufferToBlocks(chunk.buffer, {
          maxPages: chunkPages + 4,
          signal: ctrl.signal,
          manifestSourcePdf: pdfBuffer,
          pageOffset: chunk.start - 1,
          totalPageCount: pageCount,
          visualAdjudicationInputSha256,
        }));
      } catch (error) {
        if (ctrl.signal.aborted) throw error;
        lastError = error;
      }
      for (let attempt = 0; blocks && attempt <= retries && !output; attempt += 1) {
        attempts += 1;
        try {
          output = await retypesetPdf({
            pdfBuffer: chunk.buffer,
            imageBlocks: blocks.imageBlocks,
            tiles: blocks.tileBuffers,
            ocrHint: buildOcrHint(pageTexts, chunk.start, chunk.end),
            ocrEvidence,
            ocrRenderManifest: blocks.ocrRenderManifest,
            ocrSourcePdf: pdfBuffer,
            ocrEvidencePageIndices: Array.from(
              { length: chunk.end - chunk.start + 1 },
              (_, offset) => chunk.start - 1 + offset,
            ),
            pageNumbers: false,
            model,
            renderer: effectiveRenderer,
            cpuGate,
            signal: ctrl.signal,
            onProgress: () => {},
          });
        } catch (error) {
          if (ctrl.signal.aborted) throw error;
          lastError = error;
        }
      }
      if (!output) {
        const reason = String(lastError?.message || "알 수 없는 OCR/LaTeX 오류").slice(0, 240);
        fatalError = qualityFailure(
          `OCR 재조판 품질 검증 실패: ${chunk.start}–${chunk.end}쪽 구간을 완성하지 못했습니다 (${reason}).`,
          {
            kind: "ocr_chunk_failed",
            chunk: index + 1,
            startPage: chunk.start,
            endPage: chunk.end,
            attempts,
          },
        );
        ctrl.abort(fatalError);
        throw fatalError;
      }
      const partPath = path.join(dir, `part-${index}.pdf`);
      fs.writeFileSync(partPath, output.buffer);
      results[index] = {
        partPath,
        figures: output.figures || 0,
        ocrRenderManifest: output.ocrRenderManifest || null,
        ocrEvidenceSubset: output.ocrEvidenceSubset || null,
        translationProvider: output.translationProvider || null,
        translationRequestId: output.translationRequestId || null,
      };
      done += 1;
      onProgress(`✅ 구간 ${done}/${chunks.length} 완료 (${chunk.start}–${chunk.end}쪽)`);
    }
  };

  try {
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()),
    );
    if (fatalError) throw fatalError;
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (rejected) throw rejected.reason;
    if (ctrl.signal.aborted) throw new Error("작업이 중단되었습니다.");
    assertCompleteChunkResults(results, {
      expectedCount: chunks.length,
      context: "OCR 재조판 구간 병합",
    });
    for (let index = 0; index < results.length; index += 1) {
      const chunk = chunks[index];
      assertCanonicalOcrChunkSubset({
        reportedSubset: results[index].ocrEvidenceSubset,
        ocrEvidence,
        ocrRenderManifest: results[index].ocrRenderManifest,
        sourcePdf: pdfBuffer,
        expectedPageIndices: Array.from(
          { length: chunk.end - chunk.start + 1 },
          (_, offset) => chunk.start - 1 + offset,
        ),
        chunk: index + 1,
      });
    }
    onProgress(`🧩 ${chunks.length}개 구간을 하나의 PDF로 합치는 중...`);
    const outPath = path.join(dir, "merged.pdf");
    await mergePdf(outPath, results.map((entry) => entry.partPath), { signal });
    const buffer = assertGeneratedOutputMagic(
      fs.readFileSync(outPath),
      "pdf",
      "vision merge output",
    );
    const ocrRenderManifest = mergeOcrRenderManifests({
      sourcePdf: pdfBuffer,
      pageCount,
      manifests: results.map((entry) => entry.ocrRenderManifest),
    });
    const providers = [...new Set(
      results.map((entry) => entry.translationProvider).filter(Boolean),
    )];
    const requestIds = results.map((entry) => entry.translationRequestId).filter(Boolean);
    if (providers.length !== 1 || requestIds.length !== results.length) {
      throw qualityFailure(
        "OCR 재조판 구간의 번역 request provenance가 불완전합니다.",
        { kind: "ocr_translation_request_provenance_missing" },
      );
    }
    return {
      buffer,
      pageCount,
      figures: results.reduce((sum, entry) => sum + entry.figures, 0),
      model,
      ocrEvidence,
      ocrRenderManifest,
      translationProvider: providers[0],
      translationRequestId: `batch-${crypto
        .createHash("sha256")
        .update(JSON.stringify(requestIds), "utf8")
        .digest("hex")}`,
    };
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// 단순 시간 예측(비용 표시 없음 — 독립 사이트는 크레딧 없음).
function estimateTime(meta, mode, modelId) {
  const pages = Math.max(1, Number(meta.page_count) || 1);
  const chars = Math.max(0, Number(meta.text_chars) || 0);
  const scanned = !!meta.scanned;
  const density = Number(meta.math_density) || 0;
  const resolvedMode = resolvePdfTranslationMode({
    requestedMode: mode,
    routing: { scanned, mathDensity: density },
  }).resolvedMode;
  const isOpus = /opus/i.test(modelId || "");
  const { maxPages, ocrMaxPages: ocrMax } = resolvePdfTranslationLimits({
    defaultMaxPages: 700,
  });
  const effectiveMaxPages = scanned ? Math.min(maxPages, ocrMax) : maxPages;
  let seconds = 0;
  if (scanned) {
    const procPages = pages;
    const tiles = Math.min(100, Math.ceil(procPages * 1.3));
    seconds = 1.5 * procPages + tiles * (isOpus ? 4.0 : 2.6) + 18;
  } else if (resolvedMode === "retypeset") {
    const waves = Math.ceil(Math.ceil(pages / 5) / 6);
    seconds = 0.3 * pages + waves * (isOpus ? 45 : 28) + 18;
  } else {
    const waves = Math.ceil(Math.max(1, Math.ceil(chars / 3500)) / 10);
    seconds = 1.2 * pages + (waves + 1) * (isOpus ? 13 : 8);
  }
  return {
    mode: resolvedMode, scanned, pages, chars,
    truncated: false,
    tooManyPages: pages > effectiveMaxPages,
    maxPages: effectiveMaxPages,
    overallMaxPages: maxPages,
    ocrMaxPages: Math.min(maxPages, ocrMax),
    seconds: { lo: Math.round(seconds * 0.8), hi: Math.round(seconds * 1.55) },
  };
}

async function runPdfTranslation(
  job,
  { pdfBuffer, originalName, model, mode, renderer = "auto", ocrDependencies = {} },
) {
  const t0 = Date.now();
  const timeoutMin = Math.round(PDF_TRANSLATE_TIMEOUT_MS / 60000);
  pushProgress(job, `🚀 PDF 통번역 시작 (timeout: ${timeoutMin}분)`);
  const ac = new AbortController();
  job.abortController = ac;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pushProgress(job, `⏰ ${timeoutMin}분 초과 — 강제 종료 중...`);
    ac.abort();
  }, PDF_TRANSLATE_TIMEOUT_MS);
  try {
    pushProgress(job, `📥 PDF 수신 (${Math.round(pdfBuffer.length / 1024)}KB)`);
    const onProgress = (msg) => pushProgress(job, msg);
    const requestedRenderer = normalizeRequestedRenderer(renderer);
    let libreOfficeReady = false;
    const preflightLibreOffice = () => {
      if (requestedRenderer !== "libreoffice" || libreOfficeReady) return;
      const binary = assertLibreOfficeRendererAvailable({
        env: process.env,
        findLibreOfficeBinary,
      });
      libreOfficeReady = true;
      onProgress(`🖨️ LibreOffice 출력 엔진 확인 완료 (${path.basename(binary)})`);
    };
    // Explicit LibreOffice is an operator-controlled capability even if mode
    // resolution would later select in-place output. Fail before any provider.
    if (requestedRenderer === "libreoffice") preflightLibreOffice();
    const routing = await prepareScannedRouting(pdfBuffer, {
      signal: ac.signal,
      onProgress,
      ocrDependencies,
      beforeVisionModel:
        requestedRenderer === "libreoffice" ? preflightLibreOffice : null,
    });
    const { maxPages } = resolvePdfTranslationLimits({ defaultMaxPages: 700 });
    assertPdfTranslationInputCoverage({ routing, maxPages });
    const modeDecision = resolvePdfTranslationMode({
      requestedMode: mode,
      routing,
    });
    const normalizedMode = modeDecision.requestedMode;
    const isAuto = modeDecision.isAuto;
    const resolvedMode = modeDecision.resolvedMode;
    const rendererDecision = resolvePdfTranslationRenderer({
      requestedRenderer,
      effectiveMode: resolvedMode,
    });
    const effectiveRenderer = rendererDecision.effectiveRenderer;
    if (rendererDecision.applies) {
      if (requestedRenderer === "libreoffice") preflightLibreOffice();
      onProgress(
        `🖨️ 재조판 출력 엔진 → ${effectiveRenderer === "libreoffice" ? "LibreOffice" : "Tectonic"}`,
      );
    }
    if (normalizedMode === "inplace" && routing.scanned)
      pushProgress(job, "⚠ 스캔본/이미지 PDF는 '빠른 번역'이 불가능 → 'OCR 재조판'으로 전환합니다.");
    else if (isAuto)
      pushProgress(job, `🔎 자동 변환방식 → ${resolvedMode === "retypeset" ? "재조판(수식·정밀)" : "빠른 번역(레이아웃 유지)"}` + (routing.scanned ? " · 스캔본 감지" : ` · 수식밀도 ${routing.mathDensity ?? 0}`));

    let effectiveMode = resolvedMode;
    let result;
    if (routing.scanned && routing.largeVision) {
      result = await translateLargeVisionPdf({
        pdfBuffer,
        pageCount: routing.pageCount,
        model,
        effectiveRenderer,
        pageTexts: routing.pageTexts || null,
        ocrEvidence: routing.ocrEvidence,
        visualAdjudicationInputSha256:
          routing.visualAdjudicationInputSha256 || null,
        signal: ac.signal,
        onProgress,
      });
      effectiveMode = "retypeset";
      if (result.figures) pushProgress(job, `🖼️ 원본 그림 ${result.figures}개를 본문에 복원했습니다.`);
    } else if (routing.scanned && routing.imageBlocks) {
      const ocrHint = buildOcrHint(
        routing.pageTexts,
        1,
        Number.MAX_SAFE_INTEGER,
      );
      result = await retypesetPdf({
        pdfBuffer,
        imageBlocks: routing.imageBlocks,
        tiles: routing.tileBuffers,
        ocrHint,
        ocrEvidence: routing.ocrEvidence,
        ocrRenderManifest: routing.ocrRenderManifest,
        ocrSourcePdf: pdfBuffer,
        ocrEvidencePageIndices: Array.from(
          { length: routing.pageCount },
          (_, index) => index,
        ),
        model,
        renderer: effectiveRenderer,
        signal: ac.signal,
        onProgress,
      });
      effectiveMode = "retypeset";
      if (result.figures) pushProgress(job, `🖼️ 원본 그림 ${result.figures}개를 본문에 복원했습니다.`);
    } else if (resolvedMode === "retypeset") {
      try {
        const figures = await extractFiguresForRetypeset(pdfBuffer, { signal: ac.signal, onProgress });
        if (figures.length) pushProgress(job, `🖼️ 본문 그림 ${figures.length}개 추출 — 재조판본에 복원합니다.`);
        if (routing.twoColumn) pushProgress(job, "📐 2단 레이아웃 감지 — 2단으로 조판합니다.");
        const pdfChunks = await splitPdfToBuffers(pdfBuffer, { signal: ac.signal, onProgress });
        result = await retypesetPdf({ pdfBuffer, pdfChunks, figures, twoColumn: routing.twoColumn, model, renderer: effectiveRenderer, signal: ac.signal, onProgress });
        if (result.figures) pushProgress(job, `🖼️ 원본 그림 ${result.figures}개를 재조판본에 복원했습니다.`);
      } catch (e) {
        if (ac.signal.aborted || timedOut) throw e;
        const reason = String(e && (e.message || e)).slice(0, 240);
        const retypesetContext =
          normalizedMode === "retypeset"
            ? "사용자가 선택한 재조판"
            : "문서 품질 분석에서 필요하다고 판정된 재조판";
        throw qualityFailure(
          `${retypesetContext}을 완료하지 못했습니다: ${reason}. ` +
            "빠른 번역으로 자동 변경하면 필요한 조판 방식과 결과 보존 수준이 달라지므로 작업을 중단했습니다.",
          {
            kind: "requested_retypeset_failed",
            requestedMode: normalizedMode,
            cause: reason,
          },
        );
      }
    } else {
      result = await translatePdf({ pdfBuffer, model, signal: ac.signal, onProgress });
    }

    const terminal = await finalizePdfTranslationOutput({
      originalBuffer: pdfBuffer,
      resultBuffer: result.buffer,
      effectiveMode,
      signal: ac.signal,
      onProgress,
      ocrEvidence: result.ocrEvidence || null,
      ocrRenderManifest: result.ocrRenderManifest || null,
      ocrSemanticReviewContext: routing.scanned
        ? {
            generationProvider: result.translationProvider,
            generationModel: result.model || model,
            generationRequestId: result.translationRequestId,
          }
        : null,
      requireOcrEvidence: !!routing.scanned,
    });
    job.result = terminal.buffer;
    job.mimeType = "application/pdf";
    job.filename = buildTranslatedFilename(originalName, terminal.suffix);
    job.effectiveMode = terminal.effectiveMode;
    job.effectiveRenderer = effectiveRenderer;
    job.status = "done";
    const totalSec = Math.floor((Date.now() - t0) / 1000);
    const outKB = Math.round(terminal.buffer.length / 1024);
    pushProgress(
      job,
      effectiveMode === "retypeset"
        ? `🎉 재조판 완료! ${outKB}KB, 총 ${totalSec}초. 다운로드 가능합니다.`
        : `🎉 완료! ${result.pageCount}쪽 / 문단 ${result.blockCount}개 → ${outKB}KB, 총 ${totalSec}초. 다운로드 가능합니다.`,
    );
  } catch (e) {
    if (timedOut) throw new Error(`${timeoutMin}분 timeout 으로 강제 종료되었습니다.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
  job.listeners.forEach((r) => { sendSse(r, "done", { filename: job.filename, effectiveMode: job.effectiveMode, effectiveRenderer: job.effectiveRenderer }); r.end(); });
  job.listeners = [];
}

// ── 라우트 ───────────────────────────────────────────────────────────────────
// Public, read-only capability metadata. No binary path or environment value
// is returned; clients only receive a fail-closed availability bit.
app.get("/api/translate-pdf/capabilities", (_req, res) => {
  res.json(getPdfRendererCapabilities());
});

app.post("/api/translate-pdf/estimate", requireCode, upload.single("pdf"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "PDF 파일이 필요합니다." });
  try {
    assertRequestedPdfRenderersAvailable(req.body);
  } catch (error) {
    return sendRendererUnavailable(res, error);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdfest-"));
  const pdfPath = path.join(tmpDir, "in.pdf");
  try {
    fs.writeFileSync(pdfPath, req.file.buffer);
    const meta = await analyzePdf(pdfPath, {});
    res.json({ ...estimateTime(meta, String(req.body.mode || "auto"), String(req.body.model || DEFAULT_MODEL)), meta });
  } catch (e) {
    res.status(500).json({ error: e.message || "예측 실패" });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

app.post("/api/translate-pdf", requireCode, upload.single("pdf"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "PDF 파일을 업로드하세요." });
  file.originalname = normalizeUploadFilename(file.originalname);
  if (file.mimetype !== "application/pdf" && !/\.pdf$/i.test(file.originalname || ""))
    return res.status(400).json({ error: "PDF 파일만 업로드 가능합니다." });
  const requested = String(req.body.model || "").trim();
  const model = ALLOWED_MODELS.includes(requested) ? requested : DEFAULT_MODEL;
  const mode = normalizeRequestedMode(req.body.mode);
  let rendererInput = req.body.renderer;
  try {
    const perFile = JSON.parse(String(req.body.renderers || "null"));
    if (Array.isArray(perFile) && perFile.length) rendererInput = perFile[0];
  } catch (_) {
    // Optional per-file JSON is ignored when malformed; the common value wins.
  }
  const renderer = normalizeRequestedRenderer(rendererInput);
  try {
    assertRequestedPdfRenderersAvailable({
      ...req.body,
      renderer: rendererInput,
    });
  } catch (error) {
    return sendRendererUnavailable(res, error);
  }
  const job = createJob();
  res.json({ jobId: job.id });
  runPdfTranslation(job, { pdfBuffer: file.buffer, originalName: file.originalname || "document.pdf", model, mode, renderer }).catch((err) => {
    job.status = "error";
    job.error = err.message || String(err);
    pushProgress(job, `❌ 오류: ${job.error}`);
    job.listeners.forEach((r) => { sendSse(r, "error", job.error); r.end(); });
    job.listeners = [];
  });
});

app.get("/api/jobs/:id/stream", requireCode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  job.progress.forEach((p) => sendSse(res, "progress", p));
  if (job.status === "done") { sendSse(res, "done", { filename: job.filename, effectiveMode: job.effectiveMode, effectiveRenderer: job.effectiveRenderer }); return res.end(); }
  if (job.status === "error") { sendSse(res, "error", job.error); return res.end(); }
  job.listeners.push(res);
  req.on("close", () => { job.listeners = job.listeners.filter((r) => r !== res); });
});

app.get("/api/jobs/:id/download", requireCode, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== "done" || !job.result)
    return res.status(404).json({ error: "결과를 찾을 수 없습니다(만료되었거나 미완료)." });
  const fn = job.filename || "translated.pdf";
  res.setHeader("Content-Type", job.mimeType || "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="translated.pdf"; filename*=UTF-8''${encodeURIComponent(fn)}`,
  );
  res.setHeader("Content-Length", job.result.length);
  res.send(job.result);
});

// ── 정적 (UI) ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "translate-app.html")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));
app.get("/healthz", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[translate] PDF 통번역 사이트 :${PORT} (gate=${OPEN_NO_GATE ? "OPEN(dev)" : CODES.length + " codes"})`);
  if (IS_PROD && CODES.length === 0)
    console.warn("[translate] ⚠ TRANSLATE_ACCESS_CODES 미설정 — 프로덕션에서 모든 접근이 차단됩니다.");
});
