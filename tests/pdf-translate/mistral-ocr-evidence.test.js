"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sha256Canonical } = require("../../lib/pipelines/pdf-translate/invariants");

const {
  OcrEvidenceValidationError,
  buildCanonicalOcrEvidence,
  ocrPdfToEvidenceStrict,
  ocrPdfToPageTexts,
  summarizeOcrEvidence,
  validateCanonicalOcrEvidence,
} = require("../../lib/pipelines/pdf-translate/mistral-ocr");

const FIXTURE_05_PDF = Buffer.from("%PDF-1.7\nfixture-scan-only-005", "utf8");
const FIXTURE_06_PDF = Buffer.from("%PDF-1.7\nfixture-hidden-ocr-006", "utf8");
const A4_SOURCE_PAGE = Object.freeze({
  index: 0,
  width: 595.28,
  height: 841.89,
  rotation: 0,
});

function clone(value) {
  return structuredClone(value);
}

function visualInputBinding(summary, runtimeEvidence, {
  provider = "mock-vision",
  model = "mock-vision-judge-v1",
  requestId = "visual-request-schema",
} = {}) {
  const riskTokens = summary.risk_tokens
    .filter((token) => token.needs_visual_adjudication)
    .map((token) => ({
      page_index: token.page_index,
      block_order: token.block_order,
      type: token.type,
      token_sha256: token.token_sha256,
    }))
    .sort((left, right) => (
      left.page_index - right.page_index ||
      left.block_order - right.block_order ||
      left.type.localeCompare(right.type) ||
      left.token_sha256.localeCompare(right.token_sha256)
    ));
  const riskyPages = [...new Set(riskTokens.map((token) => token.page_index))];
  const inputCommitment = {
    schema_version: 1,
    source_pdf_sha256: runtimeEvidence.source_pdf_sha256,
    ocr_evidence_sha256: summary.evidence_sha256,
    risk_tokens: riskTokens,
    source_pages: runtimeEvidence.pages.map((page) => ({
      index: page.index,
      width: page.source_dimensions.width,
      height: page.source_dimensions.height,
      rotation: page.source_dimensions.rotation,
    })),
    rendered_pages: riskyPages.map((index) => {
      const source = runtimeEvidence.pages[index].source_dimensions;
      return {
        index,
        source_width: source.width,
        source_height: source.height,
        tiles: [{
          index: 0,
          bbox: [0, 0, source.width, source.height],
          width: Math.round(source.width),
          height: Math.round(source.height),
          media_type: "image/png",
          image_sha256: "b".repeat(64),
        }],
      };
    }),
  };
  const inputDigest = sha256Canonical(inputCommitment);
  const renderedTileCount = inputCommitment.rendered_pages.reduce(
    (count, page) => count + page.tiles.length,
    0,
  );
  return {
    input_commitment: inputCommitment,
    input_digest: inputDigest,
    render_attestation: {
      schema_version: 2,
      proof_type: "ocr-visual-source-render-attestation",
      source_pdf_sha256: inputCommitment.source_pdf_sha256,
      input_digest: inputDigest,
      adjudicator_identity_sha256: sha256Canonical({
        provider,
        model,
        request_id: requestId,
      }),
      rendered_page_count: inputCommitment.rendered_pages.length,
      rendered_tile_count: renderedTileCount,
      binding_hmac_sha256: "a".repeat(64),
    },
  };
}

function responseHeaders(requestId = "official-header-request") {
  return {
    get(name) {
      return String(name).toLowerCase() === "x-request-id" ? requestId : null;
    },
  };
}

function wordsFromMarkdown(markdown, confidenceFor = () => 0.99) {
  return [...markdown.matchAll(/\S+/gu)].map((match) => ({
    text: match[0],
    confidence: confidenceFor(match[0]),
    start_index: match.index,
  }));
}

function officialPage({ markdown, blocks, lowMeasurement = false }) {
  return {
    index: 0,
    markdown,
    images: [],
    dimensions: { dpi: 200, width: 1000, height: 1414 },
    confidence_scores: {
      average_page_confidence_score: 0.985,
      minimum_page_confidence_score: lowMeasurement ? 0.61 : 0.95,
      word_confidence_scores: wordsFromMarkdown(markdown, (text) => (
        lowMeasurement && (text === "84.20" || text === "mL") ? 0.61 : 0.99
      )),
    },
    blocks,
  };
}

function fixture05Response({ lowMeasurement = false } = {}) {
  const title = "FIXTURE-SCAN-ONLY-005";
  const measurement = "Image-only measurement sheet 84.20 mL";
  const formula = "Pressure 101.3 kPa; formula E=mc^2; https://example.test/scan";
  const markdown = [title, measurement, formula].join("\n\n");
  return {
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1, doc_size_bytes: FIXTURE_05_PDF.length },
    pages: [officialPage({
      markdown,
      lowMeasurement,
      // Coordinates are deliberately not spatially sorted. OCR 4 specifies
      // that blocks[] itself is reading order, which must be preserved.
      blocks: [
        {
          type: "title",
          top_left_x: 70,
          top_left_y: 300,
          bottom_right_x: 930,
          bottom_right_y: 370,
          content: title,
        },
        {
          type: "text",
          top_left_x: 70,
          top_left_y: 60,
          bottom_right_x: 930,
          bottom_right_y: 150,
          content: measurement,
        },
        {
          type: "text",
          top_left_x: 70,
          top_left_y: 180,
          bottom_right_x: 930,
          bottom_right_y: 270,
          content: formula,
        },
      ],
    })],
  };
}

