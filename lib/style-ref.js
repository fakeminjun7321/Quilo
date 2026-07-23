// 공통 "내 글 스타일" 헬퍼.
//
// 모든 보고서 파이프라인(chem-pre/chem-result/phys-result/phys-inquiry)에서
// 사용자가 올린 글 샘플(또는 문체 메모)을 받아, 그 사람의 "문체"만 흉내 내도록
// Claude 입력 블록과 시스템 프롬프트 섹션을 만든다.
//
// 핵심 안전 규칙: 샘플의 "내용/주제/수치/데이터/수식/예시"는 절대 보고서로 가져오지
// 않는다. 오직 "어떻게 쓰는가(문체)"만 흉내 낸다.

const JSZip = require("jszip");
const {
  prepareImageForAnthropic,
  toAnthropicImageBlock,
  getBatchImageOptions,
} = require("./anthropic-media");
const { inspectZipArchive } = require("./zip-resource-limits");

const STYLE_REF_EXTS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "txt",
  "md",
  "csv",
  "hwpx",
];

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}

function refName(f) {
  return (f && (f.name || f.originalname)) || "";
}

function isPdf(f) {
  return fileExt(refName(f)) === "pdf" || f.mimetype === "application/pdf";
}

function isText(f) {
  return ["txt", "md", "csv", "tsv"].includes(fileExt(refName(f)));
}

function isHwpx(f) {
  return (
    fileExt(refName(f)) === "hwpx" ||
    /hwpx|hwp\+zip/i.test(String((f && f.mimetype) || ""))
  );
}

function isImage(f) {
  return (
    ["png", "jpg", "jpeg", "gif", "webp"].includes(fileExt(refName(f))) ||
    String(f.mimetype || "").startsWith("image/")
  );
}

// ── HWPX 스타일 분석 ──────────────────────────────────────────────────────────
// .hwpx(ZIP)을 풀어 ① 본문 텍스트(문체 흉내용) ② 지배 글꼴·글자 크기를 추출한다.
// header.xml 의 <hh:font face>·<hh:charPr height><hh:fontRef hangul> +
// section*.xml 의 <hp:run charPrIDRef> 텍스트량으로 "가장 많이 쓰인" 글꼴을 고른다.
function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

// zip-bomb 방어: 업로드 64MB 제한(multer)은 '압축본' 크기만 막고, .hwpx(ZIP)을
// 풀어 header.xml/section*.xml 을 통째로 문자열화하면 해제 후 메모리는 못 막는다.
// 항목별/누적 압축 해제 크기에 보수적 상한을 둔다. cap-parser.js 의 방식과 동일.
const STYLE_HWPX_ENTRY_MAX = 32 * 1024 * 1024; // 엔트리 1개당 해제 상한
const STYLE_HWPX_DECOMP_MAX = 64 * 1024 * 1024; // 누적 해제 상한
const STYLE_HWPX_COMPRESSED_MAX = 64 * 1024 * 1024;
const STYLE_HWPX_ARCHIVE_DECLARED_MAX = 256 * 1024 * 1024;
const STYLE_HWPX_MAX_ENTRIES = 400;
const STYLE_HWPX_MAX_COMPRESSION_RATIO = 200;
const STYLE_HWPX_RATIO_MIN_BYTES = 1024 * 1024;

class HwpxTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "HwpxTooLargeError";
    this.tooLarge = true;
    this.code = "STYLE_HWPX_UNSAFE";
  }
}

class HwpxArchiveError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "HwpxArchiveError";
    this.code = "STYLE_HWPX_INVALID";
  }
}

function hwpxSafetyError(detail) {
  return new HwpxTooLargeError(
    `스타일 참고 .hwpx 파일을 안전하게 처리할 수 없습니다(${detail}). 파일을 줄이거나 정상 HWPX로 다시 저장해 주세요.`,
  );
}

