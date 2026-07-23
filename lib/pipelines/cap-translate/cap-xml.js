// PASCO Capstone .cap 의 main.xml 에서 "화면에 보이는 텍스트"만 골라내고,
// 번역 결과를 같은 자리에 안전하게 되써넣기 위한 XML/HTML 헬퍼.
//
// 설계 원칙(파일 무결성 최우선):
//   - main.xml 트리를 통째로 재직렬화하지 않는다. fast-xml-parser → build 왕복은
//     속성 순서·따옴표·엔티티·공백을 바꿔 캡스톤이 못 여는 파일을 만들 위험이 크다.
//   - 대신 원본 XML "문자열"에서 번역 대상 속성값만 정규식으로 찾아, 그 자리(byte
//     span)에만 새 값을 끼워 넣는다. 나머지 바이트는 1:1 보존된다.
//
// 번역 대상 (캡스톤 워크북에서 학생이 화면으로 읽는 텍스트):
//   1) <WorkbookPage ... Name="...">           → 페이지 탭 이름
//   2) <... DisplayTitleText="...">             → 표시 객체 제목(그림/표/그래프 캡션)
//   3) <CSTextEdit ... HTML="...">              → 이론/실험과정/분석/결론 등 본문 리치텍스트
//
// HTML 속성은 Qt 리치텍스트가 이중 이스케이프되어 들어있다(예: &lt;p&gt;...). 태그·스타일·
// DOCTYPE 는 절대 건드리지 않고, 태그 사이의 "보이는 텍스트 조각"만 추출해 번역한다.

// ── XML 속성값 이스케이프 ────────────────────────────────────────────────────
// 큰따옴표로 감싼 XML 속성값에 안전하게 들어가도록 최소 5종 엔티티만 이스케이프.
function xmlAttrEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// XML 속성값(이미 엔티티 디코드 전 raw)에서 표준 엔티티만 디코드. 숫자참조 포함.
function xmlEntityDecode(s) {
  if (!s) return "";
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeFromCode(parseInt(n, 10)))
    .replace(/&amp;/g, "&"); // amp 는 마지막에 (이중 디코드 방지)
}

function safeFromCode(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

// ── 번역할 만한 텍스트인지 판단 ───────────────────────────────────────────────
// 숫자·기호·단위·코드성 토큰만 있는 문자열은 번역하지 않는다(원문 유지).
// 최소 하나의 알파벳(라틴 문자)이 있어야 "번역할 문장"으로 본다.
const PLACEHOLDER_RE = /^\s*\[[^\]]*\]\s*$/; // [Text title here] 같은 캡스톤 placeholder
function isTranslatable(text) {
  const t = String(text || "").trim();
  if (t.length < 2) return false;
  if (PLACEHOLDER_RE.test(t)) return false; // 빈 placeholder 는 화면에 안 띄움
  if (!/[A-Za-z]/.test(t)) return false; // 알파벳 없는 순수 숫자/기호 → 유지
  // 이미 한글이 다수면(이미 번역됨) 건너뜀
  const ko = (t.match(/[가-힣]/g) || []).length;
  if (ko > 0 && ko >= t.replace(/\s/g, "").length * 0.4) return false;
  return true;
}

