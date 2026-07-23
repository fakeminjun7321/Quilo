const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sharp = require("sharp");

const {
  cropFigures,
  figuresToAssets,
  dedupFigureImages,
  assertCompleteCropManifest,
} = require("../../lib/pipelines/pdf-translate/latex-gen");
const {
  extractFigures,
  assertCompleteFigureExtraction,
  PYTHON,
} = require("../../lib/pipelines/pdf-translate/pdf-tool");

test("scan crop reports every expected occurrence and rejects invalid tile/box", async () => {
  const tile = await sharp({
    create: {
      width: 120,
      height: 100,
      channels: 3,
      background: { r: 245, g: 245, b: 245 },
    },
  })
    .png()
    .toBuffer();

  const result = await cropFigures(
    [
      {
        n: 1,
        image: 1,
        box: [0.1, 0.1, 0.8, 0.8],
        caption: "Figure 2.4",
      },
      { n: 2, image: 99, box: [0.1, 0.1, 0.8, 0.8], caption: "" },
      { n: 3, image: 1, box: [0.2, 0.2, 0.2, 0.6], caption: "" },
      { n: 4, image: 1, box: [-0.2, 0.1, 0.8, 0.8], caption: "" },
      { n: 5, image: 2, box: [0.1, 0.1, 0.8, 0.8], caption: "" },
    ],
    [tile, Buffer.from("not an image")],
  );

  assert.equal(result.redrawn, 0);
  assert.equal(result.assets.length, 1);
  assert.equal(result.meta[1].num, "2.4");
  assert.deepEqual(result.manifest.expected_ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.manifest.attempted_ids, [1, 2, 3, 4, 5]);
  assert.deepEqual(result.manifest.emitted_ids, [1]);
  assert.deepEqual(result.manifest.failed_ids, [2, 3, 4, 5]);
  assert.equal(result.manifest.complete, false);
  assert.throws(
    () => assertCompleteCropManifest(result),
    (error) => {
      assert.equal(error.code, "PDF_FIGURE_CROP_INCOMPLETE");
      assert.deepEqual(error.figureManifest.failed_ids, [2, 3, 4, 5]);
      return true;
    },
  );
});

test("successful chart redraw is emitted and counted in the crop manifest", async () => {
  const tile = await sharp({
    create: {
      width: 80,
      height: 80,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();
  const result = await cropFigures(
    [
      {
        n: 4,
        image: 1,
        box: [0.1, 0.1, 0.9, 0.9],
        kind: "plot",
        caption: "Figure 4",
        chart: {
          type: "line",
          title: "y over x",
          x_label: "x",
          y_label: "y",
          x_values: [0, 1, 2],
          series: [{ label: "sample", values: [1, 2, 3] }],
        },
      },
    ],
    [tile],
    { chartRedraw: true },
  );

  assert.equal(result.redrawn, 1);
  assert.equal(result.assets.length, 1);
  assert.deepEqual(result.manifest.emitted_ids, [4]);
  assert.deepEqual(result.manifest.failed_ids, []);
  assert.equal(result.manifest.complete, true);
});

test("identical pixels at two legitimate occurrences remain two placements", () => {
  const buffer = Buffer.from("same decoded pixels");
  const result = figuresToAssets([
    { n: 7, page: 1, buffer, caption: "Figure 1" },
    { n: 8, page: 2, buffer, caption: "Figure 1 repeated" },
  ]);

  assert.equal(result.assets.length, 2);
  assert.notEqual(result.assets[0].name, result.assets[1].name);
  assert.match(result.replace[7], /fig-7\.png/);
  assert.match(result.replace[8], /fig-8\.png/);
});

test("final image cleanup does not delete a second placement solely by filename", () => {
  assert.equal(typeof dedupFigureImages, "function");
  const block =
    "\\\\begin{center}\n" +
    "\\\\includegraphics[width=0.5\\\\linewidth]{shared.png}\n" +
    "\\\\end{center}";
  const body = `first\n${block}\nsecond placement\n${block}\nlast`;
  const cleaned = dedupFigureImages(body);
  assert.equal((cleaned.match(/shared\.png/g) || []).length, 2);
});

test("text-PDF extraction manifest is fail-closed", () => {
  assert.equal(typeof assertCompleteFigureExtraction, "function");
  const complete = {
    figures: [{ id: "p1-r1", n: 1, file: "/tmp/fig-1.png" }],
    figure_manifest: {
      complete: true,
      candidate_ids: ["p1-r1"],
      discovered_ids: ["p1-r1"],
      emitted_ids: ["p1-r1"],
      truncated_ids: [],
      failed_ids: [],
    },
  };
  assert.equal(assertCompleteFigureExtraction(complete), complete);

  const incomplete = structuredClone(complete);
  incomplete.figures = [];
  incomplete.figure_manifest.complete = false;
  incomplete.figure_manifest.emitted_ids = [];
  incomplete.figure_manifest.truncated_ids = ["p1-r1"];
  assert.throws(
    () => assertCompleteFigureExtraction(incomplete),
    (error) => {
      assert.equal(error.code, "PDF_FIGURE_EXTRACTION_INCOMPLETE");
      assert.match(error.message, /p1-r1/);
      return true;
    },
  );
});

test("pdf-tool rejects a real Python extraction truncated by maxFigures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-fig-manifest-"));
  const source = path.join(root, "source.pdf");
  const outDir = path.join(root, "figures");
  const makePdf = String.raw`
import fitz, sys
doc = fitz.open()
page = doc.new_page(width=600, height=800)
for x0, y0 in ((60, 120), (350, 430)):
    page.draw_rect(fitz.Rect(x0, y0, x0 + 110, y0 + 4), color=(0, 0, 0))
    page.draw_rect(fitz.Rect(x0 + 106, y0, x0 + 110, y0 + 100), color=(0, 0, 0))
    page.draw_rect(fitz.Rect(x0, y0 + 96, x0 + 110, y0 + 100), color=(0, 0, 0))
    page.draw_rect(fitz.Rect(x0, y0, x0 + 4, y0 + 100), color=(0, 0, 0))
doc.save(sys.argv[1])
doc.close()
`;
  try {
    const made = spawnSync(PYTHON, ["-c", makePdf, source], {
      encoding: "utf8",
    });
    assert.equal(made.status, 0, made.stderr);
    await assert.rejects(
      extractFigures(source, outDir, { maxFigures: 1 }),
      (error) => {
        assert.equal(error.code, "PDF_FIGURE_EXTRACTION_INCOMPLETE");
        assert.match(error.message, /p1-r2/);
        return true;
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
