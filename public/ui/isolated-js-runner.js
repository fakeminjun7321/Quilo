(function initIsolatedJsRunner(global) {
  "use strict";

  var DEFAULT_TIMEOUT_MS = 3000;
  var MAX_TIMEOUT_MS = 10000;

  function workerMain() {
    "use strict";

    var send = self.postMessage.bind(self);
    var listen = self.addEventListener.bind(self);
    var evaluate = (0, eval);
    var MAX_LOG_LINES = 120;
    var MAX_LOG_LINE_CHARS = 2000;
    var MAX_LOG_TOTAL_CHARS = 20000;
    var MAX_RESULT_CHARS = 4000;
    var logs = [];
    var logChars = 0;
    var outputTruncated = false;

    function securityError(name) {
      var error = new Error(name + " API는 격리된 JavaScript 실행에서 사용할 수 없습니다.");
      error.name = "SecurityError";
      return error;
    }

    function denied(name) {
      return function deniedApi() {
        throw securityError(name);
      };
    }

    function lockConstructor(prototype, name) {
      if (!prototype) return;
      try {
        Object.defineProperty(prototype, "constructor", {
          value: denied(name),
          writable: false,
          configurable: false,
        });
      } catch (_) {}
    }

    function lockGlobal(name, replacement) {
      var cursor = self;
      while (cursor) {
        var descriptor;
        try { descriptor = Object.getOwnPropertyDescriptor(cursor, name); } catch (_) { descriptor = null; }
        if (descriptor && descriptor.configurable) {
          try {
            Object.defineProperty(cursor, name, {
              value: replacement,
              writable: false,
              configurable: false,
              enumerable: false,
            });
          } catch (_) { /* keep walking and install an own shadow below */ }
        }
        try { cursor = Object.getPrototypeOf(cursor); } catch (_) { cursor = null; }
      }
      try {
        Object.defineProperty(self, name, {
          value: replacement,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      } catch (_) {
        try { self[name] = replacement; } catch (_) { /* unavailable API */ }
      }
    }

    function formatValue(value, limit) {
      var text;
      if (typeof value === "string") text = value;
      else if (typeof value === "undefined") text = "undefined";
      else if (typeof value === "bigint") text = String(value) + "n";
      else if (typeof value === "symbol" || typeof value === "function") text = String(value);
      else if (value instanceof Error) text = value.name + ": " + value.message;
      else {
        try {
          var seen = [];
          text = JSON.stringify(value, function (_key, item) {
            if (typeof item === "bigint") return String(item) + "n";
            if (item && typeof item === "object") {
              if (seen.indexOf(item) !== -1) return "[Circular]";
              seen.push(item);
            }
            return item;
          });
        } catch (_) {
          try { text = String(value); } catch (_) { text = "[표시할 수 없는 값]"; }
        }
      }
      if (typeof text !== "string") {
        try { text = String(value); } catch (_) { text = "[표시할 수 없는 값]"; }
      }
      if (text.length > limit) return text.slice(0, Math.max(0, limit - 1)) + "…";
      return text;
    }

    function appendLog(level, values) {
      if (outputTruncated) return;
      var prefix = level === "warn" || level === "error" ? "⚠ " : "";
      var line = prefix + Array.prototype.map.call(values, function (value) {
        return formatValue(value, MAX_LOG_LINE_CHARS);
      }).join(" ");
      line = line.slice(0, MAX_LOG_LINE_CHARS);
      if (logs.length >= MAX_LOG_LINES || logChars + line.length > MAX_LOG_TOTAL_CHARS) {
        outputTruncated = true;
        logs.push("… 출력이 안전 한도를 넘어 잘렸습니다.");
        return;
      }
      logs.push(line);
      logChars += line.length;
    }

    var safeConsole = Object.freeze({
      log: function () { appendLog("log", arguments); },
      info: function () { appendLog("info", arguments); },
      debug: function () { appendLog("debug", arguments); },
      warn: function () { appendLog("warn", arguments); },
      error: function () { appendLog("error", arguments); },
      clear: function () { logs.length = 0; logChars = 0; outputTruncated = false; },
    });

    var blockedApis = [
      "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream", "EventSource", "WebTransport",
      "RTCPeerConnection", "webkitRTCPeerConnection", "importScripts", "Worker", "SharedWorker",
      "BroadcastChannel", "MessageChannel", "postMessage", "close", "indexedDB", "caches",
      "cookieStore", "localStorage", "sessionStorage", "StorageManager", "CacheStorage", "IDBFactory",
      "FileSystemHandle", "FileSystemFileHandle", "FileSystemDirectoryHandle", "showOpenFilePicker",
      "showSaveFilePicker", "showDirectoryPicker", "Notification", "location",
    ];
    blockedApis.forEach(function (name) { lockGlobal(name, denied(name)); });
    lockGlobal("navigator", Object.freeze({
      language: "ko-KR",
      languages: Object.freeze(["ko-KR"]),
      onLine: false,
      userAgent: "Quilo isolated JavaScript runner",
    }));
    lockGlobal("console", safeConsole);
    lockGlobal("eval", denied("eval"));
    // global Function을 가려도 (() => {}).constructor 같은 우회로 새 코드를 만들 수
    // 있다. 일반/async/generator 함수 prototype의 constructor도 함께 닫는다.
    lockConstructor(Function.prototype, "Function constructor");
    lockConstructor(Object.getPrototypeOf(async function () {}), "AsyncFunction constructor");
    lockConstructor(Object.getPrototypeOf(function* () {}), "GeneratorFunction constructor");
    lockConstructor(Object.getPrototypeOf(async function* () {}), "AsyncGeneratorFunction constructor");
    lockGlobal("Function", denied("Function"));

    listen("message", async function runMessage(event) {
      var payload = event && event.data;
      if (!payload || payload.type !== "run") return;
      try {
        var code = String(payload.code || "");
        // import()는 fetch를 거치지 않고 same-origin 쿠키가 붙은 모듈 요청을 만들 수
        // 있으므로 금지한다. Function 계열 constructor를 먼저 잠가 문자열 조립 우회도 막는다.
        if (/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/u.test(code)) {
          throw securityError("dynamic import");
        }
        var result = evaluate(code);
        if (result && typeof result.then === "function") result = await result;
        send({
          type: "complete",
          logs: logs,
          hasResult: typeof result !== "undefined",
          result: typeof result === "undefined" ? "" : formatValue(result, MAX_RESULT_CHARS),
          error: "",
        });
      } catch (error) {
        send({
          type: "complete",
          logs: logs,
          hasResult: false,
          result: "",
          error: error && error.message ? String(error.message) : formatValue(error, MAX_RESULT_CHARS),
        });
      }
    });
  }

  var WORKER_SOURCE = "\"use strict\";(" + workerMain.toString() + ")();";

  function normalizeTimeout(value) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, Math.max(100, Math.floor(parsed)));
  }

  function run(code, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      if (typeof global.Worker !== "function" || typeof global.Blob !== "function") {
        reject(new Error("이 브라우저에서는 격리된 JavaScript 실행을 지원하지 않습니다."));
        return;
      }

      var workerUrl;
      var worker;
      try {
        workerUrl = global.URL.createObjectURL(new global.Blob([WORKER_SOURCE], { type: "text/javascript" }));
        worker = new global.Worker(workerUrl, { name: "quilo-isolated-js" });
      } catch (error) {
        if (workerUrl) global.URL.revokeObjectURL(workerUrl);
        reject(error);
        return;
      }
      global.URL.revokeObjectURL(workerUrl);

      var settled = false;
      var timeoutMs = normalizeTimeout(options.timeoutMs);
      var timer = global.setTimeout(function () {
        if (settled) return;
        settled = true;
        worker.terminate();
        resolve({
          logs: [],
          hasResult: false,
          result: "",
          error: "실행 시간이 " + (timeoutMs / 1000).toFixed(1).replace(/\.0$/, "") + "초를 초과해 중지되었습니다.",
          timedOut: true,
        });
      }, timeoutMs);

      function finish(result) {
        if (settled) return;
        settled = true;
        global.clearTimeout(timer);
        worker.terminate();
        resolve(result);
      }

      worker.onmessage = function (event) {
        var data = event && event.data;
        if (!data || data.type !== "complete") return;
        finish({
          logs: Array.isArray(data.logs) ? data.logs.slice(0, 121).map(String) : [],
          hasResult: data.hasResult === true,
          result: data.hasResult === true ? String(data.result || "") : "",
          error: data.error ? String(data.error) : "",
          timedOut: false,
        });
      };
      worker.onerror = function (event) {
        if (event && typeof event.preventDefault === "function") event.preventDefault();
        finish({
          logs: [],
          hasResult: false,
          result: "",
          error: "격리된 JavaScript 실행 중 오류가 발생했습니다.",
          timedOut: false,
        });
      };
      worker.postMessage({ type: "run", code: String(code || "") });
    });
  }

  function formatOutput(execution) {
    var lines = execution && Array.isArray(execution.logs) ? execution.logs.slice() : [];
    if (execution && execution.error) lines.push("⚠ " + execution.error);
    if (execution && execution.hasResult) lines.push("→ " + execution.result);
    return lines.join("\n") || "(출력 없음)";
  }

  global.QuiloIsolatedJsRunner = Object.freeze({
    run: run,
    formatOutput: formatOutput,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  });
})(window);
