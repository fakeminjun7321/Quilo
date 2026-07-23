// Mistral OCR adapter.
//
// There are deliberately two contracts in this module:
//   1. ocrPdfToPageTexts() is the legacy, best-effort markdown hint wrapper.
//      It keeps the existing `[{ page: 1, text }]` return shape.
//   2. ocrPdfToEvidenceStrict() is the fail-closed retypeset provenance path.
//      It accepts only provider responses that carry enough page, geometry,
//      ordering and confidence evidence to audit the OCR result.
//
// Hidden OCR layers are never promoted to source truth here.  They may be
// attached to strict evidence only as hashes marked `authoritative: false`.

"use strict";

const crypto = require("node:crypto");

const MISTRAL_BASE = process.env.MISTRAL_API_BASE || "https://api.mistral.ai/v1";
const MISTRAL_OCR_MODEL = process.env.MISTRAL_OCR_MODEL || "mistral-ocr-4-0";
// 작은 문서는 data URL 한 번으로 보내되, base64/JSON 팽창이 큰 문서는 Files API에
// 임시 업로드하고 signed URL로 OCR한 뒤 즉시 삭제한다. 과거 MISTRAL_OCR_MAX_MB=45는
// 전체 거부 상한이었지만 이제는 하위호환 inline 전환점으로만 사용한다.
const parsedInlineMaxMb = parseInt(
  process.env.MISTRAL_OCR_INLINE_MAX_MB || process.env.MISTRAL_OCR_MAX_MB || "45",
  10,
);
const INLINE_MAX_MB = Number.isFinite(parsedInlineMaxMb) && parsedInlineMaxMb >= 1
  ? parsedInlineMaxMb
  : 45;
const parsedMaxFileMb = parseInt(process.env.MISTRAL_OCR_MAX_FILE_MB || "512", 10);
const MAX_MB = Number.isFinite(parsedMaxFileMb) && parsedMaxFileMb >= 1
  ? parsedMaxFileMb
  : 512;
// Version 2 is bound to the public OCR 4 response contract.  Version 1
// incorrectly expected synthetic per-block words/page_confidence fields that
// Mistral does not return.
const OCR_EVIDENCE_SCHEMA_VERSION = 2;
const DEFAULT_ASPECT_RATIO_TOLERANCE = finiteEnvFraction(
  process.env.PDF_OCR_ASPECT_RATIO_TOLERANCE,
  0.025,
);
const DEFAULT_RISK_CONFIDENCE_THRESHOLD = finiteEnvFraction(
  process.env.PDF_OCR_RISK_CONFIDENCE_THRESHOLD,
  0.92,
);

class OcrEvidenceValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "OcrEvidenceValidationError";
    this.code = code;
    // Callers may log details.  Never put raw provider text in this object.
    this.details = details;
  }
}

