// 공통 "보고서 AI 이미지(개념도·삽화) 생성" 헬퍼.
//
// 모든 보고서 파이프라인(chem-pre/chem-result/phys-result/phys-inquiry/math-inquiry)에서
// 사용자가 "이미지 생성 허용"을 켰을 때, 모델이 방출한 figures[] 를 실제 PNG 버퍼로
// 만들어 기존 사진/그림 삽입 경로(__photos / add_picture / ImageRun)에 흘려보낸다.
//
// 핵심 안전 규칙 (학술 무결성):
// - 개념도·원리 도해·장식 삽화만 생성한다.
// - 실제 실험 사진·결과 사진처럼 보이는 이미지, 측정 데이터·그래프·차트, 특정 수치를
//   담은 그림은 절대 생성하지 않는다(실데이터 그래프는 chart 엔진이 따로 그린다).
// - 캡션에 'AI 생성 개념도'임이 드러나게 한다.
//
// 이미지 엔진: 기존 artifacts 와 동일하게 OpenAI images/generations(gpt-image-1).
// 키: GPT_API_KEY → OPENAI_API_KEY. 엔드포인트: GPT_API_BASE.

const GPT_BASE = process.env.GPT_API_BASE || "https://api.openai.com/v1";
// 개념도·장식은 std(gpt-image-1) 로 충분하고 빠르다. env 로 교체 가능.
const IMAGE_MODEL =
  process.env.REPORT_IMAGE_MODEL || process.env.IMAGE_MODEL_STD || "gpt-image-1";
// 지연·타임아웃·비용 방어 — 보고서당 생성 장수 상한.
const MAX_FIGURES = Math.max(
  0,
  parseInt(process.env.REPORT_IMAGE_MAX || "2", 10) || 2,
);

function imageKeyAvailable() {
  return !!(process.env.GPT_API_KEY || process.env.OPENAI_API_KEY);
}

// 파이프라인 입력에서 "이미지 생성 허용 + 키 존재" 여부.
function allowsImageGen(input = {}) {
  return !!input.allowImageGen && imageKeyAvailable();
}

// 시스템 프롬프트에 붙일 지침. allowImageGen 일 때만 붙인다.
const IMAGE_SYSTEM_SECTION = `## AI 이미지(개념도·삽화) 생성 — 허용됨

이 보고서는 AI 이미지 생성이 **허용**되었습니다. 이해를 돕는 **개념도/모식도** 또는 표지·섹션 **장식 삽화**가 정말 도움이 될 때, JSON 최상위에 "figures" 배열을 추가하세요.

각 figure 형식:
{
  "kind": "concept" | "decoration",
  "prompt": "생성할 이미지를 묘사하는 영어 프롬프트 (깔끔한 교육용 모식도/도해 스타일)",
  "caption": "그림 캡션 (한국어, 개념 설명용 삽화임이 드러나게)",
  "placement": "이 그림이 어울리는 위치 힌트 (예: 이론, 결론, 표지)"
}

엄격한 규칙(반드시 지킬 것):
- **개념도·원리 도해·추상 개념 시각화·장식 삽화만** 생성합니다.
- **절대 금지**: ① 실제 실험 사진·결과 사진처럼 보이는 이미지, ② 측정 데이터·그래프·차트 이미지(실데이터 그래프는 따로 그려집니다), ③ 특정 측정 수치를 담은 표/그림. AI가 만든 그림을 실측 증거처럼 보이게 하면 학술 부정입니다.
- caption 에는 개념 설명용 삽화임이 드러나야 합니다.
- figure 는 **최대 ${MAX_FIGURES}개**. 정말 도움이 되는 경우에만. 필요 없으면 "figures" 를 넣지 않거나 빈 배열로 둡니다.
- prompt 는 글자(텍스트 라벨)를 최소화한 깔끔한 도해 스타일로 묘사하세요(생성 이미지의 글자는 자주 깨집니다).`;

// 모델 prompt 를 안전한 교육용 도해 스타일로 감싼다.
function buildSafePrompt(fig) {
  const base = String(fig.prompt || "").trim().slice(0, 900);
  const style =
    fig.kind === "decoration"
      ? "Clean minimal decorative illustration for an academic report cover. Flat, professional, no text labels."
      : "Clean educational schematic diagram / conceptual illustration for a science lab report. Flat vector style, white background, minimal or no text labels.";
  return `${base}\n\nStyle: ${style} Do NOT depict it as a real photograph or as real measured data.`;
}

