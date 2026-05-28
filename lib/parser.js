const { ShadingType, TextRun } = require("docx");

const HIGHLIGHT_FILL = "CDF2E4";

/**
 * Parse rich text markers into an array of docx TextRun objects.
 *
 * Markers:
 *   _{content}   -> subscript
 *   ^{content}   -> superscript
 *   **content**  -> bold + mint highlight
 *   *content*    -> italic
 *
 * Supports nesting (italic inside bold etc.) and combined styles.
 */
function parseRichText(text, baseStyle = {}) {
  if (text == null) return [];
  const str = String(text);
  const tokens = tokenize(str);
  return tokens.map((t) => {
    const options = {
      text: t.text,
      bold: !!t.bold || !!baseStyle.bold,
      italics: !!t.italic || !!baseStyle.italic,
      subScript: !!t.sub,
      superScript: !!t.sup,
      font: baseStyle.font || "Malgun Gothic",
      size: baseStyle.size || 22, // half-points = 11pt
    };
    if (t.highlight && baseStyle.allowHighlights !== false) {
      options.shading = { type: ShadingType.CLEAR, fill: HIGHLIGHT_FILL };
    }
    return new TextRun(options);
  });
}

/**
 * Tokenize a marker-formatted string into flat segments with style flags.
 * Recursive descent parser supporting nesting.
 */
function tokenize(str) {
  const out = [];
  parseSegment(str, 0, str.length, {}, out);
  return out;
}

function parseSegment(str, start, end, style, out) {
  let i = start;
  let buf = "";

  const flush = () => {
    if (buf.length > 0) {
      out.push({ text: buf, ...style });
      buf = "";
    }
  };

  while (i < end) {
    const c = str[i];

    // _{...}  subscript
    if (c === "_" && str[i + 1] === "{") {
      const close = findClosingBrace(str, i + 2, end);
      if (close !== -1) {
        flush();
        parseSegment(str, i + 2, close, { ...style, sub: true }, out);
        i = close + 1;
        continue;
      }
    }

    // ^{...}  superscript
    if (c === "^" && str[i + 1] === "{") {
      const close = findClosingBrace(str, i + 2, end);
      if (close !== -1) {
        flush();
        parseSegment(str, i + 2, close, { ...style, sup: true }, out);
        i = close + 1;
        continue;
      }
    }

    // **...**  bold + mint highlight (must check before single-asterisk italic)
    if (c === "*" && str[i + 1] === "*") {
      const close = findDelimiter(str, i + 2, end, "**");
      if (close !== -1) {
        flush();
        parseSegment(
          str,
          i + 2,
          close,
          { ...style, bold: true, highlight: true },
          out,
        );
        i = close + 2;
        continue;
      }
    }

    // *...*  italic
    if (c === "*") {
      const close = findDelimiter(str, i + 1, end, "*");
      if (close !== -1) {
        flush();
        parseSegment(str, i + 1, close, { ...style, italic: true }, out);
        i = close + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
}

function findClosingBrace(str, start, end) {
  let depth = 1;
  for (let i = start; i < end; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findDelimiter(str, start, end, delim) {
  const len = delim.length;
  for (let i = start; i <= end - len; i++) {
    if (str.slice(i, i + len) === delim) {
      // For single '*', avoid matching '**'
      if (delim === "*" && str[i + 1] === "*") continue;
      // Avoid matching '*' that immediately follows '*' (closing of previous **)
      if (delim === "*" && str[i - 1] === "*" && i - 1 >= start) continue;
      return i;
    }
  }
  return -1;
}

/**
 * Strip all markers from a string. Useful for plain-text contexts (table cells,
 * figure captions where formatting is not important).
 */
function stripMarkers(text) {
  if (text == null) return "";
  return String(text)
    .replace(/_\{([^{}]*)\}/g, "$1")
    .replace(/\^\{([^{}]*)\}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1");
}

module.exports = { parseRichText, stripMarkers };
