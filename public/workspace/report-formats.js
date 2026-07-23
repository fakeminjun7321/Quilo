function selectedValue(selector, fallback) {
  return document.querySelector(selector)?.value || fallback;
}

export const getChemPreFormat = () => selectedValue('#form input[name="format"]:checked, #form input[name="format"][type="hidden"]', "docx");
export const getChemResultFormat = () => selectedValue('#chemResultForm input[name="crFormat"]:checked, #chemResultForm input[name="crFormat"][type="hidden"]', "docx");
export const getPhysResultFormat = () => selectedValue('#physResultForm input[name="prFormat"]:checked, #physResultForm input[name="prFormat"][type="hidden"]', "docx");
export const getPhysInquiryFormat = () => selectedValue('#physInquiryForm input[name="piFormat"]:checked, #physInquiryForm input[name="piFormat"][type="hidden"]', "hwpx");
export const getMathInquiryFormat = () => selectedValue('#mathInquiryForm input[name="miFormat"]:checked, #mathInquiryForm input[name="miFormat"][type="hidden"]', "hwpx");
export const getFreeFormat = () => selectedValue('#freeForm input[name="frFormat"]:checked, #freeForm input[name="frFormat"][type="hidden"]', "docx");
export const getFormMakerFormat = () => selectedValue('#formMakerForm input[name="fmFormat"]:checked, #formMakerForm input[name="fmFormat"][type="hidden"]', "hwpx");

function updateHwpxOnlyFontOptions(selectId, format) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const allowHwpxOnly = format === "hwpx";
  select.querySelectorAll('option[data-hwpx-only="true"]').forEach((option) => {
    option.hidden = !allowHwpxOnly;
    option.disabled = !allowHwpxOnly;
    if (!option.dataset.baseLabel) option.dataset.baseLabel = option.textContent;
    option.textContent = allowHwpxOnly ? option.dataset.baseLabel : `${option.dataset.baseLabel} (한글 전용)`;
  });
  const selected = select.options[select.selectedIndex];
  const autoSwitched = !allowHwpxOnly && selected?.dataset.hwpxOnly === "true";
  if (autoSwitched) select.value = "malgun-gothic";
  let note = select.parentNode?.querySelector(":scope > .font-fallback-note");
  if (autoSwitched) {
    if (!note) {
      note = document.createElement("small");
      note.className = "font-fallback-note";
      select.parentNode?.appendChild(note);
    }
    note.textContent = "선택한 글꼴은 한글(.hwpx) 전용이라 .docx에서는 맑은 고딕으로 표시됩니다.";
    note.hidden = false;
  } else if (note) note.hidden = true;
}

export const updateChemPreFontOptions = () => updateHwpxOnlyFontOptions("fontFace", getChemPreFormat());
export const updateChemResultFontOptions = () => updateHwpxOnlyFontOptions("crFontFace", getChemResultFormat());
export const updatePhysResultFontOptions = () => updateHwpxOnlyFontOptions("prFontFace", getPhysResultFormat());
export const updatePhysInquiryFontOptions = () => updateHwpxOnlyFontOptions("piFontFace", getPhysInquiryFormat());
export const updateMathInquiryFontOptions = () => updateHwpxOnlyFontOptions("miFontFace", getMathInquiryFormat());
export const updateReadingLogFontOptions = () => updateHwpxOnlyFontOptions("rlFontFace", "hwpx");
export const updateFreeFontOptions = () => updateHwpxOnlyFontOptions("frFontFace", getFreeFormat());
export const updateFormMakerFontOptions = () => updateHwpxOnlyFontOptions("fmFontFace", getFormMakerFormat());

export function initFormatControls() {
  const controls = [
    ["#form", "format", updateChemPreFontOptions],
    ["#chemResultForm", "crFormat", updateChemResultFontOptions],
    ["#physResultForm", "prFormat", updatePhysResultFontOptions],
    ["#physInquiryForm", "piFormat", updatePhysInquiryFontOptions],
    ["#mathInquiryForm", "miFormat", updateMathInquiryFontOptions],
    ["#freeForm", "frFormat", updateFreeFontOptions],
    ["#formMakerForm", "fmFormat", updateFormMakerFontOptions],
  ];
  controls.forEach(([formSelector, name, update]) => {
    document.querySelectorAll(`${formSelector} input[name="${name}"]`).forEach((input) => input.addEventListener("change", update));
    update();
  });
  updateReadingLogFontOptions();
}
