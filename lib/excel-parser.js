// 엑셀(.xlsx, .xls) / CSV 파일을 읽어서 Claude에게 전달할 텍스트(markdown table)로 변환.
// 통계 계산은 Claude가 프롬프트에 따라 처리 (스킬 명세에 평균·표준편차·백분율 오차 규칙 명시됨).
//
// 보안 주의: xlsx 패키지에 prototype pollution 경고가 있으나,
// 우리는 sheet_to_json만 사용하고 결과는 단순 2D array로 처리하므로 영향 없음.

const XLSX = require("xlsx");
const {
  inspectZipArchive,
  inspectActualEntryBytes,
} = require("./zip-resource-limits");

// 안전 한도 — 메모리·토큰 보호 (실험 데이터로 1만 행 이상은 비현실적)
// xlsx 패키지는 read() 시 workbook 전체를 메모리에 올리므로, 거대한
// workbook(시트·행·열·셀 폭주)은 CPU/메모리 DoS 위험이 있다. 아래 상한으로
// 시트별 행·열을 잘라 읽고(범위 옵션), 전체 셀 합계에도 예산을 두어
// sheet_to_json/padRow 단계에서 거대한 배열이 만들어지지 않도록 막는다.
// 초과분은 잘라내고(truncated=true), 정상 크기 파일은 동작이 동일하다.
const MAX_ROWS_PER_SHEET = 10000;
const MAX_COLS_PER_SHEET = 1000;
const MAX_SHEETS = 20;
// 전체 시트를 합친 셀(행×열) 총량 상한. 정상 실험 데이터는 한참 아래.
const MAX_TOTAL_CELLS = 2000000; // 200만 셀 (예: 1만 행 × 200열 × 1시트)
const MAX_XLSX_ENTRIES = parseInt(process.env.XLSX_MAX_ENTRIES || "400", 10);
const MAX_XLSX_COMPRESSED_BYTES =
  parseInt(process.env.XLSX_MAX_FILE_MB || "64", 10) * 1024 * 1024;
const MAX_XLSX_UNCOMPRESSED_BYTES =
  parseInt(process.env.XLSX_MAX_UNCOMPRESSED_MB || "120", 10) * 1024 * 1024;
const MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES =
  parseInt(process.env.XLSX_MAX_ENTRY_MB || "40", 10) * 1024 * 1024;
const MAX_XLSX_SHEET_XML_BYTES =
  parseInt(process.env.XLSX_MAX_SHEET_XML_MB || "30", 10) * 1024 * 1024;
const MAX_XLSX_SHARED_STRINGS_BYTES =
  parseInt(process.env.XLSX_MAX_SHARED_STRINGS_MB || "30", 10) * 1024 * 1024;
const MAX_XLSX_COMPRESSION_RATIO = parseInt(
  process.env.XLSX_MAX_COMPRESSION_RATIO || "200",
  10,
);
const MAX_XLSX_RATIO_MIN_BYTES = parseInt(
  process.env.XLSX_RATIO_MIN_BYTES || String(1024 * 1024),
  10,
);
const MAX_XLS_BINARY_BYTES =
  parseInt(process.env.XLS_MAX_FILE_MB || "40", 10) * 1024 * 1024;

