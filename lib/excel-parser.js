// 엑셀(.xlsx, .xls) / CSV 파일을 읽어서 Claude에게 전달할 텍스트(markdown table)로 변환.
// 통계 계산은 Claude가 프롬프트에 따라 처리 (스킬 명세에 평균·표준편차·백분율 오차 규칙 명시됨).
//
// 보안 주의: xlsx 패키지에 prototype pollution 경고가 있으나,
// 우리는 sheet_to_json만 사용하고 결과는 단순 2D array로 처리하므로 영향 없음.

const XLSX = require("xlsx");

// 안전 한도 — 메모리·토큰 보호 (실험 데이터로 1만 행 이상은 비현실적)
const MAX_ROWS_PER_SHEET = 10000;
const MAX_SHEETS = 20;

/**
 * 파일 버퍼와 확장자를 받아 markdown table 문자열로 변환.
 *
 * @param {Buffer} buffer
 * @param {string} ext   "xlsx" | "xls" | "csv"
 * @returns {{ text: string, sheetCount: number, totalRows: number, truncated: boolean }}
 */
function parseToMarkdown(buffer, ext) {
  let workbook;
  try {
    if (ext === "csv") {
      // CSV는 string으로 읽어서 처리
      const text = buffer.toString("utf8");
      workbook = XLSX.read(text, { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (e) {
    throw new Error(`엑셀/CSV 파싱 실패: ${e.message}`);
  }

  const allSheets = workbook.SheetNames || [];
  const sheets = allSheets.slice(0, MAX_SHEETS);
  const truncatedSheets = allSheets.length > MAX_SHEETS;
  let combinedText = "";
  let totalRows = 0;
  let truncatedRows = false;

  for (const sheetName of sheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // 2D array로 변환 (header 옵션 1 = raw rows)
    const allRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });
    const rows = allRows.slice(0, MAX_ROWS_PER_SHEET);
    if (allRows.length > MAX_ROWS_PER_SHEET) truncatedRows = true;

    if (rows.length === 0) continue;

    totalRows += rows.length;

    // 시트가 여러 개면 시트명 표시
    if (sheets.length > 1) {
      combinedText += `\n## 시트: ${sheetName}\n\n`;
    }

    // 첫 행을 헤더로 가정. 컬럼 수가 들쭉날쭉하면 max로 맞춤
    // (행 수는 MAX_ROWS_PER_SHEET 제한이므로 spread 사용 안전)
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const padRow = (r) =>
      Array.from({ length: maxCols }, (_, i) =>
        r[i] !== undefined && r[i] !== null ? String(r[i]) : "",
      );

    const headerCells = padRow(rows[0]);
    combinedText += "| " + headerCells.join(" | ") + " |\n";
    combinedText += "|" + headerCells.map(() => "---").join("|") + "|\n";

    for (let i = 1; i < rows.length; i++) {
      combinedText += "| " + padRow(rows[i]).join(" | ") + " |\n";
    }
    if (allRows.length > MAX_ROWS_PER_SHEET) {
      combinedText += `\n_(이 시트는 ${MAX_ROWS_PER_SHEET}행으로 잘림 — 원본 ${allRows.length}행)_\n`;
    }
    combinedText += "\n";
  }

  if (!combinedText.trim()) {
    throw new Error("엑셀/CSV 파일에 데이터가 없습니다.");
  }

  return {
    text: combinedText.trim(),
    sheetCount: sheets.length,
    totalRows,
    truncated: truncatedSheets || truncatedRows,
  };
}

/**
 * 파일 버퍼와 확장자를 받아 시트별 2D 표 구조로 변환.
 * Claude에 넘기는 markdown과 별개로, 서버가 물리 결과보고서의
 * 데이터 역할/충돌을 판별할 때 사용한다.
 *
 * @param {Buffer} buffer
 * @param {string} ext   "xlsx" | "xls" | "csv"
 * @returns {{ tables: Array<{ sheetName: string, headers: string[], rows: string[][], rowCount: number, colCount: number }>, sheetCount: number, totalRows: number, truncated: boolean }}
 */
function parseToTables(buffer, ext) {
  let workbook;
  try {
    if (ext === "csv") {
      workbook = XLSX.read(buffer.toString("utf8"), { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (e) {
    throw new Error(`엑셀/CSV 파싱 실패: ${e.message}`);
  }

  const allSheets = workbook.SheetNames || [];
  const sheets = allSheets.slice(0, MAX_SHEETS);
  const tables = [];
  let totalRows = 0;
  let truncatedRows = false;

  for (const sheetName of sheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    const allRows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      blankrows: false,
      raw: false,
    });
    const rows = allRows.slice(0, MAX_ROWS_PER_SHEET);
    if (allRows.length > MAX_ROWS_PER_SHEET) truncatedRows = true;
    if (rows.length === 0) continue;

    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const padRow = (r) =>
      Array.from({ length: maxCols }, (_, i) =>
        r[i] !== undefined && r[i] !== null ? String(r[i]) : "",
      );

    const headers = padRow(rows[0]).map((v) => String(v || "").trim());
    const bodyRows = rows.slice(1).map((r) => padRow(r).map((v) => String(v || "").trim()));
    tables.push({
      sheetName,
      headers,
      rows: bodyRows,
      rowCount: rows.length,
      colCount: maxCols,
    });
    totalRows += rows.length;
  }

  return {
    tables,
    sheetCount: sheets.length,
    totalRows,
    truncated: allSheets.length > MAX_SHEETS || truncatedRows,
  };
}

module.exports = { parseToMarkdown, parseToTables };
