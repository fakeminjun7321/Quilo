"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const sharp = require("sharp");
const byok = require("../../byok");
const { isGptModel } = require("../../model-call");
const { prepareImageForAnthropic, toAnthropicImageBlock } = require("../../anthropic-media");
const { parseJsonLenient } = require("../../json-sanitize");

const QA_DPI = 300;
const MIN_TRANSCRIPT_SIMILARITY = Number(process.env.PRINT_RESTORE_MIN_OCR_SIMILARITY || 0.62);
const MIN_LAYOUT_SIMILARITY = Number(process.env.PRINT_RESTORE_MIN_LAYOUT_SIMILARITY || 0.70);
const MIN_SOURCE_COVERAGE = Number(process.env.PRINT_RESTORE_MIN_SOURCE_COVERAGE || 0.68);
const MAX_SOURCE_COVERAGE = Number(process.env.PRINT_RESTORE_MAX_SOURCE_COVERAGE || 1.35);

const QA_SYSTEM = `You are an independent, strict document-restoration quality inspector. You did not create either image.

You receive exactly two images: (1) a photograph of a printed source page, then (2) a 300 dpi render of a reconstructed PDF page.

Inspect both visually at full resolution. OCR only the PRINTED content; ignore handwriting, shadows, paper curl and background objects. Compare exact Korean/English text, numbers, units, equations, tables, page furniture, diagrams and graphs. For a diagram, judge its semantic relationships, not only visual resemblance: arrow direction, axis direction, labels attached to the correct object, angle/dimension endpoints, curve topology and causal ordering must agree. A clean but physically wrong redraw is a critical error.

Return one JSON object only:
{
  "source_transcript": "printed text in reading order; equations may be canonical LaTeX",
  "output_transcript": "visible output text in reading order; equations may be canonical LaTeX",
  "text_similarity": 0.0,
  "layout_similarity": 0.0,
  "diagram_semantics_ok": true,
  "no_overlap": true,
  "no_clipping": true,
  "critical_issues": [],
  "warnings": []
}

Critical issues include missing/changed printed sentences or numbers, invented values, unreadable output, text overlap/clipping, missing table cells, and a semantically incorrect graph/diagram. Do not excuse such defects because the output looks neat.`;

function pythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const local = path.resolve(process.cwd(), ".venv/bin/python3");
  return fs.existsSync(local) ? local : "python3";
}

