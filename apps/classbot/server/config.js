import crypto from "node:crypto";
import "dotenv/config";

function readBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function requiredInProduction(production, name, value, minLength = 1) {
  if (production && (!value || String(value).length < minLength)) {
    const suffix = minLength > 1 ? ` and be at least ${minLength} characters` : "";
    throw new Error(`${name} must be set in production${suffix}`);
  }
  return value;
}

function requireProductionHttpsUrl(production, name, value) {
  if (!production || !value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL in production`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${name} must use HTTPS without embedded credentials in production`);
  }
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const production = env.NODE_ENV === "production" || env.RENDER === "true";
  const embedded = readBoolean(env.CLASSBOT_EMBEDDED, false);
  const storage = env.CLASSBOT_STORAGE || (env.SUPABASE_URL ? "supabase" : "memory");
  const developmentSecret = crypto.createHash("sha256").update("quilo-schedule-local").digest("hex");

  const config = {
    nodeEnv: production ? "production" : (env.NODE_ENV || "development"),
    production,
    embedded,
    port: Number(env.PORT || 4310),
    allowedOrigin: env.CLASSBOT_ALLOWED_ORIGIN ?? (production ? "" : "http://localhost:5173"),
    sessionSecret: env.CLASSBOT_SESSION_SECRET || env.SESSION_SECRET || developmentSecret,
    adminPassword: env.CLASSBOT_ADMIN_PASSWORD || (production || embedded ? "" : "local-admin"),
    cronSecret: env.CLASSBOT_CRON_SECRET || (production ? "" : "local-cron-secret"),
    kakaoSkillSecret: env.CLASSBOT_KAKAO_SKILL_SECRET || "",
    storage,
    supabaseUrl: env.SUPABASE_URL || "",
    // The existing quilolab.com service uses SUPABASE_SERVICE_KEY. Accept the
    // conventional service-role name as well so standalone development keeps
    // working without duplicating production credentials.
    supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || "",
    classCode: env.CLASSBOT_CLASS_CODE || "2-4",
    className: env.CLASSBOT_CLASS_NAME || "2학년 4반",
    timezone: env.CLASSBOT_TIMEZONE || "Asia/Seoul",
    kakao: {
      enabled: readBoolean(env.KAKAO_EVENT_ENABLED, false),
      botId: env.KAKAO_BOT_ID || "",
      restApiKey: env.KAKAO_REST_API_KEY || "",
      eventName: env.KAKAO_EVENT_NAME || "quilo_schedule_notification",
      apiBase: (env.KAKAO_EVENT_API_BASE || "https://bot-api.kakao.com").replace(/\/$/, ""),
    },
    googleDrive: {
      // The folder is created with the connected Quilo Google OAuth token so
      // the intentionally narrow drive.file scope can access it. An explicit
      // ID is only an override for a folder already created by the same app.
      folderId: String(env.CLASSBOT_GOOGLE_DRIVE_FOLDER_ID || "").trim(),
      folderName: String(env.CLASSBOT_GOOGLE_DRIVE_FOLDER_NAME || "Quilo schedule 자료실").trim(),
      ownerUserId: String(env.CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID || "").trim(),
    },
  };

  requiredInProduction(production, "CLASSBOT_SESSION_SECRET or SESSION_SECRET", config.sessionSecret, 32);
  if (!embedded) {
    requiredInProduction(production, "CLASSBOT_ADMIN_PASSWORD", config.adminPassword, 16);
  }
  requiredInProduction(production, "CLASSBOT_CRON_SECRET", config.cronSecret, 32);
  requiredInProduction(production, "CLASSBOT_KAKAO_SKILL_SECRET", config.kakaoSkillSecret, 32);

  if (production) {
    const protectedEntries = [
      ["CLASSBOT_SESSION_SECRET", config.sessionSecret],
      ["CLASSBOT_CRON_SECRET", config.cronSecret],
      ["CLASSBOT_KAKAO_SKILL_SECRET", config.kakaoSkillSecret],
    ];
    if (!embedded) protectedEntries.push(["CLASSBOT_ADMIN_PASSWORD", config.adminPassword]);
    for (const [name, value] of protectedEntries) {
      if (/^(?:replace-with|change-?me|local-admin|local-cron-secret)/i.test(String(value))) {
        throw new Error(`${name} must not use a placeholder or development default in production`);
      }
    }
    const protectedValues = protectedEntries.map(([, value]) => value);
    if (new Set(protectedValues).size !== protectedValues.length) {
      throw new Error("Production secrets must all use distinct values");
    }
    const origins = String(config.allowedOrigin).split(",").map((item) => item.trim()).filter(Boolean);
    for (const origin of origins) requireProductionHttpsUrl(true, "CLASSBOT_ALLOWED_ORIGIN", origin);
  }

  if (config.timezone !== "Asia/Seoul") {
    throw new Error("CLASSBOT_TIMEZONE currently supports only Asia/Seoul");
  }

  if (production && storage !== "supabase") {
    throw new Error("CLASSBOT_STORAGE must be supabase in production");
  }

  if (storage === "supabase") {
    requiredInProduction(production, "SUPABASE_URL", config.supabaseUrl);
    requiredInProduction(production, "SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_KEY", config.supabaseServiceRoleKey);
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
      throw new Error("Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    }
    requireProductionHttpsUrl(production, "SUPABASE_URL", config.supabaseUrl);
  }

  if (config.kakao.enabled && (!config.kakao.botId || !config.kakao.restApiKey)) {
    throw new Error("Kakao Event API requires KAKAO_BOT_ID and KAKAO_REST_API_KEY when enabled");
  }
  if (config.googleDrive.folderId && !/^[A-Za-z0-9_-]{10,300}$/.test(config.googleDrive.folderId)) {
    throw new Error("CLASSBOT_GOOGLE_DRIVE_FOLDER_ID is invalid");
  }
  if (config.googleDrive.ownerUserId && !/^[A-Za-z0-9_-]{8,300}$/.test(config.googleDrive.ownerUserId)) {
    throw new Error("CLASSBOT_GOOGLE_DRIVE_OWNER_USER_ID is invalid");
  }
  if (!config.googleDrive.folderName || config.googleDrive.folderName.length > 100) {
    throw new Error("CLASSBOT_GOOGLE_DRIVE_FOLDER_NAME must be between 1 and 100 characters");
  }
  requireProductionHttpsUrl(production, "KAKAO_EVENT_API_BASE", config.kakao.apiBase);

  return config;
}
