// 보고서 파이프라인 회귀: PASCO Capstone .cap 파서 (DEF-016).
//
// 과거 결함: 사용자 입력 표(TLV userdata)의 UTF-16 문자열 사이에 끼는 NUL
// 종결자 변형 때문에 값이 "1.4"/"47" 처럼 쪼개져 파손됐다. atwood.cap 의
// "Exp. a" measurement 는 정확히 [1.47, 1.47, 1.47, 1.47] 로 복원되어야 한다.
//
// 실측 .cap 파일은 로컬 전용 캡처 데이터(tmp/testdata/, 비추적)라서 파일이
// 없으면 skip 한다. tmp/ 의 코드는 require 하지 않고, 데이터 파일만 조건부로
// 읽는다.

"use strict";

const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

const CAP_PATH = path.join(H.REPO_ROOT, "tmp", "testdata", "phys", "atwood.cap");
const skip = fs.existsSync(CAP_PATH)
  ? false
  : "tmp/testdata/phys/atwood.cap 없음 (로컬 전용 실측 데이터)";

describe("cap-parser: atwood.cap 사용자 표 복원 (DEF-016 회귀 방지)", () => {
  it(
    "Exp. a 열이 ['1.47','1.47','1.47','1.47'] 로 파싱된다",
    { skip, timeout: 60_000 },
    async () => {
      const { parseCap, summarizeForPrompt } = require(
        path.join(H.REPO_ROOT, "lib", "pipelines", "phys-result", "cap-parser"),
      );
      const parsed = await parseCap(fs.readFileSync(CAP_PATH));

      // measurement 이름 -> dataset 매핑에서 "Exp. a" 를 찾는다.
      const mapping = parsed.dataset_to_measurement || {};
      const entry = Object.entries(mapping).find(
        ([, m]) => m && m.measurement_name === "Exp. a",
      );
      assert.ok(
        entry,
        `"Exp. a" measurement 매핑이 없음. 실제 매핑: ${JSON.stringify(
          Object.values(mapping).map((m) => m && m.measurement_name),
        )}`,
      );

      const dataset = (parsed.datasets || {})[entry[0]];
      assert.ok(dataset, `Exp. a dataset(${entry[0]}) 없음`);
      const values = (dataset.values || []).map((v) => String(v));
      assert.deepEqual(
        values,
        ["1.47", "1.47", "1.47", "1.47"],
        "Exp. a 열 값이 파손됨 (DEF-016: UTF-16 NUL 종결자 변형 처리 회귀)",
      );

      // 프롬프트 요약의 사용자 입력 표에도 파손 없이 반영되는지 (느슨한 검사:
      // 수치 포매팅 변화에는 관대하고, 열 유실/파손에는 민감하게).
      const summary = summarizeForPrompt(parsed);
      assert.ok(
        summary.includes("Exp. a"),
        "프롬프트 요약에 Exp. a 열이 없음",
      );
      assert.ok(
        summary.includes("1.47"),
        "프롬프트 요약에 Exp. a 값(1.47)이 없음",
      );
    },
  );
});