function fixture06Response() {
  const title = "FIXTURE-HIDDEN-OCR-006";
  const record = "Calibration record HIDDEN-OCR-602 at 101.3 kPa";
  const markdown = `${title}\n\n${record}`;
  return {
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1, doc_size_bytes: FIXTURE_06_PDF.length },
    pages: [officialPage({
      markdown,
      blocks: [
        {
          type: "title",
          top_left_x: 60,
          top_left_y: 60,
          bottom_right_x: 940,
          bottom_right_y: 140,
          content: title,
        },
        {
          type: "text",
          top_left_x: 60,
          top_left_y: 190,
          bottom_right_x: 940,
          bottom_right_y: 300,
          content: record,
        },
      ],
    })],
  };
}

function segmentedBlocksResponse() {
  const markdown = "# Results\n\nMeasurement 84.20 mL";
  return {
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1 },
    pages: [{
      index: 0,
      markdown,
      images: [],
      tables: [],
      dimensions: { dpi: 200, width: 1000, height: 1414 },
      confidence_scores: {
        average_page_confidence_score: 0.99,
        minimum_page_confidence_score: 0.98,
        // Matches the official OCR 4 example shape: markdown punctuation,
        // leading whitespace, and paragraph separators are score segments.
        word_confidence_scores: [
          { text: "#", confidence: 0.99, start_index: 0 },
          { text: " Results", confidence: 0.99, start_index: 1 },
          { text: "\n\n", confidence: 0.99, start_index: 9 },
          { text: "Measurement", confidence: 0.99, start_index: 11 },
          { text: " 84.20", confidence: 0.99, start_index: 22 },
          { text: " mL", confidence: 0.99, start_index: 28 },
        ],
      },
      blocks: [
        {
          type: "title",
          top_left_x: 50,
          top_left_y: 50,
          bottom_right_x: 950,
          bottom_right_y: 130,
          content: "# Results",
        },
        {
          type: "text",
          top_left_x: 50,
          top_left_y: 180,
          bottom_right_x: 950,
          bottom_right_y: 280,
          content: "Measurement 84.20 mL",
        },
      ],
    }],
  };
}

function tableResponse({
  lowMeasurement = true,
  blockContent = "table",
} = {}) {
  const tableId = "tbl-0.md";
  const placeholder = `[${tableId}](${tableId})`;
  const markdown = `# Results\n\n${placeholder}`;
  const tableContent = "| Sample | Volume |\n| --- | --- |\n| A | 84.20 mL |";
  const tableWords = wordsFromMarkdown(tableContent, (text) => (
    lowMeasurement && (text === "84.20" || text === "mL") ? 0.4 : 0.99
  ));
  return {
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1 },
    pages: [{
      index: 0,
      markdown,
      images: [],
      tables: [{
        id: tableId,
        content: tableContent,
        format: "markdown",
        word_confidence_scores: tableWords,
      }],
      dimensions: { dpi: 200, width: 1000, height: 1414 },
      confidence_scores: {
        average_page_confidence_score: 0.99,
        minimum_page_confidence_score: 0.98,
        word_confidence_scores: [
          { text: "#", confidence: 0.99, start_index: 0 },
          { text: " Results", confidence: 0.99, start_index: 1 },
          { text: "\n\n", confidence: 0.99, start_index: 9 },
          { text: placeholder, confidence: 0.99, start_index: 11 },
        ],
      },
      blocks: [
        {
          type: "title",
          top_left_x: 50,
          top_left_y: 50,
          bottom_right_x: 950,
          bottom_right_y: 130,
          content: "# Results",
        },
        {
          type: "table",
          top_left_x: 50,
          top_left_y: 180,
          bottom_right_x: 950,
          bottom_right_y: 500,
          content: blockContent === "placeholder" ? placeholder : tableContent,
          table_id: tableId,
        },
      ],
    }],
  };
}

function canonical(response, {
  sourcePdf = FIXTURE_05_PDF,
  sourcePages = [A4_SOURCE_PAGE],
  requestId = "direct-canonical-request",
  ...options
} = {}) {
  return buildCanonicalOcrEvidence(response, {
    sourcePdf,
    sourcePages,
    responseHeaders: requestId == null ? null : responseHeaders(requestId),
    ...options,
  });
}

