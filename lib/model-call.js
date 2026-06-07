// 보고서 생성용 제공자-인지 모델 호출 헬퍼.
//
// 보고서 파이프라인들은 Anthropic 형식 content 블록(text/document(base64 PDF)/image(base64))과
// 시스템 프롬프트로 Claude 를 스트리밍 호출한다. GPT(OpenAI) 모델일 때는 이 헬퍼가 그 블록을
// OpenAI chat/completions 형식(file/file_data, image_url, text)으로 변환해 호출하고, 결과를
// { text, usage } 로 돌려준다(usage 는 calcCost 가 그대로 쓰도록 Anthropic 형식).
//
// 시스템 프롬프트는 Claude/GPT 공용 prompt.md 를 그대로 쓴다(모델 무관).
// 웹검색(chem-pre 시약 물성): OpenAI chat/completions 엔 Anthropic web_search 가 없으므로
// GPT 경로에선 도구 없이 모델 지식으로 채운다. 필요시 추후 Responses API web_search 로 확장 가능.

const GPT_BASE = process.env.GPT_API_BASE || "https://api.openai.com/v1";
// GPT-5.x 추론 모델은 max_completion_tokens 예산을 '추론 토큰'과 '출력 토큰'이
// 공유한다. effort 를 낮춰야 추론이 예산을 덜 먹어 JSON 출력이 잘리지 않는다.
// 보고서는 깊은 추론보다 구조화 출력이 중요하므로 기본 'low'.
const GPT_REASONING_EFFORT = process.env.GPT_REASONING_EFFORT || "low";

function isGptModel(m) {
  return /^gpt/i.test(String(m || ""));
}

// GPT 전용 시스템 보강 규칙. prompt.md(=Claude 기준)에 더해, GPT 가 자주 어기는
// 출력 형식·완전성 규칙을 강한 어조로 명시한다. 각 파이프라인이 isGptModel 일 때
// 시스템 프롬프트 뒤에 덧붙인다. (별도 prompt.gpt.md 를 따로 유지하지 않고 단일
// 소스 prompt.md + 이 보강분으로 관리해 drift 를 막는다.)
const GPT_SYSTEM_ADDENDUM = `

──────────────────────────────────────────────
[GPT 출력 보강 규칙 — 위 지침과 충돌 시 위 지침이 우선, 단 아래는 반드시 지킬 것]

1. 출력은 **단 하나의 JSON 객체**만. JSON 앞뒤에 설명·인사·코드펜스 텍스트를 절대 넣지 말 것.
2. 스키마의 **모든 필드를 빠짐없이 채울 것**. 객체를 빈 {} 나 빈 "" 로 두지 말 것(예: pcei, conclusion, analysis 는 비우면 안 됨).
3. **서로 다른 측정 실험·서로 다른 측정 조건마다 별도 항목으로 빠짐없이 반영**할 것(한 실험만 다루고 나머지를 조용히 생략하거나, 여러 조건을 임의로 한 항목으로 병합하지 말 것). 단, 같은 한 실험의 여러 시트(원자료/계산/차트 등 같은 측정의 다른 표현)는 한 항목으로 묶을 것.
4. **사람이 읽는 모든 텍스트는 한국어**로: 보고서 제목, 표 헤더(data_table.headers), 실험명(experiments[].name), 캡션, 본문, 분석, 그리고 **차트 안 텍스트(chart 의 title/x_label/y_label/x_values/series.label/trendline.label)도 한국어**로 작성(서버 렌더러가 NanumGothic 한글 폰트를 지원하므로 차트도 한글로 렌더된다). 단위·변수 기호(°C, mL, N, m/s², 1/T, ln P, mω²)는 그대로 둔다. 표·제목·실험명·차트 라벨을 영어로 쓰지 말 것 — 예: "각도 vs 시간", "시간 (s)", "측정값", "이론값", "선형 회귀". series.label 에 Exp/Theory/Measured/Trial/Run/Frequency 같은 영어 단어를 쓰지 말고 측정값/이론값/보정값/시행/진동수처럼 한국어로 쓸 것.
5. 강조 마커 **bold** 는 한 섹션에 0~2회, 진짜 핵심 결과에만. 일반 변수나 평범한 문장에 남발하지 말 것. **여는 마커는 반드시 같은 문자열 안에서 닫을 것**(미완결 *, ** 금지). 변수는 *기울임* 또는 _{아래첨자}/^{위첨자} 표기를 쓰되, 그 외의 위키식 수식 마커({{MATH}}, [[수식]] 등)는 쓰지 말 것.
6. **데이터에 없는 값을 지어내지 말 것**. 측정하지 않은 항목은 빈칸/placeholder 로 두고, 임의 평균·임의 제외·없는 오차원인을 만들지 말 것.
7. 군더더기 도입/마무리 문장, 같은 말 반복, "A/B/C" 식 슬래시 나열을 쓰지 말 것. 간결하고 학술적으로.
──────────────────────────────────────────────`;

