// 보고서 파이프라인 회귀: docx 렌더 결정 경로.
//
// 각 타입의 docx-gen.generateDocx(content) 는 (모델 호출 없이) content JSON 을
// 결정론적으로 Word 문서 Buffer 로 바꾼다. 여기서는 산출물만 검사한다:
//   (a) PK 매직의 Buffer 반환
//   (b) word/document.xml 에 긴 하이픈(U+2014/U+2013) 부재
//       (서버 stripAiDashes 이후에도 렌더러가 하드코딩 문자열로 재유입시키지 않는지)
//   (c) raw {{EQ: / {{MATH: 수식 마커 부재 (docx 는 유니코드 평문으로 변환되어야 함)
//   (d) 콘텐츠 본문 텍스트(제목 등)가 실제 문서에 들어갔는지
//   (e) 사진/차트 PNG 가 word/media/* 로 실제 embed 됐는지 (픽스처별 하한)
//
// 주의: chem-result docx 는 설계상 제목을 렌더하지 않는다(사전보고서 뒤에 붙는
// 추가 작성분). 그래서 기대 문자열은 픽스처 __meta.expect.docxIncludes 로
// 타입별로 정의한다 (chem-result 는 실험명/차트 제목/논의 텍스트를 검사).

"use strict";

const path = require("path");
const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const H = require("./helpers/content-fixtures");

// 서버 PIPELINES 와 동일한 타입 -> docx 렌더러 바인딩 (public export 만 사용).
const DOCX_RENDERERS = {
  "chem-pre": "lib/pipelines/chem-pre/docx-gen",
  "chem-result": "lib/pipelines/chem-result/docx-gen",
  "phys-result": "lib/pipelines/phys-result/docx-gen",
  "free": "lib/pipelines/free-report/docx-gen",
  "form-maker": "lib/pipelines/form-maker/docx-gen",
};

// U+2014(em dash) / U+2013(en dash): 리터럴 대신 이스케이프로 표기.
const LONG_DASH_RE = new RegExp("[\\u2014\\u2013]");
const RAW_EQ_MARKER_RE = /\{\{(EQ|EQN|MATH|FORMULA)[:-]/;

describe("docx 렌더 결정 경로 (content JSON -> .docx)", () => {
  for (const [fixtureName, rendererPath] of Object.entries(DOCX_RENDERERS)) {
    it(`${fixtureName}: PK Buffer + dash/수식 마커 부재 + 본문 텍스트/이미지 포함`, async () => {
      const { meta, content } = H.loadFixture(fixtureName);
      const { generateDocx } = require(path.join(H.REPO_ROOT, rendererPath));

      const buffer = await generateDocx(content);

      // (a) PK 매직 Buffer
      assert.ok(Buffer.isBuffer(buffer), "generateDocx 는 Buffer 를 반환해야 한다");
      assert.ok(H.isZipBuffer(buffer), "docx 산출물은 PK(ZIP) 매직이어야 한다");
      assert.ok(
        buffer.length > 2000,
        `docx 산출물이 비정상적으로 작음 (${buffer.length}B)`,
      );

      const zip = await H.loadZip(buffer);
      const xml = await H.zipEntryText(zip, "word/document.xml");
      assert.ok(xml && xml.length > 0, "word/document.xml 이 있어야 한다");

      // (b) 긴 하이픈 부재
      assert.ok(
        !LONG_DASH_RE.test(xml),
        "word/document.xml 에 U+2014/U+2013 긴 하이픈이 남아 있음",
      );

      // (c) raw 수식 마커 부재 (사용자에게 {{EQ:...}} 가 그대로 보이는 결함)
      assert.ok(
        !RAW_EQ_MARKER_RE.test(xml),
        "word/document.xml 에 raw {{EQ:/{{MATH: 계열 수식 마커가 남아 있음",
      );

      // (d) 콘텐츠 텍스트가 실제 렌더됐는지
      const text = H.xmlToText(xml);
      for (const expected of meta.expect.docxIncludes || []) {
        assert.ok(
          text.includes(expected),
          `문서 본문에 기대 텍스트 누락: ${JSON.stringify(expected)}`,
        );
      }

      // (e) 사진/차트가 실제 이미지로 embed 됐는지 (픽스처에 하한이 정의된 경우만)
      if (meta.expect.docxMinMedia) {
        const media = Object.keys(zip.files).filter((n) =>
          n.startsWith("word/media/"),
        );
        assert.ok(
          media.length >= meta.expect.docxMinMedia,
          `word/media/* 이미지 ${media.length}개 < 기대 최소 ${meta.expect.docxMinMedia}개 (사진/차트 embed 누락)`,
        );
      }
    });
  }
});
