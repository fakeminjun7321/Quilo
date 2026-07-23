const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const XLSX = require("xlsx");

const {
  parseSpreadsheet,
  preflightSpreadsheet,
} = require("../../lib/excel-parser");
const styleRef = require("../../lib/style-ref");
const {
  inspectZipArchive,
  inspectActualEntryBytes,
} = require("../../lib/zip-resource-limits");

function centralDirectoryOffset(buffer) {
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 0xffff - 22); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return buffer.readUInt32LE(offset + 16);
  }
  throw new Error("EOCD not found");
}

function forgeDeclaredSize(buffer, targetName, declaredSize) {
  const forged = Buffer.from(buffer);
  let offset = centralDirectoryOffset(forged);
  while (offset + 46 <= forged.length && forged.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = forged.readUInt16LE(offset + 28);
    const extraLength = forged.readUInt16LE(offset + 30);
    const commentLength = forged.readUInt16LE(offset + 32);
    const name = forged.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === targetName) {
      const localOffset = forged.readUInt32LE(offset + 42);
      forged.writeUInt32LE(declaredSize, offset + 24);
      forged.writeUInt32LE(declaredSize, localOffset + 22);
      return forged;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`entry not found: ${targetName}`);
}

async function makeMinimalHwpx(text = "안녕하세요. 문체 예시입니다.") {
  const zip = new JSZip();
  zip.file(
    "Contents/header.xml",
    '<hh:head><hh:font id="0" face="함초롬바탕"/><hh:charPr id="1" height="1000"><hh:fontRef hangul="0"/></hh:charPr></hh:head>',
  );
  zip.file(
    "Contents/section0.xml",
    `<hp:section><hp:run charPrIDRef="1"><hp:t>${text}</hp:t></hp:run></hp:section>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("parseSpreadsheet creates markdown and canonical tables from one bounded parse", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["시간", "속도"], ["0", "1.5"], ["1", "2.0"]]),
    "측정",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const parsed = parseSpreadsheet(buffer, "xlsx");
  assert.match(parsed.text, /\| 시간 \| 속도 \|/);
  assert.equal(parsed.sheetCount, 1);
  assert.equal(parsed.totalRows, 3);
  assert.deepEqual(parsed.tables[0].headers, ["시간", "속도"]);
  assert.deepEqual(parsed.tables[0].rows, [["0", "1.5"], ["1", "2.0"]]);

  const legacyBuffer = XLSX.write(workbook, { type: "buffer", bookType: "biff8" });
  const legacyParsed = parseSpreadsheet(legacyBuffer, "xls");
  assert.equal(legacyParsed.tables[0].headers[0], "시간");

  const csvParsed = parseSpreadsheet(Buffer.from("시간,속도\n0,1.5\n", "utf8"), "csv");
  assert.deepEqual(csvParsed.tables[0].rows, [["0", "1.5"]]);
});

test("XLSX preflight rejects forged declared sizes after measuring actual inflate output", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("xl/workbook.xml", "A".repeat(2 * 1024 * 1024));
  const valid = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const forged = forgeDeclaredSize(valid, "xl/workbook.xml", 32);

  assert.throws(
    () => preflightSpreadsheet(forged, "xlsx"),
    /실제 압축률|선언 크기와 실제 압축 해제 크기|안전하지 않습니다/,
  );
});

test("ZIP inspection stops actual inflate output at the byte limit", async () => {
  const zip = new JSZip();
  zip.file("large.txt", "B".repeat(1024 * 1024));
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const inspected = inspectZipArchive(buffer, {
    maxEntries: 5,
    maxEntryUncompressedBytes: 2 * 1024 * 1024,
    maxTotalUncompressedBytes: 2 * 1024 * 1024,
    maxCompressionRatio: 5000,
    ratioMinOutputBytes: 1,
  });

  assert.throws(
    () => inspectActualEntryBytes(buffer, inspected.entries[0], {
      maxEntryUncompressedBytes: 64 * 1024,
      maxCompressionRatio: 5000,
      ratioMinOutputBytes: 1,
    }),
    /실제 압축 해제 크기가 안전 한도를 초과/,
  );
});

test("spreadsheet preflight rejects unsupported extensions and mislabeled XLS", () => {
  assert.throws(
    () => preflightSpreadsheet(Buffer.from("a,b\n1,2"), "json"),
    /지원하지 않는 스프레드시트 형식/,
  );
  assert.throws(
    () => preflightSpreadsheet(Buffer.from("not-an-ole-workbook"), "xls"),
    /XLS 파일 구조가 올바르지 않습니다/,
  );
});

test("HWPX style analysis preserves normal text/font behavior and caches the same buffer", async () => {
  const buffer = await makeMinimalHwpx();
  const originalLoadAsync = JSZip.loadAsync;
  let loadCount = 0;
  JSZip.loadAsync = async (...args) => {
    loadCount++;
    return originalLoadAsync.call(JSZip, ...args);
  };
  try {
    const analyzed = await styleRef.analyzeHwpx(buffer);
    const detected = await styleRef.detectStyleFont([
      { name: "style.hwpx", mimetype: "application/hwp+zip", buffer },
    ]);
    assert.match(analyzed.text, /문체 예시/);
    assert.equal(analyzed.face, "함초롬바탕");
    assert.equal(detected.face, "함초롬바탕");
    assert.equal(loadCount, 1);
  } finally {
    JSZip.loadAsync = originalLoadAsync;
  }
});

test("HWPX style analysis rejects forged actual expansion and does not silently skip it", async () => {
  const valid = await makeMinimalHwpx("A".repeat(2 * 1024 * 1024));
  const forged = forgeDeclaredSize(valid, "Contents/section0.xml", 64);
  const file = {
    name: "unsafe.hwpx",
    mimetype: "application/hwp+zip",
    buffer: forged,
  };

  await assert.rejects(
    () => styleRef.buildStyleBlocks({ styleRefs: [file] }),
    /안전하게 처리할 수 없습니다|실제 압축률|선언 크기와 실제 크기/,
  );
});

test("HWPX style analysis rejects excessive archive entry counts before JSZip parsing", async () => {
  const zip = new JSZip();
  zip.file("Contents/header.xml", "<hh:head/>");
  zip.file("Contents/section0.xml", "<hp:section/>");
  for (let index = 0; index < 401; index++) {
    zip.file(`BinData/item-${index}.txt`, "x");
  }
  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(
    () => styleRef.analyzeHwpx(buffer),
    /안전하게 처리할 수 없습니다.*항목 수/,
  );
});

test("report pipelines use the combined spreadsheet parser instead of two whole parses", () => {
  const physicalSource = fs.readFileSync(
    path.join(__dirname, "../../lib/pipelines/phys-result/generate.js"),
    "utf8",
  );
  assert.match(physicalSource, /parseSpreadsheet\(dataFile\.buffer, dataExt\)/);
  assert.doesNotMatch(physicalSource, /parseToMarkdown\(dataFile\.buffer/);
  assert.doesNotMatch(physicalSource, /parseToTables\(dataFile\.buffer/);

  const chemistrySource = fs.readFileSync(
    path.join(__dirname, "../../lib/pipelines/chem-result/generate.js"),
    "utf8",
  );
  assert.match(chemistrySource, /parseSpreadsheet\(dataBuffer, dataExt\)/);
  assert.doesNotMatch(chemistrySource, /parseToMarkdown\(dataBuffer/);
  assert.doesNotMatch(chemistrySource, /parseToTables\(dataBuffer/);

  const freeReportSource = fs.readFileSync(
    path.join(__dirname, "../../lib/pipelines/free-report/generate.js"),
    "utf8",
  );
  assert.match(freeReportSource, /throw new Error\(`자료 데이터 파싱 실패/);
});