function runProcess(bin, args, { signal, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let finished = false;
    let abortHandler = null;
    const detachAbort = () => {
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    };
    const timer = setTimeout(() => {
      if (!finished) child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      detachAbort();
      reject(error);
    });
    child.on("close", (code, sig) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      detachAbort();
      if (code !== 0) {
        reject(new Error(`프로세스 실패(${path.basename(bin)}, code=${code}, signal=${sig || ""}): ${Buffer.concat(err).toString("utf8").slice(-600)}`));
      } else resolve(Buffer.concat(out).toString("utf8"));
    });
    if (signal) {
      abortHandler = () => child.kill("SIGKILL");
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

async function renderPdf300(pdfBuffer, { signal } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "print-restore-qa-"));
  const pdfPath = path.join(root, "output.pdf");
  const renderDir = path.join(root, "renders");
  fs.writeFileSync(pdfPath, pdfBuffer);
  try {
    const raw = await runProcess(
      pythonBin(),
      [path.join(__dirname, "render_pdf.py"), pdfPath, renderDir, String(QA_DPI)],
      { signal, timeout: 180000 },
    );
    const manifest = JSON.parse(raw);
    if (!manifest || !Array.isArray(manifest.pages) || !manifest.pages.length) {
      throw new Error("300dpi 렌더 manifest가 비어 있습니다.");
    }
    const pages = manifest.pages.map((page) => ({ ...page, buffer: fs.readFileSync(page.path) }));
    return { pages, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function extractJson(text) {
  const fenced = String(text || "").match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : String(text || "");
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("QA 모델이 JSON 객체를 반환하지 않았습니다.");
  return parseJsonLenient(raw.slice(first, last + 1));
}

function normalizedText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

function ngrams(text, n = 2) {
  const out = new Map();
  if (text.length < n) return new Map([[text, 1]]);
  for (let i = 0; i <= text.length - n; i += 1) {
    const gram = text.slice(i, i + n);
    out.set(gram, (out.get(gram) || 0) + 1);
  }
  return out;
}

function diceSimilarity(a, b) {
  const x = normalizedText(a);
  const y = normalizedText(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const ax = ngrams(x);
  const by = ngrams(y);
  let common = 0;
  let totalA = 0;
  let totalB = 0;
  for (const count of ax.values()) totalA += count;
  for (const count of by.values()) totalB += count;
  for (const [key, count] of ax.entries()) common += Math.min(count, by.get(key) || 0);
  return (2 * common) / Math.max(1, totalA + totalB);
}

function validateQaResponse(raw, pageNumber) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`QA ${pageNumber}페이지 응답이 객체가 아닙니다.`);
  const sourceTranscript = String(raw.source_transcript || "").trim();
  const outputTranscript = String(raw.output_transcript || "").trim();
  const sourceLength = normalizedText(sourceTranscript).length;
  const outputLength = normalizedText(outputTranscript).length;
  const localSimilarity = diceSimilarity(sourceTranscript, outputTranscript);
  const modelSimilarity = Number(raw.text_similarity);
  const layoutSimilarity = Number(raw.layout_similarity);
  const critical = Array.isArray(raw.critical_issues) ? raw.critical_issues.map(String).filter(Boolean).slice(0, 20) : ["QA critical_issues 형식 오류"];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(String).filter(Boolean).slice(0, 20) : [];
  const coverage = sourceLength > 0 ? outputLength / sourceLength : outputLength === 0 ? 1 : 0;
  const evidenceUsable = sourceLength >= 12 && outputLength >= 8;
  const defects = [];
  if (!evidenceUsable) defects.push("OCR 전사 증거가 너무 짧음");
  if (!Number.isFinite(modelSimilarity) || modelSimilarity < MIN_TRANSCRIPT_SIMILARITY) defects.push(`vision 텍스트 유사도 ${modelSimilarity}`);
  if (localSimilarity < MIN_TRANSCRIPT_SIMILARITY) defects.push(`독립 전사 Dice 유사도 ${localSimilarity.toFixed(3)}`);
  if (!Number.isFinite(layoutSimilarity) || layoutSimilarity < MIN_LAYOUT_SIMILARITY) defects.push(`레이아웃 유사도 ${layoutSimilarity}`);
  if (coverage < MIN_SOURCE_COVERAGE || coverage > MAX_SOURCE_COVERAGE) defects.push(`전사 길이 coverage ${coverage.toFixed(3)}`);
  if (raw.diagram_semantics_ok !== true) defects.push("그림/그래프 의미 관계 불일치");
  if (raw.no_overlap !== true) defects.push("텍스트/도형 겹침");
  if (raw.no_clipping !== true) defects.push("페이지 잘림");
  if (critical.length) defects.push(...critical);
  return {
    ok: defects.length === 0,
    sourceLength,
    outputLength,
    coverage,
    localSimilarity,
    modelSimilarity,
    layoutSimilarity,
    warnings,
    defects,
  };
}

async function checkRenderPixels(page, pageNumber) {
  const meta = await sharp(page.buffer).metadata();
  if (page.dpi !== QA_DPI || (meta.width || 0) < 2400 || (meta.height || 0) < 3400) {
    throw new Error(`QA ${pageNumber}페이지가 300dpi A4로 렌더되지 않았습니다(${meta.width}x${meta.height}).`);
  }
  const stats = await sharp(page.buffer).greyscale().stats();
  const mean = stats.channels[0]?.mean ?? 255;
  if (mean > 254.6) throw new Error(`QA ${pageNumber}페이지 출력이 사실상 빈 페이지입니다.`);
  return { width: meta.width, height: meta.height, mean };
}

async function callQaModel({ model, sourcePhoto, outputRender, pageNumber, signal, onProgress }) {
  const opts = { maxEdge: 2200, maxBase64Chars: 3_800_000, forceCompress: true };
  const source = await prepareImageForAnthropic(sourcePhoto, opts);
  const output = await prepareImageForAnthropic({ buffer: outputRender, name: `render-${pageNumber}.png`, mimetype: "image/png" }, opts);
  if (!source.ok || !output.ok) {
    throw new Error(`QA 이미지 전처리 실패(${pageNumber}페이지): ${source.reason || output.reason}`);
  }
  const content = [
    { type: "text", text: `[SOURCE PHOTO, page ${pageNumber}]` },
    toAnthropicImageBlock(source),
    { type: "text", text: `[RESTORED PDF RENDER AT 300 DPI, page ${pageNumber}]` },
    toAnthropicImageBlock(output),
    { type: "text", text: "Independently OCR and compare these two images. Return the required JSON only." },
  ];
  if (isGptModel(model)) {
    const key = byok.openaiKey();
    if (!key) throw new Error("독립 QA를 위한 GPT_API_KEY가 없습니다.");
    onProgress(`🤖 ${model} 독립 QA 요청 중...`);
    const parts = content.map((b) => b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    const response = await fetch(`${process.env.GPT_API_BASE || "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: QA_SYSTEM }, { role: "user", content: parts }],
        max_completion_tokens: 12000,
        reasoning_effort: process.env.PRINT_RESTORE_GPT_QA_EFFORT || "medium",
        response_format: { type: "json_object" },
      }),
      signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`OpenAI QA ${response.status}: ${body.slice(0, 240)}`);
    const parsed = JSON.parse(body);
    const choice = parsed.choices?.[0] || {};
    if (choice.finish_reason === "length") throw new Error("독립 QA 응답이 길이 제한으로 잘렸습니다.");
    const u = parsed.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      raw: extractJson(choice.message?.content || ""),
      usage: {
        input_tokens: Math.max(0, Number(u.prompt_tokens || 0) - cached),
        output_tokens: Number(u.completion_tokens || 0),
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      },
      requestId: parsed.id || "",
    };
  }
  const key = byok.anthropicKey();
  if (!key) throw new Error("독립 QA를 위한 ANTHROPIC_API_KEY가 없습니다.");
  const client = new Anthropic({ apiKey: key, timeout: 15 * 60 * 1000 });
  const response = await client.messages.create({
    model,
    max_tokens: 12000,
    ...(/fable/i.test(model) ? {} : { thinking: { type: "disabled" } }),
    system: QA_SYSTEM,
    messages: [{ role: "user", content }],
  }, signal ? { signal } : undefined);
  const text = (response.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
  return { raw: extractJson(text), usage: response.usage || {}, requestId: response.id || "" };
}

function tesseractAvailable() {
  const bin = process.env.TESSERACT_BIN || "tesseract";
  const result = spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 3000 });
  return !result.error && result.status === 0 ? bin : null;
}

async function tesseractText(buffer, bin, root, stem, { signal } = {}) {
  const imagePath = path.join(root, `${stem}.png`);
  fs.writeFileSync(imagePath, await sharp(buffer).rotate().flatten({ background: "white" }).png().toBuffer());
  return runProcess(
    bin,
    [imagePath, "stdout", "-l", process.env.PRINT_RESTORE_TESSERACT_LANG || "kor+eng", "--psm", "6"],
    { signal, timeout: 120000 },
  );
}

async function runArtifactQa({ pdfBuffer, sourcePhotos, model, signal, onProgress = () => {}, usageSink = null }) {
  onProgress("🔍 300dpi 렌더 + 독립 OCR/시각 QA 시작...");
  const rendered = await renderPdf300(pdfBuffer, { signal });
  const warnings = [];
  const pageResults = [];
  const tesseract = tesseractAvailable();
  const tessRoot = tesseract ? fs.mkdtempSync(path.join(os.tmpdir(), "print-restore-tess-")) : null;
  try {
    if (rendered.pages.length !== sourcePhotos.length) {
      throw new Error(`복원 PDF 페이지 수(${rendered.pages.length})가 원본 사진 수(${sourcePhotos.length})와 다릅니다.`);
    }
    for (let i = 0; i < rendered.pages.length; i += 1) {
      const pageNumber = i + 1;
      await checkRenderPixels(rendered.pages[i], pageNumber);
      onProgress(`🔎 독립 vision OCR/그림 의미 검증 ${pageNumber}/${rendered.pages.length}`);
      const checked = await callQaModel({ model, sourcePhoto: sourcePhotos[i], outputRender: rendered.pages[i].buffer, pageNumber, signal, onProgress });
      if (usageSink && checked.usage) usageSink(checked.usage);
      const result = validateQaResponse(checked.raw, pageNumber);
      if (!checked.requestId) result.defects.push("독립 QA request ID 누락");
      if (tesseract) {
        try {
          const [sourceText, outputText] = await Promise.all([
            tesseractText(
              sourcePhotos[i].buffer,
              tesseract,
              tessRoot,
              `src-${pageNumber}`,
              { signal },
            ),
            tesseractText(
              rendered.pages[i].buffer,
              tesseract,
              tessRoot,
              `out-${pageNumber}`,
              { signal },
            ),
          ]);
          result.tesseractSimilarity = diceSimilarity(sourceText, outputText);
          if (!normalizedText(outputText)) result.defects.push("보조 Tesseract 출력이 비어 있음");
          else if (normalizedText(sourceText).length >= 20 && result.tesseractSimilarity < 0.18) {
            result.defects.push(`보조 Tesseract 유사도가 비정상적으로 낮음 ${result.tesseractSimilarity.toFixed(3)}`);
          } else if (normalizedText(sourceText).length >= 20 && result.tesseractSimilarity < 0.35) {
            warnings.push(`${pageNumber}페이지 Tesseract 유사도 낮음: ${result.tesseractSimilarity.toFixed(3)}`);
          }
        } catch (error) {
          warnings.push(`${pageNumber}페이지 Tesseract 보조 검사 실패: ${String(error.message).slice(0, 120)}`);
        }
      }
      result.ok = result.defects.length === 0;
      pageResults.push(result);
    }
    const failed = pageResults.map((p, i) => ({ p, page: i + 1 })).filter(({ p }) => !p.ok);
    if (failed.length) {
      const detail = failed.slice(0, 6).map(({ p, page }) => `${page}p: ${p.defects.slice(0, 4).join(", ")}`).join(" | ");
      throw new Error(`복원 PDF 품질 게이트 실패(${failed.length}/${pageResults.length}페이지): ${detail}`);
    }
    const avg = (key) => pageResults.reduce((sum, p) => sum + (Number(p[key]) || 0), 0) / pageResults.length;
    const qa = {
      ok: true,
      qualityGate: "ocr-visual-300dpi",
      pageCount: pageResults.length,
      renderedDpi: QA_DPI,
      ocrCoverage: Number(avg("coverage").toFixed(4)),
      visualPassed: true,
      summary: `독립 vision OCR/레이아웃/그림 의미 검증 ${pageResults.length}페이지 통과 (전사 Dice ${avg("localSimilarity").toFixed(3)}, 레이아웃 ${avg("layoutSimilarity").toFixed(3)})`,
      warnings: [...warnings, ...pageResults.flatMap((p, i) => p.warnings.map((w) => `${i + 1}p: ${w}`))].slice(0, 30),
    };
    return qa;
  } finally {
    rendered.cleanup();
    if (tessRoot) fs.rmSync(tessRoot, { recursive: true, force: true });
  }
}

module.exports = {
  QA_DPI,
  normalizedText,
  diceSimilarity,
  validateQaResponse,
  renderPdf300,
  runArtifactQa,
  _runProcess: runProcess,
  _tesseractText: tesseractText,
};
