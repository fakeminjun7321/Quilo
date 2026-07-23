// tests/pipelines 공용 헬퍼: 합성 콘텐츠 픽스처 로더 + 렌더 전 준비.
//
// 픽스처 포맷은 평가 캡처(tmp/eval, gen-any.js makeEncoder)와 동일한 신형식
// { __meta, content } 이며, 사이드카 마커를 여기서 복원(rehydrate)한다:
//   {"$bin$": "bNNNN.bin"}  → Buffer (픽스처 옆 <이름>.bin/ 디렉토리에서 로드)
//   {"$map$": [[k,v],...]}  → Map
//   {"$set$": [...]}        → Set
//   {"$hidden$": {...}}     → Object.defineProperty(enumerable:false) 재부착
//     (__photos, chart.pngBuffer 등 서버가 non-enumerable 로 붙이는 값)
//
// 디코더는 tmp/render-any.js 의 makeDecoder 와 동일 규칙을 자체 구현한 것이다.
// tmp/ 는 비추적 폴더라 tests/ 에서 require 하지 않는다.

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

// ── 사이드카 디코더 (tmp/render-any.js makeDecoder 와 동일 규칙) ────────────
function makeDecoder(binDirAbs) {
  function readBin(file) {
    return fs.readFileSync(path.join(binDirAbs, file));
  }
  function applyHidden(target, hidden) {
    if (!hidden || typeof hidden !== "object") return;
    for (const [k, v] of Object.entries(hidden)) {
      Object.defineProperty(target, k, {
        value: decode(v),
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
  }
  function decode(value) {
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(decode);
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "$bin$") return readBin(value["$bin$"]);
    if (keys.length === 1 && keys[0] === "$map$") {
      const m = new Map();
      for (const [k, v] of value["$map$"]) m.set(decode(k), decode(v));
      return m;
    }
    if (keys.length === 1 && keys[0] === "$set$") {
      return new Set(value["$set$"].map(decode));
    }
    if (keys.includes("$array$")) {
      const arr = value["$array$"].map(decode);
      applyHidden(arr, value["$hidden$"]);
      return arr;
    }
    const out = {};
    for (const k of keys) {
      if (k === "$hidden$") continue;
      out[k] = decode(value[k]);
    }
    applyHidden(out, value["$hidden$"]);
    return out;
  }
  return decode;
}

// ── 긴 하이픈 제거 (server.js stripAiDashes 와 동일 규칙, Buffer·__키 보호) ──
// 픽스처는 애초에 긴 하이픈이 없지만, 서버 렌더 직전 흐름을 그대로 재현한다.
// (소스에 긴 하이픈 리터럴을 넣지 않기 위해 전부 \u 이스케이프로 표기)
const DASH_CLASS = "[\\u2014\\u2013\\u2015]"; // em dash, en dash, horizontal bar
function stripAiDashes(v, depth = 0) {
  if (depth > 14 || v == null) return v;
  if (typeof v === "string") {
    if (!new RegExp(DASH_CLASS).test(v)) return v;
    return v
      .replace(new RegExp(`(^|\\n)\\s*${DASH_CLASS}+\\s*`, "g"), "$1")
      .replace(new RegExp(`\\s*${DASH_CLASS}+\\s*(?=\\n|$)`, "g"), "")
      .replace(new RegExp(`(\\d)\\s*${DASH_CLASS}\\s*(?=\\d)`, "g"), "$1~")
      .replace(new RegExp(`\\s*${DASH_CLASS}+\\s*(?=[).,!?\\]])`, "g"), "")
      .replace(new RegExp(`\\s*${DASH_CLASS}+\\s*`, "g"), ", ")
      .replace(/,\s*,/g, ",");
  }
  if (Buffer.isBuffer(v)) return v;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = stripAiDashes(v[i], depth + 1);
    return v;
  }
  if (typeof v === "object") {
    for (const k of Object.keys(v)) {
      if (k.startsWith("__")) continue;
      v[k] = stripAiDashes(v[k], depth + 1);
    }
    return v;
  }
  return v;
}

// ── server.js runGeneration 이 렌더 직전에 content 에 부착하는 값 재현 ──────
function prepareContentForRender(content, render = {}) {
  const { normalizeFontFace } = require(path.join(REPO_ROOT, "lib", "document-fonts"));
  const fontFace = normalizeFontFace(render.fontFace || "");
  const studentId = String(render.studentId || "").trim();
  const userName = String(render.studentName || "").trim();

  stripAiDashes(content);
  if (content.__allowHighlights === undefined) content.__allowHighlights = false;
  if (!Object.getOwnPropertyDescriptor(content, "__fontFace")) {
    Object.defineProperty(content, "__fontFace", {
      value: fontFace,
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  if (!content.font_face) content.font_face = fontFace;
  if (!Object.getOwnPropertyDescriptor(content, "__studentInfo")) {
    Object.defineProperty(content, "__studentInfo", {
      value: { studentId, userName },
      enumerable: false,
      writable: false,
      configurable: true,
    });
  }
  if (content.student_id === undefined) content.student_id = studentId;
  if (content.student_name === undefined) content.student_name = userName;
  if (content.temperature === undefined) {
    content.temperature = String(render.temperature || "").trim();
  }
  if (content.pressure === undefined) {
    content.pressure = String(render.pressure || "").trim();
  }
  if (content.report_number === undefined) content.report_number = "";
  if (render.date && !content.date) content.date = render.date;
  return { studentId, userName };
}

// ── 픽스처 로더 ─────────────────────────────────────────────────────────────
// 호출할 때마다 디스크에서 새로 디코드한 fresh 객체를 반환한다(변형 테스트 안전).
function loadFixture(name, { prepare = true } = {}) {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw.__meta || !raw.content) {
    throw new Error(`픽스처 ${name} 가 신형식({__meta, content})이 아닙니다.`);
  }
  const meta = raw.__meta;
  const binDir = path.join(FIXTURE_DIR, meta.sidecar || `${name}.bin`);
  const content = makeDecoder(binDir)(raw.content);
  if (prepare) prepareContentForRender(content, meta.render || {});
  return { meta, content };
}

function fixtureTypes() {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.basename(f, ".json"))
    .sort();
}

// ── ZIP(docx/hwpx) 검사 유틸 ────────────────────────────────────────────────
function isZipBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 4 &&
    buf.slice(0, 2).toString("latin1") === "PK"
  );
}

function isPngBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length > 8 &&
    buf.slice(0, 8).toString("hex") === "89504e470d0a1a0a"
  );
}

async function loadZip(buf) {
  const JSZip = require("jszip");
  return JSZip.loadAsync(buf);
}

async function zipEntryText(zip, entryPath) {
  const file = zip.file(entryPath);
  if (!file) return null;
  return file.async("string");
}

// XML 태그를 벗겨 순수 텍스트만 남긴다(문서 본문 텍스트 검사용).
function xmlToText(xml) {
  return String(xml || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ── hwpx 테스트용 Python 탐지 (lib/pipelines/*/hwpx-gen.js detectPython 미러) ─
function detectPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venv = path.join(REPO_ROOT, ".venv", "bin", "python3");
  if (fs.existsSync(venv)) return venv;
  return null; // 시스템 python3 폴백은 의존성 미보장이라 테스트에선 skip 처리
}

module.exports = {
  REPO_ROOT,
  FIXTURE_DIR,
  makeDecoder,
  stripAiDashes,
  prepareContentForRender,
  loadFixture,
  fixtureTypes,
  isZipBuffer,
  isPngBuffer,
  loadZip,
  zipEntryText,
  xmlToText,
  detectPython,
};
