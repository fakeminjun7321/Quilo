const assert = require("node:assert/strict");
const test = require("node:test");

const {
  annotatePageContinuations,
  buildTranslationReusePlan,
  findUntranslatedEnglishProse,
  findUnsupportedTargetCodePoints,
  normalizeLatinCompatibilityLigatures,
  normalizeTranslatedEnglishScaleNotation,
  looksLikeCodeOnly,
  pageContinuationIssue,
  translateBatch,
  translateBlocksWithRetries,
  validateTranslationCandidate,
  validateTranslationMap,
} = require("../../lib/pipelines/pdf-translate/translate");

function reasonCodes(result) {
  return result.reasons.map((reason) => reason.code);
}

test("translation prompt uses batch-wide document context and domain-sensitive terminology", async () => {
  let captured;
  const blocks = [
    { id: 101, text: "Regression fixture" },
    { id: 102, text: "The physical fixture holds the sample." },
  ];
  const { map } = await translateBatch(async (request) => {
    captured = request;
    return {
      text: JSON.stringify({
        t: {
          101: "회귀 테스트 픽스처",
          102: "물리적 고정구가 시료를 고정한다.",
        },
      }),
      usage: {},
    };
  }, blocks);

  assert.deepEqual(Object.keys(map).sort(), ["101", "102"]);
  assert.match(captured.system, /Read ALL segments in the batch as parts of one document/);
  assert.match(captured.system, /IDs are separate only for output mapping and completeness checks/);
  assert.doesNotMatch(captured.system, /Translate each id independently/i);
  assert.match(captured.system, /born-digital.*디지털 원본.*처음부터 디지털로 생성된/);
  assert.match(captured.system, /reflow text\/prose.*재배치.*줄바꿈 재조정.*never 재흐름/);
  assert.match(captured.system, /internal jump.*문서 내 이동 링크.*never 내부 점프/);
  assert.match(captured.system, /heading.*제목.*표제.*header\/머리글/);
  assert.match(captured.system, /test\/regression fixture.*테스트 픽스처.*never 고정물.*실험 템플릿/);
  assert.match(captured.system, /measurement ledger.*측정값 기록부.*측정값 목록/);
  assert.match(captured.system, /unit SYMBOLS.*m, kg, eV/);
  assert.match(captured.system, /nautical mile.*해리.*electron volts.*전자볼트.*years.*년/);
  assert.match(captured.system, /18 million.*1,800만.*500 million.*5억/);
  assert.match(captured.system, /physical\/mechanical fixture.*장치.*고정구/);
  assert.match(captured.system, /해라체 or 하십시오체.*do not mix/);
  assert.match(captured.system, /Still translate lowercase English common nouns such as fixture and page/);
});

test("repeated fixture segments retain every output ID without correction-reason leakage", async () => {
  const calls = [];
  const blocks = [
    { id: 201, text: "Regression fixture" },
    { id: 202, text: "The regression fixture is reusable." },
    { id: 203, text: "The physical fixture holds the sample." },
  ];
  const suppliedByFakeModel = {
    201: "회귀 테스트 픽스처",
    202: "회귀 테스트 픽스처는 재사용할 수 있다.",
    203: "물리적 고정구는 시료를 고정한다.",
  };
  const caller = async (request) => {
    calls.push(request);
    // The test supplies a fake model result; production JavaScript does not synthesize or
    // assert that these Korean phrases are the one true translation.
    return { text: JSON.stringify({ t: suppliedByFakeModel }), usage: {} };
  };

  const result = await translateBlocksWithRetries({
    blocks,
    caller,
    retrySizes: [],
    verbose: false,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(result.translations, suppliedByFakeModel);
  for (const id of [201, 202, 203]) assert.match(calls[0].user, new RegExp(`"id":${id}`));
  assert.doesNotMatch(calls[0].user, /targeted correction retry|previous answers were rejected/i);
  assert.doesNotMatch(calls[0].user, /^- ID \d+:/m);
});

test("already-Korean and exact duplicate segments avoid model tokens while preserving every ID", async () => {
  const calls = [];
  const caller = async ({ user }) => {
    calls.push(user);
    return {
      text: JSON.stringify({
        t: {
          1: "반복되는 머리글",
          5: "고유한 본문입니다.",
        },
      }),
      usage: { input_tokens: 12, output_tokens: 7 },
    };
  };

  const result = await translateBlocksWithRetries({
    blocks: [
      { id: 1, text: "Repeated header" },
      { id: 2, text: "Repeated header" },
      { id: 3, text: "이미 한국어인 문단입니다." },
      { id: 4, text: "Repeated header" },
      { id: 5, text: "Unique body text." },
    ],
    caller,
    retrySizes: [],
    verbose: false,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0], /"id":1/);
  assert.match(calls[0], /"id":5/);
  assert.doesNotMatch(calls[0], /"id":2|"id":3|"id":4/);
  assert.deepEqual(result.translations, {
    1: "반복되는 머리글",
    2: "반복되는 머리글",
    3: "이미 한국어인 문단입니다.",
    4: "반복되는 머리글",
    5: "고유한 본문입니다.",
  });
  assert.deepEqual(result.reuse, { korean: 1, duplicates: 2, modelBlocks: 2 });
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 7);
});

test("formula-only blocks bypass the model while prose containing an equation is translated", async () => {
  const calls = [];
  const result = await translateBlocksWithRetries({
    blocks: [
      { id: 1, text: "= sin(A − 90<sup>◦</sup>)cos(90<sup>◦</sup>− b)cosc" },
      { id: 2, text: "sinB sina = sinAsinb," },
      { id: 3, text: "sinsinaA = sinb" },
      { id: 4, text: "Since x = 1, the relation is simple." },
      { id: 5, text: "or" },
    ],
    caller: async ({ user }) => {
      calls.push(user);
      return {
        text: JSON.stringify({
          t: {
            4: "x = 1이므로 관계는 단순하다.",
            5: "또는",
          },
        }),
        usage: {},
      };
    },
    retrySizes: [],
    verbose: false,
  });

  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0], /"id":1|"id":2|"id":3/);
  assert.match(calls[0], /"id":4/);
  assert.match(calls[0], /"id":5/);
  assert.equal(result.translations[1], "= sin(A − 90<sup>◦</sup>)cos(90<sup>◦</sup>− b)cosc");
  assert.equal(result.translations[2], "sinB sina = sinAsinb,");
  assert.equal(result.translations[3], "sinsinaA = sinb");
  assert.equal(result.translations[4], "x = 1이므로 관계는 단순하다.");
  assert.equal(result.translations[5], "또는");
});

test("a failed canonical duplicate remains fail-closed for all repeated IDs", async () => {
  await assert.rejects(
    translateBlocksWithRetries({
      blocks: [
        { id: 11, text: "Repeated unsafe text." },
        { id: 12, text: "Repeated unsafe text." },
      ],
      caller: async () => ({ text: JSON.stringify({ t: {} }), usage: {} }),
      retrySizes: [],
      verbose: false,
    }),
    (error) => {
      assert.equal(error.code, "PDF_TRANSLATION_QUALITY_FAILURE");
      assert.deepEqual(error.details.missingIds, ["11", "12"]);
      return true;
    },
  );
});

test("rejects lowercase untranslated prose outside a Korean parenthetical gloss", () => {
  const source = "This born-digital page contains an ordinary paragraph.";

  const hyphenated = validateTranslationCandidate(
    { id: 1, text: source },
    "이 born-digital 페이지에는 일반 문단이 있습니다.",
  );
  assert.equal(hyphenated.ok, false);
  assert.deepEqual(hyphenated.reasons[0].phrases, ["born-digital"]);

  const multiword = validateTranslationCandidate(
    { id: 1, text: source },
    "이 디지털 원본 페이지에는 ordinary paragraph가 있습니다.",
  );
  assert.equal(multiword.ok, false);
  assert.deepEqual(multiword.reasons[0].phrases, ["ordinary paragraph"]);

  assert.deepEqual(
    findUntranslatedEnglishProse(source, "이 디지털 원본 페이지에는 일반 문단이 있습니다."),
    [],
  );
});

test("rejects a continuation fragment that drops most source meaning", () => {
  const result = validateTranslationCandidate(
    { id: "continuation", text: "path on the surface of the sphere between these points." },
    "경로이다.",
  );
  assert.equal(result.ok, false);
  assert.equal(reasonCodes(result).includes("translation_too_short"), true);

  assert.deepEqual(
    validateTranslationCandidate(
      { id: "continuation", text: "path on the surface of the sphere between these points." },
      "이 점들 사이의 구면 위 경로이다.",
    ),
    { ok: true, reasons: [] },
  );
});

test("open formula introductions use an exact eight-character shortness floor", () => {
  const block = {
    id: 87,
    text: "and the altitude at the lower culmination is",
  };
  assert.deepEqual(
    validateTranslationCandidate(block, "하중에서의 고도는"),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "we-have", text: "For the corresponding angular relation we have:" },
      "따라서 해당 관계는",
    ),
    { ok: true, reasons: [] },
  );

  const tooShort = validateTranslationCandidate(block, "하중 고도는");
  assert.equal(reasonCodes(tooShort).includes("translation_too_short"), true);
  assert.equal(
    tooShort.reasons.find((reason) => reason.code === "translation_too_short")
      .minimumTargetLength,
    8,
  );
  for (const [source, target] of [
    ["The properties of distant galaxies and all the evidence we have", "우리가 가진 모든 증거"],
    ["The properties of every distant galaxy and all the evidence we thus have", "우리가 가진 증거다"],
    ["The properties of every distant galaxy and all the evidence we then have", "우리가 가진 증거다"],
    ["The properties of every distant galaxy and all the evidence are given by", "증거는 다음으로 주어진다"],
    ["The distribution of every stellar population and its complete luminosity function is expressed as", "광도함수는 다음과 같다"],
    ["The most important observation of all the data available to us is", "가장 중요한 관측은"],
  ]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate({ id: "ordinary-open-ending", text: source }, target))
        .includes("translation_too_short"),
      true,
      source,
    );
  }
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "standalone-formula-transition", text: "Thus we have:" },
      "따라서 다음을 얻는다:",
    ),
    { ok: true, reasons: [] },
  );
});

test("page-edge continuation pairs are retried atomically with joined source context", async () => {
  const calls = [];
  const blocks = [
    {
      id: 26,
      page: 5,
      text: "The English text was written by the Finnish authors, who are responsible for updating the text and correcting",
    },
    { id: 27, page: 5, text: "viii" },
    { id: 28, page: 6, text: "Chapter 1" },
    { id: 29, page: 6, text: "Fundamental Astronomy" },
    {
      id: 30,
      page: 6,
      text: "errors found in the original edition. The parts on galactic and extragalactic astronomy have been extensively revised.",
    },
  ];
  const caller = async (request) => {
    const payloadStart = request.user.lastIndexOf("\n\n[");
    assert.notEqual(payloadStart, -1);
    calls.push({
      user: request.user,
      items: JSON.parse(request.user.slice(payloadStart + 2)),
    });
    if (calls.length === 1) {
      return {
        text: JSON.stringify({
          t: {
            26: "영문 원고는 핀란드 저자들이 작성했으며, 이들은 본문을 갱신하고 수정했습니다.",
            28: "제1장",
            29: "기본 천문학",
            30: "원판에서 발견된 오류들을. 은하 천문학과 외부은하 천문학 부분은 대폭 개정되었다.",
          },
        }),
        usage: {},
      };
    }
    return {
      text: JSON.stringify({
        t: {
          26: "영문 원고는 핀란드 저자들이 작성했으며, 이들은 본문을 갱신하고",
          30: "원판에서 발견된 오류를 바로잡을 책임이 있다. 은하 천문학과 외부은하 천문학 부분은 대폭 개정되었다.",
        },
      }),
      usage: {},
    };
  };

  const result = await translateBlocksWithRetries({
    blocks,
    caller,
    retrySizes: [1],
    verbose: false,
  });

  assert.equal(calls.length, 2);
  const firstPair = calls[0].items.filter((item) => [26, 30].includes(item.id));
  assert.deepEqual(firstPair.map((item) => item.id), [26, 30]);
  assert.deepEqual(firstPair.map((item) => item.continuation_role), ["head", "tail"]);
  assert.deepEqual(firstPair.map((item) => item.continuation_index), [0, 1]);
  assert.equal(firstPair[0].continuation_group, firstPair[1].continuation_group);
  assert.equal(firstPair[0].joined_source, firstPair[1].joined_source);
  assert.match(firstPair[0].joined_source, /correcting ⟂ errors found/);
  assert.deepEqual(calls[1].items.map((item) => item.id), [26, 30]);
  assert.match(calls[1].user, /ID 26: .*페이지 경계/);
  assert.match(calls[1].user, /ID 30: .*페이지 경계/);
  assert.doesNotMatch(calls[1].user, /"id":28|"id":29/);
  assert.equal(
    result.translations[26],
    "영문 원고는 핀란드 저자들이 작성했으며, 이들은 본문을 갱신하고",
  );
  assert.match(result.translations[30], /^원판에서 발견된 오류를 바로잡을 책임이 있다/);
});