function mockFetch(payload, { status = 200, headers = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return {
      status,
      headers: {
        get(name) {
          const found = Object.entries(headers).find(
            ([key]) => key.toLowerCase() === String(name).toLowerCase(),
          );
          return found ? found[1] : null;
        },
      },
      async text() {
        return typeof payload === "string" ? payload : JSON.stringify(payload);
      },
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function expectCode(code) {
  return (error) => error instanceof OcrEvidenceValidationError && error.code === code;
}

test("official OCR 4 mock requests blocks and word confidence, then binds exact response fields", async () => {
  const response = fixture05Response();
  // A non-schema response field must never override the real HTTP request ID.
  response.request_id = "untrusted-json-id";
  const fetchImpl = mockFetch(response, {
    headers: { "x-request-id": "header-request-005" },
  });
  const evidence = await ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
    apiKey: "test-key",
    requestedModel: "mistral-ocr-4-0",
    sourcePages: [A4_SOURCE_PAGE],
    fetchImpl,
    sleepImpl: async () => {},
  });

  assert.equal(evidence.schema_version, 2);
  assert.equal(evidence.provider, "mistral");
  assert.equal(evidence.model, "mistral-ocr-4-0");
  assert.equal(evidence.request_id, "header-request-005");
  assert.equal(evidence.pages[0].dimensions.dpi, 200);
  assert.equal(evidence.pages[0].page_confidence, 0.985);
  assert.equal(evidence.pages[0].minimum_page_confidence, 0.95);
  assert.equal(evidence.pages[0].source_dimensions.rotation, 0);
  assert.equal(evidence.pages[0].reading_order_basis, "provider");
  assert.deepEqual(
    evidence.pages[0].blocks.map((block) => block.content),
    [
      "FIXTURE-SCAN-ONLY-005",
      "Image-only measurement sheet 84.20 mL",
      "Pressure 101.3 kPa; formula E=mc^2; https://example.test/scan",
    ],
  );
  assert.equal(evidence.needs_visual_adjudication, false);
  assert.match(evidence.evidence_sha256, /^[a-f0-9]{64}$/);

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "https://api.mistral.ai/v1/ocr");
  assert.equal(fetchImpl.calls[0].body.model, "mistral-ocr-4-0");
  assert.equal(fetchImpl.calls[0].body.include_blocks, true);
  assert.equal(fetchImpl.calls[0].body.confidence_scores_granularity, "word");
  assert.equal(fetchImpl.calls[0].body.table_format, "markdown");
  assert.equal(fetchImpl.calls[0].body.include_image_base64, false);
  assert.match(fetchImpl.calls[0].body.document.document_url, /^data:application\/pdf;base64,/);
});

test("large OCR inputs use a temporary signed file and delete it after strict evidence", async () => {
  const calls = [];
  const response = (payload, { status = 200, requestId = null } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-request-id" ? requestId : null;
      },
    },
    async text() {
      return payload == null ? "" : JSON.stringify(payload);
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/files") && options.method === "POST") {
      assert.ok(options.body instanceof FormData);
      return response({ id: "temporary-ocr-file" });
    }
    if (url.includes("/files/temporary-ocr-file/url")) {
      return response({ url: "https://signed.example.test/document.pdf" });
    }
    if (url.endsWith("/ocr")) {
      const body = JSON.parse(options.body);
      assert.equal(
        body.document.document_url,
        "https://signed.example.test/document.pdf",
      );
      return response(fixture05Response(), { requestId: "large-ocr-request" });
    }
    if (url.endsWith("/files/temporary-ocr-file") && options.method === "DELETE") {
      return response({ id: "temporary-ocr-file", deleted: true });
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };

  const evidence = await ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
    apiKey: "test-key",
    sourcePages: [A4_SOURCE_PAGE],
    fetchImpl,
    sleepImpl: async () => {},
    inlineMaxBytes: 1,
  });

  assert.equal(evidence.request_id, "large-ocr-request");
  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ["POST", "https://api.mistral.ai/v1/files"],
      ["GET", "https://api.mistral.ai/v1/files/temporary-ocr-file/url?expiry=1"],
      ["POST", "https://api.mistral.ai/v1/ocr"],
      ["DELETE", "https://api.mistral.ai/v1/files/temporary-ocr-file"],
    ],
  );
});

test("temporary OCR cleanup rejects an empty successful deletion response", async () => {
  const response = (payload, { status = 200, requestId = null } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-request-id" ? requestId : null;
      },
    },
    async text() { return payload == null ? "" : JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "empty-cleanup-file" });
    }
    if (url.includes("/files/empty-cleanup-file/url")) {
      return response({ url: "https://signed.example.test/empty-cleanup.pdf" });
    }
    if (url.endsWith("/ocr")) {
      return response(fixture05Response(), { requestId: "empty-cleanup-ocr" });
    }
    if (url.endsWith("/files/empty-cleanup-file") && options.method === "DELETE") {
      return response(null);
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl,
      sleepImpl: async () => {},
      inlineMaxBytes: 1,
    }),
    expectCode("OCR_FILE_CLEANUP_FAILED"),
  );
});

test("OCR request and cleanup failure is surfaced with both sanitized causes", async () => {
  const response = (payload, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get() { return null; } },
    async text() { return payload == null ? "" : JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "ocr-and-cleanup-fail" });
    }
    if (url.includes("/files/ocr-and-cleanup-fail/url")) {
      return response({ url: "https://signed.example.test/ocr-fail.pdf" });
    }
    if (url.endsWith("/ocr")) return response({ message: "provider failure" }, 500);
    if (url.endsWith("/files/ocr-and-cleanup-fail") && options.method === "DELETE") {
      return response(null);
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl,
      sleepImpl: async () => {},
      inlineMaxBytes: 1,
    }),
    (error) => (
      expectCode("OCR_FILE_CLEANUP_FAILED")(error) &&
      error.details.primary_code === "OCR_PROVIDER_HTTP_ERROR" &&
      error.details.cleanup_code === "OCR_FILE_CLEANUP_FAILED"
    ),
  );
});

