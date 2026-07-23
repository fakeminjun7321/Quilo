const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeUntrustedTex } = require("../../lib/pipelines/pdf-translate/latex-pdf");

function doc(body) {
  return `\\documentclass{article}
\\usepackage{graphicx}
\\begin{document}
${body}
\\end{document}`;
}

test("LaTeX sanitizer rejects file IO and TeX construction primitives", () => {
  for (const body of [
    "\\input{/etc/passwd}",
    "\\openin1=/etc/passwd",
    "\\read1 to \\x",
    "\\immediate\\write18{cat /etc/passwd}",
    "\\csname input\\endcsname{/etc/passwd}",
    "\\catcode`\\@=11",
    "\\def\\x{\\input{/etc/passwd}}",
  ]) {
    assert.throws(() => sanitizeUntrustedTex(doc(body)), /LaTeX 보안 정책/);
  }
});

test("LaTeX sanitizer allows normal body markup and registered assets", () => {
  const safe = doc("\\section*{Title}\\[E=mc^2\\]\\includegraphics[width=0.5\\linewidth]{fig-1.png}");
  const out = sanitizeUntrustedTex(safe, {
    assets: [{ name: "fig-1.png", buffer: Buffer.from("x") }],
  });
  assert.equal(out.text, safe);
});

test("LaTeX sanitizer rejects unregistered includegraphics paths", () => {
  assert.throws(
    () => sanitizeUntrustedTex(doc("\\includegraphics{/etc/passwd}")),
    /includegraphics/,
  );
});