test("completed page endings and uppercase next-page prose are not continuation groups", () => {
  const completed = annotatePageContinuations([
    {
      id: 1,
      page: 10,
      text: "This complete paragraph is deliberately long enough to qualify as ordinary page prose.",
    },
    {
      id: 2,
      page: 11,
      text: "lowercase-looking prose on the next page is independent because the prior paragraph ended.",
    },
  ]);
  assert.equal(completed.some((block) => block.continuation_group), false);

  const uppercase = annotatePageContinuations([
    {
      id: 3,
      page: 20,
      text: "This paragraph ends without punctuation and is deliberately long enough to qualify",
    },
    {
      id: 4,
      page: 21,
      text: "However this new paragraph begins with an uppercase word and is not a continuation.",
    },
  ]);
  assert.equal(uppercase.some((block) => block.continuation_group), false);

  const captionBetweenBodyHalves = annotatePageContinuations([
    {
      id: 169,
      page: 5,
      text: "In normal stars electrons travel only a short distance, so conduction",
    },
    {
      id: 170,
      page: 5,
      text: "Fig. 11.3 The energy flowing out of a spherical shell is the sum of the energy generated within the shell",
    },
    {
      id: 173,
      page: 6,
      text: "only becomes important in compact stars, white dwarfs and neutron stars.",
    },
  ]);
  const bodyHead = captionBetweenBodyHalves.find((block) => block.id === 169);
  const caption = captionBetweenBodyHalves.find((block) => block.id === 170);
  const bodyTail = captionBetweenBodyHalves.find((block) => block.id === 173);
  assert.equal(bodyHead.continuation_group, "169>173");
  assert.equal(bodyTail.continuation_group, "169>173");
  assert.equal(caption.continuation_group, undefined);
});

test("continuation validation catches polite sentence endings without treating nouns as endings", () => {
  const members = annotatePageContinuations([
    {
      id: "head",
      page: 30,
      text: "The authors remain responsible for updating this long passage and correcting",
    },
    {
      id: "tail",
      page: 31,
      text: "errors found in the earlier edition before publication of the current volume.",
    },
  ]);
  assert.equal(
    pageContinuationIssue(members, {
      head: "저자들은 이 긴 구절을 갱신하고 오류를 수정했습니다.",
      tail: "이전 판에서 발견된 오류를 바로잡을 책임이 있다.",
    }).code,
    "page_continuation_broken",
  );
  assert.equal(
    pageContinuationIssue(members, {
      head: "저자들에게는 이 긴 구절을 갱신하고 오류를 수정할 책임",
      tail: "이 있으며, 현 판이 출판되기 전에 이전 판의 오류를 바로잡아야 한다.",
    }),
    null,
  );
});

test("formula-introduction tails may end in a Korean particle but ordinary tails may not", () => {
  const formulaMembers = annotatePageContinuations([
    {
      id: 82,
      page: 1,
      text: "At upper culmination the corresponding long relation gives the altitude",
    },
    {
      id: 87,
      page: 2,
      text: "and the altitude at the lower culmination is",
    },
  ]);
  assert.equal(
    pageContinuationIssue(formulaMembers, {
      82: "상중에서의 관계에 이어",
      87: "하중에서의 고도는",
    }),
    null,
  );

  const ordinaryMembers = annotatePageContinuations([
    {
      id: 26,
      page: 5,
      text: "The authors remain responsible for updating this long passage and correcting",
    },
    {
      id: 30,
      page: 6,
      text: "errors found in the earlier edition before publication of the current volume.",
    },
  ]);
  assert.equal(
    pageContinuationIssue(ordinaryMembers, {
      26: "저자들에게는 이 긴 구절을 갱신하고 수정할 책임",
      30: "이전 판에서 발견된 오류는",
    }).code,
    "page_continuation_broken",
  );
});

test("true page-continuation groups evaluate shortness jointly without permitting omissions", () => {
  const members = annotatePageContinuations([
    {
      id: 30,
      page: 1,
      text: "Since declination and right ascension are in- dependent of the position of the observer and the",
    },
    {
      id: 33,
      page: 2,
      text: "motions of the Earth, they can be used in star maps and catalogues. As will be explained later, in many telescopes one of the axes (the hour axis) is parallel to the rotation axis of the Earth. The other axis (declination axis) is perpendicular to the hour axis. Declinations can be read imme- diately on the declination dial of the telescope. But the zero point of the right ascension seems to move in the sky, due to the diurnal rotation of the Earth. So we cannot use the right ascension to ﬁnd an object unless we know the direction of the vernal equinox.",
    },
  ]);
  const actual = {
    30: "적위와 적경은 관측자의 위치와",
    33: "지구의 운동에 독립적이므로 성도와 성표에 사용할 수 있다. 뒤에서 설명하겠지만, 많은 망원경에서는 축들 가운데 하나(시각축)가 지구 자전축과 평행하다. 다른 축(적위축)은 시각축에 수직이다. 적위는 망원경의 적위 눈금에서 바로 읽을 수 있다. 그러나 적경의 영점은 지구의 일주 자전 때문에 하늘에서 움직이는 것처럼 보인다. 따라서 춘분점의 방향을 알지 못하면 적경으로 천체를 찾을 수 없다.",
  };
  assert.equal(
    reasonCodes(validateTranslationCandidate(members[0], actual[30]))
      .includes("translation_too_short"),
    true,
  );
  assert.deepEqual(validateTranslationMap(members, actual), {
    accepted: actual,
    rejected: {},
  });
  assert.equal(pageContinuationIssue(members, actual), null);

  const missing = validateTranslationMap(members, { 33: actual[33] });
  assert.equal(reasonCodes(missing.rejected["30"]).includes("missing_response"), true);

  const tooShortAsAGroup = validateTranslationMap(members, {
    30: "적위와 적경은 관측 위치를 따르고",
    33: "지구 운동과 관련된 좌표이다.",
  });
  assert.equal(
    reasonCodes(tooShortAsAGroup.rejected["33"]).includes("translation_too_short"),
    true,
  );
});

test("a continuation spanning three pages remains one ordered atomic group", async () => {
  const blocks = [
    {
      id: "a",
      page: 1,
      text: "The first part of this unusually long sentence describes the telescope and",
    },
    {
      id: "b",
      page: 2,
      text: "continues with the detector calibration while the same explanation still",
    },
    {
      id: "c",
      page: 3,
      text: "ends by stating why the final measurement is reliable.",
    },
  ];
  const annotated = annotatePageContinuations(blocks);
  assert.deepEqual(
    annotated.map((block) => block.continuation_role),
    ["head", "middle", "tail"],
  );
  assert.deepEqual(annotated.map((block) => block.continuation_index), [0, 1, 2]);
  assert.equal(new Set(annotated.map((block) => block.continuation_group)).size, 1);
  assert.equal(new Set(annotated.map((block) => block.joined_source)).size, 1);
  assert.equal(pageContinuationIssue(annotated, {
    a: "이 매우 긴 문장의 첫 부분은 망원경을 자세히 설명하고",
    b: "검출기 보정에 관한 같은 설명을 중단 없이 계속 이어서",
    c: "마지막 측정값이 신뢰할 수 있는 이유를 밝히며 끝난다.",
  }), null);

  const calls = [];
  const result = await translateBlocksWithRetries({
    blocks,
    batchChars: 1,
    retrySizes: [],
    verbose: false,
    caller: async ({ user }) => {
      const payloadStart = user.lastIndexOf("\n\n[");
      calls.push(JSON.parse(user.slice(payloadStart + 2)));
      return {
        text: JSON.stringify({
          t: {
            a: "이 매우 긴 문장의 첫 부분은 망원경을 자세히 설명하고",
            b: "검출기 보정에 관한 같은 설명을 중단 없이 계속 이어서",
            c: "마지막 측정값이 신뢰할 수 있는 이유를 밝히며 끝난다.",
          },
        }),
        usage: {},
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(calls[0].map((item) => item.continuation_count), [3, 3, 3]);
  assert.equal(result.translations.c.endsWith("끝난다."), true);
});

test("rejects isolated untranslated prose words and source labels", () => {
  const years = validateTranslationCandidate(
    { id: "years", text: "One revolution takes 18.6 years." },
    "한 번 공전하는 데 18.6 years가 걸린다.",
  );
  assert.equal(years.ok, false);
  assert.equal(reasonCodes(years).includes("untranslated_english_prose"), true);

  const section = validateTranslationCandidate(
    { id: "section", text: "See Sect. 2.10." },
    "Sect. 2.10을 참조한다.",
  );
  assert.equal(section.ok, false);
  assert.equal(reasonCodes(section).includes("untranslated_english_prose"), true);

  assert.deepEqual(
    validateTranslationCandidate(
      { id: "ok", text: "One revolution takes 18.6 years; see Sect. 2.10." },
      "한 번 공전하는 데 18.6년이 걸린다. 2.10절을 참조한다.",
    ),
    { ok: true, reasons: [] },
  );
});

test("allows URLs, code, formulas, units, IDs, acronyms, proper nouns, and parenthetical glosses", () => {
  const cases = [
    [
      "Attention improves the residual connection.",
      "어텐션(attention)은 잔차 연결(residual connection)을 개선합니다.",
    ],
    [
      "OpenAI API model XG-42 uses 12 kg at https://example.com/v1?q=2.",
      "OpenAI API 모델 XG-42는 https://example.com/v1?q=2에서 12 kg을 사용합니다.",
    ],
    ["Run `npm install foo bar` now.", "이제 `npm install foo bar`를 실행합니다."],
    ["npm install foo bar", "npm install foo bar"],
    ["The sample ID abc-def is valid.", "샘플 ID abc-def는 유효합니다."],
    ["New York uses numpy.", "New York에서는 numpy를 사용합니다."],
    ["10 kg m s", "10 kg m s"],
    [
      "H<sub>2</sub>O has energy E<sup>2</sup>.",
      "H<sub>2</sub>O의 에너지는 E<sup>2</sup>입니다.",
    ],
  ];

  for (const [source, target] of cases) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "allowed", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }
});

test("allows Latin math function names in preserved equations", () => {
  const formula = "y <sup>′</sup>= y cosχ + zsinχ,(2.4)";
  assert.deepEqual(
    validateTranslationCandidate({ id: "formula", text: formula }, formula),
    { ok: true, reasons: [] },
  );

  const captionSource =
    "Fig. 2.5 The coordinates of point P are y <sup>′</sup>= y cosχ + z sinχ.";
  const captionTarget =
    "그림 2.5 점 P의 좌표는 y <sup>′</sup>= y cosχ + z sinχ이다.";
  assert.deepEqual(
    validateTranslationCandidate({ id: "caption", text: captionSource }, captionTarget),
    { ok: true, reasons: [] },
  );
});

test("ordinary limit-prefix words are not mistaken for glued math functions", () => {
  const proseCases = [
    ["The Chandrasekhar limit is 1.4.", "찬드라세카르 한계는 1.4이다."],
    ["The limiting magnitude is 20.", "한계등급은 20이다."],
    ["minor = 4", "소항목 = 4"],
    ["limb = 1", "가장자리 = 1"],
  ];
  for (const [source, target] of proseCases) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "math-prefix-prose", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  const formulaCases = [
    ["lim x = 0", "lim x = 0"],
    ["sin i = 1", "sin i = 1"],
    ["sini = 1", "sini = 1"],
  ];
  for (const [source, target] of formulaCases) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "real-math-function", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  const changed = validateTranslationCandidate(
    { id: "changed-lim", text: "lim x = 0" },
    "sin x = 0",
  );
  assert.equal(reasonCodes(changed).includes("scientific_literals_changed"), true);
});

test("source-exact compact scientific units and identifiers are not English prose", () => {
  const cases = [
    ["The particle mass is 4 amu.", "입자 질량은 4 amu이다."],
    ["The field integral is 3 gausscm.", "장 적분은 3 gausscm이다."],
    [
      "The velocity is 70 kms<sup>−1</sup>.",
      "속도는 70 kms<sup>−1</sup>이다.",
    ],
    ["The relation uses lgz.", "관계에는 lgz를 사용한다."],
    ["The formula uses sini = 1.", "공식에는 sini = 1을 사용한다."],
    ["Older literature uses the variable ict.", "오래된 문헌에서는 변수 ict를 사용한다."],
    [
      "The x<sup>′</sup>y<sup>′</sup>z<sup>′</sup> frame moves.",
      "x<sup>′</sup>y<sup>′</sup>z<sup>′</sup> 좌표계가 움직인다.",
    ],
    ["The scale is 1 arc sec.", "척도는 1 arc sec이다."],
    [
      "Fig. 18.9 The size of the volume element at distance r in the direction (l,b) is ωr<sup>2</sup> dr",
      "그림 18.9 방향 (l,b)에서 거리 r에 있는 부피요소의 크기는 ωr<sup>2</sup> dr이다.",
    ],
  ];
  for (const [source, target] of cases) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "compact-science", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  const invented = validateTranslationCandidate(
    { id: "invented-compact-science", text: "The value is stable." },
    "값은 amu이다.",
  );
  assert.equal(reasonCodes(invented).includes("untranslated_english_prose"), true);

  const ordinaryArc = validateTranslationCandidate(
    { id: "ordinary-arc", text: "The arc is visible." },
    "arc가 보인다.",
  );
  assert.equal(reasonCodes(ordinaryArc).includes("untranslated_english_prose"), true);

  const exactLedgerMutations = [
    ["The mass is 4 amu.", "질량은 4 amu amu이다."],
    ["The mass is 4 amu.", "질량은 4 AMU이다."],
    ["The formula contains ndl dA.", "이 식은 NDL dA를 포함한다."],
    ["The mass is 4 amu.", "질량은 4 kms이다."],
    ["The velocity is 70 kms<sup>−1</sup>.", "속도는 70<sup>−1</sup>이다."],
  ];
  for (const [source, target] of exactLedgerMutations) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "compact-ledger-mutation", text: source },
        target,
      )).includes("scientific_literals_changed"),
      true,
      `${source} -> ${target}`,
    );
  }
});