test("ambiguous temporary file upload failures are not retried", async () => {
  let uploadCalls = 0;
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      inlineMaxBytes: 1,
      sleepImpl: async () => {},
      fetchImpl: async (url, options = {}) => {
        if (url.endsWith("/files") && options.method === "POST") {
          uploadCalls += 1;
          throw new Error("ambiguous network failure");
        }
        throw new Error(`unexpected mock request: ${options.method} ${url}`);
      },
    }),
    expectCode("OCR_FILE_UPLOAD_FAILED"),
  );
  assert.equal(uploadCalls, 1);
});

test("101-page OCR inputs share one temporary file across 50+50+1 page batches", async () => {
  const calls = [];
  const response = (payload, { status = 200, requestId = null } = {}) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-request-id" ? requestId : null;
      },
    },
    async text() {
      return payload == null ? "" : JSON.stringify(payload);
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "batched-ocr-file" });
    }
    if (url.includes("/files/batched-ocr-file/url")) {
      return response({ url: "https://signed.example.test/batched.pdf" });
    }
    if (url.endsWith("/ocr")) {
      const body = JSON.parse(options.body);
      assert.equal(body.document.document_url, "https://signed.example.test/batched.pdf");
      const pages = body.pages.map((index) => {
        const page = clone(fixture05Response().pages[0]);
        page.index = index;
        return page;
      });
      return response({
        model: "mistral-ocr-4-0",
        pages,
        usage_info: {
          pages_processed: pages.length,
          doc_size_bytes: FIXTURE_05_PDF.length,
        },
      }, { requestId: `batch-${body.pages[0]}` });
    }
    if (url.endsWith("/files/batched-ocr-file") && options.method === "DELETE") {
      return response({ id: "batched-ocr-file", deleted: true });
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };
  const sourcePages = Array.from({ length: 101 }, (_, index) => ({
    ...A4_SOURCE_PAGE,
    index,
  }));

  const evidence = await ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
    apiKey: "test-key",
    sourcePages,
    fetchImpl,
    sleepImpl: async () => {},
    providerBatchPages: 50,
    providerConcurrency: 2,
  });

  assert.equal(evidence.pages.length, 101);
  assert.deepEqual(evidence.pages.map((page) => page.index), Array.from({ length: 101 }, (_, index) => index));
  assert.match(evidence.request_id, /^batch-[a-f0-9]{64}$/);
  const requestedBatches = calls
    .filter((call) => call.url.endsWith("/ocr"))
    .map((call) => JSON.parse(call.body).pages)
    .sort((left, right) => left[0] - right[0]);
  assert.deepEqual(requestedBatches, [
    Array.from({ length: 50 }, (_, index) => index),
    Array.from({ length: 50 }, (_, index) => index + 50),
    [100],
  ]);
  assert.equal(calls.filter((call) => call.url.endsWith("/files")).length, 1);
  assert.equal(
    calls.filter((call) => call.url.endsWith("/files/batched-ocr-file") && call.method === "DELETE").length,
    1,
  );
});

test("temporary OCR files are deleted when signed URL creation fails", async () => {
  const calls = [];
  const response = (payload, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get() { return null; } },
    async text() { return JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const fetchImpl = async (url, options = {}) => {
    calls.push([options.method, url]);
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "cleanup-after-url-failure" });
    }
    if (url.includes("/files/cleanup-after-url-failure/url")) {
      return response({ message: "temporary error" }, 503);
    }
    if (url.endsWith("/files/cleanup-after-url-failure") && options.method === "DELETE") {
      return response({ id: "cleanup-after-url-failure", deleted: true });
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl,
      sleepImpl: async () => {},
      inlineMaxBytes: 1,
    }),
    expectCode("OCR_FILE_URL_FAILED"),
  );
  assert.equal(
    calls.filter(([method, url]) => method === "DELETE" && url.endsWith("cleanup-after-url-failure")).length,
    1,
  );
});

test("signed URL and cleanup failure is surfaced instead of leaving an untracked temporary file", async () => {
  const response = (payload, status = 200) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get() { return null; } },
    async text() { return payload == null ? "" : JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "untracked-cleanup-file" });
    }
    if (url.includes("/files/untracked-cleanup-file/url")) {
      return response({ message: "temporary error" }, 503);
    }
    if (url.endsWith("/files/untracked-cleanup-file") && options.method === "DELETE") {
      return response(null);
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl,
      sleepImpl: async () => {},
      inlineMaxBytes: 1,
    }),
    (error) => (
      expectCode("OCR_FILE_CLEANUP_FAILED")(error) &&
      error.details.primary_code === "OCR_FILE_URL_FAILED"
    ),
  );
});

