(function (global) {
  "use strict";

  function node(value) {
    if (!value) return null;
    return typeof value === "string" ? document.querySelector(value) : value;
  }

  async function readJson(response) {
    try { return await response.json(); }
    catch (_) { return {}; }
  }

  function action(label, href, primary) {
    return '<a class="btn ' + (primary ? 'btn-primary' : 'secondary') + '" href="' + href + '">' + label + '</a>';
  }

  function render(gate, state, options) {
    if (!gate) return;
    var title = "접근 권한을 확인하고 있습니다";
    var body = "잠시만 기다려 주세요.";
    var actions = "";
    if (state === "logged-out") {
      title = options.loggedOutTitle || "로그인이 필요합니다";
      body = options.loggedOutMessage || "이 기능은 로그인 후 사용할 수 있습니다.";
      actions = action("로그인", "/login.html?next=" + encodeURIComponent(location.pathname + location.search), true) + action("홈으로", "/", false);
    } else if (state === "forbidden") {
      title = options.forbiddenTitle || "이 기능을 사용할 권한이 없습니다";
      body = options.forbiddenMessage || "현재 계정의 이용 등급을 확인하거나 관리자에게 권한을 요청해 주세요.";
      actions = action("계정 확인", "/#settings", true) + action("홈으로", "/", false);
    } else if (state === "error") {
      title = options.errorTitle || "권한 확인을 완료하지 못했습니다";
      body = options.errorMessage || "잠시 후 다시 시도해 주세요. 입력한 내용은 변경되지 않습니다.";
      actions = '<button type="button" class="btn btn-primary" data-entitlement-retry>다시 시도</button>' + action("홈으로", "/", false);
    }
    gate.classList.add("app-entitlement");
    gate.hidden = false;
    gate.setAttribute("data-entitlement-state", state);
    gate.setAttribute("aria-live", "polite");
    gate.innerHTML = state === "loading"
      ? '<div class="app-loading-line"><span class="app-entitlement__spinner" aria-hidden="true"></span><span>' + title + '</span></div>'
      : '<p class="app-entitlement__eyebrow">Quilo access</p><h2>' + title + '</h2><p>' + body + '</p><div class="app-entitlement__actions">' + actions + '</div>';
  }

  async function requireAccess(options) {
    options = options || {};
    var gate = node(options.gate);
    var content = node(options.content);
    var lastShellState = global.QuiloShellAuth && global.QuiloShellAuth.current
      ? global.QuiloShellAuth.current().state
      : "pending";
    var running = null;
    if (content) content.hidden = true;
    render(gate, "loading", options);

    function showGate(state) {
      if (content) content.hidden = true;
      render(gate, state, options);
    }

    async function runOnce() {
      try {
        var me;
        if (global.QuiloShellAuth && global.QuiloShellAuth.ready) {
          var currentSession = global.QuiloShellAuth.current ? global.QuiloShellAuth.current() : null;
          var shellSession = currentSession && currentSession.state !== "pending"
            ? currentSession
            : await global.QuiloShellAuth.ready;
          lastShellState = shellSession.state;
          if (shellSession.state === "anonymous") {
            showGate("logged-out");
            return { allowed: false, state: "logged-out" };
          }
          if (shellSession.state !== "authenticated") throw new Error("me:unknown");
          me = shellSession.user;
        } else {
          var meResponse = await fetch("/api/me", { cache: "no-store", credentials: "same-origin" });
          if (meResponse.status === 401) {
            showGate("logged-out");
            return { allowed: false, state: "logged-out" };
          }
          if (!meResponse.ok) throw new Error("me:" + meResponse.status);
          me = await readJson(meResponse);
        }
        var allowed = !!(me.isAdmin || me.admin);
        var reason = allowed ? "admin" : "";
        var details = null;

        if (options.accessEndpoint) {
          var accessResponse = await fetch(options.accessEndpoint, { cache: "no-store", credentials: "same-origin" });
          if (accessResponse.status === 401) {
            showGate("logged-out");
            return { allowed: false, state: "logged-out", me: me };
          }
          if (!accessResponse.ok) throw new Error("access:" + accessResponse.status);
          details = await readJson(accessResponse);
          allowed = details.allowed === true;
          reason = details.reason || reason;
        } else if (options.feature) {
          var betaResponse = await fetch("/api/me/beta", { cache: "no-store", credentials: "same-origin" });
          if (betaResponse.status === 401) {
            showGate("logged-out");
            return { allowed: false, state: "logged-out", me: me };
          }
          if (!betaResponse.ok) throw new Error("beta:" + betaResponse.status);
          details = await readJson(betaResponse);
          var features = Array.isArray(details.features) ? details.features : [];
          var tier = String(details.tier || me.tier || "").toLowerCase();
          allowed = allowed || details.admin === true || tier === "max" || features.indexOf(options.feature) >= 0;
          reason = details.admin === true ? "admin" : (tier === "max" ? "max" : (allowed ? "feature" : ""));
        }

        if (!allowed) {
          showGate("forbidden");
          return { allowed: false, state: "forbidden", me: me, details: details };
        }
        if (gate) gate.hidden = true;
        if (content) content.hidden = false;
        return { allowed: true, state: "ready", me: me, details: details, reason: reason };
      } catch (error) {
        showGate("error");
        var retry = gate && gate.querySelector("[data-entitlement-retry]");
        if (retry) retry.addEventListener("click", function () { run(); }, { once: true });
        return { allowed: false, state: "error", error: error };
      }
    }

    function run() {
      if (running) return running;
      running = runOnce().finally(function () { running = null; });
      return running;
    }

    document.addEventListener("quilo:auth-state", function (event) {
      var nextState = event.detail && event.detail.state;
      var previousState = lastShellState;
      if (nextState) lastShellState = nextState;
      if (previousState === "anonymous" && nextState === "authenticated") {
        // The page-specific initializer returned while access was denied. Reload once
        // so authenticated users receive the fully initialized application, not only
        // newly visible markup.
        location.reload();
        return;
      }
      void run();
    });

    return run();
  }

  global.QuiloEntitlement = { require: requireAccess };
})(window);
