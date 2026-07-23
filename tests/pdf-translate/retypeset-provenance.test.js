const test = require("node:test");
const assert = require("node:assert/strict");

const {
  InvariantValidationError,
  canonicalJson,
  maskInvariants,
  restoreInvariantLiterals,
  sha256Canonical,
  sha256Hex,
  validateInvariantPlaceholders,
} = require("../../lib/pipelines/pdf-translate/invariants");
const {
  ProvenanceValidationError,
  bindTargetSegment,
  createFigureOccurrence,
  createJudgeItem,
  digestJudgeInput,
  prepareSourceSegment,
  sealRetypesetEvidence,
  sourceSegmentDigest,
  stableSegmentId,
  validateRetypesetEvidence,
} = require("../../lib/pipelines/pdf-translate/provenance");

function expectInvariantCode(code) {
  return (error) => error instanceof InvariantValidationError && error.code === code;
}

function expectProvenanceCode(code) {
  return (error) => error instanceof ProvenanceValidationError && error.code === code;
}

function targetFromMask(prepared, prefix = "번역") {
  return `${prefix} ${prepared.mask.entries.map((entry) => entry.placeholder).join(" 그리고 ")}`;
}

function buildFixture({
  translationProvider = "openai",
  judgeProvider = "anthropic",
  judgeVerdicts = ["pass", "pass"],
  judgeItemsTransform = (items) => items,
  judgeInputTransform = (input) => input,
  judgeDigestTransform = (digest) => digest,
} = {}) {
  const sourcePdf = Buffer.from("%PDF-1.7\nsource-pdf-provenance-fixture", "utf8");
  const outputPdf = Buffer.from("%PDF-1.7\noutput-pdf-provenance-fixture", "utf8");
  const layoutTemplate = Buffer.from("\\documentclass{article}\n% stable layout template", "utf8");
  const documentSha256 = sha256Hex(sourcePdf);
  const prepared = [
    prepareSourceSegment({
      documentSha256,
      page: 1,
      order: 1,
      kind: "heading",
      sourceText: "Measurement 12.5 kg at https://example.test/a2.pdf",
    }),
    prepareSourceSegment({
      documentSha256,
      page: 1,
      order: 2,
      kind: "paragraph",
      sourceText: "For H2O use E=mc^2 and `solver.py`.",
    }),
  ];
  const bound = prepared.map((item, index) => bindTargetSegment(
    item,
    targetFromMask(item, index === 0 ? "측정값" : "공식을 보존한다"),
  ));
  const segments = bound.map((item) => item.segment);
  const figures = [
    createFigureOccurrence({
      documentSha256,
      page: 1,
      order: 1,
      sourceBytes: Buffer.from("same-source-figure"),
      outputBytes: Buffer.from("same-output-figure"),
    }),
    createFigureOccurrence({
      documentSha256,
      page: 2,
      order: 1,
      sourceBytes: Buffer.from("same-source-figure"),
      outputBytes: Buffer.from("same-output-figure"),
    }),
  ];
  const judgeInput = judgeInputTransform({
    task: "independent-semantic-correspondence",
    source_pdf_sha256: sha256Hex(sourcePdf),
    output_pdf_sha256: sha256Hex(outputPdf),
    items: prepared.map((item, index) => ({
      segment_id: item.source.segment_id,
      source: index === 0 ? "RAW SOURCE SECRET 12.5 kg" : "RAW SOURCE SECRET H2O",
      target: index === 0 ? "RAW TARGET SECRET 측정값" : "RAW TARGET SECRET 공식",
    })),
  });
  const inputDigest = judgeDigestTransform(digestJudgeInput(judgeInput));
  const translation = {
    provider: translationProvider,
    model: "translator-model",
    request_id: "translate-request-001",
  };
  const items = judgeItemsTransform(segments.map((segment, index) =>
    createJudgeItem(segment, judgeVerdicts[index] || "pass")));
  const judge = {
    provider: judgeProvider,
    model: "independent-judge-model",
    request_id: "judge-request-001",
    input_digest: inputDigest,
    items,
  };
  return {
    sourcePdf,
    outputPdf,
    layoutTemplate,
    documentSha256,
    prepared,
    bound,
    segments,
    figures,
    judgeInput,
    translation,
    judge,
  };
}

function sealFixture(fixture) {
  return sealRetypesetEvidence({
    sourcePdf: fixture.sourcePdf,
    outputPdf: fixture.outputPdf,
    layoutTemplate: fixture.layoutTemplate,
    segments: fixture.segments,
    figures: fixture.figures,
    translation: fixture.translation,
    judge: fixture.judge,
    judgeInput: fixture.judgeInput,
  });
}

