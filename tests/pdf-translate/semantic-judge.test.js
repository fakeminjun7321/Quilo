"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bindTargetSegment,
  digestJudgeInput,
  prepareSourceSegment,
} = require("../../lib/pipelines/pdf-translate/provenance");
const { sha256Hex } = require("../../lib/pipelines/pdf-translate/invariants");
const { createFifoSemaphore } = require("../../lib/pipelines/pdf-translate/resource-gate");
const {
  MAX_REASON_CODES,
  MAX_SEMANTIC_RETRANSLATIONS,
  REASON_CODES,
  SEMANTIC_JUDGE_SCHEMA_VERSION,
  SEMANTIC_JUDGE_TASK,
  SemanticJudgeError,
  buildSemanticJudgeRequest,
  judgeSemanticSegments,
  runSemanticJudgePolicy,
} = require("../../lib/pipelines/pdf-translate/semantic-judge");

const RAW_SOURCE_SECRET = "RAW SOURCE SECRET";
const RAW_TARGET_SECRET = "RAW TARGET SECRET";

function expectCode(code) {
  return (error) => error instanceof SemanticJudgeError && error.code === code;
}

function targetWithPlaceholders(prepared, prefix) {
  const placeholders = prepared.mask.entries.map((entry) => entry.placeholder);
  return `${prefix}${placeholders.length ? ` ${placeholders.join(" 및 ")}` : ""}`;
}

function descriptor(prepared, sourceText, prefix) {
  return {
    prepared,
    bound: bindTargetSegment(prepared, targetWithPlaceholders(prepared, prefix)),
    source_text: sourceText,
  };
}

function buildFixture() {
  const documentSha256 = sha256Hex("semantic-judge-fixture-pdf");
  const sourceTexts = [
    `${RAW_SOURCE_SECRET} Measure 12.5 kg at https://example.test/report.pdf.`,
    `${RAW_SOURCE_SECRET} Use H2O in the reference vessel.`,
    `${RAW_SOURCE_SECRET} Reflow the final paragraph without omissions.`,
  ];
  const prepared = sourceTexts.map((sourceText, index) => prepareSourceSegment({
    documentSha256,
    page: 1,
    order: index + 1,
    kind: index === 0 ? "heading" : "paragraph",
    sourceText,
  }));
  const segments = prepared.map((item, index) => descriptor(
    item,
    sourceTexts[index],
    `${RAW_TARGET_SECRET} 번역문 ${["가", "나", "다"][index]}`,
  ));
  return { documentSha256, sourceTexts, prepared, segments };
}

function passingItem(requestItem) {
  return {
    segment_id: requestItem.segment_id,
    source_sha256: requestItem.source_sha256,
    target_sha256: requestItem.target_sha256,
    verdict: "pass",
    meaning_equivalent: true,
    complete: true,
    no_additions: true,
    invariant_associations_correct: true,
    reason_codes: [],
  };
}

function responseFor(request, transform = (items) => items) {
  return {
    schema_version: SEMANTIC_JUDGE_SCHEMA_VERSION,
    task: SEMANTIC_JUDGE_TASK,
    items: transform(request.items.map(passingItem)),
  };
}

function injectedCaller(handler, usage = {}) {
  let callCount = 0;
  const calls = [];
  const caller = async (args) => {
    callCount += 1;
    const request = JSON.parse(args.user);
    assert.deepEqual(request, args.request);
    calls.push({
      request,
      provider: args.provider,
      model: args.model,
      hasSignal: Object.prototype.hasOwnProperty.call(args, "signal"),
    });
    const response = await handler(request, callCount, args);
    return {
      text: typeof response === "string" ? response : JSON.stringify(response),
      request_id: `judge-request-${callCount}`,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 0,
        ...usage,
      },
    };
  };
  caller.calls = calls;
  caller.count = () => callCount;
  return caller;
}

function judgeOptions(fixture, caller, overrides = {}) {
  return {
    segments: fixture.segments,
    generationProvider: "openai",
    judgeProvider: "anthropic",
    judgeModel: "independent-judge-v1",
    caller,
    ...overrides,
  };
}

