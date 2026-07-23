#!/usr/bin/env node
// scripts/verify_report_content.js — 보고서 콘텐츠 JSON 스키마 검증 CLI (얇은 래퍼).
// 검증 로직은 전부 lib/content-schema.js (순수 함수, 파이프라인 배선용)에 있다.
//
// 사용법:
//   node scripts/verify_report_content.js <content.json> --type <type> [--json out.json] [--format docx|hwpx|pdf|zip]
//
//   <content.json> : 검사할 콘텐츠. 순수 콘텐츠 객체이거나,
//                    구형식 래퍼({type, model, progress, ..., report|content: {본문}}),
//                    또는 신형식 gen-any 래퍼({__meta: {type,...}, content: {본문}})면
//                    본문 필드를 자동 탐지해 언랩한다.
//                    gen-any 사이드카 마커({"$bin$":..} → Buffer 존재,
//                    {"$map$"/"$set$"/"$array$"}, "$hidden$" 키 = non-enumerable 내부값)는
//                    검증 전에 투명하게 디코딩/제거한다(gen-any.js makeEncoder 와 쌍).
//   --type         : chem-pre | chem-result | phys-result | free(-report) |
//                    reading-log | form-maker | problem-set.
//                    생략 시 래퍼의 type(신형식은 __meta.type) 필드를 사용.
//   --json out     : verdict JSON({schema_version,passed,hard_failures,warnings,metrics})을 파일로 저장.
//   --format       : 출력 포맷 힌트({{EQ:}} 수식 placeholder 판정용). 생략 가능.
//
// exit code: 0 = 통과(hard failure 없음), 1 = hard failure 있음, 2 = 사용법/입출력 오류.

"use strict";

const fs = require("fs");
const path = require("path");
const { validateContent, knownTypes } = require("../lib/content-schema");