function readHwpxEntryGuarded(file, meta, state) {
  if (!file || file.dir) return Promise.resolve("");
  if (!meta) return Promise.reject(hwpxSafetyError("ZIP 항목 정보 불일치"));
  if (meta.uncompressedSize > STYLE_HWPX_ENTRY_MAX) {
    return Promise.reject(hwpxSafetyError("내부 XML 크기 초과"));
  }
  if (
    meta.uncompressedSize >= STYLE_HWPX_RATIO_MIN_BYTES &&
    (meta.compressedSize === 0 ||
      meta.uncompressedSize / meta.compressedSize > STYLE_HWPX_MAX_COMPRESSION_RATIO)
  ) {
    return Promise.reject(hwpxSafetyError("비정상 압축률"));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let entryBytes = 0;
    let settled = false;
    let stream;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      try {
        stream?.destroy();
      } catch {
        /* ignore */
      }
      reject(error);
    };

    try {
      stream = file.nodeStream("nodebuffer");
    } catch (error) {
      reject(error);
      return;
    }
    stream.on("data", (chunk) => {
      if (settled) return;
      entryBytes += chunk.length;
      state.totalBytes += chunk.length;
      if (
        entryBytes > STYLE_HWPX_ENTRY_MAX ||
        state.totalBytes > STYLE_HWPX_DECOMP_MAX
      ) {
        fail(hwpxSafetyError("실제 압축 해제 크기 초과"));
        return;
      }
      if (
        entryBytes >= STYLE_HWPX_RATIO_MIN_BYTES &&
        (meta.compressedSize === 0 ||
          entryBytes / meta.compressedSize > STYLE_HWPX_MAX_COMPRESSION_RATIO)
      ) {
        fail(hwpxSafetyError("실제 압축률 초과"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", fail);
    stream.on("end", () => {
      if (settled) return;
      if (entryBytes !== meta.uncompressedSize) {
        fail(hwpxSafetyError("선언 크기와 실제 크기 불일치"));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks, entryBytes).toString("utf8"));
    });
    stream.resume();
  });
}

async function analyzeHwpxUncached(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HwpxArchiveError("스타일 참고 .hwpx 파일이 비어 있거나 올바른 파일이 아닙니다.");
  }
  if (buffer.length > STYLE_HWPX_COMPRESSED_MAX) {
    throw hwpxSafetyError("압축 파일 크기 초과");
  }

  let inspected;
  try {
    inspected = inspectZipArchive(buffer, {
      maxEntries: STYLE_HWPX_MAX_ENTRIES,
      maxEntryUncompressedBytes: STYLE_HWPX_ARCHIVE_DECLARED_MAX,
      maxTotalUncompressedBytes: STYLE_HWPX_ARCHIVE_DECLARED_MAX,
      maxCompressionRatio: STYLE_HWPX_MAX_COMPRESSION_RATIO,
      ratioMinOutputBytes: STYLE_HWPX_RATIO_MIN_BYTES,
    });
  } catch (error) {
    throw hwpxSafetyError(error && error.message ? error.message : "ZIP 구조 오류");
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (error) {
    throw new HwpxArchiveError(
      `스타일 참고 .hwpx 파일을 열 수 없습니다: ${error.message}`,
      error,
    );
  }
  const entryMeta = new Map(inspected.entries.map((entry) => [entry.name, entry]));
  const state = { totalBytes: 0 };
  const readEntry = (file, name) =>
    readHwpxEntryGuarded(file, entryMeta.get(name), state);

  const headerFile = zip.file("Contents/header.xml");
  const secNames = Object.keys(zip.files)
    .filter((n) => /Contents\/section\d+\.xml$/i.test(n))
    .sort();
  if (!headerFile || secNames.length === 0) {
    throw new HwpxArchiveError(
      "스타일 참고 파일에 필수 HWPX 문서 항목(header.xml/section.xml)이 없습니다.",
    );
  }
  let header;
  const sectionParts = [];
  try {
    header = await readEntry(headerFile, "Contents/header.xml");
    for (const name of secNames) {
      sectionParts.push(await readEntry(zip.file(name), name));
    }
  } catch (error) {
    if (error && error.code === "STYLE_HWPX_UNSAFE") throw error;
    throw new HwpxArchiveError(
      `스타일 참고 .hwpx 내부 문서를 읽을 수 없습니다: ${error.message}`,
      error,
    );
  }
  const sectionXml = sectionParts.join("");

  // font id -> face
  const fontMap = {};
  let m;
  const fontRe = /<(?:\w+:)?font\b[^>]*\bid="(\d+)"[^>]*\bface="([^"]*)"/gi;
  while ((m = fontRe.exec(header))) if (!(m[1] in fontMap)) fontMap[m[1]] = m[2];

  // charPr id -> {height(1/100 pt), hangulFontId, bold}
  const charPr = {};
  const cpRe = /<(?:\w+:)?charPr\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?charPr>/gi;
  while ((m = cpRe.exec(header))) {
    const attrs = m[1];
    const inner = m[2];
    const id = (attrs.match(/\bid="(\d+)"/) || [])[1];
    const height = parseInt((attrs.match(/\bheight="(\d+)"/) || [])[1] || "0", 10);
    const hangul = (inner.match(/<(?:\w+:)?fontRef\b[^>]*\bhangul="(\d+)"/) || [])[1];
    // 굵게: <hh:bold/> 자식 또는 bold="1" 속성. value="0" 은 굵게 아님.
    const bold =
      /<(?:\w+:)?bold\b(?![^>]*\bvalue="0")/i.test(inner) ||
      /\bbold="(?:1|true)"/i.test(attrs);
    if (id != null) charPr[id] = { height, hangul, bold };
  }

  // section runs: charPrIDRef -> 누적 텍스트 길이, 본문 텍스트
  const weight = {};
  let bodyText = "";
  const runRe = /<(?:\w+:)?run\b[^>]*\bcharPrIDRef="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?run>/gi;
  while ((m = runRe.exec(sectionXml))) {
    const cpid = m[1];
    const t = [...m[2].matchAll(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/gi)]
      .map((x) => decodeXmlEntities(x[1]))
      .join("");
    weight[cpid] = (weight[cpid] || 0) + t.length;
    bodyText += t + " ";
  }

  // (face, sizePt, bold) 클러스터별 글자수 집계 → 역할 분류(본문/제목/강조)
  const clusters = new Map();
  for (const [cpid, w] of Object.entries(weight)) {
    const cp = charPr[cpid];
    if (!cp) continue;
    const cFace = String(fontMap[cp.hangul] || "").trim();
    if (!cFace) continue;
    const cSize = cp.height ? Math.round(cp.height / 100) : 0;
    const key = `${cFace}|${cSize}|${cp.bold ? 1 : 0}`;
    const ex = clusters.get(key) || { face: cFace, sizePt: cSize, bold: !!cp.bold, chars: 0 };
    ex.chars += w;
    clusters.set(key, ex);
  }
  const totalChars = [...clusters.values()].reduce((a, c) => a + c.chars, 0) || 1;
  const profile = [...clusters.values()]
    .map((c) => ({ ...c, share: Math.round((c.chars / totalChars) * 100) }))
    .sort((a, b) => b.chars - a.chars);

  // 본문 글꼴 = 텍스트량이 가장 많은 클러스터. 클러스터가 하나도 없으면(charPrIDRef
  // run 이 전혀 안 잡힘) header 폰트표의 임의 첫 항목으로 떨어지면 안 된다 — 그건
  // '본문 최다 글꼴'이 아니라 잘못된 글꼴을 출력에 적용하는 거짓 양성이 된다.
  // 그래서 face 를 비워 두고, detectStyleFont 가 감지 글꼴 적용을 건너뛰게 한다.
  const body = profile[0] || { face: "", sizePt: 0, bold: false };
  // 제목/소제목: 본문보다 큰 글꼴 중 가장 많이 쓰인 것(없으면 본문과 다른 굵은 글꼴)
  const heading =
    profile.filter((c) => c !== body && c.sizePt > body.sizePt).sort((a, b) => b.chars - a.chars)[0] ||
    profile.filter((c) => c !== body && (c.bold || c.face !== body.face)).sort((a, b) => b.chars - a.chars)[0] ||
    null;

  bodyText = bodyText.replace(/\s+/g, " ").trim();
  if (bodyText.length > 40000) bodyText = bodyText.slice(0, 40000);
  return {
    face: body.face, // 본문(지배) 글꼴 — 출력 적용용 (back-compat)
    sizePt: body.sizePt,
    bodyFace: body.face,
    bodySizePt: body.sizePt,
    bodyBold: !!body.bold,
    headingFace: heading ? heading.face : "",
    headingSizePt: heading ? heading.sizePt : 0,
    headingBold: heading ? !!heading.bold : false,
    profile, // 전체 글꼴 구성(상세) — 사용자에게 보여줌
    text: bodyText,
  };
}

