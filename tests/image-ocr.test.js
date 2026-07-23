"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sharp = require("sharp");
const { extractImageText, prepareImageForOcr } = require("../lib/document-tools/image-ocr");

async function sampleImage() {
  return sharp({
    create: { width: 720, height: 360, channels: 3, background: "white" },
  }).composite([{
    input: Buffer.from('<svg width="720" height="360"><text x="45" y="150" font-size="56">Quilo OCR 123</text><rect x="40" y="190" width="620" height="3"/></svg>'),
  }]).png().toBuffer();
}

function payload(confidence, markdown, model = "mistral-ocr-latest") {
  return {
    model,
    pages: [{
      index: 0,
      markdown,
      dimensions: { width: 720, height: 360, dpi: 200 },
      confidence_scores: {
        average_page_confidence_score: confidence,
        minimum_page_confidence_score: confidence - 0.05,
        word_confidence_scores: [{ text: "Quilo", start_index: 0, confidence }],
      },
      blocks: [{ type: "title", content: markdown, top_left_x: 0, top_left_y: 0, bottom_right_x: 100, bottom_right_y: 40 }],
      tables: [],
    }],
    usage_info: { pages_processed: 1 },
  };
}

test("OCR preprocessing keeps document images well above the old 2200px cap when possible", async () => {
  const input = await sharp({ create: { width: 3200, height: 1200, channels: 3, background: "white" } }).png().toBuffer();
  const prepared = await prepareImageForOcr({ buffer: input, originalname: "wide.png", mimetype: "image/png" });
  const meta = await sharp(prepared.buffer).metadata();
  assert.equal(meta.width, 3200);
  assert.equal(meta.height, 1200);
  assert.ok(prepared.finalBytes <= 19 * 1024 * 1024);
});

test("OCR always performs four high-quality passes with HTML tables and semantic blocks", async () => {
  const image = await sampleImage();
  const calls = [];
  const responses = [
    payload(0.91, "Quilo OCR 123"),
    payload(0.92, "Quilo OCR 123"),
    payload(0.93, "Quilo OCR 123"),
    payload(0.94, "Quilo OCR 123"),
  ];
  responses[3].pages[0].tables = [{ id: "table-1", content: '<table><tr><th colspan="2">항목</th></tr></table>' }];
  responses[3].pages[0].blocks = [{ type: "table", table_id: "table-1", content: "", top_left_x: 1, top_left_y: 2, bottom_right_x: 3, bottom_right_y: 4 }];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await extractImageText(
    { buffer: image, originalname: "scan.png", mimetype: "image/png" },
    { apiKey: "test-key", fetchImpl, mode: "fast", includeBlocks: true },
  );
  assert.equal(calls.length, 4);
  assert.equal(calls[0].include_blocks, true);
  assert.equal(calls[0].confidence_scores_granularity, "word");
  assert.equal(calls[0].table_format, "html");
  assert.equal(result.text, "Quilo OCR 123");
  assert.equal(result.source.passes, 4);
  assert.equal(result.source.attemptedPasses, 4);
  assert.equal(result.source.mode, "quality");
  assert.ok(result.confidence.average > 0.9);
  assert.ok(result.quality.verifiedConfidence > 0.9);
  assert.ok(result.quality.layoutConfidence > 0.7);
  assert.equal(result.quality.successfulPasses, 4);
  assert.equal(result.pages[0].blocks[0].type, "table");
  assert.equal(result.pages[0].blocks[0].tableId, "table-1");
  assert.match(result.pages[0].tables[0].content, /colspan="2"/);
});