function spreadsheetError(message, code = "SPREADSHEET_UNSAFE_INPUT") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function preflightSpreadsheet(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw spreadsheetError("스프레드시트 파일이 비어 있거나 올바른 버퍼가 아닙니다.");
  }
  const lower = String(ext || "").toLowerCase();
  if (lower === "csv") {
    if (buffer.length > MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES) {
      throw spreadsheetError("CSV 파일이 너무 큽니다. 파일을 나눠서 업로드하세요.");
    }
    return;
  }
  if (lower === "xls") {
    if (buffer.length > MAX_XLS_BINARY_BYTES) {
      throw spreadsheetError("XLS 파일이 너무 큽니다. 파일을 나눠서 업로드하세요.");
    }
    const oleMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    if (buffer.length < oleMagic.length || !buffer.subarray(0, 8).equals(oleMagic)) {
      throw spreadsheetError("XLS 파일 구조가 올바르지 않습니다.");
    }
    return;
  }
  if (lower !== "xlsx") {
    throw spreadsheetError("지원하지 않는 스프레드시트 형식입니다. .xlsx, .xls, .csv만 가능합니다.");
  }
  if (buffer.length > MAX_XLSX_COMPRESSED_BYTES) {
    throw spreadsheetError("XLSX 파일이 너무 큽니다. 파일을 나눠서 업로드하세요.");
  }

  let inspected;
  try {
    inspected = inspectZipArchive(buffer, {
      maxEntries: MAX_XLSX_ENTRIES,
      maxEntryUncompressedBytes: MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES,
      maxTotalUncompressedBytes: MAX_XLSX_UNCOMPRESSED_BYTES,
      maxCompressionRatio: MAX_XLSX_COMPRESSION_RATIO,
      ratioMinOutputBytes: MAX_XLSX_RATIO_MIN_BYTES,
    });
  } catch (error) {
    const suffix = error && error.message ? `: ${error.message}` : "";
    throw spreadsheetError(`XLSX 파일 구조가 안전하지 않습니다${suffix}`);
  }
  let actualTotal = 0;
  for (const entry of inspected.entries) {
    let actualBytes;
    try {
      actualBytes = inspectActualEntryBytes(buffer, entry, {
        maxEntryUncompressedBytes: MAX_XLSX_ENTRY_UNCOMPRESSED_BYTES,
        maxCompressionRatio: MAX_XLSX_COMPRESSION_RATIO,
        ratioMinOutputBytes: MAX_XLSX_RATIO_MIN_BYTES,
      });
    } catch (error) {
      const suffix = error && error.message ? `: ${error.message}` : "";
      throw spreadsheetError(`XLSX 파일 구조가 안전하지 않습니다${suffix}`);
    }
    actualTotal += actualBytes;
    if (actualTotal > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw spreadsheetError("XLSX 파일이 너무 큽니다. 시트/문자열 수를 줄여 업로드하세요.");
    }
    if (
      (/^xl\/worksheets\/.*\.xml$/i.test(entry.name) &&
        actualBytes > MAX_XLSX_SHEET_XML_BYTES) ||
      (/^xl\/sharedStrings\.xml$/i.test(entry.name) &&
        actualBytes > MAX_XLSX_SHARED_STRINGS_BYTES)
    ) {
      throw spreadsheetError("XLSX 파일이 너무 큽니다. 시트/문자열 수를 줄여 업로드하세요.");
    }
  }
  const entryNames = new Set(inspected.entries.map((entry) => entry.name));
  if (!entryNames.has("[Content_Types].xml") || !entryNames.has("xl/workbook.xml")) {
    throw spreadsheetError("XLSX 파일에 필수 workbook 항목이 없습니다.");
  }
}

/**
 * 시트를 안전 한도 안에서만 2D array로 읽는다.
 * - `!ref`로 시트 차원을 미리 파악해 행/열을 잘라 읽으므로(range 옵션)
 *   거대한 시트도 제한된 크기의 배열만 메모리에 올린다.
 * - `budget.remaining` 셀 예산을 소진하면 더 이상 읽지 않는다.
 *
 * @param {object} sheet      XLSX worksheet
 * @param {{ remaining: number }} budget  남은 전체 셀 예산 (in/out)
 * @returns {{ rows: string[][], truncated: boolean }}
 */
function readBoundedRows(sheet, budget) {
  let truncated = false;

  // 시트 차원을 미리 읽어(셀 순회 없이) 행/열 상한으로 클램프한다.
  let readRange = null;
  const ref = sheet["!ref"];
  if (typeof ref === "string" && ref) {
    let dim;
    try {
      dim = XLSX.utils.decode_range(ref);
    } catch (_e) {
      dim = null;
    }
    if (dim && dim.s && dim.e) {
      const startR = dim.s.r;
      const startC = dim.s.c;
      const fullRows = dim.e.r - startR + 1;
      const fullCols = dim.e.c - startC + 1;

      let rowCap = Math.min(fullRows, MAX_ROWS_PER_SHEET);
      let colCap = Math.min(fullCols, MAX_COLS_PER_SHEET);
      if (rowCap < fullRows || colCap < fullCols) truncated = true;

      // 전체 셀 예산을 넘지 않도록 행 수를 추가로 줄인다.
      if (budget && Number.isFinite(budget.remaining)) {
        if (budget.remaining <= 0 || colCap <= 0) {
          return { rows: [], truncated: true };
        }
        const maxRowsByBudget = Math.floor(budget.remaining / colCap);
        if (maxRowsByBudget < rowCap) {
          rowCap = Math.max(0, maxRowsByBudget);
          truncated = true;
        }
      }

      if (rowCap <= 0 || colCap <= 0) {
        return { rows: [], truncated: true };
      }

      readRange = XLSX.utils.encode_range({
        s: { r: startR, c: startC },
        e: { r: startR + rowCap - 1, c: startC + colCap - 1 },
      });
    }
  }

  const opts = {
    header: 1,
    defval: "",
    blankrows: false,
    raw: false,
  };
  if (readRange) opts.range = readRange;

  let rows = XLSX.utils.sheet_to_json(sheet, opts);

  // blankrows:false로 빈 행이 빠지면 실제 행 수는 readRange보다 적을 수 있다.
  // 안전망으로 한 번 더 행/열을 잘라준다(`!ref`가 없는 시트 포함).
  if (rows.length > MAX_ROWS_PER_SHEET) {
    rows = rows.slice(0, MAX_ROWS_PER_SHEET);
    truncated = true;
  }
  let colClamped = false;
  rows = rows.map((r) => {
    if (Array.isArray(r) && r.length > MAX_COLS_PER_SHEET) {
      colClamped = true;
      return r.slice(0, MAX_COLS_PER_SHEET);
    }
    return r;
  });
  if (colClamped) truncated = true;

  // 전체 셀 예산 차감 (행 × 최대 열 폭 기준).
  if (budget && Number.isFinite(budget.remaining)) {
    const maxCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
    budget.remaining -= rows.length * maxCols;
  }

  return { rows, truncated };
}

