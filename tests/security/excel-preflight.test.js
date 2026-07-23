const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");

test("XLSX preflight rejects oversized sheet XML before workbook parse", async () => {
  process.env.XLSX_MAX_SHEET_XML_MB = "0";
  delete require.cache[require.resolve("../../lib/excel-parser")];
  const { preflightSpreadsheet } = require("../../lib/excel-parser");

  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/worksheets/sheet1.xml", "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>");
  const buf = await zip.generateAsync({ type: "nodebuffer" });

  assert.throws(() => preflightSpreadsheet(buf, "xlsx"), /XLSX 파일이 너무 큽니다/);
});
