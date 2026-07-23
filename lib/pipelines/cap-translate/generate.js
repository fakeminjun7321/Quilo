// PASCO Capstone .cap 번역본 생성 파이프라인 (capstone-cap-translator).
//
// 입력: .cap 파일 1개(필드명 "cap"). 선택: body.targetLang(기본 "ko").
// 출력: 원본과 "동일한 내부 구조"의 .cap — 화면에 보이는 텍스트(페이지 탭, 표시
//       객체 제목, 이론/실험과정/분석/결론 리치텍스트)만 한국어로 번역된 .cap.
//
// 흐름:
//   1) JSZip 로 .cap(=ZIP) 로드.
//   2) main.xml 에서 번역 단위(units) 수집 — cap-xml.js 가 "보이는 텍스트"만 골라냄.
//      숫자/단위/변수기호/센서명/코드성 토큰·binary(data/*.tmp, images/*)는 손대지 않음.
//   3) units 를 배치로 나눠 LLM(Claude 또는 GPT) 에 [{id,text}] → {translations:[{id,ko}]}
//      형식으로 번역 요청. 마크업·자리표시자·기호는 보존하라고 지시.
//   4) 번역 결과를 main.xml 의 같은 자리에만 되써넣음(나머지 바이트 1:1 보존).
//   5) JSZip 으로 재압축 — main.xml 만 교체하고 다른 모든 엔트리는 원본 그대로 유지.
//   6) content = { capBuffer, filename, translatedCount } 반환.
//
// 안전 원칙: 확신이 없는 노드는 번역하지 않고 원문을 남긴다(파일 손상 < 일부 미번역).
//           출력은 항상 유효한 ZIP(=.cap)이며 원본의 모든 part 가 들어있어야 한다.

const Anthropic = require("@anthropic-ai/sdk");
const JSZip = require("jszip");
const { parseJsonLenient } = require("../../json-sanitize");
const { isGptModel, callGptReport } = require("../../model-call");
const { calcCost } = require("../../pricing");
const { collectTranslationUnits } = require("./cap-xml");

const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "claude-opus-4-8";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "32000", 10);
// 한 번역 호출에 넣는 최대 단위 수. 단위 텍스트가 길 수 있으므로 보수적으로.
const BATCH_SIZE = Math.max(
  4,
  parseInt(process.env.CAP_TRANSLATE_BATCH || "40", 10) || 40,
);
// 동시 번역 배치 수.
const CONCURRENCY = Math.max(
  1,
  Math.min(4, parseInt(process.env.CAP_TRANSLATE_CONCURRENCY || "4", 10) || 4),
);
const MAX_UNITS = Math.max(
  1,
  parseInt(process.env.CAP_TRANSLATE_MAX_UNITS || "800", 10) || 800,
);
const MAX_CHARS = Math.max(
  1000,
  parseInt(process.env.CAP_TRANSLATE_MAX_CHARS || "120000", 10) || 120000,
);
const MAX_BATCHES = Math.max(
  1,
  parseInt(process.env.CAP_TRANSLATE_MAX_BATCHES || "30", 10) || 30,
);

const LANG_NAMES = {
  ko: "한국어(Korean)",
  en: "영어(English)",
  ja: "일본어(Japanese)",
  zh: "중국어(Chinese)",
};

function fileExt(name = "") {
  return (String(name).split(".").pop() || "").toLowerCase();
}

// ── prepareInput ─────────────────────────────────────────────────────────────
// filesByField: { cap: [{buffer, originalname, mimetype}], ... }
// 동기. 잘못된 입력은 throw.
function prepareInput(filesByField, body = {}) {
  const fb = filesByField || {};
  const capArr = Array.isArray(fb.cap) ? fb.cap : [];
  const first = capArr.find((f) => f && f.buffer && f.buffer.length);
  if (!first) {
    throw new Error("번역할 .cap 파일을 업로드하세요 (필드명 cap).");
  }
  const name = first.originalname || first.name || "capstone.cap";
  if (fileExt(name) !== "cap") {
    throw new Error("PASCO Capstone .cap 파일만 번역할 수 있습니다.");
  }
  // .cap 은 ZIP. 매직넘버(PK\x03\x04)로 1차 검증.
  const b = first.buffer;
  const isZip = b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (!isZip) {
    throw new Error(".cap 파일이 손상되었거나 올바른 Capstone 파일이 아닙니다.");
  }

  const targetLang = String(body.targetLang || "ko").trim().toLowerCase() || "ko";

  return {
    capBuffer: b,
    sourceFilename: name,
    targetLang,
  };
}