/**
 * 파일 버퍼와 확장자를 받아 markdown table 문자열로 변환.
 *
 * @param {Buffer} buffer
 * @param {string} ext   "xlsx" | "xls" | "csv"
 * @returns {{ text: string, sheetCount: number, totalRows: number, truncated: boolean }}
 */
function readWorkbook(buffer, ext) {
  let workbook;
  const normalizedExt = String(ext || "").toLowerCase();
  try {
    preflightSpreadsheet(buffer, normalizedExt);
    if (normalizedExt === "csv") {
      // CSV는 string으로 읽어서 처리
      const text = buffer.toString("utf8");
      workbook = XLSX.read(text, { type: "string" });
    } else {
      workbook = XLSX.read(buffer, { type: "buffer" });
    }
  } catch (e) {
    const error = new Error(`엑셀/CSV 파싱 실패: ${e.message}`);
    error.code = e.code || "SPREADSHEET_PARSE_FAILED";
    throw error;
  }
  return workbook;
}

function rowPadder(rows) {
  const maxCols = rows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    maxCols,
    padRow: (row) =>
      Array.from({ length: maxCols }, (_, index) =>
        row[index] !== undefined && row[index] !== null ? String(row[index]) : "",
      ),
  };
}

/**
 * workbook은 한 번만 열고 각 시트도 한 번만 2D 배열로 변환해, Claude용
 * Markdown과 서버 보정용 구조화 표를 함께 만든다. 물리 결과보고서처럼 두 표현을
 * 모두 쓰는 호출자는 이 함수를 사용해 같은 업로드를 두 번 전체 파싱하지 않는다.
 */
function parseSpreadsheet(buffer, ext) {
  const workbook = readWorkbook(buffer, ext);

  const allSheets = workbook.SheetNames || [];
  const sheets = allSheets.slice(0, MAX_SHEETS);
  const truncatedSheets = allSheets.length > MAX_SHEETS;
  let combinedText = "";
  let totalRows = 0;
  let truncatedRows = false;
  const budget = { remaining: MAX_TOTAL_CELLS };
  const tables = [];

  for (const sheetName of sheets) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    // 안전 한도 안에서만 2D array로 변환 (header 옵션 1 = raw rows)
    const bounded = readBoundedRows(sheet, budget);
    const rows = bounded.rows;
    if (bounded.truncated) truncatedRows = true;

    if (rows.length === 0) continue;

    totalRows += rows.length;

    // 시트가 여러 개면 시트명 표시
    if (sheets.length > 1) {
      combinedText += `\n## 시트: ${sheetName}\n\n`;
    }

    // 첫 행을 헤더로 가정. 컬럼 수가 들쭉날쭉하면 max로 맞춤
    // (행/열 모두 상한이 걸려 있으므로 spread/Array.from 사용 안전)
    const { maxCols, padRow } = rowPadder(rows);

    const headerCells = padRow(rows[0]);
    combinedText += "| " + headerCells.join(" | ") + " |\n";
    combinedText += "|" + headerCells.map(() => "---").join("|") + "|\n";

    for (let i = 1; i < rows.length; i++) {
      combinedText += "| " + padRow(rows[i]).join(" | ") + " |\n";
    }
    if (bounded.truncated) {
      combinedText += `\n_(이 시트는 안전 한도로 잘림 — 최대 ${MAX_ROWS_PER_SHEET}행 × ${MAX_COLS_PER_SHEET}열)_\n`;
    }
    combinedText += "\n";

    tables.push({
      sheetName,
      headers: headerCells.map((value) => String(value || "").trim()),
      rows: rows
        .slice(1)
        .map((row) => padRow(row).map((value) => String(value || "").trim())),
      rowCount: rows.length,
      colCount: maxCols,
    });
  }

  if (!combinedText.trim()) {
    throw new Error("엑셀/CSV 파일에 데이터가 없습니다.");
  }

  return {
    text: combinedText.trim(),
    sheetCount: sheets.length,
    totalRows,
    truncated: truncatedSheets || truncatedRows,
    tables,
  };
}

function parseToMarkdown(buffer, ext) {
  const parsed = parseSpreadsheet(buffer, ext);
  return {
    text: parsed.text,
    sheetCount: parsed.sheetCount,
    totalRows: parsed.totalRows,
    truncated: parsed.truncated,
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
  const parsed = parseSpreadsheet(buffer, ext);
  return {
    tables: parsed.tables,
    sheetCount: parsed.sheetCount,
    totalRows: parsed.totalRows,
    truncated: parsed.truncated,
  };
}

module.exports = {
  parseSpreadsheet,
  parseToMarkdown,
  parseToTables,
  preflightSpreadsheet,
};