test("four-pass consensus rejects a confident divergent outlier", async () => {
  const image = await sampleImage();
  const responses = [
    payload(0.995, "완전히 잘못 읽은 외톨이 판독 999"),
    payload(0.92, "정답 문장 123"),
    payload(0.93, "정답 문장 123"),
    payload(0.91, "정답 문장 123"),
  ];
  const result = await extractImageText(
    { buffer: image, originalname: "consensus.png", mimetype: "image/png" },
    { apiKey: "test-key", fetchImpl: async () => new Response(JSON.stringify(responses.shift()), { status: 200 }) },
  );
  assert.equal(result.text, "정답 문장 123");
  assert.ok(result.quality.agreement > 0.6);
  assert.notEqual(result.quality.selectedVariant, "standard");
});

test("quality OCR keeps image layout metadata across four variants", async () => {
  const image = await sampleImage();
  const responses = [
    payload(0.86, "Quilo OCR 12?"),
    payload(0.94, "Quilo OCR 123"),
    payload(0.98, "Quilo OCR 123 정확"),
    payload(0.96, "Quilo OCR 123 정확"),
  ];
  responses[2].pages[0].images = [{
    id: "img-0.jpeg",
    top_left_x: 12,
    top_left_y: 34,
    bottom_right_x: 212,
    bottom_right_y: 164,
    image_annotation: "원본 그림",
  }];
  let calls = 0;
  const result = await extractImageText(
    { buffer: image, originalname: "ultra.png", mimetype: "image/png" },
    {
      apiKey: "test-key",
      mode: "ultra",
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(responses.shift()), { status: 200 });
      },
    },
  );
  assert.equal(calls, 4);
  assert.equal(result.text, "Quilo OCR 123 정확");
  assert.equal(result.source.passes, 4);
  assert.equal(result.source.attemptedPasses, 4);
  assert.ok(["handwriting", "binary"].includes(result.quality.selectedVariant));
  assert.equal(result.quality.candidateScores.length, 4);
  assert.ok(result.quality.candidateScores.every((candidate) => Number.isFinite(candidate.layoutConfidence)));
  assert.equal(result.pages[0].images[0].id, "img-0.jpeg");
  assert.equal(result.pages[0].images[0].topLeftX, 12);
  assert.equal(result.pages[0].images[0].annotation, "원본 그림");
});

test("comparison-pass failures preserve the first OCR result and expose review evidence", async () => {
  const image = await sampleImage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls > 1) throw new Error("temporary rate limit");
    return new Response(JSON.stringify(payload(0.6, "첫 판독 보존")), { status: 200 });
  };
  const result = await extractImageText(
    { buffer: image, originalname: "retry.png", mimetype: "image/png" },
    { apiKey: "test-key", fetchImpl, mode: "accurate" },
  );
  assert.equal(calls, 4);
  assert.equal(result.text, "첫 판독 보존");
  assert.equal(result.source.passes, 1);
  assert.match(result.source.enhancedRetryWarning, /temporary rate limit/);
  assert.equal(result.quality.reviewRequired, true);
});

test("OCR retries a transient provider abort instead of leaking the raw abort message", async () => {
  const image = await sampleImage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) throw new DOMException("This operation was aborted", "AbortError");
    return new Response(JSON.stringify(payload(0.96, "중단 후 재시도 성공")), { status: 200 });
  };
  const result = await extractImageText(
    { buffer: image, originalname: "abort.png", mimetype: "image/png" },
    { apiKey: "test-key", fetchImpl, mode: "fast" },
  );
  assert.equal(calls, 5);
  assert.equal(result.text, "중단 후 재시도 성공");
  assert.equal(result.source.passes, 4);
});

test("OCR returns a stable diagnostic when provider aborts twice", async () => {
  const image = await sampleImage();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new DOMException("This operation was aborted", "AbortError");
  };
  await assert.rejects(
    extractImageText(
      { buffer: image, originalname: "abort.png", mimetype: "image/png" },
      { apiKey: "test-key", fetchImpl, mode: "fast" },
    ),
    (error) => {
      assert.equal(calls, 2);
      assert.equal(error.code, "OCR_PROVIDER_ABORTED");
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /This operation was aborted/i);
      return true;
    },
  );
});