function finiteEnvFraction(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function mistralKey() {
  return process.env.MISTRAL_API_KEY || "";
}

function mistralOcrConfigured() {
  return !!mistralKey();
}

function sha256Hex(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value)
    : Buffer.from(String(value), "utf8");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON rejects non-finite numbers");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError(`canonical JSON rejects ${typeof value}`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("canonical JSON accepts plain objects only");
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => {
    if (value[key] === undefined) throw new TypeError("canonical JSON rejects undefined");
    return `${JSON.stringify(key)}:${canonicalJson(value[key])}`;
  }).join(",")}}`;
}

function evidenceDigest(value) {
  return sha256Hex(canonicalJson(value));
}

function fail(code, message, details = {}) {
  throw new OcrEvidenceValidationError(code, message, details);
}

function requireNonEmptyString(value, field, details = {}) {
  if (typeof value !== "string" || !value.trim()) {
    fail("OCR_IDENTITY_MISSING", `${field} is missing from the provider response.`, {
      field,
      ...details,
    });
  }
  return value.trim();
}

function requireFinite(value, field, details = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("OCR_NUMBER_INVALID", `${field} must be a finite number.`, { field, ...details });
  }
  return value;
}

function requirePositive(value, field, details = {}) {
  const number = requireFinite(value, field, details);
  if (number <= 0) {
    fail("OCR_DIMENSIONS_INVALID", `${field} must be greater than zero.`, {
      field,
      ...details,
    });
  }
  return number;
}

function requireConfidence(value, field, details = {}) {
  const number = requireFinite(value, field, details);
  if (number < 0 || number > 1) {
    fail("OCR_CONFIDENCE_INVALID", `${field} must be in the closed interval [0, 1].`, {
      field,
      ...details,
    });
  }
  return number;
}

function integerIndex(value, field, details = {}) {
  if (!Number.isInteger(value) || value < 0) {
    fail("OCR_PAGE_INDEX_INVALID", `${field} must be a non-negative integer.`, {
      field,
      ...details,
    });
  }
  return value;
}

function normalizeSourceRotation(value, field, details = {}) {
  if (!Number.isInteger(value) || value % 90 !== 0) {
    fail("OCR_PAGE_ROTATION_INVALID", `${field} must be an integer multiple of 90 degrees.`, {
      field,
      ...details,
    });
  }
  return ((value % 360) + 360) % 360;
}

function normalizeSourcePages(sourcePages) {
  if (!Array.isArray(sourcePages) || sourcePages.length === 0) {
    fail(
      "OCR_SOURCE_PAGES_REQUIRED",
      "Strict OCR requires the original PDF page indices and dimensions.",
      { provided: Array.isArray(sourcePages) ? sourcePages.length : null },
    );
  }
  const byIndex = new Map();
  for (const source of sourcePages) {
    const index = integerIndex(source && source.index, "sourcePages[].index");
    if (byIndex.has(index)) {
      fail("OCR_SOURCE_PAGE_DUPLICATE", "Original page specifications contain a duplicate index.", {
        page_index: index,
      });
    }
    const width = requirePositive(
      source.width != null ? source.width : source.width_pt,
      "sourcePages[].width",
      { page_index: index },
    );
    const height = requirePositive(
      source.height != null ? source.height : source.height_pt,
      "sourcePages[].height",
      { page_index: index },
    );
    const rotation = normalizeSourceRotation(
      source && source.rotation,
      "sourcePages[].rotation",
      { page_index: index },
    );
    byIndex.set(index, { index, width, height, rotation, aspect_ratio: width / height });
  }
  const expected = Array.from({ length: sourcePages.length }, (_, index) => index);
  const actual = [...byIndex.keys()].sort((a, b) => a - b);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(
      "OCR_SOURCE_PAGE_COVERAGE",
      "Original page specifications must cover exact zero-based indices 0..N-1.",
      { expected_indices: expected, actual_indices: actual },
    );
  }
  return expected.map((index) => byIndex.get(index));
}

function responseDimensions(page, pageIndex) {
  const dimensions = page && page.dimensions && typeof page.dimensions === "object"
    ? page.dimensions
    : page || {};
  const width = requirePositive(
    dimensions.width != null ? dimensions.width : dimensions.width_px,
    "pages[].dimensions.width",
    { page_index: pageIndex },
  );
  const height = requirePositive(
    dimensions.height != null ? dimensions.height : dimensions.height_px,
    "pages[].dimensions.height",
    { page_index: pageIndex },
  );
  const dpi = requirePositive(dimensions.dpi, "pages[].dimensions.dpi", {
    page_index: pageIndex,
  });
  if (!Number.isInteger(dpi)) {
    fail("OCR_DIMENSIONS_INVALID", "pages[].dimensions.dpi must be an integer.", {
      page_index: pageIndex,
    });
  }
  return { dpi, width, height, aspect_ratio: width / height };
}

function normalizeBbox(value, dimensions, details) {
  let bbox;
  if (Array.isArray(value) && value.length === 4) {
    bbox = value.slice();
  } else if (value && typeof value === "object") {
    bbox = [
      value.x0 != null ? value.x0 : value.left,
      value.y0 != null ? value.y0 : value.top,
      value.x1 != null ? value.x1 : value.right,
      value.y1 != null ? value.y1 : value.bottom,
    ];
  } else {
    fail("OCR_BBOX_INVALID", "OCR block bbox must contain x0, y0, x1, y1.", details);
  }
  bbox = bbox.map((number, index) => requireFinite(number, `bbox[${index}]`, details));
  const [x0, y0, x1, y1] = bbox;
  const epsilon = 1e-6;
  if (
    x0 < -epsilon || y0 < -epsilon || x1 > dimensions.width + epsilon ||
    y1 > dimensions.height + epsilon || x1 <= x0 || y1 <= y0
  ) {
    fail("OCR_BBOX_OUT_OF_BOUNDS", "OCR block bbox is empty or outside its page dimensions.", {
      ...details,
      bbox,
      page_dimensions: { width: dimensions.width, height: dimensions.height },
    });
  }
  return bbox.map((number, index) => {
    if ((index === 0 || index === 1) && Math.abs(number) <= epsilon) return 0;
    if (index === 2 && Math.abs(number - dimensions.width) <= epsilon) return dimensions.width;
    if (index === 3 && Math.abs(number - dimensions.height) <= epsilon) return dimensions.height;
    return number;
  });
}

function compareStrings(a, b) {
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function codePointOffsets(value) {
  const offsets = [0];
  let offset = 0;
  for (const character of value) {
    offset += character.length;
    offsets.push(offset);
  }
  return offsets;
}

// The public API calls start_index an index into the page markdown.  Python's
// SDK naturally exposes Unicode code-point offsets while JavaScript strings
// use UTF-16 code units.  Prefer the cross-language code-point interpretation,
// but accept a code-unit value when that is the only exact match.  In either
// case the provider text must match byte-for-byte at the resolved span.
function resolveMarkdownWordSpan(markdown, text, startIndex, offsets, details) {
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    fail("OCR_WORD_START_INVALID", "word_confidence_scores[].start_index must be non-negative.", details);
  }
  const textPointLength = Array.from(text).length;
  const codePointStart = startIndex < offsets.length ? offsets[startIndex] : null;
  const codePointEnd = startIndex + textPointLength < offsets.length
    ? offsets[startIndex + textPointLength]
    : null;
  const codePointMatch = codePointStart != null && codePointEnd != null &&
    markdown.slice(codePointStart, codePointEnd) === text;
  const codeUnitEnd = startIndex + text.length;
  const codeUnitMatch = startIndex <= markdown.length &&
    markdown.slice(startIndex, codeUnitEnd) === text;
  if (!codePointMatch && !codeUnitMatch) {
    fail("OCR_WORD_CONTENT_MISMATCH", "OCR word text does not match page markdown at start_index.", {
      ...details,
      start_index: startIndex,
      word_sha256: sha256Hex(text),
      markdown_sha256: sha256Hex(markdown),
    });
  }
  return codePointMatch
    ? { start: codePointStart, end: codePointEnd, indexBasis: "unicode_code_point" }
    : { start: startIndex, end: codeUnitEnd, indexBasis: "utf16_code_unit" };
}

function normalizeOfficialPageConfidence(page, pageIndex) {
  const scores = page && page.confidence_scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    fail("OCR_PAGE_CONFIDENCE_MISSING", "OCR 4 page confidence_scores are missing.", {
      page_index: pageIndex,
    });
  }
  const average = requireConfidence(
    scores.average_page_confidence_score,
    "pages[].confidence_scores.average_page_confidence_score",
    { page_index: pageIndex },
  );
  const minimum = requireConfidence(
    scores.minimum_page_confidence_score,
    "pages[].confidence_scores.minimum_page_confidence_score",
    { page_index: pageIndex },
  );
  if (minimum > average + 1e-12) {
    fail("OCR_CONFIDENCE_INVALID", "Minimum page confidence cannot exceed average confidence.", {
      page_index: pageIndex,
    });
  }
  if (!Array.isArray(scores.word_confidence_scores)) {
    fail("OCR_WORD_CONFIDENCE_MISSING", "OCR 4 word_confidence_scores are missing.", {
      page_index: pageIndex,
    });
  }
  return { average, minimum, rawWords: scores.word_confidence_scores };
}

function significantWordSpan(text, absoluteStart) {
  let first = null;
  let last = null;
  let offset = 0;
  for (const character of text) {
    const next = offset + character.length;
    if (/[\p{L}\p{N}]/u.test(character)) {
      if (first == null) first = offset;
      last = next;
    }
    offset = next;
  }
  return first == null
    ? null
    : { start: absoluteStart + first, end: absoluteStart + last };
}

function normalizeOfficialWords(rawWords, markdown, pageIndex, {
  fieldPrefix = "pages[].confidence_scores.word_confidence_scores[]",
  indexScope = "page_markdown",
  tableId = null,
} = {}) {
  const identity = tableId == null ? { page_index: pageIndex } : {
    page_index: pageIndex,
    table_id: tableId,
  };
  if (rawWords.length === 0 && /[\p{L}\p{N}]/u.test(markdown)) {
    fail("OCR_WORD_CONFIDENCE_MISSING", "A non-empty OCR page has no word confidence scores.", {
      ...identity,
      index_scope: indexScope,
    });
  }
  const offsets = codePointOffsets(markdown);
  const words = [];
  let previousEnd = 0;
  for (let index = 0; index < rawWords.length; index += 1) {
    const word = rawWords[index];
    if (!word || typeof word !== "object" || typeof word.text !== "string" || !word.text) {
      fail("OCR_WORD_INVALID", "OCR word confidence entry has no text.", {
        ...identity,
        word_index: index,
      });
    }
    const confidence = requireConfidence(
      word.confidence,
      `${fieldPrefix}.confidence`,
      { ...identity, word_index: index },
    );
    const span = resolveMarkdownWordSpan(
      markdown,
      word.text,
      word.start_index,
      offsets,
      { ...identity, word_index: index, index_scope: indexScope },
    );
    if (span.start < previousEnd) {
      fail("OCR_WORD_ORDER_INVALID", "OCR word confidence spans overlap or are out of order.", {
        ...identity,
        word_index: index,
      });
    }
    const significant = significantWordSpan(word.text, span.start);
    words.push({
      order: index,
      content: word.text,
      confidence,
      start: span.start,
      end: span.end,
      provider_start_index: word.start_index,
      index_basis: span.indexBasis,
      index_scope: indexScope,
      coverage_start: significant && significant.start,
      coverage_end: significant && significant.end,
    });
    previousEnd = span.end;
  }
  return words;
}

const OFFICIAL_OCR4_BLOCK_TYPES = new Set([
  "aside_text", "caption", "code", "equation", "footer", "header", "image",
  "list", "references", "signature", "table", "text", "title",
]);

function officialBlockBbox(block, dimensions, details) {
  const coordinates = [
    block.top_left_x,
    block.top_left_y,
    block.bottom_right_x,
    block.bottom_right_y,
  ];
  if (coordinates.some((value) => !Number.isInteger(value))) {
    fail("OCR_BBOX_INVALID", "OCR 4 block coordinates must be integers.", details);
  }
  return normalizeBbox(coordinates, dimensions, details);
}

function rangeCoveredByWords(start, end, words) {
  let cursor = start;
  for (const word of words) {
    if (word.end <= cursor) continue;
    if (word.start > cursor) return false;
    cursor = Math.max(cursor, word.end);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

function validateBlockWordCoverage(block, details) {
  const wordish = /[\p{L}\p{N}]+/gu;
  const risky = riskLiteralSpans(block.risk_content);
  for (const match of block.risk_content.matchAll(wordish)) {
    const start = match.index;
    const end = start + match[0].length;
    if (rangeCoveredByWords(start, end, block.word_ranges)) continue;
    // Risky literals without a matching provider word are allowed to continue
    // only so collectRiskTokens() can force visual adjudication.  Ordinary
    // missing word coverage is a malformed provider response and fails here.
    if (risky.some((range) => range.start <= start && range.end >= end)) continue;
    fail("OCR_WORD_COVERAGE_INCOMPLETE", "Word confidence scores do not cover all block text.", {
      ...details,
      uncovered_sha256: sha256Hex(match[0]),
    });
  }
}

function publicConfidenceWord(word) {
  return {
    order: word.order,
    content: word.content,
    confidence: word.confidence,
    start_index: word.provider_start_index,
    resolved_start_index: word.start,
    index_basis: word.index_basis,
    index_scope: word.index_scope,
  };
}

function wordConfidenceSummary(words) {
  const confidences = words.map((word) => word.confidence);
  return {
    count: confidences.length,
    min: confidences.length ? Math.min(...confidences) : null,
    mean: confidences.length
      ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
      : null,
  };
}

function normalizeOfficialTables(rawTables, pageIndex) {
  // OCRPageObject.tables is optional in the official SDK.  Absence is an
  // empty table set; a table block that references it will still fail below.
  if (rawTables == null) return { tables: [], byId: new Map() };
  if (!Array.isArray(rawTables)) {
    fail("OCR_TABLES_INVALID", "OCR 4 page tables must be an array when present.", {
      page_index: pageIndex,
    });
  }
  const byId = new Map();
  const tables = rawTables.map((rawTable, tableIndex) => {
    if (!rawTable || typeof rawTable !== "object" || Array.isArray(rawTable)) {
      fail("OCR_TABLE_INVALID", "OCR table entry must be an object.", {
        page_index: pageIndex,
        table_index: tableIndex,
      });
    }
    if (typeof rawTable.id !== "string" || !rawTable.id.trim()) {
      fail("OCR_TABLE_ID_MISSING", "OCR table entry is missing its id.", {
        page_index: pageIndex,
        table_index: tableIndex,
      });
    }
    const id = rawTable.id.trim();
    if (byId.has(id)) {
      fail("OCR_TABLE_DUPLICATE", "OCR page contains a duplicate table id.", {
        page_index: pageIndex,
        table_id: id,
      });
    }
    if (rawTable.format !== "markdown") {
      fail("OCR_TABLE_FORMAT_INVALID", "Strict OCR requires markdown table content.", {
        page_index: pageIndex,
        table_id: id,
      });
    }
    if (typeof rawTable.content !== "string") {
      fail("OCR_TABLE_CONTENT_MISSING", "OCR table content is missing.", {
        page_index: pageIndex,
        table_id: id,
      });
    }
    if (!Array.isArray(rawTable.word_confidence_scores)) {
      fail("OCR_TABLE_WORD_CONFIDENCE_MISSING", "OCR table word confidence scores are missing.", {
        page_index: pageIndex,
        table_id: id,
      });
    }
    const words = normalizeOfficialWords(
      rawTable.word_confidence_scores,
      rawTable.content,
      pageIndex,
      {
        fieldPrefix: "pages[].tables[].word_confidence_scores[]",
        indexScope: "table_content",
        tableId: id,
      },
    );
    const table = {
      id,
      order: tableIndex,
      format: "markdown",
      content: rawTable.content,
      content_sha256: sha256Hex(rawTable.content),
      word_confidence: wordConfidenceSummary(words),
      words,
    };
    byId.set(id, table);
    return table;
  });
  return { tables, byId };
}

function tableMarkdownPlaceholder(tableId) {
  return `[${tableId}](${tableId})`;
}

function materializeMarkdownTables(markdown, tables, pageIndex) {
  let materialized = markdown;
  for (const table of tables) {
    const placeholder = tableMarkdownPlaceholder(table.id);
    const first = materialized.indexOf(placeholder);
    if (first >= 0) {
      if (materialized.indexOf(placeholder, first + placeholder.length) >= 0) {
        fail("OCR_TABLE_PLACEHOLDER_DUPLICATE", "OCR table placeholder appears more than once.", {
          page_index: pageIndex,
          table_id: table.id,
        });
      }
      materialized = `${materialized.slice(0, first)}${table.content}${materialized.slice(first + placeholder.length)}`;
    }
  }
  return materialized;
}

function orderedBlocks(rawBlocks, dimensions, pageIndex, markdown, pageWords, normalizedTables) {
  if (!Array.isArray(rawBlocks)) {
    fail("OCR_BLOCKS_MISSING", "OCR page blocks are missing.", { page_index: pageIndex });
  }
  if (rawBlocks.length === 0 && /[\p{L}\p{N}]/u.test(markdown)) {
    fail("OCR_BLOCKS_MISSING", "A non-empty OCR page has no OCR 4 blocks.", {
      page_index: pageIndex,
    });
  }
  let searchFrom = 0;
  const referencedTables = new Set();
  const blocks = rawBlocks.map((block, inputIndex) => {
    if (!block || typeof block !== "object") {
      fail("OCR_BLOCK_INVALID", "OCR block must be an object.", {
        page_index: pageIndex,
        block_input_index: inputIndex,
      });
    }
    const type = typeof block.type === "string" ? block.type.trim().toLowerCase() : "";
    if (!OFFICIAL_OCR4_BLOCK_TYPES.has(type)) {
      fail("OCR_BLOCK_TYPE_INVALID", "OCR block type is not part of the OCR 4 contract.", {
        page_index: pageIndex,
        block_input_index: inputIndex,
      });
    }
    const contentRaw = block.content;
    if (typeof contentRaw !== "string" || (!contentRaw && type !== "signature")) {
      fail("OCR_BLOCK_CONTENT_MISSING", "OCR block content is missing.", {
        page_index: pageIndex,
        block_input_index: inputIndex,
      });
    }
    const bbox = officialBlockBbox(block, dimensions, {
      page_index: pageIndex,
      block_input_index: inputIndex,
    });
    let canonicalContent = contentRaw;
    let tableId = null;
    let table = null;
    let anchorText = contentRaw;
    let blockStart = contentRaw ? markdown.indexOf(contentRaw, searchFrom) : searchFrom;
    if (type === "table") {
      if (typeof block.table_id !== "string" || !block.table_id.trim()) {
        fail("OCR_TABLE_REFERENCE_MISSING", "OCR table block is missing table_id.", {
          page_index: pageIndex,
          block_input_index: inputIndex,
        });
      }
      tableId = block.table_id.trim();
      table = normalizedTables.byId.get(tableId);
      if (!table) {
        fail("OCR_TABLE_REFERENCE_INVALID", "OCR table block references an unknown table id.", {
          page_index: pageIndex,
          block_input_index: inputIndex,
          table_id: tableId,
        });
      }
      if (referencedTables.has(tableId)) {
        fail("OCR_TABLE_REFERENCE_DUPLICATE", "OCR table id is referenced by more than one block.", {
          page_index: pageIndex,
          table_id: tableId,
        });
      }
      referencedTables.add(tableId);
      canonicalContent = table.content;
      const placeholder = tableMarkdownPlaceholder(tableId);
      if (blockStart < 0) {
        blockStart = markdown.indexOf(placeholder, searchFrom);
        anchorText = placeholder;
      }
      if (blockStart < 0 && canonicalContent !== contentRaw) {
        blockStart = markdown.indexOf(canonicalContent, searchFrom);
        anchorText = canonicalContent;
      }
      const contentIsKnown = contentRaw === canonicalContent || contentRaw === placeholder;
      if (!contentIsKnown) {
        fail("OCR_TABLE_BLOCK_CONTENT_MISMATCH", "OCR table block content does not match its table entry or placeholder.", {
          page_index: pageIndex,
          block_input_index: inputIndex,
          table_id: tableId,
        });
      }
    }
    if (blockStart < 0) {
      fail("OCR_BLOCK_CONTENT_MISMATCH", "OCR block content is absent from page markdown in provider order.", {
        page_index: pageIndex,
        block_input_index: inputIndex,
        block_sha256: sha256Hex(contentRaw),
        markdown_sha256: sha256Hex(markdown),
      });
    }
    const blockEnd = blockStart + anchorText.length;
    searchFrom = blockEnd;
    return {
      input_index: inputIndex,
      type,
      bbox,
      content: canonicalContent,
      content_sha256: sha256Hex(canonicalContent),
      provider_content_sha256: sha256Hex(contentRaw),
      table_id: tableId,
      table,
      page_start: blockStart,
      page_end: blockEnd,
    };
  });

  const missingTableReferences = normalizedTables.tables
    .map((table) => table.id)
    .filter((id) => !referencedTables.has(id));
  if (missingTableReferences.length) {
    fail("OCR_TABLE_REFERENCE_MISSING", "OCR tables are not covered by provider reading-order blocks.", {
      page_index: pageIndex,
      table_ids: missingTableReferences,
    });
  }

  for (const word of pageWords) {
    if (word.coverage_start == null || word.coverage_end == null) continue;
    const tableAnchor = blocks.some((block) => (
      block.type === "table" &&
      word.coverage_start >= block.page_start &&
      word.coverage_end <= block.page_end
    ));
    if (tableAnchor) continue;
    const owners = blocks.filter((block) => (
      block.type !== "table" &&
      word.coverage_start >= block.page_start &&
      word.coverage_end <= block.page_end
    ));
    if (owners.length !== 1) {
      fail("OCR_WORD_BLOCK_BINDING_INVALID", "Every word confidence span must belong to exactly one OCR block.", {
        page_index: pageIndex,
        word_index: word.order,
        owner_count: owners.length,
      });
    }
  }

  return {
    // OCR 4 explicitly defines blocks[] as reading order.  Never spatially
    // resort this array: that would corrupt multi-column/table semantics.
    orderBasis: "provider",
    blocks: blocks.map((block, order) => {
      const assigned = block.type === "table"
        ? block.table.words
            .map((word) => ({
              ...word,
              start: word.coverage_start == null ? word.start : word.coverage_start,
              end: word.coverage_end == null ? word.end : word.coverage_end,
              page_start: word.start,
            }))
        : pageWords
            .filter((word) => (
              word.coverage_start != null
                ? word.coverage_start >= block.page_start && word.coverage_end <= block.page_end
                : word.start >= block.page_start && word.end <= block.page_end
            ))
            .map((word) => ({
              ...word,
              start: (word.coverage_start == null ? word.start : word.coverage_start) - block.page_start,
              end: (word.coverage_end == null ? word.end : word.coverage_end) - block.page_start,
              page_start: word.start,
            }));
      const riskContent = block.content;
      validateBlockWordCoverage({
        risk_content: riskContent,
        word_ranges: assigned,
      }, { page_index: pageIndex, block_order: order });
      return {
        order,
        type: block.type,
        bbox: block.bbox,
        content: block.content,
        content_sha256: block.content_sha256,
        ...(block.type === "table" ? { table_id: block.table_id } : {}),
        word_confidence: wordConfidenceSummary(assigned),
        words: assigned.map((word) => ({
          ...publicConfidenceWord(word),
          resolved_start_index: word.page_start,
        })),
        _word_ranges: assigned,
        _risk_content: riskContent,
      };
    }),
  };
}

const RISK_PATTERNS = Object.freeze([
  {
    type: "url",
    regex: /(?:https?:\/\/|mailto:|www\.)[^\s<>"']+/giu,
  },
  {
    type: "number_unit",
    regex: /(?<![\p{L}\p{N}])[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)\s*(?:%|°\s*[CFK]|(?:p|n|µ|μ|m|c|d|k|M|G)?(?:g|L|l|m|s|Pa|Hz|V|A|W|J|N|Ω)|mol(?:\s*\/\s*L)?|atm|bar)(?![\p{L}\p{N}])/gu,
  },
  {
    type: "math_formula",
    regex: /(?:[$][^$\n]{1,160}[$]|\\\([^\n]{1,160}\\\)|\b[\p{L}][\p{L}\p{N}_{}()]*\s*=\s*[^,;.!?\n]{1,120})/gu,
  },
  {
    type: "chemical_formula",
    regex: /(?<![\p{L}\p{N}])(?:\d+\s*)?(?:[A-Z][a-z]?(?:[₀-₉0-9]+|\([A-Za-z0-9]+\)[₀-₉0-9]+)?)+(?![\p{L}\p{N}])/gu,
  },
  {
    // Candidate is filtered below to require both a letter and a number.
    type: "identifier",
    regex: /(?<![\p{L}\p{N}])[\p{L}\p{N}](?:[\p{L}\p{N}._:/-]{1,126}[\p{L}\p{N}])?(?![\p{L}\p{N}])/gu,
  },
  {
    // Bare measurements, record numbers and numeric IDs remain invariant even
    // when there is no adjacent unit.
    type: "bare_number",
    regex: /(?<![\p{L}\p{N}])[-+]?(?:\d+(?:[.,]\d+)*(?:[eE][-+]?\d+)?|[.,]\d+)(?![\p{L}\p{N}])/gu,
  },
]);

const ELEMENT_SYMBOLS = new Set([
  "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne", "Na", "Mg",
  "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca", "Sc", "Ti", "V", "Cr",
  "Mn", "Fe", "Co", "Ni", "Cu", "Zn", "Ga", "Ge", "As", "Se", "Br", "Kr",
  "Rb", "Sr", "Y", "Zr", "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd",
  "In", "Sn", "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
  "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb", "Lu", "Hf",
  "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg", "Tl", "Pb", "Bi", "Po",
  "At", "Rn", "Fr", "Ra", "Ac", "Th", "Pa", "U", "Np", "Pu", "Am", "Cm",
  "Bk", "Cf", "Es", "Fm", "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs",
  "Mt", "Ds", "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og",
]);

function looksLikeChemicalFormula(literal) {
  const compact = literal.replace(/\s+/gu, "");
  const withoutCoefficient = compact.replace(/^\d+/u, "");
  const lettersOnly = withoutCoefficient.replace(/[₀-₉0-9()[\]{}+\-]/gu, "");
  const symbols = lettersOnly.match(/[A-Z][a-z]?/gu) || [];
  if (!symbols.length || symbols.join("") !== lettersOnly) return false;
  if (!symbols.every((symbol) => ELEMENT_SYMBOLS.has(symbol))) return false;
  return symbols.length >= 2 || /[₀-₉0-9]/u.test(withoutCoefficient);
}

function trimRiskLiteral(value) {
  return value.replace(/[.,;:!?]+$/u, "");
}

function riskLiteralSpans(content) {
  const found = [];
  const seenSpans = new Set();
  for (const { type, regex } of RISK_PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const literal = trimRiskLiteral(match[0]);
      if (!literal) continue;
      if (type === "chemical_formula" && !looksLikeChemicalFormula(literal)) continue;
      if (type === "identifier" && !(/[\p{L}]/u.test(literal) && /\p{N}/u.test(literal))) {
        continue;
      }
      const start = match.index;
      const end = start + literal.length;
      const spanKey = `${start}:${end}:${literal}`;
      if (seenSpans.has(spanKey)) continue;
      seenSpans.add(spanKey);
      found.push({ type, literal, start, end });
      if (match[0] === "") regex.lastIndex += 1;
    }
  }
  return found;
}

function collectRiskTokens(block, pageConfidence, threshold, pageIndex) {
  const riskContent = block._risk_content;
  const found = [];
  for (const { type, literal, start, end } of riskLiteralSpans(riskContent)) {
    const overlapping = block._word_ranges
      .filter((word) => word.end > start && word.start < end)
      .map((word) => word.confidence);
    // Never inherit an unrelated block/page minimum.  Missing word overlap is
    // itself uncertain evidence and must go through visual adjudication.
    const confidence = overlapping.length
      ? Math.min(pageConfidence, ...overlapping)
      : null;
    found.push({
      page_index: pageIndex,
      block_order: block.order,
      type,
      token_sha256: sha256Hex(literal),
      confidence,
      threshold,
      needs_visual_adjudication: confidence == null || confidence < threshold,
    });
  }
  return found.sort((left, right) => (
    left.block_order - right.block_order ||
    compareStrings(left.type, right.type) ||
    compareStrings(left.token_sha256, right.token_sha256)
  ));
}

function normalizeHiddenOcrAuxiliary(hiddenOcrPageTexts, pageCount) {
  if (hiddenOcrPageTexts == null) return null;
  if (!Array.isArray(hiddenOcrPageTexts)) {
    fail("OCR_AUXILIARY_INVALID", "Hidden OCR auxiliary text must be a page array.");
  }
  const pages = [];
  const seen = new Set();
  for (const entry of hiddenOcrPageTexts) {
    // Existing pagetext output is one-based.  A strict caller may also pass an
    // explicit zero-based `index`; the two forms are never guessed from value.
    const index = entry && entry.index != null
      ? integerIndex(entry.index, "hiddenOcrPageTexts[].index")
      : Number.isInteger(entry && entry.page) && entry.page >= 1
        ? entry.page - 1
        : fail("OCR_AUXILIARY_PAGE_INVALID", "Hidden OCR page needs index or one-based page.");
    if (index >= pageCount || seen.has(index)) {
      fail("OCR_AUXILIARY_PAGE_INVALID", "Hidden OCR page is duplicate or outside the PDF.", {
        page_index: index,
      });
    }
    const text = entry && entry.text;
    if (typeof text !== "string") {
      fail("OCR_AUXILIARY_INVALID", "Hidden OCR auxiliary page text must be a string.", {
        page_index: index,
      });
    }
    seen.add(index);
    pages.push({ index, length: text.length, content_sha256: sha256Hex(text.normalize("NFC")) });
  }
  pages.sort((a, b) => a.index - b.index);
  return {
    authoritative: false,
    page_count: pages.length,
    pages,
    digest: evidenceDigest(pages),
  };
}

function responseRequestId(response, responseHeaders) {
  if (responseHeaders && typeof responseHeaders.get === "function") {
    for (const name of ["x-request-id", "request-id", "mistral-request-id", "x-mistral-request-id"]) {
      const value = responseHeaders.get(name);
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  // The public OCRResponse schema has no request ID.  This fallback exists for
  // persisted/mock responses passed directly to the canonicalizer; live HTTP
  // calls always prefer the provider response header above.
  const direct = response && (response.request_id || response.id);
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  return "";
}

function buildCanonicalOcrEvidence(providerResponse, {
  sourcePdf,
  sourcePages,
  hiddenOcrPageTexts = null,
  responseHeaders = null,
  requireHeaderRequestId = false,
  aspectRatioTolerance = DEFAULT_ASPECT_RATIO_TOLERANCE,
  riskConfidenceThreshold = DEFAULT_RISK_CONFIDENCE_THRESHOLD,
} = {}) {
  if (!providerResponse || typeof providerResponse !== "object" || Array.isArray(providerResponse)) {
    fail("OCR_RESPONSE_INVALID", "OCR provider response must be an object.");
  }
  if (!Buffer.isBuffer(sourcePdf) || sourcePdf.length === 0) {
    fail("OCR_SOURCE_PDF_REQUIRED", "Strict OCR evidence requires the source PDF bytes.");
  }
  const normalizedSourcePages = normalizeSourcePages(sourcePages);
  const tolerance = requireConfidence(aspectRatioTolerance, "aspectRatioTolerance");
  const threshold = requireConfidence(riskConfidenceThreshold, "riskConfidenceThreshold");
  const model = requireNonEmptyString(providerResponse.model, "model");
  const requestId = requireNonEmptyString(
    responseRequestId(requireHeaderRequestId ? null : providerResponse, responseHeaders),
    "request_id",
  );
  if (!Array.isArray(providerResponse.pages)) {
    fail("OCR_PAGES_MISSING", "OCR provider response has no pages array.");
  }
  const usage = providerResponse.usage_info;
  if (!usage || typeof usage !== "object" || !Number.isInteger(usage.pages_processed) ||
      usage.pages_processed < 0) {
    fail("OCR_USAGE_INVALID", "OCR 4 usage_info.pages_processed is missing or invalid.");
  }
  if (usage.doc_size_bytes != null &&
      (!Number.isInteger(usage.doc_size_bytes) || usage.doc_size_bytes < 0)) {
    fail("OCR_USAGE_INVALID", "OCR 4 usage_info.doc_size_bytes is invalid.");
  }

  const pageMap = new Map();
  for (const page of providerResponse.pages) {
    const index = integerIndex(page && page.index, "pages[].index");
    if (pageMap.has(index)) {
      fail("OCR_PAGE_DUPLICATE", "OCR provider response contains a duplicate page index.", {
        page_index: index,
      });
    }
    pageMap.set(index, page);
  }
  const expectedIndices = normalizedSourcePages.map((page) => page.index);
  const actualIndices = [...pageMap.keys()].sort((a, b) => a - b);
  if (
    actualIndices.length !== expectedIndices.length ||
    actualIndices.some((value, index) => value !== expectedIndices[index])
  ) {
    fail(
      "OCR_PAGE_COVERAGE",
      "OCR response must cover every zero-based PDF page exactly once.",
      { expected_indices: expectedIndices, actual_indices: actualIndices },
    );
  }
  if (usage.pages_processed !== expectedIndices.length) {
    fail("OCR_USAGE_PAGE_MISMATCH", "OCR usage page count does not match exact page coverage.", {
      expected_pages: expectedIndices.length,
      processed_pages: usage.pages_processed,
    });
  }

  const pages = [];
  const riskTokens = [];
  for (const source of normalizedSourcePages) {
    const rawPage = pageMap.get(source.index);
    if (typeof rawPage.markdown !== "string") {
      fail("OCR_PAGE_MARKDOWN_MISSING", "OCR 4 page markdown is missing.", {
        page_index: source.index,
      });
    }
    if (!Array.isArray(rawPage.images)) {
      fail("OCR_PAGE_IMAGES_MISSING", "OCR 4 page images array is missing.", {
        page_index: source.index,
      });
    }
    const dimensions = responseDimensions(rawPage, source.index);
    const relativeAspectError = Math.abs(dimensions.aspect_ratio - source.aspect_ratio) /
      source.aspect_ratio;
    if (relativeAspectError > tolerance) {
      fail("OCR_PAGE_ASPECT_MISMATCH", "OCR page dimensions do not match the original page aspect ratio.", {
        page_index: source.index,
        source_aspect_ratio: source.aspect_ratio,
        ocr_aspect_ratio: dimensions.aspect_ratio,
        relative_error: relativeAspectError,
        tolerance,
      });
    }
    const confidence = normalizeOfficialPageConfidence(rawPage, source.index);
    const pageWords = normalizeOfficialWords(
      confidence.rawWords,
      rawPage.markdown,
      source.index,
    );
    const normalizedTables = normalizeOfficialTables(rawPage.tables, source.index);
    const normalizedBlocks = orderedBlocks(
      rawPage.blocks,
      dimensions,
      source.index,
      rawPage.markdown,
      pageWords,
      normalizedTables,
    );
    const pageRisks = [];
    for (const block of normalizedBlocks.blocks) {
      pageRisks.push(...collectRiskTokens(
        block,
        confidence.average,
        threshold,
        source.index,
      ));
    }
    riskTokens.push(...pageRisks);
    const publicBlocks = normalizedBlocks.blocks.map(
      ({ _word_ranges, _risk_content, ...block }) => block,
    );
    const providerMarkdown = rawPage.markdown;
    const text = materializeMarkdownTables(providerMarkdown, normalizedTables.tables, source.index);
    const publicTables = normalizedTables.tables.map((table) => ({
      id: table.id,
      order: table.order,
      format: table.format,
      content: table.content,
      content_sha256: table.content_sha256,
      word_confidence: table.word_confidence,
      words: table.words.map(publicConfidenceWord),
    }));
    pages.push({
      index: source.index,
      dimensions,
      source_dimensions: {
        width: source.width,
        height: source.height,
        rotation: source.rotation,
      },
      page_confidence: confidence.average,
      minimum_page_confidence: confidence.minimum,
      reading_order_basis: normalizedBlocks.orderBasis,
      blocks: publicBlocks,
      tables: publicTables,
      provider_word_confidence_segments: pageWords.map(publicConfidenceWord),
      provider_markdown: providerMarkdown,
      provider_markdown_sha256: sha256Hex(providerMarkdown),
      text,
      text_sha256: sha256Hex(text),
      needs_visual_adjudication: pageRisks.some((token) => token.needs_visual_adjudication),
    });
  }

  const lowConfidenceRisks = riskTokens.filter((token) => token.needs_visual_adjudication);
  const evidence = {
    schema_version: OCR_EVIDENCE_SCHEMA_VERSION,
    task: "strict-ocr-source-evidence",
    provider: "mistral",
    model,
    request_id: requestId,
    source_pdf_sha256: sha256Hex(sourcePdf),
    page_count: pages.length,
    pages,
    risk_confidence_threshold: threshold,
    risk_tokens: riskTokens,
    needs_visual_adjudication: lowConfidenceRisks.length > 0,
    auxiliary_hidden_ocr: normalizeHiddenOcrAuxiliary(
      hiddenOcrPageTexts,
      normalizedSourcePages.length,
    ),
  };
  evidence.evidence_sha256 = evidenceDigest(evidence);
  return evidence;
}

function summarizeOcrEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return null;
  return {
    schema_version: evidence.schema_version,
    provider: evidence.provider,
    model: evidence.model,
    request_id: evidence.request_id,
    source_pdf_sha256: evidence.source_pdf_sha256,
    evidence_sha256: evidence.evidence_sha256,
    page_count: evidence.page_count,
    pages: Array.isArray(evidence.pages)
      ? evidence.pages.map((page) => ({
          index: page.index,
          dimensions: page.dimensions,
          source_rotation: page.source_dimensions && page.source_dimensions.rotation,
          page_confidence: page.page_confidence,
          minimum_page_confidence: page.minimum_page_confidence,
          block_count: Array.isArray(page.blocks) ? page.blocks.length : 0,
          table_count: Array.isArray(page.tables) ? page.tables.length : 0,
          provider_markdown_sha256: page.provider_markdown_sha256,
          text_sha256: page.text_sha256,
          needs_visual_adjudication: !!page.needs_visual_adjudication,
        }))
      : [],
    risk_tokens: Array.isArray(evidence.risk_tokens)
      ? evidence.risk_tokens.map((token) => ({
          page_index: token.page_index,
          block_order: token.block_order,
          type: token.type,
          token_sha256: token.token_sha256,
          confidence: token.confidence,
          threshold: token.threshold,
          needs_visual_adjudication: !!token.needs_visual_adjudication,
        }))
      : [],
    needs_visual_adjudication: !!evidence.needs_visual_adjudication,
    auxiliary_hidden_ocr: evidence.auxiliary_hidden_ocr,
  };
}

function assertExactObjectKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("OCR_EVIDENCE_SCHEMA_INVALID", `${path} must be an object.`, { path });
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail("OCR_EVIDENCE_SCHEMA_INVALID", `${path} has missing or unexpected fields.`, {
      path,
      missing: wanted.filter((key) => !actual.includes(key)),
      unexpected: actual.filter((key) => !wanted.includes(key)),
    });
  }
}

function validateAuxiliaryHashes(auxiliary, pageCount) {
  if (auxiliary == null) return null;
  assertExactObjectKeys(
    auxiliary,
    ["authoritative", "page_count", "pages", "digest"],
    "auxiliary_hidden_ocr",
  );
  if (auxiliary.authoritative !== false || !Array.isArray(auxiliary.pages)) {
    fail(
      "OCR_EVIDENCE_SCHEMA_INVALID",
      "Hidden OCR evidence must remain non-authoritative hash metadata.",
    );
  }
  const seen = new Set();
  for (const [position, page] of auxiliary.pages.entries()) {
    assertExactObjectKeys(page, ["index", "length", "content_sha256"], `auxiliary.pages[${position}]`);
    const index = integerIndex(page.index, "auxiliary.pages[].index");
    if (index >= pageCount || seen.has(index)) {
      fail("OCR_EVIDENCE_SCHEMA_INVALID", "Auxiliary OCR page coverage is invalid.", {
        page_index: index,
      });
    }
    if (!Number.isInteger(page.length) || page.length < 0 || !/^[a-f0-9]{64}$/.test(page.content_sha256)) {
      fail("OCR_EVIDENCE_SCHEMA_INVALID", "Auxiliary OCR hash metadata is invalid.", {
        page_index: index,
      });
    }
    seen.add(index);
  }
  if (auxiliary.page_count !== auxiliary.pages.length || auxiliary.digest !== evidenceDigest(auxiliary.pages)) {
    fail("OCR_EVIDENCE_SEAL_INVALID", "Auxiliary OCR hash manifest does not match its seal.");
  }
  return auxiliary;
}

// Revalidate already-canonical runtime evidence before it crosses the LaTeX or
// postflight boundary.  Raw provider JSON is intentionally not needed: the
// canonical page blocks are reconstructed through the same strict normalizer,
// then every structural field and the top-level seal is compared.
function validateCanonicalOcrEvidence(evidence, { sourcePdf } = {}) {
  const baseKeys = [
    "schema_version",
    "task",
    "provider",
    "model",
    "request_id",
    "source_pdf_sha256",
    "page_count",
    "pages",
    "risk_confidence_threshold",
    "risk_tokens",
    "needs_visual_adjudication",
    "auxiliary_hidden_ocr",
    "evidence_sha256",
  ];
  const keys = evidence && typeof evidence === "object" ? Object.keys(evidence) : [];
  const expectedKeys = keys.includes("visual_adjudication")
    ? [...baseKeys, "visual_adjudication"]
    : baseKeys;
  assertExactObjectKeys(evidence, expectedKeys, "ocr_evidence");
  if (
    evidence.schema_version !== OCR_EVIDENCE_SCHEMA_VERSION ||
    evidence.task !== "strict-ocr-source-evidence" ||
    evidence.provider !== "mistral"
  ) {
    fail("OCR_EVIDENCE_SCHEMA_INVALID", "Unsupported OCR evidence schema, task, or provider.");
  }
  if (!Buffer.isBuffer(sourcePdf) || sourcePdf.length === 0) {
    fail("OCR_SOURCE_PDF_REQUIRED", "OCR evidence validation requires source PDF bytes.");
  }
  const sourceDigest = sha256Hex(sourcePdf);
  if (evidence.source_pdf_sha256 !== sourceDigest) {
    fail("OCR_EVIDENCE_SOURCE_MISMATCH", "OCR evidence is bound to a different source PDF.", {
      expected_source_sha256: sourceDigest,
      actual_source_sha256: String(evidence.source_pdf_sha256 || ""),
    });
  }
  if (!Array.isArray(evidence.pages) || evidence.page_count !== evidence.pages.length) {
    fail("OCR_EVIDENCE_SCHEMA_INVALID", "OCR evidence page_count is inconsistent.");
  }
  const providerResponse = {
    request_id: evidence.request_id,
    model: evidence.model,
    usage_info: {
      pages_processed: evidence.page_count,
      doc_size_bytes: sourcePdf.length,
    },
    pages: evidence.pages.map((page) => ({
      index: page.index,
      markdown: page.provider_markdown,
      images: [],
      dimensions: page.dimensions,
      confidence_scores: {
        average_page_confidence_score: page.page_confidence,
        minimum_page_confidence_score: page.minimum_page_confidence,
        word_confidence_scores: Array.isArray(page.provider_word_confidence_segments)
          ? [...page.provider_word_confidence_segments]
              .sort((left, right) => left.resolved_start_index - right.resolved_start_index)
              .map((word) => ({
                text: word.content,
                confidence: word.confidence,
                start_index: word.start_index,
              }))
          : null,
      },
      tables: Array.isArray(page.tables)
        ? page.tables.map((table) => ({
            id: table.id,
            content: table.content,
            format: table.format,
            word_confidence_scores: Array.isArray(table.words)
              ? [...table.words]
                  .sort((left, right) => left.resolved_start_index - right.resolved_start_index)
                  .map((word) => ({
                    text: word.content,
                    confidence: word.confidence,
                    start_index: word.start_index,
                  }))
              : null,
          }))
        : null,
      blocks: Array.isArray(page.blocks)
        ? page.blocks.map((block) => ({
            type: block.type,
            top_left_x: block.bbox[0],
            top_left_y: block.bbox[1],
            bottom_right_x: block.bbox[2],
            bottom_right_y: block.bbox[3],
            content: block.content,
            ...(block.type === "table" ? { table_id: block.table_id } : {}),
          }))
        : null,
    })),
  };
  const sourcePages = evidence.pages.map((page) => ({
    index: page.index,
    width: page && page.source_dimensions && page.source_dimensions.width,
    height: page && page.source_dimensions && page.source_dimensions.height,
    rotation: page && page.source_dimensions && page.source_dimensions.rotation,
  }));
  const rebuilt = buildCanonicalOcrEvidence(providerResponse, {
    sourcePdf,
    sourcePages,
    riskConfidenceThreshold: evidence.risk_confidence_threshold,
  });
  for (const field of [
    "schema_version",
    "task",
    "provider",
    "model",
    "request_id",
    "source_pdf_sha256",
    "page_count",
    "pages",
    "risk_confidence_threshold",
    "risk_tokens",
    "needs_visual_adjudication",
  ]) {
    if (canonicalJson(evidence[field]) !== canonicalJson(rebuilt[field])) {
      fail("OCR_EVIDENCE_CONTENT_MISMATCH", `OCR evidence ${field} is not canonical.`, {
        field,
      });
    }
  }
  validateAuxiliaryHashes(evidence.auxiliary_hidden_ocr, evidence.page_count);
  if (evidence.needs_visual_adjudication) {
    if (!Object.prototype.hasOwnProperty.call(evidence, "visual_adjudication")) {
      fail(
        "OCR_VISUAL_ADJUDICATION_REQUIRED",
        "Low-confidence risky OCR tokens have no sealed visual adjudication.",
        { evidence_sha256: evidence.evidence_sha256 },
      );
    }
    if (!Object.prototype.hasOwnProperty.call(
      evidence.visual_adjudication,
      "render_attestation",
    )) {
      fail(
        "OCR_VISUAL_RENDER_ATTESTATION_MISSING",
        "Low-confidence visual evidence has no trusted source-render attestation.",
      );
    }
    validateVisualAdjudication(evidence.visual_adjudication, evidence);
  } else if (Object.prototype.hasOwnProperty.call(evidence, "visual_adjudication")) {
    fail(
      "OCR_EVIDENCE_SCHEMA_INVALID",
      "Visual adjudication must not be attached when no risky token requires it.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(evidence.evidence_sha256 || ""))) {
    fail("OCR_EVIDENCE_SEAL_INVALID", "OCR evidence seal is not canonical SHA-256.");
  }
  const { evidence_sha256: seal, ...unsigned } = evidence;
  if (seal !== evidenceDigest(unsigned)) {
    fail("OCR_EVIDENCE_SEAL_INVALID", "OCR evidence seal does not match its canonical payload.");
  }
  return evidence;
}

function retryAbortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("OCR request aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

const sleep = (ms, { signal } = {}) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(retryAbortError(signal));
    return;
  }
  let timer = null;
  const onAbort = () => {
    if (timer) clearTimeout(timer);
    reject(retryAbortError(signal));
  };
  timer = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

async function waitForRetry(ms, { signal, sleepImpl = sleep } = {}) {
  if (signal?.aborted) throw retryAbortError(signal);
  if (!signal || sleepImpl === sleep) {
    await sleepImpl(ms, { signal });
    return;
  }
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(retryAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Test/custom wait implementations may ignore the second argument.  Racing
    // them with the signal still makes provider-batch cancellation and the
    // independent cleanup deadline observable immediately.
    await Promise.race([
      Promise.resolve().then(() => sleepImpl(ms, { signal })),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
function backoffMs(attempt) {
  return Math.min(15000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
}

function retryAfterMs(headers) {
  const raw = headers && typeof headers.get === "function"
    ? headers.get("retry-after")
    : null;
  if (raw == null || String(raw).trim() === "") return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(120000, Math.ceil(seconds * 1000));
  }
  const at = Date.parse(String(raw));
  return Number.isFinite(at)
    ? Math.min(120000, Math.max(0, at - Date.now()))
    : 0;
}

async function fetchWithRetry(url, init, {
  fetchImpl,
  signal,
  sleepImpl,
  maxAttempts = 3,
} = {}) {
  const retryable = new Set([429, 500, 502, 503, 504, 529]);
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (signal?.aborted || attempt >= maxAttempts) throw error;
      await waitForRetry(backoffMs(attempt), { signal, sleepImpl });
      continue;
    }
    if (!retryable.has(response.status) || attempt >= maxAttempts || signal?.aborted) {
      return response;
    }
    try {
      await response.arrayBuffer();
    } catch {
      /* retry response drain is best-effort */
    }
    await waitForRetry(
      Math.max(backoffMs(attempt), retryAfterMs(response.headers)),
      { signal, sleepImpl },
    );
  }
}

async function readProviderJson(response, code, message) {
  const raw = await response.text();
  const ok = response.ok == null
    ? response.status >= 200 && response.status < 300
    : response.ok;
  if (!ok) {
    fail(code, `${message} returned HTTP ${response.status}.`, {
      status: response.status,
      response_sha256: sha256Hex(raw),
      response_bytes: Buffer.byteLength(raw),
    });
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${code}_JSON_INVALID`, `${message} returned invalid JSON.`, {
      status: response.status,
      response_sha256: sha256Hex(raw),
      response_bytes: Buffer.byteLength(raw),
    });
  }
}