// ── LLM 호출 (제공자-인지) ─────────────────────────────────────────────────────
// 번역 배치 1개를 보내 { id → ko } 맵 일부를 돌려준다.
function buildTranslateSystem(targetName) {
  return `당신은 PASCO Capstone 실험 워크북의 화면 텍스트를 ${targetName}로 번역하는 전문 번역가입니다.

규칙(반드시 준수):
1. 입력은 번역할 텍스트 조각들의 JSON 배열입니다: [{ "id": "...", "text": "..." }].
2. 각 조각의 의미를 자연스럽고 정확한 ${targetName}로 번역하세요. 물리 실험 맥락(역학·전자기·열·파동 등)에 맞는 용어를 쓰세요.
3. **번역하지 말 것(원문 그대로 둘 것)**:
   - 숫자, 측정값, 수식, 변수 기호(F, m, a, v, t, g, θ, ω 등)
   - 단위(m, s, kg, N, m/s², °C, Hz, mL 등)
   - 센서/장비 고유명(PASCO, Photogate, Super Pulley, Capstone, ScienceWorkshop 등 고유명사)
   - 코드성 토큰, 파일명, URL
4. 표시 형식·기호·구두점·대소문자 구조를 최대한 보존하세요. 텍스트 앞뒤 공백/줄바꿈은 신경 쓰지 말고 알맹이만 번역하세요.
5. 마크다운/HTML 태그를 추가하지 마세요. 입력 text 는 이미 태그가 제거된 평문입니다.
6. 확신이 없거나 번역이 무의미한 조각(순수 기호/숫자)은 원문을 그대로 ko 에 넣으세요.
7. 출력은 **정확히 하나의 JSON 객체**이며, 코드펜스(\`\`\`json ... \`\`\`)로 감싸세요. 형식:
   { "translations": [ { "id": "...", "ko": "..." }, ... ] }
   입력의 모든 id 를 빠짐없이 포함하고, 그 외 텍스트(설명·인사)는 절대 넣지 마세요.`;
}

