"use strict";

const fs = require("fs");
const path = require("path");
const { extractVocabularySource } = require("./source");
const { callModelJson } = require("../../ai-studio-core");
const { calcCost } = require("../../pricing");
const { normalizeVocabularyDesign } = require("./designs");

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "prompt.md"), "utf8");
const MAX_PAGES = Math.max(10, parseInt(process.env.VOCABULARY_BOOK_MAX_PAGES || "80", 10) || 80);
const CONCURRENCY = Math.max(1, parseInt(process.env.VOCABULARY_BOOK_CONCURRENCY || "3", 10) || 3);
const ALLOWED_KINDS = new Set(["core", "academic", "phrase"]);
const ALLOWED_POS = new Set(["명", "동", "형", "부", "구"]);

function cleanText(value, max = 600) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .replace(/[—–―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sourceKey(value) {
  return cleanText(value, 400)
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ");
}

function termExistsInSource(term, source) {
  const needle = sourceKey(term);
  if (needle.length < 2) return false;
  const haystack = sourceKey(source);
  let index = haystack.indexOf(needle);
  const wordish = (char) => !!char && /[\p{L}\p{N}]/u.test(char);
  while (index !== -1) {
    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] || "";
    if (!wordish(before) && !wordish(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function normalizePairs(items, limit) {
  return (Array.isArray(items) ? items : [])
    .slice(0, limit)
    .map((item) => ({
      en: cleanText(item && item.en, 320),
      ko: cleanText(item && item.ko, 320),
    }))
    .filter((item) => item.en && item.ko);
}

function normalizeEntry(raw, { allowedKinds, pageText, pageNumbers, pageTexts, fallbackSection }) {
  const term = cleanText(raw && raw.term, 120);
  const kind = ALLOWED_KINDS.has(raw && raw.kind) ? raw.kind : "core";
  if (!allowedKinds.has(kind) || !termExistsInSource(term, pageText)) return null;
  const requestedPage = Math.trunc(Number(raw && raw.source_page));
  const matchingSourcePages = Array.isArray(pageTexts)
    ? pageTexts.filter((page) => termExistsInSource(term, page && page.text))
    : (pageNumbers || []).map((number) => ({ number, label: `PDF ${number}쪽` }));
  const matchingPages = matchingSourcePages.map((page) => page.number);
  if (!matchingPages.length) return null;
  const sourcePage = matchingPages.includes(requestedPage) ? requestedPage : matchingPages[0];
  const examples = normalizePairs(raw && raw.examples, 2);
  if (examples.length < 2 || examples.some((item) => !termExistsInSource(term, item.en))) return null;
  return {
    kind,
    section: cleanText(raw && raw.section, 40) || fallbackSection,
    term,
    part_of_speech: ALLOWED_POS.has(raw && raw.part_of_speech) ? raw.part_of_speech : kind === "phrase" ? "구" : "명",
    pronunciation: cleanText(raw && raw.pronunciation, 120),
    meaning: cleanText(raw && raw.meaning, 160),
    definition_ko: cleanText(raw && raw.definition_ko, 420),
    study_note_ko: cleanText(raw && raw.study_note_ko, 420),
    source_page: sourcePage,
    source_label: cleanText(matchingSourcePages.find((page) => page.number === sourcePage)?.label, 160) || `PDF ${sourcePage}쪽`,
    examples,
    related: normalizePairs(raw && raw.related, 2).filter((item) => termExistsInSource(item.en, pageText)),
  };
}

function mergeUsage(target, usage) {
  const out = target || {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const source = usage || {};
  for (const key of Object.keys(out)) out[key] += Math.max(0, Number(source[key]) || 0);
  return out;
}

async function mapLimit(items, limit, fn, signal) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function chunkPages(pages, size) {
  const chunks = [];
  for (let index = 0; index < pages.length; index += size) chunks.push(pages.slice(index, index + size));
  return chunks;
}

function kindsInstruction(input) {
  const parts = [];
  if (input.includeCore) parts.push("core(핵심 용어)");
  if (input.includeAcademic) parts.push("academic(학술 어휘)");
  if (input.includePhrases) parts.push("phrase(문제 풀이 표현)");
  return parts.join(", ");
}

function unitPrompt(pages, input, unitNumber) {
  const source = pages.map((page) => `[[SOURCE ${page.number}: ${page.label || `출처 ${page.number}`}]]\n${page.text}`).join("\n\n");
  return `이 자료 묶음에서 단어장 항목 ${input.termCount}개를 고르세요.

묶음 번호: ${unitNumber}
허용 종류: ${kindsInstruction(input)}
발음 표기: ${input.includePronunciation ? "작성" : "pronunciation은 빈 문자열"}
원문에 정확히 나타난 term만 선택하고 source_page에는 SOURCE 번호를 정확히 적으세요.

=== 영어 자료 원문 시작 ===
${source}
=== 영어 자료 원문 끝 ===`;
}

async function generateUnit(pages, input, unitNumber, { model, signal }) {
  const pageText = pages.map((page) => page.text).join("\n");
  const pageNumbers = pages.map((page) => page.number);
  const allowedKinds = new Set([
    ...(input.includeCore ? ["core"] : []),
    ...(input.includeAcademic ? ["academic"] : []),
    ...(input.includePhrases ? ["phrase"] : []),
  ]);
  const response = await callModelJson({
    model,
    system: SYSTEM_PROMPT,
    userText: unitPrompt(pages, input, unitNumber),
    maxTokens: Math.min(18000, Math.max(7000, input.termCount * 520)),
    signal,
  });
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(response.data.entries) ? response.data.entries : []) {
    const entry = normalizeEntry(raw, {
      allowedKinds,
      pageText,
      pageNumbers,
      pageTexts: pages,
      fallbackSection: `U${unitNumber}`,
    });
    if (!entry) continue;
    const key = sourceKey(entry.term).replace(/s$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= input.termCount) break;
  }
  const minimumEntries = input.sourceKind === "pdf" ? Math.min(8, input.termCount) : 1;
  if (entries.length < minimumEntries) {
    throw new Error(
      `${pages[0].label}-${pages.at(-1).label}에서 출처가 확인된 어휘가 ${entries.length}개뿐입니다. 영어 원문이나 표 구성을 확인해 주세요.`,
    );
  }
  return {
    number: unitNumber,
    title_en: cleanText(response.data.title_en, 120) || `Source ${pageNumbers[0]}-${pageNumbers.at(-1)}`,
    title_ko: cleanText(response.data.title_ko, 120) || `자료 ${pageNumbers[0]}-${pageNumbers.at(-1)}`,
    page_start: pageNumbers[0],
    page_end: pageNumbers.at(-1),
    entries,
    requested_entries: input.termCount,
    usage: response.usage || {},
  };
}

async function generateReportContent({
  sourceFile,
  title,
  pageRange,
  pagesPerUnit,
  termCount,
  includeCore,
  includeAcademic,
  includePhrases,
  includePronunciation,
  includeReview,
  includeMemo,
  designStyle,
  model,
  signal,
  onProgress = () => {},
}) {
  onProgress("📖 영어 교재·단어장 자료의 출처 구조를 읽는 중...");
  const extracted = await extractVocabularySource(sourceFile, {
    pageRange,
    maxPages: MAX_PAGES,
    signal,
  });
  const minimumSourceLength = extracted.kind === "pdf" ? 40 : 2;
  const textPages = extracted.pages.filter((page) => page.text && page.text.length >= minimumSourceLength);
  if (!textPages.length) {
    throw new Error("선택한 자료에서 읽을 수 있는 영어 단어나 문장을 찾지 못했습니다. 스캔 PDF는 먼저 OCR해 주세요.");
  }
  const skippedPages = extracted.pages.filter((page) => !page.text || page.text.length < minimumSourceLength).map((page) => page.number);
  const units = chunkPages(textPages, pagesPerUnit);
  const sourceCountLabel = extracted.kind === "pdf" ? `${extracted.page_count}쪽 중 ${extracted.selected_pages.length}쪽 선택` : `출처 단위 ${textPages.length}개 확인`;
  onProgress(`✓ ${sourceCountLabel} · ${units.length}개 묶음`);
  let finished = 0;
  const generated = await mapLimit(
    units,
    CONCURRENCY,
    async (pages, index) => {
      onProgress(`🧠 묶음 ${index + 1}/${units.length} 어휘 선별 중 (${pages[0].label}${pages.length > 1 ? ` ~ ${pages.at(-1).label}` : ""})`);
      const unit = await generateUnit(
        pages,
        {
          termCount,
          includeCore,
          includeAcademic,
          includePhrases,
          includePronunciation,
          sourceKind: extracted.kind,
        },
        index + 1,
        { model, signal },
      );
      finished += 1;
      onProgress(`✓ 묶음 ${finished}/${units.length} 완료 · 출처 확인 어휘 ${unit.entries.length}개`);
      return unit;
    },
    signal,
  );

  let usage = null;
  for (const unit of generated) usage = mergeUsage(usage, unit.usage);
  for (const unit of generated) delete unit.usage;
  const warnings = [...(extracted.warnings || [])];
  if (skippedPages.length) {
    const skippedLabels = extracted.pages.filter((page) => skippedPages.includes(page.number)).map((page) => page.label);
    warnings.push(`텍스트가 거의 없는 출처 ${skippedLabels.slice(0, 12).join(", ")}${skippedLabels.length > 12 ? " 외" : ""}는 어휘 선별에서 제외했습니다.`);
  }
  for (const unit of generated) {
    if (unit.entries.length < termCount) {
      warnings.push(`묶음 ${unit.number}은 원문 출처가 확인된 항목 ${unit.entries.length}개만 수록했습니다(요청 ${termCount}개).`);
    }
  }
  const resolvedTitle = cleanText(title, 160) || cleanText(extracted.title, 160) || sourceFile.name.replace(/\.[^.]+$/i, "");
  const content = {
    title: resolvedTitle,
    book: {
      title: resolvedTitle,
      subtitle: "VOCABULARY",
      source_line: extracted.source_line,
      publisher_line: "ENGLISH-KOREAN TEXTBOOK STUDY EDITION",
      author: "Quilo",
    },
    chapters: generated,
    options: {
      include_pronunciation: !!includePronunciation,
      include_review: !!includeReview,
      include_memo: !!includeMemo,
      design_style: normalizeVocabularyDesign(designStyle),
    },
    source: {
      filename: sourceFile.name,
      kind: extracted.kind,
      total_pages: extracted.kind === "pdf" ? extracted.page_count : undefined,
      total_units: extracted.total_units,
      selected_pages: extracted.selected_pages,
      source_labels: textPages.map((page) => page.label),
    },
    data_warnings: warnings,
    __usage: usage,
    __cost: calcCost({ usage: usage || {}, model }),
  };
  return content;
}

module.exports = {
  MAX_PAGES,
  cleanText,
  sourceKey,
  termExistsInSource,
  normalizeEntry,
  generateReportContent,
};
