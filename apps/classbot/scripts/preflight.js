import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../server/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(root, "../..");

function requireFile(relativePath) {
  const absolutePath = path.join(root, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`Required deployment file is missing: ${relativePath}`);
  return fs.readFileSync(absolutePath, "utf8");
}

function requireIncludes(source, labels, filename) {
  for (const label of labels) {
    if (!source.includes(label)) throw new Error(`${filename} is missing required marker: ${label}`);
  }
}

export function runPreflight({ env = process.env } = {}) {
  const packageJson = JSON.parse(requireFile("package.json"));
  const html = requireFile("dist/index.html");
  const schema = requireFile("db/schema.sql");
  const rootPackage = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
  const rootServer = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");

  requireIncludes(html, ["Quilo", "/schedule/assets/"], "dist/index.html");
  requireIncludes(schema, [
    "classbot_schema_meta",
    "classbot_health_check",
    "classbot_classes",
    "classbot_notifications",
    "classbot_create_member",
    "classbot_claim_invite",
    "classbot_replace_timetable_day",
  ], "db/schema.sql");
  requireIncludes(rootPackage, [
    "npm ci --prefix apps/classbot --include=dev",
    "npm run build --prefix apps/classbot",
  ], "../../package.json");
  requireIncludes(rootServer, [
    'app.use("/schedule"',
    'import("./apps/classbot/server/app.js")',
    "SUPABASE_SERVICE_KEY",
  ], "../../server.js");

  let runtime = null;
  if (env.NODE_ENV === "production") {
    const config = loadConfig(env);
    runtime = {
      storage: config.storage,
      kakaoEnabled: config.kakao.enabled,
      allowedOriginCount: String(config.allowedOrigin).split(",").filter(Boolean).length,
    };
  }

  return {
    ok: true,
    app: packageJson.name,
    version: packageJson.version,
    productionEnvironmentChecked: Boolean(runtime),
    runtime,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runPreflight();
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Quilo preflight failed: ${error.message}`);
    process.exitCode = 1;
  }
}
