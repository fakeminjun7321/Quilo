// 생성 산출물 검증 유틸.
//
// 1) assertGeneratedOutputMagic(): magic byte 검사(기존 동작 그대로).
//    형식이 아예 다른 버퍼가 사용자에게 내려가는 것을 막는 최소 관문으로, 실패 시 throw 한다.
// 2) validateReportArtifact(): 저장 직전 심층 검사(W2-C/DEF-011).
//    zip을 열어 문서 본문 XML에서 수식 raw 마커, 긴 대시(U+2014류), 인코딩 깨짐
//    문자(U+FFFD)를 스캔하고, HWPX는 Contents/content.hpf 가 참조하는 BinData 항목이
//    zip 안에 실제로 존재하는지까지 확인한다.
//    이 함수는 절대 throw 하지 않고 { ok, problems } 만 반환한다. 경고로 둘지 생성
//    실패로 승격할지는 호출부(server.js runGeneration) 정책이다.
//
// 설계 근거(성능): 산출물은 이미지가 들어가면 수 MB에 이르지만, 검사 대상은 압축을
// 푼 본문 XML 텍스트 몇 개뿐이다(보통 수십~수백 KB). 전체 텍스트에 복잡한 정규식을
// 돌리는 대신 고정 부분 문자열 indexOf 스캔(패턴당 1 pass, 전체 O(n))만 사용해 대형
// 문서에서도 수십 ms 안에 끝나게 한다. 정규식은 작은 manifest(content.hpf) 파싱과
// 엔트리 이름 매칭에만 제한적으로 쓴다.
// 한계(의도된 트레이드오프): 마커가 여러 XML 텍스트 런으로 쪼개져 저장되는 극단적
// 경우는 잡지 못한다. 생성기는 마커를 한 텍스트 노드에 통째로 쓰므로 실사용에서는
// 연속 문자열 검색으로 충분하다.

const JSZip = require("jszip");
const path = require("path");

const ZIP_FAMILY = new Set(["docx", "hwpx", "zip"]);
const PDF_MAGIC = Buffer.from("%PDF-");
const PDF_EOF = Buffer.from("%%EOF");
const OUTPUT_MIME_TYPES = Object.freeze({
  pdf: "application/pdf",
  zip: "application/zip",
  hwpx: "application/hwp+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
});

// 수식 postprocess 가 남기면 안 되는 raw 마커(M1급). CLAUDE.md 금지 목록과 동일 계열.
const RAW_EQUATION_MARKERS = [
  "{{EQN-LATEX:",
  "{{EQ-LATEX:",
  "{{EQN:",
  "{{EQ:",
  "{{MATH:",
  "{{FORMULA:",
  "[[수식",
];

// 보고서 출력에 금지된 긴 대시 계열(2026-07-03 지시). 소스에 리터럴로 넣지 않도록
// 전부 유니코드 escape 로만 표기한다.
const LONG_DASH_CHARS = [
  { ch: "\u2014", label: "U+2014" },
  { ch: "\u2013", label: "U+2013" },
  { ch: "\u2015", label: "U+2015" },
];

const REPLACEMENT_CHAR = "\uFFFD";

// 사용자에게 전달하면 안 되는 치명적 산출물 결함. 핵심 보고서 파이프라인은
// 별도 환경변수 없이 이 규칙들을 fail-closed로 처리한다. 긴 대시와 U+FFFD는
// 문서 구조를 깨뜨리는 결함은 아니므로 계속 경고로만 남긴다.
const ENFORCEABLE_RULES = new Set([
  "raw-marker",
  "empty-output",
  "zip-open",
  "entry-missing",
  "bindata-missing",
  "pdf-structure",
  "validator-error",
]);

const FAIL_CLOSED_REPORT_TYPES = new Set([
  "chem-pre",
  "chem-result",
  "phys-result",
  "print-pdf-restore",
]);

