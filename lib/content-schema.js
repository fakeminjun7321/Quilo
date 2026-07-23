// lib/content-schema.js — 보고서 콘텐츠(JSON) 미니 스키마 검증 엔진.
//
// 파이프라인이 Claude/GPT 응답을 lenient-parse(lib/json-sanitize.js)·sanitize 한 "직후"의
// 콘텐츠 객체를 검사한다. 렌더러(docx/hwpx/zip)가 크래시하거나 실질적으로 빈 문서를
// 만들게 되는 결함(hard)과, 품질성 결함(warn)을 구분해서 보고한다.
// 의존성 zero(node 내장 fs/path 만) — CLI 는 scripts/verify_report_content.js 참고.
//
// ── 미니 스키마 형식 (lib/pipelines/<dir>/schema.json) ────────────────────────
// {
//   "$doc": "사람용 설명 문자열 (검증에는 안 쓰임)",
//   "required": [ <rule>, ... ],   // 위반 = hardFailures (rule id S1)
//   "warn":     [ <rule>, ... ],   // 위반 = warnings     (rule id S3)
//   "forbidMarkers": true,          // JSON 직렬화 전체에서 금지 마커 스캔 (rule id S2)
//   "metrics": ["path", ...]        // metrics.counts 에 기록할 경로 (배열 길이/문자열 길이)
// }
//
// <rule> 필드:
//   path     : 점 표기 경로. "a.b.c". 세그먼트 끝 "[]" 는 배열 원소 순회
//              ("experiments[].data_table.headers" → 각 실험의 headers).
//              "" (빈 문자열) = 루트 객체 자신.
//              빈 배열 순회는 vacuous pass (원소 0개면 위반 없음 — 배열 자체의
//              최소 개수는 그 배열 경로에 minItems 규칙을 따로 둔다).
//   type     : "string" | "array" | "object" | "number" | "boolean".
//              "|" 로 union 허용 (예: "string|array").
//   minLen   : 문자열 trim 후 최소 길이.
//   minItems : 배열 최소 원소 수.
//   nonEmpty : true 면 값이 비면 위반 (문자열 trim>0, 배열 len>0, 객체 key>0).
//   anyOf    : ["sub.path", ...] — 매칭된 각 값에서 하위 경로 중 하나 이상이
//              비어있지 않아야 통과 (하위 경로에 "[]" 는 지원 안 함).
//   optional : true 면 값이 없을 때(undefined/null) 규칙을 건너뜀.
//              값이 "있으면" type/minLen 등은 그대로 검사한다.
//   detail   : 위반 시 메시지에 덧붙일 설명 (선택).
//
// ── 마커 스캔 (forbidMarkers) ────────────────────────────────────────────────
//   위키식 수식 마커 {{MATH: / {{FORMULA: / [[수식]]  → 항상 hard (S2).
//   내부 수식 마커 {{EQ: / {{EQN: / {{EQ-LATEX: / {{EQN-LATEX:
//     → opts.format === "hwpx" 면 정상 중간산물이라 허용,
//       opts.format 이 docx/pdf/zip 이면 hard (렌더에 raw 로 노출됨),
//       format 미지정이면 warn (S2).
//   긴 하이픈 — – ― (U+2014/2013/2015) → 항상 warn (S2).
//     서버의 stripAiDashes 가 렌더 전에 결정적으로 제거하므로 hard 가 아니다.
//   `__` 로 시작하는 내부 키(__photos, __figures 등)와 Buffer 는 스캔에서 제외.
//
// ── API ─────────────────────────────────────────────────────────────────────
//   validateContent(type, contentObj, opts?) →
//     { hardFailures: [{rule,path,detail}], warnings: [{rule,path,detail}], metrics: {...} }
//   rule id: S1 = required 위반, S2 = 마커 잔존, S3 = 분량/품질 warn.
//   알 수 없는 type / 스키마 파일 없음 → Error throw (호출자가 잡아서 처리).

"use strict";

const fs = require("fs");
const path = require("path");

// 서버 type 키 → 스키마가 있는 파이프라인 디렉토리.
const TYPE_DIRS = {
  "chem-pre": "chem-pre",
  "chem-result": "chem-result",
  "phys-result": "phys-result",
  "free": "free-report",
  "free-report": "free-report",
  "reading-log": "reading-log",
  "reading-log-bulk": "reading-log",
  "form-maker": "form-maker",
  "problem-set": "problem-set",
};

const WIKI_MARKERS = ["{{MATH:", "{{FORMULA:", "[[수식]]"];
const EQ_MARKERS = ["{{EQ:", "{{EQN:", "{{EQ-LATEX:", "{{EQN-LATEX:"];
const DASHES = [
  ["—", "—(U+2014)"],
  ["–", "–(U+2013)"],
  ["―", "―(U+2015)"],
];