async function uploadTemporaryOcrFile(pdfBuffer, {
  fetchImpl,
  apiKey,
  baseUrl,
  signal,
  sleepImpl,
} = {}) {
  if (typeof FormData !== "function" || typeof Blob !== "function") {
    fail("OCR_FILE_UPLOAD_UNAVAILABLE", "Runtime does not support temporary OCR file upload.");
  }
  const form = new FormData();
  form.append("purpose", "ocr");
  form.append("visibility", "user");
  form.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), "document.pdf");
  let response;
  try {
    // POST /files is non-idempotent.  Retrying an ambiguous network failure can
    // create an additional provider file whose id was lost with the first
    // response, leaving no handle that the finally cleanup can delete.
    response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    fail("OCR_FILE_UPLOAD_FAILED", "Mistral OCR temporary file upload request failed.", {
      cause_code: typeof error?.code === "string" ? error.code : null,
    });
  }
  const uploaded = await readProviderJson(
    response,
    "OCR_FILE_UPLOAD_FAILED",
    "Mistral OCR temporary file upload",
  );
  const fileId = typeof uploaded.id === "string" ? uploaded.id.trim() : "";
  if (!fileId) fail("OCR_FILE_UPLOAD_FAILED", "Mistral OCR file upload returned no file id.");
  try {
    const signedResponse = await fetchWithRetry(
      `${String(baseUrl).replace(/\/$/, "")}/files/${encodeURIComponent(fileId)}/url?expiry=1`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      { fetchImpl, signal, sleepImpl },
    );
    const signed = await readProviderJson(
      signedResponse,
      "OCR_FILE_URL_FAILED",
      "Mistral OCR signed URL request",
    );
    const url = typeof signed.url === "string" ? signed.url.trim() : "";
    if (!url) fail("OCR_FILE_URL_FAILED", "Mistral OCR signed URL response is empty.");
    return { fileId, url };
  } catch (error) {
    try {
      await deleteTemporaryOcrFile(fileId, {
        fetchImpl,
        apiKey,
        baseUrl,
        signal: undefined,
        sleepImpl,
      });
    } catch (cleanupError) {
      fail(
        "OCR_FILE_CLEANUP_FAILED",
        "Mistral OCR signed URL creation failed and temporary file deletion could not be verified.",
        {
          primary_code: typeof error?.code === "string" ? error.code : null,
          cleanup_code: typeof cleanupError?.code === "string" ? cleanupError.code : null,
          file_id_sha256: sha256Hex(fileId),
        },
      );
    }
    throw error;
  }
}