function extractJson(text) {
  const fence = String(text).match(/```json\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const any = String(text).match(/```\s*([\s\S]*?)```/);
  if (any) return any[1].trim();
  const first = String(text).indexOf("{");
  const last = String(text).lastIndexOf("}");
  if (first !== -1 && last > first) return String(text).slice(first, last + 1);
  return null;
}

function parseTranslations(text) {
  const json = extractJson(text);
  if (!json) {
    throw new Error(`번역 응답에서 JSON 을 찾지 못했습니다: ${String(text).slice(0, 160)}`);
  }
  let obj;
  try {
    obj = parseJsonLenient(json);
  } catch (e) {
    throw new Error(`번역 JSON 파싱 실패 — ${e.message}`);
  }
  const arr = Array.isArray(obj.translations)
    ? obj.translations
    : Array.isArray(obj)
      ? obj
      : [];
  return arr;
}

// Claude 스트림 또는 GPT 1회 호출 → 응답 텍스트.
async function callModel(client, { system, content, model, signal, onProgress }) {
  if (isGptModel(model)) {
    const { text, usage } = await callGptReport({
      model,
      system,
      content,
      maxTokens: MAX_TOKENS,
      jsonObject: true,
      signal,
      onProgress,
    });
    return { text, usage };
  }
  const stream = client.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      // Sonnet 5는 thinking 생략 시 추론 ON이 기본 → 기존 추론 OFF 동작 유지(Fable은 disabled 400이라 제외).
      ...(/fable/i.test(model || "") ? {} : { thinking: { type: "disabled" } }),
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
    },
    signal ? { signal } : undefined,
  );
  const final = await stream.finalMessage();
  if (final.stop_reason === "max_tokens") {
    throw new Error("번역 응답이 잘렸습니다. 배치 크기를 줄여 다시 시도하세요.");
  }
  return {
    text: final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
      .join("\n"),
    usage: final.usage,
  };
}

// 동시 실행 제한 워커 풀(입력 순서 보존). 실패 배치는 null 로 건너뜀.
async function mapLimit(items, limit, fn, { signal, onProgress = () => {} } = {}) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length).fill(null);
  if (!list.length) return results;
  const workers = Math.max(1, Math.min(limit | 0 || 1, list.length));
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) throw new Error("작업이 중단되었습니다.");
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await fn(list[i], i);
      } catch (e) {
        if (signal?.aborted) throw e;
        onProgress(`⚠ 번역 배치 ${i + 1} 실패 — 해당 부분은 원문 유지: ${String(e.message).slice(0, 90)}`);
        results[i] = null;
      }
      done++;
      onProgress(`  번역 진행 (${done}/${list.length} 배치)`);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ── generateReportContent ─────────────────────────────────────────────────────
// ctx = { ...pipelineInput, date, model, signal, outputFormat, allowImageGen, onProgress }
async function generateReportContent(ctx) {
  const {
    capBuffer,
    sourceFilename = "capstone.cap",
    targetLang = "ko",
    model = null,
    signal,
    onProgress = () => {},
  } = ctx || {};

  if (!capBuffer || !capBuffer.length) {
    throw new Error("내부 오류: .cap 버퍼가 비어 있습니다.");
  }
  const MODEL = model || DEFAULT_MODEL;
  const useGpt = isGptModel(MODEL);
  if (useGpt) {
    if (!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY)) {
      throw new Error("GPT_API_KEY 환경변수가 설정되지 않았습니다.");
    }
  } else if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.");
  }
  const targetName = LANG_NAMES[targetLang] || LANG_NAMES.ko;

  onProgress(`🤖 모델: ${MODEL} | 번역 대상 언어: ${targetName}`);

  // 1) .cap(ZIP) 로드.
  let zip;
  try {
    zip = await JSZip.loadAsync(capBuffer);
  } catch (e) {
    throw new Error(`.cap(ZIP) 열기 실패: ${e.message}`);
  }
  const mainXmlFile = zip.file("main.xml");
  if (!mainXmlFile) {
    throw new Error(".cap 파일 안에 main.xml 이 없습니다(올바른 Capstone 파일이 아님).");
  }
  // zip-bomb 방어: main.xml 압축 해제 크기 상한.
  if (mainXmlFile._data && mainXmlFile._data.uncompressedSize > 80 * 1024 * 1024) {
    throw new Error(".cap 압축 해제 크기가 비정상적으로 큽니다.");
  }
  const xmlString = await mainXmlFile.async("string");

  // 2) 번역 단위 수집.
  onProgress("🔎 화면 텍스트(페이지 탭·제목·본문) 추출 중...");
  const collected = collectTranslationUnits(xmlString);
  const units = collected.units;
  onProgress(`📋 번역 대상 텍스트 ${units.length}개 추출`);
  const totalUnitChars = units.reduce((sum, u) => sum + String(u.text || "").length, 0);
  if (units.length > MAX_UNITS || totalUnitChars > MAX_CHARS) {
    throw new Error(
      `.cap 화면 텍스트가 너무 많습니다(텍스트 ${units.length}/${MAX_UNITS}개, ${totalUnitChars}/${MAX_CHARS}자). 파일을 나눠서 시도하세요.`,
    );
  }

  // 번역할 게 없으면 원본을 그대로 돌려준다(파일은 여전히 유효).
  if (units.length === 0) {
    onProgress("ℹ️ 번역할 화면 텍스트를 찾지 못했습니다 — 원본 구조를 그대로 반환합니다.");
    const passthrough = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    return {
      capBuffer: passthrough,
      filename: makeOutName(sourceFilename),
      translatedCount: 0,
    };
  }

  // 3) 배치 번역.
  const client = useGpt
    ? null
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 50 * 60 * 1000 });
  const system = buildTranslateSystem(targetName);
  const batches = chunk(units, BATCH_SIZE);
  if (batches.length > MAX_BATCHES) {
    throw new Error(
      `.cap 번역 배치가 너무 많습니다(${batches.length}/${MAX_BATCHES}). CAP_TRANSLATE_BATCH를 키우거나 파일을 나눠 주세요.`,
    );
  }
  onProgress(`✍️ ${units.length}개 텍스트를 ${batches.length}배치로 번역 중...`);
  const usageSum = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const addUsage = (u) => {
    if (!u) return;
    usageSum.input_tokens += u.input_tokens || 0;
    usageSum.output_tokens += u.output_tokens || 0;
    usageSum.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usageSum.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };

  const batchResults = await mapLimit(
    batches,
    CONCURRENCY,
    async (batch) => {
      // 모델에는 id+text 만 보낸다(kind 등 내부 메타는 비공개).
      const payload = batch.map((u) => ({ id: u.id, text: u.text }));
      const content = [
        {
          type: "text",
          text:
            "다음 텍스트 조각들을 규칙에 따라 번역하세요. 입력 배열입니다:\n\n" +
            JSON.stringify(payload, null, 0) +
            "\n\n출력은 { \"translations\": [{ \"id\", \"ko\" }, ...] } JSON 하나뿐.",
        },
      ];
      const { text, usage } = await callModel(client, {
        system,
        content,
        model: MODEL,
        signal,
        onProgress,
      });
      addUsage(usage);
      return parseTranslations(text);
    },
    { signal, onProgress },
  );

  // 4) 번역 맵 구성. 실패 배치/누락 id 는 원문 유지(맵에서 빠짐).
  const validIds = new Set(units.map((u) => u.id));
  const translations = new Map();
  for (const arr of batchResults) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      if (!t || !validIds.has(t.id)) continue;
      const ko = t.ko != null ? String(t.ko) : "";
      // 빈 번역은 원문 유지(맵에 안 넣음).
      if (ko.trim().length === 0) continue;
      translations.set(t.id, ko);
    }
  }
  const translatedCount = translations.size;
  onProgress(`✅ ${translatedCount}/${units.length}개 텍스트 번역 완료`);

  if (translatedCount === 0) {
    throw new Error("번역 결과가 비어 있습니다. 잠시 후 다시 시도하세요.");
  }

  // 5) main.xml 되써넣기 + 재압축(main.xml 만 교체, 나머지 part 보존).
  onProgress("🧩 번역본 .cap 재조립 중...");
  const newXml = collected.apply(translations);
  // 산출 .cap 가 유효한지 가벼운 점검: 여전히 main.xml 루트 구조가 보여야 함.
  if (!newXml.includes("<WorkbookPage")) {
    throw new Error("번역본 XML 무결성 검사 실패 — 구조가 손상되어 출력하지 않습니다.");
  }
  // 기존 zip 객체의 main.xml 엔트리만 교체. 다른 엔트리(data/*, images/*)는 그대로
  // 유지되어 재압축 시 원본 내용으로 다시 들어간다.
  zip.file("main.xml", newXml);

  const outBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

  // 산출물 ZIP 유효성 1차 확인(다시 열어 main.xml 존재 확인).
  try {
    const check = await JSZip.loadAsync(outBuffer);
    if (!check.file("main.xml")) throw new Error("main.xml 누락");
  } catch (e) {
    throw new Error(`번역본 .cap 검증 실패: ${e.message}`);
  }

  const cost = calcCost({ usage: usageSum, model: MODEL });
  return {
    capBuffer: outBuffer,
    filename: makeOutName(sourceFilename),
    translatedCount,
    __cost: cost,
  };
}

// "원본명.cap" → "원본명_번역.cap"
function makeOutName(sourceFilename) {
  const base = String(sourceFilename || "capstone.cap").replace(/\.cap$/i, "");
  const safe = base.replace(/[\\/:*?"<>|]+/g, "_").trim() || "capstone";
  return `${safe}_번역.cap`;
}

// ── generateBundle ─────────────────────────────────────────────────────────────
// content = generateReportContent 결과. 번역된 .cap 바이트를 그대로 다운로드.
// (서버는 mime 를 application/zip 으로 강제하지만 .cap 자체가 zip 이라 무방.)
async function generateBundle(content, opts = {}) {
  const { onProgress = () => {} } = opts;
  if (!content || !content.capBuffer) {
    throw new Error("내부 오류: 번역된 .cap 버퍼가 없습니다.");
  }
  onProgress("📦 번역본 .cap 다운로드 준비 완료");
  return {
    buffer: content.capBuffer,
    filename: content.filename || "capstone_번역.cap",
  };
}

module.exports = {
  prepareInput,
  generateReportContent,
  generateBundle,
};
