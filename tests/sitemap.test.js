const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { XMLParser } = require("fast-xml-parser");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const SITE_ORIGIN = "https://quilolab.com";

const expectedPublicPages = [
  "/pricing.html",
  "/developers.html",
  "/apps/quilo.html",
  "/apps/live-translator.html",
  "/filechat.html",
  "/physics-studio.html",
  "/vibe-coding.html",
  "/tools/image-ocr.html",
  "/tools/pdf-analysis.html",
];

function readSitemapUrls() {
  const xml = fs.readFileSync(path.join(PUBLIC_DIR, "sitemap.xml"), "utf8");
  const parsed = new XMLParser().parse(xml);
  const entries = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
  return entries.map((entry) => entry.loc);
}

test("sitemap includes each public product page exactly once", () => {
  const urls = readSitemapUrls();
  assert.equal(new Set(urls).size, urls.length, "sitemap must not contain duplicate URLs");

  for (const pathname of expectedPublicPages) {
    const canonicalUrl = `${SITE_ORIGIN}${pathname}`;
    assert.equal(
      urls.filter((url) => url === canonicalUrl).length,
      1,
      `${canonicalUrl} must appear exactly once`,
    );
  }
});

test("sitemap product entries point to canonical, indexable HTML files", () => {
  for (const pathname of expectedPublicPages) {
    const filePath = path.join(PUBLIC_DIR, pathname);
    assert.equal(fs.existsSync(filePath), true, `${pathname} must exist in public/`);

    const html = fs.readFileSync(filePath, "utf8");
    const canonicalUrl = `${SITE_ORIGIN}${pathname}`;
    assert.match(
      html,
      new RegExp(`<link\\s+rel=["']canonical["']\\s+href=["']${canonicalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*/?>`, "i"),
      `${pathname} must declare its sitemap URL as canonical`,
    );
    assert.doesNotMatch(
      html,
      /<meta\s+[^>]*name=["']robots["'][^>]*content=["'][^"']*noindex/i,
      `${pathname} must not be marked noindex`,
    );
  }
});

test("sitemap product entries are not blocked by robots.txt", () => {
  const robots = fs.readFileSync(path.join(PUBLIC_DIR, "robots.txt"), "utf8");
  const disallowedPrefixes = robots
    .split(/\r?\n/)
    .map((line) => line.match(/^Disallow:\s*(\S+)/i)?.[1])
    .filter(Boolean);

  for (const pathname of expectedPublicPages) {
    assert.equal(
      disallowedPrefixes.some((prefix) => pathname.startsWith(prefix)),
      false,
      `${pathname} must not be blocked by robots.txt`,
    );
  }
});
