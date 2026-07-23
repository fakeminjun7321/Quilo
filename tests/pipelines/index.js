// `node --test tests/pipelines/` 진입점.
//
// Node v21+ 의 --test 는 디렉토리 인자를 재귀 탐색하지 않고 모듈로 로드한다
// (v24 실측). 그래서 디렉토리 형태 호출을 지원하기 위해 이 index 가
// *.test.js 를 전부 등록한다. 개별 파일/글롭 호출도 그대로 동작한다:
//   node --test tests/pipelines/
//   node --test tests/pipelines/*.test.js
//   node --test tests/pipelines/docx-render.test.js
//
// 주의: 이 진입점 경유 시 모든 스위트가 한 프로세스에서 순차 실행된다.
// (테스트 파일들은 프로세스 공유를 전제로 작성됨 - env 변형은 try/finally 복원)

"use strict";

const fs = require("fs");
const path = require("path");

const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.js"))
  .sort();

for (const name of files) {
  require(path.join(__dirname, name));
}
