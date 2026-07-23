// 보고서 파이프라인 공용 — Claude 스트리밍 + 끊김/길이 복구(이어쓰기) 헬퍼.
//
// 배경(왜 필요한가):
//   Render 등 호스팅 환경은 server→api.anthropic.com 단일 연결을 ~150~210초에 끊는다
//   (Premature close / ERR_STREAM_PREMATURE_CLOSE). 장문 보고서는 한 번의 긴 스트림으로
//   생성되므로 이 벽에 걸려 통째로 실패했다. 또 claude-opus-4-8 은 assistant prefill
//   (마지막 메시지를 assistant 로 두는 이어쓰기)을 지원하지 않아 400("conversation must
//   end with a user message")으로 복구 시도가 무조건 실패했다.
//
//   이 헬퍼는 그 두 문제를 동시에 해결한다:
//     - 끊기면(또는 max_tokens 로 잘리면) '새 연결'로 이어 받는다 → 각 연결이 짧아져
//       연결수명 컷오프에 안 걸린다(끊긴 지점부터 user-message 지시로 이어쓰기).
//     - prefill 이 아니라 user-message 이어쓰기라 Opus 4.8 에서도 400 이 안 난다
//       (부분응답을 assistant 히스토리로 넣고, 마지막은 user 지시로 끝낸다).
//
//   원본 검증 구현은 math-inquiry/generate.js(commit 301888e, 적대적 코드리뷰 2회).
//   그것을 파이프라인 비종속으로 추출해 phys-result/chem-result/chem-pre/free-report/
//   phys-inquiry 가 공유한다.

const { parseJsonLenient } = require("./json-sanitize");

// 일시적(연결) 오류만 이어쓰기/재시도 대상. 진짜 API 오류(400 스키마 등)·사용자 중단은 제외.
function isTransientStreamError(e) {
  return /premature close|econnreset|socket hang up|\bterminated\b|other side closed|und_err|fetch failed|network error|epipe|enotfound|eai_again/i.test(
    String((e && e.message) || e || ""),
  );
}

