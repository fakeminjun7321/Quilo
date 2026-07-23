import { trackEvent } from "./telemetry.js";

export function createJobStreamController(deps) {
  const { runtime, appendLine, setProgressStep, stopGenTimer, clearRetryCard,
    resetForm, showGenErrorCard, commitLastGenPrefs, loadBalance, loadFiles } = deps;
  const statusTitle = document.getElementById("statusTitle");
  const resultArea = document.getElementById("resultArea");

  function openPreview(url, filename) {
    if (typeof HTMLDialogElement === "undefined" || typeof HTMLDialogElement.prototype.showModal !== "function") {
      window.open(url, "_blank", "noopener");
      return;
    }
    let dialog = document.getElementById("generationPreviewDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "generationPreviewDialog";
      dialog.className = "generation-preview-dialog";
      const head = document.createElement("div");
      head.className = "generation-preview-dialog__head";
      const title = document.createElement("strong");
      title.dataset.previewTitle = "";
      const external = document.createElement("a");
      external.dataset.previewExternal = "";
      external.target = "_blank";
      external.rel = "noopener";
      external.textContent = "새 창에서 열기";
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "닫기";
      close.addEventListener("click", () => dialog.close());
      head.append(title, external, close);
      const frame = document.createElement("iframe");
      frame.dataset.previewFrame = "";
      frame.title = "생성 파일 미리보기";
      dialog.append(head, frame);
      dialog.addEventListener("close", () => frame.removeAttribute("src"));
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      document.body.appendChild(dialog);
    }
    dialog.querySelector("[data-preview-title]").textContent = filename || "파일 미리보기";
    dialog.querySelector("[data-preview-external]").href = url;
    dialog.querySelector("[data-preview-frame]").src = url;
    dialog.showModal();
  }

  function createResultActions({ jobId, filename, fileIndex = null }) {
    const suffix = fileIndex == null ? "" : `?file=${encodeURIComponent(fileIndex)}`;
    const actions = document.createElement("div");
    actions.className = "generation-result-actions";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = "generation-preview-button";
    preview.textContent = "미리보기";
    preview.addEventListener("click", () => {
      trackEvent("preview_clicked", { fileIndex: fileIndex == null ? 0 : fileIndex, source: "generation_result" });
      openPreview(`/api/jobs/${jobId}/preview${suffix}`, filename);
    });
    const download = document.createElement("a");
    download.href = `/api/jobs/${jobId}/download${suffix}`;
    download.textContent = `${filename || "파일"} 다운로드`;
    download.download = filename || "";
    download.addEventListener("click", () => {
      trackEvent("download_clicked", { fileIndex: fileIndex == null ? 0 : fileIndex, source: "generation_result" });
    });
    actions.append(preview, download);
    return actions;
  }

  function createQualityFeedback(jobId) {
    const panel = document.createElement("form");
    panel.className = "generation-quality-feedback";
    const title = document.createElement("strong");
    title.textContent = "이 결과가 얼마나 도움이 됐나요?";
    const controls = document.createElement("div");
    controls.className = "generation-quality-feedback__controls";

    const score = document.createElement("select");
    score.required = true;
    score.setAttribute("aria-label", "결과 평점");
    score.innerHTML = '<option value="">평점 선택</option><option value="5">5 · 매우 좋음</option><option value="4">4 · 좋음</option><option value="3">3 · 보통</option><option value="2">2 · 아쉬움</option><option value="1">1 · 매우 아쉬움</option>';
    const disposition = document.createElement("select");
    disposition.required = true;
    disposition.setAttribute("aria-label", "결과 사용 방식");
    disposition.innerHTML = '<option value="">사용 결과</option><option value="as_is">거의 그대로 사용</option><option value="minor_edits">조금 수정</option><option value="major_edits">많이 수정</option><option value="not_used">사용하지 않음</option>';
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "평가 보내기";
    controls.append(score, disposition, submit);

    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "아쉬운 점 선택 (선택)";
    const tagBox = document.createElement("div");
    tagBox.className = "generation-quality-feedback__tags";
    const tags = [
      ["data_error", "데이터 오류"],
      ["missing_content", "내용 누락"],
      ["format_broken", "문서 형식"],
      ["equation_error", "수식 오류"],
      ["chart_error", "차트 오류"],
      ["too_verbose", "너무 김"],
      ["too_short", "너무 짧음"],
      ["style_mismatch", "문체 불일치"],
      ["other", "기타"],
    ];
    tags.forEach(([value, label]) => {
      const item = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = value;
      item.append(input, document.createTextNode(label));
      tagBox.appendChild(item);
    });
    details.append(summary, tagBox);
    const status = document.createElement("span");
    status.className = "generation-quality-feedback__status";
    status.setAttribute("aria-live", "polite");
    panel.append(title, controls, details, status);
    panel.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = "저장 중...";
      const selectedTags = [...tagBox.querySelectorAll('input[type="checkbox"]:checked')]
        .map((input) => input.value);
      const payload = {
        score: Number(score.value),
        disposition: disposition.value,
        tags: selectedTags,
      };
      try {
        const response = await fetch(`/api/jobs/${jobId}/quality-feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "평가를 저장하지 못했습니다.");
        status.textContent = "감사합니다. 다음 개선에 반영할게요.";
        trackEvent("quality_feedback_submitted", {
          ...payload,
          reportType: runtime.pendingPrefs?.type || "unknown",
          source: "generation_result",
        });
        panel.querySelectorAll("input, select, button").forEach((node) => { node.disabled = true; });
      } catch (error) {
        status.textContent = error.message;
        submit.disabled = false;
      }
    });
    return panel;
  }

  function streamJob(jobId) {
    trackEvent("job_stream_opened", { reportType: runtime.pendingPrefs?.type || "unknown" });
    let settled = false;
    let disconnectCheckPending = false;
    let connectionInterrupted = false;
    const es = new EventSource(`/api/jobs/${jobId}/stream`);
    runtime.currentEs = es;
    const genSpinner = document.getElementById("genSpinner");
    if (genSpinner) genSpinner.hidden = false;

    es.addEventListener("open", () => {
      if (settled || !connectionInterrupted) return;
      connectionInterrupted = false;
      appendLine("서버 연결이 복구되었습니다. 진행 로그를 다시 받습니다.");
      statusTitle.textContent = "생성 중...";
      if (genSpinner) genSpinner.hidden = false;
    });

    es.addEventListener("progress", (e) => {
      if (settled) return;
      appendLine(JSON.parse(e.data));
    });

    es.addEventListener("done", (e) => {
      if (settled) return;
      settled = true;
      const data = JSON.parse(e.data);
      appendLine("완료");
      statusTitle.textContent = "완료";
      setProgressStep("ready");
      stopGenTimer(); // 경과 타이머 정지·정리
      clearRetryCard(); // 성공했으므로 이전 에러 카드 제거
      runtime.retryCount = 0;
      if (genSpinner) genSpinner.hidden = true;

      const resultActions = createResultActions({ jobId, filename: data.filename });
      try {
        const driveUrl = new URL(data.googleDriveUrl || "");
        if (driveUrl.protocol === "https:" && /(^|\.)google\.com$/.test(driveUrl.hostname)) {
          const drive = document.createElement("a");
          drive.href = driveUrl.href;
          drive.target = "_blank";
          drive.rel = "noopener";
          drive.textContent = "Google Drive에서 열기";
          resultActions.append(drive);
        }
      } catch (_) {}
      resultArea.appendChild(resultActions);
      resultArea.appendChild(createQualityFeedback(jobId));
      trackEvent("generation_completed", {
        reportType: runtime.pendingPrefs?.type || "unknown",
        source: "sse",
      });

      // 보관 안내 + (사전→결과) 이어서 만들기 CTA.
      try {
        // 마지막 제출 시 캡처한 종류(없으면 빈 문자열).
        const genType =
          (typeof runtime.pendingPrefs === "object" && runtime.pendingPrefs && runtime.pendingPrefs.type) || "";
        const meta = document.createElement("div");
        meta.className = "result-meta";

        const keep = document.createElement("small");
        keep.className = "result-keep";
        keep.textContent = "내 파일함에 24시간 보관됩니다 — 위 버튼으로 다시 받을 수 있어요.";
        meta.appendChild(keep);

        // 화학 사전보고서 → 화학 결과보고서로 자연스럽게 이어가는 동선.
        if (genType === "chem-pre") {
          const next = document.createElement("button");
          next.type = "button";
          next.className = "result-next-cta";
          next.textContent = "이 사전보고서로 결과보고서 이어서 만들기 →";
          next.addEventListener("click", () => {
            const radio = document.querySelector(
              'input[name="reportType"][value="chem-result"]',
            );
            if (radio && !radio.disabled) {
              try { radio.click(); } catch (_) { radio.checked = true; radio.dispatchEvent(new Event("change", { bubbles: true })); }
            }
          });
          meta.appendChild(next);
        }
        resultArea.appendChild(meta);
      } catch (_) { /* CTA 실패는 무시 — 다운로드는 정상 */ }

      // 데이터·메모 이상 점검 결과(참고 사항) — 결과 아래에 표시
      if (Array.isArray(data.warnings) && data.warnings.length) {
        const box = document.createElement("div");
        box.className = "generation-result-panel generation-result-panel--warning";
        const head = document.createElement("div");
        head.className = "generation-result-panel__title";
        head.textContent = "⚠️ 참고 사항 — 업로드한 데이터/메모에서 확인이 필요한 점";
        box.appendChild(head);
        const ul = document.createElement("ul");
        ul.className = "generation-result-panel__list";
        data.warnings.forEach((w) => {
          const li = document.createElement("li");
          li.textContent = w;
          ul.appendChild(li);
        });
        box.appendChild(ul);
        const note = document.createElement("div");
        note.className = "generation-result-panel__note";
        note.textContent =
          "보고서는 정상 생성되었습니다. 위 사항이 의도한 것이면 무시해도 되고, 데이터·메모를 고쳐 다시 생성하면 더 정확해집니다.";
        box.appendChild(note);
        resultArea.appendChild(box);
      }

      // 업로드한 .hwpx 글꼴 상세 분석 결과 — 결과 아래에 표시
      const sf = data.styleFont;
      if (sf && (sf.bodyFace || (sf.profile && sf.profile.length))) {
        const fb = document.createElement("div");
        fb.className = "generation-result-panel generation-result-panel--font";
        const h = document.createElement("div");
        h.className = "generation-result-panel__title";
        h.textContent = "🖊 감지된 글꼴 구성 (업로드한 한글파일 기준)";
        fb.appendChild(h);
        const sum = document.createElement("div");
        const bodyLabel = document.createElement("b");
        bodyLabel.textContent = "본문";
        sum.append(
          bodyLabel,
          document.createTextNode(` ${sf.bodyFace || "-"}${sf.bodySizePt ? " " + sf.bodySizePt + "pt" : ""}`),
        );
        if (sf.headingFace) {
          const headLabel = document.createElement("b");
          headLabel.textContent = "제목/소제목";
          sum.append(
            document.createTextNode("  ·  "),
            headLabel,
            document.createTextNode(
              ` ${sf.headingFace}${sf.headingSizePt ? " " + sf.headingSizePt + "pt" : ""}${sf.headingBold ? " 굵게" : ""}`,
            ),
          );
        }
        fb.appendChild(sum);
        if (sf.profile && sf.profile.length) {
          const det = document.createElement("details");
          const sm = document.createElement("summary");
          sm.textContent = `텍스트별 글꼴 상세 (${sf.profile.length}종)`;
          det.appendChild(sm);
          const ul2 = document.createElement("ul");
          sf.profile.forEach((c) => {
            const li = document.createElement("li");
            li.textContent = `${c.face} ${c.sizePt}pt${c.bold ? " 굵게" : ""} — ${c.share}%`;
            ul2.appendChild(li);
          });
          det.appendChild(ul2);
          fb.appendChild(det);
        }
        const fn = document.createElement("div");
        fn.className = "generation-result-panel__note";
        fn.textContent =
          "보고서는 본문 글꼴로 출력했습니다(그 글꼴이 PC에 설치돼 있어야 그대로 보입니다). 글자 크기·제목 글꼴까지 맞추려면 알려주세요.";
        fb.appendChild(fn);
        resultArea.appendChild(fb);
      }

      // AI로 이어서 편집 — 인수인계 프롬프트(복사용)
      if (typeof data.handoff === "string" && data.handoff.trim()) {
        const hb = document.createElement("div");
        hb.className = "generation-result-panel generation-result-panel--handoff";
        const hh = document.createElement("div");
        hh.className = "generation-handoff-head";
        const hhTitle = document.createElement("b");
        hhTitle.textContent = "🤝 AI로 이어서 편집하기";
        hh.appendChild(hhTitle);
        const copyBtn = document.createElement("button");
        copyBtn.textContent = "프롬프트 복사";
        copyBtn.className = "generation-handoff-copy";
        hh.appendChild(copyBtn);
        hb.appendChild(hh);
        const desc = document.createElement("div");
        desc.className = "generation-handoff-description";
        desc.textContent =
          "아래 안내문을 복사해 ChatGPT·Claude 등에 붙여넣고, 그 아래에 다운로드한 보고서 내용을 붙이면 이어서 다듬을 수 있어요(주의사항·다듬을 포인트 포함).";
        hb.appendChild(desc);
        const ta = document.createElement("textarea");
        ta.readOnly = true;
        ta.value = data.handoff;
        ta.className = "generation-handoff-text";
        hb.appendChild(ta);
        copyBtn.addEventListener("click", () => {
          ta.select();
          navigator.clipboard?.writeText(data.handoff).then(
            () => { copyBtn.textContent = "복사됨 ✓"; setTimeout(() => (copyBtn.textContent = "프롬프트 복사"), 1500); },
            () => { try { document.execCommand("copy"); copyBtn.textContent = "복사됨 ✓"; } catch {} },
          );
        });
        resultArea.appendChild(hb);
      }

      es.close();
      resetForm();
      // 마지막 성공 생성의 선택값(종류·모델·형식·글꼴)을 기억한다.
      if (typeof commitLastGenPrefs === "function") commitLastGenPrefs();
      // 작업 후 잔액 자동 새로고침
      if (typeof loadBalance === "function") loadBalance();
      if (typeof loadFiles === "function") loadFiles();
    });

    es.addEventListener("error", (e) => {
      // 서버가 명시적으로 보낸 error 이벤트(e.data 있음)인지, 순수 연결 끊김
      // (e.data 없음)인지 구분한다. 서버 error 이벤트는 작업이 실제로 실패한
      // 것이라 크레딧 미차감 + 재시도 안전. 반면 연결만 끊긴 경우 서버는 작업을
      // 중단하지 않고 끝까지 돌릴 수 있으므로 EventSource 기본 재연결을 유지한다.
      let msg;
      try { msg = e.data ? JSON.parse(e.data) : null; } catch (_) { msg = e.data || null; }
      const serverReportedError = e && e.data != null;
      if (settled) return;

      if (serverReportedError) {
        settled = true;
        stopGenTimer();
        if (genSpinner) genSpinner.hidden = true;
        es.close();
        trackEvent("generation_failed", {
          reportType: runtime.pendingPrefs?.type || "unknown",
          failureCode: "server_error",
          source: "sse",
        });
        const detail = msg ||
          "보고서 생성 중 오류가 발생했습니다. 크레딧은 차감되지 않았습니다. 잠시 후 다시 시도하세요.";
        appendLine("오류: " + detail);
        statusTitle.textContent = "오류";
        setProgressStep("document", "error");
        resetForm();
        showGenErrorCard({
          message: String(detail),
          detail: String(detail),
          phase: "stream",
          httpStatus: 0,
          allowRetry: true,
        });
        return;
      }

      if (!connectionInterrupted) {
        connectionInterrupted = true;
        appendLine("서버 연결이 잠시 끊겼습니다. 같은 작업에 다시 연결하는 중…");
        trackEvent("generation_failed", {
          reportType: runtime.pendingPrefs?.type || "unknown",
          failureCode: "stream_disconnected",
          source: "sse",
        });
      }
      statusTitle.textContent = "연결 재시도 중 · 서버에서 생성 계속";
      if (disconnectCheckPending) return;
      disconnectCheckPending = true;

      fetch(`/api/jobs/${jobId}/download`, { method: "HEAD" })
        .then((r) => {
          disconnectCheckPending = false;
          if (settled) return;
          if (r.status === 200) {
            settled = true;
            stopGenTimer();
            if (genSpinner) genSpinner.hidden = true;
            es.close();
            let filename = "";
            try {
              const cd = r.headers.get("Content-Disposition") || "";
              const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
              if (m && m[1]) filename = decodeURIComponent(m[1]);
            } catch (_) {}
            appendLine("완료 — 보고서가 서버에서 생성되었습니다.");
            statusTitle.textContent = "완료(연결 끊김)";
            setProgressStep("ready");
            clearRetryCard();
            runtime.retryCount = 0;
            const box = document.createElement("div");
            box.className = "generation-result-panel generation-result-panel--recovered";
            const h = document.createElement("div");
            h.className = "generation-result-panel__title";
            h.textContent = "✅ 연결은 끊겼지만 보고서는 완성됐어요";
            box.appendChild(h);
            const p = document.createElement("div");
            p.textContent =
              "화면과의 연결만 끊겼을 뿐, 서버에서 보고서 생성이 끝났습니다. 아래 버튼 또는 '내 파일'에서 받으세요(24시간 보관). 다시 생성하면 중복 요금이 나갈 수 있으니 재생성은 하지 마세요.";
            box.appendChild(p);
            const link = document.createElement("a");
            link.href = `/api/jobs/${jobId}/download`;
            link.textContent = filename ? `${filename} 다운로드` : "보고서 다운로드";
            if (filename) link.download = filename;
            link.className = "generation-recovered-download";
            const preview = document.createElement("button");
            preview.type = "button";
            preview.className = "generation-recovered-preview";
            preview.textContent = "미리보기";
            preview.addEventListener("click", () => openPreview(`/api/jobs/${jobId}/preview`, filename));
            const actions = document.createElement("div");
            actions.className = "generation-recovered-actions";
            actions.append(preview, link);
            box.appendChild(actions);
            resultArea.appendChild(box);
            resetForm();
            if (typeof loadBalance === "function") loadBalance();
            if (typeof loadFiles === "function") loadFiles();
            return;
          }
          if (r.status === 404 || r.status === 410) {
            settled = true;
            stopGenTimer();
            if (genSpinner) genSpinner.hidden = true;
            es.close();
            appendLine("서버가 재시작되어 작업이 중단되었습니다.");
            statusTitle.textContent = "오류";
            setProgressStep("document", "error");
            resetForm();
            showGenErrorCard({
              message: "서버 재시작으로 작업이 중단되었습니다. 크레딧은 차감되지 않았습니다. 다시 시도하세요.",
              detail: "서버 재시작으로 작업이 중단되었습니다. 크레딧은 차감되지 않았습니다. 다시 시도하세요.",
              phase: "stream",
              httpStatus: r.status,
              allowRetry: true,
            });
            return;
          }
          if (r.status === 401 || r.status === 403) {
            settled = true;
            stopGenTimer();
            if (genSpinner) genSpinner.hidden = true;
            es.close();
            appendLine("로그인 상태가 만료되어 작업 연결을 계속할 수 없습니다.");
            statusTitle.textContent = "로그인 필요";
            setProgressStep("document", "error");
            resetForm();
            showGenErrorCard({
              message: "로그인 상태를 확인한 뒤 '내 파일'에서 작업 결과를 확인해 주세요.",
              detail: "작업 상태 조회 권한이 없어 실시간 연결을 종료했습니다.",
              phase: "stream",
              httpStatus: r.status,
              allowRetry: false,
            });
            return;
          }
          if (r.status === 409) {
            if (connectionInterrupted) {
              appendLine("서버에서 보고서를 계속 생성하고 있습니다. 진행 로그에 재연결하는 중…");
            }
            return;
          }
          if (connectionInterrupted) {
            appendLine(`작업 상태 확인이 지연되고 있습니다 (HTTP ${r.status}). 재연결을 계속 시도합니다.`);
          }
        })
        .catch(() => {
          disconnectCheckPending = false;
          if (settled || !connectionInterrupted) return;
          appendLine("작업 상태 확인이 지연되고 있습니다. 재연결을 계속 시도합니다.");
        });
    });
  }


  return { streamJob };
}
