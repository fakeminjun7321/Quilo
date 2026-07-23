"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const pdfTool = require("../../lib/pipelines/pdf-translate/pdf-tool");
const {
  translateLargePdf,
  createPdfTranslateResourceLimits,
} = require("../../lib/pipelines/pdf-translate/translate");


function runPython(code, args = []) {
  const proc = spawnSync(pdfTool.PYTHON, ["-c", code, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(proc.status, 0, `python failed:\n${proc.stdout}\n${proc.stderr}`);
  return proc.stdout.trim();
}


function makeLargePdf(target) {
  runPython(String.raw`
import fitz
import sys

target = sys.argv[1]
doc = fitz.open()
for index in range(51):
    page = doc.new_page(width=612, height=792)
    page.insert_text(
        (54, 72),
        f"Chunk structure regression page {index + 1:02d}",
        fontsize=11,
        fontname="helv",
    )
doc.set_toc([
    [1, "Main Section", 1],
    [2, "Repeated Detail", 2],
    [2, "Repeated Detail", 51],
    [1, "RFC", 25],
    [1, "Final Section", 51],
], collapse=1)
doc.set_metadata({
    "title": "Large structure translation fixture",
    "subject": "Reader visible chunk merge information",
    "keywords": "translation, chunking, PDF",
    "author": "Preserved Test Author",
    "creator": "Preserved Test Creator",
    "producer": "Preserved Test Producer",
    "creationDate": "D:20260102030405+09'00'",
    "modDate": "D:20260710112233+09'00'",
})
doc.save(target, garbage=3, deflate=True)
doc.close()
`, [target]);
}


function translatedValue(item) {
  const id = String(item.id);
  const fixed = {
    "__pdf_outline__:000000": "주요 섹션",
    "__pdf_outline__:000001": "반복 세부 항목",
    "__pdf_outline__:000004": "마지막 섹션",
    "__pdf_metadata__:title": "대용량 구조 번역 픽스처",
    "__pdf_metadata__:subject": "리더에 표시되는 구간 병합 정보",
    "__pdf_metadata__:keywords": "번역, 구간 분할, PDF",
  };
  if (fixed[id]) return fixed[id];
  const pageNumber = String(item.text).match(/(\d{2})\s*$/)?.[1];
  assert.ok(pageNumber, `unexpected page block: ${JSON.stringify(item)}`);
  return `구간 구조 회귀 페이지 ${pageNumber}`;
}


test("large orchestration translates whole-document virtual blocks once and restores them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-large-orchestration-"));
  const source = path.join(dir, "source.pdf");
  const output = path.join(dir, "output.pdf");
  makeLargePdf(source);

  const seen = new Map();
  let callerInvocations = 0;
  const caller = async ({ user }) => {
    callerInvocations += 1;
    const arrayStart = user.indexOf("[");
    assert.notEqual(arrayStart, -1, user);
    const items = JSON.parse(user.slice(arrayStart));
    const translated = {};
    for (const item of items) {
      const id = String(item.id);
      seen.set(id, (seen.get(id) || 0) + 1);
      translated[id] = translatedValue(item);
    }
    return {
      text: JSON.stringify({ t: translated }),
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
  };

  try {
    const result = await translateLargePdf({
      pdfBuffer: fs.readFileSync(source),
      caller,
      model: "test-no-api-model",
      pageCount: 51,
      resourceLimits: createPdfTranslateResourceLimits({
        apiConcurrency: 4,
        documentConcurrency: 4,
        env: {},
      }),
    });
    fs.writeFileSync(output, result.buffer);

    const modelVirtualIds = [
      "__pdf_outline__:000000",
      "__pdf_outline__:000001",
      "__pdf_outline__:000004",
      "__pdf_metadata__:title",
      "__pdf_metadata__:subject",
      "__pdf_metadata__:keywords",
    ];
    for (const id of modelVirtualIds) {
      assert.equal(seen.get(id), 1, `${id} should reach the caller exactly once`);
    }
    assert.equal(
      seen.get("__pdf_outline__:000002"),
      undefined,
      "an exact repeated outline should reuse its canonical translation without another model token",
    );
    assert.ok(callerInvocations >= 3, "two page chunks and one structure batch must run");
    assert.equal(result.pageCount, 51);
    assert.equal(result.blockCount, 58);
    assert.equal(result.missing, 0);
    assert.equal(result.stats.structure_restored, true);
    assert.equal(result.stats.virtual_replaced, 7);
    assert.equal(result.stats.outline_replaced, 4);
    assert.equal(result.stats.metadata_replaced, 3);

    const inspection = JSON.parse(runPython(String.raw`
import fitz
import json
import sys

with fitz.open(sys.argv[1]) as doc:
    print(json.dumps({
        "pages": len(doc),
        "titles": [item[1] for item in doc.get_toc(simple=False)],
        "levels": [int(item[0]) for item in doc.get_toc(simple=False)],
        "targets": [int(item[2]) for item in doc.get_toc(simple=False)],
        "metadata": doc.metadata,
        "last_page": doc[-1].get_text(),
    }, ensure_ascii=False))
`, [output]));
    assert.equal(inspection.pages, 51);
    assert.deepEqual(inspection.titles, [
      "주요 섹션",
      "반복 세부 항목",
      "반복 세부 항목",
      "RFC",
      "마지막 섹션",
    ]);
    assert.deepEqual(inspection.levels, [1, 2, 2, 1, 1]);
    assert.deepEqual(inspection.targets, [1, 2, 51, 25, 51]);
    assert.equal(inspection.metadata.title, "대용량 구조 번역 픽스처");
    assert.equal(
      inspection.metadata.subject,
      "리더에 표시되는 구간 병합 정보",
    );
    assert.equal(inspection.metadata.keywords, "번역, 구간 분할, PDF");
    assert.equal(inspection.metadata.author, "Preserved Test Author");
    assert.match(inspection.last_page, /구간 구조 회귀 페이지 51/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
