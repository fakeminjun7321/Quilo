"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const express = require("express");

const EVENTS = new Set(["job.completed", "job.failed", "job.cancelled"]);
const MISSING_TABLE = /api_webhook_|schema cache|relation .* does not exist/i;
const MAX_ACTIVE_ENDPOINTS = 10;
const webhookCreateLocks = new Map();

async function withWebhookCreateLock(userId, task) {
  const key = String(userId || "");
  const previous = webhookCreateLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const current = previous.catch(() => {}).then(() => gate);
  webhookCreateLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (webhookCreateLocks.get(key) === current) webhookCreateLocks.delete(key);
  }
}

const IPV4_NON_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]) IPV4_NON_PUBLIC.addSubnet(network, prefix, "ipv4");

const IPV6_GLOBAL_UNICAST = new net.BlockList();
IPV6_GLOBAL_UNICAST.addSubnet("2000::", 3, "ipv6");

const IPV6_IETF_PROTOCOL = new net.BlockList();
IPV6_IETF_PROTOCOL.addSubnet("2001::", 23, "ipv6");

const IPV6_IETF_GLOBALLY_REACHABLE = new net.BlockList();
for (const [network, prefix] of [
  ["2001:1::1", 128],
  ["2001:1::2", 128],
  ["2001:1::3", 128],
  ["2001:3::", 32],
  ["2001:4:112::", 48],
  ["2001:20::", 28],
  ["2001:30::", 28],
]) IPV6_IETF_GLOBALLY_REACHABLE.addSubnet(network, prefix, "ipv6");

const IPV6_NON_PUBLIC = new net.BlockList();
for (const [network, prefix] of [
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]) IPV6_NON_PUBLIC.addSubnet(network, prefix, "ipv6");

function keyMaterial(secret) {
  const value = String(secret || process.env.WEBHOOK_SECRET_KEY || process.env.SESSION_SECRET || "");
  if (!value) throw new Error("WEBHOOK_SECRET_KEY가 설정되지 않았습니다.");
  return crypto.createHash("sha256").update(value).digest();
}