function expectedContext(fixture, overrides = {}) {
  return {
    sourcePdf: fixture.sourcePdf,
    outputPdf: fixture.outputPdf,
    layoutTemplate: fixture.layoutTemplate,
    segments: fixture.segments,
    figures: fixture.figures,
    judgeInput: fixture.judgeInput,
    translationProvider: fixture.translation.provider,
    ...overrides,
  };
}

test("canonical JSON is key-order independent and rejects ambiguous values", () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: true, x: ["é", -0] } }),
    '{"a":{"x":["é",0],"y":true},"z":1}',
  );
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ bad: undefined }), /undefined/);
  assert.throws(() => canonicalJson(Buffer.from("not-json")), /plain objects/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), /cycles/);
});

test("stable segment IDs are document/page/order based and fixed width", () => {
  const digest = sha256Hex("document bytes");
  assert.equal(stableSegmentId(digest, 7, 42), `seg-${digest.slice(0, 12)}-p0007-o0042`);
  assert.equal(stableSegmentId(digest.toUpperCase(), 7, 42), `seg-${digest.slice(0, 12)}-p0007-o0042`);
  assert.throws(() => stableSegmentId(digest, 0, 1), /integer from 1/);
  assert.throws(() => stableSegmentId("abc", 1, 1), /SHA-256/);
  assert.throws(() => stableSegmentId(digest, 1, 10000), /integer from 1/);
});

test("masking is deterministic, NFC-normalized, and longest-first across overlaps", () => {
  const source = "Café mass 12.50 kg; URL https://host.test/a2/report.pdf?x=7; H2O; E=mc^2; `run(3)`; /tmp/a9.csv; 44.";
  const decomposed = source.replace("é", "e\u0301");
  const options = {
    documentSha256: sha256Hex("doc"),
    kind: "paragraph",
    page: 1,
    order: 1,
  };
  const first = maskInvariants(source, options);
  const second = maskInvariants(decomposed, options);
  assert.equal(first.maskedText, second.maskedText);
  assert.deepEqual(first.manifest, second.manifest);
  assert.match(first.maskedText, /^Café mass QINV_/);
  assert.deepEqual(
    first.entries.map((entry) => [entry.type, entry.literal]),
    [
      ["number_unit", "12.50 kg"],
      ["url", "https://host.test/a2/report.pdf?x=7"],
      ["chemical_formula", "H2O"],
      ["math_formula", "E=mc^2"],
      ["code_file", "`run(3)`"],
      ["code_file", "/tmp/a9.csv"],
      ["number", "44"],
    ],
  );
  assert.equal(first.entries.filter((entry) => entry.literal === "7").length, 0);
  assert.equal(first.entries.filter((entry) => entry.literal === "3").length, 0);
  for (const [index, entry] of first.entries.entries()) {
    assert.match(entry.placeholder, /^QINV_[a-f0-9]{12}_\d{4}_[a-f0-9]{12}$/);
    assert.equal(entry.sequence, index + 1);
  }
});

test("chemical reactions and parenthesized formulae are single longest invariants", () => {
  const masked = maskInvariants("Reaction 2H2 + O2 -> 2H2O, then Fe(OH)3.", { runId: "runfixed1" });
  assert.equal(masked.entries[0].type, "chemical_formula");
  assert.equal(masked.entries[0].literal, "2H2 + O2 -> 2H2O");
  assert.equal(masked.entries[1].literal, "Fe(OH)3");
  assert.equal(masked.entries.some((entry) => entry.type === "number"), false);
});

test("plain multi-term equations are masked whole while prose assignments are not", () => {
  const masked = maskInvariants("Keep x^2 + y^2 = z^2 and F=ma, but translate status = ready.", {
    runId: "equation1",
  });
  assert.deepEqual(
    masked.entries.map((entry) => [entry.type, entry.literal]),
    [
      ["math_formula", "x^2 + y^2 = z^2"],
      ["math_formula", "F=ma"],
    ],
  );
});

