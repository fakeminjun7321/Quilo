"use strict";

const { Readable } = require("stream");

const APP_RELEASES = Object.freeze({
  quilo: Object.freeze({
    repo: "fakeminjun7321/quilo-app",
    assets: Object.freeze({
      "mac-arm64": /^Quilo-mac-arm64\.dmg$/i,
      "mac-x64": /^Quilo-mac-x64\.dmg$/i,
      windows: /^Quilo-win-x64\.exe$/i,
    }),
    fallbacks: Object.freeze({
      "mac-arm64": Object.freeze({
        name: "Quilo-mac-arm64.dmg",
        version: "v1.0.0",
        size: 99043701,
        url: "https://github.com/fakeminjun7321/quilo-app/releases/download/v1.0.0/Quilo-mac-arm64.dmg",
      }),
      "mac-x64": Object.freeze({
        name: "Quilo-mac-x64.dmg",
        version: "v1.0.0",
        size: 105884091,
        url: "https://github.com/fakeminjun7321/quilo-app/releases/download/v1.0.0/Quilo-mac-x64.dmg",
      }),
      windows: Object.freeze({
        name: "Quilo-win-x64.exe",
        version: "v1.0.0",
        size: 82067644,
        url: "https://github.com/fakeminjun7321/quilo-app/releases/download/v1.0.0/Quilo-win-x64.exe",
      }),
    }),
  }),
  "live-translator": Object.freeze({
    repo: "fakeminjun7321/live-translator-app",
    assets: Object.freeze({
      "mac-arm64": /^LiveTranslator-mac-arm64\.dmg$/i,
      windows: /^LiveTranslator-win-x64\.exe$/i,
    }),
    fallbacks: Object.freeze({
      "mac-arm64": Object.freeze({
        name: "LiveTranslator-mac-arm64.dmg",
        version: "v0.1.4",
        size: 98836225,
        url: "https://github.com/fakeminjun7321/live-translator-app/releases/download/v0.1.4/LiveTranslator-mac-arm64.dmg",
      }),
      windows: Object.freeze({
        name: "LiveTranslator-win-x64.exe",
        version: "v0.1.4",
        size: 82441444,
        url: "https://github.com/fakeminjun7321/live-translator-app/releases/download/v0.1.4/LiveTranslator-win-x64.exe",
      }),
    }),
  }),
});

function normalizeAppPlatform(value, arch) {
  const platform = String(value || "").trim().toLowerCase();
  const requestedArch = String(arch || "").trim().toLowerCase();
  if (["windows", "win", "win32", "win-x64"].includes(platform)) return "windows";
  if (["mac-x64", "macos-x64", "darwin-x64", "intel"].includes(platform)) return "mac-x64";
  if (["mac-arm64", "macos-arm64", "darwin-arm64", "apple-silicon"].includes(platform)) {
    return "mac-arm64";
  }
  if (["mac", "macos", "darwin"].includes(platform)) {
    return requestedArch === "x64" || requestedArch === "intel" ? "mac-x64" : "mac-arm64";
  }
  return "";
}

function isAllowedReleaseAssetUrl(value, repo, assetName) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
    const prefix = `/${repo}/releases/download/`;
    if (!url.pathname.startsWith(prefix)) return false;
    return decodeURIComponent(url.pathname.split("/").pop() || "") === assetName;
  } catch (_) {
    return false;
  }
}

