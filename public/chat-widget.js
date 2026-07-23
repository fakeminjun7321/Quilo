/* Quilo chat compatibility loader. The implementation lives in /chat/*.js. */
(function loadQuiloChat() {
  "use strict";
  window.Quilo = window.Quilo || {};
  if (window.__quiloChatLoaded) return;
  window.__quiloChatLoaded = true;
  if (!document.querySelector('link[data-quilo-chat-css]')) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/ui/chat.css";
    link.dataset.quiloChatCss = "";
    document.head.appendChild(link);
  }
  import("/chat/index.js")
    .then((module) => module.initChatWidget())
    .catch((error) => console.error("Quilo chat failed to load", error));
})();
