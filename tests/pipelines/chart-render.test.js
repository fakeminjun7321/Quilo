// 보고서 파이프라인 회귀: 차트 spec -> PNG 렌더 (chem-result/chart-gen).
//
// renderChart 는 chem-result 와 phys-result(및 free-report)가 공유하는
// 차트 렌더러다. 실측 회귀 포인트:
//   - x_values + values 조합의 line spec (가장 흔한 형태)
//   - values 없이 points({x,y})만 갖는 line spec: 모델이 실제로 내는 형태.
//     예전엔 축만 있는 빈 차트가 그려졌다(DEF-017) -> 지금은 정상 PNG 렌더.
//   - 유효 데이터 0점 spec: 빈 PNG 대신 null 을 반환해 호출부가 실패를 가시화.
//   - bar + reference_line(참값 라인) spec.
//
// 기본은 in-process 렌더(CHART_RENDER_INLINE=1)로 빠르게 검사하고,
// 프로덕션 기본 경로(워커 fork)와 Chart.js 엔진 폴백도 각각 1회씩 태운다.

"use strict";

process.env.CHART_RENDER_INLINE = "1"; // fork 없이 in-process 렌더 (호출 시점에 읽힘)

const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

const { renderChart } = require(
  path.join(H.REPO_ROOT, "lib", "pipelines", "chem-result", "chart-gen"),
);

function lineSpecWithValues() {
  return {
    title: "Temperature vs Time",
    type: "line",
    x_label: "Time (s)",
    y_label: "Temperature (C)",
    x_values: [0, 30, 60, 90],
    series: [{ label: "Measured", values: [21.5, 24.1, 26.8, 27.9] }],
  };
}

function lineSpecWithPointsOnly() {
  // DEF-017 실측 형태: values 없이 수치 points 만 있는 line spec.
  return {
    title: "Absorbance vs Concentration",
    type: "line",
    x_label: "Concentration (M)",
    y_label: "Absorbance",
    series: [
      {
        label: "Sample",
        points: [
          { x: 0.1, y: 0.12 },
          { x: 0.2, y: 0.25 },
          { x: 0.3, y: 0.36 },
          { x: 0.4, y: 0.49 },
        ],
      },
    ],
  };
}

describe("chart-gen renderChart (spec -> PNG Buffer)", () => {
  it("x_values + values line spec -> PNG Buffer", async () => {
    const png = await renderChart(lineSpecWithValues());
    assert.ok(H.isPngBuffer(png), "PNG 매직의 Buffer 여야 한다");
  });

  it("points 기반 line spec -> PNG Buffer (DEF-017 회귀 방지)", async () => {
    const png = await renderChart(lineSpecWithPointsOnly());
    assert.ok(
      H.isPngBuffer(png),
      "values 없이 points 만 있는 line spec 도 PNG 로 렌더돼야 한다",
    );
  });

  it("데이터 0점 spec -> null (빈 차트 무음 삽입 방지)", async () => {
    const png = await renderChart({
      title: "Empty",
      type: "line",
      x_values: [],
      series: [{ label: "none", values: [] }],
    });
    assert.equal(png, null, "유효 데이터 0점이면 null 을 반환해야 한다");
  });

  it("bar + reference_line spec -> PNG Buffer", async () => {
    const png = await renderChart({
      title: "Mean Volume by Tool",
      type: "bar",
      x_label: "Tool",
      y_label: "Volume (mL)",
      x_values: ["Pipette", "Buret"],
      series: [{ label: "Mean", values: [10.01, 10.02] }],
      reference_line: { value: 10.0, label: "True value" },
    });
    assert.ok(H.isPngBuffer(png), "참값 라인이 있는 bar spec 도 PNG 로 렌더돼야 한다");
  });

  it("Chart.js 엔진 폴백에서도 points 기반 line spec -> PNG (DEF-017)", async () => {
    process.env.CHART_RENDER_ENGINE = "chartjs";
    try {
      const png = await renderChart(lineSpecWithPointsOnly());
      assert.ok(H.isPngBuffer(png), "chartjs 엔진에서도 PNG 렌더돼야 한다");
    } finally {
      delete process.env.CHART_RENDER_ENGINE;
    }
  });

  it("프로덕션 기본 경로(워커 fork) -> PNG Buffer", { timeout: 60_000 }, async () => {
    delete process.env.CHART_RENDER_INLINE; // renderChart 가 호출 시점에 읽으므로 안전
    try {
      const png = await renderChart(lineSpecWithValues());
      assert.ok(H.isPngBuffer(png), "워커 fork 경로에서도 PNG Buffer 여야 한다");
    } finally {
      process.env.CHART_RENDER_INLINE = "1";
    }
  });
});
