import { appendFiles, appendPolicy, appendSlashDate, file, files, selected, sumBytes, value } from "./common.js";

export function readFreeInput(studentId) {
  const instructions = value("frInstructions");
  if (!instructions) return { valid: false, reason: "instructions" };
  const attachments = files("frFiles");
  const photos = files("frPhotos");
  return {
    valid: true,
    instructions,
    grading: value("frGrading"),
    title: value("frTitle"),
    refLinks: value("frRefLinks"),
    attachments,
    photos,
    photoBytes: sumBytes(photos),
    styleRefs: files("frStyleRefs"),
    styleNote: value("frStyleNote"),
    model: selected("frModel", "claude-opus-4-8"),
    format: selected("frFormat", "hwpx"),
    fontFace: value("frFontFace"),
    userNotes: value("frUserNotes"),
    userNotesFile: file("frUserNotesFile"),
    date: value("frDate"),
    studentId: studentId || "",
  };
}

export function buildFreeFormData(input, finalModel = input.model) {
  const data = new FormData();
  data.append("type", "free");
  data.append("instructions", input.instructions);
  if (input.grading) data.append("gradingCriteria", input.grading);
  if (input.title) data.append("title", input.title);
  if (input.refLinks) data.append("refLinks", input.refLinks);
  appendFiles(data, "files", input.attachments);
  appendFiles(data, "photos", input.photos);
  appendFiles(data, "styleRefs", input.styleRefs);
  if (input.styleNote) data.append("styleNote", input.styleNote);
  appendSlashDate(data, "date", input.date);
  if (input.studentId) data.append("studentId", input.studentId);
  data.append("model", finalModel);
  data.append("format", input.format);
  data.append("fontFace", input.fontFace);
  data.append("userNotes", input.userNotes);
  if (input.userNotesFile) data.append("userNotesFile", input.userNotesFile);
  appendPolicy(data);
  return data;
}