const schemaCache = new Map();

function knownTypes() {
  return Object.keys(TYPE_DIRS);
}

function loadSchema(type) {
  const dir = TYPE_DIRS[String(type || "").trim()];
  if (!dir) {
    throw new Error(
      `알 수 없는 보고서 type: "${type}" (지원: ${knownTypes().join(", ")})`,
    );
  }
  if (schemaCache.has(dir)) return schemaCache.get(dir);
  const file = path.join(__dirname, "pipelines", dir, "schema.json");
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`스키마 로드 실패 (${file}): ${e.message}`);
  }
  schemaCache.set(dir, schema);
  return schema;
}

// ── 경로 해석 ────────────────────────────────────────────────────────────────
// resolvePath(root, "a[].b") → [{path, value, exists, notArray?}, ...]
// 중간 값이 없으면 "없어진 지점"의 경로로 exists:false 한 건만 남긴다.
function resolvePath(root, rulePath) {
  if (!rulePath) {
    return [{ path: "(root)", value: root, exists: root !== undefined && root !== null }];
  }
  let targets = [{ path: "", value: root, exists: true }];
  for (const seg of String(rulePath).split(".")) {
    const isArr = seg.endsWith("[]");
    const key = isArr ? seg.slice(0, -2) : seg;
    const next = [];
    for (const t of targets) {
      if (!t.exists || t.notArray) {
        next.push(t); // 이미 끊긴 경로는 그대로 전달 (최초 결손 지점 유지)
        continue;
      }
      const parent = t.value;
      const canIndex = parent !== null && typeof parent === "object";
      const v = canIndex ? parent[key] : undefined;
      const p = t.path ? `${t.path}.${key}` : key;
      if (v === undefined || v === null) {
        next.push({ path: p, value: undefined, exists: false });
        continue;
      }
      if (isArr) {
        if (!Array.isArray(v)) {
          next.push({ path: p, value: v, exists: true, notArray: true });
        } else {
          v.forEach((item, i) =>
            next.push({ path: `${p}[${i}]`, value: item, exists: true }),
          );
        }
      } else {
        next.push({ path: p, value: v, exists: true });
      }
    }
    targets = next;
  }
  return targets;
}

// anyOf 하위 경로용 단순 해석 ("[]" 미지원).
function getSubValue(base, subPath) {
  let v = base;
  for (const key of String(subPath).split(".")) {
    if (v === null || v === undefined || typeof v !== "object") return undefined;
    v = v[key];
  }
  return v;
}

