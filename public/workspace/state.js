const initialState = Object.freeze({
  auth: "pending",
  view: "landing",
  user: null,
  studentId: "",
  reportEligible: true,
  reportType: "",
});

export function normalizeStudentId(value) {
  return String(value || "").trim().slice(0, 20);
}

export function createWorkspaceState() {
  let value = { ...initialState };
  const listeners = new Set();
  return {
    get: () => ({ ...value }),
    set(patch) {
      value = { ...value, ...patch };
      listeners.forEach((listener) => listener({ ...value }));
      return { ...value };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function getStoredStudentId() {
  try { return normalizeStudentId(localStorage.getItem("studentId") || ""); }
  catch (_) { return ""; }
}

export function storeStudentId(value) {
  try { localStorage.setItem("studentId", normalizeStudentId(value)); }
  catch (_) {}
}

export function getStoredStyleNote() {
  try { return localStorage.getItem("quiloStyleNote") || ""; }
  catch (_) { return ""; }
}

export function storeStyleNote(value) {
  try { localStorage.setItem("quiloStyleNote", value || ""); }
  catch (_) {}
}