test("provider page batches fail closed on per-request coverage mismatch", async () => {
  const response = (payload, { requestId = null } = {}) => ({
    status: 200,
    ok: true,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "x-request-id" ? requestId : null;
      },
    },
    async text() { return payload == null ? "" : JSON.stringify(payload); },
    async arrayBuffer() { return new ArrayBuffer(0); },
  });
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/files") && options.method === "POST") {
      return response({ id: "coverage-file" });
    }
    if (url.includes("/files/coverage-file/url")) {
      return response({ url: "https://signed.example.test/coverage.pdf" });
    }
    if (url.endsWith("/ocr")) {
      const body = JSON.parse(options.body);
      const returned = [...body.pages].reverse().map((index) => {
        const page = clone(fixture05Response().pages[0]);
        page.index = index;
        return page;
      });
      return response({
        model: "mistral-ocr-4-0",
        pages: returned,
        usage_info: { pages_processed: returned.length },
      }, { requestId: `coverage-${body.pages[0]}` });
    }
    if (url.endsWith("/files/coverage-file") && options.method === "DELETE") {
      return response({ id: "coverage-file", deleted: true });
    }
    throw new Error(`unexpected mock request: ${options.method} ${url}`);
  };
  const sourcePages = Array.from({ length: 3 }, (_, index) => ({
    ...A4_SOURCE_PAGE,
    index,
  }));

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages,
      fetchImpl,
      sleepImpl: async () => {},
      providerBatchPages: 2,
      providerConcurrency: 1,
    }),
    expectCode("OCR_BATCH_COVERAGE_INVALID"),
  );
});

test("official punctuation, leading-space and newline confidence segments preserve lexical block coverage", () => {
  const evidence = canonical(segmentedBlocksResponse());
  assert.deepEqual(
    evidence.pages[0].blocks.map((block) => block.content),
    ["# Results", "Measurement 84.20 mL"],
  );
  assert.deepEqual(
    evidence.pages[0].blocks[0].words.map((word) => word.content),
    ["#", " Results"],
  );
  assert.equal(
    evidence.pages[0].blocks.flatMap((block) => block.words)
      .some((word) => word.content === "\n\n"),
    false,
  );
  assert.equal(evidence.risk_tokens.some((token) => token.type === "number_unit"), true);
  assert.equal(evidence.needs_visual_adjudication, false);
  assert.equal(validateCanonicalOcrEvidence(evidence, { sourcePdf: FIXTURE_05_PDF }), evidence);
});

test("markdown table entries materialize into canonical text and bind table confidence/risk evidence", () => {
  const lowEvidence = canonical(tableResponse({ lowMeasurement: true }));
  const page = lowEvidence.pages[0];
  assert.equal(page.provider_markdown.includes("[tbl-0.md](tbl-0.md)"), true);
  assert.equal(page.text.includes("| A | 84.20 mL |"), true);
  assert.equal(page.text.includes("[tbl-0.md](tbl-0.md)"), false);
  assert.equal(page.tables.length, 1);
  assert.equal(page.tables[0].content.includes("84.20 mL"), true);
  assert.equal(page.blocks[1].table_id, "tbl-0.md");
  assert.equal(page.blocks[1].content, page.tables[0].content);
  const measurement = lowEvidence.risk_tokens.find((token) => token.type === "number_unit");
  assert.ok(measurement);
  assert.equal(measurement.confidence, 0.4);
  assert.equal(measurement.needs_visual_adjudication, true);
  assert.equal(
    lowEvidence.risk_tokens.some((token) => token.confidence === 0.99),
    false,
    "placeholder digits must not become risk tokens",
  );

  for (const blockContent of ["table", "placeholder"]) {
    const highEvidence = canonical(tableResponse({ lowMeasurement: false, blockContent }));
    assert.equal(highEvidence.needs_visual_adjudication, false);
    assert.equal(
      validateCanonicalOcrEvidence(highEvidence, { sourcePdf: FIXTURE_05_PDF }),
      highEvidence,
    );
  }
});

test("markdown table evidence rejects missing or malformed table linkage and confidence", () => {
  const missingEntry = tableResponse();
  delete missingEntry.pages[0].tables;
  assert.throws(() => canonical(missingEntry), expectCode("OCR_TABLE_REFERENCE_INVALID"));

  const missingId = tableResponse();
  delete missingId.pages[0].blocks[1].table_id;
  assert.throws(() => canonical(missingId), expectCode("OCR_TABLE_REFERENCE_MISSING"));

  const missingEntryId = tableResponse();
  delete missingEntryId.pages[0].tables[0].id;
  assert.throws(() => canonical(missingEntryId), expectCode("OCR_TABLE_ID_MISSING"));

  const malformedTables = tableResponse();
  malformedTables.pages[0].tables = {};
  assert.throws(() => canonical(malformedTables), expectCode("OCR_TABLES_INVALID"));

  const unknownId = tableResponse();
  unknownId.pages[0].blocks[1].table_id = "tbl-unknown.md";
  assert.throws(() => canonical(unknownId), expectCode("OCR_TABLE_REFERENCE_INVALID"));

  const missingConfidence = tableResponse();
  delete missingConfidence.pages[0].tables[0].word_confidence_scores;
  assert.throws(
    () => canonical(missingConfidence),
    expectCode("OCR_TABLE_WORD_CONFIDENCE_MISSING"),
  );

  const malformedStart = tableResponse();
  malformedStart.pages[0].tables[0].word_confidence_scores[1].start_index += 1;
  assert.throws(() => canonical(malformedStart), expectCode("OCR_WORD_CONTENT_MISMATCH"));

  const mismatchedContent = tableResponse();
  mismatchedContent.pages[0].blocks[1].content = "unbound table body";
  assert.throws(
    () => canonical(mismatchedContent),
    expectCode("OCR_TABLE_BLOCK_CONTENT_MISMATCH"),
  );
});

