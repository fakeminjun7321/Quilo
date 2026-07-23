(function () {
  "use strict";

  var input = document.getElementById("pdfAnalysisFile");
  var drop = document.getElementById("pdfAnalysisDrop");
  var fileMeta = document.getElementById("pdfAnalysisFileMeta");
  var fileName = document.getElementById("pdfAnalysisFileName");
  var fileClear = document.getElementById("pdfAnalysisFileClear");
  var run = document.getElementById("pdfAnalysisRun");
  var status = document.getElementById("pdfAnalysisStatus");
  var auth = document.getElementById("pdfAnalysisAuth");
  var result = document.getElementById("pdfAnalysisResult");
  var resultMeta = document.getElementById("pdfAnalysisResultMeta");
  var resultBadge = document.getElementById("pdfAnalysisResultBadge");
  var verdict = document.getElementById("pdfAnalysisVerdict");
  var recommendations = document.getElementById("pdfAnalysisRecommendations");
  var raw = document.getElementById("pdfAnalysisRaw");
  var actionStatus = document.getElementById("pdfAnalysisActionStatus");
  var copy = document.getElementById("pdfAnalysisCopy");
  var download = document.getElementById("pdfAnalysisDownload");
  var selected = null;
  var lastPayload = null;
  var authState = null;

  if (!input || !drop || !run) return;

  function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + "MB";
    return Math.max(1, Math.round(bytes / 1024)) + "KB";
  }

  function number(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatNumber(value) {
    return Math.round(number(value)).toLocaleString("ko-KR");
  }

  function updateRunState() {
    run.disabled = !selected || authState === false || run.classList.contains("is-running");
  }

  function showAuth() {
    authState = false;
    auth.hidden = false;
    updateRunState();
  }

  function choose(file) {
    if (!file) return;
    status.classList.remove("is-error");
    if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name || "")) {
      status.textContent = "PDF 파일만 선택할 수 있습니다.";
      status.classList.add("is-error");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      status.textContent = "PDF는 25MB 이하만 분석할 수 있습니다.";
      status.classList.add("is-error");
      return;
    }
    selected = file;
    lastPayload = null;
    result.hidden = true;
    actionStatus.textContent = "";
    fileName.textContent = file.name + " · " + formatBytes(file.size);
    fileMeta.hidden = false;
    drop.classList.add("has-file");
    drop.querySelector("strong").textContent = "PDF가 준비되었습니다";
    drop.querySelector("span").textContent = "분석을 시작하거나 다른 파일을 선택하세요.";
    status.textContent = "";
    updateRunState();
  }

  function clearSelection() {
    selected = null;
    input.value = "";
    fileMeta.hidden = true;
    result.hidden = true;
    status.textContent = "";
    drop.classList.remove("has-file");
    drop.querySelector("strong").textContent = "PDF를 끌어놓거나 눌러서 선택";
    drop.querySelector("span").textContent = "원본 파일은 수정되지 않습니다.";
    updateRunState();
    input.click();
  }

  function setCheck(id, title, description, tone) {
    var node = document.getElementById(id);
    node.dataset.tone = tone || "neutral";
    node.querySelector("strong").textContent = title;
    node.querySelector("p").textContent = description;
  }

  function documentVerdict(analysis) {
    if (analysis.math_garbled) return { label: "수식 글꼴 손상 가능", tone: "danger", text: "수식 글꼴의 문자 매핑이 불완전해 일반 텍스트 추출 결과를 신뢰하기 어렵습니다." };
    if (analysis.garbled) return { label: "텍스트층 손상 가능", tone: "danger", text: "PDF의 문자 매핑이 깨져 있어 OCR 기반 판독이 필요합니다." };
    if (analysis.ocr_layer) return { label: "숨은 OCR층이 있는 스캔본", tone: "warn", text: "페이지 이미지 위에 보이지 않는 OCR 텍스트가 포함된 스캔 PDF입니다." };
    if (analysis.scanned) return { label: "스캔·이미지 PDF", tone: "warn", text: "직접 추출할 텍스트가 부족한 페이지가 있어 OCR 기반 처리가 적합합니다." };
    return { label: "텍스트 PDF", tone: "good", text: "텍스트층을 직접 추출할 수 있어 검색·복사·번역 같은 후속 작업에 적합합니다." };
  }

  function buildRecommendations(analysis) {
    var items = [];
    if (analysis.scanned || analysis.garbled) {
      items.push("텍스트 추출 대신 페이지 이미지를 읽는 OCR 기반 처리를 권장합니다.");
    } else {
      items.push("텍스트층을 직접 사용하는 빠른 추출·검색·번역 처리가 가능합니다.");
    }
    if (analysis.math_garbled) {
      items.push("수식은 추출 텍스트를 그대로 쓰지 말고 원본 페이지 이미지와 대조하세요.");
    } else if (number(analysis.math_score) > 0) {
      items.push("수식 기호가 감지됐습니다. 문서 변환 후 기호와 첨자만 한 번 검수하세요.");
    }
    if (analysis.two_column) items.push("2단 읽기 순서를 보존하는 변환 방식을 사용하세요.");
    if (number(analysis.scan_page_count) > 0 && number(analysis.scan_page_count) < number(analysis.page_count)) {
      items.push("텍스트 페이지와 이미지 페이지가 섞인 혼합 PDF이므로 모든 페이지를 같은 방식으로 처리하지 마세요.");
    }
    return items;
  }

  function summaryText(payload) {
    var analysis = payload.analysis || {};
    var classification = documentVerdict(analysis);
    return [
      "PDF 분석 결과 — " + (payload.filename || "PDF"),
      "판정: " + classification.label,
      "페이지: " + formatNumber(analysis.page_count),
      "텍스트 글자: " + formatNumber(analysis.text_chars),
      "스캔 페이지: " + formatNumber(analysis.scan_page_count),
      "수식 밀도: " + number(analysis.math_density).toFixed(2) + "/1,000자",
      "2단 레이아웃: " + (analysis.two_column ? "감지" : "미감지"),
    ].join("\n");
  }

  function render(payload) {
    var analysis = payload.analysis || {};
    var pages = Math.max(0, number(analysis.page_count));
    var textChars = Math.max(0, number(analysis.text_chars));
    var scanPages = Math.max(0, number(analysis.scan_page_count));
    var density = Math.max(0, number(analysis.math_density));
    var classification = documentVerdict(analysis);
    var averageChars = pages ? Math.round(textChars / pages) : 0;

    resultMeta.textContent = (payload.filename || selected.name) + " · 구조 분석 완료";
    resultBadge.textContent = classification.label;
    verdict.dataset.tone = classification.tone;
    verdict.textContent = classification.text;
    document.getElementById("pdfMetricPages").textContent = formatNumber(pages) + "쪽";
    document.getElementById("pdfMetricText").textContent = formatNumber(textChars) + "자";
    document.getElementById("pdfMetricScan").textContent = scanPages ? formatNumber(scanPages) + "쪽" : "없음";
    document.getElementById("pdfMetricMath").textContent = density.toFixed(2);

    if (analysis.garbled) {
      setCheck("pdfCheckText", "손상 신호 감지", "깨진 문자 비율 " + (number(analysis.garbled_ratio) * 100).toFixed(1) + "%", "danger");
    } else if (textChars < pages * 20) {
      setCheck("pdfCheckText", "추출 텍스트 부족", "페이지당 평균 " + formatNumber(averageChars) + "자", "warn");
    } else {
      setCheck("pdfCheckText", "추출 가능", "페이지당 평균 " + formatNumber(averageChars) + "자", "good");
    }

    if (analysis.ocr_layer) {
      setCheck("pdfCheckScan", "숨은 OCR층 감지", "페이지 이미지 위 비가시 텍스트층이 있습니다.", "warn");
    } else if (analysis.scanned) {
      setCheck("pdfCheckScan", scanPages ? scanPages + "쪽 감지" : "스캔본 가능성", "이미지 기반 OCR 처리를 권장합니다.", "warn");
    } else {
      setCheck("pdfCheckScan", "스캔 신호 없음", "일반 텍스트 PDF로 판정했습니다.", "good");
    }

    if (analysis.math_garbled) {
      setCheck("pdfCheckMath", "수식 글꼴 손상", "손상 의심 글리프 비율 " + (number(analysis.math_garbled_ratio) * 100).toFixed(1) + "%", "danger");
    } else {
      setCheck("pdfCheckMath", density.toFixed(2) + "/1,000자", "수식 지표 점수 " + formatNumber(analysis.math_score), number(analysis.math_score) > 0 ? "neutral" : "good");
    }

    setCheck(
      "pdfCheckLayout",
      analysis.two_column ? "2단 본문 감지" : "2단 신호 없음",
      analysis.two_column ? "열별 읽기 순서를 보존해야 합니다." : "뚜렷한 2단 본문 패턴은 감지되지 않았습니다.",
      analysis.two_column ? "warn" : "good"
    );

    recommendations.replaceChildren();
    buildRecommendations(analysis).forEach(function (text) {
      var item = document.createElement("li");
      item.textContent = text;
      recommendations.appendChild(item);
    });
    raw.textContent = JSON.stringify(analysis, null, 2);
    result.hidden = false;
    if (window.matchMedia("(max-width: 1180px)").matches) result.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function analyze() {
    if (!selected || run.disabled) return;
    var form = new FormData();
    form.append("pdf", selected, selected.name);
    run.classList.add("is-running");
    updateRunState();
    run.textContent = "분석 중…";
    status.classList.remove("is-error");
    status.textContent = "페이지 구조와 텍스트층을 확인하고 있습니다.";
    result.hidden = true;

    try {
      var response = await fetch("/api/tools/pdf/analyze", { method: "POST", body: form, credentials: "same-origin" });
      var data = await response.json().catch(function () { return {}; });
      if (response.status === 401) {
        showAuth();
        throw new Error("로그인 후 PDF를 분석할 수 있습니다.");
      }
      if (!response.ok) throw new Error(data.error || "PDF를 분석하지 못했습니다.");
      lastPayload = { filename: data.filename || selected.name, analysis: data.analysis || {}, analyzedAt: new Date().toISOString() };
      render(lastPayload);
      status.textContent = "분석이 완료되었습니다.";
    } catch (error) {
      status.textContent = error.message || "PDF를 분석하지 못했습니다.";
      status.classList.add("is-error");
    } finally {
      run.classList.remove("is-running");
      run.textContent = "PDF 분석하기";
      updateRunState();
    }
  }

  drop.addEventListener("click", function () { input.click(); });
  drop.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); input.click(); }
  });
  input.addEventListener("change", function () { choose(input.files && input.files[0]); });
  ["dragenter", "dragover"].forEach(function (name) {
    drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.add("is-dragging"); });
  });
  ["dragleave", "drop"].forEach(function (name) {
    drop.addEventListener(name, function (event) { event.preventDefault(); drop.classList.remove("is-dragging"); });
  });
  drop.addEventListener("drop", function (event) { choose(event.dataTransfer && event.dataTransfer.files[0]); });
  fileClear.addEventListener("click", clearSelection);
  run.addEventListener("click", analyze);

  copy.addEventListener("click", async function () {
    if (!lastPayload) return;
    try {
      await navigator.clipboard.writeText(summaryText(lastPayload));
      actionStatus.textContent = "분석 결과를 복사했습니다.";
    } catch (_) {
      actionStatus.textContent = "브라우저에서 클립보드 복사를 허용해 주세요.";
    }
  });

  download.addEventListener("click", function () {
    if (!lastPayload) return;
    var blob = new Blob([JSON.stringify(lastPayload, null, 2)], { type: "application/json;charset=utf-8" });
    var link = document.createElement("a");
    var base = String(lastPayload.filename || "pdf").replace(/\.pdf$/i, "").replace(/[^\p{L}\p{N}._-]+/gu, "_") || "pdf";
    link.href = URL.createObjectURL(blob);
    link.download = base + "_analysis.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
    actionStatus.textContent = "JSON 분석값을 저장했습니다.";
  });

  fetch("/api/me", { credentials: "same-origin", cache: "no-store" }).then(function (response) {
    if (response.ok) {
      authState = true;
      auth.hidden = true;
      updateRunState();
    } else if (response.status === 401) {
      showAuth();
    }
  }).catch(function () {
    authState = null;
    updateRunState();
  });
})();