test("bibliographic and between dotted initials is allowed but prose and is rejected", () => {
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "authors", text: "Georgelin, Y.M. and Y.P., 381" },
      "Georgelin, Y.M. and Y.P., 381",
    ),
    { ok: true, reasons: [] },
  );

  const prose = validateTranslationCandidate(
    { id: "prose-and", text: "A and B are variables." },
    "A and B는 변수이다.",
  );
  assert.equal(reasonCodes(prose).includes("untranslated_english_prose"), true);
});

test("discretionary prose hyphens do not create math functions while real sec remains literal", () => {
  assert.deepEqual(
    validateTranslationCandidate(
      { id: 272, text: "The scale is 1 arc sec- ond per mark." },
      "눈금 하나당 1각초의 척도이다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "sec", text: "For angle x, sec x = 2." },
      "각 x에 대해 sec x = 2이다.",
    ),
    { ok: true, reasons: [] },
  );

  const changed = validateTranslationCandidate(
    { id: "sec-changed", text: "For angle x, sec x = 2." },
    "각 x에 대해 cos x = 2이다.",
  );
  assert.equal(reasonCodes(changed).includes("scientific_literals_changed"), true);
});

test("allows conventional Korean digits for explicit English number words but never drops literal digits", () => {
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "number-words", text: "Sixth Edition, April 2016, one tenth" },
      "제6판, 2016년 4월, 10분의 1",
    ),
    { ok: true, reasons: [] },
  );

  const abbreviatedMonth = {
    id: "abbreviated-month",
    text: "During the maximum (Sept 27, 2001), spots were visible; exactly seven years later none remained.",
  };
  assert.deepEqual(
    validateTranslationCandidate(
      abbreviatedMonth,
      "극대기(2001년 9월 27일)에는 흑점이 보였지만, 정확히 7년 뒤에는 하나도 남지 않았다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      abbreviatedMonth,
      "극대기(2001년 10월 27일)에는 흑점이 보였지만, 정확히 7년 뒤에는 하나도 남지 않았다.",
    )).includes("preserved_numbers_changed"),
    true,
  );

  const nonzeroAndFraction = {
    id: "nonzero-and-fraction",
    text: "If the mass is nonzero, assume that Λ = 0 and the other density is one tenth of the critical density.",
  };
  const faithfulNonzero =
    "질량이 0이 아니라면 Λ = 0이고 다른 밀도는 임계밀도의 10분의 1이라고 가정한다.";
  assert.deepEqual(
    validateTranslationCandidate(nonzeroAndFraction, faithfulNonzero),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      nonzeroAndFraction,
      faithfulNonzero.replace("다른 밀도는", "다른 0 밀도는"),
    )).includes("preserved_numbers_changed"),
    true,
  );

  const missingLiteral = validateTranslationCandidate(
    { id: "missing-literal", text: "Sixth Edition with 419 illustrations" },
    "삽화가 수록된 제6판",
  );
  assert.equal(missingLiteral.ok, false);
  assert.equal(reasonCodes(missingLiteral).includes("preserved_numbers_changed"), true);
});

test("source-bound duration conversion accepts two decades as 20 years only", () => {
  const block = {
    id: 23,
    text: "For over two decades the Green Bank telescope was the largest.",
  };
  assert.deepEqual(
    validateTranslationCandidate(
      block,
      "20년이 넘는 기간 동안 Green Bank 망원경이 가장 컸다.",
    ),
    { ok: true, reasons: [] },
  );

  for (const invented of ["30년", "20개의 망원경이 있는 기간"] ) {
    const rejected = validateTranslationCandidate(
      block,
      `${invented} 동안 Green Bank 망원경이 가장 컸다.`,
    );
    assert.equal(reasonCodes(rejected).includes("preserved_numbers_changed"), true);
  }
});

test("astronomy formula unit literals sterad and magkpc are not untranslated prose", () => {
  const formula = "ω = 2.01 × 10<sup>7</sup> Wm<sup>−2</sup> sterad<sup>−1</sup>.";
  assert.deepEqual(
    validateTranslationCandidate({ id: 590, text: formula }, formula),
    { ok: true, reasons: [] },
  );

  assert.deepEqual(
    validateTranslationCandidate(
      {
        id: 653,
        text: "The visual-band extinction is a<sub>V</sub> = 1 magkpc<sup>−1</sup>.",
      },
      "시각 대역 소광은 a<sub>V</sub> = 1 magkpc<sup>−1</sup>이다.",
    ),
    { ok: true, reasons: [] },
  );
});

test("Fig. 2.33 permits half an hour as 30분 but not unrelated numeric credits", () => {
  const block = {
    id: 422,
    text: "Fig. 2.33 The time zones. The map gives the difference of the local zonal time from the Greenwich mean time (UT). During daylight saving time, one hour must be added to the given figures. When travelling across the date line westward, the date must be incremented by one day, and decremented if going eastward. For example, a traveller taking a flight from Honolulu to Tokyo on Monday morning will arrive on Tuesday, even though (s)he does not see a single night en route. In 2015 North Korea adopted time zone UTC+8.5 h, which is half an hour behind the South Korean time. (Drawing U.S. Naval Observatory)",
  };
  const translated =
    "그림 2.33 시간대. 이 지도는 현지 표준시와 그리니치 평균시(UT)의 차이를 보여 준다. 일광 절약 시간에는 표시된 값에 한 시간을 더해야 한다. 날짜 변경선을 서쪽으로 건너면 날짜를 하루 늘리고, 동쪽으로 건너면 하루 줄여야 한다. 예를 들어 월요일 아침 Honolulu에서 Tokyo로 출발한 여행자는 도중에 밤을 한 번도 보지 않지만 화요일에 도착한다. 2015년 North Korea는 UTC+8.5 h 시간대를 채택했으며, 이는 South Korea 시간보다 30분 늦다. (U.S. Naval Observatory 그림)";
  assert.deepEqual(validateTranslationCandidate(block, translated), {
    ok: true,
    reasons: [],
  });

  for (const invented of ["99분", "7분"]) {
    const rejected = validateTranslationCandidate(
      block,
      translated.replace("30분", invented),
    );
    assert.equal(reasonCodes(rejected).includes("preserved_numbers_changed"), true);
  }

  const changedLiteral = validateTranslationCandidate(
    block,
    translated.replace("2015년", "2016년"),
  );
  assert.equal(reasonCodes(changedLiteral).includes("preserved_numbers_changed"), true);
});

test("discretionary month breaks grant only the corresponding Korean month digit", () => {
  const source =
    "Currently most maps and catalogues use the epoch J2000.0, which means the beginning of the year 2000, or, to be exact, the noon of Jan- uary 1, 2000, or the Julian date 2,451,545.0 (see Sect. 2.15).";
  const target =
    "현재 대부분의 성도와 목록은 원기 J2000.0을 사용하며, 이것은 2000년의 시작, 더 정확히는 2000년 1월 1일 정오, 또는 율리우스일 2,451,545.0을 뜻한다(2.15절 참조).";
  assert.deepEqual(
    validateTranslationCandidate({ id: 152, text: source }, target),
    { ok: true, reasons: [] },
  );

  const invented = validateTranslationCandidate(
    { id: 152, text: source },
    target.replace("정오", "정오 9시"),
  );
  assert.equal(reasonCodes(invented).includes("preserved_numbers_changed"), true);
});

test("exact English-to-Korean large-number scaling accepts normalization but not wrong quantities", () => {
  const source =
    "With the new media, the size of the star cat- alogues exploded. The ﬁrst Hubble Guide Star Catalog from the early 1990’s contained 18 mil- lion stars and the second Guide Star Catalog from the year 2001, nearly 500 million stars. It was surpassed by the U.S. Naval Observatory USNO-B1.0 Catalog, which contains entries for 1,024,618,261 stars and galaxies from digitised images of several photographic sky surveys. The catalogue presents right ascension and declina- tion, proper motion and magnitude estimates.";
  const translated =
    "새로운 매체의 등장으로 성표의 규모는 폭발적으로 커졌다. 1990년대 초의 첫 번째 Hubble Guide Star Catalog에는 1,800만 개의 별이 들어 있었고, 2001년의 두 번째 Guide Star Catalog에는 거의 5억 개의 별이 들어 있었다. 이를 능가한 것이 U.S. Naval Observatory의 USNO-B1.0 Catalog로, 여러 사진 천구 탐사의 디지털화된 영상에서 얻은 1,024,618,261개의 별과 은하 항목을 담고 있다. 이 성표는 적경과 적위, 고유운동, 등급 추정치를 제시한다.";
  assert.deepEqual(
    validateTranslationCandidate({ id: 363, text: source }, translated),
    { ok: true, reasons: [] },
  );

  const wrongScale = validateTranslationCandidate(
    { id: 363, text: source },
    translated.replace("1,800만", "1,700만"),
  );
  assert.equal(reasonCodes(wrongScale).includes("preserved_numbers_changed"), true);

  const untranslatedScale = validateTranslationCandidate(
    { id: 363, text: source },
    translated
      .replace("1,800만", "18 million")
      .replace("5억", "500 million"),
  );
  assert.deepEqual(untranslatedScale, { ok: true, reasons: [] });

  const scaleWithoutNumericLiteral = validateTranslationCandidate(
    { id: 363, text: source },
    translated.replace("1,800만", "million"),
  );
  assert.equal(
    reasonCodes(scaleWithoutNumericLiteral).includes("untranslated_english_prose"),
    true,
  );
});

test("normalizes residual English scale notation exactly before accepting ID 135", () => {
  assert.equal(
    normalizeTranslatedEnglishScaleNotation("2 million years ago", "2 million years"),
    "200만 년",
  );
  assert.equal(
    normalizeTranslatedEnglishScaleNotation("2 million years ago", "2 million년"),
    "200만 년",
  );
  assert.equal(
    normalizeTranslatedEnglishScaleNotation("18 million stars", "18 million"),
    "1,800만",
  );
  assert.equal(
    normalizeTranslatedEnglishScaleNotation("500 million stars", "500 million"),
    "5억",
  );
  assert.equal(
    normalizeTranslatedEnglishScaleNotation(
      "The title is 2 Million Years B.C.",
      "The Million Dollar title and 200만 년",
    ),
    "The Million Dollar title and 200만 년",
  );
  for (const skipped of ["2.5 million", "$2 million", "2-3 million", "2 Million"]) {
    assert.equal(normalizeTranslatedEnglishScaleNotation(skipped, skipped), skipped);
  }
  assert.equal(
    normalizeTranslatedEnglishScaleNotation("200 years", "2 million years"),
    "2 million years",
  );

  const block = {
    id: 135,
    text: "The light coming from the Andromeda Galaxy in the northern sky originated 2 million years ago.",
  };
  const rawCandidate =
    "북쪽 하늘의 안드로메다은하에서 오는 빛은 2 million years 전에 출발했다.";
  assert.deepEqual(validateTranslationMap([block], { 135: rawCandidate }), {
    accepted: {
      135: "북쪽 하늘의 안드로메다은하에서 오는 빛은 200만 년 전에 출발했다.",
    },
    rejected: {},
  });
  assert.deepEqual(
    validateTranslationMap([block], {
      135: rawCandidate.replace("2 million", "3 million"),
    }).accepted,
    {},
  );
  const wrongQuantity = validateTranslationCandidate(
    block,
    rawCandidate.replace("2 million", "3 million"),
  );
  assert.equal(reasonCodes(wrongQuantity).includes("preserved_numbers_changed"), true);

  const hallucinatedScale = validateTranslationCandidate(
    { id: "plain-years", text: "The record spans 200 years." },
    "이 기록은 2 million years에 걸쳐 있다.",
  );
  assert.equal(reasonCodes(hallucinatedScale).includes("preserved_numbers_changed"), true);
  assert.equal(reasonCodes(hallucinatedScale).includes("untranslated_english_prose"), true);

  const equivalentButUnboundScale = validateTranslationCandidate(
    { id: "different-scale", text: "The catalogue contains 2 billion entries." },
    "이 성표에는 2000 million개의 항목이 있다.",
  );
  assert.equal(
    reasonCodes(equivalentButUnboundScale).includes("preserved_numbers_changed"),
    true,
  );
  assert.equal(equivalentButUnboundScale.ok, false);
});

