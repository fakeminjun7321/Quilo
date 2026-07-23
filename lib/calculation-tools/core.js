"use strict";

const { latexToUnicode } = require("../latex-to-unicode");
const { parseToTables } = require("../excel-parser");
const { describe } = require("./statistics");

function wordCount(input) {
  const text = String(input ?? "");
  return {
    characters: Array.from(text).length,
    charactersNoWhitespace: Array.from(text.replace(/\s/g, "")).length,
    words: (text.trim().match(/\S+/g) || []).length,
    lines: text ? text.split(/\r\n|\r|\n/).length : 0,
    paragraphs: text.trim() ? text.trim().split(/(?:\r?\n){2,}/).filter((part) => part.trim()).length : 0,
    bytesUtf8: Buffer.byteLength(text, "utf8"),
  };
}

function equationToUnicode(expression) {
  const source = String(expression || "").trim();
  if (!source) throw new Error("변환할 수식이 필요합니다.");
  if (source.length > 20000) throw new Error("수식은 20,000자 이하만 지원합니다.");
  return { source, format: "unicode", result: latexToUnicode(source) };
}

function numericColumn(headers, rows, index) {
  const values = [];
  let nonEmpty = 0;
  for (const row of rows) {
    const raw = String(row[index] ?? "").trim().replace(/,/g, "");
    if (!raw) continue;
    nonEmpty++;
    const value = Number(raw);
    if (Number.isFinite(value)) values.push(value);
  }
  if (!nonEmpty || values.length / nonEmpty < 0.8) return null;
  return { name: headers[index] || `열 ${index + 1}`, index, validValues: values.length, missingOrInvalid: rows.length - values.length, statistics: describe(values) };
}

function analyzeTableFile(buffer, filename) {
  const extension = String(filename || "").split(".").pop().toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(extension)) throw new Error("CSV, XLSX 또는 XLS 파일만 지원합니다.");
  const parsed = parseToTables(buffer, extension);
  return {
    sheetCount: parsed.sheetCount,
    totalRows: parsed.totalRows,
    truncated: parsed.truncated,
    sheets: parsed.tables.map((table) => ({
      name: table.sheetName,
      headers: table.headers,
      rowCount: table.rowCount,
      columnCount: table.colCount,
      preview: table.rows.slice(0, 100),
      previewTruncated: table.rows.length > 100,
      numericColumns: table.headers.map((_, index) => numericColumn(table.headers, table.rows, index)).filter(Boolean),
    })),
  };
}

module.exports = { analyzeTableFile, equationToUnicode, wordCount };