test("Unicode chemical subscripts and non-ASCII numbers cannot bypass masking", () => {
  const masked = maskInvariants("Water H₂O, formula E=mc², count １２ and value ٤.", {
    runId: "unicode01",
  });
  assert.deepEqual(
    masked.entries.map((entry) => [entry.type, entry.literal]),
    [
      ["chemical_formula", "H₂O"],
      ["math_formula", "E=mc²"],
      ["number", "１２"],
      ["number", "٤"],
    ],
  );
  const safeTarget = masked.entries.map((entry) => entry.placeholder).join(" ");
  assert.throws(
    () => validateInvariantPlaceholders(masked, `${safeTarget} ５`),
    expectInvariantCode("INVARIANT_ADDITION"),
  );
});

test("exact placeholder stream restores byte-equivalent source literals", () => {
  const masked = maskInvariants("Use 9.81 m/s2, H2O, and https://a.test/x.", { runId: "restore01" });
  const target = `사용 ${masked.entries.map((entry) => entry.placeholder).join(" 및 ")}.`;
  const check = validateInvariantPlaceholders(masked, target);
  assert.equal(check.expectedCount, 3);
  assert.equal(restoreInvariantLiterals(masked, target), "사용 9.81 m/s2 및 H2O 및 https://a.test/x.");
});

test("placeholder validation rejects missing, duplicate, reordered, unknown, and malformed tokens", () => {
  const masked = maskInvariants("Values 10 kg and 20 s.", { runId: "attack001" });
  const [first, second] = masked.entries.map((entry) => entry.placeholder);
  assert.throws(() => validateInvariantPlaceholders(masked, `값 ${first}`), expectInvariantCode("INVARIANT_PLACEHOLDER_MISMATCH"));
  assert.throws(() => validateInvariantPlaceholders(masked, `값 ${first} ${first} ${second}`), expectInvariantCode("INVARIANT_PLACEHOLDER_MISMATCH"));
  assert.throws(() => validateInvariantPlaceholders(masked, `값 ${second} ${first}`), expectInvariantCode("INVARIANT_PLACEHOLDER_MISMATCH"));
  assert.throws(() => validateInvariantPlaceholders(masked, `값 ${first} ${second} QINV_attacker_0001_deadbeef0000`), expectInvariantCode("INVARIANT_PLACEHOLDER_MISMATCH"));
  assert.throws(() => validateInvariantPlaceholders(masked, `값 X${first} ${second}`), expectInvariantCode("INVARIANT_PLACEHOLDER_MISMATCH"));
  assert.throws(() => validateInvariantPlaceholders(masked, `값 ${first} ${second.slice(0, -1)}X`), (error) =>
    error.code === "INVARIANT_PLACEHOLDER_MISMATCH" || error.code === "INVARIANT_PLACEHOLDER_MALFORMED");
});

test("source text cannot collide with the reserved placeholder namespace", () => {
  assert.throws(
    () => maskInvariants("literal QINV_existing_0001_deadbeef", { runId: "collision1" }),
    expectInvariantCode("INVARIANT_SOURCE_NAMESPACE_COLLISION"),
  );
});

test("placeholder validation rejects raw substitution and additional invariants", () => {
  const masked = maskInvariants("Mass 10 kg.", { runId: "attack002" });
  const placeholder = masked.entries[0].placeholder;
  for (const target of [
    "질량 10 kg.",
    `질량 ${placeholder} 및 99.`,
    `질량 ${placeholder} 및 https://evil.test/x`,
    `질량 ${placeholder} 및 E=mc^2`,
    `질량 ${placeholder} 및 H2O`,
    `질량 ${placeholder} 및 evil.py`,
  ]) {
    assert.throws(
      () => validateInvariantPlaceholders(masked, target),
      (error) => error.code === "INVARIANT_PLACEHOLDER_MISMATCH" || error.code === "INVARIANT_ADDITION",
    );
  }
});

test("source hash binds NFC text, kind, position, and sorted invariant manifest", () => {
  const documentSha256 = sha256Hex("source PDF");
  const base = prepareSourceSegment({
    documentSha256,
    page: 1,
    order: 1,
    kind: "paragraph",
    sourceText: "Café 10 kg",
  });
  const nfd = prepareSourceSegment({
    documentSha256,
    page: 1,
    order: 1,
    kind: "paragraph",
    sourceText: "Cafe\u0301 10 kg",
  });
  assert.equal(base.source.source_sha256, nfd.source.source_sha256);
  assert.equal(base.source.invariant_manifest_sha256, nfd.source.invariant_manifest_sha256);
  const changedLiteral = prepareSourceSegment({
    documentSha256,
    page: 1,
    order: 1,
    kind: "paragraph",
    sourceText: "Café 11 kg",
  });
  const changedKind = prepareSourceSegment({
    documentSha256,
    page: 1,
    order: 1,
    kind: "heading",
    sourceText: "Café 10 kg",
  });
  assert.notEqual(base.source.source_sha256, changedLiteral.source.source_sha256);
  assert.notEqual(base.source.source_sha256, changedKind.source.source_sha256);
  assert.equal(
    sourceSegmentDigest({
      sourceText: "Café 10 kg",
      kind: "paragraph",
      page: 1,
      order: 1,
      invariantManifest: [...base.mask.manifest].reverse(),
    }),
    base.source.source_sha256,
  );
});