// gpt-image-1 지원 사이즈로 매핑. decoration 은 가로형 표지.
function figSize(fig) {
  return fig.kind === "decoration" ? "1536x1024" : "1024x1024";
}

// 캡션이 'AI 생성 개념도'임을 드러내게 보정.
function cleanCaption(c) {
  let s = String(c || "").trim();
  if (!s) s = "개념 설명 그림";
  if (!/ai/i.test(s)) s = `${s} (AI 생성 개념도)`;
  return s;
}

async function callImageModel(prompt, size, model) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("이미지 생성 키(GPT_API_KEY)가 없습니다.");
  const resp = await fetch(`${GPT_BASE}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || IMAGE_MODEL,
      prompt,
      size: size || "1024x1024",
      quality: "medium",
    }),
  });
  const raw = await resp.text();
  if (!resp.ok)
    throw new Error(`이미지 생성 ${resp.status}: ${raw.slice(0, 160)}`);
  const j = JSON.parse(raw);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("이미지 응답이 비었습니다.");
  return b64;
}

// 단일 프롬프트 → PNG Buffer. model 미지정 시 기본 엔진(gpt-image-1).
// model 을 주면 그 모델로(예: "gpt-image-2"), 실패 시 호출자가 폴백한다.
async function genImage(prompt, { size, model } = {}) {
  const b64 = await callImageModel(prompt, size, model);
  return Buffer.from(b64, "base64");
}

// 입력 이미지(PNG/JPEG buffer) + 프롬프트 → 편집/재생성된 PNG Buffer (images/edits, 멀티파트).
// 문서 복원에서 "사진 속 그림을 깔끔히 다시 그림" 용. ⚠ 생성 모델이라 원본과 달라질 수 있다 —
// 호출부에서 옵트인 + 경고를 책임진다. 실패 시 throw(호출부가 원본 크롭으로 폴백).
async function editImage(imageBuffer, prompt, { size, model, signal } = {}) {
  const key = process.env.GPT_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw new Error("이미지 생성 키(GPT_API_KEY)가 없습니다.");
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    throw new Error("편집할 이미지가 비었습니다.");
  }
  const form = new FormData();
  form.append("model", model || IMAGE_MODEL);
  form.append("image", new Blob([imageBuffer], { type: "image/png" }), "figure.png");
  form.append("prompt", String(prompt || "").slice(0, 900));
  form.append("size", size || "1024x1024");
  form.append("quality", "medium");
  const resp = await fetch(`${GPT_BASE}/images/edits`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`이미지 편집 ${resp.status}: ${raw.slice(0, 160)}`);
  const j = JSON.parse(raw);
  const b64 = j.data && j.data[0] && j.data[0].b64_json;
  if (!b64) throw new Error("이미지 편집 응답이 비었습니다.");
  return Buffer.from(b64, "base64");
}

// 모델이 방출한 figures[] 를 실제 PNG 버퍼로 만든다.
// 반환: [{ buffer, caption, kind, placement }]. 개별 실패는 건너뛴다(전체 생성을 막지 않음).
async function renderFigures(
  figures,
  { onProgress = () => {}, max = MAX_FIGURES } = {},
) {
  const list = (Array.isArray(figures) ? figures : [])
    .filter((f) => f && typeof f.prompt === "string" && f.prompt.trim())
    .slice(0, Math.max(0, max));
  if (list.length === 0) return [];
  onProgress(`🖼 AI 개념도/삽화 ${list.length}장 생성 중...`);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const fig = list[i];
    try {
      const buffer = await genImage(buildSafePrompt(fig), { size: figSize(fig) });
      out.push({
        buffer,
        caption: cleanCaption(fig.caption),
        kind: fig.kind === "decoration" ? "decoration" : "concept",
        placement: String(fig.placement || "").slice(0, 60),
      });
      onProgress(`🖼 이미지 ${i + 1}/${list.length} 생성 완료`);
    } catch (e) {
      onProgress(
        `⚠ 이미지 ${i + 1} 생성 실패 — 건너뜀 (${String(e.message).slice(0, 80)})`,
      );
    }
  }
  return out;
}

module.exports = {
  IMAGE_SYSTEM_SECTION,
  allowsImageGen,
  imageKeyAvailable,
  genImage,
  editImage,
  renderFigures,
  MAX_FIGURES,
};