async function deleteTemporaryOcrFile(fileId, {
  fetchImpl,
  apiKey,
  baseUrl,
  signal,
  sleepImpl,
} = {}) {
  const cleanupController = signal ? null : new AbortController();
  const cleanupTimeoutMs = Math.max(
    5000,
    Number.parseInt(process.env.MISTRAL_OCR_CLEANUP_TIMEOUT_MS || "20000", 10) || 20000,
  );
  const timer = cleanupController
    ? setTimeout(() => cleanupController.abort(), cleanupTimeoutMs)
    : null;
  timer?.unref?.();
  try {
    const response = await fetchWithRetry(
      `${String(baseUrl).replace(/\/$/, "")}/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
      { fetchImpl, signal: signal || cleanupController.signal, sleepImpl },
    );
    const raw = await response.text();
    const ok = response.ok == null
      ? response.status >= 200 && response.status < 300
      : response.ok;
    if (!ok) {
      fail("OCR_FILE_CLEANUP_FAILED", `Mistral OCR temporary file deletion returned HTTP ${response.status}.`, {
        status: response.status,
        response_sha256: sha256Hex(raw),
        response_bytes: Buffer.byteLength(raw),
      });
    }
    if (!raw.trim()) {
      fail("OCR_FILE_CLEANUP_FAILED", "Mistral OCR returned no temporary file deletion confirmation.", {
        status: response.status,
        response_bytes: 0,
      });
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      fail("OCR_FILE_CLEANUP_FAILED", "Mistral OCR temporary file deletion returned invalid JSON.", {
        status: response.status,
        response_sha256: sha256Hex(raw),
        response_bytes: Buffer.byteLength(raw),
      });
    }
    if (payload?.deleted !== true || String(payload?.id || "") !== String(fileId)) {
      fail("OCR_FILE_CLEANUP_FAILED", "Mistral OCR did not confirm temporary file deletion.", {
        status: response.status,
        file_id_matches: String(payload?.id || "") === String(fileId),
        deleted: payload?.deleted === true,
      });
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function requestOcr(pdfBuffer, {
  signal,
  fetchImpl = globalThis.fetch,
  apiKey = mistralKey(),
  baseUrl = MISTRAL_BASE,
  requestedModel = MISTRAL_OCR_MODEL,
  sleepImpl = sleep,
  inlineMaxBytes = INLINE_MAX_MB * 1024 * 1024,
  sourcePages = null,
  providerBatchPages = Number.parseInt(
    process.env.PDF_OCR_PROVIDER_BATCH_PAGES || "50",
    10,
  ),
  providerConcurrency = Number.parseInt(
    process.env.PDF_OCR_PROVIDER_CONCURRENCY || "2",
    10,
  ),
  requireRequestId = true,
} = {}) {
  if (typeof fetchImpl !== "function") {
    fail("OCR_FETCH_UNAVAILABLE", "No fetch implementation is available for OCR.");
  }
  const requestController = new AbortController();
  const onAbort = () => requestController.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) requestController.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const requestSignal = requestController.signal;
  const totalPages = Array.isArray(sourcePages) ? sourcePages.length : 0;
  const batchSize = Math.max(
    1,
    Math.min(100, Number.isInteger(providerBatchPages) ? providerBatchPages : 50),
  );
  const pageBatches = [];
  if (totalPages > batchSize) {
    for (let start = 0; start < totalPages; start += batchSize) {
      pageBatches.push(
        Array.from(
          { length: Math.min(batchSize, totalPages - start) },
          (_, index) => start + index,
        ),
      );
    }
  } else {
    pageBatches.push(null);
  }
  let temporaryFile = null;
  let documentUrl;
  let primaryError = null;
  try {
    // 여러 OCR 범위가 같은 원본을 읽을 때 data URL을 매번 재전송하지 않는다.
    if (pdfBuffer.length > inlineMaxBytes || pageBatches.length > 1) {
      temporaryFile = await uploadTemporaryOcrFile(pdfBuffer, {
        fetchImpl,
        apiKey,
        baseUrl,
        signal: requestSignal,
        sleepImpl,
      });
      documentUrl = temporaryFile.url;
    } else {
      documentUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`;
    }
    const baseBody = {
      model: requestedModel,
      document: { type: "document_url", document_url: documentUrl },
      include_image_base64: false,
      include_blocks: true,
      confidence_scores_granularity: "word",
      table_format: "markdown",
    };
    const fetchBatch = async (pageIndices) => {
    const body = pageIndices == null
      ? baseBody
      : { ...baseBody, pages: pageIndices };
    const response = await fetchWithRetry(
      `${String(baseUrl).replace(/\/$/, "")}/ocr`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { fetchImpl, signal: requestSignal, sleepImpl },
    );
    const raw = await response.text();
    const requestId = responseRequestId(null, response.headers) || null;
    const ok = response.ok == null
      ? response.status >= 200 && response.status < 300
      : response.ok;
    if (!ok) {
      fail("OCR_PROVIDER_HTTP_ERROR", `Mistral OCR returned HTTP ${response.status}.`, {
        status: response.status,
        response_sha256: sha256Hex(raw),
        response_bytes: Buffer.byteLength(raw),
        request_id: requestId,
      });
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      fail("OCR_PROVIDER_JSON_INVALID", "Mistral OCR response is not valid JSON.", {
        status: response.status,
        response_sha256: sha256Hex(raw),
        response_bytes: Buffer.byteLength(raw),
        request_id: requestId,
      });
    }
    if (requireRequestId && !requestId) {
      fail("OCR_IDENTITY_MISSING", "Mistral OCR response header has no request id.");
    }
    if (pageIndices != null) {
      const returnedPages = Array.isArray(json?.pages)
        ? json.pages.map((page) => Number(page?.index))
        : [];
      const processedPages = Number(json?.usage_info?.pages_processed);
      if (
        returnedPages.length !== pageIndices.length ||
        returnedPages.some((page, index) => page !== pageIndices[index]) ||
        processedPages !== pageIndices.length
      ) {
        fail("OCR_BATCH_COVERAGE_INVALID", "Mistral OCR page batch coverage is incomplete.", {
          requested_pages: pageIndices,
          returned_pages: returnedPages,
          pages_processed: Number.isFinite(processedPages) ? processedPages : null,
          request_id: requestId,
        });
      }
    }
    return { json, requestId, headers: response.headers };
    };

    const results = new Array(pageBatches.length);
    const concurrency = Math.max(
      1,
      Math.min(4, Number.isInteger(providerConcurrency) ? providerConcurrency : 2),
    );
    let next = 0;
    let fatalError = null;
    const worker = async () => {
      try {
        for (;;) {
          if (requestSignal.aborted) throw new Error("OCR request aborted.");
          const index = next++;
          if (index >= pageBatches.length) return;
          results[index] = await fetchBatch(pageBatches[index]);
        }
      } catch (error) {
        if (!fatalError) fatalError = error;
        requestController.abort(error);
        throw error;
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: Math.min(concurrency, pageBatches.length) }, () => worker()),
    );
    if (fatalError) throw fatalError;
    const rejected = settled.find((entry) => entry.status === "rejected");
    if (rejected) throw rejected.reason;

    if (results.length === 1) {
      return { json: results[0].json, headers: results[0].headers };
    }
    const models = new Set(results.map((result) => String(result.json?.model || "")));
    if (models.size !== 1 || !models.has(requestedModel)) {
      fail("OCR_IDENTITY_MISMATCH", "Mistral OCR model changed between page batches.", {
        models: [...models],
      });
    }
    const pages = results.flatMap((result) =>
      Array.isArray(result.json?.pages) ? result.json.pages : [],
    );
    const processedPages = results.reduce(
      (sum, result) => sum + Number(result.json?.usage_info?.pages_processed || 0),
      0,
    );
    const requestIds = results.map((result) => result.requestId);
    const aggregateRequestId = `batch-${sha256Hex(requestIds.join("\n"))}`;
    const json = {
      ...results[0].json,
      model: requestedModel,
      pages,
      usage_info: {
        ...(results[0].json?.usage_info || {}),
        pages_processed: processedPages,
        doc_size_bytes: pdfBuffer.length,
      },
    };
    const headers = {
      get(name) {
        const normalized = String(name || "").toLowerCase();
        return normalized === "x-request-id" || normalized === "request-id"
          ? aggregateRequestId
          : null;
      },
    };
    return { json, headers };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    if (temporaryFile) {
      try {
        await deleteTemporaryOcrFile(temporaryFile.fileId, {
          fetchImpl,
          apiKey,
          baseUrl,
          signal: undefined,
          sleepImpl,
        });
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        fail(
          "OCR_FILE_CLEANUP_FAILED",
          "Mistral OCR failed and temporary file deletion could not be verified.",
          {
            primary_code: typeof primaryError?.code === "string" ? primaryError.code : null,
            cleanup_code: typeof cleanupError?.code === "string" ? cleanupError.code : null,
            file_id_sha256: sha256Hex(temporaryFile.fileId),
          },
        );
      }
    }
  }
}