// buildStyleBlocks와 출력 글꼴 감지가 같은 업로드를 연달아 분석하므로 Buffer 기준
// Promise 캐시로 ZIP 전체를 두 번 열고 푸는 일을 피한다. WeakMap이라 업로드 버퍼가
// 해제되면 분석 결과도 함께 회수된다.
const hwpxAnalysisCache = new WeakMap();
function analyzeHwpx(buffer) {
  if (!Buffer.isBuffer(buffer)) return analyzeHwpxUncached(buffer);
  let pending = hwpxAnalysisCache.get(buffer);
  if (!pending) {
    pending = analyzeHwpxUncached(buffer);
    hwpxAnalysisCache.set(buffer, pending);
  }
  return pending;
}

// 폰트 적용/표시용: styleRefs 중 첫 .hwpx 의 글꼴 프로필(본문·제목·전체 구성) 반환.
async function detectStyleFont(styleRefs = []) {
  for (const f of Array.isArray(styleRefs) ? styleRefs : []) {
    if (!isHwpx(f) || !f.buffer) continue;
    const a = await analyzeHwpx(f.buffer);
    if (a && a.face) {
      return {
        face: a.face,
        sizePt: a.sizePt || 0,
        headingFace: a.headingFace || "",
        headingSizePt: a.headingSizePt || 0,
        headingBold: !!a.headingBold,
        profile: Array.isArray(a.profile) ? a.profile.slice(0, 8) : [],
      };
    }
  }
  return null;
}

