import { appendFiles, appendPolicy, appendSlashDate, file, files, selected, sumBytes, value } from "./common.js";

export function readChemResultInput(studentId) {
  const preReport = file("crPreReport");
  if (!preReport) return { valid: false, reason: "preReport" };
  const photos = files("crPhotos");
  return {
    valid: true,
    preReport,
    dataFile: file("crData"),
    photos,
    photoBytes: sumBytes(photos),
    manual: file("crManual"),
    styleRefs: files("crStyleRefs"),
    styleNote: value("crStyleNote"),
    model: selected("crModel", "claude-opus-4-8"),
    style: selected("crStyle", "default"),
    format: selected("crFormat", "hwpx"),
    fontFace: value("crFontFace"),
    userNotes: value("crUserNotes"),
    userNotesFile: file("crUserNotesFile"),
    date: value("crDate"),
    temperature: value("crTemp"),
    pressure: value("crPressure"),
    studentId: studentId || "",
  };
}

export function buildChemResultFormData(input, finalModel = input.model) {
  const data = new FormData();
  data.append("type", "chem-result");
  appendFiles(data, "styleRefs", input.styleRefs);
  if (input.styleNote) data.append("styleNote", input.styleNote);
  data.append("preReport", input.preReport);
  if (input.dataFile) data.append("data", input.dataFile);
  appendFiles(data, "photos", input.photos);
  if (input.manual) data.append("manual", input.manual);
  appendSlashDate(data, "date", input.date);
  data.append("temperature", input.temperature);
  data.append("pressure", input.pressure);
  data.append("studentId", input.studentId);
  data.append("model", finalModel);
  data.append("style", input.style);
  data.append("format", input.format);
  data.append("fontFace", input.fontFace);
  data.append("userNotes", input.userNotes);
  if (input.userNotesFile) data.append("userNotesFile", input.userNotesFile);
  appendPolicy(data);
  return data;
}