function findEnforceableArtifactProblem(
  validation,
  { type = "", enforceAll = false } = {},
) {
  if (!enforceAll && !FAIL_CLOSED_REPORT_TYPES.has(String(type || ""))) {
    return null;
  }
  const problems = Array.isArray(validation?.problems)
    ? validation.problems
    : [];
  return problems.find((problem) =>
    ENFORCEABLE_RULES.has(String(problem?.rule || "")),
  ) || null;
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function assertGeneratedOutputMagic(value, kind, label = "generated output") {
  const buffer = asBuffer(value);
  const normalizedKind = String(kind || "").replace(/^\./, "").toLowerCase();

  if (!buffer || buffer.length === 0) {
    throw new Error(`${label} validation failed: output is empty.`);
  }

  if (ZIP_FAMILY.has(normalizedKind)) {
    if (buffer.length < 2 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error(
        `${label} validation failed: expected ${normalizedKind} output to start with PK.`,
      );
    }
    return buffer;
  }

  if (normalizedKind === "pdf") {
    if (
      buffer.length < PDF_MAGIC.length ||
      !buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)
    ) {
      throw new Error(
        `${label} validation failed: expected PDF output to start with %PDF-.`,
      );
    }
    return buffer;
  }

  throw new Error(
    `${label} validation failed: unsupported output kind "${kind}".`,
  );
}

// 기존 assertGeneratedOutputMagic의 하위호환 계약은 magic byte까지만 유지한다.
// 새 단일 PDF 산출물 경로에서는 별도의 stricter postflight로 잘린 PDF를 차단한다.
function assertCompletePdf(value, label = "PDF artifact") {
  const buffer = assertGeneratedOutputMagic(value, "pdf", label);
  const tailStart = Math.max(0, buffer.length - 16 * 1024);
  if (buffer.subarray(tailStart).indexOf(PDF_EOF) === -1) {
    throw new Error(
      `${label} validation failed: PDF output is missing a trailing %%EOF marker.`,
    );
  }
  return buffer;
}

function safeArtifactFilename(value, fallback, kind) {
  const ext = String(kind || "").replace(/^\./, "").toLowerCase();
  const raw = path
    .basename(String(value || fallback || `result.${ext}`))
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  const withoutExt = raw.replace(/\.[A-Za-z0-9]{1,12}$/u, "").trim();
  const stem = (withoutExt || "result").slice(0, 150);
  return `${stem}.${ext}`;
}

/**
 * Buffer 또는 `{buffer, filename, mimeType, qa}` 형태의 생성기 결과를 서버가
 * 저장할 수 있는 단일 산출물 계약으로 정규화한다. 생성기가 주장한 MIME type은
 * 신뢰하지 않고 실제 output kind에 맞는 값으로 고정한다.
 */
function normalizeGeneratedArtifact(value, opts = {}) {
  const kind = String(opts.kind || "").replace(/^\./, "").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(OUTPUT_MIME_TYPES, kind)) {
    throw new Error(`generated artifact validation failed: unsupported output kind "${opts.kind}".`);
  }
  const artifact = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? { buffer: value }
    : value && typeof value === "object"
      ? value
      : {};
  const label = opts.label || `.${kind} output`;
  const buffer = kind === "pdf"
    ? assertCompletePdf(artifact.buffer, label)
    : assertGeneratedOutputMagic(artifact.buffer, kind, label);
  return {
    buffer,
    filename: safeArtifactFilename(
      artifact.filename,
      opts.fallbackFilename || `result.${kind}`,
      kind,
    ),
    mimeType: OUTPUT_MIME_TYPES[kind],
    qa: artifact.qa && typeof artifact.qa === "object" ? artifact.qa : null,
  };
}

function countOccurrences(text, needle) {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}

// 로그 가독용 발췌: 첫 발견 지점 주변만 잘라 XML 태그를 걷어낸다(작은 창이라 저렴).
function excerptAround(text, idx, needleLength) {
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + needleLength + 60);
  return text
    .slice(start, end)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// 본문 XML 텍스트 1개를 스캔해 problems 배열에 누적한다.
function scanDocumentXml(entryName, text, problems) {
  for (const marker of RAW_EQUATION_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx === -1) continue;
    problems.push({
      rule: "raw-marker",
      detail: `${entryName}: 수식 raw 마커 "${marker}" ${countOccurrences(text, marker)}회 잔존 (예: ${excerptAround(text, idx, marker.length)})`,
    });
  }
  for (const { ch, label } of LONG_DASH_CHARS) {
    const idx = text.indexOf(ch);
    if (idx === -1) continue;
    problems.push({
      rule: "long-dash",
      detail: `${entryName}: 긴 대시(${label}) ${countOccurrences(text, ch)}회`,
    });
  }
  const idx = text.indexOf(REPLACEMENT_CHAR);
  if (idx !== -1) {
    problems.push({
      rule: "replacement-char",
      detail: `${entryName}: 인코딩 깨짐 문자(U+FFFD) ${countOccurrences(text, REPLACEMENT_CHAR)}회`,
    });
  }
}

