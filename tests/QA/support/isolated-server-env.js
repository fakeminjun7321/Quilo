const DISABLED_EXTERNAL_ENV = Object.freeze({
  ADMIN_EMAIL: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_API_KEY: "",
  CHAT_API_KEY: "",
  CLASSBOT_SUPABASE_SERVICE_KEY: "",
  CLASSBOT_SUPABASE_SERVICE_ROLE_KEY: "",
  CLASSBOT_SUPABASE_URL: "",
  DROPBOX_APP_KEY: "",
  DROPBOX_APP_SECRET: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  GEMINI_API_KEY: "",
  GPT_API_KEY: "",
  MISTRAL_API_KEY: "",
  NOTION_CLIENT_ID: "",
  NOTION_CLIENT_SECRET: "",
  OPENAI_API_KEY: "",
  PRODUCT_TELEMETRY_ENABLED: "0",
  RESEND_API_KEY: "",
  SUPABASE_ANON_KEY: "",
  SUPABASE_SERVICE_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  SUPABASE_URL: "",
  TECTONIC_BIN: "/usr/bin/false",
});

function isolatedServerEnv(overrides = {}) {
  return {
    ...process.env,
    ...DISABLED_EXTERNAL_ENV,
    DEV_FAKE_AUTH: "0",
    DISABLE_SELF_PING: "1",
    NODE_ENV: "test",
    SITE_CLOSED: "0",
    ...overrides,
  };
}

module.exports = { DISABLED_EXTERNAL_ENV, isolatedServerEnv };
