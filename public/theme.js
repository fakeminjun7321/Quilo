/* 라이트/다크 테마 토글.
 * FOUC 방지용 초기 적용은 각 페이지 <head>의 인라인 미니 스크립트가 담당하고,
 * 이 파일은 #themeToggle 버튼 동작과 시스템 설정 추종을 맡는다.
 */
(function () {
  "use strict";
  var KEY = "theme";
  var root = document.documentElement;

  function systemPref() {
    return window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function stored() {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  }

  function current() {
    return root.getAttribute("data-theme") || stored() || systemPref();
  }

  function syncButton(theme) {
    var dark = theme === "dark";
    var label = dark ? "라이트 모드로 전환" : "다크 모드로 전환";
    document.querySelectorAll("[data-ui-theme], #themeToggle").forEach(function (btn) {
      btn.setAttribute("aria-pressed", dark ? "true" : "false");
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
      if (btn.hasAttribute("data-ui-theme")) {
        var icon = btn.querySelector("span") || btn;
        icon.textContent = dark ? "☀️" : "🌙";
      }
    });
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
    syncButton(theme);
    document.dispatchEvent(new CustomEvent("quilo:theme-change", { detail: { theme: theme } }));
  }

  function set(theme) {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch (_) {
      /* private mode 등 */
    }
  }

  // 로드 시 현재 상태로 버튼 동기화 (head 스크립트가 이미 data-theme 설정)
  apply(current());

  // 이벤트 위임: 버튼이 헤더 어디에 있든 동작
  document.addEventListener("click", function (e) {
    var btn = e.target.closest && e.target.closest("[data-ui-theme], #themeToggle");
    if (!btn) return;
    set(current() === "dark" ? "light" : "dark");
  });

  // 사용자가 명시적으로 고르지 않았으면 OS 설정 변경을 따라감
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      if (!stored()) apply(systemPref());
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
})();