// content.hpf manifest 의 BinData href 가 zip 에 실존하는지 확인한다.
// href 는 패키지 루트 기준("BinData/image1.jpg")이 관례지만, 방어적으로
// "Contents/" 접두 경로도 허용한다.
function checkHwpxBinData(manifestText, entryNameSet, problems) {
  const re = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(manifestText)) !== null) {
    const href = (m[1] != null ? m[1] : m[2]) || "";
    if (!href.startsWith("BinData/")) continue;
    if (entryNameSet.has(href) || entryNameSet.has(`Contents/${href}`)) continue;
    problems.push({
      rule: "bindata-missing",
      detail: `content.hpf가 참조하는 BinData 항목이 zip에 없음: ${href}`,
    });
  }
}

/**
 * 생성 산출물 심층 검사. throw 하지 않는다.
 *
 * @param {Buffer|Uint8Array} value 산출물 버퍼
 * @param {{format?: string, type?: string}} opts
 *   format: "hwpx" | "docx"는 패키지 본문을, "pdf"는 magic+EOF 구조를 검사한다.
 *   그 외(zip 번들 등)는 범위 밖으로 보고 문제 없음으로 통과시킨다.
 *   type(보고서 타입)은 지금은 규칙 분기에 쓰지 않고,
 *   향후 타입별 규칙 확장을 위해 시그니처에만 받아둔다.
 * @returns {Promise<{ok: boolean, problems: Array<{rule: string, detail: string}>}>}
 */
async function validateReportArtifact(value, opts = {}) {
  const problems = [];
  const format = String(opts.format || "").replace(/^\./, "").toLowerCase();
  try {
    const buffer = asBuffer(value);
    if (!buffer || buffer.length === 0) {
      problems.push({ rule: "empty-output", detail: "산출물 버퍼가 비어 있습니다." });
      return { ok: false, problems };
    }
    if (format === "pdf") {
      try {
        assertCompletePdf(buffer, "PDF artifact");
      } catch (e) {
        problems.push({
          rule: "pdf-structure",
          detail: String((e && e.message) || e).slice(0, 240),
        });
      }
      return { ok: problems.length === 0, problems };
    }
    if (format !== "hwpx" && format !== "docx") {
      return { ok: true, problems };
    }

    let zip;
    try {
      zip = await JSZip.loadAsync(buffer);
    } catch (e) {
      problems.push({
        rule: "zip-open",
        detail: `zip 파싱 실패: ${String((e && e.message) || e).slice(0, 160)}`,
      });
      return { ok: false, problems };
    }

    const entryNames = Object.keys(zip.files);
    const entryNameSet = new Set(entryNames);

    if (format === "hwpx") {
      const sections = entryNames
        .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
        .sort();
      if (!sections.length) {
        problems.push({
          rule: "entry-missing",
          detail: "Contents/section*.xml 이 없습니다.",
        });
      }
      for (const name of sections) {
        const text = await zip.file(name).async("string");
        scanDocumentXml(name, text, problems);
      }
      const hpf = zip.file("Contents/content.hpf");
      if (!hpf) {
        problems.push({
          rule: "entry-missing",
          detail: "Contents/content.hpf 가 없습니다.",
        });
      } else {
        checkHwpxBinData(await hpf.async("string"), entryNameSet, problems);
      }
    } else {
      const doc = zip.file("word/document.xml");
      if (!doc) {
        problems.push({
          rule: "entry-missing",
          detail: "word/document.xml 이 없습니다.",
        });
      } else {
        scanDocumentXml("word/document.xml", await doc.async("string"), problems);
      }
    }
  } catch (e) {
    // 계약: 이 함수는 어떤 경우에도 throw 하지 않고 검사기 자체 오류도 문제
    // 목록으로 반환한다. 핵심 보고서 호출부는 validator-error를 fail-closed로 처리한다.
    problems.push({
      rule: "validator-error",
      detail: `검사기 내부 오류: ${String((e && e.message) || e).slice(0, 160)}`,
    });
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  assertGeneratedOutputMagic,
  assertCompletePdf,
  normalizeGeneratedArtifact,
  validateReportArtifact,
  ENFORCEABLE_RULES,
  FAIL_CLOSED_REPORT_TYPES,
  findEnforceableArtifactProblem,
};
