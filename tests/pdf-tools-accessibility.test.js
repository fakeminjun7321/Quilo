"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const PUBLIC_TOOLS = path.join(__dirname, "..", "public", "tools");

function readTool(filename) {
  return fs.readFileSync(path.join(PUBLIC_TOOLS, filename), "utf8");
}

function tagWithId(source, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.match(new RegExp(`<[^>]+\\bid="${escaped}"[^>]*>`))?.[0] || "";
}

function expectAttribute(tag, name, value, context) {
  assert.match(tag, new RegExp(`\\b${name}="${value}"`), context);
}

test("convert workspace exposes a complete APG tab contract", () => {
  const html = readTool("convert.html");
  const names = ["file", "image", "pdf", "equation", "docx2hwpx"];

  expectAttribute(tagWithId(html, "convTabs"), "role", "tablist", "tablist role");
  expectAttribute(tagWithId(html, "convTabs"), "aria-label", "변환 도구 종류", "tablist name");

  for (const [index, name] of names.entries()) {
    const tabId = `convTab-${name}`;
    const panelId = `convPanel-${name}`;
    const tab = tagWithId(html, tabId);
    const panel = tagWithId(html, panelId);

    assert.ok(tab, `${tabId} exists`);
    assert.ok(panel, `${panelId} exists`);
    expectAttribute(tab, "role", "tab", tabId);
    expectAttribute(tab, "aria-controls", panelId, tabId);
    expectAttribute(tab, "aria-selected", index === 0 ? "true" : "false", tabId);
    expectAttribute(tab, "tabindex", index === 0 ? "0" : "-1", tabId);
    expectAttribute(panel, "role", "tabpanel", panelId);
    expectAttribute(panel, "aria-labelledby", tabId, panelId);
    if (index === 0) assert.doesNotMatch(panel, /\shidden(?:\s|>|=)/, panelId);
    else assert.match(panel, /\shidden(?:\s|>|=)/, panelId);
  }

  for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) {
    assert.match(html, new RegExp(`event\\.key === "${key}"`), `${key} keyboard navigation`);
  }
  assert.match(html, /tab\.setAttribute\("aria-selected", String\(selected\)\)/);
  assert.match(html, /tab\.tabIndex = selected \? 0 : -1/);
  assert.match(html, /panel\.hidden = !selected/);
  assert.match(html, /if \(moveFocus\) btn\.focus\(\)/);
  assert.match(html, /frame\.src = frame\.dataset\.src/);
  assert.match(html, /button\[data-jump-tab\]/);
});

test("convert tab controller preserves click, keyboard, quick-jump and lazy iframe behavior", () => {
  class FakeElement {
    constructor(dataset = {}, active = false) {
      this.dataset = dataset;
      this.attributes = new Map();
      this.classes = new Set(active ? ["on"] : []);
      this.classList = {
        toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name)),
      };
      this.listeners = new Map();
      this.hidden = !active;
      this.src = "";
      this.focused = false;
      this.scrolled = false;
      this.tabIndex = active ? 0 : -1;
    }

    addEventListener(type, handler) { this.listeners.set(type, handler); }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    focus() { this.focused = true; }
    click() { this.listeners.get("click")?.({ target: this }); }
    scrollIntoView() { this.scrolled = true; }
    querySelector(selector) { return selector === "iframe.conv-frame[data-src]" ? this.frame || null : null; }
  }

  const names = ["file", "image", "pdf", "equation", "docx2hwpx"];
  const tabs = names.map((name, index) => new FakeElement({ tab: name }, index === 0));
  const panels = names.map((name, index) => new FakeElement({ panel: name }, index === 0));
  tabs[0].setAttribute("aria-selected", "true");
  tabs.slice(1).forEach((tab) => tab.setAttribute("aria-selected", "false"));
  panels[1].frame = new FakeElement({ src: "/tools/image.html?embed=1" });
  panels[3].frame = new FakeElement({ src: "/equation/index.html?embed=1" });

  const shortcuts = new FakeElement();
  const modeButton = new FakeElement({ m: "table" });
  let modeClicks = 0;
  modeButton.click = () => { modeClicks += 1; };
  const document = {
    querySelectorAll(selector) {
      if (selector === "#convTabs button[data-tab]") return tabs;
      if (selector === ".conv-panel[data-panel]") return panels;
      return [];
    },
    querySelector(selector) {
      let match = selector.match(/^\.conv-panel\[data-panel="([^"]+)"\]$/);
      if (match) return panels[names.indexOf(match[1])] || null;
      match = selector.match(/^#convTabs button\[data-tab="([^"]+)"\]$/);
      if (match) return tabs[names.indexOf(match[1])] || null;
      if (selector === '#modeTabs button[data-m="table"]') return modeButton;
      if (selector === ".conv-panel.on") return panels.find((panel) => panel.classes.has("on")) || null;
      return null;
    },
    getElementById(id) { return id === "convertShortcuts" ? shortcuts : null; },
  };

  const html = readTool("convert.html");
  const controller = html.match(/<script>\s*(\/\/ 상위 탭 전환[\s\S]*?)<\/script>/)?.[1] || "";
  assert.ok(controller, "tab controller script exists");
  new Function("document", controller)(document);

  tabs[1].click();
  assert.equal(tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(tabs[0].tabIndex, -1);
  assert.equal(panels[0].hidden, true);
  assert.equal(panels[1].hidden, false);
  assert.equal(panels[1].frame.src, "/tools/image.html?embed=1");

  let prevented = false;
  tabs[1].listeners.get("keydown")({ key: "End", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(tabs[4].focused, true);
  assert.equal(tabs[4].getAttribute("aria-selected"), "true");

  tabs[4].listeners.get("keydown")({ key: "ArrowRight", preventDefault() {} });
  assert.equal(tabs[0].focused, true, "right arrow wraps to first tab");

  const shortcut = {
    dataset: { jumpTab: "file", jumpMode: "table" },
    closest() { return this; },
  };
  shortcuts.listeners.get("click")({ target: shortcut });
  assert.equal(tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(modeClicks, 1);
  assert.equal(panels[0].scrolled, true);
});

test("asynchronous PDF tool messages and completion summaries are polite live statuses", () => {
  const cases = new Map([
    ["pdf-compress.html", ["pcMsg"]],
    ["pdf-crop.html", ["pcStat", "pcMsg"]],
    ["pdf-extract.html", ["pxStat", "pxMsg"]],
    ["pdf-merge.html", ["pmStat", "pmMsg"]],
    ["pdf-organize.html", ["poOrderMsg", "poStat", "poMsg"]],
    ["pdf-pagenum.html", ["pnStat", "pnMsg"]],
    ["pdf-remove.html", ["prStat", "prMsg"]],
    ["pdf-rotate.html", ["prStat", "prMsg"]],
    ["pdf-split.html", ["psStat", "psMsg"]],
    ["pdf-watermark.html", ["wmStat", "wmMsg"]],
  ]);

  for (const [filename, ids] of cases) {
    const html = readTool(filename);
    for (const id of ids) {
      const tag = tagWithId(html, id);
      assert.ok(tag, `${filename}#${id} exists`);
      expectAttribute(tag, "role", "status", `${filename}#${id}`);
      expectAttribute(tag, "aria-live", "polite", `${filename}#${id}`);
      expectAttribute(tag, "aria-atomic", "true", `${filename}#${id}`);
      assert.doesNotMatch(tag, /\brole="alert"/, `${filename}#${id} must not interrupt`);
    }
  }
});