function assertStrictInput(pdfBuffer, { apiKey, strict }) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    if (strict) fail("OCR_SOURCE_PDF_REQUIRED", "Strict OCR requires non-empty PDF bytes.");
    return false;
  }
  if (!apiKey) {
    if (strict) fail("OCR_NOT_CONFIGURED", "Strict OCR is unavailable because the provider key is missing.");
    return false;
  }
  const sizeMB = pdfBuffer.length / (1024 * 1024);
  if (sizeMB > MAX_MB) {
    if (strict) {
      fail("OCR_INPUT_TOO_LARGE", "Strict OCR input exceeds the provider file limit.", {
        size_bytes: pdfBuffer.length,
        max_bytes: MAX_MB * 1024 * 1024,
      });
    }
    return false;
  }
  return true;
}

function canonicalVisualRiskTokens(evidence) {
  return evidence.risk_tokens
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
      compareStrings(left.type, right.type) ||
      compareStrings(left.token_sha256, right.token_sha256)
    ));
}

function canonicalVisualSourcePages(evidence) {
  return evidence.pages.map((page) => ({
    index: page.index,
    width: page.source_dimensions.width,
    height: page.source_dimensions.height,
    rotation: Number(page.source_dimensions.rotation) || 0,
  }));
}

function preAdjudicationEvidenceDigest(evidence) {
  const unsigned = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (key !== "evidence_sha256" && key !== "visual_adjudication") unsigned[key] = value;
  }
  return evidenceDigest(unsigned);
}