function encryptSecret(secret, encryptionKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(encryptionKey), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

function decryptSecret(blob, encryptionKey) {
  const [version, iv, tag, ciphertext] = String(blob || "").split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Webhook secret 형식이 올바르지 않습니다.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial(encryptionKey), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

function publicEndpoint(row) {
  return {
    id: row.id,
    url: row.url,
    description: row.description || "",
    events: Array.isArray(row.events) ? row.events : [],
    enabled: row.enabled !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeEvents(value) {
  const events = [...new Set((Array.isArray(value) ? value : []).map(String).filter((event) => EVENTS.has(event)))];
  if (!events.length) throw new Error("Webhook 이벤트를 하나 이상 선택하세요.");
  return events;
}

function validateWebhookUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch { throw new Error("올바른 Webhook URL이 필요합니다."); }
  if (url.protocol !== "https:") throw new Error("Webhook URL은 HTTPS여야 합니다.");
  if (url.username || url.password || url.port) throw new Error("Webhook URL에는 인증정보나 사용자 지정 포트를 넣을 수 없습니다.");
  const hostname = networkHostname(url.hostname).toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("내부 네트워크 주소는 사용할 수 없습니다.");
  if (net.isIP(hostname) && isPrivateAddress(hostname)) throw new Error("사설 IP 주소는 사용할 수 없습니다.");
  url.hash = "";
  return url.toString();
}

function networkHostname(hostname) {
  const value = String(hostname || "").trim();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseIpv6Words(address) {
  let value = networkHostname(address).toLowerCase();
  if (!value || value.includes("%")) return null;
  const dottedIndex = value.lastIndexOf(":");
  const dottedTail = dottedIndex >= 0 ? value.slice(dottedIndex + 1) : "";
  if (net.isIP(dottedTail) === 4) {
    const octets = dottedTail.split(".").map(Number);
    value = `${value.slice(0, dottedIndex)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function mappedIpv4Address(address) {
  const words = parseIpv6Words(address);
  if (!words || words.slice(0, 5).some(Boolean) || words[5] !== 0xffff) return "";
  return [words[6] >> 8, words[6] & 0xff, words[7] >> 8, words[7] & 0xff].join(".");
}

function isPrivateAddress(address) {
  const normalized = networkHostname(address).toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) {
    if (normalized === "192.0.0.9" || normalized === "192.0.0.10") return false;
    return IPV4_NON_PUBLIC.check(normalized, "ipv4");
  }
  if (family !== 6) return true;
  const mapped = mappedIpv4Address(normalized);
  if (mapped) return isPrivateAddress(mapped);
  if (IPV6_IETF_PROTOCOL.check(normalized, "ipv6")) {
    return !IPV6_IETF_GLOBALLY_REACHABLE.check(normalized, "ipv6");
  }
  return !IPV6_GLOBAL_UNICAST.check(normalized, "ipv6") || IPV6_NON_PUBLIC.check(normalized, "ipv6");
}

async function assertPublicDns(urlString, lookup = dns.lookup) {
  const url = new URL(validateWebhookUrl(urlString));
  const hostname = networkHostname(url.hostname);
  const literalFamily = net.isIP(hostname);
  const records = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(records) || !records.length || records.some((record) => {
    const family = net.isIP(networkHostname(record?.address));
    return !family || isPrivateAddress(record.address);
  })) throw new Error("Webhook 대상이 공개 인터넷 주소가 아닙니다.");
  const seen = new Set();
  return records.flatMap((record) => {
    const address = networkHostname(record.address).toLowerCase();
    if (seen.has(address)) return [];
    seen.add(address);
    return [{ address, family: net.isIP(address) }];
  });
}

function buildPinnedHttpsOptions(urlInput, resolved, headers = {}) {
  const url = new URL(validateWebhookUrl(urlInput instanceof URL ? urlInput.toString() : urlInput));
  const targetHostname = networkHostname(url.hostname);
  const address = networkHostname(resolved?.address).toLowerCase();
  const family = net.isIP(address);
  if (!family || isPrivateAddress(address)) throw new Error("Webhook 대상이 공개 인터넷 주소가 아닙니다.");
  const normalizedHeaders = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() !== "host") normalizedHeaders[String(name).toLowerCase()] = value;
  }
  return {
    protocol: "https:",
    hostname: address,
    family,
    port: 443,
    method: "POST",
    path: `${url.pathname}${url.search}`,
    servername: net.isIP(targetHostname) ? undefined : targetHostname,
    rejectUnauthorized: true,
    agent: false,
    headers: { ...normalizedHeaders, host: url.host },
  };
}

function requestPinnedWebhook(urlInput, resolved, { headers = {}, body = "", signal, requestImpl = https.request } = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const options = buildPinnedHttpsOptions(urlInput, resolved, {
    ...headers,
    "content-length": String(payload.length),
  });
  if (signal) options.signal = signal;
  return new Promise((resolve, reject) => {
    const request = requestImpl(options, (response) => {
      const status = Number(response.statusCode) || 0;
      // 상태 코드만 필요하다. 공격자가 끝나지 않는/거대한 응답 본문으로 소켓과
      // 대역폭을 점유하지 못하게 헤더 확인 즉시 응답 스트림을 닫는다.
      response.destroy?.();
      if (status >= 300 && status < 400) {
        const error = new Error(`Webhook redirect is not allowed (HTTP ${status}).`);
        error.code = "WEBHOOK_REDIRECT_REJECTED";
        reject(error);
        return;
      }
      resolve({ ok: status >= 200 && status < 300, status });
    });
    request.once("error", reject);
    request.end(payload);
  });
}

async function assertWebhookCapacity(client, userId, limit = MAX_ACTIVE_ENDPOINTS) {
  const { count, error } = await client.from("api_webhook_endpoints")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("enabled", true);
  if (error) throw error;
  if ((Number(count) || 0) >= limit) {
    const capacityError = new Error(`활성 Webhook은 계정당 최대 ${limit}개까지 만들 수 있습니다.`);
    capacityError.code = "WEBHOOK_LIMIT_REACHED";
    throw capacityError;
  }
}

function createWebhookRouter({ supa, getSessionUser, encryptionKey }) {
  const router = express.Router();
  const user = (req, res) => {
    const current = getSessionUser(req);
    if (!current?.id) { res.status(401).json({ error: "로그인이 필요합니다." }); return null; }
    return current;
  };
  router.get("/webhooks", async (req, res) => {
    const current = user(req, res); if (!current) return;
    try {
      const { data, error } = await supa.getClient().from("api_webhook_endpoints").select("id, url, description, events, enabled, created_at, updated_at").eq("user_id", current.id).order("created_at", { ascending: false });
      if (error) throw error;
      res.json({ webhooks: (data || []).map(publicEndpoint), supportedEvents: [...EVENTS] });
    } catch (error) { webhookStoreError(res, error); }
  });
  router.post("/webhooks", async (req, res) => {
    const current = user(req, res); if (!current) return;
    try {
      const url = validateWebhookUrl(req.body?.url);
      const events = normalizeEvents(req.body?.events);
      const client = supa.getClient();
      const { data, secret } = await withWebhookCreateLock(current.id, async () => {
        await assertWebhookCapacity(client, current.id);
        const createdSecret = `whsec_${crypto.randomBytes(32).toString("base64url")}`;
        const { data: created, error } = await client.from("api_webhook_endpoints").insert({
          user_id: current.id,
          url,
          description: String(req.body?.description || "").trim().slice(0, 120),
          events,
          secret_ciphertext: encryptSecret(createdSecret, encryptionKey),
          enabled: true,
        }).select("id, url, description, events, enabled, created_at, updated_at").single();
        if (error) throw error;
        return { data: created, secret: createdSecret };
      });
      res.status(201).json({ webhook: publicEndpoint(data), secret, warning: "서명 비밀키는 지금 한 번만 표시됩니다." });
    } catch (error) { webhookStoreError(res, error); }
  });
  router.delete("/webhooks/:id", async (req, res) => {
    const current = user(req, res); if (!current) return;
    try {
      const { data, error } = await supa.getClient().from("api_webhook_endpoints").delete().eq("id", req.params.id).eq("user_id", current.id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Webhook을 찾을 수 없습니다." });
      res.json({ ok: true });
    } catch (error) { webhookStoreError(res, error); }
  });
  router.get("/webhook-deliveries", async (req, res) => {
    const current = user(req, res); if (!current) return;
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
      const { data, error } = await supa.getClient().from("api_webhook_deliveries").select("id, endpoint_id, event, event_id, status, attempt_count, response_status, error, delivered_at, created_at").eq("user_id", current.id).order("created_at", { ascending: false }).limit(limit);
      if (error) throw error;
      res.json({ deliveries: data || [] });
    } catch (error) { webhookStoreError(res, error); }
  });
  return router;
}

async function dispatchJobEvent({ supa, userId, event, payload, encryptionKey }) {
  if (!userId || !EVENTS.has(event) || !supa?.getClient()) return;
  const client = supa.getClient();
  try {
    const { data, error } = await client.from("api_webhook_endpoints").select("id, url, secret_ciphertext, events").eq("user_id", userId).eq("enabled", true).contains("events", [event]);
    if (error) throw error;
    await Promise.allSettled((data || []).map((endpoint) => deliver({ client, userId, endpoint, event, payload, encryptionKey })));
  } catch (error) {
    if (!MISSING_TABLE.test(String(error?.message || error))) console.warn("[webhook] dispatch:", error?.message || error);
  }
}

async function deliver({ client, userId, endpoint, event, payload, encryptionKey }) {
  const eventId = `evt_${crypto.randomBytes(16).toString("hex")}`;
  const body = JSON.stringify({ id: eventId, type: event, createdAt: new Date().toISOString(), data: payload });
  let lastError = "";
  let responseStatus = null;
  let attempts = 0;
  try {
    const resolvedAddresses = await assertPublicDns(endpoint.url);
    const endpointUrl = new URL(endpoint.url);
    const secret = decryptSecret(endpoint.secret_ciphertext, encryptionKey);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    for (attempts = 1; attempts <= 3; attempts++) {
      try {
        const response = await requestPinnedWebhook(endpointUrl, resolvedAddresses[(attempts - 1) % resolvedAddresses.length], {
          headers: {
            "content-type": "application/json",
            "user-agent": "Quilo-Webhooks/1.0",
            "x-quilo-event": event,
            "x-quilo-event-id": eventId,
            "x-quilo-timestamp": String(timestamp),
            "x-quilo-signature": `v1=${signature}`,
          },
          body,
          signal: AbortSignal.timeout(10000),
        });
        responseStatus = response.status;
        if (response.ok) { lastError = ""; break; }
        lastError = `HTTP ${response.status}`;
      } catch (error) { lastError = String(error?.message || error).slice(0, 400); }
      if (attempts < 3) await new Promise((resolve) => setTimeout(resolve, attempts * 250));
    }
  } catch (error) { lastError = String(error?.message || error).slice(0, 400); attempts = Math.max(1, attempts); }
  await client.from("api_webhook_deliveries").insert({
    endpoint_id: endpoint.id,
    user_id: userId,
    event,
    event_id: eventId,
    status: lastError ? "failed" : "delivered",
    attempt_count: attempts,
    response_status: responseStatus,
    error: lastError || null,
    delivered_at: lastError ? null : new Date().toISOString(),
  });
}

function webhookStoreError(res, error) {
  const message = String(error?.message || error || "");
  if (MISSING_TABLE.test(message)) return res.status(503).json({ error: "Webhook 테이블이 아직 설치되지 않았습니다.", code: "WEBHOOK_TABLE_MISSING" });
  if (error?.code === "WEBHOOK_LIMIT_REACHED") return res.status(409).json({ error: message, code: error.code });
  if (/duplicate key|23505/i.test(message)) return res.status(409).json({ error: "같은 URL의 Webhook이 이미 있습니다." });
  if (/Webhook|URL|이벤트|HTTPS|내부 네트워크|사설 IP/i.test(message)) return res.status(400).json({ error: message });
  console.error("[webhook] store:", message);
  return res.status(500).json({ error: "Webhook을 처리하지 못했습니다." });
}

module.exports = {
  assertPublicDns,
  assertWebhookCapacity,
  buildPinnedHttpsOptions,
  createWebhookRouter,
  decryptSecret,
  dispatchJobEvent,
  encryptSecret,
  isPrivateAddress,
  requestPinnedWebhook,
  withWebhookCreateLock,
  validateWebhookUrl,
};
