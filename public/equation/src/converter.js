/*
 * LaTeX → 한글(HWP) 수식 편집기 문법 변환기
 * 
 * Copyright (c) 2026 Shin Mingyu
 * Licensed under Custom License (Non-Commercial & Attribution).
 * See LICENSE file for details.
 *
 * 변환 규칙의 근거는 CONVERSION_RULES.md (한컴 공식 명세 revision 1.2 기반)를 참고.
 * 브라우저(<script src>로 window.LatexToHwp)와 Node(require) 양쪽에서 동작한다.
 */
(function (global) {
  'use strict';

  // ── 매핑 테이블 ────────────────────────────────────────────────

  // 그리스 문자: LaTeX 이름 == 한글 이름 (백슬래시만 제거)
  var GREEK = new Set([
    'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta',
    'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron',
    'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'varupsilon',
    'phi', 'varphi', 'chi', 'psi', 'omega',
    'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon',
    'Phi', 'Psi', 'Omega', 'Alpha', 'Beta', 'Epsilon', 'Zeta', 'Eta', 'Iota',
    'Kappa', 'Mu', 'Nu', 'Omicron', 'Rho', 'Tau', 'Chi'
  ]);

  // 자동 로만체 함수 / 예약어 (이름 그대로)
  var FUNCTIONS = new Set([
    'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'coth',
    'ln', 'log', 'lg', 'lim', 'Lim', 'max', 'min', 'exp', 'Exp', 'det', 'gcd',
    'mod', 'arcsin', 'arccos', 'arctan', 'arg', 'deg', 'dim', 'ker', 'hom', 'Pr'
  ]);

  // 연산/관계/집합/화살표/기타 기호 매핑
  var SYMBOLS = {
    times: 'times', div: 'div', pm: 'plusminus', mp: 'minusplus', cdot: 'cdot',
    le: 'leq', leq: 'leq', ge: 'geq', geq: 'geq', ne: 'neq', neq: 'neq',
    equiv: 'equiv', approx: 'approx', sim: 'sim', simeq: 'simeq', cong: 'cong',
    propto: 'propto', doteq: 'doteq', prec: 'prec', succ: 'succ', ll: '<<', gg: '>>', lll: 'LLL', ggg: '>>>',
    asymp: 'ASYMP',
    in: '` IN `', ni: 'owns', notin: 'notin', subset: 'subset', supset: 'supset',
    subseteq: 'subseteq', supseteq: 'supseteq', cup: 'union', cap: 'inter',
    bigcup: 'union', bigcap: 'inter', sqcap: 'sqcap', sqcup: 'sqcup',
    sqsubset: 'SQSUBSET', sqsupset: 'SQSUPSET', sqsubseteq: 'SQSUBSETEQ', sqsupseteq: 'SQSUPSETEQ',
    emptyset: 'emptyset', varnothing: 'emptyset', aleph: 'aleph', uplus: 'uplus',
    coprod: 'COPROD',
    oplus: 'oplus', ominus: 'ominus', otimes: 'otimes', odot: 'odot', oslash: 'oslash',
    vee: 'vee', lor: 'vee', wedge: 'wedge', land: 'wedge', circ: 'circ', bullet: 'bullet',
    ast: 'ast', star: 'star', infty: 'inf', partial: 'partial', forall: 'forall',
    exists: 'exist', therefore: 'therefore', because: 'because',
    diamond: 'diamond', triangledown: 'TRIANGLED',
    degree: 'DEG', AA: 'ANGSTROM',
    Im: 'IMAG', Re: 'REIMAGE',
    imath: 'IMATH', jmath: 'JMATH', ell: 'ELL', wp: 'WP',
    cdots: 'cdots', ldots: 'ldots', dots: 'ldots', vdots: 'vdots', ddots: 'ddots',
    angle: 'angle', triangle: 'triangle', dagger: 'dagger', ddagger: 'ddagger',
    lnot: 'lnot', neg: 'lnot', top: 'top', bot: 'bot', perp: 'bot', models: 'models',
    vdash: 'vdash', prime: 'prime', nabla: 'nabla', hbar: 'hbar',
    iint: 'dint', iiint: 'tint', iiiint: 'qint',
    // 화살표
    leftarrow: 'larrow', gets: 'larrow', rightarrow: 'rarrow', to: 'rarrow',
    uparrow: 'uparrow', downarrow: 'downarrow', leftrightarrow: 'lrarrow',
    updownarrow: 'udarrow', Leftarrow: 'LARROW', Rightarrow: 'RARROW',
    Uparrow: 'UPARROW', Downarrow: 'DOWNARROW', Leftrightarrow: 'LRARROW',
    Updownarrow: 'UDARROW', mapsto: 'mapsto',
    nwarrow: 'nwarrow', nearrow: 'nearrow', swarrow: 'swarrow', searrow: 'searrow',
    hookleftarrow: 'hookleft', hookrightarrow: 'hookright',
    // Long arrows
    longleftarrow: 'larrow', longrightarrow: 'rarrow', longleftrightarrow: 'lrarrow',
    Longleftarrow: 'LARROW', Longrightarrow: 'RARROW', Longleftrightarrow: 'LRARROW',
    // Shorthand (common in AI outputs)
    larr: 'larrow', rarr: 'rarrow', uarr: 'uparrow', darr: 'downarrow', harr: 'lrarrow',
    Larr: 'LARROW', Rarr: '` RARROW ``', Uarr: 'UPARROW', Darr: 'DOWNARROW', Harr: 'LRARROW'
  };

  // 글자 장식 (accent) → 한글 명령
  var ACCENTS = {
    hat: 'hat', widehat: 'hat', check: 'check', tilde: 'tilde', widetilde: 'tilde',
    acute: 'acute', grave: 'grave', dot: 'dot', ddot: 'ddot', bar: 'bar',
    overline: 'bar', vec: 'vec', underline: 'under', overrightarrow: 'dyad'
  };

  // 공백 명령 → 한글 빈칸 (` = 1/4칸, ~ = 정상칸)
  var SPACING = {
    ',': '`', ':': '~', ';': '~', '!': '', ' ': '~', quad: '~', qquad: '~~'
  };

  // 행렬 환경 → 한글 명령
  var MATRIX_ENV = {
    matrix: 'matrix', pmatrix: 'pmatrix', bmatrix: 'bmatrix', Bmatrix: 'matrix',
    vmatrix: 'dmatrix', Vmatrix: 'dmatrix', smallmatrix: 'matrix'
  };

  // 좁은 공백(`)으로 감쌀 이항 연산자
  var WRAP_OPS = new Set(['+', '-', '=', '<', '>']);

  // ── 토크나이저 ─────────────────────────────────────────────────

  function tokenize(input) {
    var tokens = [];
    var i = 0;
    var n = input.length;
    while (i < n) {
      var c = input[i];
      if (c === '\\') {
        var j = i + 1;
        if (j < n && /[a-zA-Z]/.test(input[j])) {
          while (j < n && /[a-zA-Z]/.test(input[j])) j++;
          tokens.push({ type: 'cmd', value: input.slice(i + 1, j) });
          i = j;
        } else {
          // \\ , \{ , \} , \, , \; , \! , (백슬래시+공백) 등
          tokens.push({ type: 'cmd', value: j < n ? input[j] : '' });
          i = j + 1;
        }
      } else if (c === '{' || c === '}' || c === '_' || c === '^' || c === '&') {
        tokens.push({ type: 'ctrl', value: c });
        i++;
      } else if (/\s/.test(c)) {
        tokens.push({ type: 'space', value: ' ' });
        i++;
      } else if (/[0-9]/.test(c)) {
        // 여러 자리 숫자는 하나의 항으로 묶는다 ({24}, {12} 등)
        var k = i;
        while (k < n && /[0-9.]/.test(input[k])) k++;
        tokens.push({ type: 'char', value: input.slice(i, k) });
        i = k;
      } else if (/[^\x00-\x7F]/.test(c)) {
        // 한글 등 non-ASCII 문자는 최대한 묶어서 하나의 항으로 처리
        var m = i;
        while (m < n && /[^\x00-\x7F]/.test(input[m])) m++;
        tokens.push({ type: 'text', value: input.slice(i, m) });
        i = m;
      } else {
        tokens.push({ type: 'char', value: c });
        i++;
      }
    }
    return tokens;
  }

  // ── 파서 ───────────────────────────────────────────────────────

  function peek(tokens, pos) { return tokens[pos.i]; }

  function skipSpaces(tokens, pos) {
    while (pos.i < tokens.length && tokens[pos.i].type === 'space') pos.i++;
  }

  // 항들을 순서대로 변환해 공백으로 잇는다.
  // (한글 수식에서 공백은 '항 구분'이며 반복/여분 공백은 화면에 안 나타난다.)
  function parseSeq(tokens, pos, stop) {
    var parts = [];
    while (pos.i < tokens.length) {
      var t = tokens[pos.i];
      if (t.type === 'ctrl' && t.value === '}') break;
      if (stop && stop(t)) break;
      var atom = parseAtom(tokens, pos);
      if (atom === null) continue;
      var s = attachScripts(atom.text, tokens, pos);
      if (s !== '') parts.push(s);
    }
    return parts.join(' ');
  }

  // 위/아래 첨자 직전 항에 붙인다. 항상 앞에 공백을 둔다(골든 예시 관례).
  function attachScripts(text, tokens, pos) {
    while (pos.i < tokens.length) {
      var t = tokens[pos.i];
      if (t.type === 'ctrl' && (t.value === '_' || t.value === '^')) {
        pos.i++;
        var arg = readArg(tokens, pos);
        text += ' ' + t.value + '{' + arg + '}';
      } else {
        break;
      }
    }
    return text;
  }

  // 인자 하나 읽기: { ... } 그룹이면 내부, 아니면 단일 항.
  function readArg(tokens, pos) {
    skipSpaces(tokens, pos);
    var t = peek(tokens, pos);
    if (!t) return '';
    if (t.type === 'ctrl' && t.value === '{') {
      pos.i++;
      var inner = parseSeq(tokens, pos, null);
      var c = peek(tokens, pos);
      if (c && c.type === 'ctrl' && c.value === '}') pos.i++;
      return inner;
    }
    var atom = parseAtom(tokens, pos);
    return atom === null ? '' : atom.text;
  }

  // { ... } 안의 글자를 공백 없이 그대로 잇는다 (환경 이름 등에 사용).
  function readRawName(tokens, pos) {
    skipSpaces(tokens, pos);
    var t = peek(tokens, pos);
    if (!t || !(t.type === 'ctrl' && t.value === '{')) return '';
    pos.i++;
    var name = '';
    while (pos.i < tokens.length) {
      var tk = tokens[pos.i];
      if (tk.type === 'ctrl' && tk.value === '}') { pos.i++; break; }
      if (tk.type === 'char' || tk.type === 'cmd' || tk.type === 'text') name += tk.value;
      pos.i++;
    }
    return name;
  }

  function readDelim(tokens, pos) {
    skipSpaces(tokens, pos);
    var t = peek(tokens, pos);
    if (!t) return '';
    pos.i++;
    if (t.type === 'char' || t.type === 'text') {
      return t.value; // ( ) [ ] | 등. '.'(빈 구분자)도 그대로 보존해 LEFT./RIGHT. 출력
    }
    if (t.type === 'cmd') {
      var m = {
        '{': '{', '}': '}', lbrace: '{', rbrace: '}',
        langle: '<', rangle: '>', lfloor: '[', rfloor: ']',
        lceil: '[', rceil: ']', vert: '|', Vert: 'VERT',
        lvert: '|', rvert: '|', lVert: 'VERT', rVert: 'VERT'
      };
      return m.hasOwnProperty(t.value) ? m[t.value] : t.value;
    }
    return '';
  }

  // left/right 뒤 구분자. vert(|·VERT)는 키워드에 붙으면 한글이 인식하지 못하므로
  // 공백으로 분리한다. 괄호류·빈 구분자(.)는 키워드에 바로 붙인다.
  function leftRightDelim(tokens, pos) {
    var d = readDelim(tokens, pos);
    if (d === '|' || d === 'VERT') return ' ' + d;
    return d;
  }

  // 단일 항 변환. {text, keyword} 또는 null(공백) 반환.
  function parseAtom(tokens, pos) {
    var t = tokens[pos.i];
    if (!t) return null;

    if (t.type === 'space') { pos.i++; return null; }

    if (t.type === 'ctrl') {
      if (t.value === '{') {
        pos.i++;
        var inner = parseSeq(tokens, pos, null);
        var c = peek(tokens, pos);
        if (c && c.type === 'ctrl' && c.value === '}') pos.i++;
        return { text: '{' + inner + '}', keyword: false };
      }
      if (t.value === '}') { pos.i++; return null; } // 짝 없는 } 무시
      if (t.value === '&') { pos.i++; return { text: '&', keyword: false }; }
      // 짝 없는 _ ^ → 글자로
      pos.i++;
      return { text: t.value, keyword: false };
    }

    if (t.type === 'char') {
      pos.i++;
      if (WRAP_OPS.has(t.value)) return { text: '`' + t.value + '`', keyword: false };
      return { text: t.value, keyword: false };
    }

    if (t.type === 'text') {
      pos.i++;
      // 한글 등 텍스트는 따옴표로 감싸서 한 항으로 유지
      return { text: '"' + t.value + '"', keyword: false };
    }

    // cmd
    pos.i++;
    return convertCmd(t.value, tokens, pos);
  }

  function convertCmd(name, tokens, pos) {
    // 줄바꿈
    if (name === '\\') return { text: '#', keyword: false };

    // 공백 명령
    if (SPACING.hasOwnProperty(name)) return { text: SPACING[name], keyword: false };

    // 분수
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac' || name === 'fras') {
      var a = readArg(tokens, pos);
      var b = readArg(tokens, pos);
      return { text: '{' + a + '} over {' + b + '}', keyword: false };
    }

    // substack support (mapping to matrix in HWP)
    if (name === 'substack') {
      var content = readArg(tokens, pos);
      // Remove outer braces if added by readArg
      if (content.startsWith('{') && content.endsWith('}')) {
        content = content.slice(1, -1);
      }
      return { text: 'matrix{' + content + '}', keyword: false };
    }

    // underbrace / overbrace — 한글 문법은 라벨을 앞, 본문을 뒤에 둔다.
    //   \underbrace{본문}_{라벨} → UNDERBRACE {라벨} {본문}
    //   \overbrace{본문}^{라벨}  → OVERBRACE {라벨} {본문}
    if (name === 'underbrace' || name === 'overbrace') {
      var ubBody = readArg(tokens, pos);
      skipSpaces(tokens, pos);
      var ubLabel = '';
      var ubT = peek(tokens, pos);
      if (ubT && ubT.type === 'ctrl' && (ubT.value === '_' || ubT.value === '^')) {
        pos.i++;
        ubLabel = readArg(tokens, pos);
      }
      var ubKw = (name === 'underbrace') ? 'UNDERBRACE' : 'OVERBRACE';
      if (ubLabel !== '') return { text: ubKw + ' {' + ubLabel + '} {' + ubBody + '}', keyword: false };
      return { text: ubKw + ' {' + ubBody + '}', keyword: false };
    }

    // overset / underset / stackrel
    if (name === 'overset' || name === 'stackrel' || name === 'underset') {
      var top = (name === 'underset') ? '' : readArg(tokens, pos);
      var bot = (name === 'underset') ? readArg(tokens, pos) : '';
      var base = readArg(tokens, pos);

      // Specific mapping requested by user: \overset{!}{=} -> !=
      if (name === 'overset' && top.trim() === '!' && (base.trim() === '`=`' || base.trim() === '=')) {
        return { text: '!=', keyword: false };
      }

      var cleanBase = base.replace(/[{}]/g, '').trim();
      var arrowMap = {
        'larrow': 'larrow', 'rarrow': 'rarrow', 'lrarrow': 'lrarrow',
        'LARROW': 'LARROW', 'RARROW': 'RARROW', 'LRARROW': 'LRARROW',
        'udarrow': 'udarrow', 'UDARROW': 'UDARROW', 'exarrow': 'EXARROW', 'EXARROW': 'EXARROW'
      };

      if (arrowMap.hasOwnProperty(cleanBase)) {
        var topArg = (name === 'underset') ? '{}' : '{' + top + '}';
        var botArg = (name === 'underset') ? '{' + bot + '}' : '{}';
        return { text: 'REL ' + arrowMap[cleanBase] + ' ' + topArg + ' ' + botArg, keyword: false };
      }

      if (name === 'underset') {
        // If base is a function like lim, use script notation
        if (base.trim().match(/^(lim|Lim|sum|prod|int|max|min)$/)) {
          return { text: base + ' _{' + bot + '}', keyword: false };
        }
        return { text: 'REL ' + base + ' {} {' + bot + '}', keyword: false };
      }
      return { text: 'REL ' + base + ' {' + top + '} {}', keyword: false };
    }

    // xarrow support
    if (name === 'xrightarrow' || name === 'xleftarrow' || name === 'xRightarrow' || 
        name === 'xLeftarrow' || name === 'xleftrightarrow' || name === 'xLeftrightarrow' ||
        name === 'xmapsto') {
      var bot = '';
      var c = peek(tokens, pos);
      if (c && c.type === 'char' && c.value === '[') {
        pos.i++;
        bot = parseSeq(tokens, pos, function (tk) {
          return tk.type === 'char' && tk.value === ']';
        });
        if (peek(tokens, pos) && peek(tokens, pos).value === ']') pos.i++;
      }
      var top = readArg(tokens, pos);
      var arrowMap = {
        xrightarrow: 'rarrow', xleftarrow: 'larrow', xRightarrow: 'RARROW',
        xLeftarrow: 'LARROW', xleftrightarrow: 'lrarrow', xLeftrightarrow: 'LRARROW',
        xmapsto: 'mapsto'
      };
      var hwpArrow = arrowMap[name] || 'rarrow';
      return { text: 'REL ' + hwpArrow + ' {' + top + '} {' + bot + '}', keyword: false };
    }

    // 이항계수 / 조합
    if (name === 'binom' || name === 'dbinom' || name === 'tbinom') {
      var top = readArg(tokens, pos);
      var bot = readArg(tokens, pos);
      return { text: '{' + top + '} CHOOSE {' + bot + '}', keyword: false };
    }

    // 제곱근 / n제곱근
    if (name === 'sqrt') {
      skipSpaces(tokens, pos);
      var nth = null;
      var c = peek(tokens, pos);
      if (c && c.type === 'char' && c.value === '[') {
        pos.i++; // [
        nth = parseSeq(tokens, pos, function (tk) {
          return tk.type === 'char' && tk.value === ']';
        });
        var close = peek(tokens, pos);
        if (close && close.type === 'char' && close.value === ']') pos.i++;
      }
      var rad = readArg(tokens, pos);
      if (nth) return { text: '^{' + nth + '} sqrt {' + rad + '}', keyword: false };
      return { text: 'sqrt {' + rad + '}', keyword: false };
    }

    // 큰 괄호 — 정책: LEFT( ... RIGHT) (한글 명세 권장, CONVERSION_RULES.md 4절)
    if (name === 'left') return { text: 'LEFT' + leftRightDelim(tokens, pos), keyword: false };
    if (name === 'right') return { text: 'RIGHT' + leftRightDelim(tokens, pos), keyword: false };
    if (name === 'bigl' || name === 'bigr' || name === 'Bigl' || name === 'Bigr' ||
        name === 'biggl' || name === 'biggr' || name === 'Biggl' || name === 'Biggr') {
      return { text: readDelim(tokens, pos), keyword: false };
    }

    // 환경 (행렬, cases 등)
    if (name === 'begin') return parseEnvironment(tokens, pos);
    if (name === 'end') { readRawName(tokens, pos); return null; }

    // 글자 장식
    if (ACCENTS.hasOwnProperty(name)) {
      var arg = readArg(tokens, pos);
      return { text: ACCENTS[name] + ' {' + arg + '}', keyword: false };
    }

    // 로만/볼드/기타 폰트
    if (name === 'mathrm' || name === 'text' || name === 'textrm' || name === 'operatorname') {
      return { text: readArg(tokens, pos), keyword: true };
    }
    if (name === 'mathbf' || name === 'boldsymbol' || name === 'bold' || name === 'textbf') {
      return { text: 'bold ' + readArg(tokens, pos), keyword: true };
    }
    // 캘리그래픽/이중선체(blackboard)/필기체/세리프 등 — 한글 수식엔 전용 글꼴이
    // 없으므로(rm/it/bold/scale만 지원) 글꼴 장식은 버리고 글자(인자)만 남긴다.
    // 이렇게 하지 않으면 mathcal/mathbb 등 키워드가 그대로 노출돼 한글에서 깨진다.
    if (name === 'mathcal' || name === 'mathbb' || name === 'mathscr' ||
        name === 'mathfrak' || name === 'mathsf' || name === 'mathtt' ||
        name === 'mathit' || name === 'mathnormal') {
      return { text: readArg(tokens, pos), keyword: true };
    }

    // Ignore structural formatting commands in HWP
    if (name === 'hline' || name === 'vline') return null;

    if (name === 'not') return { text: 'not', keyword: true };
    if (name === 'over') return { text: 'over', keyword: true };
    if (name === 'atop') return { text: 'atop', keyword: true };

    // 함수 / 그리스 / 기호
    if (FUNCTIONS.has(name)) return { text: name, keyword: true };
    if (GREEK.has(name)) return { text: name, keyword: true };
    if (SYMBOLS.hasOwnProperty(name)) return { text: SYMBOLS[name], keyword: true };

    // 미확인 명령: 이름을 보존 (임의로 버리지 않음)
    return { text: name, keyword: true, unknown: true };
  }

  function parseEnvironment(tokens, pos) {
    var env = readRawName(tokens, pos); // 환경 이름
    if (env === 'array') readArg(tokens, pos); // 열 정렬 스펙 {ccc} 소비
    var content = parseSeq(tokens, pos, function (t) {
      return t.type === 'cmd' && t.value === 'end';
    });
    // \end{...} 소비
    var e = peek(tokens, pos);
    if (e && e.type === 'cmd' && e.value === 'end') { pos.i++; readRawName(tokens, pos); }

    // HWP matrix doesn't support | or lines, so we clean them
    content = content.replace(/\|/g, '').trim();

    if (MATRIX_ENV.hasOwnProperty(env) || env === 'array') {
      var mType = MATRIX_ENV[env] || 'matrix';
      return { text: mType + '{ ' + content + ' }', keyword: false };
    }
    if (env === 'cases') {
      return { text: 'cases{ ' + content + ' }', keyword: false };
    }
    // align / aligned / equation / split 등은 내용만 (정렬 & 는 그대로 둠)
    return { text: content, keyword: false };
  }

  // ── 진입점 ─────────────────────────────────────────────────────

  function stripDelimiters(s) {
    s = s.trim();
    // 전역적으로 모든 구분자 제거 (텍스트 중간에 섞인 경우 대응)
    s = s.replace(/\$\$/g, '');
    s = s.replace(/\$/g, '');
    s = s.replace(/\\\[/g, '');
    s = s.replace(/\\\]/g, '');
    s = s.replace(/\\\( /g, ''); // 뒤에 공백이 있을 수 있음
    s = s.replace(/\\\) /g, '');
    s = s.replace(/\\\(/g, '');
    s = s.replace(/\\\)/g, '');
    return s.trim();
  }

  function cleanup(s) {
    return s.replace(/[ \t]+/g, ' ').trim();
  }

  function convert(latex) {
    if (!latex || !latex.trim()) return '';
    var body = stripDelimiters(latex);
    var tokens = tokenize(body);
    var pos = { i: 0 };
    var out = parseSeq(tokens, pos, null);
    return cleanup(out);
  }

  var api = { convert: convert };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.LatexToHwp = api;
})(typeof window !== 'undefined' ? window : globalThis);