// 코드펜스를 모두 제거한 뒤, 문자열/이스케이프를 고려해 '깊이 0 으로 처음 닫히는' 완전한
// 객체만 잘라낸다. 끊김 이어쓰기로 뒤에 중복 객체·군더더기가 붙어도 첫 완전 JSON 만 취해
// "Unexpected non-whitespace character after JSON" 파싱 실패를 피한다. 끝까지 안 닫히면
// (진짜 미완성) last '}' 폴백.
function extractJson(text) {
  const t = String(text || "").replace(/```+[ \t]*(?:json)?/gi, " ");
  const start = t.indexOf("{");
  if (start === -1) return null;
  let depth = 0,
    inStr = false,
    esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return t.slice(start, i + 1);
  }
  const last = t.lastIndexOf("}");
  return last > start ? t.slice(start, last + 1) : null;
}

// 지금까지 받은 텍스트가 이미 파싱 가능한 완전 JSON 인지(끊겨도 완성됐으면 이어쓰기 불필요).
function looksCompleteJson(text) {
  const j = extractJson(text);
  if (!j) return false;
  try {
    parseJsonLenient(j);
    return true;
  } catch {
    return false;
  }
}

const CONT_INSTRUCTION =
  "직전 너의 응답이 길이 제한으로 중간에 잘렸다. 잘린 바로 그 지점부터 곧바로 이어서, 남은 부분만 출력하라. 이미 출력한 내용을 절대 다시 반복하지 말고, 인사·설명·새 코드펜스(```) 없이 잘린 위치에 그대로 이어 붙여 JSON 을 끝까지 완성하라.";

// 이어쓰기 구간(seg>1)이 펜스를 다시 열면 앞 펜스만 제거(최종 extractJson 이 전역으로 또 정리).
const stripContLead = (txt) => txt.replace(/^\s*```(?:json)?[ \t]*\r?\n?/i, "");

/**
 * Claude 스트림을 끝까지(끊김/길이 복구 포함) 받아 전체 텍스트를 반환한다.
 *
 * @param {object} o
 * @param {Anthropic} o.client            - Anthropic SDK 클라이언트
 * @param {string}   o.model              - 모델 id
 * @param {number}   o.maxTokens          - max_tokens
 * @param {string}   o.system             - 시스템 프롬프트(문자열). 내부에서 cache_control 블록으로 감쌈
 * @param {Array|object} o.userContent    - user 메시지 content 배열(또는 {role,content} 메시지)
 * @param {AbortSignal} [o.signal]
 * @param {string|null} [o.betaHeaders]   - 있으면 anthropic-beta 헤더로 전달(예: Files API beta)
 * @param {boolean}  [o.useWebSearch]     - web_search 도구 사용 여부
 * @param {number}   [o.webSearchMaxUses=3]
 * @param {boolean}  [o.enableThinking]
 * @param {string}   [o.thinkingEffort="medium"]
 * @param {(m:string)=>void} [o.onProgress]
 * @param {string}   [o.label=""]         - 진행 메시지 접두 라벨(여러 콜 구분용; 비우면 접두 없음)
 * @param {string}   [o.noun="보고서"]     - "○○ 작성 중..." 의 명사
 * @param {number}   [o.startedAt]        - 경과시간 기준(기본 now)
 * @param {number}   [o.maxSegments=5]    - 이어쓰기 최대 구간 수
 * @returns {Promise<{text:string, usage:object, webSearchCount:number}>}
 */
async function streamWithContinuation({
  client,
  model,
  maxTokens,
  system,
  userContent,
  signal,
  betaHeaders = null,
  useWebSearch = false,
  webSearchMaxUses = 3,
  enableThinking = false,
  thinkingEffort = "medium",
  onProgress = () => {},
  label = "",
  noun = "보고서",
  startedAt = Date.now(),
  maxSegments = 5,
}) {
  if (!client) throw new Error("streamWithContinuation: client 가 필요합니다.");
  const pfx = label ? `[${label}] ` : "";
  const elapsed = () => Math.floor((Date.now() - startedAt) / 1000);
  const systemBlock = [
    { type: "text", text: system, cache_control: { type: "ephemeral" } },
  ];
  const reqOptions = (() => {
    const o = {};
    if (signal) o.signal = signal;
    if (betaHeaders) o.headers = { "anthropic-beta": betaHeaders };
    return Object.keys(o).length ? o : undefined;
  })();
  // userContent 를 content 배열로 정규화({role,content} 메시지를 받아도 동작).
  const initialContent =
    Array.isArray(userContent) || typeof userContent === "string"
      ? userContent
      : userContent && userContent.content
        ? userContent.content
        : userContent;

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const addUsage = (u) => {
    if (!u) return;
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
  };

  let webSearchCount = 0;
  let charCount = 0;
  let fullText = "";
  let emptyDrops = 0; // 같은 콜에서 '텍스트 0자' 끊김 연속 횟수(진전 있으면 리셋)

  for (let seg = 1; seg <= maxSegments; seg++) {
    const messages = fullText
      ? [
          { role: "user", content: initialContent },
          // assistant content 끝 공백만 제거(API 거부 회피). fullText 자체는 안 건드려
          // 숫자 경계가 공백 없이 합쳐져 조용히 손상되는 일을 막는다.
          { role: "assistant", content: fullText.replace(/\s+$/, "") },
          { role: "user", content: CONT_INSTRUCTION },
        ]
      : [{ role: "user", content: initialContent }];

    let segText = "";
    let lastReportedChars = charCount;
    let lastEventAt = Date.now();
    let firstTokenSeen = fullText.length > 0;
    let searchInFlight = false;
    let lastUsage = null; // 끊긴 구간도 토큰을 집계할 수 있게 증분 usage 보관

    const heartbeat = setInterval(() => {
      if ((Date.now() - lastEventAt) / 1000 >= 12) {
        onProgress(
          `⏳ ${pfx}${firstTokenSeen ? `${noun} 작성 중... (${charCount}자, ${elapsed()}초)` : `모델이 분석 중... (${elapsed()}초)`}`,
        );
        lastEventAt = Date.now();
      }
    }, 5000);

    const params = {
      model,
      max_tokens: maxTokens,
      system: systemBlock,
      messages,
    };
    if (enableThinking) {
      params.thinking = { type: "adaptive" };
      params.output_config = { effort: thinkingEffort };
    } else if (!/fable/i.test(model || "")) {
      // Sonnet 5는 thinking 생략 시 추론(adaptive) ON이 기본 → 기존 '추론 OFF' 동작 유지를
      // 위해 명시적으로 disabled. (Fable 5는 disabled 가 400 이므로 제외 → 항상 추론 ON)
      params.thinking = { type: "disabled" };
    }
    if (useWebSearch) {
      params.tools = [
        { type: "web_search_20250305", name: "web_search", max_uses: webSearchMaxUses },
      ];
    }

    try {
      const stream = client.messages.stream(params, reqOptions);
      stream.on("streamEvent", (event) => {
        lastEventAt = Date.now();
        // 증분 usage 보관(끊겨도 직전 usage 로 집계 — 과소집계 방지).
        if (event.type === "message_start" && event.message?.usage)
          lastUsage = event.message.usage;
        if (event.type === "message_delta" && event.usage)
          lastUsage = { ...(lastUsage || {}), ...event.usage };
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block?.type === "text") {
            if (!firstTokenSeen) {
              onProgress(
                `✍️ ${pfx}${noun} 작성 ${seg > 1 ? "이어서 " : ""}시작 (${elapsed()}초)`,
              );
              firstTokenSeen = true;
            }
          } else if (block?.type === "thinking") {
            if (!firstTokenSeen) onProgress(`🤔 ${pfx}추론 중... (${elapsed()}초)`);
          } else if (block?.type === "server_tool_use" && block?.name === "web_search") {
            webSearchCount++;
            searchInFlight = true;
            onProgress(`🔍 ${pfx}웹 검색 중... (${webSearchCount}번째, ${elapsed()}초)`);
          } else if (block?.type === "web_search_tool_result") {
            searchInFlight = false;
            onProgress(`✓ ${pfx}검색 결과 수신`);
          }
        }
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          segText += event.delta.text;
          charCount += event.delta.text.length;
          if (charCount - lastReportedChars >= 1500) {
            onProgress(`✍️ ${pfx}${noun} 작성 중... (${charCount}자, ${elapsed()}초)`);
            lastReportedChars = charCount;
          }
        }
        if (event.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
          onProgress(`⚠ ${pfx}토큰 한도 — 이어서 생성`);
        }
      });

      const finalMessage = await stream.finalMessage();
      addUsage(finalMessage.usage);
      fullText += seg > 1 ? stripContLead(segText) : segText;
      // max_tokens 로 잘렸어도 JSON 이 이미 완성됐으면 종료. 아니면 이어쓰기.
      if (
        finalMessage.stop_reason === "max_tokens" &&
        seg < maxSegments &&
        !looksCompleteJson(fullText)
      ) {
        onProgress(`🔁 ${pfx}길이 한도 — 이어서 생성 (${seg}/${maxSegments})`);
        continue;
      }
      return { text: fullText, usage, webSearchCount };
    } catch (e) {
      if (signal && signal.aborted) throw e; // 사용자 중단·타임아웃은 재시도 안 함
      if (!isTransientStreamError(e)) throw e; // 진짜 오류(400 스키마 등)는 그대로 전파
      const cause = (e && e.cause && (e.cause.code || e.cause.message)) || e.name || "?";
      const msg = String((e && e.message) || e || "").slice(0, 80);
      onProgress(
        `🔧 ${pfx}끊김 진단: seg${seg} @${elapsed()}초 ${charCount}자 | 검색중=${searchInFlight} | cause=${cause} | msg=${msg}`,
      );
      if (lastUsage) addUsage(lastUsage); // 끊긴 구간 토큰도 집계
      if (segText.length > 0) {
        fullText += seg > 1 ? stripContLead(segText) : segText;
        emptyDrops = 0; // 진전 있으면 빈끊김 카운터 리셋
        // 끊겼지만 이미 완전한 JSON 을 다 받았으면 이어쓰기 불필요(계속하면 중복 객체로 파싱 깨짐).
        if (looksCompleteJson(fullText)) return { text: fullText, usage, webSearchCount };
        if (seg >= maxSegments) return { text: fullText, usage, webSearchCount };
        onProgress(
          `🔁 ${pfx}연결 끊김(${elapsed()}초, ${charCount}자) — 받은 내용에서 이어서 생성 (${seg}/${maxSegments})`,
        );
        continue;
      }
      emptyDrops++;
      if (emptyDrops > 2 || seg >= maxSegments) throw e;
      onProgress(`🔁 ${pfx}연결 끊김(응답 시작 전) — 재시도 (${emptyDrops}/2)`);
      seg--; // 빈 끊김은 구간으로 세지 않음
      continue;
    } finally {
      clearInterval(heartbeat);
    }
  }
  return { text: fullText, usage, webSearchCount };
}

module.exports = {
  streamWithContinuation,
  extractJson,
  looksCompleteJson,
  isTransientStreamError,
};

// ── 자체 점검(외부 호출 없음): node lib/claude-stream.js ──────────────────────
if (require.main === module) {
  const assert = require("assert");
  // extractJson: 중복 객체가 뒤에 붙어도 첫 완전 객체만.
  assert.strictEqual(
    extractJson('```json\n{"a":1}\n```\n{"a":1}'),
    '{"a":1}',
    "중복 객체 뒤에 붙어도 첫 완전 객체",
  );
  // 중첩/문자열 안 중괄호 처리.
  assert.strictEqual(extractJson('prefix {"k":"}{","n":{"m":2}} tail'), '{"k":"}{","n":{"m":2}}');
  // 미완성 → last '}' 폴백.
  assert.strictEqual(extractJson('{"a":1, "b":'), null);
  assert.strictEqual(extractJson("no braces"), null);
  // looksCompleteJson
  assert.strictEqual(looksCompleteJson('{"a":1}'), true);
  assert.strictEqual(looksCompleteJson('{"a":'), false);
  // isTransientStreamError: 연결오류만 true, 400 스키마오류는 false.
  assert.strictEqual(isTransientStreamError(new Error("Premature close")), true);
  assert.strictEqual(isTransientStreamError(new Error("ERR_STREAM_PREMATURE_CLOSE: terminated")), true);
  assert.strictEqual(isTransientStreamError(new Error("fetch failed")), true);
  assert.strictEqual(
    isTransientStreamError(new Error("400 invalid_request_error: messages: ...")),
    false,
    "400 스키마 오류는 일시적 아님",
  );
  console.log("claude-stream self-test OK");
}