function validateVisualInputCommitment(commitment, inputDigest, evidence) {
  assertExactObjectKeys(
    commitment,
    [
      "schema_version",
      "source_pdf_sha256",
      "ocr_evidence_sha256",
      "risk_tokens",
      "source_pages",
      "rendered_pages",
    ],
    "visual_adjudication.input_commitment",
  );
  if (commitment.schema_version !== 1) {
    fail(
      "OCR_VISUAL_ADJUDICATION_COMMITMENT_INVALID",
      "Visual adjudication input commitment schema is unsupported.",
    );
  }
  const expectedRiskTokens = canonicalVisualRiskTokens(evidence);
  const expectedSourcePages = canonicalVisualSourcePages(evidence);
  if (
    commitment.source_pdf_sha256 !== evidence.source_pdf_sha256 ||
    commitment.ocr_evidence_sha256 !== preAdjudicationEvidenceDigest(evidence) ||
    canonicalJson(commitment.risk_tokens) !== canonicalJson(expectedRiskTokens) ||
    canonicalJson(commitment.source_pages) !== canonicalJson(expectedSourcePages)
  ) {
    fail(
      "OCR_VISUAL_ADJUDICATION_COMMITMENT_MISMATCH",
      "Visual adjudication input commitment is not derived from canonical OCR evidence.",
    );
  }
  const expectedPageIndices = [...new Set(expectedRiskTokens.map((token) => token.page_index))]
    .sort((left, right) => left - right);
  if (!Array.isArray(commitment.rendered_pages)) {
    fail(
      "OCR_VISUAL_ADJUDICATION_COMMITMENT_INVALID",
      "Visual adjudication input commitment has no rendered pages.",
    );
  }
  const actualPageIndices = commitment.rendered_pages.map((page) => page && page.index);
  if (canonicalJson(actualPageIndices) !== canonicalJson(expectedPageIndices)) {
    fail(
      "OCR_VISUAL_ADJUDICATION_COMMITMENT_MISMATCH",
      "Visual adjudication input commitment does not cover every risky page exactly once.",
    );
  }
  const sourcePages = new Map(expectedSourcePages.map((page) => [page.index, page]));
  for (const [pagePosition, page] of commitment.rendered_pages.entries()) {
    assertExactObjectKeys(
      page,
      ["index", "source_width", "source_height", "tiles"],
      `visual_adjudication.input_commitment.rendered_pages[${pagePosition}]`,
    );
    const source = sourcePages.get(page.index);
    if (
      !source || page.source_width !== source.width || page.source_height !== source.height ||
      !Array.isArray(page.tiles) || !page.tiles.length
    ) {
      fail(
        "OCR_VISUAL_ADJUDICATION_COMMITMENT_MISMATCH",
        "Visual adjudication rendered-page commitment has wrong source geometry.",
        { page_index: page.index },
      );
    }
    const tolerance = Math.max(0.01, source.height * 1e-6);
    let coveredTo = 0;
    for (const [tilePosition, tile] of page.tiles.entries()) {
      assertExactObjectKeys(
        tile,
        ["index", "bbox", "width", "height", "media_type", "image_sha256"],
        `visual_adjudication.input_commitment.rendered_pages[${pagePosition}].tiles[${tilePosition}]`,
      );
      const bbox = Array.isArray(tile.bbox) && tile.bbox.length === 4
        ? tile.bbox.map(Number)
        : [];
      const [x0, y0, x1, y1] = bbox;
      if (
        tile.index !== tilePosition || bbox.length !== 4 ||
        bbox.some((value) => !Number.isFinite(value)) ||
        !Number.isInteger(tile.width) || tile.width < 1 ||
        !Number.isInteger(tile.height) || tile.height < 1 ||
        tile.media_type !== "image/png" ||
        !/^[a-f0-9]{64}$/.test(String(tile.image_sha256 || "")) ||
        x0 < -tolerance || y0 < -tolerance ||
        x1 > source.width + tolerance || y1 > source.height + tolerance ||
        x1 <= x0 || y1 <= y0 || Math.abs(x0) > tolerance ||
        Math.abs(x1 - source.width) > tolerance || y0 > coveredTo + tolerance ||
        y1 <= coveredTo + tolerance / 10
      ) {
        fail(
          "OCR_VISUAL_ADJUDICATION_COMMITMENT_INVALID",
          "Visual adjudication tile commitment is malformed or does not continuously cover its page.",
          { page_index: page.index, tile_index: tilePosition },
        );
      }
      const bboxAspect = (x1 - x0) / (y1 - y0);
      const pixelAspect = tile.width / tile.height;
      const aspectError = Math.abs(pixelAspect - bboxAspect) / bboxAspect;
      if (!Number.isFinite(aspectError) || aspectError > 0.05) {
        fail(
          "OCR_VISUAL_ADJUDICATION_COMMITMENT_INVALID",
          "Visual adjudication tile commitment has inconsistent pixel geometry.",
          { page_index: page.index, tile_index: tilePosition },
        );
      }
      coveredTo = Math.max(coveredTo, y1);
    }
    if (coveredTo < source.height - tolerance) {
      fail(
        "OCR_VISUAL_ADJUDICATION_COMMITMENT_INVALID",
        "Visual adjudication tile commitment does not reach the bottom of its page.",
        { page_index: page.index },
      );
    }
  }
  if (inputDigest !== evidenceDigest(commitment)) {
    fail(
      "OCR_VISUAL_ADJUDICATION_INPUT_MISMATCH",
      "Visual adjudication input_digest does not match its canonical input commitment.",
    );
  }
  return commitment;
}

