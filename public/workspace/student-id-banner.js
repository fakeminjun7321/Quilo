const REQUIRED_STUDENT_ID_FORMS = ["phys-result", "phys-inquiry", "math-inquiry"];

export function createStudentIdBannerController({ getStudentId, showTab }) {
  function ensure(form) {
    if (!form) return null;
    let banner = form.querySelector(":scope > .studentid-banner");
    if (banner) return banner;
    banner = document.createElement("div");
    banner.className = "notice studentid-banner";
    banner.hidden = true;
    const copy = document.createElement("span");
    copy.append("🎓 표지에 들어갈 ");
    const strong = document.createElement("b");
    strong.textContent = "학번";
    copy.append(strong, "이 없어요. 저장하면 보고서 표지·파일명에 자동으로 들어갑니다.");
    const action = document.createElement("button");
    action.type = "button";
    action.className = "link-button studentid-banner-link";
    action.textContent = "설정에서 학번 추가 →";
    action.addEventListener("click", () => {
      showTab?.("settings");
      const input = document.getElementById("settingsStudentIdInput");
      if (!input) return;
      try { input.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (_) {}
      input.focus();
    });
    banner.append(copy, action);
    const flow = form.querySelector(":scope > .form-flow-steps");
    if (flow?.nextSibling) form.insertBefore(banner, flow.nextSibling);
    else form.insertBefore(banner, form.firstChild);
    return banner;
  }

  function update() {
    const missing = !getStudentId?.();
    REQUIRED_STUDENT_ID_FORMS.forEach((type) => {
      const banner = ensure(document.querySelector(`[data-report-form="${type}"]`));
      if (banner) banner.hidden = !missing;
    });
  }

  return { update };
}
