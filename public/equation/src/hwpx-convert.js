/*
 * HWPX 안의 LaTeX 수식만 한글(HWP) 수식 개체로 변환 (브라우저/Node 공용)
 *
 * 변환 엔진(LaTeX → 한글 수식 script)은 converter.js(window.LatexToHwp.convert)를 사용한다.
 * 이 모듈은 tools/hwpx_latex_to_hwp.py(파이썬)의 HWPX 처리 로직을 브라우저로 포팅한 것이다:
 *   ZIP 해제(JSZip) → Contents/section*.xml 파싱(DOMParser) → 텍스트 런에서 LaTeX 구간 탐지
 *   → <hp:equation> 개체로 치환 → 다시 ZIP 묶기(mimetype 우선·STORED 보존).
 *
 * 의존성: 전역 JSZip, DOMParser, XMLSerializer, LatexToHwp.convert
 *   (Node 테스트에서는 deps 인자로 주입 가능)
 *
 * ── 출처 표시 / 라이선스 ───────────────────────────────────────────
 * 이 파일은 latex-to-hwp 프로젝트의 파이썬 CLI(tools/hwpx_latex_to_hwp.py)
 * HWPX 처리 로직을 브라우저용으로 포팅한 2차적 저작물입니다.
 *   원저작자: Shin Mingyu (@minigu5)  ·  원본: https://github.com/minigu5/latex-to-hwp
 *   라이선스: Custom License (Non-Commercial & Attribution) — 저장소 LICENSE 참조
 * 본 결합 저작물은 변환 엔진(converter.js)을 포함·파생하므로 전체가 위 조건
 * (출처 표시 + 비영리)의 적용을 받습니다. 자세한 내용은 NOTICE 파일 참조.
 * 변환 규칙 근거: CONVERSION_RULES.md (한컴 공개 명세 revision 1.2 기반).
 */
