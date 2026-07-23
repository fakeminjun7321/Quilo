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


function makePdf(target, { blankLast = false, allBlank = false, structure = false } = {}) {
  runPython(String.raw`
import fitz
import sys

target = sys.argv[1]
blank_last = sys.argv[2] == "1"
all_blank = sys.argv[3] == "1"
structure = sys.argv[4] == "1"
doc = fitz.open()
for index in range(51):
    page = doc.new_page(width=612, height=792)
    if not all_blank and not (blank_last and index == 50):
        page.insert_text(
            (54, 72),
            f"Chunk blank regression page {index + 1:02d}",
            fontsize=11,
            fontname="helv",
        )
if structure:
    doc.set_toc([[1, "Blank document section", 1]])
    doc.set_metadata({"title": "Blank document title"})
doc.save(target, garbage=3, deflate=True)
doc.close()
`, [target, blankLast ? "1" : "0", allBlank ? "1" : "0", structure ? "1" : "0"]);
}


function parseItems(user) {
  const start = user.indexOf("[");
  assert.notEqual(start, -1, user);
  return JSON.parse(user.slice(start));
}


function limits() {
  return createPdfTranslateResourceLimits({
    apiConcurrency: 4,
    documentConcurrency: 4,
    env: {},
  });
}


test("large translation passes through only a proven blank trailing chunk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-blank-chunk-"));
  const source = path.join(dir, "source.pdf");
  const output = path.join(dir, "output.pdf");
  makePdf(source, { blankLast: true });
  const seenTexts = [];
  const caller = async ({ user }) => {
    const items = parseItems(user);
    const translated = {};
    for (const item of items) {
      seenTexts.push(item.text);
      const page = String(item.text).match(/(\d{2})\s*$/)?.[1];
      assert.ok(page, item.text);
      translated[String(item.id)] = `구간 빈 페이지 회귀 ${page}`;
    }
    return {
      text: JSON.stringify({ t: translated }),
      usage: { input_tokens: items.length, output_tokens: items.length },
    };
  };

  try {
    const result = await translateLargePdf({
      pdfBuffer: fs.readFileSync(source),
      caller,
      model: "claude-sonnet-5",
      pageCount: 51,
      resourceLimits: limits(),
    });
    fs.writeFileSync(output, result.buffer);
    assert.equal(result.pageCount, 51);
    assert.equal(result.blockCount, 50);
    assert.equal(result.stats.replaced, 50);
    assert.equal(seenTexts.length, 50);
    assert.ok(seenTexts.every((text) => !/51\s*$/.test(text)));

    const inspection = JSON.parse(runPython(String.raw`
import fitz, json, sys
with fitz.open(sys.argv[1]) as doc:
    print(json.dumps({
        "pages": len(doc),
        "first": doc[0].get_text().strip(),
        "last": doc[-1].get_text().strip(),
    }, ensure_ascii=False))
`, [output]));
    assert.equal(inspection.pages, 51);
    assert.match(inspection.first, /구간 빈 페이지 회귀 01/);
    assert.equal(inspection.last, "");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("structure-only blank large PDF translates virtual blocks once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-blank-structure-"));
  const source = path.join(dir, "source.pdf");
  const output = path.join(dir, "output.pdf");
  makePdf(source, { allBlank: true, structure: true });
  const seen = new Map();
  const targets = {
    "__pdf_outline__:000000": "빈 문서 섹션",
    "__pdf_metadata__:title": "빈 문서 제목",
  };
  const caller = async ({ user }) => {
    const items = parseItems(user);
    const translated = {};
    for (const item of items) {
      const id = String(item.id);
      seen.set(id, (seen.get(id) || 0) + 1);
      assert.ok(targets[id], id);
      translated[id] = targets[id];
    }
    return { text: JSON.stringify({ t: translated }), usage: {} };
  };

  try {
    const result = await translateLargePdf({
      pdfBuffer: fs.readFileSync(source),
      caller,
      model: "claude-sonnet-5",
      pageCount: 51,
      resourceLimits: limits(),
    });
    fs.writeFileSync(output, result.buffer);
    assert.equal(result.blockCount, 2);
    assert.equal(result.stats.virtual_replaced, 2);
    assert.equal(seen.get("__pdf_outline__:000000"), 1);
    assert.equal(seen.get("__pdf_metadata__:title"), 1);
    const inspection = JSON.parse(runPython(String.raw`
import fitz, json, sys
with fitz.open(sys.argv[1]) as doc:
    print(json.dumps({
        "pages": len(doc),
        "title": doc.metadata.get("title"),
        "outline": [item[1] for item in doc.get_toc(simple=False)],
        "text": sum(len(page.get_text().strip()) for page in doc),
    }, ensure_ascii=False))
`, [output]));
    assert.deepEqual(inspection, {
      pages: 51,
      title: "빈 문서 제목",
      outline: ["빈 문서 섹션"],
      text: 0,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test("first chunk failure aborts and drains every sibling before rejection", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-chunk-drain-"));
  const source = path.join(dir, "source.pdf");
  makePdf(source);
  const resourceLimits = limits();
  const progress = [];
  let wakeLongCaller;
  let longCallerStarted = false;
  const waitForLongCaller = new Promise((resolve) => { wakeLongCaller = resolve; });
  let activeCallers = 0;
  let maxActiveCallers = 0;
  let settledCallers = 0;

  const caller = async ({ user }) => {
    const items = parseItems(user);
    const isLastPage = items.some((item) => /51\s*$/.test(String(item.text)));
    activeCallers += 1;
    maxActiveCallers = Math.max(maxActiveCallers, activeCallers);
    try {
      if (isLastPage) {
        await waitForLongCaller;
        throw new Error("forced page 51 failure");
      }
      if (!longCallerStarted) {
        longCallerStarted = true;
        wakeLongCaller();
      }
      // Deliberately ignore AbortSignal to prove the orchestrator drains a
      // non-cooperative provider promise before returning.
      await new Promise((resolve) => setTimeout(resolve, 350));
      const translated = {};
      for (const item of items) {
        const page = String(item.text).match(/(\d{2})\s*$/)?.[1];
        translated[String(item.id)] = `구간 드레인 회귀 페이지 ${page}`;
      }
      return { text: JSON.stringify({ t: translated }), usage: {} };
    } finally {
      activeCallers -= 1;
      settledCallers += 1;
    }
  };

  try {
    const started = Date.now();
    let caught = null;
    try {
      await translateLargePdf({
        pdfBuffer: fs.readFileSync(source),
        caller,
        model: "claude-sonnet-5",
        pageCount: 51,
        resourceLimits,
        onProgress: (message) => progress.push(message),
      });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - started;
    assert.ok(caught, "translation should fail");
    assert.match(caught.message, /품질 검증 실패|forced page 51 failure/);
    assert.ok(elapsed >= 300, `returned before sibling drain: ${elapsed}ms`);
    assert.equal(activeCallers, 0);
    assert.ok(settledCallers >= 7, settledCallers);
    assert.ok(maxActiveCallers >= 2, maxActiveCallers);
    assert.deepEqual(resourceLimits.stats().api, { capacity: 4, active: 0, queued: 0 });
    assert.deepEqual(resourceLimits.stats().document, { capacity: 4, active: 0, queued: 0 });
    const progressAtReturn = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(progress.length, progressAtReturn, "progress continued after rejection");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
