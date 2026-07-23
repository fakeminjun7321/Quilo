import { assertWorkspaceDom } from "./dom-contract.js";
import { createWorkspaceState } from "./state.js";
import { createRouter } from "./router.js";
import { createShellController } from "./shell-controller.js";
import { createFilesController } from "./files-controller.js";
import { createAccountController } from "./account-controller.js";
import { loadAnnouncements } from "./announcements.js";
import { installTelemetryListeners } from "./telemetry.js";

assertWorkspaceDom();

const hooks = {};
const state = createWorkspaceState();
const router = createRouter({ state, hooks });
const shell = createShellController({ state, router, hooks });
const files = createFilesController({ hooks });
const account = createAccountController({ state, router, hooks });
let reportRuntimePromise = null;
let accountExtensionsPromise = null;

function ensureReportRuntime() {
  if (!reportRuntimePromise) reportRuntimePromise = import("../app.js");
  return reportRuntimePromise;
}

function ensureAccountExtensions() {
  if (!accountExtensionsPromise) accountExtensionsPromise = import("./account-extensions.js");
  return accountExtensionsPromise;
}

Object.assign(hooks, {
  shell,
  filesController: files,
  accountController: account,
  ensureReportRuntime,
  ensureAccountExtensions,
  requestedAccountTab: ["files", "integrations", "settings", "feedback"].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : "",
});

const runtime = {
  state,
  router,
  shell,
  files,
  account,
  hooks,
  ensureReportRuntime,
  ensureAccountExtensions,
  registerHooks(next) { Object.assign(hooks, next || {}); },
};

window.__quiloWorkspaceRuntime = runtime;
window.QuiloSetView = shell.setView;

// The global shell must be interactive before the report runtime finishes
// parsing. Report generation is the heaviest part of the frontend and should
// never block a menu, theme, or account interaction on first paint.
shell.init();
files.init();
installTelemetryListeners();
const accountReady = account.init();
loadAnnouncements();
await accountReady;