function validateVisualRenderAttestationShape(proof, inputDigest, inputCommitment, adjudicator) {
  assertExactObjectKeys(
    proof,
    [
      "schema_version",
      "proof_type",
      "source_pdf_sha256",
      "input_digest",
      "adjudicator_identity_sha256",
      "rendered_page_count",
      "rendered_tile_count",
      "binding_hmac_sha256",
    ],
    "visual_adjudication.render_attestation",
  );
  const renderedPages = inputCommitment.rendered_pages;
  const expectedTileCount = renderedPages.reduce(
    (count, page) => count + page.tiles.length,
    0,
  );
  const expectedAdjudicatorDigest = evidenceDigest({
    provider: String(adjudicator?.provider || "").trim(),
    model: String(adjudicator?.model || "").trim(),
    request_id: String(adjudicator?.request_id || "").trim(),
  });
  if (
    proof.schema_version !== 2 ||
    proof.proof_type !== "ocr-visual-source-render-attestation" ||
    proof.source_pdf_sha256 !== inputCommitment.source_pdf_sha256 ||
    proof.input_digest !== inputDigest ||
    proof.adjudicator_identity_sha256 !== expectedAdjudicatorDigest ||
    proof.rendered_page_count !== renderedPages.length ||
    proof.rendered_tile_count !== expectedTileCount ||
    !/^[a-f0-9]{64}$/.test(String(proof.binding_hmac_sha256 || ""))
  ) {
    fail(
      "OCR_VISUAL_RENDER_ATTESTATION_INVALID",
      "Visual adjudication render attestation metadata is invalid.",
    );
  }
  return proof;
}

