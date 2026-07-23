const net = require("net");
const path = require("path");
const { spawn } = require("child_process");
const { isolatedServerEnv } = require("../support/isolated-server-env");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function serverIsUp(baseUrl) {
  try {
    const response = await fetch(baseUrl);
    return response.ok || response.status < 500;
  } catch (_) {
    return false;
  }
}

async function waitForServer(baseUrl, child, readStderrTail) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null) {
      throw new Error(`Quilo QA server exited with code ${child.exitCode}\n${readStderrTail ? readStderrTail() : ""}`.trim());
    }
    if (await serverIsUp(baseUrl)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Quilo QA server did not start at ${baseUrl}\n${readStderrTail ? readStderrTail() : ""}`.trim());
}

async function stopChild(child) {
  if (!child || child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}

// Boots server.js on a spec-private free port so parallel spec files never share
// (or tear down) each other's server. QA_BASE_URL still overrides everything:
// when set, the spec targets that external server and stop() is a no-op.
async function startQaServer(options = {}) {
  if (process.env.QA_BASE_URL) {
    const baseUrl = process.env.QA_BASE_URL.replace(/\/+$/, "");
    await waitForServer(baseUrl, null, null);
    return { baseUrl, stop: async () => {} };
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(process.cwd(), "server.js")], {
    cwd: process.cwd(),
    env: isolatedServerEnv({ PORT: String(port), ...(options.env || {}) }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrTail = [];
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    stderrTail.push(String(chunk));
    while (stderrTail.length > 20) stderrTail.shift();
  });
  const readStderrTail = () => stderrTail.join("").slice(-2000);

  try {
    await waitForServer(baseUrl, child, readStderrTail);
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return { baseUrl, stop: () => stopChild(child) };
}

module.exports = { startQaServer, freePort };