test("target hash and binding change for target prose while invariants restore exactly", () => {
  const sourcePdfSha256 = sha256Hex("source PDF");
  const prepared = prepareSourceSegment({
    documentSha256: sourcePdfSha256,
    page: 1,
    order: 1,
    sourceText: "Mass 10 kg",
  });
  const placeholder = prepared.mask.entries[0].placeholder;
  const first = bindTargetSegment(prepared, `질량 ${placeholder}`);
  const second = bindTargetSegment(prepared, `측정 질량 ${placeholder}`);
  assert.equal(first.restored_text, "질량 10 kg");
  assert.notEqual(first.segment.target_sha256, second.segment.target_sha256);
  assert.notEqual(first.segment.binding_sha256, second.segment.binding_sha256);
});

test("sealed evidence validates exact artifacts, segments, figures, and judge request", () => {
  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  assert.equal(validateRetypesetEvidence(evidence, expectedContext(fixture)), evidence);
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.segments.length, 2);
  assert.equal(evidence.figures.length, 2);
  assert.notEqual(evidence.figures[0].occurrence_id, evidence.figures[1].occurrence_id);
  assert.equal(evidence.figures[0].source_sha256, evidence.figures[1].source_sha256);
  assert.equal(evidence.figures[0].output_sha256, evidence.figures[1].output_sha256);
});

test("sealed evidence is deterministic and never persists raw source/target text", () => {
  const fixture = buildFixture();
  const first = sealFixture(fixture);
  const second = sealFixture(fixture);
  assert.deepEqual(first, second);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /RAW SOURCE SECRET/);
  assert.doesNotMatch(serialized, /RAW TARGET SECRET/);
  assert.doesNotMatch(serialized, /Measurement 12\.5 kg/);
  assert.doesNotMatch(serialized, /측정값/);
  assert.doesNotMatch(serialized, /source_text|target_text|masked_text/);
});

test("self-judging is rejected, including provider aliases", () => {
  assert.throws(() => sealFixture(buildFixture({
    translationProvider: "anthropic",
    judgeProvider: "claude",
  })), expectProvenanceCode("SELF_JUDGE_FORBIDDEN"));
  assert.throws(() => sealFixture(buildFixture({
    translationProvider: "ChatGPT",
    judgeProvider: "openai",
  })), expectProvenanceCode("SELF_JUDGE_FORBIDDEN"));
});

test("fail and uncertain judge verdicts are rejected", () => {
  assert.throws(() => sealFixture(buildFixture({ judgeVerdicts: ["pass", "fail"] })), expectProvenanceCode("JUDGE_VERDICT_REJECTED"));
  assert.throws(() => sealFixture(buildFixture({ judgeVerdicts: ["uncertain", "pass"] })), expectProvenanceCode("JUDGE_VERDICT_REJECTED"));
});

test("missing, duplicate, extra, and hash-mismatched judge items are rejected", () => {
  assert.throws(() => sealFixture(buildFixture({
    judgeItemsTransform: (items) => items.slice(0, 1),
  })), expectProvenanceCode("JUDGE_ITEMS_MISMATCH"));
  assert.throws(() => sealFixture(buildFixture({
    judgeItemsTransform: (items) => [items[0], items[0]],
  })), expectProvenanceCode("JUDGE_ITEMS_MISMATCH"));
  assert.throws(() => sealFixture(buildFixture({
    judgeItemsTransform: (items) => [...items, {
      ...items[0],
      segment_id: "seg-ffffffffffff-p0001-o9999",
    }],
  })), expectProvenanceCode("JUDGE_ITEMS_MISMATCH"));
  assert.throws(() => sealFixture(buildFixture({
    judgeItemsTransform: (items) => [{ ...items[0], target_sha256: "0".repeat(64) }, items[1]],
  })), expectProvenanceCode("JUDGE_ITEMS_MISMATCH"));
});