function typeName(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isEmptyValue(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false; // number/boolean 은 비어있지 않다고 본다
}

// ── 규칙 하나 평가 → 위반 목록 [{path, detail}] ──────────────────────────────
function evalRule(root, rule) {
  const out = [];
  const seen = new Set(); // 같은 결손 지점 중복 보고 방지
  const add = (p, detail) => {
    const key = `${p}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, detail: rule.detail ? `${detail} — ${rule.detail}` : detail });
  };

  for (const t of resolvePath(root, rule.path || "")) {
    if (t.notArray) {
      if (!rule.optional) add(t.path, `배열이 아님 (${typeName(t.value)})`);
      continue;
    }
    if (!t.exists) {
      if (!rule.optional) add(t.path, "필드 없음");
      continue;
    }
    const v = t.value;

    if (rule.type) {
      const allowed = String(rule.type).split("|").map((s) => s.trim());
      if (!allowed.includes(typeName(v))) {
        add(t.path, `타입 불일치: ${typeName(v)} (기대: ${rule.type})`);
        continue; // 타입이 틀리면 길이 검사는 무의미
      }
    }
    if (rule.nonEmpty && isEmptyValue(v)) {
      add(t.path, "값이 비어 있음");
      continue;
    }
    if (rule.minLen !== undefined && typeof v === "string") {
      const len = v.trim().length;
      if (len < rule.minLen) add(t.path, `문자열 길이 ${len} < 최소 ${rule.minLen}`);
    }
    if (rule.minItems !== undefined && Array.isArray(v)) {
      if (v.length < rule.minItems)
        add(t.path, `배열 원소 ${v.length}개 < 최소 ${rule.minItems}개`);
    }
    if (Array.isArray(rule.anyOf) && rule.anyOf.length > 0) {
      const ok = rule.anyOf.some((sub) => {
        const sv = getSubValue(v, sub);
        if (isEmptyValue(sv)) return false;
        if (rule.minLen !== undefined && typeof sv === "string") {
          return sv.trim().length >= rule.minLen;
        }
        return true;
      });
      if (!ok) add(t.path, `다음 중 하나가 필요: ${rule.anyOf.join(" | ")}`);
    }
  }
  return out;
}

// ── 마커 스캔용 직렬화 (내부 키·Buffer 제외, 순환 안전) ─────────────────────
function safeSerialize(content) {
  const seen = new WeakSet();
  try {
    return (
      JSON.stringify(content, function (key, value) {
        if (key && key.startsWith("__")) return undefined;
        const raw = this ? this[key] : value;
        if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) return undefined;
        if (raw instanceof Uint8Array) return undefined;
        if (value && typeof value === "object") {
          if (seen.has(value)) return "[circular]";
          seen.add(value);
        }
        return value;
      }) || ""
    );
  } catch {
    return "";
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    i = haystack.indexOf(needle, i);
    if (i === -1) return n;
    n++;
    i += needle.length;
  }
}

// 문자열 leaf 총 글자수 (본문 분량 프록시). __키·Buffer 제외.
function countTextChars(v, depth = 0) {
  if (depth > 20 || v === null || v === undefined) return 0;
  if (typeof v === "string") return v.length;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) return 0;
  if (v instanceof Uint8Array) return 0;
  if (Array.isArray(v)) {
    let n = 0;
    for (const item of v) n += countTextChars(item, depth + 1);
    return n;
  }
  if (typeof v === "object") {
    let n = 0;
    for (const k of Object.keys(v)) {
      if (k.startsWith("__")) continue;
      n += countTextChars(v[k], depth + 1);
    }
    return n;
  }
  return 0;
}

function metricValue(v) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return v.length;
  if (typeof v === "string") return v.trim().length;
  if (typeof v === "object") return Object.keys(v).length;
  return v;
}

// ── 메인 API ────────────────────────────────────────────────────────────────
// opts.format: "docx" | "hwpx" | "pdf" | "zip" (선택 — {{EQ:}} 마커 판정에만 사용)
function validateContent(type, contentObj, opts = {}) {
  const schema = loadSchema(type);
  const hardFailures = [];
  const warnings = [];
  const metrics = {};

  if (
    contentObj === null ||
    typeof contentObj !== "object" ||
    Array.isArray(contentObj)
  ) {
    hardFailures.push({
      rule: "S1",
      path: "(root)",
      detail: `콘텐츠가 객체가 아님 (${typeName(contentObj)})`,
    });
    return { hardFailures, warnings, metrics };
  }

  for (const rule of schema.required || []) {
    for (const v of evalRule(contentObj, rule)) {
      hardFailures.push({ rule: "S1", path: v.path, detail: v.detail });
    }
  }
  for (const rule of schema.warn || []) {
    for (const v of evalRule(contentObj, rule)) {
      warnings.push({ rule: "S3", path: v.path, detail: v.detail });
    }
  }

  if (schema.forbidMarkers) {
    const serialized = safeSerialize(contentObj);
    for (const m of WIKI_MARKERS) {
      const n = countOccurrences(serialized, m);
      if (n > 0) {
        hardFailures.push({
          rule: "S2",
          path: "(전체)",
          detail: `위키식 수식 마커 ${m} ${n}건 잔존`,
        });
      }
    }
    const fmt = String(opts.format || "").toLowerCase();
    for (const m of EQ_MARKERS) {
      const n = countOccurrences(serialized, m);
      if (n === 0) continue;
      if (fmt === "hwpx") continue; // HWPX 는 수식 postprocess 가 변환하는 정상 중간산물
      const finding = {
        rule: "S2",
        path: "(전체)",
        detail: `수식 placeholder ${m} ${n}건 잔존${fmt ? ` (format=${fmt} 는 raw 노출됨)` : " (출력 포맷 미상 — hwpx 면 정상)"}`,
      };
      if (fmt) hardFailures.push(finding);
      else warnings.push(finding);
    }
    for (const [ch, label] of DASHES) {
      const n = countOccurrences(serialized, ch);
      if (n > 0) {
        warnings.push({
          rule: "S2",
          path: "(전체)",
          detail: `긴 하이픈 ${label} ${n}건 (서버 stripAiDashes 가 렌더 전 제거)`,
        });
      }
    }
    metrics.jsonChars = serialized.length;
  }

  metrics.textChars = countTextChars(contentObj);
  if (Array.isArray(schema.metrics)) {
    const counts = {};
    for (const p of schema.metrics) {
      const targets = resolvePath(contentObj, p);
      const t = targets[0];
      counts[p] = t && t.exists ? metricValue(t.value) : null;
    }
    metrics.counts = counts;
  }

  return { hardFailures, warnings, metrics };
}

module.exports = { validateContent, loadSchema, knownTypes, resolvePath };
