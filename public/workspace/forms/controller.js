import { readChemPreInput, buildChemPreFormData } from "./chem-pre.js";
import { readChemResultInput, buildChemResultFormData } from "./chem-result.js";
import { readPhysResultInput, buildPhysResultFormData } from "./phys-result.js";
import { readFreeInput, buildFreeFormData } from "./free.js";
import { isReadingLogBulk, readReadingLogInput, buildReadingLogFormData } from "./reading-log.js";

export function installReportFormControllers(deps) {
  const {
    runtime, elements, getSelectedModel, getModelLabel, getFontLabel,
    updateChemPreFontOptions, updateChemResultFontOptions, updatePhysResultFontOptions,
    updatePhysInquiryFontOptions, updateMathInquiryFontOptions, updateReadingLogFontOptions,
    updateFreeFontOptions, updateFormMakerFontOptions, getPhysInquiryFormat,
    getMathInquiryFormat, getFormMakerFormat, validateUserNotesFile, getUserNotesValue,
    getUserNotesFile, estimateCost, estimateChemResultCost, estimatePhysResultCost,
    estimateFreeReportCost, estimateGenSeconds, showConfirmDialog, getModelCredits,
    userNotesSummary, costRangeText, formatDuration, submitReport, showTab,
    appendPolicyAcknowledgements, usePolicyNote
  } = deps;
  const USE_POLICY_NOTE = usePolicyNote;
  const { form, btn, crForm, crBtn, prForm, prBtn, piForm, piBtn, miForm, miBtn,
    frForm, frBtn, psForm, psBtn, vbForm, vbBtn, fmForm, fmBtn, pprForm, pprBtn,
    rlForm, rlBtn } = elements;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (runtime.currentJobId) return; // 안전장치: 진행 중이면 무시
    const input = readChemPreInput(runtime.studentId);
    if (!input.valid) return;
    const file = input.manual;
    const model = input.model;
    const modelLabel = getModelLabel(model);
    updateChemPreFontOptions();
    if (!validateUserNotesFile(input.userNotesFile)) return;

    // 예상 비용 확인
    const allowImageGen = input.allowImageGen;
    const est = estimateCost(file.size, model);
    if (allowImageGen) est.hi += 0.08; // AI 개념도 최대 2장 × ~$0.04
    const krwLo = Math.round(est.lo * 1400);
    const krwHi = Math.round(est.hi * 1400);
    const genEst = estimateGenSeconds("chem-pre", model);
    const ok = await showConfirmDialog({
      title: "사전보고서 생성",
      background: form,
      credits: getModelCredits(model),
      recovery: { formEl: form, radioName: "model" },
      rows: [
        ["모델", modelLabel],
        ["글꼴", getFontLabel(input.fontFace)],
        ["참고 메모", userNotesSummary(input.userNotes, input.userNotesFile)],
        ["AI 이미지", allowImageGen ? "개념도 최대 2장 (장당 +1크레딧)" : "사용 안 함"],
        ["PDF", `${est.sizeKB}KB`],
        ["예상 비용", costRangeText(est, krwLo, krwHi)],
        ["예상 시간", formatDuration(genEst)],
      ],
      note: `실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
    });
    if (!ok) return;
    // 모델 변경(회복) 가능성 — 확인 후 현재 선택값을 다시 읽어 FormData·estimate 에 반영.
    const finalModel = getSelectedModel();

    const fd = buildChemPreFormData(input, finalModel);
    try {
      localStorage.setItem(
        "chemPreUserDefaults",
        JSON.stringify({ studentName: input.studentName }),
      );
    } catch (_) { /* private mode etc. */ }

    await submitReport({ formEl: form, buttonEl: btn, formData: fd, estimate: estimateGenSeconds("chem-pre", finalModel) });
  });

  // ── 화학 결과보고서 submit (Phase 2-2: 백엔드 골격 동작) ──────────────
  crForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (runtime.currentJobId) return;
    const input = readChemResultInput(runtime.studentId);
    if (!input.valid) return;
    const { preReport, dataFile, photos, manual } = input;
    const crModel = input.model;
    const modelLabel = getModelLabel(crModel);
    const crStyle = input.style;
    const crStyleLabel = crStyle === "minimal" ? "간단 양식" : "기본 양식";
    const crFormat = input.format;
    updateChemResultFontOptions();
    const crFontFace = input.fontFace;
    const crUserNotes = input.userNotes;
    const crUserNotesFile = input.userNotesFile;
    if (!validateUserNotesFile(input.userNotesFile)) return;

    const est = estimateChemResultCost({
      preReportBytes: preReport.size,
      manualBytes: manual?.size || 0,
      dataBytes: (dataFile?.size || 0) + (crUserNotesFile?.size || 0),
      photoBytes: input.photoBytes,
      photoCount: photos.length,
      modelId: crModel,
    });
    const krwLo = Math.round(est.lo * 1400);
    const krwHi = Math.round(est.hi * 1400);
    const crPhotoTokens = photos.length * 1500;
    const ok = await showConfirmDialog({
      title: "화학 결과보고서 생성",
      background: crForm,
      credits: getModelCredits(crModel),
      recovery: { formEl: crForm, radioName: "crModel" },
      rows: [
        ["모델", modelLabel],
        ["스타일", crStyleLabel],
        ["형식", crFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
        ["글꼴", getFontLabel(crFontFace)],
        ["참고 메모", userNotesSummary(crUserNotes, crUserNotesFile)],
        ["출력 범위", "사전보고서 뒤에 붙일 결과 추가 작성분"],
        ["첨부", `사전보고서${dataFile ? ", 데이터" : ", 데이터 없음"}${(crUserNotes || crUserNotesFile) && !dataFile ? " (메모 활용)" : ""}, 사진 ${photos.length}장${manual ? ", 매뉴얼" : ""}`],
        ["총 크기", `${est.totalKB}KB`],
        ["예상 비용", costRangeText(est, krwLo, krwHi)],
        ["예상 시간", formatDuration(estimateGenSeconds("chem-result", crModel, crPhotoTokens))],
      ],
      note: `실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
    });
    if (!ok) return;
    // 회복으로 모델이 바뀌었을 수 있어 현재 선택값을 다시 읽는다.
    const crFinalModel =
      document.querySelector('input[name="crModel"]:checked')?.value || crModel;

    const fd = buildChemResultFormData(input, crFinalModel);

    await submitReport({ formEl: crForm, buttonEl: crBtn, formData: fd, estimate: estimateGenSeconds("chem-result", crFinalModel, crPhotoTokens) });
  });

  // ── 물리 결과보고서 submit ───────────────────────────────────────────
  prForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (runtime.currentJobId) return;
    const input = readPhysResultInput(runtime.studentId);
    if (!input.valid && input.reason === "source") {
      alert("PASCO Capstone (.cap), 엑셀/CSV/텍스트 데이터, 데이터표·그래프 스크린샷 중 하나는 업로드해야 합니다.");
      return;
    }
    if (!input.valid && input.reason === "studentId") {
      alert("개인 설정에서 학번을 저장한 뒤 생성하세요.");
      showTab("settings");
      document.getElementById("settingsStudentIdInput").focus();
      return;
    }
    const { cap, dataFiles, manual, photos } = input;
    const prModel = input.model;
    const modelLabel = getModelLabel(prModel);
    const prFormat = input.format;
    updatePhysResultFontOptions();
    const prFontFace = input.fontFace;
    const prUserNotes = input.userNotes;
    const prUserNotesFile = input.userNotesFile;
    if (!validateUserNotesFile(prUserNotesFile)) return;

    const dataFileBytes = input.dataFileBytes;
    const dataInputBytes =
      (cap?.size || 0) + dataFileBytes + (prUserNotesFile?.size || 0);
    const est = estimatePhysResultCost({
      capBytes: dataInputBytes,
      photoCount: photos.length,
      photoBytes: input.photoBytes,
      formBytes: manual?.size || 0,
      rubricBytes: 0,
      modelId: prModel,
    });
    const krwLo = Math.round(est.lo * 1400);
    const krwHi = Math.round(est.hi * 1400);
    const inputLabel =
      (cap ? `.cap (${Math.round(cap.size / 1024)}KB)` : "") +
      (cap && dataFiles.length ? " + " : "") +
      (dataFiles.length
        ? `엑셀/CSV/텍스트 ${dataFiles.length}개 (${Math.round(dataFileBytes / 1024)}KB)`
        : "") +
      (!cap && dataFiles.length === 0 && photos.length ? "이미지 자료만" : "");
    const prPhotoTokens = photos.length * 1500;
    const ok = await showConfirmDialog({
      title: "물리 결과보고서 생성",
      background: prForm,
      credits: getModelCredits(prModel),
      recovery: { formEl: prForm, radioName: "prModel" },
      rows: [
        ["모델", modelLabel],
        ["양식", "기본 양식"],
        ["형식", prFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
        ["글꼴", getFontLabel(prFontFace)],
        ["참고 메모", userNotesSummary(prUserNotes, prUserNotesFile)],
        ["입력", `${inputLabel}${photos.length > 0 ? `, 사진 ${photos.length}장` : ""}${manual ? ", 매뉴얼" : ""}`],
        ["총 크기", `${est.totalKB}KB`],
        ["예상 비용", costRangeText(est, krwLo, krwHi)],
        ["예상 시간", formatDuration(estimateGenSeconds("phys-result", prModel, prPhotoTokens))],
      ],
      note: `기본 평가 기준을 적용합니다. ${USE_POLICY_NOTE}`,
    });
    if (!ok) return;
    // 회복으로 모델이 바뀌었을 수 있어 현재 선택값을 다시 읽는다.
    const prFinalModel =
      document.querySelector('input[name="prModel"]:checked')?.value || prModel;

    const fd = buildPhysResultFormData(input, prFinalModel);

    await submitReport({ formEl: prForm, buttonEl: prBtn, formData: fd, estimate: estimateGenSeconds("phys-result", prFinalModel, prPhotoTokens) });
  });

  // ── 물리 수행평가(베타) submit ───────────────────────────────────────
  if (piForm) {
    piForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;

      const topic = document.getElementById("piTopic").value.trim();
      const notes = Array.from(document.getElementById("piNotes").files);
      const refs = Array.from(document.getElementById("piRefs").files);
      const refLinks = document.getElementById("piRefLinks").value.trim();
      const styleRefs = Array.from(document.getElementById("piStyleRefs").files);
      const styleNote = document.getElementById("piStyleNote").value.trim();

      if (!topic) {
        alert("탐구 주제를 입력하세요.");
        document.getElementById("piTopic").focus();
        return;
      }
      if (notes.length === 0 && refs.length === 0 && !refLinks) {
        alert("필기노트 PDF, 참고자료 파일, 참고 링크 중 하나는 첨부하세요.");
        return;
      }

      const piModel =
        document.querySelector('input[name="piModel"]:checked')?.value ||
        "claude-opus-4-8";
      const modelLabel = getModelLabel(piModel);
      const piFormat = getPhysInquiryFormat();
      updatePhysInquiryFontOptions();
      const piFontFace = document.getElementById("piFontFace").value;
      const piUserNotes = getUserNotesValue("piUserNotes");
      const piUserNotesFile = getUserNotesFile("piUserNotesFile");
      if (!validateUserNotesFile(piUserNotesFile)) return;

      const inputBits = [];
      if (notes.length) inputBits.push(`필기노트 ${notes.length}개`);
      if (refs.length) inputBits.push(`참고자료 ${refs.length}개`);
      if (refLinks) inputBits.push(`링크 ${refLinks.split(/\s*\n\s*/).filter(Boolean).length}개`);

      const ok = await showConfirmDialog({
        title: "물리 수행평가 초안 생성 (Pro)",
        background: piForm,
        rows: [
          ["모델", modelLabel],
          ["형식", piFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
          ["글꼴", getFontLabel(piFontFace)],
          ["주제", topic.length > 40 ? topic.slice(0, 40) + "…" : topic],
          ["입력", inputBits.join(", ") || "주제만"],
          ["참고 메모", userNotesSummary(piUserNotes, piUserNotesFile)],
          ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
          ["예상 비용", "무료 (Pro)"],
          ["예상 시간", formatDuration(estimateGenSeconds("phys-inquiry", piModel))],
        ],
        note: `탐구·사고 과정 성찰 보고서 양식으로 작성합니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = new FormData();
      fd.append("type", "phys-inquiry");
      fd.append("topic", topic);
      notes.forEach((f) => fd.append("notes", f));
      refs.forEach((f) => fd.append("refs", f));
      fd.append("refLinks", refLinks);
      styleRefs.forEach((f) => fd.append("styleRefs", f));
      if (styleNote) fd.append("styleNote", styleNote);
      const piDateStr = document.getElementById("piDate").value;
      if (piDateStr) {
        const [y, m, d] = piDateStr.split("-");
        fd.append("date", `${y}/ ${m} / ${d}`);
      }
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", piModel);
      fd.append("format", piFormat);
      fd.append("fontFace", piFontFace);
      fd.append("userNotes", piUserNotes);
      if (piUserNotesFile) fd.append("userNotesFile", piUserNotesFile);
      appendPolicyAcknowledgements(fd);

      await submitReport({ formEl: piForm, buttonEl: piBtn, formData: fd, estimate: estimateGenSeconds("phys-inquiry", piModel) });
    });
  }

  // ── 수학 수행평가(베타) submit — 주제(+선택 메모·문체)만 입력 ─────────
  if (miForm) {
    miForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;

      const topic = document.getElementById("miTopic").value.trim();
      const styleRefs = Array.from(document.getElementById("miStyleRefs").files);
      const styleNote = document.getElementById("miStyleNote").value.trim();

      if (!topic) {
        alert("탐구 주제를 입력하세요.");
        document.getElementById("miTopic").focus();
        return;
      }

      const miModel =
        document.querySelector('input[name="miModel"]:checked')?.value ||
        "claude-opus-4-8";
      const modelLabel = getModelLabel(miModel);
      const miFormat = getMathInquiryFormat();
      updateMathInquiryFontOptions();
      const miFontFace = document.getElementById("miFontFace").value;
      const miUserNotes = getUserNotesValue("miUserNotes");
      const miUserNotesFile = getUserNotesFile("miUserNotesFile");
      if (!validateUserNotesFile(miUserNotesFile)) return;

      const ok = await showConfirmDialog({
        title: "수학 수행평가 초안 생성 (Pro)",
        background: miForm,
        rows: [
          ["모델", modelLabel],
          ["형식", miFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
          ["글꼴", getFontLabel(miFontFace)],
          ["주제", topic.length > 40 ? topic.slice(0, 40) + "…" : topic],
          ["참고 메모", userNotesSummary(miUserNotes, miUserNotesFile)],
          ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
          ["예상 비용", "무료 (Pro)"],
          ["예상 시간", formatDuration(estimateGenSeconds("math-inquiry", miModel))],
        ],
        note: `주제만으로 AI가 수학 전개·웹 검색을 통해 수학Ⅲ 급수 탐구보고서 양식(Ⅰ~Ⅴ)으로 작성합니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = new FormData();
      fd.append("type", "math-inquiry");
      fd.append("topic", topic);
      styleRefs.forEach((f) => fd.append("styleRefs", f));
      if (styleNote) fd.append("styleNote", styleNote);
      const miDateStr = document.getElementById("miDate").value;
      if (miDateStr) {
        const [y, m, d] = miDateStr.split("-");
        fd.append("date", `${y}/ ${m} / ${d}`);
      }
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", miModel);
      fd.append("format", miFormat);
      fd.append("fontFace", miFontFace);
      fd.append("userNotes", miUserNotes);
      if (miUserNotesFile) fd.append("userNotesFile", miUserNotesFile);
      appendPolicyAcknowledgements(fd);

      await submitReport({ formEl: miForm, buttonEl: miBtn, formData: fd, estimate: estimateGenSeconds("math-inquiry", miModel) });
    });
  }

  // ── 독서록 submit — 도서 정보 → 독서활동 기록지(.hwpx) (크레딧 과금) ──────────
  if (rlForm) {
    // 생성 방식(한 권씩 / 엑셀 대량) 토글 — 관련 섹션 표시·필수속성·버튼 라벨 전환.
    const rlIsBulk = isReadingLogBulk;
    const rlToggle = (el, hide) => {
      if (!el) return;
      el.hidden = hide;
    };
    const rlSetMode = () => {
      const bulk = rlIsBulk();
      rlToggle(document.getElementById("rlBulkSection"), !bulk);
      rlForm
        .querySelectorAll("[data-rl-single]")
        .forEach((el) => rlToggle(el, bulk));
      const titleEl = document.getElementById("rlTitle");
      if (titleEl) titleEl.required = !bulk;
      if (rlBtn) rlBtn.textContent = bulk ? "독서록 대량 생성 (ZIP)" : "독서록 생성";
    };
    rlForm
      .querySelectorAll('input[name="rlMode"]')
      .forEach((r) => r.addEventListener("change", rlSetMode));
    rlSetMode();

    rlForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;

      const input = readReadingLogInput(runtime.studentId);
      const bulk = input.bulk;
      const recordArea = input.recordArea;
      const subject = input.subject;
      const enrolledSubjects = input.enrolledSubjects;
      const domain = input.domain;
      const domainLabel =
        document.querySelector('#rlDomain option[value="' + domain + '"]')?.textContent.trim() || "";
      const borrowed = input.borrowed;
      const rlModel = input.model;
      const modelLabel = getModelLabel(rlModel);
      updateReadingLogFontOptions();
      const rlFontFace = input.fontFace;

      if (bulk) {
        // ── 대량(엑셀) — 책마다 독서활동 기록지(.hwpx) → ZIP ──────────────
        const excelEl = document.getElementById("rlExcel");
        const excelFile = input.excel;
        if (!input.valid) {
          alert("책 목록 엑셀(.xlsx/.csv)을 올리세요. (책이름·출판사·작가 순)");
          excelEl?.focus?.();
          return;
        }
        const periodStart = input.periodStart;
        const periodEnd = input.periodEnd;
        const subjectTeachers = input.subjectTeachers;
        const homeroomTeacher = input.homeroomTeacher;
        const mapCount = subjectTeachers ? subjectTeachers.split(/\n+/).filter((l) => /[-–:]/.test(l)).length : 0;

        const rlMaxCredits = getModelCredits(rlModel);
        const ok = await showConfirmDialog({
          title: "독서록 대량 생성",
          background: rlForm,
          rows: [
            ["모델", modelLabel],
            ["책 목록", excelFile.name],
            ["영역", domainLabel || "미선택"],
            ["대출 여부", borrowed === "no" ? "× (기본)" : borrowed === "yes" ? "○" : "미선택"],
            ["읽기 기간", `${periodStart || "?"} ~ ${periodEnd || "?"} (책 수만큼 분배)`],
            ["과목-담당교사", mapCount ? `${mapCount}건 매핑 · 나머지는 담임(${homeroomTeacher || "미지정"}) 공통 ○` : "미입력 (엑셀/일괄 설정 사용)"],
            ["출력", mapCount || homeroomTeacher ? "교사별 합본 .hwpx → ZIP" : "책마다 .hwpx → ZIP 묶음"],
            ["차감 크레딧", rlMaxCredits > 0
              ? `권당 최대 ${rlMaxCredits}크레딧 예약 · 실제 사용 토큰만큼만 차감(차액 환불)`
              : "하루 5건 무료 · 이후 1크레딧"],
          ],
          note: `엑셀의 책마다 AI가 선택 계기·내용·느낀 점을 써서 학교 '독서활동 기록지'(.hwpx)를 만들어 ZIP으로 묶습니다. 책이 많으면 몇 분 걸릴 수 있어요. 크레딧은 실제 생성된 책의 토큰만큼만 차감됩니다(실패한 책은 미차감). ${USE_POLICY_NOTE}`,
        });
        if (!ok) return;

        const fd = buildReadingLogFormData(input);

        await submitReport({ formEl: rlForm, buttonEl: rlBtn, formData: fd, estimate: estimateGenSeconds("reading-log", rlModel) });
        return;
      }

      // ── 단일(한 권) ────────────────────────────────────────────────
      const title = input.title;
      if (!input.valid) {
        alert("도서명을 입력하세요.");
        document.getElementById("rlTitle").focus();
        return;
      }
      const author = input.author;
      const publisher = input.publisher;
      const userNotes = input.userNotes;

      const rlMaxCredits = getModelCredits(rlModel);
      const ok = await showConfirmDialog({
        title: "독서록 초안 생성",
        background: rlForm,
        rows: [
          ["모델", modelLabel],
          ["형식", ".hwpx (한글 — 학교 양식)"],
          ["글꼴", getFontLabel(rlFontFace)],
          ["도서명", title.length > 40 ? title.slice(0, 40) + "…" : title],
          ["저자", author || "AI 추정"],
          ["영역", domainLabel || "미선택"],
          ["감상 메모", userNotes ? "반영" : "없음"],
          ["차감 크레딧", rlMaxCredits > 0
            ? `최대 ${rlMaxCredits}크레딧 예약 · 실제 사용 토큰만큼만 차감(차액 환불)`
            : "하루 5건 무료 · 이후 1크레딧"],
          ["예상 시간", formatDuration(estimateGenSeconds("reading-log", rlModel))],
        ],
        note: `도서 정보로 AI가 선택 계기·내용 요약·느낀 점을 써서 학교 '독서활동 기록지' 양식(.hwpx)에 채웁니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = buildReadingLogFormData(input);

      await submitReport({ formEl: rlForm, buttonEl: rlBtn, formData: fd, estimate: estimateGenSeconds("reading-log", rlModel) });
    });
  }

  // ── 문제집 메이커(베타) submit — 문제 PDF/사진 → 3종 PDF ZIP ─────────
  if (psForm) {
    psForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;

      const source = Array.from(document.getElementById("psSource").files);
      if (source.length === 0) {
        alert("문제 파일(PDF 또는 이미지)을 올리세요.");
        document.getElementById("psSource").focus();
        return;
      }

      const psModel =
        document.querySelector('input[name="psModel"]:checked')?.value ||
        "claude-opus-4-8";
      const modelLabel = getModelLabel(psModel);
      const perPage = document.getElementById("psPerPage").value || "6";
      const crossVerify = document.getElementById("psCrossVerify").checked;
      const allowImageGen =
        document.getElementById("psAllowImageGen").checked;
      const userNotes = document.getElementById("psUserNotes").value.trim();

      const ok = await showConfirmDialog({
        title: "문제집 메이커 (Pro)",
        background: psForm,
        rows: [
          ["모델", modelLabel],
          ["문제 파일", `${source.length}개`],
          ["페이지당 문제 수", `${perPage}문제`],
          ["교차검증", crossVerify ? "ON (3중 풀이)" : "OFF"],
          ["해설 삽화", allowImageGen ? "생성 (gpt-image)" : "사용 안 함"],
          ["출력", "ZIP · 영어 문제지 + 한글 문제지 + 해설지"],
          ["예상 비용", "무료 (Pro)"],
          [
            "예상 시간",
            crossVerify
              ? "문제 수에 따라 2~8분"
              : "문제 수에 따라 1~5분",
          ],
        ],
        note: `교재 문제를 영어 문제지·한글 문제지·해설지 3종 PDF로 만들어 ZIP 하나로 묶습니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = new FormData();
      fd.append("type", "problem-set");
      source.forEach((f) => fd.append("source", f));
      fd.append("perPage", perPage);
      fd.append("crossVerify", crossVerify ? "true" : "false");
      fd.append("allowImageGen", allowImageGen ? "true" : "false");
      if (userNotes) fd.append("userNotes", userNotes);
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", psModel);
      appendPolicyAcknowledgements(fd);

      await submitReport({ formEl: psForm, buttonEl: psBtn, formData: fd });
    });
  }

  // ── 단어장 메이커(Pro) submit - 교재·기존 단어장·표 → PDF + JSON ZIP ──
  if (vbForm) {
    const sourceInput = document.getElementById("vbSource");
    const syncButton = () => {
      if (!runtime.currentJobId) vbBtn.disabled = !sourceInput.files?.length;
    };
    sourceInput.addEventListener("change", syncButton);
    syncButton();

    vbForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const source = sourceInput.files?.[0];
      if (!source) {
        alert("영어교재 또는 영어 단어장 파일을 올리세요.");
        sourceInput.focus();
        return;
      }
      const includeCore = document.getElementById("vbIncludeCore").checked;
      const includeAcademic = document.getElementById("vbIncludeAcademic").checked;
      const includePhrases = document.getElementById("vbIncludePhrases").checked;
      if (!includeCore && !includeAcademic && !includePhrases) {
        alert("핵심 용어, 학술 어휘, 문제 풀이 표현 중 하나 이상을 선택하세요.");
        return;
      }
      const model = document.querySelector('input[name="vbModel"]:checked')?.value || "claude-opus-4-8";
      const pagesPerUnit = document.getElementById("vbPagesPerUnit").value || "10";
      const termCount = document.getElementById("vbTermCount").value || "20";
      const pageRange = document.getElementById("vbPageRange").value.trim();
      const title = document.getElementById("vbTitle").value.trim();
      const includePronunciation = document.getElementById("vbIncludePronunciation").checked;
      const includeReview = document.getElementById("vbIncludeReview").checked;
      const includeMemo = document.getElementById("vbIncludeMemo").checked;
      const designStyle = document.querySelector('input[name="vbDesignStyle"]:checked')?.value || "science";
      const designLabel = {
        science: "사이언스 블루",
        classic: "클래식 교재형",
        minimal: "미니멀 암기형",
      }[designStyle] || "사이언스 블루";
      const typeLabels = [
        includeCore && "핵심 용어",
        includeAcademic && "학술 어휘",
        includePhrases && "문제 풀이 표현",
      ].filter(Boolean);

      const ok = await showConfirmDialog({
        title: "단어장 메이커 (Pro)",
        background: vbForm,
        rows: [
          ["모델", getModelLabel(model)],
          ["영어 자료", source.name],
          ["PDF 페이지 범위", pageRange || "전체 (PDF는 최대 80쪽)"],
          ["구성", `출처 ${pagesPerUnit}개 단위마다 ${termCount}개`],
          ["디자인", designLabel],
          ["어휘 종류", typeLabels.join(", ")],
          ["학습 요소", [includePronunciation && "발음", includeReview && "단원 평가", includeMemo && "메모"].filter(Boolean).join(", ") || "기본"],
          ["출력", "ZIP · 인터랙티브 PDF + 학습용 JSON"],
          ["예상 비용", "무료 (Pro)"],
          ["예상 시간", "선택 범위에 따라 1~5분"],
        ],
        note: `교재·단어장·표 원문에 실제로 등장한 표현만 서버 검증을 통과해 수록합니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = new FormData();
      fd.append("type", "vocabulary-book");
      fd.append("source", source);
      if (title) fd.append("title", title);
      if (pageRange) fd.append("pageRange", pageRange);
      fd.append("pagesPerUnit", pagesPerUnit);
      fd.append("termCount", termCount);
      fd.append("includeCore", includeCore ? "true" : "false");
      fd.append("includeAcademic", includeAcademic ? "true" : "false");
      fd.append("includePhrases", includePhrases ? "true" : "false");
      fd.append("includePronunciation", includePronunciation ? "true" : "false");
      fd.append("includeReview", includeReview ? "true" : "false");
      fd.append("includeMemo", includeMemo ? "true" : "false");
      fd.append("designStyle", designStyle);
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", model);
      appendPolicyAcknowledgements(fd);

      await submitReport({ formEl: vbForm, buttonEl: vbBtn, formData: fd });
    });
  }

  // ── 자유 보고서 submit ───────────────────────────────────────────────
  if (frForm) {
    frForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const input = readFreeInput(runtime.studentId);
      if (!input.valid) {
        alert("어떤 보고서를 어떻게 쓸지 '작성 지시'를 입력하세요.");
        document.getElementById("frInstructions").focus();
        return;
      }
      const { instructions, grading, title, refLinks, photos, styleRefs, styleNote } = input;
      const files = input.attachments;
      const frModel = input.model;
      const modelLabel = getModelLabel(frModel);
      const frFormat = input.format;
      updateFreeFontOptions();
      const frFontFace = input.fontFace;
      const frUserNotes = input.userNotes;
      const frUserNotesFile = input.userNotesFile;
      if (!validateUserNotesFile(frUserNotesFile)) return;

      const docBytes =
        files.reduce((s, f) => s + f.size, 0) + (frUserNotesFile?.size || 0);
      const est = estimateFreeReportCost({
        docBytes,
        photoBytes: input.photoBytes,
        photoCount: photos.length,
        textChars: instructions.length + grading.length + frUserNotes.length + refLinks.length,
        modelId: frModel,
      });
      const krwLo = Math.round(est.lo * 1400);
      const krwHi = Math.round(est.hi * 1400);
      const frPhotoTokens = photos.length * 1500;
      const ok = await showConfirmDialog({
        title: "자유 보고서 생성",
        background: frForm,
        credits: getModelCredits(frModel),
        recovery: { formEl: frForm, radioName: "frModel" },
        rows: [
          ["모델", modelLabel],
          ["형식", frFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
          ["글꼴", getFontLabel(frFontFace)],
          ["참고 메모", userNotesSummary(frUserNotes, frUserNotesFile)],
          ["첨부", `자료 ${files.length}개, 사진 ${photos.length}장`],
          ["내 문체", styleRefs.length || styleNote ? `반영${styleRefs.length ? ` (샘플 ${styleRefs.length}개)` : ""}` : "기본"],
          ["총 크기", `${est.totalKB}KB`],
          ["예상 비용", costRangeText(est, krwLo, krwHi)],
          ["예상 시간", formatDuration(estimateGenSeconds("free", frModel, frPhotoTokens))],
        ],
        note: `작성 지시·평가 기준에 맞춰 자유 형식으로 작성합니다. 실제 비용은 완료 후 표시됩니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;
      // 회복으로 모델이 바뀌었을 수 있어 현재 선택값을 다시 읽는다.
      const frFinalModel =
        document.querySelector('input[name="frModel"]:checked')?.value || frModel;

      const fd = buildFreeFormData(input, frFinalModel);

      await submitReport({ formEl: frForm, buttonEl: frBtn, formData: fd, estimate: estimateGenSeconds("free", frFinalModel, frPhotoTokens) });
    });
  }

  // 업로드 전 사진 다운스케일 — 폰 사진(6~8MB)을 그대로 올리면 합계가 커서 업로드가
  // 느리거나 실패(타임아웃/메모리)한다. 브라우저 canvas 로 긴 변 maxEdge 로 줄여 JPEG 로
  // 재인코딩하면 합계가 1/5 수준으로 줄어 업로드가 빠르고 안정적이며 생성도 빨라진다.
  // 복원 그림 크롭에 충분한 해상도(기본 2400px)는 유지한다. 실패하면 원본을 그대로 쓴다.
  async function downscaleImageForUpload(
    file,
    { maxEdge = 2400, quality = 0.82, maxBytes = 1.8 * 1024 * 1024 } = {},
  ) {
    try {
      if (!file || !/^image\//.test(file.type || "")) return file;
      if (file.size <= 900 * 1024) return file; // 이미 작으면 그대로
      let bmp;
      try {
        bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      } catch {
        bmp = await createImageBitmap(file);
      }
      const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      let q = quality;
      let blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
      while (blob && blob.size > maxBytes && q > 0.5) {
        q -= 0.12;
        blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
      }
      if (!blob || blob.size >= file.size) return file; // 효과 없으면 원본
      const base = (file.name || "photo").replace(/\.[^.]+$/, "");
      return new File([blob], base + ".jpg", { type: "image/jpeg", lastModified: Date.now() });
    } catch {
      return file;
    }
  }

  // ── 양식 메이커 (베타) ───────────────────────────────────────────────
  if (fmForm) {
    fmForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;

      const promptText = document.getElementById("fmInstructions").value.trim();
      const photos = Array.from(document.getElementById("fmPhotos").files);
      if (!promptText && photos.length === 0) {
        alert("① 양식 설명을 입력하거나, ② 복원할 문서 사진을 한 장 이상 올리세요.");
        document.getElementById("fmInstructions").focus();
        return;
      }
      const title = document.getElementById("fmTitle").value.trim();
      const fmUserNotes = getUserNotesValue("fmUserNotes");
      const fmModel =
        document.querySelector('input[name="fmModel"]:checked')?.value ||
        "claude-opus-4-8";
      const fmFormat = getFormMakerFormat();
      updateFormMakerFontOptions();
      const fmFontFace = document.getElementById("fmFontFace").value;
      const fmRedraw = !!document.getElementById("fmFigureRedraw")?.checked;
      const fmLayout = document.querySelector('input[name="fmLayout"]:checked')?.value || "auto";
      const layoutLabel = fmLayout === "layout" ? "원문 2단 그대로" : fmLayout === "clean" ? "정리해서 깔끔하게" : "자동 (정리본)";
      const modeLabel =
        photos.length > 0
          ? promptText
            ? `문서 복원 + 지시 (사진 ${photos.length}장)`
            : `문서 복원 (사진 ${photos.length}장)`
          : "양식 생성";

      const ok = await showConfirmDialog({
        title: "양식 메이커",
        background: fmForm,
        rows: [
          ["작업", modeLabel],
          ["모델", getModelLabel(fmModel)],
          ["형식", fmFormat === "hwpx" ? ".hwpx (한글)" : ".docx (MS Word)"],
          ["글꼴", getFontLabel(fmFontFace)],
          ...(photos.length > 0
            ? [
                ["레이아웃", layoutLabel],
                ["그림", fmRedraw ? "AI로 재생성 (원본과 다를 수 있음)" : "원본 그대로 잘라 넣기"],
              ]
            : []),
          ["예상 비용", "무료 (Pro)"],
          ["예상 시간", formatDuration(estimateGenSeconds("free", fmModel, photos.length * 1500))],
        ],
        note: `Pro 기능이라 크레딧이 차감되지 않습니다. 복원은 구조·내용을 재구성하는 것이며 픽셀 단위 복제가 아닙니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const fd = new FormData();
      fd.append("type", "form-maker");
      if (promptText) fd.append("promptText", promptText);
      // 업로드 전 사진 다운스케일(업로드 안정성·속도). 실패 시 원본 사용.
      const sizedPhotos = photos.length
        ? await Promise.all(photos.map((p) => downscaleImageForUpload(p)))
        : [];
      sizedPhotos.forEach((p) => fd.append("photos", p));
      if (document.getElementById("fmFigureRedraw")?.checked) {
        fd.append("figureRedraw", "true");
      }
      fd.append(
        "layoutMode",
        document.querySelector('input[name="fmLayout"]:checked')?.value || "auto",
      );
      if (title) fd.append("title", title);
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", fmModel);
      fd.append("format", fmFormat);
      fd.append("fontFace", fmFontFace);
      fd.append("userNotes", fmUserNotes);
      appendPolicyAcknowledgements(fd);

      await submitReport({ formEl: fmForm, buttonEl: fmBtn, formData: fd, estimate: estimateGenSeconds("free", fmModel, photos.length * 1500) });
    });
  }

  // ── 프린트 PDF 복원 (관리자 전용 베타) ─────────────────────────────
  if (pprForm) {
    pprForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (runtime.currentJobId) return;
      // UI 은 서버 권한 검사를 대신하지 않지만, 숨겨진 폼을 DOM에서 강제로 연
      // 일반 계정의 제출 실수를 막는 1차 경계다. 최종 권한은 서버가 다시 검사한다.
      if (!runtime.isAdmin) {
        alert("프린트 PDF 복원은 현재 관리자 전용 베타입니다.");
        return;
      }

      const photosInput = document.getElementById("pprPhotos");
      const photos = Array.from(photosInput?.files || []);
      if (!photos.length) {
        alert("복원할 프린트 페이지 사진을 한 장 이상 올리세요.");
        photosInput?.focus();
        return;
      }
      const reference = document.getElementById("pprReference")?.files?.[0] || null;
      const pageOrder = document.getElementById("pprPageOrder")?.value.trim() || "";
      const promptText = document.getElementById("pprInstructions")?.value.trim() || "";
      const preserveLayout = document.getElementById("pprPreserveLayout")?.checked !== false;
      const semanticRedraw = document.getElementById("pprSemanticRedraw")?.checked !== false;
      const baseEstimate = estimateGenSeconds("free", "claude-opus-4-8", photos.length * 2200);
      const estimateSeconds = {
        lo: Math.max(180, Number(baseEstimate?.lo) || 0),
        hi: Math.max(180, Number(baseEstimate?.hi) || 0),
      };

      const ok = await showConfirmDialog({
        title: "프린트 PDF 복원 · 관리자 베타",
        background: pprForm,
        rows: [
          ["입력", `페이지 사진 ${photos.length}장${reference ? ", 참고 PDF 1개" : ""}`],
          ["페이지 순서", pageOrder || "선택한 파일 순서"],
          ["양식", preserveLayout ? "원본 페이지·여백·단·표 구조 유지" : "내용 중심으로 정리"],
          ["그래프·도해", semanticRedraw ? "맥락·수학적/물리적 의미를 검증해 벡터 재작성" : "원본 도형을 보존해 배치"],
          ["출력", "벡터 PDF"],
          ["품질 검사", "300dpi 렌더 · OCR 대조 · 페이지별 시각 QA"],
          ["공개 범위", "관리자 전용 베타"],
          ["예상 시간", formatDuration(estimateSeconds)],
        ],
        note: `사진을 단순히 PDF에 넣지 않고 원문·수식·표·레이아웃을 다시 구성합니다. 확인할 수 없는 값은 만들지 않습니다. ${USE_POLICY_NOTE}`,
      });
      if (!ok) return;

      const formData = new FormData();
      formData.append("type", "print-pdf-restore");
      photos.forEach((photo) => formData.append("photos", photo, photo.name));
      if (reference) formData.append("reference", reference, reference.name);
      if (pageOrder) formData.append("pageOrder", pageOrder);
      if (promptText) formData.append("promptText", promptText);
      formData.append("layoutMode", preserveLayout ? "source" : "clean");
      formData.append("semanticRedraw", semanticRedraw ? "true" : "false");
      formData.append("qualityGate", "ocr-visual-300dpi");
      formData.append("format", "pdf");
      if (runtime.studentId) formData.append("studentId", runtime.studentId);
      appendPolicyAcknowledgements(formData);

      await submitReport({
        formEl: pprForm,
        buttonEl: pprBtn,
        formData,
        estimate: estimateSeconds,
      });
    });
  }

  // ── 스킬 스튜디오 신규 베타 4종 (모두 ZIP 출력, Pro 무료) ───────────────
  function pickModel(name) {
    return (
      document.querySelector('input[name="' + name + '"]:checked')?.value ||
      "claude-opus-4-8"
    );
  }

  // 영어 시험대비 3종
  const engExamForm = document.getElementById("engExamForm");
  if (engExamForm) {
    engExamForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const files = Array.from(document.getElementById("engSource").files);
      if (!files.length) {
        alert("영어 지문 파일을 한 개 이상 올리세요.");
        return;
      }
      const fd = new FormData();
      fd.append("type", "eng-exam-prep");
      files.forEach((f) => fd.append("source", f));
      fd.append("userNotes", document.getElementById("engUserNotes").value.trim());
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", pickModel("engModel"));
      appendPolicyAcknowledgements(fd);
      await submitReport({
        formEl: engExamForm,
        buttonEl: document.getElementById("engExamBtn"),
        formData: fd,
      });
    });
  }

  // 국어(문학) 내신·모의고사
  const koreanLitForm = document.getElementById("koreanLitForm");
  if (koreanLitForm) {
    koreanLitForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const src = Array.from(document.getElementById("klSource").files);
      if (!src.length) {
        alert("학습지(판서 포함) 파일을 한 개 이상 올리세요.");
        return;
      }
      const bank = Array.from(document.getElementById("klBank").files);
      const fd = new FormData();
      fd.append("type", "korean-lit-exam");
      src.forEach((f) => fd.append("source", f));
      bank.forEach((f) => fd.append("bank", f));
      fd.append("userNotes", document.getElementById("klUserNotes").value.trim());
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", pickModel("klModel"));
      appendPolicyAcknowledgements(fd);
      await submitReport({
        formEl: koreanLitForm,
        buttonEl: document.getElementById("koreanLitBtn"),
        formData: fd,
      });
    });
  }

  // Capstone .cap 번역본
  const capTranslateForm = document.getElementById("capTranslateForm");
  if (capTranslateForm) {
    capTranslateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const cap = document.getElementById("capFile").files[0];
      if (!cap) {
        alert(".cap 파일을 올리세요.");
        return;
      }
      const fd = new FormData();
      fd.append("type", "cap-translate");
      fd.append("cap", cap);
      fd.append("targetLang", document.getElementById("capTargetLang").value || "ko");
      fd.append("model", pickModel("capModel"));
      appendPolicyAcknowledgements(fd);
      await submitReport({
        formEl: capTranslateForm,
        buttonEl: document.getElementById("capTranslateBtn"),
        formData: fd,
      });
    });
  }

  // 물리 모의고사
  const physMockForm = document.getElementById("physMockForm");
  if (physMockForm) {
    physMockForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (runtime.currentJobId) return;
      const exam = document.getElementById("pmExam").files[0];
      const textbook = document.getElementById("pmTextbook").files[0];
      if (!exam || !textbook) {
        alert("기출 시험지와 교과서 단원 PDF를 모두 올리세요.");
        return;
      }
      const rubric = document.getElementById("pmRubric").files[0];
      const fd = new FormData();
      fd.append("type", "phys-mock-exam");
      fd.append("exam", exam);
      fd.append("textbook", textbook);
      if (rubric) fd.append("rubric", rubric);
      fd.append("userNotes", document.getElementById("pmUserNotes").value.trim());
      if (runtime.studentId) fd.append("studentId", runtime.studentId);
      fd.append("model", pickModel("pmModel"));
      appendPolicyAcknowledgements(fd);
      await submitReport({
        formEl: physMockForm,
        buttonEl: document.getElementById("physMockBtn"),
        formData: fd,
      });
    });
  }


}