(function (global) {
  'use strict';

  var HP_NS = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  var HH_NS = 'http://www.hancom.co.kr/hwpml/2011/head';

  // 수식 글자 크기를 본문 대비 키울 값(hpt 단위, 100 = 1pt).
  var EQUATION_SIZE_BUMP_HPT = 100;
  // 수식 글꼴 (한컴 수식 편집기 내부 렌더링 폰트).
  var EQUATION_FONT = 'HancomEQN';

  // ── 의존성 해석 ────────────────────────────────────────────────
  function resolveDeps(deps) {
    deps = deps || {};
    var JSZipLib = deps.JSZip || global.JSZip;
    var DOMParserCls = deps.DOMParser || global.DOMParser;
    var XMLSerializerCls = deps.XMLSerializer || global.XMLSerializer;
    var convert = deps.convert ||
      (global.LatexToHwp && global.LatexToHwp.convert) ||
      (typeof require !== 'undefined' ? safeRequireConverter() : null);
    if (!JSZipLib) throw new Error('JSZip를 찾을 수 없습니다.');
    if (!DOMParserCls) throw new Error('DOMParser를 찾을 수 없습니다.');
    if (!XMLSerializerCls) throw new Error('XMLSerializer를 찾을 수 없습니다.');
    if (typeof convert !== 'function') throw new Error('LatexToHwp.convert를 찾을 수 없습니다.');
    return { JSZip: JSZipLib, DOMParser: DOMParserCls, XMLSerializer: XMLSerializerCls, convert: convert };
  }
  function safeRequireConverter() {
    try { return require('./converter.js').convert; } catch (e) { return null; }
  }

  // ── 스타일 (파이썬 EquationStyle 기본값) ───────────────────────
  function defaultStyle() {
    return { baseUnit: 1000, textColor: '#000000', lineThickness: 100, letterSpacing: 0 };
  }

  // ── header.xml 안의 hh:charPr 목록을 다루는 컨텍스트 ───────────
  //
  // 수식 글자를 본문 대비 +1pt로 키우려면, 원본 텍스트 런의 charPr(글자 크기 등
  // 글자 모양) 을 그대로 복제한 뒤 height 만 +100(=+1pt) 으로 바꾼 새 charPr 를
  // header.xml 에 추가하고, 수식 런이 그 새 charPr 를 가리키도록 charPrIDRef 를
  // 교체해야 한다. 또 수식 자체의 hp:equation/@baseUnit 도 동일 크기로 맞춘다.
  function createHeaderCtx(headerXmlString, DOMParserCls, XMLSerializerCls) {
    if (!headerXmlString) return null;
    var doc;
    try {
      doc = new DOMParserCls().parseFromString(headerXmlString, 'application/xml');
    } catch (e) { return null; }
    var perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) return null;

    var charPropsEl = doc.getElementsByTagNameNS(HH_NS, 'charProperties')[0];
    if (!charPropsEl) return null;

    var charPrEls = doc.getElementsByTagNameNS(HH_NS, 'charPr');
    var byId = Object.create(null);
    var maxId = -1;
    for (var i = 0; i < charPrEls.length; i++) {
      var el = charPrEls[i];
      var idStr = el.getAttribute('id');
      var heightStr = el.getAttribute('height');
      var id = parseInt(idStr, 10);
      var height = parseInt(heightStr, 10);
      if (!isNaN(id)) {
        byId[idStr] = { el: el, height: isNaN(height) ? null : height };
        if (id > maxId) maxId = id;
      }
    }
    if (maxId < 0) return null;

    var nextId = maxId + 1;
    var enlargedCache = Object.create(null); // origId(string) -> newId(string)
    var dirty = false;

    return {
      getHeight: function (origId) {
        return (origId != null && byId[origId]) ? byId[origId].height : null;
      },
      // 원본 charPr 의 +1pt 클론 ID 를 반환. 없으면 새로 만들어 header.xml 에 추가.
      // 원본을 찾지 못하거나 height 가 없으면 null 반환(=원본 유지).
      getEnlargedId: function (origId) {
        if (origId == null) return null;
        if (enlargedCache[origId]) return enlargedCache[origId];
        var orig = byId[origId];
        if (!orig || orig.height == null) return null;

        var cloned = orig.el.cloneNode(true);
        var newIdStr = String(nextId++);
        cloned.setAttribute('id', newIdStr);
        cloned.setAttribute('height', String(orig.height + EQUATION_SIZE_BUMP_HPT));
        charPropsEl.appendChild(cloned);

        var cntAttr = charPropsEl.getAttribute('itemCnt');
        var cnt = parseInt(cntAttr, 10);
        if (!isNaN(cnt)) charPropsEl.setAttribute('itemCnt', String(cnt + 1));

        byId[newIdStr] = { el: cloned, height: orig.height + EQUATION_SIZE_BUMP_HPT };
        enlargedCache[origId] = newIdStr;
        dirty = true;
        return newIdStr;
      },
      isDirty: function () { return dirty; },
      serialize: function () {
        var serialized = new XMLSerializerCls().serializeToString(doc);
        var clean = removeRedundantNsDecls(serialized);
        return ensureXmlDeclaration(clean, headerXmlString);
      }
    };
  }

  // ── ID 생성기 (파이썬 IdGenerator) ─────────────────────────────
  function collectUsedIds(xmlStrings) {
    var used = new Set();
    var re = /\bid="(\d+)"/g;
    for (var i = 0; i < xmlStrings.length; i++) {
      var s = xmlStrings[i], m;
      re.lastIndex = 0;
      while ((m = re.exec(s)) !== null) used.add(m[1]);
    }
    return used;
  }
  function makeIdGenerator(used, start) {
    if (start == null) start = 1000000;
    var next = start - 1;
    used.forEach(function (v) {
      var n = parseInt(v, 10);
      if (!isNaN(n) && /^\d+$/.test(v) && n > next) next = n;
    });
    next += 1;
    return {
      next: function () {
        while (used.has(String(next))) next++;
        var val = String(next);
        used.add(val);
        next++;
        return val;
      }
    };
  }

  // ── LaTeX 구간 탐지 (파이썬 find_latex_spans 등 그대로 포팅) ────
  function isEscaped(text, index) {
    var backslashes = 0, cursor = index - 1;
    while (cursor >= 0 && text[cursor] === '\\') { backslashes++; cursor--; }
    return backslashes % 2 === 1;
  }
  function findUnescapedMarker(text, marker, start) {
    var cursor = start;
    while (true) {
      var index = text.indexOf(marker, cursor);
      if (index < 0) return -1;
      if (!isEscaped(text, index)) return index;
      cursor = index + marker.length;
    }
  }
  function findSingleDollarClose(text, start) {
    var cursor = start;
    while (true) {
      var index = text.indexOf('$', cursor);
      if (index < 0) return -1;
      if (isEscaped(text, index)) { cursor = index + 1; continue; }
      if (index + 1 < text.length && text[index + 1] === '$') { cursor = index + 2; continue; }
      if (index > 0 && text[index - 1] === '$') { cursor = index + 1; continue; }
      return index;
    }
  }
  function shouldConvertDollarBody(body) {
    var value = body.trim();
    if (!value) return false;
    if (/^\d[\d,]*(?:\.\d+)?$/.test(value)) return false;
    if (/\\[A-Za-z]+|[_^{}=<>]|[+\-*\/|]/.test(value)) return true;
    if (/[A-Za-z]\d|\d[A-Za-z]/.test(value)) return true;
    if (/^[A-Za-z]{1,3}$/.test(value)) return true;
    // 글자+프라임 형태의 짧은 수식 (S', x', S'' 등). 상대론의 S′·x′ 관성계처럼
    // 인라인 $S'$ 가 평문으로 남지 않도록 한다. (원본 파이썬 휴리스틱에서 보강)
    if (/^[A-Za-z]{1,3}['′’]+$/.test(value)) return true;
    return false;
  }
  function findLatexSpans(text, stats) {
    var spans = [];
    var cursor = 0, n = text.length;
    while (cursor < n) {
      if (text.startsWith('$$', cursor) && !isEscaped(text, cursor)) {
        var e1 = findUnescapedMarker(text, '$$', cursor + 2);
        if (e1 >= 0 && text.slice(cursor + 2, e1).trim()) {
          spans.push({ start: cursor, end: e1 + 2, raw: text.slice(cursor, e1 + 2) });
          cursor = e1 + 2; continue;
        }
      }
      if (text.startsWith('\\[', cursor) && !isEscaped(text, cursor)) {
        var e2 = findUnescapedMarker(text, '\\]', cursor + 2);
        if (e2 >= 0 && text.slice(cursor + 2, e2).trim()) {
          spans.push({ start: cursor, end: e2 + 2, raw: text.slice(cursor, e2 + 2) });
          cursor = e2 + 2; continue;
        }
      }
      if (text.startsWith('\\(', cursor) && !isEscaped(text, cursor)) {
        var e3 = findUnescapedMarker(text, '\\)', cursor + 2);
        if (e3 >= 0 && text.slice(cursor + 2, e3).trim()) {
          spans.push({ start: cursor, end: e3 + 2, raw: text.slice(cursor, e3 + 2) });
          cursor = e3 + 2; continue;
        }
      }
      if (text[cursor] === '$' && !isEscaped(text, cursor)) {
        if (cursor + 1 < n && text[cursor + 1] === '$') { cursor += 1; continue; }
        var e4 = findSingleDollarClose(text, cursor + 1);
        if (e4 >= 0) {
          var body = text.slice(cursor + 1, e4);
          if (shouldConvertDollarBody(body)) {
            spans.push({ start: cursor, end: e4 + 1, raw: text.slice(cursor, e4 + 1) });
          } else {
            stats.skippedNumericDollars++;
          }
          cursor = e4 + 1; continue;
        }
      }
      cursor += 1;
    }
    return spans;
  }

  // ── DOM 헬퍼 ───────────────────────────────────────────────────
  function elementChildren(node) {
    var out = [];
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1) out.push(c);
    }
    return out;
  }
  function isHp(el, local) {
    return el && el.nodeType === 1 && el.namespaceURI === HP_NS && el.localName === local;
  }
  function isPlainTextRun(el) {
    if (!isHp(el, 'run')) return false;
    var kids = elementChildren(el);
    return kids.length === 1 && isHp(kids[0], 't');
  }
  function runText(run) {
    var t = elementChildren(run)[0];
    return (t && t.textContent) || '';
  }
  function getAttrs(el) {
    var attrs = [];
    var a = el.attributes;
    for (var i = 0; i < a.length; i++) attrs.push({ name: a[i].name, value: a[i].value });
    return attrs;
  }
  function applyAttrs(el, attrs) {
    for (var i = 0; i < attrs.length; i++) el.setAttribute(attrs[i].name, attrs[i].value);
  }

  // ── 개체 생성 (파이썬 make_text_run / make_equation) ───────────
  function makeTextRun(doc, text, attrs) {
    var run = doc.createElementNS(HP_NS, 'hp:run');
    applyAttrs(run, attrs);
    var t = doc.createElementNS(HP_NS, 'hp:t');
    t.appendChild(doc.createTextNode(text));
    run.appendChild(t);
    return run;
  }
  function makeEquation(doc, script, id, style, baseUnitOverride) {
    var baseUnit = (baseUnitOverride != null) ? baseUnitOverride : style.baseUnit;
    var eq = doc.createElementNS(HP_NS, 'hp:equation');
    eq.setAttribute('id', id);
    eq.setAttribute('type', '0');
    eq.setAttribute('textColor', style.textColor);
    eq.setAttribute('baseUnit', String(baseUnit));
    eq.setAttribute('letterSpacing', String(style.letterSpacing));
    eq.setAttribute('lineThickness', String(style.lineThickness));
    eq.setAttribute('baseLine', '0');
    eq.setAttribute('font', EQUATION_FONT);
    eq.setAttribute('lineMode', 'CHAR');
    // version: 한글이 직접 만든 수식엔 늘 붙는 속성. 이게 없으면 수식이
    // "미처리" 상태로 남아, 수식편집기를 한 번 열었다 닫아야 정상 렌더링된다.
    // 네이티브 수식과 동일하게 박아 두면 파일을 열자마자 바로 렌더링된다.
    eq.setAttribute('version', 'Equation Version 60');

    var sz = doc.createElementNS(HP_NS, 'hp:sz');
    sz.setAttribute('width', '0');
    sz.setAttribute('height', '0');
    sz.setAttribute('widthRelTo', 'ABS');
    sz.setAttribute('heightRelTo', 'ABS');
    eq.appendChild(sz);

    var pos = doc.createElementNS(HP_NS, 'hp:pos');
    var posAttrs = [
      ['treatAsChar', '1'], ['affectLSpacing', '0'], ['flowWithText', '0'],
      ['allowOverlap', '0'], ['holdAnchorAndSO', '0'], ['rgroupWithPrevCtrl', '0'],
      ['vertRelTo', 'PARA'], ['horzRelTo', 'PARA'], ['vertAlign', 'TOP'],
      ['horzAlign', 'LEFT'], ['vertOffset', '0'], ['horzOffset', '0']
    ];
    for (var i = 0; i < posAttrs.length; i++) pos.setAttribute(posAttrs[i][0], posAttrs[i][1]);
    eq.appendChild(pos);

    var sc = doc.createElementNS(HP_NS, 'hp:script');
    sc.appendChild(doc.createTextNode((script || '').trim()));
    eq.appendChild(sc);
    return eq;
  }
  function makeEquationRun(doc, script, id, attrs, style, baseUnitOverride) {
    var run = doc.createElementNS(HP_NS, 'hp:run');
    applyAttrs(run, attrs);
    run.appendChild(makeEquation(doc, script, id, style, baseUnitOverride));
    return run;
  }

  // 런 속성 목록에서 charPrIDRef 값을 찾는다.
  function findCharPrIDRef(attrs) {
    for (var i = 0; i < attrs.length; i++) {
      if (attrs[i].name === 'charPrIDRef') return attrs[i].value;
    }
    return null;
  }
  // 런 속성 목록을 복제하면서 charPrIDRef 값을 교체한다. 원본 배열은 건드리지 않는다.
  function withCharPrIDRef(attrs, newRef) {
    var found = false;
    var out = attrs.map(function (a) {
      if (a.name === 'charPrIDRef') { found = true; return { name: a.name, value: newRef }; }
      return { name: a.name, value: a.value };
    });
    if (!found) out.push({ name: 'charPrIDRef', value: newRef });
    return out;
  }

  // ── 런 그룹 내 LaTeX 치환 (파이썬 replace_latex_in_run_group) ──
  function buildTextRunSpans(runs) {
    var spans = [], pos = 0;
    for (var i = 0; i < runs.length; i++) {
      var text = runText(runs[i]);
      spans.push({ run: runs[i], text: text, start: pos, end: pos + text.length });
      pos += text.length;
    }
    return spans;
  }
  function attrsAtPosition(spans, pos) {
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.start <= pos && pos < s.end) return getAttrs(s.run);
      if (pos === s.start) return getAttrs(s.run);
    }
    if (spans.length) return getAttrs(spans[spans.length - 1].run);
    return [];
  }
  function textSliceToRuns(doc, spans, start, end) {
    var result = [];
    if (start >= end) return result;
    for (var i = 0; i < spans.length; i++) {
      var s = spans[i];
      var overlapStart = Math.max(start, s.start);
      var overlapEnd = Math.min(end, s.end);
      if (overlapStart >= overlapEnd) continue;
      var text = s.text.slice(overlapStart - s.start, overlapEnd - s.start);
      if (text) result.push(makeTextRun(doc, text, getAttrs(s.run)));
    }
    return result;
  }
  function replaceLatexInRunGroup(doc, runs, idGen, convert, style, stats, headerCtx) {
    var spans = buildTextRunSpans(runs);
    var text = spans.map(function (s) { return s.text; }).join('');
    var latexSpans = findLatexSpans(text, stats);
    if (!latexSpans.length) return { newRuns: null, count: 0 };

    var result = [];
    var cursor = 0;
    for (var i = 0; i < latexSpans.length; i++) {
      var ls = latexSpans[i];
      pushAll(result, textSliceToRuns(doc, spans, cursor, ls.start));
      var runAttrs = attrsAtPosition(spans, ls.start);
      var script = convert(ls.raw);

      // 수식 런 크기 보정: 원본 텍스트의 글자 크기(charPr.height, hpt 단위)를
      // 찾아내 +1pt 클론을 만들고 charPrIDRef 를 그쪽으로 돌린다.
      // 동시에 hp:equation/@baseUnit 을 같은 크기로 설정해 수식 내부 렌더링도
      // 함께 키운다. header.xml 정보가 없거나 매칭이 실패하면 원본 그대로 둔다.
      var eqAttrs = runAttrs;
      var eqBaseUnit = null;
      if (headerCtx) {
        var origCharPrId = findCharPrIDRef(runAttrs);
        var origHeight = headerCtx.getHeight(origCharPrId);
        var newCharPrId = headerCtx.getEnlargedId(origCharPrId);
        if (newCharPrId) eqAttrs = withCharPrIDRef(runAttrs, newCharPrId);
        if (origHeight != null) eqBaseUnit = origHeight + EQUATION_SIZE_BUMP_HPT;
      }
      result.push(makeEquationRun(doc, script, idGen.next(), eqAttrs, style, eqBaseUnit));
      cursor = ls.end;
    }
    pushAll(result, textSliceToRuns(doc, spans, cursor, text.length));
    return { newRuns: result, count: latexSpans.length };
  }
  function pushAll(arr, items) { for (var i = 0; i < items.length; i++) arr.push(items[i]); }

  // ── 섹션 1개 처리 ──────────────────────────────────────────────
  function processSectionXml(xmlString, idGen, convert, style, stats, DOMParserCls, XMLSerializerCls, headerCtx) {
    if (xmlString.indexOf('$') < 0 && xmlString.indexOf('\\(') < 0 && xmlString.indexOf('\\[') < 0) {
      return { xml: xmlString, changed: false };
    }
    var doc = new DOMParserCls().parseFromString(xmlString, 'application/xml');
    var perr = doc.getElementsByTagName('parsererror');
    if (perr && perr.length) throw new Error('section XML 파싱 실패');

    var paras = doc.getElementsByTagNameNS(HP_NS, 'p');
    var total = 0;
    for (var pi = 0; pi < paras.length; pi++) {
      var para = paras[pi];
      var children = elementChildren(para);
      var pending = []; // {nodes:[...], newRuns:[...]}
      var idx = 0;
      while (idx < children.length) {
        if (!isPlainTextRun(children[idx])) { idx++; continue; }
        var group = [];
        while (idx < children.length && isPlainTextRun(children[idx])) { group.push(children[idx]); idx++; }
        var groupText = group.map(runText).join('');
        if (groupText.indexOf('$') < 0 && groupText.indexOf('\\(') < 0 && groupText.indexOf('\\[') < 0) continue;
        var res = replaceLatexInRunGroup(doc, group, idGen, convert, style, stats, headerCtx);
        if (res.count) pending.push({ nodes: group, newRuns: res.newRuns, count: res.count });
      }
      for (var g = 0; g < pending.length; g++) {
        var item = pending[g];
        var firstNode = item.nodes[0];
        var parent = firstNode.parentNode;
        for (var r = 0; r < item.newRuns.length; r++) parent.insertBefore(item.newRuns[r], firstNode);
        for (var d = 0; d < item.nodes.length; d++) parent.removeChild(item.nodes[d]);
        total += item.count;
      }
      // 텍스트를 수정한 단락의 라인 레이아웃 캐시(hp:linesegarray)는 무효해진다.
      // 그대로 두면 한글이 "복구하였습니다" 경고를 띄우므로, 변경된 단락의 직속
      // 자식 linesegarray만 제거한다. (중첩된 표 안 단락은 따로 처리.)
      // linesegarray는 한글이 다시 열 때 자동 재생성되는 optional 요소다.
      if (pending.length > 0) {
        var paraKids = elementChildren(para);
        for (var ki = 0; ki < paraKids.length; ki++) {
          if (isHp(paraKids[ki], 'linesegarray')) para.removeChild(paraKids[ki]);
        }
      }
    }
    if (total === 0) return { xml: xmlString, changed: false };
    stats.equations += total;

    var serialized = new XMLSerializerCls().serializeToString(doc);
    var clean = removeRedundantNsDecls(serialized);
    return { xml: ensureXmlDeclaration(clean, xmlString), changed: true };
  }

  // XMLSerializer가 새로 생성된 요소마다 인라인으로 중복 삽입하는 xmlns 선언을 제거한다.
  // 한글 파서는 이를 손상된 구조로 인식해 복구 경고를 띄운다.
  function removeRedundantNsDecls(xml) {
    var seen = Object.create(null);
    return xml.replace(/ xmlns(?::[a-zA-Z0-9_-]+)?="[^"]*"/g, function (match) {
      if (seen[match]) return '';
      seen[match] = true;
      return match;
    });
  }

  function ensureXmlDeclaration(serialized, original) {
    if (/^﻿?\s*<\?xml/i.test(serialized)) return serialized;
    var decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    var m = original.match(/^﻿?\s*(<\?xml[^>]*\?>)/i);
    if (m) decl = m[1] + '\n';
    return decl + serialized;
  }

  // ── 섹션 파일 이름 (파이썬 find_section_files) ─────────────────
  function findSectionNames(zip) {
    var names = Object.keys(zip.files).filter(function (n) {
      return !zip.files[n].dir &&
        n.indexOf('Contents/section') === 0 &&
        n.slice(-4) === '.xml';
    });
    names.sort();
    return names;
  }

  // ── ZIP 재구성 (mimetype 우선·STORED 보존) ─────────────────────
  function rebuildZip(JSZipLib, originalZip, updates) {
    var out = new JSZipLib();
    var names = Object.keys(originalZip.files).filter(function (n) { return !originalZip.files[n].dir; });

    // 삽입 순서를 mimetype 우선으로 고정 (HWPX/OCF 규약: mimetype은 첫 항목·비압축).
    var ordered = [];
    if (names.indexOf('mimetype') !== -1) ordered.push('mimetype');
    for (var i = 0; i < names.length; i++) {
      if (names[i] !== 'mimetype') ordered.push(names[i]);
    }

    // 내용은 병렬로 먼저 모두 읽고, out.file() 호출은 정해진 순서대로 '동기' 실행한다.
    // (비동기 읽기 완료 순서에 따라 삽입 순서가 흐트러지는 것을 방지)
    return Promise.all(ordered.map(function (name) {
      if (Object.prototype.hasOwnProperty.call(updates, name)) {
        return Promise.resolve([name, updates[name]]); // 수정된 XML 문자열
      }
      return originalZip.file(name).async('uint8array').then(function (data) { return [name, data]; });
    })).then(function (entries) {
      var contentByName = {};
      entries.forEach(function (e) { contentByName[e[0]] = e[1]; });
      ordered.forEach(function (name) {
        var opts = name === 'mimetype'
          ? { compression: 'STORE', createFolders: false }
          : { compression: 'DEFLATE', createFolders: false };
        out.file(name, contentByName[name], opts);
      });
      return out;
    });
  }

  // ── 메인 진입점 ────────────────────────────────────────────────
  function convertArrayBuffer(arrayBuffer, deps) {
    var d = resolveDeps(deps);
    var stats = { equations: 0, sectionsChanged: 0, skippedNumericDollars: 0 };
    var style = defaultStyle();
    return d.JSZip.loadAsync(arrayBuffer).then(function (zip) {
      var sectionNames = findSectionNames(zip);
      if (!sectionNames.length) {
        throw new Error('Contents/section*.xml 을 찾지 못했습니다. 올바른 HWPX 파일이 맞나요?');
      }
      // 섹션과 함께 header.xml 도 읽어 들인다. header.xml 은 hh:charPr 글자 모양
      // 정의를 담고 있어, 수식 런이 본문 대비 +1pt 가 되도록 클론 charPr 를
      // 추가하는 데 필요하다. 파일이 없으면 헤더 보정 없이 진행한다.
      var headerName = 'Contents/header.xml';
      var headerPromise = zip.file(headerName)
        ? zip.file(headerName).async('string')
        : Promise.resolve(null);

      return Promise.all([
        Promise.all(sectionNames.map(function (n) {
          return zip.file(n).async('string').then(function (s) { return [n, s]; });
        })),
        headerPromise
      ]).then(function (results) {
        var pairs = results[0];
        var headerXmlStr = results[1];

        var sectionXml = {};
        pairs.forEach(function (p) { sectionXml[p[0]] = p[1]; });

        var headerCtx = createHeaderCtx(headerXmlStr, d.DOMParser, d.XMLSerializer);

        var idGen = makeIdGenerator(collectUsedIds(Object.keys(sectionXml).map(function (k) { return sectionXml[k]; })));
        var updates = {};
        sectionNames.forEach(function (n) {
          var res = processSectionXml(sectionXml[n], idGen, d.convert, style, stats, d.DOMParser, d.XMLSerializer, headerCtx);
          if (res.changed) { updates[n] = res.xml; stats.sectionsChanged++; }
        });

        if (headerCtx && headerCtx.isDirty()) updates[headerName] = headerCtx.serialize();

        return rebuildZip(d.JSZip, zip, updates).then(function (outZip) {
          return outZip.generateAsync({ type: 'blob', mimeType: 'application/octet-stream' })
            .catch(function () { return outZip.generateAsync({ type: 'uint8array' }); })
            .then(function (blob) { return { blob: blob, stats: stats }; });
        });
      });
    });
  }

  function makeOutputName(name) {
    if (!name) return 'output_hwp_equations.hwpx';
    var dot = name.lastIndexOf('.');
    var stem = dot >= 0 ? name.slice(0, dot) : name;
    var ext = dot >= 0 ? name.slice(dot) : '.hwpx';
    return stem + '_hwp_equations' + ext;
  }

  function convertFile(file, deps) {
    return file.arrayBuffer().then(function (buf) {
      return convertArrayBuffer(buf, deps).then(function (out) {
        return { blob: out.blob, stats: out.stats, filename: makeOutputName(file.name) };
      });
    });
  }

  var api = {
    convertFile: convertFile,
    convertArrayBuffer: convertArrayBuffer,
    makeOutputName: makeOutputName,
    // 내부 함수 일부 노출(테스트용)
    _internal: {
      findLatexSpans: findLatexSpans,
      shouldConvertDollarBody: shouldConvertDollarBody,
      makeIdGenerator: makeIdGenerator,
      collectUsedIds: collectUsedIds
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.HwpxConvert = api;
})(typeof window !== 'undefined' ? window : globalThis);