test("fixture06 hidden OCR is auxiliary hashes only and provider OCR stays authoritative", () => {
  const hiddenRaw = "SHOULD-NOT-BE-AUTHORITATIVE SECRET 101.3 kPa";
  const evidence = canonical(fixture06Response(), {
    sourcePdf: FIXTURE_06_PDF,
    hiddenOcrPageTexts: [{ page: 1, text: hiddenRaw }],
  });

  assert.equal(evidence.auxiliary_hidden_ocr.authoritative, false);
  assert.equal(evidence.auxiliary_hidden_ocr.pages[0].length, hiddenRaw.length);
  assert.match(evidence.auxiliary_hidden_ocr.pages[0].content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(evidence).includes(hiddenRaw), false);
  assert.equal(evidence.pages[0].text.includes("Calibration record"), true);
  const summaryJson = JSON.stringify(summarizeOcrEvidence(evidence));
  assert.equal(summaryJson.includes("Calibration record"), false);
  assert.equal(summaryJson.includes("HIDDEN-OCR-602"), false);
  assert.equal(summaryJson.includes(hiddenRaw), false);
});

test("legacy markdown wrapper stays one-based and does not require strict evidence fields", async () => {
  const response = {
    pages: [
      { index: 0, markdown: "First page" },
      { page_number: 2, text: "Second page" },
    ],
  };
  const result = await ocrPdfToPageTexts(FIXTURE_05_PDF, {
    apiKey: "test-key",
    fetchImpl: mockFetch(response),
    sleepImpl: async () => {},
  });
  assert.deepEqual(result, [
    { page: 1, text: "First page" },
    { page: 2, text: "Second page" },
  ]);
  assert.equal(await ocrPdfToPageTexts(FIXTURE_05_PDF, { apiKey: "" }), null);
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "",
      sourcePages: [A4_SOURCE_PAGE],
    }),
    expectCode("OCR_NOT_CONFIGURED"),
  );
});

test("strict page coverage rejects missing, duplicate, one-based and usage-count pages", () => {
  const sourcePages = [
    { index: 0, width: 600, height: 800, rotation: 0 },
    { index: 1, width: 600, height: 800, rotation: 0 },
  ];
  const page0 = clone(fixture05Response().pages[0]);
  page0.dimensions = { dpi: 200, width: 600, height: 800 };
  const base = { model: "mistral-ocr-4-0", usage_info: { pages_processed: 2 } };

  assert.throws(
    () => canonical({ ...base }),
    expectCode("OCR_PAGES_MISSING"),
  );

  assert.throws(
    () => canonical({ ...base, pages: [page0] }, { sourcePages }),
    expectCode("OCR_PAGE_COVERAGE"),
  );
  assert.throws(
    () => canonical({ ...base, pages: [page0, clone(page0)] }, { sourcePages }),
    expectCode("OCR_PAGE_DUPLICATE"),
  );
  const oneBased = clone(page0);
  oneBased.index = 1;
  const page2 = clone(page0);
  page2.index = 2;
  assert.throws(
    () => canonical({ ...base, pages: [oneBased, page2] }, { sourcePages }),
    expectCode("OCR_PAGE_COVERAGE"),
  );
  const nanIndex = clone(page0);
  nanIndex.index = Number.NaN;
  assert.throws(
    () => canonical({ ...base, pages: [nanIndex, { ...clone(page0), index: 1 }] }, { sourcePages }),
    expectCode("OCR_PAGE_INDEX_INVALID"),
  );

  const onePage = fixture05Response();
  onePage.usage_info.pages_processed = 2;
  assert.throws(() => canonical(onePage), expectCode("OCR_USAGE_PAGE_MISMATCH"));
});

test("strict identity requires actual response model and provider request ID", () => {
  const missingModel = fixture05Response();
  delete missingModel.model;
  assert.throws(() => canonical(missingModel), expectCode("OCR_IDENTITY_MISSING"));

  assert.throws(
    () => canonical(fixture05Response(), { requestId: null }),
    expectCode("OCR_IDENTITY_MISSING"),
  );
});

test("live strict OCR accepts request identity only from an HTTP response header", async () => {
  const response = fixture05Response();
  response.request_id = "json-body-is-not-an-official-request-id";
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl: mockFetch(response),
      sleepImpl: async () => {},
    }),
    expectCode("OCR_IDENTITY_MISSING"),
  );
});

test("strict geometry rejects missing dpi, NaN, out-of-bounds bbox and page aspect mismatch", () => {
  const missingDpi = fixture05Response();
  delete missingDpi.pages[0].dimensions.dpi;
  assert.throws(() => canonical(missingDpi), expectCode("OCR_NUMBER_INVALID"));

  const invalidBbox = fixture05Response();
  invalidBbox.pages[0].blocks[0].bottom_right_x = 1001;
  assert.throws(() => canonical(invalidBbox), expectCode("OCR_BBOX_OUT_OF_BOUNDS"));

  const nonFinite = fixture05Response();
  nonFinite.pages[0].blocks[0].top_left_x = Number.NaN;
  assert.throws(() => canonical(nonFinite), expectCode("OCR_BBOX_INVALID"));

  const wrongAspect = fixture05Response();
  wrongAspect.pages[0].dimensions = { dpi: 200, width: 1000, height: 1000 };
  assert.throws(() => canonical(wrongAspect), expectCode("OCR_PAGE_ASPECT_MISMATCH"));
});

