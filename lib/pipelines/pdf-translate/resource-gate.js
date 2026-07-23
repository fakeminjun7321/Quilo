"use strict";

// Process-wide safety defaults. The API default is deliberately below the existing
// per-job limit (12), while document work is kept low because each permit may own a
// Python process, rendered pages, and a sizeable PDF buffer.
const DEFAULT_GLOBAL_API_CONCURRENCY = 6;
const DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY = 2;

function parseConcurrency(value, fallback) {
  const safeFallback = Number.isSafeInteger(fallback) && fallback > 0 ? fallback : 1;
  if (value == null || String(value).trim() === "") return safeFallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return safeFallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : safeFallback;
}

function makeAbortError() {
  const error = new Error("작업이 중단되었습니다.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortSignal(signal) {
  return !!signal &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function";
}

/**
 * Abort-aware FIFO semaphore.
 *
 * A queued task is removed and rejected as soon as its signal aborts. Once a task
 * starts, cancellation remains the task's responsibility (the same signal is
 * already passed to model/Python callers). Both completion paths release the permit
 * before settling the public promise, including synchronous throws and rejections.
 */
function createFifoSemaphore(maxConcurrency) {
  const capacity = parseConcurrency(maxConcurrency, 1);
  let active = 0;
  const queue = [];

  const removeAbortListener = (entry) => {
    if (entry.onAbort && isAbortSignal(entry.signal)) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    entry.onAbort = null;
  };

  const pump = () => {
    while (active < capacity && queue.length) {
      const entry = queue.shift();
      if (entry.cancelled) continue;
      entry.started = true;
      removeAbortListener(entry);
      active += 1;

      Promise.resolve()
        .then(entry.task)
        .then((value) => {
          active -= 1;
          pump();
          entry.resolve(value);
        }, (error) => {
          active -= 1;
          pump();
          entry.reject(error);
        });
    }
  };

  const run = (task, { signal } = {}) => {
    if (typeof task !== "function") {
      return Promise.reject(new TypeError("semaphore task must be a function"));
    }
    if (signal?.aborted) return Promise.reject(makeAbortError());

    return new Promise((resolve, reject) => {
      const entry = {
        task,
        signal,
        resolve,
        reject,
        started: false,
        cancelled: false,
        onAbort: null,
      };

      if (isAbortSignal(signal)) {
        entry.onAbort = () => {
          if (entry.started || entry.cancelled) return;
          entry.cancelled = true;
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          removeAbortListener(entry);
          reject(makeAbortError());
          // Removing a queued entry can expose the next FIFO waiter when a permit
          // is available (for example, if cancellation races with enqueue/pump).
          pump();
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }

      queue.push(entry);
      pump();
    });
  };

  return Object.freeze({
    capacity,
    run,
    stats() {
      return { capacity, active, queued: queue.length };
    },
  });
}

function createPdfTranslateResourceLimits(options = {}) {
  const env = options.env || process.env;
  const apiConcurrency = parseConcurrency(
    options.apiConcurrency ?? env.PDF_TRANSLATE_GLOBAL_API_CONCURRENCY,
    DEFAULT_GLOBAL_API_CONCURRENCY,
  );
  const documentConcurrency = parseConcurrency(
    options.documentConcurrency ?? env.PDF_TRANSLATE_GLOBAL_DOCUMENT_CONCURRENCY,
    DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY,
  );
  const api = createFifoSemaphore(apiConcurrency);
  const document = createFifoSemaphore(documentConcurrency);

  return Object.freeze({
    apiConcurrency,
    documentConcurrency,
    runApi(task, opts) {
      return api.run(task, opts);
    },
    runDocument(task, opts) {
      return document.run(task, opts);
    },
    stats() {
      return { api: api.stats(), document: document.stats() };
    },
  });
}

// Lazily initialized so importing translate.js does not freeze test-provided env
// values. Tests that need distinct limits should inject a factory-created instance.
let processWideResourceLimits = null;
function getProcessWidePdfTranslateResourceLimits() {
  if (!processWideResourceLimits) {
    processWideResourceLimits = createPdfTranslateResourceLimits();
  }
  return processWideResourceLimits;
}

module.exports = {
  DEFAULT_GLOBAL_API_CONCURRENCY,
  DEFAULT_GLOBAL_DOCUMENT_CONCURRENCY,
  parseConcurrency,
  makeAbortError,
  createFifoSemaphore,
  createPdfTranslateResourceLimits,
  getProcessWidePdfTranslateResourceLimits,
};