// ── HTML 안의 "보이는 텍스트" 조각 추출/치환 ──────────────────────────────────
// 디코드된 HTML 문자열을 받아, <style>/<script> 내부와 태그를 제외한 텍스트 노드만
// 골라낸다. 반환: { segments:[{text, raw}], replace(map) }
//   - segments[i].text : 번역할 원문(HTML 엔티티 디코드된 사람이 읽는 문자열)
//   - replace(translatedByOriginal) : 원문→번역 매핑을 받아 같은 위치만 치환한 HTML 반환
//
// 토큰 단위(태그 vs 텍스트)로 분해해 위치를 보존하므로, 같은 텍스트가 여러 번 나와도
// 안전하게 일괄 치환된다.
function parseHtmlSegments(decodedHtml) {
  const tokens = []; // {type:'tag'|'text', value}
  const re = /<[^>]+>/g;
  let last = 0;
  let m;
  while ((m = re.exec(decodedHtml)) !== null) {
    if (m.index > last) tokens.push({ type: "text", value: decodedHtml.slice(last, m.index) });
    tokens.push({ type: "tag", value: m[0] });
    last = re.lastIndex;
  }
  if (last < decodedHtml.length) tokens.push({ type: "text", value: decodedHtml.slice(last) });

  // <style>...</style>, <script>...</script> 내부 텍스트는 번역 금지 플래그.
  let skipDepth = 0;
  const segments = [];
  for (const tok of tokens) {
    if (tok.type === "tag") {
      const open = /^<\s*(style|script)[\s>]/i.test(tok.value);
      const close = /^<\s*\/\s*(style|script)\s*>/i.test(tok.value);
      if (open) skipDepth++;
      else if (close && skipDepth > 0) skipDepth--;
      continue;
    }
    if (skipDepth > 0) continue;
    // 텍스트 토큰: HTML 엔티티 디코드한 "보이는 문자열"
    const visible = xmlEntityDecode(tok.value);
    if (isTranslatable(visible)) {
      segments.push({ text: visible.trim(), token: tok });
    }
  }

  return {
    segments,
    // translatedByOriginal: Map<원문 trim, 번역문> → 같은 위치만 갈아끼운 HTML 반환
    replace(translatedByOriginal) {
      let out = "";
      for (const tok of tokens) {
        if (tok.type === "tag") {
          out += tok.value;
          continue;
        }
        const visible = xmlEntityDecode(tok.value);
        const key = visible.trim();
        const ko = translatedByOriginal.get(key);
        if (ko != null && isTranslatable(visible)) {
          // 앞/뒤 공백(들여쓰기·줄바꿈)은 보존하고 가운데 알맹이만 교체.
          const lead = visible.match(/^\s*/)[0];
          const trail = visible.match(/\s*$/)[0];
          out += htmlTextEscape(lead + ko + trail);
        } else {
          out += tok.value; // 원본 raw(엔티티 그대로) 유지
        }
      }
      return out;
    },
  };
}

