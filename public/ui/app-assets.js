(function (global) {
  "use strict";
  var pending = Object.create(null);
  var MONACO_BASE = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/";

  function script(key, src, ready) {
    if (ready && ready()) return Promise.resolve();
    if (pending[key]) return pending[key];
    pending[key] = new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[data-app-asset="' + key + '"]');
      if (existing) {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      var el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.dataset.appAsset = key;
      el.onload = resolve;
      el.onerror = function () { pending[key] = null; reject(new Error(key + " 라이브러리를 불러오지 못했습니다.")); };
      document.head.appendChild(el);
    });
    return pending[key];
  }

  function monacoLoader() {
    return script("monaco-loader", MONACO_BASE + "vs/loader.js", function () { return typeof global.require === "function" && !!global.require.config; });
  }

  function jszip() {
    return script("jszip", "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js", function () { return !!global.JSZip; });
  }

  function mathjax() {
    if (!global.MathJax) {
      global.MathJax = {
        tex: { inlineMath: [["$", "$"], ["\\(", "\\)"]], displayMath: [["$$", "$$"], ["\\[", "\\]"]] },
        options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre"] },
        startup: { typeset: false }
      };
    }
    return script("mathjax", "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js", function () { return !!(global.MathJax && global.MathJax.typesetPromise); });
  }

  global.QuiloAssets = { script: script, monacoLoader: monacoLoader, jszip: jszip, mathjax: mathjax, MONACO_BASE: MONACO_BASE };
})(window);