test("request binds the exact canonical segment ID/hash/text set and evidence exposes only hashes", async () => {
  const fixture = buildFixture();
  const built = buildSemanticJudgeRequest({ segments: fixture.segments.slice().reverse() });
  assert.equal(built.request.schema_version, 1);
  assert.equal(built.request.task, SEMANTIC_JUDGE_TASK);
  assert.deepEqual(
    built.request.items.map((item) => item.segment_id),
    [...built.request.items.map((item) => item.segment_id)].sort(),
  );
  assert.equal(built.input_digest, digestJudgeInput(built.request));
  for (const [index, item] of built.request.items.entries()) {
    assert.equal(item.source, fixture.sourceTexts[index]);
    assert.equal(item.source_sha256, fixture.segments[index].bound.segment.source_sha256);
    assert.equal(item.target_sha256, fixture.segments[index].bound.segment.target_sha256);
  }

  const caller = injectedCaller((request) => responseFor(request));
  const result = await judgeSemanticSegments(judgeOptions(fixture, caller));
  assert.equal(result.retranslation_targets.length, 0);
  assert.equal(result.judge.input_digest, digestJudgeInput(caller.calls[0].request));
  assert.deepEqual(
    Object.keys(result.judge).sort(),
    ["provider", "model", "request_id", "input_digest", "items"].sort(),
  );
  assert.deepEqual(
    Object.keys(result.judge.items[0]).sort(),
    ["segment_id", "source_sha256", "target_sha256", "verdict"].sort(),
  );
  const persisted = JSON.stringify({
    judge: result.judge,
    evaluations: result.evaluations,
    targets: result.retranslation_targets,
  });
  assert.equal(persisted.includes(RAW_SOURCE_SECRET), false);
  assert.equal(persisted.includes(RAW_TARGET_SECRET), false);
  assert.deepEqual(result.usage, {
    input_tokens: 10,
    output_tokens: 2,
    cache_read_input_tokens: 1,
    cache_creation_input_tokens: 0,
  });
});

test("generation and judge providers must differ after Anthropic/OpenAI alias normalization", async (t) => {
  const fixture = buildFixture();
  for (const [generationProvider, judgeProvider] of [
    ["claude", "anthropic"],
    ["Anthropic", "CLAUDE"],
    ["openai", "chatgpt"],
    ["ChatGPT", "OPENAI"],
  ]) {
    await t.test(`${generationProvider}/${judgeProvider}`, async () => {
      let calls = 0;
      await assert.rejects(
        judgeSemanticSegments(judgeOptions(fixture, async () => {
          calls += 1;
        }, { generationProvider, judgeProvider })),
        expectCode("SELF_JUDGE_FORBIDDEN"),
      );
      assert.equal(calls, 0);
    });
  }
});

test("invalid JSON and provider failures are rejected without leaking response or error prose", async () => {
  const fixture = buildFixture();
  const invalid = injectedCaller(() => `not-json ${RAW_SOURCE_SECRET} ${RAW_TARGET_SECRET}`);
  await assert.rejects(
    judgeSemanticSegments(judgeOptions(fixture, invalid)),
    (error) => {
      assert.equal(error.code, "JUDGE_RESPONSE_INVALID_JSON");
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(serialized.includes(RAW_SOURCE_SECRET), false);
      assert.equal(serialized.includes(RAW_TARGET_SECRET), false);
      return true;
    },
  );

  await assert.rejects(
    judgeSemanticSegments(judgeOptions(fixture, async () => {
      throw new Error(`upstream quoted ${RAW_SOURCE_SECRET} and ${RAW_TARGET_SECRET}`);
    })),
    (error) => {
      assert.equal(error.code, "JUDGE_CALL_FAILED");
      assert.equal(error.message.includes("quoted"), false);
      assert.equal(JSON.stringify(error.details).includes(RAW_SOURCE_SECRET), false);
      return true;
    },
  );
});