// HTML 텍스트 노드용 이스케이프(<, >, & 만). 따옴표는 텍스트 노드에선 불필요.
function htmlTextEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── main.xml 전체에서 번역 단위 수집 ──────────────────────────────────────────
// 반환: { units:[{id, kind, text}], apply(translations) → 번역된 새 xml 문자열 }
//   kind: 'page' | 'title' | 'html-seg'
// units[].text 는 사람이 읽는 평문(번역 모델에 그대로 보냄).
//
// apply 는 원본 xml 문자열에서 "그 속성값 토큰"만 정규식 1패스로 치환한다.
function collectTranslationUnits(xmlString) {
  const units = [];
  let uid = 0;

  // 각 속성 매치의 위치(인덱스)와 새 값 계산기를 모았다가, 뒤에서 앞으로 치환한다.
  // (앞에서부터 치환하면 인덱스가 밀린다.)
  const edits = []; // {start, end, build(translations)}

  // 1) WorkbookPage Name="..."  (탭 이름)
  for (const m of matchAllAttr(xmlString, /<WorkbookPage\b[^>]*?\sName="([^"]*)"/g, 1)) {
    const raw = m.value;
    const text = xmlEntityDecode(raw).trim();
    if (!isTranslatable(text)) continue;
    const id = `u${uid++}`;
    units.push({ id, kind: "page", text });
    edits.push({
      start: m.valueStart,
      end: m.valueEnd,
      build: (tr) => {
        const ko = tr.get(id);
        return ko != null ? xmlAttrEscape(ko) : raw;
      },
    });
  }

  // 2) DisplayTitleText="..."  (표시 객체 제목/캡션)
  for (const m of matchAllAttr(xmlString, /\bDisplayTitleText="([^"]*)"/g, 1)) {
    const raw = m.value;
    const text = xmlEntityDecode(raw).trim();
    if (!isTranslatable(text)) continue;
    const id = `u${uid++}`;
    units.push({ id, kind: "title", text });
    edits.push({
      start: m.valueStart,
      end: m.valueEnd,
      build: (tr) => {
        const ko = tr.get(id);
        return ko != null ? xmlAttrEscape(ko) : raw;
      },
    });
  }

  // 3) CSTextEdit ... HTML="..."  (본문 리치텍스트)
  //    raw 속성값 → (XML 디코드) → Qt HTML → 보이는 텍스트 조각들.
  //    각 조각이 독립 unit. 되써넣을 때 한 HTML 블록의 모든 조각 번역을 모아 재조립.
  for (const m of matchAllAttr(xmlString, /<CSTextEdit\b[^>]*?\sHTML="([^"]*)"/g, 1)) {
    const raw = m.value;
    const decodedHtml = xmlEntityDecode(raw);
    const parsed = parseHtmlSegments(decodedHtml);
    if (!parsed.segments.length) continue;

    // 한 HTML 블록 안에서 같은 원문은 한 unit 으로 합침(중복 번역 방지).
    const localIds = new Map(); // 원문 trim → unitId
    for (const seg of parsed.segments) {
      if (localIds.has(seg.text)) continue;
      const id = `u${uid++}`;
      localIds.set(seg.text, id);
      units.push({ id, kind: "html-seg", text: seg.text });
    }
    edits.push({
      start: m.valueStart,
      end: m.valueEnd,
      build: (tr) => {
        // 원문 → 번역 맵 구성(이 블록 한정). 번역 없으면 해당 조각은 원문 유지.
        const byOriginal = new Map();
        for (const [orig, id] of localIds.entries()) {
          const ko = tr.get(id);
          if (ko != null) byOriginal.set(orig, ko);
        }
        if (byOriginal.size === 0) return raw; // 이 블록은 번역 0 → 원본 그대로
        const newHtml = parsed.replace(byOriginal);
        return xmlAttrEscape(newHtml); // XML 속성값으로 재이스케이프
      },
    });
  }

  return {
    units,
    // translations: Map<unitId, 번역문>
    apply(translations) {
      const tr = translations instanceof Map ? translations : new Map(Object.entries(translations || {}));
      // 뒤에서 앞으로 치환(인덱스 보존).
      const ordered = edits.slice().sort((a, b) => b.start - a.start);
      let out = xmlString;
      for (const e of ordered) {
        const replacement = e.build(tr);
        out = out.slice(0, e.start) + replacement + out.slice(e.end);
      }
      return out;
    },
  };
}

// 정규식으로 캡처그룹(속성값)의 시작/끝 인덱스를 함께 돌려주는 헬퍼.
//
// 인덱스는 반드시 `d`(hasIndices) 플래그의 match.indices[groupIndex] 로 계산한다.
// m[0].indexOf(value) 로 오프셋을 구하면, 같은 태그의 앞선 속성(예: Tag)이
// 대상 속성(예: Name)과 값이 같을 때 첫 등장(=앞선 속성) 위치를 잡아 엉뚱한
// 속성 위에 번역을 덮어써 원문을 훼손한다. 캡처그룹의 정확한 범위를 써서
// 반드시 캡처된 속성 위에만 편집이 떨어지게 한다.
function* matchAllAttr(str, regex, groupIndex) {
  // 호출부 정규식에 `d` 플래그가 없을 수 있으므로 보장해서 다시 만든다.
  const re = regex.flags.includes("d")
    ? regex
    : new RegExp(regex.source, regex.flags + "d");
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(str)) !== null) {
    const value = m[groupIndex];
    const span = m.indices && m.indices[groupIndex];
    // indices 는 [start, end] (end = 배타적). 캡처가 비어 span 이 없으면
    // 안전하게 매치 시작으로 폴백한다.
    const valueStart = span ? span[0] : m.index;
    const valueEnd = span ? span[1] : valueStart + String(value ?? "").length;
    yield { value, valueStart, valueEnd };
    if (m.index === re.lastIndex) re.lastIndex++; // 빈 매치 무한루프 방지
  }
}

module.exports = {
  collectTranslationUnits,
  parseHtmlSegments,
  isTranslatable,
  xmlAttrEscape,
  xmlEntityDecode,
};