test("an implicit singular per-time rate may add only the Korean numeral one", () => {
  const source =
    "The greatest known proper motion belongs to Barnard’s Star, which moves across the sky at the enormous speed of 10.3 arc seconds per year. It needs less than 200 years to travel the diameter of a full moon.";
  const explicitOne =
    "알려진 가장 큰 고유운동은 Barnard’s Star에 속하며, 이 별은 하늘을 가로질러 1년에 10.3 초각이라는 엄청난 속도로 움직인다. 보름달의 지름만큼 이동하는 데 200년도 채 걸리지 않는다.";
  assert.deepEqual(
    validateTranslationCandidate({ id: 282, text: source }, explicitOne),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: 282, text: source },
      explicitOne.replace("1년에", "연간"),
    ),
    { ok: true, reasons: [] },
  );

  const inventedTwo = validateTranslationCandidate(
    { id: 282, text: source },
    explicitOne.replace("1년에", "2년에"),
  );
  assert.equal(reasonCodes(inventedTwo).includes("preserved_numbers_changed"), true);

  const changedLiteral = validateTranslationCandidate(
    { id: 282, text: source },
    explicitOne.replace("10.3", "11.3"),
  );
  assert.equal(reasonCodes(changedLiteral).includes("preserved_numbers_changed"), true);

  const droppedLiteral = validateTranslationCandidate(
    { id: 282, text: source },
    explicitOne.replace("200년도", "그리 오래 걸리지"),
  );
  assert.equal(reasonCodes(droppedLiteral).includes("preserved_numbers_changed"), true);
});

test("allows retained accented names, Roman page labels, Latin titles, and scientific variable words", () => {
  const cases = [
    ["Hannu Karttunen Pekka Kröger", "Hannu Karttunen Pekka Kröger"],
    ["viii", "viii"],
    ["The species Homo habilis appeared.", "Homo habilis 종이 나타났다."],
    [
      "Support came from Suomalaisen kirjallisuuden edistämisvarojen valtuuskunta.",
      "Suomalaisen kirjallisuuden edistämisvarojen valtuuskunta의 지원을 받았다.",
    ],
    ["Principia mathematica was published.", "Principia mathematica가 출판되었다."],
    ["Use rectangular xyz coordinates at 10 kgm−<sup>3</sup>.", "10 kgm−<sup>3</sup>에서 직교 xyz 좌표를 사용한다."],
    ["The sine formula follows.", "사인 공식은 다음과 같다."],
  ];
  for (const [source, target] of cases) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "proper-literal", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  const sourceBoundUnit = validateTranslationMap(
    [{ id: "unit-words", text: "The energy is 10 electron volts." }],
    { "unit-words": "에너지는 10 electron volts이다." },
  );
  assert.deepEqual(sourceBoundUnit, {
    accepted: { "unit-words": "에너지는 10 전자볼트이다." },
    rejected: {},
  });

  const sourceAbsentUnit = validateTranslationCandidate(
    { id: "unit-words", text: "The energy is 10 eV." },
    "에너지는 10 electron volts이다.",
  );
  assert.equal(sourceAbsentUnit.ok, false);
  assert.equal(reasonCodes(sourceAbsentUnit).includes("untranslated_english_prose"), true);
});

test("astronomy retry regressions distinguish formula literals from prose", () => {
  const formulaBlocks = [
    "coskx ˆi + sinkx ˆj",
    "R<sup>2</sup> − x<sup>2</sup> coskx dx.",
    "1 −t<sup>2</sup> cospt dt = 0.",
    "12v<sup>2</sup> −μ/r = const = h.(6.11)",
  ].map((text, id) => ({ id, text }));
  const plan = buildTranslationReusePlan(formulaBlocks);
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.direct, Object.fromEntries(
    formulaBlocks.map((block) => [String(block.id), block.text]),
  ));

  assert.deepEqual(
    validateTranslationCandidate(
      {
        id: "inline-product",
        text: "where we have used the equation s = f u. Here f is the focal length.",
      },
      "여기서 식 s = f u를 사용하였다. 여기서 f는 초점거리이다.",
    ),
    { ok: true, reasons: [] },
  );

  assert.deepEqual(
    validateTranslationCandidate(
      {
        id: "ligature-prose",
        text: "The nebular hypothesis was revised and modiﬁed in the 1940’s.",
      },
      "성운 가설은 1940년대에 수정되고 보완되었다.",
    ),
    { ok: true, reasons: [] },
  );
});

test("source-bound names, foreign lexemes, units and number words do not loop retries", () => {
  const organization = validateTranslationCandidate(
    {
      id: "organization",
      text: "The California Association for Research in Astronomy built a 10 m mirror.",
    },
    "California Association for Research in Astronomy는 10 m 거울을 제작했다.",
  );
  assert.deepEqual(organization, { ok: true, reasons: [] });

  const etymology = validateTranslationCandidate(
    { id: "foreign-word", text: "the French word couder, to bend" },
    "프랑스어 couder, 즉 ‘굽히다’라는 말",
  );
  assert.deepEqual(etymology, { ok: true, reasons: [] });

  const normalized = validateTranslationMap(
    [{
      id: "area",
      text: "Secondary particles cover one square kilometre; the response is normalised to unity.",
    }],
    {
      area: "2차 입자는 1 square kilometre를 덮으며, 응답은 1로 정규화된다.",
    },
  );
  assert.deepEqual(normalized, {
    accepted: { area: "2차 입자는 1 제곱킬로미터를 덮으며, 응답은 1로 정규화된다." },
    rejected: {},
  });

  const unsupported = validateTranslationCandidate(
    { id: "script", text: "The output is available in digital form." },
    "디지털 형태로 उपलब्ध한 출력이다.",
  );
  assert.equal(reasonCodes(unsupported).includes("unsupported_target_characters"), true);
});

test("exact spelled scale conversions and concise textbook labels avoid false rejections", () => {
  const scaleSource = "Photosynthesis continued for at least a billion years.";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "spelled-scale", text: scaleSource },
      "광합성은 적어도 10억 년 동안 계속되었다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "wrong-spelled-scale", text: scaleSource },
      "광합성은 적어도 9억 년 동안 계속되었다.",
    )).includes("preserved_numbers_changed"),
    true,
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "full-spelled-scale", text: scaleSource },
      "광합성은 적어도 1,000,000,000년 동안 계속되었다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "duplicate-spelled-scale", text: scaleSource },
      "광합성은 10억 년 동안 계속되었으며 그 수는 1,000,000,000이다.",
    )).includes("preserved_numbers_changed"),
    true,
  );
  for (const malformedScale of ["1,000,000,000만", "1,000,000,000억"]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "double-scaled", text: scaleSource },
        `광합성은 적어도 ${malformedScale}년 동안 계속되었다.`,
      )).includes("preserved_numbers_changed"),
      true,
      malformedScale,
    );
  }

  const labelSource = "Interstellar extinction and polarisation";
  const labelPlan = buildTranslationReusePlan([
    { id: 150, text: labelSource },
    { id: "__pdf_table_cell__:p0011:t000:r001:c000", text: labelSource },
  ]);
  assert.equal(labelPlan.pending.length, 1);
  assert.equal(labelPlan.pending[0].concise_structural_label, true);
  assert.deepEqual(
    validateTranslationCandidate(
      labelPlan.pending[0],
      "성간 소광과 편광",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      labelPlan.pending[0],
      "성간 소광",
    )).includes("translation_too_short"),
    true,
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "ordinary-prose", text: "Stars radiate energy across interstellar space" },
      "별은 에너지를 방출",
    )).includes("translation_too_short"),
    true,
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "unproven-label", text: labelSource },
      "성간 소광과 편광",
    )).includes("translation_too_short"),
    true,
  );

  assert.deepEqual(
    validateTranslationCandidate(
      { id: "formula-intro", text: "We now define that the product of a matrix and a column vector" },
      "이제 행렬과 열벡터의 곱을",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      {
        id: "closed-formula-sentence",
        text: "We now define that the product of two variables has a special property under every transformation",
      },
      "이제 곱을 정의한다",
    )).includes("translation_too_short"),
    true,
  );
  for (const finiteTail of [
    "transforms coordinates under rotation",
    "preserves orientation under rotation",
    "maps every point into space",
  ]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        {
          id: "finite-product-clause",
          text: `We now define that the product of a matrix and a column vector ${finiteTail}`,
        },
        "이제 행렬과 열벡터의 곱을",
      )).includes("translation_too_short"),
      true,
      finiteTail,
    );
  }
});

test("scientific markup atoms may move with Korean word order but cannot change attachment", () => {
  const source =
    "We measure F ′<sub>λ</sub> at λ<sub>1</sub> and λ<sub>2</sub>, then compare T<sub>exc</sub> with B<sub>ν</sub>(T<sub>exc</sub>) = S<sub>ν</sub>.";
  const reordered =
    "λ<sub>1</sub>과 λ<sub>2</sub>에서 F ′<sub>λ</sub>를 측정한 뒤, B<sub>ν</sub>(T<sub>exc</sub>) = S<sub>ν</sub>와 T<sub>exc</sub>를 비교한다.";
  assert.deepEqual(
    validateTranslationCandidate({ id: "reordered", text: source }, reordered),
    { ok: true, reasons: [] },
  );

  const wrongAttachment = reordered.replace("F ′<sub>λ</sub>", "F ′<sub>1</sub>");
  const rejected = validateTranslationCandidate(
    { id: "wrong-attachment", text: source },
    wrongAttachment,
  );
  assert.equal(reasonCodes(rejected).includes("scientific_markup_changed"), true);
});

test("scientific markup distinguishes prose footnotes and prefix isotope atoms", () => {
  const accepted = [
    ["Polarity<sup>b</sup>", "극성<sup>b</sup>"],
    ["Angle<sup>c</sup>", "각도<sup>c</sup>"],
    ["Magneto-pause<sup>d</sup>", "자기권계면<sup>d</sup>"],
    [
      "The amount of substance of a system which contains as many elementary entities as there. are atoms in 0.012 kg of <sup>12</sup>C.",
      "0.012 kg의 <sup>12</sup>C에 들어 있는 원자 수만큼의 기본 입자를 포함하는 계의 물질량.",
    ],
    ["Mass of <sup>1</sup>H atom", "<sup>1</sup>H 원자의 질량"],
    ["Mass of <sub>2</sub><sup>4</sup>He atom", "<sub>2</sub><sup>4</sup>He 원자의 질량"],
    ["Rydberg constant for <sup>1</sup>H", "<sup>1</sup>H에 대한 Rydberg 상수"],
  ];
  for (const [source, target] of accepted) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "table-cell", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
    assert.deepEqual(
      buildTranslationReusePlan([{ id: "table-cell", text: source }]).pending.map((block) => block.id),
      ["table-cell"],
      `natural-language table cell must not be classified as formula-only: ${source}`,
    );
  }

  const wrongFootnote = validateTranslationCandidate(
    { id: "footnote", text: "Polarity<sup>b</sup>" },
    "극성<sup>c</sup>",
  );
  assert.equal(reasonCodes(wrongFootnote).includes("scientific_markup_changed"), true);

  const wrongIsotopeBase = validateTranslationCandidate(
    { id: "isotope", text: "Mass of <sup>1</sup>H atom" },
    "<sup>1</sup>He 원자의 질량",
  );
  assert.equal(reasonCodes(wrongIsotopeBase).includes("scientific_markup_changed"), true);

  const swappedIsotopeTags = validateTranslationCandidate(
    { id: "isotope", text: "Mass of <sub>2</sub><sup>4</sup>He atom" },
    "<sup>2</sup><sub>4</sub>He 원자의 질량",
  );
  assert.equal(reasonCodes(swappedIsotopeTags).includes("scientific_markup_changed"), true);
});

