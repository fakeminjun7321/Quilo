// Claude가 JSON string literal 안에 raw control characters (\n, \r, \t)를
// escape 없이 넣어버린 경우 (긴 응답에서 종종 발생), JSON.parse 직전에 자동 escape.
//
// 동작: "in string" 상태를 추적하며 string 내부의 raw control char만 escape.
// key-value 사이의 줄바꿈 (구조적 whitespace)은 그대로 유지.

function sanitizeJson(jsonStr) {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < jsonStr.length; i++) {
    const c = jsonStr[i];
    if (escape) {
      result += c;
      escape = false;
      continue;
    }
    if (c === "\\") {
      result += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      result += c;
      inString = !inString;
      continue;
    }
    if (inString) {
      if (c === "\n") { result += "\\n"; continue; }
      if (c === "\r") { result += "\\r"; continue; }
      if (c === "\t") { result += "\\t"; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        result += "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
    }
    result += c;
  }
  return result;
}

// JSON.parse를 시도하되, 실패하면 sanitize 후 재시도.
// 둘 다 실패하면 원래 에러를 던짐 (디버깅용).
function parseJsonLenient(jsonStr) {
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // raw control character 같은 흔한 이슈 자동 fix 후 재시도
    try {
      return JSON.parse(sanitizeJson(jsonStr));
    } catch {
      throw e; // 원래 에러 (사용자에게 더 도움됨)
    }
  }
}

module.exports = { sanitizeJson, parseJsonLenient };
