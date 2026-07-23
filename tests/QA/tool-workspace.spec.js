const fs = require("fs");
const path = require("path");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find(
      (key) =>
        key.includes(`${marker}@playwright${path.sep}test${path.sep}`) ||
        key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
const PUBLIC_DIR = path.join(process.cwd(), "public");

const TOOL_PAGES = Object.freeze([
  "tools/index.html",
  "tools/convert.html",
  "tools/image.html",
  "tools/pdf-compress.html",
  "tools/pdf-analysis.html",
  "tools/pdf-crop.html",
  "tools/pdf-extract.html",
  "tools/pdf-merge.html",
  "tools/pdf-organize.html",
  "tools/pdf-pagenum.html",
  "tools/pdf-remove.html",
  "tools/pdf-rotate.html",
  "tools/pdf-split.html",
  "tools/pdf-watermark.html",
  "equation/index.html",
]);

test.describe("browser tool workspace contract", () => {
  for (const route of TOOL_PAGES) {
    test(`${route} uses the shared tool workspace`, () => {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, route), "utf8");
      expect(html).toContain('<link rel="stylesheet" href="/ui/tool-shell.css" />');
      expect(html).toContain('<script src="/ui/tool-shell.js"></script>');
    });
  }

  test("heavy PDF and ZIP engines are loaded through the shared lazy loader", () => {
    for (const route of TOOL_PAGES) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, route), "utf8");
      expect(html).not.toMatch(
        /<script\s+src="(?:\/tools\/vendor\/(?:pdf-lib|pdf|jszip)\.min\.js|vendor\/jszip\.min\.js)"/,
      );
    }

    const runtime = fs.readFileSync(path.join(PUBLIC_DIR, "ui/tool-shell.js"), "utf8");
    expect(runtime).toContain("window.QuiloToolAssets");
    expect(runtime).toContain("/tools/vendor/pdf-lib.min.js");
    expect(runtime).toContain("/tools/vendor/pdf.min.js");
    expect(runtime).toContain("/tools/vendor/jszip.min.js");
    expect(runtime).not.toContain("/equation/vendor/jszip.min.js");
  });

  test("workspace runtime owns navigation, task stage and result rail", () => {
    const runtime = fs.readFileSync(path.join(PUBLIC_DIR, "ui/tool-shell.js"), "utf8");
    expect(runtime).toContain('shell.className = "q-tool-shell"');
    expect(runtime).toContain('stage.className = "q-tool-stage"');
    expect(runtime).toContain('aside.className = "q-tool-nav"');
    expect(runtime).toContain('rail.className = "q-tool-result-rail"');

    const styles = fs.readFileSync(path.join(PUBLIC_DIR, "ui/tool-shell.css"), "utf8");
    expect(styles).toContain("grid-template-columns: 244px minmax(520px, 1fr) 316px");
    expect(styles).toContain(".q-tool-result-rail");
    expect(styles).toContain(".q-tool-stage .tool-card");
  });
});