function parseStyleText(buffer) {
  const MAX_CHARS = 40000;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const utf8 = buf.toString("utf8");
  let raw = utf8;
  try {
    const eucKr = new TextDecoder("euc-kr").decode(buf);
    const badUtf8 = (utf8.match(/�/g) || []).length;
    const badEucKr = (eucKr.match(/�/g) || []).length;
    if (badEucKr < badUtf8) raw = eucKr;
  } catch {
    /* keep utf-8 */
  }
  const cleaned = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ --]/g, "")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > MAX_CHARS ? cleaned.slice(0, MAX_CHARS) : cleaned;
}

// 시스템 프롬프트에 붙일 문체 흉내 지침. hasStyle 일 때만 붙인다.
const STYLE_SYSTEM_SECTION = `## 문체 흉내 (사용자 글 스타일 반영 — 필수, 강하게)

사용자가 자기 글 샘플(필기·노트·이전 보고서 등) 또는 문체 메모를 제공했습니다. 이 보고서의 **모든 본문 문장**(experiments[].analysis, method_summary, conclusion 각 항목, discussion 등 서술형 전부)을 **그 사람이 직접 쓴 것처럼** 쓰세요. 이건 선택적 참고가 아니라 **반드시 지켜야 하는 작성 규칙**입니다. **기본 보고서 말투로 쓰면 실패**입니다.

샘플에서 다음을 구체적으로 파악한 뒤, 본문 문장에 그대로 적용하세요:
- **종결 어미·어조**: '~다/~이다' 단정형인지, '~습니다' 격식체인지, 구어체인지. 샘플과 **같은 종결·어조로 끝까지 일관되게**.
- **문장 길이·리듬**: 짧게 끊어 쓰는지, 길게 잇는지. 샘플이 단문 위주면 분석 문장도 **단문으로 끊어** 쓴다.
- **문단 여는 방식·전개 순서**: 결론부터 던지는지, 배경부터 까는지(핵심 먼저/나중).
- **연결어·접속 습관**: 자주 쓰는 접속 표현(예: "그런데/결국/즉/한편/솔직히")을 비슷한 빈도로.
- **강조·수사 장치**: 수사의문문, 대조("X가 아니라 Y다"), 핵심 단정, 짚어주기 등 샘플의 장치를 **실제로 살려서** 쓴다.

지킬 것:
- 보고서의 **구조·번호 체계(가./나./(1))·JSON 스키마·표·수식·데이터 값은 그대로 유지**하되, **그 안의 문장 자체를 샘플 말투로** 다시 씁니다(예: '가.' 항목 안의 문장을 샘플처럼 짧고 단정하게).
- **절대 가져오지 말 것**: 샘플의 **주제·내용·수치·실험 데이터·수식·예시·문장 자체**. 샘플이 다른 실험이어도 그 내용은 무시하고 **오직 "어떻게 쓰는가(문체)"만** 흉내 냅니다. "무엇을 쓰는가(내용)"는 이 보고서의 실제 자료·데이터에서만.
- 제출용이므로 정확성·최소 단정함은 유지(욕설·의미 없는 채팅 약어는 절제). 하지만 **그 선 안에서 최대한 그 사람 말투로** — 무난한 표준 보고서체로 되돌아가지 마세요.`;

function hasStyle({ styleRefs = [], styleNote = "" } = {}) {
  return (
    (Array.isArray(styleRefs) && styleRefs.length > 0) ||
    !!String(styleNote || "").trim()
  );
}

// prepareInput 용: 업로드 필드에서 스타일 입력을 읽어 정규화.
function readStyleInput(filesByField = {}, body = {}) {
  const raw = filesByField.styleRefs || [];
  const styleRefs = raw.map((f) => ({
    buffer: f.buffer,
    name: f.originalname,
    mimetype: f.mimetype,
  }));
  return {
    styleRefs,
    styleNote: String(body.styleNote || "").trim().slice(0, 1500),
  };
}