test("astronomy footnotes and glued label variables retain only scientific attachments", () => {
  const footnoteSource =
    "<sup>b</sup>⇑same as the Earth, ⇓opposite <sup>c</sup>Angle between magnetic and rotational axes <sup>d</sup>Average magnetopause distance in the direction of the Sun in planetary radii";
  const footnoteTarget =
    "<sup>b</sup>⇑지구와 같음, ⇓반대 <sup>c</sup>자기축과 자전축 사이의 각 <sup>d</sup>태양 방향에서 본 평균 자기권계면 거리(행성 반지름 단위)";
  assert.deepEqual(
    validateTranslationCandidate({ id: 709, text: footnoteSource }, footnoteTarget),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: 709, text: footnoteSource },
      footnoteTarget.replace("<sup>d</sup>", "<sup>e</sup>"),
    )).includes("scientific_markup_changed"),
    true,
  );
  const swappedFootnotes = footnoteTarget
    .replace("<sup>b</sup>", "<sup>tmp</sup>")
    .replace("<sup>c</sup>", "<sup>b</sup>")
    .replace("<sup>tmp</sup>", "<sup>c</sup>");
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "swapped-footnotes", text: footnoteSource },
      swappedFootnotes,
    )).includes("scientific_markup_changed"),
    true,
  );
  const laterFootnoteSource = "Polarity<sup>f</sup>; Angle<sup>g</sup>";
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "later-swapped-footnotes", text: laterFootnoteSource },
      "극성<sup>g</sup>; 각도<sup>f</sup>",
    )).includes("scientific_markup_changed"),
    true,
  );

  const velocitySource = "Solar velocityv<sub>0</sub> = 19.7 kms<sup>−1</sup>";
  const velocityTarget = "태양 속도 v<sub>0</sub> = 19.7 kms<sup>−1</sup>";
  assert.deepEqual(
    validateTranslationCandidate({ id: 136, text: velocitySource }, velocityTarget),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: 136, text: velocitySource },
      velocityTarget.replace("v<sub>0</sub>", "u<sub>0</sub>"),
    )).includes("scientific_markup_changed"),
    true,
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "source-absent-prose", text: velocitySource },
      "태양 pressure v<sub>0</sub> = 19.7 kms<sup>−1</sup>",
    )).includes("untranslated_english_prose"),
    true,
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "chemical-control", text: "The ion is Na<sub>2</sub> at 5 kms<sup>−1</sup>." },
      "이 이온은 5 kms<sup>−1</sup>에서 Na<sub>2</sub>이다.",
    ),
    { ok: true, reasons: [] },
  );
});

test("source-exact bibliography spans do not authorize ordinary residual prose", () => {
  const bracketCitation =
    "[Aller, L.H. (1953): Astrophysics. The Atmospheres of the Sun and Stars (The Ronald Press Company, New York) p. 318]";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "bracket-citation", text: `The line is broad. ${bracketCitation}` },
      `이 선은 넓다. ${bracketCitation}`,
    ),
    { ok: true, reasons: [] },
  );

  const trailingCitation =
    "Preston, M.A. (1962): Physics of the Nucleus (Addison-Wesley Publishing Company, Inc., Reading, Mass.)";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "tail-citation", text: `The points are shown. ${trailingCitation}` },
      `점을 나타냈다. ${trailingCitation}`,
    ),
    { ok: true, reasons: [] },
  );

  const ordinaryResidual = validateTranslationCandidate(
    { id: "ordinary-prose", text: "This sentence describes one part of the catalogue." },
    "이 문장은 목록의 한 부분을 설명하며 of the를 그대로 남겼다.",
  );
  assert.equal(reasonCodes(ordinaryResidual).includes("untranslated_english_prose"), true);

  const alteredCitation = validateTranslationCandidate(
    { id: "altered-citation", text: `The line is broad. ${bracketCitation}` },
    `이 선은 넓다. ${bracketCitation.replace("of the Sun", "of the Moon")}`,
  );
  assert.equal(reasonCodes(alteredCitation).includes("preserved_bibliography_changed"), true);
  const parentheticalCitationChange = validateTranslationCandidate(
    {
      id: "parenthetical-citation-change",
      text: "The caption. Preston, M.A. (1962): Physics (Company, City)",
    },
    "캡션. Preston, M.A. (1962): Physics (Fake Publisher, Wrong City)",
  );
  assert.equal(
    reasonCodes(parentheticalCitationChange).includes("preserved_bibliography_changed"),
    true,
  );
});

test("caption bibliographies compare canonical ledgers while preserving every citation", () => {
  const fixtures = [
    [
      239,
      "Fig. 13.2 ... (Based on Van Zandt, R.P. (1977): Astronomy for the Amateur, Planetary Astronomy, Vol. 1, 3rd edn. (published by the author, Peoria, III.))",
      "그림 13.2 ... (Van Zandt, R.P. (1977): Astronomy for the Amateur, Planetary Astronomy, Vol. 1, 3rd edn. (published by the author, Peoria, III.)에 바탕을 둠.)",
    ],
    [
      54,
      "The source is shown (Drawing based on Smith, J.M. (1968): Intro- duction to Physics (State Uni- versity Press, Chicago) p. 54)",
      "출처를 나타낸다(Smith, J.M. (1968): Introduction to Physics (State University Press, Chicago) p. 54에서 그림).",
    ],
    [
      252,
      "The source is shown (Drawing based on Brown, B.M. (1970): Stars (The Univer- sity Press, Oxford) p. 252)",
      "출처를 나타낸다(Brown, B.M. (1970): Stars (The University Press, Oxford) p. 252에서 그림).",
    ],
    [
      28,
      "(Drawing based on Greenberg, J.M. (1968): “Interstellar Grains”, in Nebulae and Interstel- lar Matter, ed. by Middlehurst, B.M., Aller, L.H., Stars and Stellar Systems, Vol. VII (The University of Chicago Press, Chicago) p. 224) The result is compared with another source (Hoyle, F., Narlikar, J. (1980): The Physics-Astronomy Frontier (W.H. Freeman and Company, San Francisco) p. 156. Used by permission)",
      "(Greenberg, J.M. (1968): “Interstellar Grains”, in Nebulae and Interstellar Matter, ed. by Middlehurst, B.M., Aller, L.H., Stars and Stellar Systems, Vol. VII (The University of Chicago Press, Chicago) p. 224에 바탕을 둔 그림) 그 결과를 다른 출처와 비교한다(Hoyle, F., Narlikar, J. (1980): The Physics-Astronomy Frontier (W.H. Freeman and Company, San Francisco) p. 156. 허가를 받아 사용).",
    ],
  ];

  for (const [id, source, target] of fixtures) {
    assert.deepEqual(validateTranslationCandidate({ id, text: source }, target), {
      ok: true,
      reasons: [],
    }, String(id));
  }

  const source = fixtures[3][1];
  const target = fixtures[3][2];
  const mutations = [
    target.replace("Greenberg", "Greene"),
    target.replace("1968", "1969"),
    target.replace("Interstellar Grains", "Interstellar Dust"),
    target.replace("Chicago Press", "Oxford Press"),
    target.replace("p. 224", "p. 225"),
    target.replace(/\(Hoyle,[\s\S]*?사용\)\./, ""),
    `${target} ${target}`,
  ];
  for (const mutated of mutations) {
    assert.equal(
      reasonCodes(validateTranslationCandidate({ id: 28, text: source }, mutated))
        .includes("preserved_bibliography_changed"),
      true,
    );
  }
});

test("modern parenthetical citation ledgers preserve authors journals punctuation and multiplicity", () => {
  const first = "C. Kouveliotou et al. 2004, ApJ, 510, L115";
  const second = "R.A. Remillard and J.E. McClintock 2006, ARA&A, 44, 49";
  const source = `The events are catalogued (${first}; ${second}).`;
  const target = `사건을 분류했다(출처: ${first}; ${second}).`;
  assert.deepEqual(
    validateTranslationCandidate({ id: "modern-citations", text: source }, target),
    { ok: true, reasons: [] },
  );

  const mutations = [
    target.replace("Kouveliotou", "Kouveliotau"),
    target.replace("2004", "2005"),
    target.replace("ApJ", "AJ"),
    target.replace(`; ${second}`, ""),
    target.replace(first, `${first}; ${first}`),
    target.replace("2004, ApJ", "2004— ApJ"),
  ];
  for (const mutated of mutations) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "modern-citation-mutation", text: source },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }

  const classicSource =
    "The source is (Preston, M.A. (1962): Physics of the Nucleus (Company, City)).";
  const punctuationChanged = validateTranslationCandidate(
    { id: "citation-punctuation", text: classicSource },
    "출처는 (Preston, M.A. (1962)— Physics of the Nucleus (Company, City))이다.",
  );
  assert.equal(
    reasonCodes(punctuationChanged).includes("preserved_bibliography_changed"),
    true,
  );
});

test("citation candidates cover classic et al modern surname variants and yearless credits", () => {
  const citationFixtures = [
    "Tananbaum, H. et al. (1972): ApJ, 174, L143",
    "Schou et al. 1998, ApJ, 505, 390",
    "Blanton et al., 2003, AJ, 125, 2348",
    "Gabany, Martinez-Delgado et al., 2010, ApJ, 719, L79",
    "H.C. Ferguson et al., 2000, ARA&A, 38, 667",
    "Eisenstein et al., 2005, ApJ, 633, 560",
    "Smith et al. 2004, AJ, 128, 163",
    "Smith 2004",
  ];
  for (const citation of citationFixtures) {
    assert.deepEqual(
      validateTranslationCandidate(
        { id: "citation-shape", text: `The source is (${citation}).` },
        `출처는 (${citation})이다.`,
      ),
      { ok: true, reasons: [] },
      citation,
    );
  }

  const combined = citationFixtures.slice(1, 6).join("; ");
  const combinedSource = `The sources are (${combined}).`;
  const combinedTarget = `출처는 (${combined})이다.`;
  const mutations = [
    combinedTarget.replace("Schou", "Shou"),
    combinedTarget.replace("2003", "2004"),
    combinedTarget.replace("ARA&A", "AJ"),
    combinedTarget.replace(`; ${citationFixtures[3]}`, ""),
    combinedTarget.replace(citationFixtures[2], `${citationFixtures[2]}; ${citationFixtures[2]}`),
  ];
  for (const mutated of mutations) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "citation-shape-mutation", text: combinedSource },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }

  const creditFixtures = [
    ["Image (Photo: NASA/ESA).", "이미지(사진 제공: NASA/ESA)."],
    ["Image (Credit: Space Telescope Science Institute).", "이미지(출처: Space Telescope Science Institute)."],
    ["Image (Source: European Southern Observatory).", "이미지(자료 제공: European Southern Observatory)."],
    ["Image (Courtesy of R. Gendler).", "이미지(제공: R. Gendler)."],
    ["Photo: NASA/ESA", "사진 제공: NASA/ESA"],
    ["Caption (Photo ESO).", "캡션(사진 ESO)."],
    [
      "Caption (Photo by Compton Gamma Ray Observatory).",
      "캡션(사진 제공 Compton Gamma Ray Observatory).",
    ],
    ["Caption (NASA/JPL).", "캡션(NASA/JPL)."],
    ["Caption (NASA/JPL-Caltech/SSC).", "캡션(NASA/JPL-Caltech/SSC)."],
    ["Caption (Image NASA/Chandra).", "캡션(이미지 NASA/Chandra)."],
    ["Caption (Diagram by H. Virtanen).", "캡션(도표 제작 H. Virtanen)."],
    [
      "Caption (NASA/CXC/MIT/F.K. Baganoff et al.).",
      "캡션(NASA/CXC/MIT/F.K. Baganoff et al.).",
    ],
  ];
  for (const [source, target] of creditFixtures) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "yearless-credit", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  for (const mutated of [
    "이미지(사진 제공: NASA/ESO).",
    "이미지(사진 제공: NASA).",
    "이미지(사진 제공: NASA/ESA; NASA/ESA).",
  ]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "yearless-credit-mutation", text: creditFixtures[0][0] },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }

  const slashCreditSource = creditFixtures.at(-1)[0];
  for (const mutated of [
    "캡션(NASA/CXC/MIT/F.K. Baganov et al.).",
    "캡션(NASA/CXC/MIT et al.).",
    "캡션(NASA/CXC/MIT/F.K. Baganoff et al.; NASA/CXC/MIT/F.K. Baganoff et al.).",
  ]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "slash-credit-mutation", text: slashCreditSource },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }

  const pluralAndArtworkCredits = [
    [
      "Caption (Pho- tos by Ferdinand Ellerman and International Dark-Sky As- sociation).",
      "캡션(사진 Ferdinand Ellerman and International Dark-Sky Association).",
    ],
    [
      "Caption (Photos Palomar Observatory, Spetsialnaya Astroﬁzitsheskaya Observatorya).",
      "캡션(사진 Palomar Observatory, Spetsialnaya Astrofizitsheskaya Observatorya).",
    ],
    [
      "Caption (Drawing D. Ducros, XMM Team, ESA.) (Graph- ics NASA/JHU Applied Physics Laboratory).",
      "캡션(그림 D. Ducros, XMM Team, ESA.) (그래픽 NASA/JHU Applied Physics Laboratory).",
    ],
  ];
  for (const [source, target] of pluralAndArtworkCredits) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "plural-artwork-credit", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }
  for (const mutated of [
    "캡션(사진 Ferdinand Ellerman and International Night-Sky Association).",
    "캡션(사진 Palomar Observatory, Spetsialnaya Astrofizitsheskaya Observatoryb).",
    "캡션(그림 D. Ducros, XMM Team, ESA.).",
  ]) {
    const source = pluralAndArtworkCredits[
      mutated.includes("Ferdinand") ? 0 : (mutated.includes("Palomar") ? 1 : 2)
    ][0];
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "plural-artwork-credit-mutation", text: source },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }
});