test("strict confidence rejects missing, NaN, out-of-range and incomplete ordinary word coverage", () => {
  const missingScores = fixture05Response();
  delete missingScores.pages[0].confidence_scores;
  assert.throws(() => canonical(missingScores), expectCode("OCR_PAGE_CONFIDENCE_MISSING"));

  const nanWord = fixture05Response();
  nanWord.pages[0].confidence_scores.word_confidence_scores[0].confidence = Number.NaN;
  assert.throws(() => canonical(nanWord), expectCode("OCR_NUMBER_INVALID"));

  const highWord = fixture05Response();
  highWord.pages[0].confidence_scores.word_confidence_scores[0].confidence = 1.01;
  assert.throws(() => canonical(highWord), expectCode("OCR_CONFIDENCE_INVALID"));

  const missingOrdinary = fixture05Response();
  missingOrdinary.pages[0].confidence_scores.word_confidence_scores =
    missingOrdinary.pages[0].confidence_scores.word_confidence_scores
      .filter((entry) => entry.text !== "measurement");
  assert.throws(
    () => canonical(missingOrdinary),
    expectCode("OCR_WORD_COVERAGE_INCOMPLETE"),
  );

  const wrongStart = fixture05Response();
  wrongStart.pages[0].confidence_scores.word_confidence_scores[1].start_index += 1;
  assert.throws(() => canonical(wrongStart), expectCode("OCR_WORD_CONTENT_MISMATCH"));
});

test("bare numbers and mixed IDs are risky, while missing risk-word overlap forces adjudication without inheritance", () => {
  const evidence = canonical(fixture06Response());
  assert.equal(evidence.risk_tokens.some((token) => token.type === "bare_number"), true);
  assert.equal(evidence.risk_tokens.some((token) => token.type === "identifier"), true);

  const missingRiskWord = fixture05Response();
  missingRiskWord.pages[0].confidence_scores.word_confidence_scores =
    missingRiskWord.pages[0].confidence_scores.word_confidence_scores
      .filter((entry) => entry.text !== "https://example.test/scan");
  const canonicalMissing = canonical(missingRiskWord);
  const url = canonicalMissing.risk_tokens.find((token) => token.type === "url");
  assert.equal(url.confidence, null);
  assert.equal(url.needs_visual_adjudication, true);
  assert.equal(canonicalMissing.needs_visual_adjudication, true);
});

test("low-confidence risky tokens fail closed without visual adjudication", async () => {
  const response = fixture05Response({ lowMeasurement: true });
  const canonicalEvidence = canonical(response);
  const low = canonicalEvidence.risk_tokens.filter((token) => token.needs_visual_adjudication);
  assert.equal(canonicalEvidence.needs_visual_adjudication, true);
  assert.equal(low.some((token) => token.type === "number_unit"), true);
  assert.equal(low.every((token) => !Object.hasOwn(token, "literal")), true);

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl: mockFetch(response, { headers: { "x-request-id": "low-request" } }),
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.equal(expectCode("OCR_VISUAL_ADJUDICATION_REQUIRED")(error), true);
      const safe = `${error.message}\n${JSON.stringify(error.details)}`;
      assert.equal(safe.includes("84.20"), false);
      assert.match(safe, /[a-f0-9]{64}/);
      return true;
    },
  );
});

test("visual adjudicator must cover every low-confidence risk hash", async () => {
  const response = fixture05Response({ lowMeasurement: true });
  const options = {
    apiKey: "test-key",
    sourcePages: [A4_SOURCE_PAGE],
    fetchImpl: mockFetch(response, { headers: { "x-request-id": "visual-request" } }),
    sleepImpl: async () => {},
  };
  const evidence = await ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
    ...options,
    visualAdjudicator: async (summary, runtimeEvidence) => {
      assert.equal(JSON.stringify(summary).includes("84.20"), false);
      assert.equal(runtimeEvidence.pages[0].text.includes("84.20 mL"), true);
      return {
        verdict: "pass",
        provider: "mock-vision",
        model: "mock-vision-judge-v1",
        request_id: "visual-request-001",
        ...visualInputBinding(summary, runtimeEvidence, {
          requestId: "visual-request-001",
        }),
        token_hashes: summary.risk_tokens
          .filter((token) => token.needs_visual_adjudication)
          .map((token) => token.token_sha256),
      };
    },
  });
  assert.equal(evidence.visual_adjudication.verdict, "pass");
  assert.equal(
    evidence.visual_adjudication.input_digest,
    sha256Canonical(evidence.visual_adjudication.input_commitment),
  );

  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => ({
        verdict: "pass",
        provider: "mock-vision",
        model: "mock-vision-judge-v1",
        request_id: "visual-request-incomplete",
        ...visualInputBinding(summary, runtimeEvidence, {
          requestId: "visual-request-incomplete",
        }),
        token_hashes: [],
      }),
    }),
    expectCode("OCR_VISUAL_ADJUDICATION_INCOMPLETE"),
  );

  const completeResult = (summary, runtimeEvidence, overrides = {}) => ({
    verdict: "pass",
    provider: "mock-vision",
    model: "mock-vision-judge-v1",
    request_id: "visual-request-schema",
    ...visualInputBinding(summary, runtimeEvidence),
    token_hashes: summary.risk_tokens
      .filter((token) => token.needs_visual_adjudication)
      .map((token) => token.token_sha256),
    ...overrides,
  });
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => {
        const result = completeResult(summary, runtimeEvidence);
        delete result.input_digest;
        return result;
      },
    }),
    expectCode("OCR_EVIDENCE_SCHEMA_INVALID"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => {
        const result = completeResult(summary, runtimeEvidence);
        delete result.input_commitment;
        return result;
      },
    }),
    expectCode("OCR_EVIDENCE_SCHEMA_INVALID"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => {
        const result = completeResult(summary, runtimeEvidence);
        delete result.render_attestation;
        return result;
      },
    }),
    expectCode("OCR_EVIDENCE_SCHEMA_INVALID"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => {
        const result = completeResult(summary, runtimeEvidence);
        result.input_commitment.extra = true;
        result.input_digest = sha256Canonical(result.input_commitment);
        return result;
      },
    }),
    expectCode("OCR_EVIDENCE_SCHEMA_INVALID"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) => {
        const result = completeResult(summary, runtimeEvidence);
        result.input_commitment.ocr_evidence_sha256 = "c".repeat(64);
        result.input_digest = sha256Canonical(result.input_commitment);
        return result;
      },
    }),
    expectCode("OCR_VISUAL_ADJUDICATION_COMMITMENT_MISMATCH"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) =>
        completeResult(summary, runtimeEvidence, { input_digest: "bad" }),
    }),
    expectCode("OCR_VISUAL_ADJUDICATION_INPUT_INVALID"),
  );
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      ...options,
      visualAdjudicator: async (summary, runtimeEvidence) =>
        completeResult(summary, runtimeEvidence, { extra: true }),
    }),
    expectCode("OCR_EVIDENCE_SCHEMA_INVALID"),
  );
});

