// 보고서 파이프라인 회귀: 렌더/보정 불변 조건.
//
//   (a) docx 산출물의 긴 하이픈 0건은 docx-render.test.js 에서 문서 단위로 검사.
//   (b) stripEquationMarkersForDocx: {{EQ:...}} 마커 래퍼가 완전히 제거되어
//       raw 마커가 docx 본문에 노출되지 않아야 한다.
//   (c) _classifyPhysicsTable: 진자 헤더 -> measured-period.
//       진자 증거가 전혀 없는 헤더 + '데이터정리1' 파일명 -> general (W1-D 회귀:
//       파일명 휴리스틱만으로 비진자 엑셀이 theory-comparison 으로 오배정되어
//       canonical 보정이 보고서 표를 오염시키는 결함 방지).
//   (d) _reconcileChartTrendline: 실측 데이터와 무관한 가공 추세선(slope 0.093)을
//       서버가 최소제곱 fit(실측 기울기 -0.009)으로 재계산해 교체.
//
// phys-result/generate.js 의 `_` 접두 export 는 테스트를 위해 공개된 함수들이다.

"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

const { stripEquationMarkersForDocx } = require(
  path.join(H.REPO_ROOT, "lib", "latex-to-unicode"),
);
const {
  _classifyPhysicsTable: classifyPhysicsTable,
  _reconcileChartTrendline: reconcileChartTrendline,
  _splitTextIntoSentences: splitTextIntoSentences,
} = require(path.join(H.REPO_ROOT, "lib", "pipelines", "phys-result", "generate"));

describe("불변 조건: _splitTextIntoSentences (약어·괄호 절단 방지, DEF-038)", () => {
  it("괄호 안 영문 약어(Effect. Rot. m)에서 문장을 자르지 않는다", () => {
    const out = splitTextIntoSentences(
      "도르래의 유효 회전질량(Effect. Rot. m) 값이 기록되어 있다. 다음 문장이다.",
    );
    assert.equal(out.length, 2);
    assert.ok(out[0].includes("(Effect. Rot. m)"));
  });
  it("괄호 밖 약어(Exp. a)도 자르지 않고, 한국어 종결은 정상 분리한다", () => {
    const out = splitTextIntoSentences("Exp. a 열은 유지한다. 결론이다.");
    assert.equal(out.length, 2);
    assert.ok(out[0].startsWith("Exp. a"));
  });
  it("소수점(9.8)과 일반 영문 문장 분리는 기존과 동일하다", () => {
    assert.equal(splitTextIntoSentences("값은 9.8 m/s^2였다. 끝.").length, 2);
    assert.equal(splitTextIntoSentences("The value ends. The next starts.").length, 2);
  });
});

describe("불변 조건: 수식 마커 제거 (docx 경로)", () => {
  it("stripEquationMarkersForDocx('{{EQ:x=1}}') 는 마커를 제거한다", () => {
    const out = stripEquationMarkersForDocx("{{EQ:x=1}}");
    assert.equal(out, "x=1");
    assert.ok(!out.includes("{{EQ"), "마커 래퍼가 남아 있음");
  });

  it("문장 속 {{EQ-LATEX:...}} 도 평문 수식으로 변환된다", () => {
    const out = stripEquationMarkersForDocx(
      "주기 공식 {{EQ-LATEX:T = 2\\pi\\sqrt{L/g}}} 을 사용한다.",
    );
    assert.ok(!out.includes("{{"), `마커 잔존: ${out}`);
    assert.ok(!out.includes("}}"), `마커 잔존: ${out}`);
    assert.ok(out.includes("T = 2"), `수식 본문 유실: ${out}`);
  });
});

describe("불변 조건: _classifyPhysicsTable (W1-D 회귀 방지)", () => {
  it("진자 헤더(Pendulum/Period/Ipivot/Icm) -> measured-period", () => {
    const role = classifyPhysicsTable("아무파일.xlsx", {
      sheetName: "Sheet1",
      headers: ["Pendulum Type", "Avg Period", "Ipivot", "Icm"],
      rows: [["Rod", "1.23", "4.56", "3.21"]],
    });
    assert.equal(role, "measured-period");
  });

  it("비진자 헤더 + '데이터정리1' 파일명 -> general (파일명 폴백 기각)", () => {
    const role = classifyPhysicsTable("데이터정리1.xlsx", {
      sheetName: "Sheet1",
      headers: ["시간 (s)", "전압 (V)"],
      rows: [["0", "1.2"]],
    });
    assert.equal(
      role,
      "general",
      "진자 헤더 증거가 없으면 파일명만으로 theory-comparison 이 되면 안 된다",
    );
  });

  it("진자 증거 헤더 + '데이터정리1' 파일명 -> theory-comparison (폴백 유지)", () => {
    const role = classifyPhysicsTable("데이터정리1.xlsx", {
      sheetName: "Sheet1",
      headers: ["Pendulum Type", "Avg Period"],
      rows: [["Rod", "1.23"]],
    });
    assert.equal(role, "theory-comparison");
  });
});

describe("불변 조건: _reconcileChartTrendline (가공 추세선 교체)", () => {
  it("실측 기울기 -0.009 인 데이터에 slope 0.093 추세선 -> 재계산 교체", () => {
    // 실측 점 (0,1.0) (10,0.91) (20,0.82) (30,0.73): 정확히 slope -0.009, 절편 1.0
    const chart = {
      type: "scatter",
      title: "Drift Check",
      x_values: [0, 10, 20, 30],
      series: [{ label: "Measured", values: [1.0, 0.91, 0.82, 0.73] }],
      trendline: { slope: 0.093, intercept: 0.5, label: "Linear Fit" },
    };
    const result = reconcileChartTrendline(chart);
    assert.ok(result, "가공 추세선이 그대로 통과하면 안 된다");
    assert.equal(result.action, "recomputed");
    assert.ok(
      Math.abs(chart.trendline.slope - -0.009) < 1e-9,
      `추세선 기울기가 실측 fit(-0.009)이어야 함. 실제: ${chart.trendline.slope}`,
    );
    assert.ok(
      Math.abs(chart.trendline.intercept - 1.0) < 1e-9,
      `추세선 절편이 실측 fit(1.0)이어야 함. 실제: ${chart.trendline.intercept}`,
    );
  });

  it("fit 근거(수치 데이터)가 없으면 추세선 자체를 제거", () => {
    const chart = {
      type: "scatter",
      title: "No Numeric X",
      x_values: ["A", "B"],
      series: [{ label: "Measured", values: [1.0, 2.0] }],
      trendline: { slope: 1.0, intercept: 0.0, label: "Linear Fit" },
    };
    const result = reconcileChartTrendline(chart);
    assert.ok(result, "fit 불가 spec 인데 추세선이 통과함");
    assert.equal(result.action, "removed");
    assert.equal(chart.trendline, undefined, "추세선 키가 삭제되어야 한다");
  });

  it("실측 fit 과 일치하는 추세선은 건드리지 않는다", () => {
    const chart = {
      type: "scatter",
      x_values: [0, 10, 20, 30],
      series: [{ label: "Measured", values: [1.0, 0.91, 0.82, 0.73] }],
      trendline: { slope: -0.009, intercept: 1.0, label: "Linear Fit" },
    };
    const result = reconcileChartTrendline(chart);
    assert.equal(result, null, "정합 추세선은 변경 없음(null)이어야 한다");
  });
});
