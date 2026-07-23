"use strict";

function abortError() {
  const error = new Error("작업이 중단되었습니다.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function queueError(code, message) {
  const error = new Error(message);
  error.name = "GenerationQueueError";
  error.code = code;
  error.status = 503;
  return error;
}

class GenerationSemaphore {
  constructor(max, { maxQueue = 20, waitTimeoutMs = 10 * 60 * 1000 } = {}) {
    this.max = Math.max(1, Math.trunc(Number(max) || 1));
    this.maxQueue = Math.max(0, Math.trunc(Number(maxQueue) || 0));
    this.waitTimeoutMs = Math.max(0, Math.trunc(Number(waitTimeoutMs) || 0));
    this.active = 0;
    this.queue = [];
  }

  acquire({ signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.active >= this.max && this.queue.length >= this.maxQueue) {
      return Promise.reject(
        queueError(
          "GENERATION_QUEUE_FULL",
          "생성 대기열이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        signal,
        onAbort: null,
        timer: null,
        granted: false,
      };
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        if (entry.onAbort) signal?.removeEventListener("abort", entry.onAbort);
      };
      const grant = () => {
        entry.granted = true;
        cleanup();
        this.active += 1;
        resolve();
      };
      if (this.active < this.max) {
        grant();
        return;
      }
      if (signal?.addEventListener) {
        entry.onAbort = () => {
          if (entry.granted) return;
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          cleanup();
          reject(abortError());
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      if (this.waitTimeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (entry.granted) return;
          const index = this.queue.indexOf(entry);
          if (index !== -1) this.queue.splice(index, 1);
          cleanup();
          reject(
            queueError(
              "GENERATION_QUEUE_TIMEOUT",
              "생성 대기 시간이 너무 길어 요청을 종료했습니다. 잠시 후 다시 시도해 주세요.",
            ),
          );
        }, this.waitTimeoutMs);
        if (typeof entry.timer.unref === "function") entry.timer.unref();
      }
      this.queue.push(entry);
    });
  }

  release() {
    while (this.queue.length) {
      const entry = this.queue.shift();
      if (entry.signal?.aborted) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
        entry.reject(abortError());
        continue;
      }
      entry.granted = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.onAbort) entry.signal?.removeEventListener("abort", entry.onAbort);
      // The released permit is transferred directly, so active is unchanged.
      entry.resolve();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  get waiting() {
    return this.queue.length;
  }
}

module.exports = { GenerationSemaphore, abortError, queueError };