test("live cover credits adapted citations and Korean program prose avoid validator false positives", () => {
  assert.deepEqual(
    validateTranslationCandidate(
      { id: 25, text: "The reader needs exact formalism for computer programs." },
      "독자는 컴퓨터 프로그램을 위해 정확한 형식화가 필요하다.",
    ),
    { ok: true, reasons: [] },
  );

  const coverSource =
    "Cover illustration: Atacama Large Millimeter/submillimeter Array (ALMA) is an interferom- eter telescope composed of 66 antennas. ALMA observes molecular gas and dust of the cool Universe—building blocks of stars, planetary systems, galaxies and life itself. Credit: ESO/ Y. Beletsky Printed on acid-free paper Springer is part of Springer Science+Business Media (www.springer.com)";
  const coverTarget =
    "표지 그림: Atacama Large Millimeter/submillimeter Array (ALMA)는 66개의 안테나로 이루어진 간섭계 망원경이다. ALMA는 차가운 우주를 이루는 분자 가스와 먼지, 곧 별, 행성계, 은하, 그리고 생명 자체의 구성 요소를 관측한다. Credit: ESO/ Y. Beletsky 무산성지에 인쇄됨 Springer는 Springer Science+Business Media의 일부이다 (www.springer.com)";
  assert.deepEqual(
    validateTranslationCandidate({ id: 13, text: coverSource }, coverTarget),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "cover-credit-change", text: coverSource },
      coverTarget.replace("ESO/ Y. Beletsky", "ESA/ Y. Beletsky"),
    )).includes("preserved_bibliography_changed"),
    true,
  );

  const adaptedSource =
    "Fig. 1.11 Astronomy in the change. The graph illustrates articles in 1981–2009. (Adapted from the New Worlds, New Hori- zons in Astronomy and Astrophysics, 2010, p. 120.) Published by the US National Science Academy";
  const adaptedTarget =
    "그림 1.11 변화하는 천문학. 이 그래프는 1981–2009년의 논문을 보여 준다. (New Worlds, New Horizons in Astronomy and Astrophysics, 2010, p. 120을 바탕으로 수정.) US National Science Academy 발행";
  assert.deepEqual(
    validateTranslationCandidate({ id: 117, text: adaptedSource }, adaptedTarget),
    { ok: true, reasons: [] },
  );
  const residualPublisher = validateTranslationCandidate(
    { id: "adapted-residual", text: adaptedSource },
    adaptedTarget.replace(
      "US National Science Academy 발행",
      "Published by the US National Science Academy",
    ),
  );
  assert.equal(reasonCodes(residualPublisher).includes("untranslated_english_prose"), true);
});

test("actual ID48 inline photographer credit preserves the author without binding ordinary prose", () => {
  const source = [
    "We are grateful to the following institutions who kindly gave us permission to use illustrations",
    "(ab- breviated references in the ﬁgure captions) Anglo-Australian Observatory, photograph by David R. Malin",
    "Arecibo Observatory, National Astronomy and Ionosphere Center, Cornell University Arp, Halton C.,",
    "Mount Wilson and Las Campanas Observatories (colour representation of plate by Jean Lorre)",
    "Big Bear Solar Observatory, California Institute of Technology Catalina Observatory, Lunar and Planetary Labo- ratory",
    "CSIRO (Commonwealth Scientiﬁc and Industrial Research Organisation), Division of Radio- physics, Sydney, Australia",
    "ESA (copyright Max-Planck-Institut für Astrono- mie, Lindau, Harz, FRG) European Southern Observatory (ESO)",
    "Helsinki University Observatory High Altitude Observatory, National Center for AtmosphericResearch, Foundation",
  ].join(" ");
  const target = [
    "그림 사용을 친절히 허가해 준 다음 기관들에 감사드린다(그림 설명의 약어 표기)",
    "Anglo-Australian Observatory, David R. Malin 촬영 Arecibo Observatory,",
    "National Astronomy and Ionosphere Center, Cornell University Arp, Halton C., Mount Wilson and Las Campanas Observatories",
    "(colour representation of plate by Jean Lorre) Big Bear Solar Observatory, California Institute of Technology",
    "Catalina Observatory, Lunar and Planetary Laboratory CSIRO",
    "(Commonwealth Scientiﬁc and Industrial Research Organisation), Division of Radio- physics, Sydney, Australia",
    "ESA (copyright Max-Planck-Institut für Astronomie, Lindau, Harz, FRG) European Southern Observatory (ESO)",
    "Helsinki University Observatory High Altitude Observatory, National Center for AtmosphericResearch, Foundation",
  ].join(" ");

  assert.deepEqual(
    validateTranslationCandidate({ id: 48, text: source }, target),
    { ok: true, reasons: [] },
  );
  assert.deepEqual(
    validateTranslationCandidate(
      { id: 48, text: source },
      target.replace("David R. Malin 촬영", "사진: David R. Malin"),
    ),
    { ok: true, reasons: [] },
  );

  for (const mutated of [
    target.replace("David R. Malin 촬영", "David R. Molin 촬영"),
    target.replace("David R. Malin 촬영 ", ""),
    target.replace(
      "David R. Malin 촬영",
      "David R. Malin 촬영; David R. Malin 촬영",
    ),
  ]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: 48, text: source },
        mutated,
      )).includes("preserved_bibliography_changed"),
      true,
      mutated,
    );
  }

  const ordinaryProse = validateTranslationCandidate(
    {
      id: "ordinary-photograph-prose",
      text: "The photograph by David R. Malin was displayed beside the telescope.",
    },
    "David R. Molin이 촬영한 사진은 망원경 옆에 전시되었다.",
  );
  assert.deepEqual(ordinaryProse, { ok: true, reasons: [] });
});

test("live astronomy credits time units and tagged formula atoms avoid retry loops", () => {
  const drawingSource =
    "(Drawing based on Greenberg, J.M. (1968): Interstellar Grains, p. 224). " +
    "(Hoyle, F. (1980): Astronomy, p. 156. Used by permission)";
  const drawingTarget =
    "(Greenberg, J.M. (1968): Interstellar Grains, p. 224를 바탕으로 한 그림). " +
    "(Hoyle, F. (1980): Astronomy, p. 156. 허가를 받아 사용함)";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "drawing-permission", text: drawingSource },
      drawingTarget,
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "drawing-credit-change", text: drawingSource },
      drawingTarget.replace("Greenberg", "Greemberg"),
    )).includes("preserved_bibliography_changed"),
    true,
  );

  assert.deepEqual(
    validateTranslationCandidate(
      {
        id: "photography-credit",
        text: "The source is shown. (Photography Lunar and Planetary Laboratory, Catalina Observatory)",
      },
      "출처를 보여 준다. (사진 Lunar and Planetary Laboratory, Catalina Observatory)",
    ),
    { ok: true, reasons: [] },
  );
  const pictureSource =
    "The bright lane is the Milky Way. (Picture David Seal, NASA/JPL/Caltech)";
  const pictureTarget =
    "밝은 띠는 은하수이다. (사진 David Seal, NASA/JPL/Caltech)";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "picture-credit", text: pictureSource },
      pictureTarget,
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "picture-credit-change", text: pictureSource },
      pictureTarget.replace("NASA/JPL/Caltech", "NASA/JPL/CaltechX"),
    )).includes("preserved_bibliography_changed"),
    true,
  );

  const millisecondSource =
    "Pictures were taken every millisecond; the period is about 33 milliseconds.";
  assert.deepEqual(
    validateTranslationMap(
      [{ id: "milliseconds", text: millisecondSource }],
      { milliseconds: "사진은 1 millisecond마다 촬영되었고 주기는 약 33 milliseconds이다." },
    ),
    {
      accepted: {
        milliseconds: "사진은 1 밀리초마다 촬영되었고 주기는 약 33 밀리초이다.",
      },
      rejected: {},
    },
  );
  assert.equal(
    reasonCodes(validateTranslationMap(
      [{ id: "milliseconds-wrong", text: millisecondSource }],
      { "milliseconds-wrong": "사진은 2 milliseconds마다 촬영되었고 주기는 약 33 milliseconds이다." },
    ).rejected["milliseconds-wrong"]).includes("preserved_numbers_changed"),
    true,
  );

  const limitSource =
    "A rotating hole has another limiting surface, an ellipsoidal static limit (Fig. 15.8).";
  const limitTarget =
    "회전하는 블랙홀에는 또 하나의 한계면, 타원체 모양의 정지 한계면(static limit)이 있다(그림 15.8).";
  assert.deepEqual(
    validateTranslationMap(
      [{ id: "static-limit", text: limitSource }],
      { "static-limit": limitTarget },
    ),
    { accepted: { "static-limit": limitTarget }, rejected: {} },
  );

  const taggedSource =
    "The brightness falls in a logI<sub>ν</sub> −logν diagram as frequency increases.";
  const taggedTarget =
    "밝기는 주파수가 증가할수록 logI<sub>ν</sub> −logν 도표에서 감소한다.";
  assert.deepEqual(
    validateTranslationMap(
      [{ id: "tagged-log", text: taggedSource }],
      { "tagged-log": taggedTarget },
    ),
    { accepted: { "tagged-log": taggedTarget }, rejected: {} },
  );
  assert.equal(
    reasonCodes(validateTranslationMap(
      [{ id: "tagged-log-wrong", text: taggedSource }],
      { "tagged-log-wrong": taggedTarget.replace("logI<sub>", "logJ<sub>") },
    ).rejected["tagged-log-wrong"]).includes("scientific_markup_changed"),
    true,
  );

  assert.deepEqual(
    validateTranslationMap(
      [{ id: "nd-stop", text: "The image was taken through a 24 stop ND-ﬁlter." }],
      { "nd-stop": "이 영상은 24 stop ND-ﬁlter를 통해 촬영했다." },
    ),
    {
      accepted: { "nd-stop": "이 영상은 24 스톱 ND-filter를 통해 촬영했다." },
      rejected: {},
    },
  );
  assert.equal(
    reasonCodes(validateTranslationMap(
      [{ id: "ordinary-stop", text: "The observers stop the exposure." }],
      { "ordinary-stop": "관측자들은 stop the exposure." },
    ).rejected["ordinary-stop"]).includes("untranslated_english_prose"),
    true,
  );

  const kilogramBlocks = [
    {
      id: 8,
      text: "Kilogram kgEqual to the mass of the international prototype of the kilogram.",
    },
    { id: "__pdf_table_cell__:p0001:t000:r002:c002", text: "Kilogram" },
    {
      id: "__pdf_table_cell__:p0001:t000:r002:c004",
      text: "Equal to the mass of the international prototype of the kilogram.",
    },
  ];
  assert.deepEqual(
    validateTranslationMap(kilogramBlocks, {
      8: "킬로그램 kg킬로그램의 국제 원기와 같은 질량이다.",
      "__pdf_table_cell__:p0001:t000:r002:c002": "킬로그램",
      "__pdf_table_cell__:p0001:t000:r002:c004":
        "킬로그램의 국제 원기와 같은 질량이다.",
    }).rejected,
    {},
  );

  const braceFunctionSource =
    "The distance is s = min{r,(H/2)secb} in the interstellar medium.";
  const braceFunctionTarget =
    "성간매질에서 거리는 s = min{r,(H/2)secb}이다.";
  assert.deepEqual(
    validateTranslationMap(
      [{ id: "brace-function", text: braceFunctionSource }],
      { "brace-function": braceFunctionTarget },
    ),
    {
      accepted: {
        "brace-function": "성간매질에서 거리는 s = min{r,(H/2)sec b}이다.",
      },
      rejected: {},
    },
  );
  assert.equal(
    reasonCodes(validateTranslationMap(
      [{ id: "brace-function-wrong", text: braceFunctionSource }],
      { "brace-function-wrong": braceFunctionTarget.replace("secb", "secc") },
    ).rejected["brace-function-wrong"]).includes("scientific_literals_changed"),
    true,
  );
});