function createAppDownloadResolver({
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
  cacheTtlMs = 10 * 60 * 1000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const cache = new Map();

  async function resolveLatestAppAsset(appKey, platform) {
    const config = APP_RELEASES[appKey];
    const matcher = config?.assets?.[platform];
    if (!config || !matcher) return null;

    const cacheKey = `${appKey}:${platform}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now()) return cached.asset;

    let asset = null;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${config.repo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Quilo-App-Download",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!response.ok) throw new Error(`release lookup failed (${response.status})`);
      const release = await response.json();
      const rawAsset = Array.isArray(release.assets)
        ? release.assets.find((candidate) => matcher.test(String(candidate?.name || "")))
        : null;
      const name = String(rawAsset?.name || "");
      if (
        rawAsset &&
        name &&
        isAllowedReleaseAssetUrl(rawAsset.browser_download_url, config.repo, name)
      ) {
        asset = Object.freeze({
          name,
          size: Number(rawAsset.size) || null,
          url: String(rawAsset.browser_download_url),
          version: String(release.tag_name || "latest"),
        });
      }
    } catch (error) {
      logger.warn?.(
        "[app-download] latest release lookup fallback:",
        config.repo,
        error.message,
      );
    }

    if (!asset) asset = config.fallbacks?.[platform] || null;
    if (!asset) return null;
    cache.set(cacheKey, { asset, expiresAt: now() + cacheTtlMs });
    return asset;
  }

  return { resolveLatestAppAsset, cache };
}

function requestSelection(req) {
  const appKey = String(req.params.app || "").trim().toLowerCase();
  const platform = normalizeAppPlatform(req.query.platform, req.query.arch);
  return { appKey, platform, config: APP_RELEASES[appKey] || null };
}

function setDownloadHeaders(res, asset) {
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`,
  );
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Quilo-App-Version", asset.version);
  if (asset.size) res.setHeader("Content-Length", String(asset.size));
}

function registerAppDownloadRoutes(app, options = {}) {
  if (!app || typeof app.get !== "function" || typeof app.head !== "function") {
    throw new TypeError("an Express-compatible app is required");
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || console;
  const resolver = createAppDownloadResolver({ ...options, fetchImpl, logger });

  app.head("/api/apps/:app/download", async (req, res) => {
    const { appKey, platform, config } = requestSelection(req);
    if (!config) return res.sendStatus(404);
    if (!platform || !config.assets[platform]) return res.sendStatus(400);
    try {
      const asset = await resolver.resolveLatestAppAsset(appKey, platform);
      if (!asset) return res.sendStatus(404);
      setDownloadHeaders(res, asset);
      return res.status(200).end();
    } catch (error) {
      logger.error?.("[app-download] metadata", appKey, platform, error.message);
      return res.sendStatus(502);
    }
  });

  app.get("/api/apps/:app/download", async (req, res) => {
    const { appKey, platform, config } = requestSelection(req);
    if (!config) return res.status(404).json({ error: "등록되지 않은 앱입니다." });
    if (!platform || !config.assets[platform]) {
      return res.status(400).json({
        error: "지원하지 않는 운영체제입니다.",
        supported: Object.keys(config.assets),
      });
    }

    try {
      const asset = await resolver.resolveLatestAppAsset(appKey, platform);
      if (!asset) {
        return res.status(404).json({ error: "현재 제공 가능한 설치 파일이 없습니다." });
      }

      const headers = { "User-Agent": "Quilo-App-Download" };
      if (req.headers.range) headers.Range = req.headers.range;
      const upstream = await fetchImpl(asset.url, { headers, redirect: "follow" });
      if (!upstream.ok || !upstream.body) {
        throw new Error(`installer download failed (${upstream.status})`);
      }

      res.status(upstream.status === 206 ? 206 : 200);
      setDownloadHeaders(res, asset);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=300");
      for (const name of [
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified",
      ]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }

      const stream = Readable.fromWeb(upstream.body);
      stream.on("error", (error) => {
        logger.error?.("[app-download] stream error:", error.message);
        if (!res.headersSent) res.status(502).end();
        else res.destroy(error);
      });
      stream.pipe(res);
      return undefined;
    } catch (error) {
      logger.error?.("[app-download]", appKey, platform, error.message);
      if (!res.headersSent) {
        return res.status(502).json({
          error: "설치 파일을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        });
      }
      return undefined;
    }
  });

  return resolver;
}

module.exports = {
  APP_RELEASES,
  createAppDownloadResolver,
  isAllowedReleaseAssetUrl,
  normalizeAppPlatform,
  registerAppDownloadRoutes,
};