test("missing, duplicate, extra, and hash-swapped response items fail closed", async (t) => {
  const fixture = buildFixture();
  const cases = [
    ["missing", "JUDGE_ITEM_MISSING", (request) => responseFor(request, (items) => items.slice(1))],
    ["duplicate", "JUDGE_ITEM_DUPLICATE", (request) => responseFor(request, (items) => [...items, items[0]])],
    ["extra", "JUDGE_ITEM_EXTRA", (request) => responseFor(request, (items) => [...items, {
      ...items[0],
      segment_id: "seg-ffffffffffff-p9999-o9999",
    }])],
    ["swapped hashes", "JUDGE_ITEM_HASH_MISMATCH", (request) => responseFor(request, (items) => {
      const copy = items.map((item) => ({ ...item }));
      [copy[0].source_sha256, copy[1].source_sha256] = [copy[1].source_sha256, copy[0].source_sha256];
      return copy;
    })],
  ];
  for (const [name, code, makeResponse] of cases) {
    await t.test(name, async () => {
      const caller = injectedCaller(makeResponse);
      await assert.rejects(judgeSemanticSegments(judgeOptions(fixture, caller)), expectCode(code));
    });
  }
});

test("unknown fields and a model's all_pass self-claim cannot bypass per-item schema", async (t) => {
  const fixture = buildFixture();
  const cases = [
    ["top-level all_pass", (request) => ({ ...responseFor(request), all_pass: true })],
    ["item explanation", (request) => responseFor(request, (items) => items.map((item, index) =>
      index === 0 ? { ...item, explanation: "trust me" } : item))],
    ["all_pass without items", () => ({
      schema_version: SEMANTIC_JUDGE_SCHEMA_VERSION,
      task: SEMANTIC_JUDGE_TASK,
      all_pass: true,
    })],
  ];
  for (const [name, makeResponse] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        judgeSemanticSegments(judgeOptions(fixture, injectedCaller(makeResponse))),
        expectCode("JUDGE_RESPONSE_SCHEMA_INVALID"),
      );
    });
  }
});

test("fail, uncertain, and any false criterion become sanitized retranslation targets", async () => {
  const fixture = buildFixture();
  const caller = injectedCaller((request) => responseFor(request, (items) => items.map((item, index) => {
    if (index === 0) {
      return {
        ...item,
        verdict: "pass",
        complete: false,
        reason_codes: ["OMISSION"],
      };
    }
    if (index === 1) {
      return {
        ...item,
        verdict: "uncertain",
        reason_codes: ["AMBIGUOUS_SOURCE"],
      };
    }
    return {
      ...item,
      verdict: "fail",
      meaning_equivalent: false,
      reason_codes: ["MEANING_MISMATCH"],
    };
  })));
  const result = await judgeSemanticSegments(judgeOptions(fixture, caller));
  assert.deepEqual(result.retranslation_targets.map((item) => item.verdict), ["fail", "uncertain", "fail"]);
  assert.deepEqual(result.judge.items.map((item) => item.verdict), ["fail", "uncertain", "fail"]);
  assert.deepEqual(
    result.retranslation_targets.map((item) => item.reason_codes),
    [["OMISSION"], ["AMBIGUOUS_SOURCE"], ["MEANING_MISMATCH"]],
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(RAW_SOURCE_SECRET), false);
  assert.equal(serialized.includes(RAW_TARGET_SECRET), false);
});

