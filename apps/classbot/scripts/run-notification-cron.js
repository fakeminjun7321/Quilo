import { classbotUrl, resolveNotificationCronTarget } from "./notification-cron-target.js";

const privateHostPort = process.env.CLASSBOT_SERVICE_HOSTPORT;
const rawHost = privateHostPort || process.env.CLASSBOT_BASE_URL;
const secret = process.env.CLASSBOT_CRON_SECRET;

if (!rawHost || !secret) {
  console.error("CLASSBOT_SERVICE_HOSTPORT (or CLASSBOT_BASE_URL) and CLASSBOT_CRON_SECRET are required.");
  process.exit(2);
}

const baseUrl = resolveNotificationCronTarget({
  privateHostPort,
  externalBaseUrl: process.env.CLASSBOT_BASE_URL,
});

try {
  const response = await fetch(classbotUrl(baseUrl, "/api/cron/notifications"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(50_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log(JSON.stringify({
    ok: true,
    reconciledTasks: Array.isArray(body.reconciliation?.results) ? body.reconciliation.results.length : 0,
    orphanCount: Number(body.reconciliation?.orphanCount || 0),
    dispatchedBatches: Array.isArray(body.dispatch?.results)
      ? body.dispatch.results.length
      : Array.isArray(body.dispatch?.batches)
        ? body.dispatch.batches.length
        : 0,
    kakaoEnabled: body.dispatch?.kakaoEnabled === true,
  }));
} catch (error) {
  console.error(`Quilo notification Cron failed: ${error.message}`);
  process.exitCode = 1;
}
