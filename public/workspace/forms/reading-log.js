import { $, appendPolicy, file, selected, value } from "./common.js";

export function isReadingLogBulk() {
  return selected("rlMode", "single") === "bulk";
}

export function readReadingLogInput(studentId) {
  const bulk = isReadingLogBulk();
  const base = {
    valid: true,
    bulk,
    studentId: studentId || "",
    recordArea: value("rlRecordArea"),
    subject: value("rlSubject"),
    enrolledSubjects: value("rlEnrolled"),
    domain: value("rlDomain"),
    borrowed: value("rlBorrowed") || "no",
    model: selected("rlModel", "gpt-5.4-mini"),
    fontFace: value("rlFontFace"),
  };
  if (bulk) {
    const excel = file("rlExcel");
    if (!excel) return { ...base, valid: false, reason: "excel" };
    return {
      ...base,
      excel,
      periodStart: value("rlPeriodStart"),
      periodEnd: value("rlPeriodEnd"),
      subjectTeachers: value("rlSubjectTeachers"),
      homeroomTeacher: value("rlHomeroom"),
    };
  }
  const title = value("rlTitle");
  if (!title) return { ...base, valid: false, reason: "title" };
  return {
    ...base,
    title,
    author: value("rlAuthor"),
    publisher: value("rlPublisher"),
    startDate: value("rlStartDate"),
    endDate: value("rlEndDate"),
    userNotes: value("rlUserNotes"),
  };
}

export function buildReadingLogFormData(input) {
  const data = new FormData();
  data.append("type", input.bulk ? "reading-log-bulk" : "reading-log");
  if (input.bulk) data.append("excel", input.excel);
  else {
    data.append("title", input.title);
    if (input.author) data.append("author", input.author);
    if (input.publisher) data.append("publisher", input.publisher);
    if (input.startDate) data.append("startDate", input.startDate);
    if (input.endDate) data.append("endDate", input.endDate);
    if (input.userNotes) data.append("userNotes", input.userNotes);
  }
  if (input.recordArea) data.append("recordArea", input.recordArea);
  if (input.recordArea === "subject" && input.subject) data.append("subject", input.subject);
  if (input.recordArea === "auto" && input.enrolledSubjects) data.append("enrolledSubjects", input.enrolledSubjects);
  if (input.subjectTeachers) data.append("subjectTeachers", input.subjectTeachers);
  if (input.homeroomTeacher) data.append("homeroomTeacher", input.homeroomTeacher);
  if (input.domain) data.append("domain", input.domain);
  data.append("borrowed", input.borrowed);
  if (input.periodStart) data.append("periodStart", input.periodStart);
  if (input.periodEnd) data.append("periodEnd", input.periodEnd);
  if (input.studentId) data.append("studentId", input.studentId);
  data.append("model", input.model);
  data.append("format", "hwpx");
  data.append("fontFace", input.fontFace);
  appendPolicy(data);
  return data;
}
