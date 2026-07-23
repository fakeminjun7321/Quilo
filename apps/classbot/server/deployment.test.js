import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(root, "../..");
const rootPackage = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
const rootServer = fs.readFileSync(path.join(projectRoot, "server.js"), "utf8");
const viteConfig = fs.readFileSync(path.join(root, "vite.config.js"), "utf8");

test("기존 Quilo Render 서비스가 /schedule namespace를 빌드하고 mount한다", () => {
  assert.match(rootPackage, /npm ci --prefix apps\/classbot --include=dev/);
  assert.match(rootPackage, /npm run build --prefix apps\/classbot/);
  assert.match(rootServer, /app\.use\("\/schedule"/);
  assert.match(rootServer, /import\("\.\/apps\/classbot\/server\/app\.js"\)/);
  assert.match(rootServer, /SUPABASE_SERVICE_KEY/);
  assert.match(viteConfig, /base: "\/schedule\/"/);
  assert.equal(fs.existsSync(path.join(root, "render.yaml")), false);
});
