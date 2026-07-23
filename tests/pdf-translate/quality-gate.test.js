const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PDF_TRANSLATION_QUALITY_ERROR,
  resolveMinFontThreshold,
  assertCompleteTranslations,
  assertCompleteRender,
  assertCompleteRasterization,
  assertCompleteChunkResults,
  mayFallbackRetypesetToInplace,
} = require("../../lib/pipelines/pdf-translate/quality-gate");

function isQualityFailure(error, kind) {
  assert.equal(error.code, PDF_TRANSLATION_QUALITY_ERROR);
  assert.equal(error.details.kind, kind);
  return true;
}

function explicitRenderStats({
  expected = 5,
  replaced = 3,
  preservedIds = ["formula-1", "formula-2"],
  preservedCount = preservedIds.length,
} = {}) {
  const fontExpected = replaced;
  return {
    ok: true,
    expected,
    replaced,
    drawn: replaced,
    completed: replaced + preservedCount,
    page_expected: fontExpected + preservedCount,
    page_drawn: fontExpected,
    font_expected: fontExpected,
    preserved_original: preservedCount,
    preserved_original_ids: preservedIds,
    virtual_replaced: 0,
    outline_expected: 0,
    outline_replaced: 0,
    metadata_expected: 0,
    metadata_replaced: 0,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 8,
    font_sizes: Array.from({ length: fontExpected }, (_, index) => ({
      id: index + 1,
      source: 10,
      rendered: 8,
    })),
  };
}

test("문단 하나라도 누락되면 원문 혼합 렌더링을 거부한다", () => {
  const blocks = [
    { id: 1, text: "First paragraph" },
    { id: 2, text: "Second paragraph" },
    { id: 3, text: "Third paragraph" },
  ];
  assert.throws(
    () => assertCompleteTranslations(blocks, { 1: "첫 문단", 2: "   " }),
    (error) => {
      isQualityFailure(error, "missing_translations");
      assert.deepEqual(error.details.missingIds, ["2", "3"]);
      assert.match(error.message, /미번역 원문을 섞지 않고/);
      return true;
    },
  );
});

test("모든 문단 ID에 비어 있지 않은 결과가 있으면 통과한다", () => {
  assert.deepEqual(
    assertCompleteTranslations(
      [
        { id: "a", text: "Alpha" },
        { id: "b", text: "123" },
      ],
      { a: "알파", b: "123" },
    ),
    { expected: 2, translated: 2, missingIds: [] },
  );
});

test("번역문을 모두 받았어도 PDF에 일부만 삽입되면 거부한다", () => {
  assert.throws(
    () =>
      assertCompleteRender(
        {
          ok: false,
          replaced: 4,
          overflow: 0,
          failed: 1,
          overflow_ids: [],
          failed_ids: [9],
          min_font: 4,
        },
        5,
      ),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.match(error.message, /문단 삽입 4\/5/);
      assert.match(error.message, /그리기 실패 1개\(ID: 9\)/);
      return true;
    },
  );
  assert.deepEqual(
    assertCompleteRender(
      {
        ok: true,
        replaced: 5,
        overflow: 0,
        failed: 0,
          overflow_ids: [],
          failed_ids: [],
          min_font: 6.5,
          font_sizes: Array.from({ length: 5 }, (_, index) => ({
            id: index + 1,
            source: 10,
            rendered: 6.5,
          })),
      },
      5,
      { minFontPt: 6 },
    ),
    {
      expected: 5,
      replaced: 5,
      overflow: 0,
      failed: 0,
      minFont: 6.5,
      minGlyphFont: null,
      fontSizes: Array.from({ length: 5 }, (_, index) => ({
        id: index + 1,
        source: 10,
        rendered: 6.5,
      })),
    },
  );
});

test("허용된 수식 원문 보존은 삽입 수와 합쳐 전체 문단을 충족하면 통과한다", () => {
  assert.deepEqual(
    assertCompleteRender(explicitRenderStats(), 5, {
      allowedPreservedOriginalIds: ["formula-1", "formula-2"],
      minFontPt: 6,
    }),
    {
      expected: 5,
      replaced: 3,
      overflow: 0,
      failed: 0,
      minFont: 8,
      minGlyphFont: null,
      fontSizes: Array.from({ length: 3 }, (_, index) => ({
        id: index + 1,
        source: 10,
        rendered: 8,
      })),
      completed: 5,
      preservedOriginal: 2,
      preservedOriginalIds: ["formula-1", "formula-2"],
    },
  );
});

