// 보고서 파이프라인 회귀: hwpx 렌더 결정 경로.
//
// hwpx 는 Node 가 Python(generator)을 spawn 하는 경로라 느리지만, 출시 핵심
// 보고서 3종(chem-pre/chem-result/phys-result)은 모두 검사한다. 검사 항목:
//   (a) PK 매직의 Buffer 반환 + Contents/section0.xml 존재
//   (b) 본문 XML 에 U+2014 부재
//   (c) {{EQ 계열 마커 부재 (HWPX 는 postprocess 가 실제 수식 객체로 변환.
//       실패를 무시하고 내보내면 사용자에게 raw 마커가 보인다 -> 회귀 방지)
//   (d) 차트 PNG/업로드 사진이 BinData 로 실제 embed 됐는지 + Preview/PrvText.txt 갱신
//
// Python 이 없으면(예: CI) 전체 skip 해 이식성을 유지한다.

"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

const HWPX_RENDERERS = {
  "chem-pre": "lib/pipelines/chem-pre/hwpx-gen",
  "chem-result": "lib/pipelines/chem-result/hwpx-gen",
  "phys-result": "lib/pipelines/phys-result/hwpx-gen",
};

const PYTHON = H.detectPython();
const skip = PYTHON
  ? false
  : "HWPX generator 용 Python 없음 (.venv/bin/python3 또는 PYTHON_BIN 필요)";

const LONG_DASH_RE = new RegExp("\\u2014");

describe("hwpx 렌더 결정 경로 (content JSON -> .hwpx, python spawn)", () => {
  for (const [fixtureName, rendererPath] of Object.entries(HWPX_RENDERERS)) {
    it(
      `${fixtureName}: PK Buffer + section0 + U+2014 부재 + {{EQ 변환 + BinData embed`,
      { skip, timeout: 180_000 },
      async () => {
        const { meta, content } = H.loadFixture(fixtureName);
        const { generateHwpx } = require(path.join(H.REPO_ROOT, rendererPath));

        const buffer = await generateHwpx(content, {});

        // (a) PK 매직 Buffer + 필수 항목
        assert.ok(Buffer.isBuffer(buffer), "generateHwpx 는 Buffer 를 반환해야 한다");
        assert.ok(H.isZipBuffer(buffer), "hwpx 산출물은 PK(ZIP) 매직이어야 한다");

        const zip = await H.loadZip(buffer);
        const entryNames = Object.keys(zip.files);
        const sectionNames = entryNames.filter((n) =>
          /^Contents\/section\d+\.xml$/.test(n),
        );
        assert.ok(
          sectionNames.includes("Contents/section0.xml"),
          "Contents/section0.xml 이 있어야 한다",
        );

        // 본문 + 헤더 XML 을 모두 모아 스캔한다.
        let bodyXml = "";
        for (const name of sectionNames) {
          bodyXml += (await H.zipEntryText(zip, name)) || "";
        }
        const headerXml = (await H.zipEntryText(zip, "Contents/header.xml")) || "";
        const scanTarget = bodyXml + headerXml;

        // (b) 긴 하이픈(U+2014) 부재
        assert.ok(
          !LONG_DASH_RE.test(scanTarget),
          "hwpx 본문 XML 에 U+2014 긴 하이픈이 남아 있음",
        );

        // (c) {{EQ 마커가 수식 객체로 변환되어 사라졌는지
        assert.ok(
          !scanTarget.includes("{{EQ"),
          "hwpx 본문에 raw {{EQ 수식 마커가 남아 있음 (수식 postprocess 실패)",
        );
        assert.ok(
          !scanTarget.includes("{{MATH:") && !scanTarget.includes("{{FORMULA:"),
          "hwpx 본문에 위키식 수식 마커가 남아 있음",
        );

        // (d) 콘텐츠 텍스트 + 바이너리 embed + 미리보기 갱신
        const bodyText = H.xmlToText(bodyXml);
        for (const expected of meta.expect.hwpxIncludes || []) {
          assert.ok(
            bodyText.includes(expected),
            `hwpx 본문에 기대 텍스트 누락: ${JSON.stringify(expected)}`,
          );
        }
        if (meta.expect.hwpxMinBinData) {
          const binItems = entryNames.filter((n) => /(^|\/)BinData\//.test(n));
          assert.ok(
            binItems.length >= meta.expect.hwpxMinBinData,
            `BinData 항목 ${binItems.length}개 < 기대 최소 ${meta.expect.hwpxMinBinData}개 (차트/사진 embed 누락)`,
          );
        }
        assert.ok(
          entryNames.includes("Preview/PrvText.txt"),
          "Preview/PrvText.txt 미리보기가 갱신되어야 한다",
        );
      },
    );
  }
});