test("judge input digest must bind the exact request payload", () => {
  assert.throws(() => sealFixture(buildFixture({
    judgeDigestTransform: () => "0".repeat(64),
  })), expectProvenanceCode("JUDGE_INPUT_HASH_MISMATCH"));

  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    judgeInput: { ...fixture.judgeInput, task: "tampered-task" },
  })), expectProvenanceCode("JUDGE_INPUT_HASH_MISMATCH"));
});

test("validator rejects source, output, layout, segment, and figure mismatches", () => {
  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    sourcePdf: Buffer.from("different source"),
  })), expectProvenanceCode("SOURCE_PDF_HASH_MISMATCH"));
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    outputPdf: Buffer.from("different output"),
  })), expectProvenanceCode("OUTPUT_PDF_HASH_MISMATCH"));
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    layoutTemplate: Buffer.from("different layout"),
  })), expectProvenanceCode("LAYOUT_TEMPLATE_HASH_MISMATCH"));
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    segments: fixture.segments.slice(0, 1),
  })), expectProvenanceCode("SEGMENT_SET_MISMATCH"));
  assert.throws(() => validateRetypesetEvidence(evidence, expectedContext(fixture, {
    figures: fixture.figures.slice(0, 1),
  })), expectProvenanceCode("FIGURE_SET_MISMATCH"));
});

test("validator rejects tampering even when a top-level evidence seal is recomputed", () => {
  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  const tampered = JSON.parse(JSON.stringify(evidence));
  tampered.segments[0].target_sha256 = "0".repeat(64);
  const unsigned = { ...tampered };
  delete unsigned.evidence_sha256;
  tampered.evidence_sha256 = sha256Canonical(unsigned);
  assert.throws(
    () => validateRetypesetEvidence(tampered, expectedContext(fixture)),
    expectProvenanceCode("SEGMENT_HASH_MISMATCH"),
  );

  const resealedOnly = JSON.parse(JSON.stringify(evidence));
  resealedOnly.evidence_sha256 = "f".repeat(64);
  assert.throws(
    () => validateRetypesetEvidence(resealedOnly, expectedContext(fixture)),
    expectProvenanceCode("EVIDENCE_SEAL_MISMATCH"),
  );
});

test("evidence schema rejects raw text fields, missing fields, and unexpected fields", () => {
  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  for (const mutate of [
    (copy) => { copy.source_text = "must never be stored"; },
    (copy) => { copy.segments[0].target_text = "must never be stored"; },
    (copy) => { delete copy.judge.request_id; },
    (copy) => { copy.judge.items[0].reason = "could leak text"; },
  ]) {
    const copy = JSON.parse(JSON.stringify(evidence));
    mutate(copy);
    assert.throws(
      () => validateRetypesetEvidence(copy, expectedContext(fixture)),
      expectProvenanceCode("PROVENANCE_SCHEMA_INVALID"),
    );
  }
  const proseActor = buildFixture();
  proseActor.translation.model = "raw source text must not live here";
  assert.throws(() => sealFixture(proseActor), expectProvenanceCode("PROVENANCE_SCHEMA_INVALID"));
});

test("figure and segment occurrence sets reject duplicate positions", () => {
  const fixture = buildFixture();
  const duplicateSegments = [fixture.segments[0], fixture.segments[0]];
  assert.throws(() => sealRetypesetEvidence({
    sourcePdf: fixture.sourcePdf,
    outputPdf: fixture.outputPdf,
    layoutTemplate: fixture.layoutTemplate,
    segments: duplicateSegments,
    figures: fixture.figures,
    translation: fixture.translation,
    judge: fixture.judge,
    judgeInput: fixture.judgeInput,
  }), expectProvenanceCode("SEGMENT_SET_INVALID"));

  const duplicateFigures = [fixture.figures[0], fixture.figures[0]];
  assert.throws(() => sealRetypesetEvidence({
    sourcePdf: fixture.sourcePdf,
    outputPdf: fixture.outputPdf,
    layoutTemplate: fixture.layoutTemplate,
    segments: fixture.segments,
    figures: duplicateFigures,
    translation: fixture.translation,
    judge: fixture.judge,
    judgeInput: fixture.judgeInput,
  }), expectProvenanceCode("FIGURE_SET_INVALID"));
});

test("no network or model client is needed for provenance construction", () => {
  const fixture = buildFixture();
  const evidence = sealFixture(fixture);
  assert.match(evidence.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(digestJudgeInput(fixture.judgeInput), fixture.judge.input_digest);
});