test("명시적 원문 보존 0개와 보존 필드 없는 구버전 성공 응답을 모두 허용한다", () => {
  assert.equal(
    assertCompleteRender(
      explicitRenderStats({ expected: 2, replaced: 2, preservedIds: [] }),
      2,
    ).completed,
    2,
  );

  const legacy = {
    ok: true,
    replaced: 1,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 8,
    font_sizes: [{ id: 1, source: 9, rendered: 8 }],
  };
  assert.equal(assertCompleteRender(legacy, 1).replaced, 1);
});

test("원문 보존 개수와 ID 배열 길이가 다르면 fail-closed로 거부한다", () => {
  assert.throws(
    () => assertCompleteRender(
      explicitRenderStats({ preservedCount: 2, preservedIds: ["formula-1"] }),
      5,
      { allowedPreservedOriginalIds: ["formula-1"] },
    ),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.preservationContractPresent, false);
      assert.match(error.message, /원본 글리프 보존 계약이 유효하지 않음/);
      return true;
    },
  );
});

test("원문 보존 ID가 중복되면 fail-closed로 거부한다", () => {
  assert.throws(
    () => assertCompleteRender(
      explicitRenderStats({ preservedIds: ["formula-1", "formula-1"] }),
      5,
      { allowedPreservedOriginalIds: ["formula-1"] },
    ),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.preservationContractPresent, false);
      return true;
    },
  );
});

test("호출부가 허용하지 않은 원문 보존 ID는 fail-closed로 거부한다", () => {
  assert.throws(
    () => assertCompleteRender(explicitRenderStats(), 5, {
      allowedPreservedOriginalIds: ["formula-1"],
    }),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.deepEqual(error.details.unknownPreservedOriginalIds, ["formula-2"]);
      assert.equal(error.details.preservationContractPresent, false);
      return true;
    },
  );
});

test("삽입 수와 허용 원문 보존 수의 합이 전체보다 작으면 fail-closed로 거부한다", () => {
  const stats = explicitRenderStats({ expected: 5, replaced: 2 });
  assert.throws(
    () => assertCompleteRender(stats, 5, {
      allowedPreservedOriginalIds: ["formula-1", "formula-2"],
    }),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.completed, 4);
      assert.match(error.message, /문단 처리 4\/5/);
      return true;
    },
  );
});

test("renderer completed 진단값이 삽입+보존 합계와 다르면 fail-closed로 거부한다", () => {
  assert.throws(
    () => assertCompleteRender(
      { ...explicitRenderStats(), completed: 4 },
      5,
      { allowedPreservedOriginalIds: ["formula-1", "formula-2"] },
    ),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.rendererCompleted, 4);
      assert.equal(error.details.completed, 5);
      assert.equal(error.details.completedContractPresent, false);
      assert.match(error.message, /렌더러 완료 합계 계약이 유효하지 않음/);
      return true;
    },
  );
});

test("모든 블록을 commit했어도 최소 글꼴에서 넘친 블록이 있으면 거부한다", () => {
  assert.throws(
    () =>
      assertCompleteRender(
        {
          ok: false,
          replaced: 5,
          overflow: 1,
          failed: 0,
          overflow_ids: [3],
          failed_ids: [],
          min_font: 4,
        },
        5,
      ),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.overflow, 1);
      assert.deepEqual(error.details.overflowIds, ["3"]);
      assert.match(error.message, /글자 넘침 1개\(ID: 3\)/);
      return true;
    },
  );
});

test("구버전 렌더러처럼 overflow/failed 진단값이 없으면 성공으로 보지 않는다", () => {
  assert.throws(
    () => assertCompleteRender({ ok: true, replaced: 5 }, 5),
    (error) => {
      isQualityFailure(error, "incomplete_render");
      assert.equal(error.details.diagnosticsPresent, false);
      assert.match(error.message, /렌더 완전성 진단값이 없음/);
      return true;
    },
  );
});

test("본문 base 글꼴이 허용 최저 크기보다 작으면 가독성 실패로 거부한다", () => {
  const stats = {
    ok: true,
    replaced: 2,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 5.5,
    // 첨자 실제 글리프는 더 작아도 gate 기준은 의도된 본문 base 크기다.
    min_glyph_font: 3.63,
    font_sizes: [
      { id: 1, source: 10, rendered: 5.5, min_glyph: 3.63 },
      { id: 2, source: 9, rendered: 6, min_glyph: 3.96 },
    ],
  };
  assert.throws(
    () => assertCompleteRender(stats, 2, { minFontPt: 6 }),
    (error) => {
      isQualityFailure(error, "unreadable_font_size");
      assert.equal(error.details.minFont, 5.5);
      assert.equal(error.details.minGlyphFont, 3.63);
      assert.equal(error.details.threshold, 6);
      assert.deepEqual(error.details.fontViolations.map((entry) => entry.id), [1]);
      return true;
    },
  );
  assert.equal(
    assertCompleteRender(stats, 2, { minFontPt: 0 }).minFont,
    5.5,
  );
});

