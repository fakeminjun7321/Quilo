"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const JSZip = require("jszip");
const XLSX = require("xlsx");
const {
  termExistsInSource,
  normalizeEntry,
} = require("../lib/pipelines/vocabulary-book/generate");
const { generateBundle } = require("../lib/pipelines/vocabulary-book/bundle");
const { spreadsheetPages, extractVocabularySource } = require("../lib/pipelines/vocabulary-book/source");
const {
  normalizeVocabularyDesign,
  vocabularyDesignLabel,
} = require("../lib/pipelines/vocabulary-book/designs");

const sampleEntry = {
  kind: "core",
  term: "electric field",
  part_of_speech: "명",
  pronunciation: "[ɪˈlɛktrɪk fiːld]",
  meaning: "전기장",
  definition_ko: "단위 양전하가 받는 전기력으로 정의되는 물리량.",
  study_note_ko: "전기력과 방향을 함께 읽어야 한다.",
  source_page: 12,
  examples: [
    { en: "The electric field points away from a positive charge.", ko: "전기장은 양전하에서 바깥쪽을 향한다." },
    { en: "Calculate the electric field at the origin.", ko: "원점에서 전기장을 계산하라." },
  ],
  related: [{ en: "electric force", ko: "전기력" }],
};

test("term source matching normalizes case, whitespace, and dash variants", () => {
  assert.equal(termExistsInSource("Electric Field", "The electric   field is uniform."), true);
  assert.equal(termExistsInSource("time-dependent", "a time–dependent field"), true);
  assert.equal(termExistsInSource("field", "The fields are uniform."), false);
  assert.equal(termExistsInSource("ion", "The particle is in motion."), false);
  assert.equal(termExistsInSource("invented quantity", "measured electric field"), false);
});

test("vocabulary design choices are whitelisted with a stable default", () => {
  assert.equal(normalizeVocabularyDesign("science"), "science");
  assert.equal(normalizeVocabularyDesign("CLASSIC"), "classic");
  assert.equal(normalizeVocabularyDesign("minimal"), "minimal");
  assert.equal(normalizeVocabularyDesign("../../unknown"), "science");
  assert.equal(vocabularyDesignLabel("classic"), "클래식 교재형");
});

test("normalizeEntry rejects terms that do not occur in the selected source", () => {
  const base = {
    allowedKinds: new Set(["core"]),
    pageText: "The magnetic force is perpendicular. The electric field and electric force point away from a positive charge.",
    pageNumbers: [11, 12],
    pageTexts: [
      { number: 11, text: "The magnetic force is perpendicular." },
      { number: 12, text: "The electric field and electric force point away from a positive charge." },
    ],
    fallbackSection: "U1",
  };
  const accepted = normalizeEntry(sampleEntry, base);
  assert.equal(accepted.term, "electric field");
  assert.equal(accepted.source_page, 12);
  assert.equal(accepted.source_label, "PDF 12쪽");
  assert.deepEqual(accepted.related, [{ en: "electric force", ko: "전기력" }]);
  assert.equal(normalizeEntry({ ...sampleEntry, source_page: 11 }, base).source_page, 12);
  assert.equal(normalizeEntry({ ...sampleEntry, term: "magnetic monopole" }, base), null);
});

test("CSV and text word lists become traceable source units", async () => {
  const csv = Buffer.from("word,meaning\nelectric field,전기장\nmagnetic force,자기력\n", "utf8");
  const parsed = spreadsheetPages(csv, "csv");
  assert.equal(parsed.kind, "spreadsheet");
  assert.equal(parsed.pages.length, 1);
  assert.match(parsed.pages[0].label, /Sheet1 · 2-3행/);
  assert.match(parsed.pages[0].text, /electric field/);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["word", "meaning"],
    ["potential energy", "위치 에너지"],
  ]), "Words");
  const xlsx = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const excelParsed = spreadsheetPages(xlsx, "xlsx");
  assert.match(excelParsed.pages[0].label, /Words · 2-2행/);
  assert.match(excelParsed.pages[0].text, /potential energy/);

  const text = await extractVocabularySource(
    { name: "my-vocab.txt", buffer: Buffer.from("electric field - 전기장\nmagnetic force - 자기력", "utf8") },
  );
  assert.equal(text.kind, "text");
  assert.equal(text.pages[0].label, "텍스트 1구간");
  assert.match(text.source_line, /my-vocab\.txt · 텍스트 1구간/);
});

test("vocabulary bundle contains a navigable PDF and public JSON", async () => {
  const content = {
    title: "Physics Vocabulary",
    book: {
      title: "Physics Vocabulary",
      subtitle: "VOCABULARY",
      source_line: "physics.pdf · PDF 12쪽",
      publisher_line: "ENGLISH-KOREAN TEXTBOOK STUDY EDITION",
      author: "Quilo",
    },
    chapters: [
      {
        number: 1,
        title_en: "Electric Fields",
        title_ko: "전기장",
        page_start: 12,
        page_end: 12,
        entries: [sampleEntry],
      },
    ],
    options: { include_pronunciation: true, include_review: true, include_memo: true, design_style: "science" },
    __usage: { input_tokens: 100, output_tokens: 100 },
  };
  const bundle = await generateBundle(content, { sourceFilename: "physics.pdf" });
  assert.match(bundle.filename, /단어장\.zip$/);
  assert.equal(bundle.buffer.subarray(0, 2).toString("ascii"), "PK");
  const zip = await JSZip.loadAsync(bundle.buffer);
  const names = Object.keys(zip.files);
  const pdfName = names.find((name) => name.endsWith(".pdf"));
  const jsonName = names.find((name) => name.endsWith(".json"));
  assert.ok(pdfName);
  assert.ok(jsonName);
  const pdf = await zip.file(pdfName).async("nodebuffer");
  assert.equal(pdf.subarray(0, 5).toString("ascii"), "%PDF-");
  const json = JSON.parse(await zip.file(jsonName).async("string"));
  assert.equal(json.chapters[0].entries[0].term, "electric field");
  assert.equal(json.options.design_style, "science");
  assert.equal(Object.hasOwn(json, "__usage"), false);
});