test("reason codes are closed, bounded, and cannot carry prose into errors or evidence", async (t) => {
  const fixture = buildFixture();
  assert.equal(MAX_REASON_CODES, 4);
  assert.equal(REASON_CODES.includes("OMISSION"), true);
  const secretReason = `The source says ${RAW_SOURCE_SECRET} while target says ${RAW_TARGET_SECRET}`;
  const cases = [
    (request) => responseFor(request, (items) => items.map((item, index) => index === 0 ? {
      ...item,
      verdict: "fail",
      meaning_equivalent: false,
      reason_codes: [secretReason],
    } : item)),
    (request) => responseFor(request, (items) => items.map((item, index) => index === 0 ? {
      ...item,
      verdict: "fail",
      meaning_equivalent: false,
      reason_codes: ["MEANING_MISMATCH", "OMISSION", "ADDITION", "TERMINOLOGY_ERROR", "REFERENCE_MISMATCH"],
    } : item)),
    (request) => responseFor(request, (items) => items.map((item, index) => index === 0 ? {
      ...item,
      reason: secretReason,
    } : item)),
  ];
  for (const [index, makeResponse] of cases.entries()) {
    await t.test(`prose/bounds case ${index + 1}`, async () => {
      await assert.rejects(
        judgeSemanticSegments(judgeOptions(fixture, injectedCaller(makeResponse))),
        (error) => {
          assert.equal(
            ["JUDGE_REASON_CODE_INVALID", "JUDGE_RESPONSE_SCHEMA_INVALID"].includes(error.code),
            true,
          );
          const serialized = JSON.stringify({ message: error.message, details: error.details });
          assert.equal(serialized.includes(RAW_SOURCE_SECRET), false);
          assert.equal(serialized.includes(RAW_TARGET_SECRET), false);
          assert.equal(serialized.includes(secretReason), false);
          return true;
        },
      );
    });
  }
});

test("the injectable global API semaphore removes an aborted queued judge without calling it", async () => {
  const fixture = buildFixture();
  const semaphore = createFifoSemaphore(1);
  let release;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const held = semaphore.run(() => new Promise((resolve) => {
    release = resolve;
    markStarted();
  }));
  await started;
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 1, queued: 0 });

  let calls = 0;
  const controller = new AbortController();
  const pending = judgeSemanticSegments(judgeOptions(fixture, async () => {
    calls += 1;
    throw new Error("must not run");
  }, {
    apiSemaphore: semaphore,
    signal: controller.signal,
  }));
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 1, queued: 1 });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError" && error.code === "ABORT_ERR");
  assert.equal(calls, 0);
  assert.deepEqual(semaphore.stats(), { capacity: 1, active: 1, queued: 0 });
  release();
  await held;
});

test("retry policy retranslates only rejected IDs and aggregates judge/retranslation usage", async () => {
  const fixture = buildFixture();
  const originalHashes = fixture.segments.map((entry) => entry.bound.segment.target_sha256);
  const rejectedId = fixture.segments[1].bound.segment.segment_id;
  const caller = injectedCaller((request, callCount) => responseFor(request, (items) => items.map((item) => {
    if (callCount === 1 && item.segment_id === rejectedId) {
      return {
        ...item,
        verdict: "pass",
        complete: false,
        reason_codes: ["OMISSION"],
      };
    }
    return item;
  })));
  const retryCalls = [];
  const result = await runSemanticJudgePolicy({
    ...judgeOptions(fixture, caller),
    retranslate: async ({ segments, targets, attempt }) => {
      retryCalls.push({
        ids: segments.map((entry) => entry.bound.segment.segment_id),
        targetIds: targets.map((item) => item.segment_id),
        attempt,
      });
      const current = segments[0];
      return {
        segments: [descriptor(
          current.prepared,
          current.source_text,
          `${RAW_TARGET_SECRET} 누락을 보완한 번역`,
        )],
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 2,
        },
      };
    },
  });

  assert.equal(caller.count(), 2);
  assert.deepEqual(retryCalls, [{ ids: [rejectedId], targetIds: [rejectedId], attempt: 1 }]);
  assert.deepEqual(caller.calls.map((call) => call.request.items.length), [3, 3]);
  assert.deepEqual(
    caller.calls[0].request.items.map((item) => item.segment_id),
    caller.calls[1].request.items.map((item) => item.segment_id),
  );
  assert.equal(caller.calls[1].request.items[0].target_sha256, originalHashes[0]);
  assert.notEqual(caller.calls[1].request.items[1].target_sha256, originalHashes[1]);
  assert.equal(caller.calls[1].request.items[2].target_sha256, originalHashes[2]);
  assert.equal(result.retranslation_attempts, 1);
  assert.equal(result.rounds.length, 2);
  assert.equal(result.judge.input_digest, digestJudgeInput(caller.calls[1].request));
  assert.deepEqual(result.judge_usage, {
    input_tokens: 20,
    output_tokens: 4,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 0,
  });
  assert.deepEqual(result.retranslation_usage, {
    input_tokens: 5,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 2,
  });
  assert.deepEqual(result.usage, {
    input_tokens: 25,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 2,
  });
  const persistable = JSON.stringify({
    judge: result.judge,
    evaluations: result.evaluations,
    rounds: result.rounds,
    usage: result.usage,
  });
  assert.equal(persistable.includes(RAW_SOURCE_SECRET), false);
  assert.equal(persistable.includes(RAW_TARGET_SECRET), false);
});

