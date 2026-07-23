import { appendFiles, appendPolicy, appendSlashDate, file, files, selected, sumBytes, value } from "./common.js";

export function readPhysResultInput(studentId) {
  const cap = file("prCap");
  const dataFiles = files("prData");
  const photos = files("prPhotos");
  if (!cap && !dataFiles.length && !photos.length) return { valid: false, reason: "source" };
  if (!studentId) return { valid: false, reason: "studentId" };
  return {
    valid: true,
    cap,
    dataFiles,
    dataFileBytes: sumBytes(dataFiles),
    manual: file("prManual"),
    photos,
    photoBytes: sumBytes(photos),
    styleRefs: files("prStyleRefs"),
    styleNote: value("prStyleNote"),
    model: selected("prModel", "claude-opus-4-8"),
    format: selected("prFormat", "hwpx"),
    fontFace: value("prFontFace"),
    userNotes: value("prUserNotes"),
    userNotesFile: file("prUserNotesFile"),
    date: value("prDate"),
    studentId,
  };
}

export function buildPhysResultFormData(input, finalModel = input.model) {
  const data = new FormData();
  data.append("type", "phys-result");
  appendFiles(data, "styleRefs", input.styleRefs);
  if (input.styleNote) data.append("styleNote", input.styleNote);
  if (input.cap) data.append("cap", input.cap);
  appendFiles(data, "data", input.dataFiles);
  if (input.manual) data.append("manual", input.manual);
  appendFiles(data, "photos", input.photos);
  appendSlashDate(data, "date", input.date);
  data.append("studentId", input.studentId);
  data.append("model", finalModel);
  data.append("format", input.format);
  data.append("fontFace", input.fontFace);
  data.append("userNotes", input.userNotes);
  if (input.userNotesFile) data.append("userNotesFile", input.userNotesFile);
  appendPolicy(data);
  return data;
}