test("기본 8pt 정책은 원문 10pt 문단이 7pt로 축소되면 자동 거부한다", () => {
  const stats = {
    ok: true,
    replaced: 1,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 7,
    min_glyph_font: 4.62,
    font_sizes: [{ id: 218, source: 10, rendered: 7, min_glyph: 4.62 }],
  };
  assert.throws(
    () => assertCompleteRender(stats, 1),
    (error) => {
      isQualityFailure(error, "unreadable_font_size");
      assert.equal(error.details.threshold, 8);
      assert.deepEqual(error.details.fontViolations.map((entry) => entry.id), [218]);
      assert.match(error.message, /10→7pt/);
      return true;
    },
  );
});

test("원문 자체가 작은 글꼴이면 같은 크기로 보존한 결과를 허용한다", () => {
  const stats = {
    ok: true,
    replaced: 1,
    overflow: 0,
    failed: 0,
    overflow_ids: [],
    failed_ids: [],
    min_font: 7.5,
    min_glyph_font: 7.5,
    font_sizes: [{ id: 7, source: 7.5, rendered: 7.5, min_glyph: 7.5 }],
  };
  const result = assertCompleteRender(stats, 1);
  assert.equal(result.minFont, 7.5);
  assert.equal(result.fontSizes[0].rendered, 7.5);

  assert.throws(
    () => assertCompleteRender({
      ...stats,
      min_font: 7,
      min_glyph_font: 7,
      font_sizes: [{ id: 7, source: 7.5, rendered: 7, min_glyph: 7 }],
    }, 1),
    (error) => {
      isQualityFailure(error, "unreadable_font_size");
      return true;
    },
  );
});

test("최소 글꼴 환경값은 기본 8pt이며 override와 0 비활성화를 유지한다", () => {
  assert.equal(resolveMinFontThreshold(""), 8);
  assert.equal(resolveMinFontThreshold("invalid"), 8);
  assert.equal(resolveMinFontThreshold("7.25"), 7.25);
  assert.equal(resolveMinFontThreshold("0"), 0);
});

test("페이지 상한으로 잘린 OCR 래스터 입력을 거부한다", () => {
  assert.throws(
    () =>
      assertCompleteRasterization({
        page_count: 31,
        rendered_pages: 30,
        tiles: 30,
        truncated: true,
        files: Array.from({ length: 30 }, (_, i) => `p-${i}.png`),
      }),
    (error) => {
      isQualityFailure(error, "incomplete_rasterization");
      assert.match(error.message, /페이지 커버리지 30\/31/);
      return true;
    },
  );
});

test("이미지 준비에 실패한 OCR 타일이 하나라도 있으면 거부한다", () => {
  assert.throws(
    () =>
      assertCompleteRasterization(
        {
          page_count: 2,
          rendered_pages: 2,
          tiles: 3,
          truncated: false,
          files: ["p-0.png", "p-1a.png", "p-1b.png"],
        },
        { preparedCount: 2 },
      ),
    (error) => {
      isQualityFailure(error, "incomplete_rasterization");
      assert.match(error.message, /모델 입력 타일 준비 2\/3/);
      return true;
    },
  );
});

test("페이지와 타일이 모두 준비된 OCR 입력은 통과한다", () => {
  assert.deepEqual(
    assertCompleteRasterization(
      {
        page_count: 2,
        rendered_pages: 2,
        tiles: 2,
        truncated: false,
        files: ["p-0.png", "p-1.png"],
      },
      { preparedCount: 2 },
    ),
    { pageCount: 2, renderedPages: 2, tileCount: 2, preparedCount: 2 },
  );
});

test("원문 폴백 구간이 섞인 OCR 병합 결과를 거부한다", () => {
  assert.throws(
    () =>
      assertCompleteChunkResults(
        [
          { partPath: "/tmp/translated-1.pdf", fellBack: false },
          { partPath: "/tmp/source-2.pdf", fellBack: true },
        ],
        { expectedCount: 2 },
      ),
    (error) => {
      isQualityFailure(error, "incomplete_chunks");
      assert.deepEqual(error.details.incomplete, [2]);
      assert.match(error.message, /미번역 원문 또는 빈 구간을 병합하지 않고/);
      return true;
    },
  );
});

test("명시적·자동 재조판과 복원은 빠른 번역으로 자동 강등하지 않는다", () => {
  assert.equal(
    mayFallbackRetypesetToInplace({ requestedMode: "retypeset", restoreOnly: false }),
    false,
  );
  assert.equal(
    mayFallbackRetypesetToInplace({ requestedMode: "auto", restoreOnly: true }),
    false,
  );
  assert.equal(
    mayFallbackRetypesetToInplace({ requestedMode: "auto", restoreOnly: false }),
    false,
  );
});