test("two exhausted targeted retranslations reject the entire document fail-closed", async () => {
  const fixture = buildFixture();
  assert.equal(MAX_SEMANTIC_RETRANSLATIONS, 2);
  const rejectedId = fixture.segments[2].bound.segment.segment_id;
  const caller = injectedCaller((request) => responseFor(request, (items) => items.map((item) =>
    item.segment_id === rejectedId
      ? {
          ...item,
          verdict: "uncertain",
          meaning_equivalent: false,
          reason_codes: ["OTHER_SEMANTIC_RISK"],
        }
      : item)));
  let retryCount = 0;
  await assert.rejects(
    runSemanticJudgePolicy({
      ...judgeOptions(fixture, caller),
      retranslate: async ({ segments, attempt }) => {
        retryCount += 1;
        assert.deepEqual(segments.map((entry) => entry.bound.segment.segment_id), [rejectedId]);
        const current = segments[0];
        return {
          segments: [descriptor(
            current.prepared,
            current.source_text,
            `${RAW_TARGET_SECRET} ${attempt === 1 ? "첫째" : "둘째"} 수정본`,
          )],
          usage: {
            input_tokens: 3,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    }),
    (error) => {
      assert.equal(error.code, "SEMANTIC_RETRY_EXHAUSTED");
      assert.deepEqual(error.details.rejected_segment_ids, [rejectedId]);
      assert.equal(error.details.retranslation_attempts, 2);
      assert.deepEqual(error.details.judge_usage, {
        input_tokens: 30,
        output_tokens: 6,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 0,
      });
      assert.deepEqual(error.details.retranslation_usage, {
        input_tokens: 6,
        output_tokens: 2,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      });
      const serialized = JSON.stringify({ message: error.message, details: error.details });
      assert.equal(serialized.includes(RAW_SOURCE_SECRET), false);
      assert.equal(serialized.includes(RAW_TARGET_SECRET), false);
      return true;
    },
  );
  assert.equal(caller.count(), 3);
  assert.equal(retryCount, 2);
});

test("retry policy rejects over-budget settings and non-targeted replacement sets before another judge", async () => {
  const fixture = buildFixture();
  const passCaller = injectedCaller((request) => responseFor(request));
  await assert.rejects(
    runSemanticJudgePolicy({
      ...judgeOptions(fixture, passCaller),
      retranslate: async () => [],
      maxRetranslations: 3,
    }),
    expectCode("SEMANTIC_RETRY_POLICY_INVALID"),
  );
  assert.equal(passCaller.count(), 0);

  const rejectedId = fixture.segments[0].bound.segment.segment_id;
  const failCaller = injectedCaller((request) => responseFor(request, (items) => items.map((item) =>
    item.segment_id === rejectedId
      ? { ...item, verdict: "fail", meaning_equivalent: false, reason_codes: ["MEANING_MISMATCH"] }
      : item)));
  await assert.rejects(
    runSemanticJudgePolicy({
      ...judgeOptions(fixture, failCaller),
      retranslate: async () => fixture.segments.slice(0, 2),
    }),
    expectCode("RETRANSLATION_SET_MISMATCH"),
  );
  assert.equal(failCaller.count(), 1);
});