function gptKey() {
  return process.env.GPT_API_KEY || process.env.OPENAI_API_KEY || "";
}
function gptConfigured() {
  return !!gptKey();
}

// Anthropic system(문자열 또는 [{type:'text',text,...}]) → OpenAI system 문자열.
function systemToText(system) {
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b && b.text ? b.text : ""))
      .join("\n");
  }
  return String(system || "");
}

// Anthropic content 블록 배열 → OpenAI chat content 파트 배열.
function toOpenAiContent(blocks) {
  const out = [];
  for (const b of blocks || []) {
    if (!b) continue;
    if (b.type === "text") {
      out.push({ type: "text", text: b.text || "" });
    } else if (b.type === "document" && b.source && b.source.type === "base64") {
      out.push({
        type: "file",
        file: {
          filename: b.source.filename || "document.pdf",
          file_data: `data:${b.source.media_type || "application/pdf"};base64,${b.source.data}`,
        },
      });
    } else if (b.type === "image" && b.source && b.source.type === "base64") {
      out.push({
        type: "image_url",
        image_url: {
          url: `data:${b.source.media_type || "image/png"};base64,${b.source.data}`,
        },
      });
    }
    // web_search 등 tool 블록·기타는 GPT 경로에서 무시.
  }
  return out;
}

// GPT 보고서 생성 호출. params 는 Anthropic 스타일(system, content, model, maxTokens).
// → { text, usage:{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens} }
async function callGptReport({
  model,
  system,
  content,
  maxTokens = 32000,
  jsonObject = true,
  signal,
  onProgress = () => {},
}) {
  const key = gptKey();
  if (!key) {
    throw new Error("GPT_API_KEY(OpenAI) 환경변수가 설정되지 않았습니다.");
  }
  const messages = [
    { role: "system", content: systemToText(system) + GPT_SYSTEM_ADDENDUM },
    { role: "user", content: toOpenAiContent(content) },
  ];
  // 1회 호출. 추론+출력이 한 예산을 공유하므로 넉넉히 잡는다.
  async function once(maxTok, effort) {
    const body = {
      model,
      messages,
      max_completion_tokens: maxTok,
      reasoning_effort: effort,
    };
    if (jsonObject) body.response_format = { type: "json_object" };
    const resp = await fetch(`${GPT_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${raw.slice(0, 300)}`);
    let j;
    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(
        `OpenAI 응답을 해석할 수 없습니다(${resp.status}, ${raw.length}바이트)${raw ? ": " + raw.slice(0, 160) : " — 빈 응답"}`,
      );
    }
    const choice = (j.choices && j.choices[0]) || {};
    return {
      finish: choice.finish_reason,
      text: (choice.message && choice.message.content) || "",
      usage: j.usage || {},
    };
  }

  onProgress(`🤖 ${model} 에게 전송 — 보고서 생성 중...`);
  // 1차: 넉넉한 예산 + 설정된 effort. 길이로 잘리면 더 큰 예산 + 최소 추론으로 1회 재시도.
  const cap1 = Math.max(maxTokens, 48000);
  let r = await once(cap1, GPT_REASONING_EFFORT);
  if (r.finish === "length") {
    onProgress("⚠️ 출력이 길어 더 큰 예산으로 1회 재시도합니다...");
    r = await once(Math.max(cap1 * 2, 96000), "minimal");
  }
  if (r.finish === "length") {
    throw new Error(
      "GPT 출력이 최대 길이에 도달해 잘렸습니다(재시도 후에도). 입력을 줄이거나 다시 시도하세요.",
    );
  }
  if (!r.text || !r.text.trim()) {
    throw new Error("GPT가 빈 응답을 반환했습니다.");
  }
  const u = r.usage;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0;
  return {
    text: r.text,
    usage: {
      input_tokens: Math.max(0, (u.prompt_tokens || 0) - cached),
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: cached,
      cache_creation_input_tokens: 0,
    },
  };
}

module.exports = {
  isGptModel,
  gptConfigured,
  systemToText,
  toOpenAiContent,
  callGptReport,
  GPT_SYSTEM_ADDENDUM,
};
