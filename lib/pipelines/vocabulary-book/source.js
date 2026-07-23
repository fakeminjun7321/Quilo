"use strict";

const path = require("path");
const { parseToTables } = require("../../excel-parser");
const { extractPdfText } = require("./extract");

const SPREADSHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);
const TEXT_EXTENSIONS = new Set(["txt", "md"]);
const ALLOWED_EXTENSIONS = new Set(["pdf", ...SPREADSHEET_EXTENSIONS, ...TEXT_EXTENSIONS]);
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const ROWS_PER_SOURCE_UNIT = 60;
const CHARS_PER_SOURCE_UNIT = 7000;

function extensionOf(name) {
  return path.extname(String(name || "")).slice(1).toLowerCase();
}

function cleanFilename(name) {
  return path.basename(String(name || "영어 자료")).replace(/[\u0000-\u001f]/g, "").slice(0, 220);
}

function decodeText(buffer) {
  const utf8 = buffer.toString("utf8");
  const replacementCount = (utf8.match(/\uFFFD/g) || []).length;
  if (replacementCount <= Math.max(2, utf8.length * 0.002)) return utf8;
  try {
    return new TextDecoder("euc-kr", { fatal: false }).decode(buffer);
  } catch (_) {
    return utf8;
  }
}

function compactSourceText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function splitText(text, maxChars = CHARS_PER_SOURCE_UNIT) {
  const paragraphs = compactSourceText(text).split(/\n{2,}/).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      if (current) chunks.push(current);
      current = "";
      for (let index = 0; index < paragraph.length; index += maxChars) {
        chunks.push(paragraph.slice(index, index + maxChars));
      }
      continue;
    }
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function spreadsheetPages(buffer, ext) {
  const parsed = parseToTables(buffer, ext);
  const pages = [];
  for (const table of parsed.tables) {
    for (let start = 0; start < table.rows.length || (start === 0 && !table.rows.length); start += ROWS_PER_SOURCE_UNIT) {
      const rows = table.rows.slice(start, start + ROWS_PER_SOURCE_UNIT);
      const firstRow = start + 2;
      const lastRow = start + rows.length + 1;
      const header = table.headers.map((value, index) => value || `열 ${index + 1}`).join("\t");
      const body = rows.map((row, index) => `${firstRow + index}행\t${row.join("\t")}`).join("\n");
      const range = rows.length ? `${firstRow}-${lastRow}행` : "머리글";
      pages.push({
        number: pages.length + 1,
        label: `${table.sheetName} · ${range}`,
        text: compactSourceText(`${header}\n${body}`),
      });
    }
  }
  if (!pages.length || !pages.some((page) => page.text)) {
    throw new Error("엑셀/CSV 파일에서 영어 단어나 문장을 찾지 못했습니다.");
  }
  return {
    kind: "spreadsheet",
    pages,
    total_units: pages.length,
    warnings: parsed.truncated ? ["안전 한도를 넘는 시트·행은 제외했습니다."] : [],
  };
}

async function extractVocabularySource(file, { pageRange = "", maxPages = 80, signal } = {}) {
  if (!file || !Buffer.isBuffer(file.buffer)) throw new Error("영어 자료 파일을 올리세요.");
  const name = cleanFilename(file.name);
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("영어 자료는 PDF, Excel(.xlsx/.xls), CSV, TXT, Markdown 파일만 가능합니다.");
  }

  if (ext === "pdf") {
    const extracted = await extractPdfText(file.buffer, { pageRange, maxPages, signal });
    return {
      ...extracted,
      kind: "pdf",
      pages: extracted.pages.map((page) => ({ ...page, label: `PDF ${page.number}쪽` })),
      total_units: extracted.page_count,
      source_line: `${name} · PDF ${extracted.selected_pages[0]}-${extracted.selected_pages.at(-1)}쪽`,
      warnings: [],
    };
  }

  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    const parsed = spreadsheetPages(file.buffer, ext);
    return {
      ...parsed,
      selected_pages: parsed.pages.map((page) => page.number),
      source_line: `${name} · 표 출처 ${parsed.pages.length}개`,
      title: name.replace(/\.[^.]+$/, ""),
    };
  }

  if (file.buffer.length > MAX_TEXT_BYTES) {
    throw new Error("텍스트 단어장은 10MB 이하 파일만 가능합니다.");
  }
  const chunks = splitText(decodeText(file.buffer));
  if (!chunks.length) throw new Error("텍스트 파일에서 영어 단어나 문장을 찾지 못했습니다.");
  const pages = chunks.map((text, index) => ({ number: index + 1, label: `텍스트 ${index + 1}구간`, text }));
  return {
    kind: "text",
    pages,
    total_units: pages.length,
    selected_pages: pages.map((page) => page.number),
    source_line: `${name} · 텍스트 ${pages.length}구간`,
    title: name.replace(/\.[^.]+$/, ""),
    warnings: [],
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  extensionOf,
  decodeText,
  splitText,
  spreadsheetPages,
  extractVocabularySource,
};