function validateVisualAdjudication(result, evidence) {
  const lowTokens = evidence.risk_tokens
    .filter((token) => token.needs_visual_adjudication)
    .map((token) => token.token_sha256)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();
  if (!result || typeof result !== "object" || result.verdict !== "pass") {
    fail("OCR_VISUAL_ADJUDICATION_FAILED", "Visual adjudication did not pass.", {
      evidence_sha256: evidence.evidence_sha256,
      low_confidence_token_hashes: lowTokens,
    });
  }
  const resultKeys = [
      "verdict",
      "provider",
      "model",
      "request_id",
      "input_digest",
      "input_commitment",
      "render_attestation",
      "token_hashes",
    ];
  assertExactObjectKeys(
    result,
    resultKeys,
    "visual_adjudication",
  );
  const provider = requireNonEmptyString(result.provider, "visual_adjudication.provider");
  const model = requireNonEmptyString(result.model, "visual_adjudication.model");
  const requestId = requireNonEmptyString(result.request_id, "visual_adjudication.request_id");
  const inputDigest = String(result.input_digest || "");
  if (!/^[a-f0-9]{64}$/.test(inputDigest)) {
    fail(
      "OCR_VISUAL_ADJUDICATION_INPUT_INVALID",
      "Visual adjudication input_digest must be a canonical SHA-256 digest.",
    );
  }
  const inputCommitment = validateVisualInputCommitment(
    result.input_commitment,
    inputDigest,
    evidence,
  );
  const renderAttestation = validateVisualRenderAttestationShape(
    result.render_attestation,
    inputDigest,
    inputCommitment,
    result,
  );
  const covered = Array.isArray(result.token_hashes)
    ? [...new Set(result.token_hashes.map(String))].sort()
    : [];
  if (covered.length !== lowTokens.length || covered.some((value, index) => value !== lowTokens[index])) {
    fail(
      "OCR_VISUAL_ADJUDICATION_INCOMPLETE",
      "Visual adjudication did not cover every low-confidence risky token.",
      {
        evidence_sha256: evidence.evidence_sha256,
        expected_token_hashes: lowTokens,
        covered_token_hashes: covered,
      },
    );
  }
  return {
    verdict: "pass",
    provider,
    model,
    request_id: requestId,
    input_digest: inputDigest,
    input_commitment: inputCommitment,
    token_hashes: covered,
    render_attestation: renderAttestation,
  };
}

// Fail-closed OCR evidence API.  Unlike the compatibility wrapper, this never
// returns null and never silently falls back to a vision-only transcription.
async function ocrPdfToEvidenceStrict(pdfBuffer, options = {}) {
  const apiKey = options.apiKey != null ? options.apiKey : mistralKey();
  assertStrictInput(pdfBuffer, { apiKey, strict: true });
  const { json, headers } = await requestOcr(pdfBuffer, { ...options, apiKey });
  const evidence = buildCanonicalOcrEvidence(json, {
    ...options,
    sourcePdf: pdfBuffer,
    responseHeaders: headers,
    requireHeaderRequestId: true,
  });
  if (evidence.needs_visual_adjudication) {
    if (typeof options.visualAdjudicator !== "function") {
      const summary = summarizeOcrEvidence(evidence);
      fail(
        "OCR_VISUAL_ADJUDICATION_REQUIRED",
        "Low-confidence numbers, units, URLs, or formulae require visual adjudication.",
        {
          evidence_sha256: evidence.evidence_sha256,
          low_confidence_risks: summary.risk_tokens.filter(
            (token) => token.needs_visual_adjudication,
          ),
        },
      );
    }
    let result;
    try {
      result = await options.visualAdjudicator(summarizeOcrEvidence(evidence), evidence);
    } catch (error) {
      fail("OCR_VISUAL_ADJUDICATION_ERROR", "Visual adjudication could not be completed.", {
        evidence_sha256: evidence.evidence_sha256,
        cause_code: typeof error?.code === "string" ? error.code : null,
      });
    }
    evidence.visual_adjudication = validateVisualAdjudication(result, evidence);
    const { evidence_sha256: previousDigest, ...unsignedEvidence } = evidence;
    void previousDigest;
    evidence.evidence_sha256 = evidenceDigest(unsignedEvidence);
  }
  return evidence;
}

// Compatibility wrapper: PDF buffer -> [{ page, text }], one-based page.
// Missing configuration/oversize remains a best-effort null so the existing
// server route can use its legacy image-vision fallback.  This wrapper is not
// sufficient provenance for a strict retypeset operation.
async function ocrPdfToPageTexts(pdfBuffer, options = {}) {
  const apiKey = options.apiKey != null ? options.apiKey : mistralKey();
  if (!assertStrictInput(pdfBuffer, { apiKey, strict: false })) return null;
  const { json } = await requestOcr(pdfBuffer, {
    ...options,
    apiKey,
    requireRequestId: false,
  });
  const pages = Array.isArray(json.pages) ? json.pages : [];
  const out = [];
  for (const pageValue of pages) {
    const index = Number(
      pageValue && (pageValue.index != null
        ? pageValue.index
        : pageValue.page_number != null
          ? pageValue.page_number
          : Number.NaN),
    );
    const blockText = Array.isArray(pageValue && pageValue.blocks)
      ? pageValue.blocks
          .map((block) => String((block && (block.content || block.text || block.markdown)) || "").trim())
          .filter(Boolean)
          .join("\n\n")
      : "";
    const text = String(
      (pageValue && (pageValue.markdown != null ? pageValue.markdown : pageValue.text)) || blockText,
    ).trim();
    if (!text) continue;
    const page = Number.isFinite(index)
      ? pageValue.index != null
        ? index + 1
        : index
      : out.length + 1;
    out.push({ page, text });
  }
  return out.length ? out : null;
}

module.exports = {
  DEFAULT_ASPECT_RATIO_TOLERANCE,
  DEFAULT_RISK_CONFIDENCE_THRESHOLD,
  INLINE_MAX_MB,
  MAX_MB,
  OCR_EVIDENCE_SCHEMA_VERSION,
  OcrEvidenceValidationError,
  buildCanonicalOcrEvidence,
  // Alias kept explicit for callers that use validation terminology.
  validateStrictOcrResponse: buildCanonicalOcrEvidence,
  mistralOcrConfigured,
  ocrPdfToEvidenceStrict,
  ocrPdfToPageTexts,
  summarizeOcrEvidence,
  validateCanonicalOcrEvidence,
};
