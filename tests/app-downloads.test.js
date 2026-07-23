"use strict";

const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const express = require("express");
const {
  createAppDownloadResolver,
  registerAppDownloadRoutes,
} = require("../lib/app-downloads");

const openServers = new Set();
const silentLogger = { warn() {}, error() {} };

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  openServers.clear();
});

async function startServer(fetchImpl) {
  const app = express();
  registerAppDownloadRoutes(app, { fetchImpl, logger: silentLogger });
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  openServers.add(server);
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

function latestRelease({
  name = "Quilo-win-x64.exe",
  url = "https://github.com/fakeminjun7321/quilo-app/releases/download/v2.0.0/Quilo-win-x64.exe",
  size = 123456,
  tag = "v2.0.0",
} = {}) {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      assets: [
        { name: "unrelated.txt", size: 1, browser_download_url: "https://example.com/no" },
        { name, size, browser_download_url: url },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("selects the matching asset from the fixed latest-release endpoint", async () => {
  const calls = [];
  const resolver = createAppDownloadResolver({
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return latestRelease();
    },
  });

  const asset = await resolver.resolveLatestAppAsset("quilo", "windows");

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    "https://api.github.com/repos/fakeminjun7321/quilo-app/releases/latest",
  );
  assert.deepEqual(asset, {
    name: "Quilo-win-x64.exe",
    size: 123456,
    url: "https://github.com/fakeminjun7321/quilo-app/releases/download/v2.0.0/Quilo-win-x64.exe",
    version: "v2.0.0",
  });
});

test("falls back to the fixed installer when the GitHub API fails", async () => {
  const resolver = createAppDownloadResolver({
    logger: silentLogger,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  });

  const asset = await resolver.resolveLatestAppAsset("quilo", "mac-arm64");

  assert.equal(asset.name, "Quilo-mac-arm64.dmg");
  assert.equal(asset.version, "v1.0.0");
  assert.equal(
    asset.url,
    "https://github.com/fakeminjun7321/quilo-app/releases/download/v1.0.0/Quilo-mac-arm64.dmg",
  );
});

test("never fetches an untrusted release URL returned by GitHub", async () => {
  const calls = [];
  const resolver = createAppDownloadResolver({
    logger: silentLogger,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return latestRelease({ url: "https://attacker.example/Quilo-win-x64.exe" });
    },
  });

  const asset = await resolver.resolveLatestAppAsset("quilo", "windows");

  assert.equal(calls.length, 1);
  assert.equal(
    asset.url,
    "https://github.com/fakeminjun7321/quilo-app/releases/download/v1.0.0/Quilo-win-x64.exe",
  );
});

test("returns 404 for an unknown app without making an outbound request", async () => {
  let calls = 0;
  const baseUrl = await startServer(async () => {
    calls += 1;
    throw new Error("must not be called");
  });

  const response = await fetch(`${baseUrl}/api/apps/not-registered/download?platform=windows`);

  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});

test("returns 400 for an unsupported platform without making an outbound request", async () => {
  let calls = 0;
  const baseUrl = await startServer(async () => {
    calls += 1;
    throw new Error("must not be called");
  });

  const response = await fetch(`${baseUrl}/api/apps/quilo/download?platform=linux`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.deepEqual(body.supported, ["mac-arm64", "mac-x64", "windows"]);
  assert.equal(calls, 0);
});

test("HEAD returns installer metadata without downloading the installer", async () => {
  const calls = [];
  const baseUrl = await startServer(async (url) => {
    calls.push(String(url));
    return latestRelease({ size: 777 });
  });

  const response = await fetch(`${baseUrl}/api/apps/quilo/download?platform=windows`, {
    method: "HEAD",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition"), /Quilo-win-x64\.exe/);
  assert.equal(response.headers.get("content-length"), "777");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.equal(response.headers.get("x-quilo-app-version"), "v2.0.0");
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(calls.length, 1);
});

test("forwards Range and streams a 206 response containing exactly 32 bytes", async () => {
  const installerUrl =
    "https://github.com/fakeminjun7321/quilo-app/releases/download/v2.0.0/Quilo-win-x64.exe";
  let forwardedRange = null;
  const baseUrl = await startServer(async (url, options = {}) => {
    if (String(url).includes("api.github.com")) return latestRelease();
    assert.equal(String(url), installerUrl);
    forwardedRange = options.headers.Range;
    return new Response(Uint8Array.from({ length: 32 }, (_, index) => index), {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": "32",
        "content-range": "bytes 0-31/100",
        "accept-ranges": "bytes",
      },
    });
  });

  const response = await fetch(`${baseUrl}/api/apps/quilo/download?platform=windows`, {
    headers: { Range: "bytes=0-31" },
  });
  const body = new Uint8Array(await response.arrayBuffer());

  assert.equal(response.status, 206);
  assert.equal(forwardedRange, "bytes=0-31");
  assert.equal(response.headers.get("content-range"), "bytes 0-31/100");
  assert.equal(response.headers.get("content-length"), "32");
  assert.equal(body.byteLength, 32);
  assert.deepEqual([...body], Array.from({ length: 32 }, (_, index) => index));
});

test("converts an upstream installer failure into 502", async () => {
  const baseUrl = await startServer(async (url) => {
    if (String(url).includes("api.github.com")) return latestRelease();
    return new Response("upstream unavailable", { status: 503 });
  });

  const response = await fetch(`${baseUrl}/api/apps/quilo/download?platform=windows`);
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.match(body.error, /설치 파일/);
});