function usage(msg) {
  if (msg) console.error(`오류: ${msg}\n`);
  console.error(
    "사용법: node scripts/verify_report_content.js <content.json> --type <type> [--json out.json] [--format docx|hwpx|pdf|zip]",
  );
  console.error(`지원 type: ${knownTypes().join(", ")}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { file: null, type: null, json: null, format: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--type") args.type = argv[++i];
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--help" || a === "-h") usage();
    else if (a.startsWith("--")) usage(`알 수 없는 옵션: ${a}`);
    else if (!args.file) args.file = a;
    else usage(`입력 파일이 두 개 지정됨: ${args.file}, ${a}`);
  }
  return args;
}

// 래퍼에서 본문을 자동 탐지.
// - 신형식 gen-any: {__meta: {type, ...}, content: {본문}}  (tmp/gen-any.js 저장 포맷)
// - 구형식:        {type, model, progress, ..., report|content: {본문}}
function unwrap(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { body: obj, wrapperType: null };
  }
  // 신형식 gen-any 래퍼
  if (
    obj.__meta &&
    typeof obj.__meta === "object" &&
    !Array.isArray(obj.__meta) &&
    obj.content !== undefined
  ) {
    const metaType =
      typeof obj.__meta.type === "string" ? obj.__meta.type : null;
    return { body: obj.content, wrapperType: metaType };
  }
  const wrapperType = typeof obj.type === "string" ? obj.type : null;
  if (obj.report && typeof obj.report === "object" && !Array.isArray(obj.report)) {
    return { body: obj.report, wrapperType };
  }
  const looksLikeWrapper =
    wrapperType !== null || obj.model !== undefined || obj.progress !== undefined;
  if (
    looksLikeWrapper &&
    obj.content &&
    typeof obj.content === "object" &&
    !Array.isArray(obj.content)
  ) {
    return { body: obj.content, wrapperType };
  }
  return { body: obj, wrapperType };
}

// gen-any.js makeEncoder 의 사이드카 마커를 검증용 in-memory 형태로 복원.
// (스키마 검증 전에 투명하게 처리 — render-any.js 의 decode 와 같은 규칙)
//   {"$bin$": "bNNNN.bin"}          → Buffer 존재로 간주 (1바이트 placeholder;
//                                     마커 스캔·textChars 에서 제외되고 nonEmpty 는 통과)
//   {"$map$": [[k,v], ...]}         → 문자열 키면 평범한 객체로, 아니면 pair 배열로
//   {"$set$": [...]}                → 배열로
//   {"$array$": [...], "$hidden$"}  → 배열로 ($hidden$ 버림)
//   "$hidden$" 키                    → 원본에서 non-enumerable 내부값(__photos,
//                                     pngBuffer 등)이므로 검증 대상에서 제거
function decodeSidecarMarkers(value, depth = 0) {
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((v) => decodeSidecarMarkers(v, depth + 1));
  }
  if (typeof value["$bin$"] === "string") {
    return Buffer.alloc(1); // Buffer 존재만 표현 (내용은 .bin 사이드카에)
  }
  if (Array.isArray(value["$map$"])) {
    const pairs = value["$map$"].map(([k, v]) => [
      decodeSidecarMarkers(k, depth + 1),
      decodeSidecarMarkers(v, depth + 1),
    ]);
    if (pairs.every(([k]) => typeof k === "string")) {
      const obj = {};
      for (const [k, v] of pairs) obj[k] = v;
      return obj;
    }
    return pairs;
  }
  if (Array.isArray(value["$set$"])) {
    return value["$set$"].map((v) => decodeSidecarMarkers(v, depth + 1));
  }
  if (Array.isArray(value["$array$"])) {
    return value["$array$"].map((v) => decodeSidecarMarkers(v, depth + 1));
  }
  const out = {};
  for (const key of Object.keys(value)) {
    if (key === "$hidden$") continue;
    out[key] = decodeSidecarMarkers(value[key], depth + 1);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) usage("검사할 content.json 경로가 필요합니다.");

  let raw;
  try {
    raw = fs.readFileSync(args.file, "utf8");
  } catch (e) {
    usage(`파일 읽기 실패 (${args.file}): ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    usage(`JSON 파싱 실패 (${args.file}): ${e.message}`);
  }

  const { body, wrapperType } = unwrap(obj);
  const type = args.type || wrapperType;
  if (!type) usage("--type 이 없고 파일에도 type 필드가 없습니다.");
  const decoded = decodeSidecarMarkers(body);

  let result;
  try {
    result = validateContent(type, decoded, { format: args.format || undefined });
  } catch (e) {
    usage(e.message);
  }

  const verdict = {
    schema_version: 1,
    passed: result.hardFailures.length === 0,
    hard_failures: result.hardFailures,
    warnings: result.warnings,
    metrics: result.metrics,
  };

  if (args.json) {
    try {
      fs.writeFileSync(args.json, JSON.stringify(verdict, null, 2) + "\n");
    } catch (e) {
      usage(`verdict 저장 실패 (${args.json}): ${e.message}`);
    }
  }

  // 사람용 요약
  const name = path.basename(args.file);
  const status = verdict.passed ? "PASS" : "FAIL";
  console.log(
    `[${status}] ${name} (type=${type}) — hard ${verdict.hard_failures.length}건, warn ${verdict.warnings.length}건`,
  );
  for (const f of verdict.hard_failures) {
    console.log(`  ✗ [${f.rule}] ${f.path}: ${f.detail}`);
  }
  for (const w of verdict.warnings) {
    console.log(`  ⚠ [${w.rule}] ${w.path}: ${w.detail}`);
  }
  if (result.metrics && result.metrics.counts) {
    const parts = Object.entries(result.metrics.counts).map(
      ([k, v]) => `${k}=${v === null ? "-" : v}`,
    );
    console.log(`  metrics: textChars=${result.metrics.textChars} ${parts.join(" ")}`);
  }

  process.exit(verdict.passed ? 0 : 1);
}

main();
