import { $, appendFiles, appendPolicy, appendSlashDate, file, files, selected, value } from "./common.js";

export function readChemPreInput(studentId) {
  const manual = file("manual");
  if (!manual) return { valid: false, reason: "manual" };
  return {
    valid: true,
    manual,
    model: selected("model", "claude-opus-4-8"),
    format: selected("format", "hwpx"),
    fontFace: value("fontFace"),
    style: selected("style", "default"),
    styleRefs: files("cpStyleRefs"),
    styleNote: value("cpStyleNote"),
    userNotes: value("preUserNotes"),
    userNotesFile: file("preUserNotesFile"),
    allowImageGen: !!$("cpAllowImageGen")?.checked,
    date: value("date"),
    studentId: studentId || "",
    studentName: value("studentName"),
    temperature: value("temperature"),
    pressure: value("pressure"),
  };
}

export function buildChemPreFormData(input, finalModel = input.model) {
  const data = new FormData();
  data.append("type", "chem-pre");
  appendFiles(data, "styleRefs", input.styleRefs);
  if (input.styleNote) data.append("styleNote", input.styleNote);
  data.append("manual", input.manual);
  appendSlashDate(data, "date", input.date);
  data.append("model", finalModel);
  data.append("format", input.format);
  data.append("allowImageGen", input.allowImageGen ? "true" : "false");
  data.append("style", input.style);
  data.append("fontFace", input.fontFace);
  data.append("userNotes", input.userNotes);
  if (input.userNotesFile) data.append("userNotesFile", input.userNotesFile);
  data.append("studentId", input.studentId);
  data.append("studentName", input.studentName);
  data.append("temperature", input.temperature);
  data.append("pressure", input.pressure);
  appendPolicy(data);
  return data;
}