// prepareInput 용: 확장자 검증 (위반 시 throw).
function validateStyleRefs(styleRefs = []) {
  for (const f of styleRefs) {
    const ext = fileExt(f.name || f.originalname || "");
    if (ext === "hwp") {
      throw new Error(
        "구형 .hwp 파일은 지원하지 않습니다. 한글에서 '다른 이름으로 저장 → .hwpx'로 저장한 뒤 올려주세요.",
      );
    }
    if (!STYLE_REF_EXTS.includes(ext)) {
      throw new Error(
        "스타일 참고 자료는 PDF, 이미지(.png/.jpg), 텍스트(.txt/.md/.csv), 한글(.hwpx)만 가능합니다.",
      );
    }
  }
}

// Claude user 메시지에 넣을 스타일 블록 배열을 만든다. (이미지 준비가 있어 async)
async function buildStyleBlocks({ styleRefs = [], styleNote = "" } = {}) {
  if (!hasStyle({ styleRefs, styleNote })) return [];
  const note = String(styleNote || "").trim().slice(0, 1500);
  const blocks = [];
  blocks.push({
    type: "text",
    text: `=== 내 글 스타일 참고 (문체 흉내용 — 매우 중요) ===
아래 자료는 학생 본인이 쓴 글 샘플(또는 문체 메모)입니다. 이 보고서의 **모든 서술형 문장을 이 사람 말투로** 쓰세요(종결어미·문장 길이·어조·연결어·강조/수사 장치까지 적극 반영). **기본 보고서체로 쓰면 안 됩니다.**
중요: 이 샘플의 **주제·내용·수치·수식·예시·문장은 절대 보고서에 가져오지 마세요.** 샘플이 다른 주제·다른 실험이어도 그 내용은 무시하고, 오직 "어떻게 쓰는지(말투·문체)"만 흉내 냅니다.${note ? `\n\n[추가 문체 메모 — 반드시 반영] ${note}` : ""}`,
  });

  const images = [];
  for (const f of Array.isArray(styleRefs) ? styleRefs : []) {
    if (!f || !f.buffer) continue;
    if (isPdf(f)) {
      blocks.push({
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: f.buffer.toString("base64"),
        },
      });
      blocks.push({
        type: "text",
        text: `↑ 위 PDF("${f.name}")는 문체 참고용입니다. 스타일만 흉내 내고 내용은 가져오지 마세요.`,
      });
    } else if (isText(f)) {
      const t = parseStyleText(f.buffer);
      if (t) {
        blocks.push({
          type: "text",
          text: `=== 문체 참고 텍스트 (${refName(f)}) — 스타일만 ===\n${t}\n=== 끝 ===`,
        });
      }
    } else if (isHwpx(f)) {
      const analyzed = await analyzeHwpx(f.buffer);
      if (analyzed && analyzed.text) {
        blocks.push({
          type: "text",
          text: `=== 문체 참고 (한글 .hwpx: ${refName(f)}) — 스타일만 ===\n이 사람이 한글 파일에 실제로 쓴 글입니다. 문장 리듬·어조·설명 방식·구성 습관 등 **문체만** 흉내 내고, 내용·수치·예시는 가져오지 마세요.\n${analyzed.text}\n=== 끝 ===`,
        });
      }
    } else if (isImage(f)) {
      images.push(f);
    }
  }

  if (images.length > 0) {
    const imageOptions = getBatchImageOptions(images.length);
    for (const [i, img] of images.entries()) {
      const prepared = await prepareImageForAnthropic(img, imageOptions);
      blocks.push({
        type: "text",
        text: `=== 문체 참고 이미지 #${i} (${img.name}) — 스타일만 ===`,
      });
      if (prepared.ok) blocks.push(toAnthropicImageBlock(prepared));
    }
  }

  // 마지막에 강한 리마인더 — 모델이 마지막으로 보는 지시가 "그 사람 말투로 써라".
  blocks.push({
    type: "text",
    text: `=== 문체 적용 최종 지시 ===
위 샘플의 **말투·문장 리듬·종결어미·연결어·강조 방식**을 이 보고서의 모든 서술형 문장에 **실제로 적용**해서 쓰세요. 번호 체계(가./나.)·표·수식·데이터 값은 그대로 두되, **그 안의 문장은 위 샘플처럼** 다시 씁니다. 무난한 표준 보고서체로 되돌아가면 실패입니다. (단, 샘플의 내용·수치·예시는 가져오지 않습니다.)`,
  });

  return blocks;
}

module.exports = {
  STYLE_SYSTEM_SECTION,
  hasStyle,
  readStyleInput,
  validateStyleRefs,
  buildStyleBlocks,
  analyzeHwpx,
  detectStyleFont,
};