test("source-bound glued math identifiers normalize deterministically and compare arguments", () => {
  const source =
    "We may write cosf and sinf as two components. The factor sina and term secb are retained.";
  const accepted = validateTranslationMap(
    [{ id: "glued", text: source }],
    { glued: "두 성분을 cosf와 sinf로 쓸 수 있다. 인자 sina와 항 secb가 유지된다." },
  );
  assert.deepEqual(accepted, {
    accepted: {
      glued: "두 성분을 cos f와 sin f로 쓸 수 있다. 인자 sin a와 항 sec b가 유지된다.",
    },
    rejected: {},
  });

  const changedArgument = validateTranslationCandidate(
    { id: "glued-changed", text: source },
    "두 성분을 cosg와 sin f로 쓸 수 있다. 인자 sin a와 항 sec b가 유지된다.",
  );
  assert.equal(reasonCodes(changedArgument).includes("scientific_literals_changed"), true);
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "glued-absent", text: "The two components are retained." },
      "두 성분 cosf가 유지된다.",
    )).includes("untranslated_english_prose"),
    true,
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "since-prose", text: "Since the components are known, we find the result." },
      "since 성분을 알므로 결과를 얻는다.",
    )).includes("untranslated_english_prose"),
    true,
  );

  assert.deepEqual(
    validateTranslationCandidate(
      { id: "source-ndl", text: "The formula contains ndl dA as one term." },
      "이 식은 ndl dA를 한 항으로 포함한다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "absent-ndl", text: "The formula contains one differential term." },
      "이 식은 ndl 항 하나를 포함한다.",
    )).includes("untranslated_english_prose"),
    true,
  );
});

test("implicit singular time quantities and gram units are normalized source-exactly", () => {
  for (const qualifier of ["next", "last", "about"]) {
    const source = `During the ${qualifier} billion years the orbit changes.`;
    assert.deepEqual(
      validateTranslationCandidate(
        { id: qualifier, text: source },
        "약 10억 년 동안 궤도가 변한다.",
      ),
      { ok: true, reasons: [] },
    );
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: `${qualifier}-wrong`, text: source },
        "약 9억 년 동안 궤도가 변한다.",
      )).includes("preserved_numbers_changed"),
      true,
    );
  }

  assert.deepEqual(
    validateTranslationCandidate(
      { id: "indefinite-time", text: "A year passes and an hour follows." },
      "1년이 지나고 1시간이 뒤따른다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "indefinite-time-wrong", text: "A year passes and an hour follows." },
      "2년이 지나고 1시간이 뒤따른다.",
    )).includes("preserved_numbers_changed"),
    true,
  );

  assert.deepEqual(
    validateTranslationMap(
      [{ id: "gram-units", text: "The sample contains 5 micrograms and 2 grams of dust." }],
      { "gram-units": "시료에는 먼지가 5 micrograms 및 2 grams 들어 있다." },
    ),
    {
      accepted: { "gram-units": "시료에는 먼지가 5 마이크로그램 및 2 그램 들어 있다." },
      rejected: {},
    },
  );

  for (const swapped of [
    "시료에는 먼지가 5 grams 및 2 micrograms 들어 있다.",
    "시료에는 먼지가 5그램 및 2마이크로그램 들어 있다.",
  ]) {
    const result = validateTranslationCandidate(
      { id: "gram-swap", text: "The sample contains 5 micrograms and 2 grams of dust." },
      swapped,
    );
    assert.equal(reasonCodes(result).includes("preserved_measurements_changed"), true);
  }

  const duplicatedMeasurement = validateTranslationCandidate(
    { id: "gram-duplicate", text: "The sample contains 5 micrograms of dust." },
    "시료에는 먼지가 5마이크로그램과 5마이크로그램 들어 있다.",
  );
  assert.equal(
    reasonCodes(duplicatedMeasurement).includes("preserved_measurements_changed"),
    true,
  );
});

test("measurement ledgers bind full local expressions in either unit order", () => {
  const commaClauseSource =
    "At 20 °C the sample contains 5 micrograms and at 30 °C it contains 2 grams.";
  const accepted = [
    [
      "The samples contain 5 × 10−6 micrograms and 2 × 10−3 grams.",
      "시료에는 2 × 10−3그램과 5 × 10−6마이크로그램이 들어 있다.",
    ],
    [
      "The samples contain 5 × 10<sup>−6</sup> micrograms and 2 × 10<sup>−3</sup> grams.",
      "시료에는 2 × 10<sup>−3</sup>그램과 5 × 10<sup>−6</sup>마이크로그램이 들어 있다.",
    ],
    [
      "The range is 5–10 micrograms and 2–4 grams.",
      "범위는 2–4그램 및 5–10마이크로그램이다.",
    ],
    [
      "The sample is 5 (micrograms) and 2 (grams).",
      "시료는 2(그램) 및 5(마이크로그램)이다.",
    ],
    [
      "The micrograms reading is 5 and the grams reading is 2.",
      "그램 측정값은 2이고 마이크로그램 측정값은 5이다.",
    ],
    [
      "The sample contains 5 micrograms and 2 grams.",
      "시료에는 2그램과 5마이크로그램이 들어 있다.",
    ],
    [
      "At 20 °C the micrograms reading is 5; at 30 °C the grams reading is 2.",
      "30 °C에서 그램 측정값은 2이다; 20 °C에서 마이크로그램 측정값은 5이다.",
    ],
    [
      "The micrograms at 20 °C measure 5 / the grams at 30 °C measure 2.",
      "그램은 2로 측정되며 온도는 30 °C이다 / 마이크로그램은 5로 측정되며 온도는 20 °C이다.",
    ],
    [commaClauseSource, "20 °C에서 5마이크로그램, 30 °C에서 2그램이다."],
    [commaClauseSource, "30 °C에서 2그램, 20 °C에서 5마이크로그램이다."],
  ];
  for (const [source, target] of accepted) {
    assert.deepEqual(
      validateTranslationCandidate({ id: "bound-measurement", text: source }, target),
      { ok: true, reasons: [] },
      `${source} -> ${target}`,
    );
  }

  const rejected = [
    [
      accepted[0][0],
      "시료에는 5 × 10−6그램과 2 × 10−3마이크로그램이 들어 있다.",
    ],
    [
      accepted[1][0],
      "시료에는 5 × 10<sup>−6</sup>그램과 2 × 10<sup>−3</sup>마이크로그램이 들어 있다.",
    ],
    [accepted[2][0], "범위는 5–10그램 및 2–4마이크로그램이다."],
    [accepted[3][0], "시료는 5(그램) 및 2(마이크로그램)이다."],
    [accepted[4][0], "그램 측정값은 5이고 마이크로그램 측정값은 2이다."],
    [
      accepted[6][0],
      "20 °C에서 마이크로그램 측정값은 2이다; 30 °C에서 그램 측정값은 5이다.",
    ],
    [
      accepted[7][0],
      "마이크로그램은 2로 측정되며 온도는 20 °C이다 / 그램은 5로 측정되며 온도는 30 °C이다.",
    ],
    [commaClauseSource, "20 °C에서 2마이크로그램, 30 °C에서 5그램이다."],
    [commaClauseSource, "30 °C에서 5마이크로그램, 20 °C에서 2그램이다."],
    [
      "The sample contains 5 micrograms.",
      "시료에는 5마이크로그램과 마이크로그램이 들어 있다.",
    ],
    ["The sample reading is 5.", "시료 측정값은 5그램이다."],
  ];
  for (const [source, target] of rejected) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "bound-measurement-mutation", text: source },
        target,
      )).includes("preserved_measurements_changed"),
      true,
      `${source} -> ${target}`,
    );
  }
});

test("target discretionary Latin line-wrap hyphens are joined before validation", () => {
  assert.deepEqual(
    validateTranslationMap(
      [{ id: "stationery", text: "Her Majesty’s Stationery Office published the table." }],
      { stationery: "Her Majesty’s Sta- tionery Office가 표를 출판했다." },
    ),
    {
      accepted: { stationery: "Her Majesty’s Stationery Office가 표를 출판했다." },
      rejected: {},
    },
  );
});

test("formula cues recover glued sini and number-word compounds grant only exact values", () => {
  const gluedSource = "The value is obtained apart from a fac- tor sini.";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "glued-sini", text: gluedSource },
      "이 값은 sin i라는 인자를 제외하고 얻어진다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "changed-glued-function", text: gluedSource },
      "이 값은 cos i라는 인자를 제외하고 얻어진다.",
    )).includes("scientific_literals_changed"),
    true,
  );
  for (const argument of ["j", "k", "I"]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "changed-glued-argument", text: gluedSource },
        `이 값은 sin ${argument}라는 인자를 제외하고 얻어진다.`,
      )).includes("scientific_literals_changed"),
      true,
      argument,
    );
  }

  const dimensionalSource = "Its three- dimensional shape can be determined.";
  assert.deepEqual(
    validateTranslationCandidate(
      { id: "three-dimensional", text: dimensionalSource },
      "그 3차원 형태를 결정할 수 있다.",
    ),
    { ok: true, reasons: [] },
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "wrong-dimensional", text: dimensionalSource },
      "그 4차원 형태를 결정할 수 있다.",
    )).includes("preserved_numbers_changed"),
    true,
  );
  assert.equal(
    reasonCodes(validateTranslationCandidate(
      { id: "source-absent-number", text: "Its dimensional shape can be determined." },
      "그 3차원 형태를 결정할 수 있다.",
    )).includes("preserved_numbers_changed"),
    true,
  );
});

test("rejects changed Greek symbols, operators, and math functions", () => {
  const source = "The coordinates are y = y cosχ + z sinχ and θ′ = −ψ.";
  const changed = validateTranslationCandidate(
    { id: "math-literals", text: source },
    "좌표는 y = y cosΛ + z cosΛ이고 θ′ = ψ이다.",
  );
  assert.equal(changed.ok, false);
  assert.equal(reasonCodes(changed).includes("scientific_literals_changed"), true);

  const exact = validateTranslationCandidate(
    { id: "math-literals", text: source },
    "좌표는 y = y cosχ + z sinχ이고 θ′ = −ψ이다.",
  );
  assert.deepEqual(exact, { ok: true, reasons: [] });
});

test("rejects changed sub/sup literals, tag order, numbers, and URLs", () => {
  const source =
    "H<sub>2</sub><sup>+</sup> has 1,234.50 states; see https://example.com/v2?q=7.";

  const changed = validateTranslationCandidate(
    { id: 7, text: source },
    "H<sup>+</sup><sub>3</sub>에는 1,234.5개 상태가 있습니다. https://example.com/v3?q=7을 참조하세요.",
  );
  assert.equal(changed.ok, false);
  assert.deepEqual(reasonCodes(changed), [
    "scientific_markup_changed",
    "preserved_numbers_changed",
    "preserved_urls_changed",
  ]);

  const exact = validateTranslationCandidate(
    { id: 7, text: source },
    "H<sub>2</sub><sup>+</sup>에는 1,234.50개 상태가 있습니다. https://example.com/v2?q=7을 참조하세요.",
  );
  assert.deepEqual(exact, { ok: true, reasons: [] });
});

test("allows supported Korean/Latin/Common text and source-retained BMP scripts", () => {
  const cases = [
    ["API 결과는 3개입니다.", "API 결과는 3개입니다."],
    [
      "The α<sub>1</sub> term equals 2πr.",
      "α<sub>1</sub> 항은 2πr과 같습니다.",
    ],
    [
      "Москва has 2 labs in 東京.",
      "Москва에는 東京에 2개의 실험실이 있습니다.",
    ],
    [
      "H<sub>2</sub><sup>+</sup> = 4.5 eV.",
      "H<sub>2</sub><sup>+</sup> = 4.5 eV입니다.",
    ],
  ];
  for (const [source, target] of cases) {
    assert.deepEqual(findUnsupportedTargetCodePoints(source, target), []);
    assert.deepEqual(validateTranslationCandidate({ id: "script-ok", text: source }, target), {
      ok: true,
      reasons: [],
    });
  }
});

