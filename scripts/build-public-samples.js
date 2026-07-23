#!/usr/bin/env node
"use strict";

// 개인정보가 없는 합성 파이프라인 픽스처를 운영 DOCX 렌더러로 변환한다.
// 외부 API나 사용자 저장소를 호출하지 않으며 public/examples/samples만 갱신한다.

const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const fixtures = require("../tests/pipelines/helpers/content-fixtures");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "public", "examples", "samples");
const PUBLIC_RENDER = Object.freeze({
  studentId: "",
  studentName: "",
  temperature: "",
  pressure: "",
  date: "2026-01-15",
  fontFace: "Malgun Gothic",
});

const SAMPLES = Object.freeze([
  {
    type: "chem-pre",
    renderer: "../lib/pipelines/chem-pre/docx-gen",
    output: "chem-pre.docx",
  },
  {
    type: "chem-result",
    renderer: "../lib/pipelines/chem-result/docx-gen",
    output: "chem-result.docx",
  },
  {
    type: "phys-result",
    renderer: "../lib/pipelines/phys-result/docx-gen",
    output: "phys-result.docx",
  },
]);

const RAW_MARKER = /\{\{(?:EQ|EQN|MATH|FORMULA)[:-]/;

function markAsPublicSample(type, content) {
  if (type === "chem-pre") {
    content.title_kr = `${content.title_kr} (공개 예시)`;
    for (const chemical of content.chemicals || []) delete chemical.source_url;
    content.references = [{ label: "일반화학실험 표준 교재 (합성 예시 자료)" }];
  } else if (type === "chem-result") {
    content.discussion = content.discussion || {};
    content.discussion.analysis = [
      "이 문서의 수치와 관찰 내용은 공개 기능 확인을 위해 구성한 합성 예시이다.",
      ...(content.discussion.analysis || []),
    ];
  } else if (type === "phys-result") {
    content.title = `${content.title} (공개 예시)`;
    content.conclusion = content.conclusion || {};
    content.conclusion.objective_recap =
      "이 문서의 측정값은 공개 기능 확인을 위해 구성한 합성 예시이며, Atwood 기계에서 질량 차이와 가속도의 관계를 확인하는 형식을 보여 준다.";
  }
}

function xmlText(xml) {
  return String(xml || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

async function scrubDocxMetadata(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const core = zip.file("docProps/core.xml");
  if (core) {
    const xml = await core.async("string");
    zip.file(
      "docProps/core.xml",
      xml
        .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/g, "<dc:creator></dc:creator>")
        .replace(
          /<cp:lastModifiedBy>[\s\S]*?<\/cp:lastModifiedBy>/g,
          "<cp:lastModifiedBy></cp:lastModifiedBy>",
        ),
    );
  }
  const app = zip.file("docProps/app.xml");
  if (app) {
    const xml = await app.async("string");
    zip.file(
      "docProps/app.xml",
      xml.replace(/<Company>[\s\S]*?<\/Company>/g, "<Company></Company>"),
    );
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function verifyDocx(buffer, sample, expectedText) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2_000) {
    throw new Error(`${sample.output}: DOCX buffer가 비정상적으로 작습니다.`);
  }
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") {
    throw new Error(`${sample.output}: ZIP/DOCX 매직이 없습니다.`);
  }

  const zip = await JSZip.loadAsync(buffer);
  for (const required of ["[Content_Types].xml", "word/document.xml"]) {
    if (!zip.file(required)) throw new Error(`${sample.output}: ${required}가 없습니다.`);
  }
  const documentXml = await zip.file("word/document.xml").async("string");
  const text = xmlText(documentXml);
  if (RAW_MARKER.test(text)) {
    throw new Error(`${sample.output}: 사용자에게 노출되는 raw 수식 마커가 남았습니다.`);
  }
  for (const expected of expectedText) {
    if (!text.includes(expected)) {
      throw new Error(`${sample.output}: 기대 본문이 없습니다: ${JSON.stringify(expected)}`);
    }
  }
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(text)) {
    throw new Error(`${sample.output}: 공개 샘플에 이메일 형태 문자열이 있습니다.`);
  }
  const metadata = await Promise.all(
    ["docProps/core.xml", "docProps/app.xml"]
      .filter((name) => zip.file(name))
      .map((name) => zip.file(name).async("string")),
  );
  if (
    metadata.some(
      (xml) =>
        /<(?:dc:creator|cp:lastModifiedBy|Company)>\s*[^<\s][^<]*<\//.test(xml),
    )
  ) {
    throw new Error(`${sample.output}: 공개 샘플에 작성자 메타데이터가 남았습니다.`);
  }
}

async function buildSample(sample) {
  const { meta, content } = fixtures.loadFixture(sample.type, { prepare: false });
  markAsPublicSample(sample.type, content);
  fixtures.prepareContentForRender(content, PUBLIC_RENDER);
  const { generateDocx } = require(sample.renderer);
  const buffer = await scrubDocxMetadata(await generateDocx(content));
  await verifyDocx(buffer, sample, meta.expect?.docxIncludes || []);

  const destination = path.join(OUTPUT_DIR, sample.output);
  const temporary = `${destination}.tmp`;
  fs.writeFileSync(temporary, buffer);
  fs.renameSync(temporary, destination);
  return { output: sample.output, bytes: buffer.length };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const built = [];
  try {
    for (const sample of SAMPLES) built.push(await buildSample(sample));
  } finally {
    for (const sample of SAMPLES) {
      const temporary = path.join(OUTPUT_DIR, `${sample.output}.tmp`);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  for (const result of built) {
    console.log(`built ${result.output} (${result.bytes.toLocaleString("en-US")} bytes)`);
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
