// 보고서 파이프라인 회귀: content-schema (lib/content-schema.js validateContent).
//
// 파이프라인이 모델 응답을 lenient-parse 한 "직후"의 콘텐츠를 검사하는 미니
// 스키마 엔진 회귀. 픽스처 5종(chem-pre / chem-result / phys-result / free /
// form-maker) 기준으로:
//   - 정상 픽스처는 hardFailures 0건 (format=hwpx: {{EQ:}} 는 정상 중간산물)
//   - title(title_kr) 제거 -> S1 hard
//   - {{MATH: 위키 마커 주입 + format=docx -> S2 hard
//   - {{EQ:}} 마커는 format 미지정이면 warn, hwpx 면 통과 (경계 확인)

"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

const { validateContent } = require(path.join(H.REPO_ROOT, "lib", "content-schema"));

// 타입별 required 제목 필드 (schema.json 과 동일).
const TITLE_FIELD = {
  "chem-pre": "title_kr",
  "chem-result": "title_kr",
  "phys-result": "title",
  "free": "title",
  "form-maker": "title",
};

const FIXTURES = H.fixtureTypes(); // fixtures/*.json 파일명 = 픽스처 이름

describe("content-schema validateContent", () => {
  for (const name of FIXTURES) {
    it(`${name}: 정상 픽스처는 hard 0건 (format=hwpx)`, () => {
      const { meta, content } = H.loadFixture(name);
      const result = validateContent(meta.type, content, { format: "hwpx" });
      assert.deepEqual(
        result.hardFailures,
        [],
        `정상 픽스처에서 hard 위반: ${JSON.stringify(result.hardFailures)}`,
      );
    });

    it(`${name}: title 제거 -> S1 hard`, () => {
      const { meta, content } = H.loadFixture(name);
      const field = TITLE_FIELD[meta.type];
      assert.ok(field, `타입 ${meta.type} 의 제목 필드 매핑 없음`);
      delete content[field];
      const result = validateContent(meta.type, content, { format: "hwpx" });
      const hit = result.hardFailures.find(
        (f) => f.rule === "S1" && f.path === field,
      );
      assert.ok(
        hit,
        `title(${field}) 제거 시 S1 hard 가 나와야 함. 실제: ${JSON.stringify(result.hardFailures)}`,
      );
    });

    it(`${name}: {{MATH: 주입(format=docx) -> S2 hard`, () => {
      const { meta, content } = H.loadFixture(name);
      const field = TITLE_FIELD[meta.type];
      content[field] = `${content[field]} {{MATH:x^2}}`;
      const result = validateContent(meta.type, content, { format: "docx" });
      const hit = result.hardFailures.find(
        (f) => f.rule === "S2" && String(f.detail).includes("{{MATH:"),
      );
      assert.ok(
        hit,
        `위키식 {{MATH: 마커는 S2 hard 여야 함. 실제: ${JSON.stringify(result.hardFailures)}`,
      );
    });
  }

  it("{{EQ:}} 마커: format 미지정 -> S2 warn, format=hwpx -> 통과", () => {
    // phys-result 픽스처는 본문에 {{EQ:...}} 마커를 포함한다.
    const { meta, content } = H.loadFixture("phys-result");

    const noFormat = validateContent(meta.type, content, {});
    assert.equal(
      noFormat.hardFailures.length,
      0,
      "format 미지정이면 {{EQ:}} 는 hard 가 아니어야 한다",
    );
    const warned = noFormat.warnings.find(
      (w) => w.rule === "S2" && String(w.detail).includes("{{EQ:"),
    );
    assert.ok(warned, "format 미지정이면 {{EQ:}} 는 S2 warn 이어야 한다");

    const hwpx = validateContent(meta.type, content, { format: "hwpx" });
    const eqFindings = [...hwpx.hardFailures, ...hwpx.warnings].filter((f) =>
      String(f.detail).includes("{{EQ:"),
    );
    assert.equal(
      eqFindings.length,
      0,
      "format=hwpx 면 {{EQ:}} 는 정상 중간산물로 통과해야 한다",
    );

    const docx = validateContent(meta.type, content, { format: "docx" });
    const hardEq = docx.hardFailures.find(
      (f) => f.rule === "S2" && String(f.detail).includes("{{EQ:"),
    );
    assert.ok(hardEq, "format=docx 면 {{EQ:}} 잔존은 S2 hard 여야 한다");
  });
});
