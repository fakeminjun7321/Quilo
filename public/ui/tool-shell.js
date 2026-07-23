(function () {
  "use strict";

  if (window.__quiloToolShellLoaded) return;
  window.__quiloToolShellLoaded = true;

  var tools = [
    { group: "시작", href: "/tools/index.html", label: "도구 홈", icon: "home" },
    { group: "시작", href: "/tools/convert.html", label: "파일 변환", icon: "swap" },
    { group: "이미지", href: "/tools/image.html", label: "이미지 변환·압축", icon: "image" },
    { group: "이미지", href: "/tools/image-ocr.html", label: "이미지 OCR", icon: "scan" },
    { group: "PDF", href: "/tools/pdf-merge.html", label: "PDF 병합", icon: "merge" },
    { group: "PDF", href: "/tools/pdf-split.html", label: "PDF 분할", icon: "split" },
    { group: "PDF", href: "/tools/pdf-extract.html", label: "페이지 추출", icon: "page" },
    { group: "PDF", href: "/tools/pdf-remove.html", label: "페이지 삭제", icon: "trash" },
    { group: "PDF", href: "/tools/pdf-organize.html", label: "페이지 정렬", icon: "sort" },
    { group: "PDF", href: "/tools/pdf-rotate.html", label: "PDF 회전", icon: "rotate" },
    { group: "PDF", href: "/tools/pdf-pagenum.html", label: "페이지 번호", icon: "hash" },
    { group: "PDF", href: "/tools/pdf-watermark.html", label: "워터마크", icon: "type" },
    { group: "PDF", href: "/tools/pdf-crop.html", label: "여백 자르기", icon: "crop" },
    { group: "PDF", href: "/tools/pdf-compress.html", label: "PDF 압축", icon: "compress" },
    { group: "PDF", href: "/tools/pdf-analysis.html", label: "PDF 분석", icon: "inspect" },
    { group: "문서", href: "/equation/index.html", label: "한글 수식 변환", icon: "formula" }
  ];

  var icons = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M9.5 20v-6h5v6"/>',
    swap: '<path d="M7 7h12l-3-3"/><path d="m19 7-3 3"/><path d="M17 17H5l3 3"/><path d="m5 17 3-3"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 15-5-4-8 8"/>',
    scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10M8 9h8M8 15h6"/>',
    merge: '<path d="M7 4v5c0 2 2 3 5 3s5 1 5 3v5"/><path d="M17 4v5c0 1.4-1 2.3-2.6 2.7"/><path d="m14 18 3 3 3-3"/>',
    split: '<path d="M12 4v5c0 2-1 3-4 3H4"/><path d="M12 4v5c0 2 1 3 4 3h4"/><path d="M4 12v8"/><path d="M20 12v8"/>',
    page: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
    trash: '<path d="M4 7h16M9 3h6l1 4H8zM7 7l1 14h8l1-14"/><path d="M10 11v6M14 11v6"/>',
    sort: '<path d="M8 5h11M8 12h8M8 19h5"/><path d="m3 7 2-2 2 2M5 5v14"/><path d="m3 17 2 2 2-2"/>',
    rotate: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    hash: '<path d="M10 3 8 21M16 3l-2 18M4 9h16M3 15h16"/>',
    type: '<path d="M5 6V4h14v2M9 20h6M12 4v16"/>',
    crop: '<path d="M6 3v15a3 3 0 0 0 3 3h12M3 6h15a3 3 0 0 1 3 3v12"/>',
    compress: '<path d="m8 3-5 5M3 3v5h5M16 3l5 5M21 3v5h-5M8 21l-5-5M3 21v-5h5M16 21l5-5M21 21v-5h-5"/>',
    inspect: '<path d="M6 3h8l4 4v5"/><path d="M14 3v5h5"/><circle cx="14" cy="16" r="4"/><path d="m17 19 3 3"/><path d="M9 12h2M9 16h1"/>',
    formula: '<path d="M18 5H9l-4 7 4 7h9"/><path d="m14 9 5 6M19 9l-5 6"/>'
  };

  var assetProfiles = {
    "/tools/pdf-merge.html": { assets: ["pdfLib"], actions: ["pmMerge"] },
    "/tools/pdf-split.html": { assets: ["pdfLib", "toolZip"], actions: ["psRun"] },
    "/tools/pdf-extract.html": { assets: ["pdfLib"], actions: ["pxRun"] },
    "/tools/pdf-remove.html": { assets: ["pdfLib"], actions: ["prRun"] },
    "/tools/pdf-organize.html": { assets: ["pdfJs", "pdfLib"], actions: ["poBuild"] },
    "/tools/pdf-rotate.html": { assets: ["pdfLib"], actions: ["prRun"] },
    "/tools/pdf-pagenum.html": { assets: ["pdfLib"], actions: ["pnRun"] },
    "/tools/pdf-watermark.html": { assets: ["pdfLib"], actions: ["wmApply"] },
    "/tools/pdf-crop.html": { assets: ["pdfLib"], actions: ["pcCrop"] },
    "/tools/pdf-compress.html": { assets: ["pdfLib", "pdfJs"], actions: ["pcRun"] }
  };

  var assetDefinitions = {
    pdfLib: { src: "/tools/vendor/pdf-lib.min.js", ready: function () { return !!window.PDFLib; } },
    pdfJs: { src: "/tools/vendor/pdf.min.js", ready: function () { return !!window.pdfjsLib; } },
    toolZip: { src: "/tools/vendor/jszip.min.js", ready: function () { return !!window.JSZip; } }
  };
  var assetPromises = Object.create(null);

  function normalizedPath() {
    var path = location.pathname.replace(/\/+$/, "");
    if (path === "/tools" || path === "/tools/index") return "/tools/index.html";
    if (path === "/equation" || path === "/equation/index") return "/equation/index.html";
    if (!/\.html$/i.test(path) && (path.indexOf("/tools/") === 0 || path.indexOf("/equation/") === 0)) path += ".html";
    return path || "/tools/index.html";
  }

  function loadAsset(name) {
    var definition = assetDefinitions[name];
    if (!definition) return Promise.reject(new Error("Unknown asset: " + name));
    if (definition.ready()) return Promise.resolve();
    if (assetPromises[name]) return assetPromises[name];

    assetPromises[name] = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = definition.src;
      script.async = true;
      script.dataset.toolAsset = name;
      script.onload = function () {
        if (definition.ready()) resolve();
        else {
          delete assetPromises[name];
          script.remove();
          reject(new Error("도구 라이브러리를 초기화하지 못했습니다."));
        }
      };
      script.onerror = function () {
        delete assetPromises[name];
        script.remove();
        reject(new Error("도구 라이브러리를 불러오지 못했습니다."));
      };
      document.head.appendChild(script);
    });
    return assetPromises[name];
  }

  function loadProfile(profile) {
    return Promise.all(profile.assets.map(loadAsset));
  }

  window.QuiloToolAssets = {
    load: loadAsset,
    loadAll: function (names) { return Promise.all((names || []).map(loadAsset)); }
  };

  function icon(name) {
    return '<span class="q-tool-nav__icon" aria-hidden="true"><svg viewBox="0 0 24 24">' + (icons[name] || icons.page) + "</svg></span>";
  }

  function buildNavigation(path) {
    var aside = document.createElement("aside");
    aside.className = "q-tool-nav";
    aside.setAttribute("aria-label", "브라우저 도구");

    var brand = document.createElement("div");
    brand.className = "q-tool-nav__brand";
    brand.innerHTML = '<strong>Browser tools</strong><a href="/guide.html">도움말</a>';
    aside.appendChild(brand);

    var groups = [];
    tools.forEach(function (tool) {
      var group = groups.find(function (item) { return item.name === tool.group; });
      if (!group) { group = { name: tool.group, items: [] }; groups.push(group); }
      group.items.push(tool);
    });

    groups.forEach(function (group) {
      var section = document.createElement("section");
      section.className = "q-tool-nav__group";
      var label = document.createElement("h2");
      label.className = "q-tool-nav__label";
      label.textContent = group.name;
      var links = document.createElement("div");
      links.className = "q-tool-nav__links";
      group.items.forEach(function (tool) {
        var link = document.createElement("a");
        link.className = "q-tool-nav__link";
        link.href = tool.href;
        link.innerHTML = icon(tool.icon) + "<span>" + tool.label + "</span>";
        if (tool.href === path) link.setAttribute("aria-current", "page");
        links.appendChild(link);
      });
      section.appendChild(label);
      section.appendChild(links);
      aside.appendChild(section);
    });
    return aside;
  }

  function buildResultRail() {
    var path = normalizedPath();
    var privacy = path === "/tools/image-ocr.html"
      ? "암호화 전송 후 OCR 처리"
      : path === "/tools/pdf-analysis.html"
        ? "암호화 전송 후 서버 분석"
        : "브라우저 안에서 안전하게 처리";
    var rail = document.createElement("aside");
    rail.className = "q-tool-result-rail";
    rail.setAttribute("aria-label", "작업 결과");
    rail.innerHTML =
      '<div class="q-tool-result-rail__head"><h2>결과</h2><p>완료된 파일과 변환 결과가 여기에 표시됩니다.</p></div>' +
      '<div class="q-tool-result-rail__empty" data-tool-result-empty>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>' +
        '<span>왼쪽에서 파일을 선택하고 작업을 실행하세요.</span>' +
        '<span class="q-tool-result-rail__privacy">' + privacy + '</span>' +
      '</div>' +
      '<div class="q-tool-result-rail__host" data-tool-result-host></div>' +
      '<div class="q-tool-asset-status" aria-hidden="true" data-tool-asset-status>작업 엔진을 불러오는 중…</div>';
    return rail;
  }

  function isVisibleResult(element) {
    if (!element || element.hidden) return false;
    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return element.textContent.trim().length > 0 || !!element.querySelector("a[href], img[src], canvas");
  }

  function moveResults(main, rail) {
    var host = rail.querySelector("[data-tool-result-host]");
    var candidates = Array.prototype.slice.call(main.querySelectorAll(".tool-result"));
    if (normalizedPath() === "/equation/index.html") {
      [document.getElementById("latexResult"), document.getElementById("result")].forEach(function (node) {
        if (node && candidates.indexOf(node) < 0) candidates.push(node);
      });
    }
    candidates.forEach(function (node) { host.appendChild(node); });

    function sync() {
      rail.classList.toggle("q-tool-result-rail--active", candidates.some(isVisibleResult));
    }
    sync();
    if (candidates.length && window.MutationObserver) {
      var observer = new MutationObserver(sync);
      candidates.forEach(function (node) {
        observer.observe(node, { attributes: true, childList: true, subtree: true, characterData: true });
      });
    }
  }

  function installLazyAssets(rail) {
    var profile = assetProfiles[normalizedPath()];
    if (!profile) return;
    var status = rail.querySelector("[data-tool-asset-status]");
    var replaying = false;

    document.addEventListener("click", function (event) {
      if (replaying) return;
      var target = event.target.closest("button, a");
      if (!target || profile.actions.indexOf(target.id) < 0) return;
      var ready = profile.assets.every(function (name) { return assetDefinitions[name].ready(); });
      if (ready) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      status.setAttribute("aria-hidden", "false");
      var oldDisabled = target.disabled;
      target.disabled = true;
      loadProfile(profile).then(function () {
        status.setAttribute("aria-hidden", "true");
        target.disabled = oldDisabled;
        replaying = true;
        target.click();
        replaying = false;
      }).catch(function (error) {
        status.setAttribute("aria-hidden", "true");
        target.disabled = oldDisabled;
        status.textContent = error.message || "작업 엔진을 불러오지 못했습니다.";
        status.setAttribute("aria-hidden", "false");
        status.classList.add("is-error");
      });
    }, true);

    /* Start loading while the native picker is open, without blocking it. */
    document.addEventListener("click", function (event) {
      var pickTarget = event.target.closest('[role="button"][id$="Drop"], [role="button"][id$="drop"]');
      if (pickTarget) loadProfile(profile).catch(function () {});
    }, true);
  }

  function init() {
    var main = document.getElementById("main-content");
    if (!main || main.closest(".q-tool-shell")) return;

    var path = normalizedPath();
    var shell = document.createElement("div");
    shell.className = "q-tool-shell";
    var stage = document.createElement("div");
    stage.className = "q-tool-stage";
    var nav = buildNavigation(path);
    var rail = buildResultRail();

    main.parentNode.insertBefore(shell, main);
    shell.appendChild(nav);
    shell.appendChild(stage);
    stage.appendChild(main);
    shell.appendChild(rail);
    document.body.classList.add("q-tool-workspace");

    moveResults(main, rail);
    installLazyAssets(rail);

  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