test("rejects source-absent scripts and all non-BMP characters using code points only", () => {
  const source = "This page is visible.";
  const cases = [
    ["이 페이지에 टनो가 섞였습니다.", ["U+091F", "U+0928", "U+094B"]],
    ["이 페이지에 Б가 섞였습니다.", ["U+0411"]],
    ["이 페이지에 漢이 섞였습니다.", ["U+6F22"]],
    ["이 페이지에 😀가 섞였습니다.", ["U+1F600"]],
  ];

  for (const [target, expected] of cases) {
    const result = validateTranslationCandidate({ id: "script-bad", text: source }, target);
    assert.equal(result.ok, false);
    const reason = result.reasons.find((entry) => entry.code === "unsupported_target_characters");
    assert.deepEqual(reason.codePoints, expected);
    assert.equal(expected.every((code) => reason.message.includes(code)), true);
    for (const char of ["ट", "न", "ो", "Б", "漢", "😀"]) {
      assert.equal(JSON.stringify(reason).includes(char), false, "reason must not expose target text");
    }
  }

  // Even a source-retained emoji is rejected: current bundled-font rendering is BMP-only.
  assert.deepEqual(findUnsupportedTargetCodePoints("Status 😀", "상태 😀"), ["U+1F600"]);

  // Raw code-point comparison is intentional: canonical decomposition must not inherit the
  // source allow-list through normalization (Й U+0419 != И U+0418 + breve U+0306).
  assert.deepEqual(findUnsupportedTargetCodePoints("Name Й", "이름 И\u0306"), ["U+0418"]);
});

test("validateTranslationMap accepts only candidates that pass deterministic checks", () => {
  const result = validateTranslationMap(
    [
      { id: 1, text: "An ordinary paragraph." },
      { id: 2, text: "There are 42 samples." },
      { id: 3, text: "A missing answer." },
    ],
    {
      1: "ordinary paragraph입니다.",
      2: "샘플은 42개입니다.",
    },
  );

  assert.deepEqual(result.accepted, { 2: "샘플은 42개입니다." });
  assert.equal(result.rejected["1"].reasons[0].code, "untranslated_english_prose");
  assert.equal(result.rejected["3"].reasons[0].code, "missing_response");
});

test("model compatibility ligatures are expanded before validation and acceptance", () => {
  const source = "The compatibility forms are shown at 17 eV where sin x = 1.";
  const result = validateTranslationMap(
    [{ id: 1, text: source }],
    { 1: "호환 합자(ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ)는 17 eV에서 표시되며 sin x = 1이다." },
  );

  assert.equal(
    normalizeLatinCompatibilityLigatures("ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ"),
    "ff fi fl ffi ffl st st",
  );
  assert.deepEqual(result, {
    accepted: {
      1: "호환 합자(ff fi fl ffi ffl st st)는 17 eV에서 표시되며 sin x = 1이다.",
    },
    rejected: {},
  });

  const changed = validateTranslationMap(
    [{ id: 1, text: source }],
    { 1: "호환 합자(ﬂ)는 18 eV에서 표시되며 cos x = 1이다." },
  );
  assert.deepEqual(
    reasonCodes(changed.rejected["1"]),
    ["scientific_literals_changed", "preserved_numbers_changed"],
  );
});

test("source ligature prose is modeled while formula identity keeps exact source glyphs", () => {
  const plan = buildTranslationReusePlan([
    { id: 245, text: "ﬂattening" },
    {
      id: 99,
      text: "From the last equation (2.16), we ﬁnd the hour angle h of an object at the moment its altitude",
    },
    { id: "formula", text: "x = ﬂ" },
  ]);

  assert.deepEqual(plan.pending.map((block) => block.id), [245, 99]);
  assert.deepEqual(plan.direct, { formula: "x = ﬂ" });
});

test("code-only detection requires real language syntax instead of a leading prose keyword", () => {
  assert.equal(looksLikeCodeOnly("from pathlib import Path"), true);
  assert.equal(looksLikeCodeOnly("SELECT name FROM stars"), true);
  assert.equal(
    looksLikeCodeOnly("From the last equation (2.16), we find the hour angle."),
    false,
  );
  assert.equal(looksLikeCodeOnly("Class A stars are relatively hot."), false);
  assert.equal(looksLikeCodeOnly("Update the catalogue after every observation."), false);
});

test("nonformula translations longer than the deterministic semantic ceiling are rejected", () => {
  const source = "This source sentence contains enough semantic material for a complete translation.";
  const sourceLength = source.replace(/\s/g, "").length;
  const maximumTargetLength = Math.max(48, Math.ceil(sourceLength * 3));
  const atBoundary = validateTranslationCandidate(
    { id: "length-boundary", text: source },
    "가".repeat(maximumTargetLength),
  );
  assert.equal(reasonCodes(atBoundary).includes("translation_too_long"), false);

  const tooLong = validateTranslationCandidate(
    { id: "length-over", text: source },
    "가".repeat(maximumTargetLength + 1),
  );
  const reason = tooLong.reasons.find((entry) => entry.code === "translation_too_long");
  assert.deepEqual(reason, {
    code: "translation_too_long",
    message: "번역문이 원문에 없는 설명·반복을 덧붙인 것으로 보일 만큼 지나치게 김",
    sourceLength,
    targetLength: maximumTargetLength + 1,
    maximumTargetLength,
  });

  const shortProse = validateTranslationCandidate(
    { id: "short-length-over", text: "Go." },
    "가".repeat(500),
  );
  const shortReason = shortProse.reasons.find(
    (entry) => entry.code === "translation_too_long",
  );
  assert.equal(shortReason.maximumTargetLength, 48);
  assert.equal(shortReason.targetLength, 500);

  for (const source of ["x = y + 1", "const x = 1;"]) {
    assert.equal(
      reasonCodes(validateTranslationCandidate(
        { id: "literal-length-control", text: source },
        "가".repeat(500),
      )).includes("translation_too_long"),
      false,
      source,
    );
  }
});

test("targeted retry sends only rejected IDs with deterministic correction reasons", async () => {
  const calls = [];
  const caller = async ({ user }) => {
    calls.push(user);
    if (calls.length === 1) {
      return {
        text: JSON.stringify({
          t: {
            1: "이 born-digital 페이지는 일반 문단입니다.",
            2: "샘플은 42개입니다.",
          },
        }),
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    }
    return {
      text: JSON.stringify({ t: { 1: "이 디지털 원본 페이지는 일반 문단입니다." } }),
      usage: { input_tokens: 4, output_tokens: 3 },
    };
  };

  const result = await translateBlocksWithRetries({
    blocks: [
      { id: 1, text: "This born-digital page is an ordinary paragraph." },
      { id: 2, text: "There are 42 samples." },
    ],
    caller,
    retrySizes: [1],
    verbose: false,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1], /targeted correction retry/i);
  assert.match(calls[1], /nautical mile.*해리.*electron volts.*전자볼트/);
  assert.match(calls[1], /Chandra X-ray observatory.*천문대.*photograph by David R\. Malin.*촬영/);
  assert.match(calls[1], /numbers changed.*same occurrence count.*numbered proper name/);
  assert.match(calls[1], /credit or citation changed.*credit body exactly.*do not translate 'and' or 'for'/i);
  assert.match(calls[1], /keep terminology, domain meaning, and Korean ending style consistent/i);
  assert.match(calls[1], /ID 1: .*미번역 영어 prose/);
  assert.match(calls[1], /"id":1/);
  assert.doesNotMatch(calls[1], /"id":2/);
  assert.deepEqual(result.translations, {
    1: "이 디지털 원본 페이지는 일반 문단입니다.",
    2: "샘플은 42개입니다.",
  });
  assert.equal(result.usage.input_tokens, 14);
  assert.equal(result.usage.output_tokens, 8);
});

test("too-long retry reports the ceiling and requests a concise complete translation", async () => {
  const calls = [];
  const source = "This sentence should be translated once without duplicated explanatory commentary.";
  const maximumTargetLength = Math.max(48, Math.ceil(source.replace(/\s/g, "").length * 3));
  const caller = async ({ user }) => {
    calls.push(user);
    if (calls.length === 1) {
      return { text: JSON.stringify({ t: { 71: "가".repeat(maximumTargetLength + 20) } }), usage: {} };
    }
    return {
      text: JSON.stringify({ t: { 71: "이 문장은 중복된 해설 없이 원문의 뜻을 한 번만 간결하게 번역한다." } }),
      usage: {},
    };
  };

  const result = await translateBlocksWithRetries({
    blocks: [{ id: 71, text: source }],
    caller,
    retrySizes: [1],
    verbose: false,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1], /translation is too long.*complete source once and concisely/i);
  assert.match(calls[1], new RegExp(`maximum target length: ${maximumTargetLength}`));
  assert.equal(
    result.translations["71"],
    "이 문장은 중복된 해설 없이 원문의 뜻을 한 번만 간결하게 번역한다.",
  );
});

test("numeric retry exposes exact source and rejected counts without weakening validation", async () => {
  const calls = [];
  const source = "Adopted Geodetic Reference System 1980 (GRS-80).";
  const caller = async ({ user }) => {
    calls.push(user);
    if (calls.length === 1) {
      return {
        text: JSON.stringify({
          t: {
            7: "1980 측지 기준계(Geodetic Reference System 1980, GRS-80)를 채택했다.",
          },
        }),
        usage: {},
      };
    }
    return {
      text: JSON.stringify({
        t: { 7: "Geodetic Reference System 1980(GRS-80)을 채택했다." },
      }),
      usage: {},
    };
  };

  const result = await translateBlocksWithRetries({
    blocks: [{ id: 7, text: source }],
    caller,
    retrySizes: [1],
    verbose: false,
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1], /source numeric literals: \["1980","-80"\]/);
  assert.match(
    calls[1],
    /rejected target numeric literals: \["1980","1980","-80"\]/,
  );
  assert.equal(
    result.translations["7"],
    "Geodetic Reference System 1980(GRS-80)을 채택했다.",
  );
});

test("retry exhaustion remains fail-closed through assertCompleteTranslations", async () => {
  const calls = [];
  const caller = async ({ user }) => {
    calls.push(user);
    return {
      text: JSON.stringify({ t: { 9: "이 born-digital 페이지입니다." } }),
      usage: {},
    };
  };

  await assert.rejects(
    translateBlocksWithRetries({
      blocks: [{ id: 9, text: "This born-digital page is visible." }],
      caller,
      retrySizes: [1, 1],
      verbose: false,
    }),
    (error) => {
      assert.equal(error.code, "PDF_TRANSLATION_QUALITY_FAILURE");
      assert.equal(error.details.kind, "missing_translations");
      assert.deepEqual(error.details.missingIds, ["9"]);
      return true;
    },
  );

  assert.equal(calls.length, 3);
  assert.match(calls[2], /이전 품질 거부 응답을 그대로 반복함/);
});

test("unexpected-script rejection targets only that ID and accepts corrected Korean", async () => {
  const calls = [];
  const caller = async ({ user }) => {
    calls.push(user);
    if (calls.length === 1) {
      return {
        text: JSON.stringify({
          t: {
            1: "이 페이지에 टनो가 표시됩니다.",
            2: "샘플은 7개입니다.",
          },
        }),
        usage: {},
      };
    }
    return { text: JSON.stringify({ t: { 1: "이 페이지가 표시됩니다." } }), usage: {} };
  };

  const result = await translateBlocksWithRetries({
    blocks: [
      { id: 1, text: "This page is displayed." },
      { id: 2, text: "There are 7 samples." },
    ],
    caller,
    retrySizes: [1],
    verbose: false,
  });

  assert.deepEqual(result.translations, {
    1: "이 페이지가 표시됩니다.",
    2: "샘플은 7개입니다.",
  });
  assert.match(calls[1], /U\+091F/);
  assert.match(calls[1], /U\+0928/);
  assert.match(calls[1], /U\+094B/);
  assert.doesNotMatch(calls[1], /ट|न|ो/);
  assert.match(calls[1], /"id":1/);
  assert.doesNotMatch(calls[1], /"id":2/);
});

test("repeated unexpected-script output exhausts retries and fails closed", async () => {
  const calls = [];
  const caller = async ({ user }) => {
    calls.push(user);
    return {
      text: JSON.stringify({ t: { 4: "이 페이지에 Б가 섞였습니다." } }),
      usage: {},
    };
  };

  await assert.rejects(
    translateBlocksWithRetries({
      blocks: [{ id: 4, text: "This page is valid." }],
      caller,
      retrySizes: [1, 1],
      verbose: false,
    }),
    (error) => {
      assert.equal(error.code, "PDF_TRANSLATION_QUALITY_FAILURE");
      assert.equal(error.details.kind, "missing_translations");
      assert.deepEqual(error.details.missingIds, ["4"]);
      return true;
    },
  );
  assert.equal(calls.length, 3);
  assert.match(calls[1], /U\+0411/);
  assert.doesNotMatch(calls[1], /Б/);
  assert.match(calls[2], /이전 품질 거부 응답을 그대로 반복함/);
});