test("source rotation is canonical evidence and participates in the seal", () => {
  const rotatedSource = [{ ...A4_SOURCE_PAGE, rotation: 90 }];
  const evidence = canonical(fixture05Response(), { sourcePages: rotatedSource });
  assert.equal(evidence.pages[0].source_dimensions.rotation, 90);
  assert.equal(validateCanonicalOcrEvidence(evidence, { sourcePdf: FIXTURE_05_PDF }), evidence);

  const tampered = clone(evidence);
  tampered.pages[0].source_dimensions.rotation = 0;
  assert.throws(
    () => validateCanonicalOcrEvidence(tampered, { sourcePdf: FIXTURE_05_PDF }),
    (error) => ["OCR_EVIDENCE_CONTENT_MISMATCH", "OCR_EVIDENCE_SEAL_INVALID"].includes(error.code),
  );

  assert.throws(
    () => canonical(fixture05Response(), {
      sourcePages: [{ index: 0, width: 595.28, height: 841.89 }],
    }),
    expectCode("OCR_PAGE_ROTATION_INVALID"),
  );
});

test("official word start_index is preserved across non-BMP Unicode and canonical revalidation", () => {
  const markdown = "😀 Sample ID-7";
  const response = {
    model: "mistral-ocr-4-0",
    usage_info: { pages_processed: 1 },
    pages: [{
      index: 0,
      markdown,
      images: [],
      dimensions: { dpi: 200, width: 1000, height: 1414 },
      confidence_scores: {
        average_page_confidence_score: 0.99,
        minimum_page_confidence_score: 0.98,
        // Offsets are Unicode code points: Sample starts at 2, while its JS
        // UTF-16 code-unit offset is 3 because the emoji is a surrogate pair.
        word_confidence_scores: [
          { text: "😀", confidence: 0.99, start_index: 0 },
          { text: "Sample", confidence: 0.99, start_index: 2 },
          { text: "ID-7", confidence: 0.99, start_index: 9 },
        ],
      },
      blocks: [{
        type: "text",
        top_left_x: 50,
        top_left_y: 50,
        bottom_right_x: 950,
        bottom_right_y: 200,
        content: markdown,
      }],
    }],
  };
  const evidence = canonical(response);
  const sample = evidence.pages[0].blocks[0].words[1];
  assert.equal(sample.start_index, 2);
  assert.equal(sample.resolved_start_index, 3);
  assert.equal(sample.index_basis, "unicode_code_point");
  assert.equal(validateCanonicalOcrEvidence(evidence, { sourcePdf: FIXTURE_05_PDF }), evidence);
});

test("provider failures expose response hashes, never raw OCR/error payload", async () => {
  const secret = "RAW OCR SECRET 84.20 mL https://private.test";
  await assert.rejects(
    () => ocrPdfToEvidenceStrict(FIXTURE_05_PDF, {
      apiKey: "test-key",
      sourcePages: [A4_SOURCE_PAGE],
      fetchImpl: mockFetch(secret, { status: 503 }),
      sleepImpl: async () => {},
    }),
    (error) => {
      assert.equal(expectCode("OCR_PROVIDER_HTTP_ERROR")(error), true);
      const safe = `${error.message}\n${JSON.stringify(error.details)}`;
      assert.equal(safe.includes(secret), false);
      assert.match(error.details.response_sha256, /^[a-f0-9]{64}$/);
      return true;
    },
  );
});
