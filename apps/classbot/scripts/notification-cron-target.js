const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function resolveNotificationCronTarget({ privateHostPort, externalBaseUrl } = {}) {
  if (privateHostPort) return new URL(`http://${privateHostPort}`);
  if (!externalBaseUrl) {
    throw new Error("CLASSBOT_SERVICE_HOSTPORT or CLASSBOT_BASE_URL is required.");
  }

  const target = new URL(externalBaseUrl);
  if (target.protocol !== "https:" && !LOCAL_HOSTS.has(target.hostname)) {
    throw new Error("Notification Cron target must use HTTPS unless it is localhost.");
  }
  return target;
}

export function classbotUrl(baseUrl, path = "/") {
  const target = new URL(baseUrl);
  const current = target.pathname.replace(/\/$/, "");
  const prefix = current.endsWith("/schedule") ? current : `${current}/schedule`;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${prefix}${suffix}`, target.origin);
}
