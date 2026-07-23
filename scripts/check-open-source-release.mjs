#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

const tracked = trackedFiles();
const trackedSet = new Set(tracked);

const required = [
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/repository-boundaries.md",
  "docs/open-source/license-audit.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  ".github/workflows/open-source-guard.yml",
];

for (const file of required) {
  if (!trackedSet.has(file) && !fs.existsSync(path.join(root, file))) {
    fail(`required public-project file is missing: ${file}`);
  }
}

const forbiddenExact = new Set([
  "SYNC.md",
  "scripts/quilo-sync.sh",
  "public/equation/CONVERSION_RULES.md",
  "lib/pipelines/phys-inquiry/templates/inquiry-template.hwpx",
  "lib/pipelines/phys-result/templates/result-report-template.hwpx",
  "lib/pipelines/reading-log/templates/reading-log-template.hwpx",
]);
const forbiddenPrefixes = [
  "videos/",
  "lib/equation/vendor/",
  "public/equation/src/",
  ".harness/runs/",
  "output/",
];
const forbiddenSecretFile = /(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key|mobileprovision))$/i;
const forbiddenRightsBinary = /\.(?:hwp|hwpx|cap)$/i;

for (const file of tracked) {
  if (forbiddenExact.has(file) || forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) {
    fail(`restricted path is tracked: ${file}`);
  }
  if (forbiddenSecretFile.test(file) && !file.endsWith(".env.example")) {
    fail(`credential-shaped file is tracked: ${file}`);
  }
  if (forbiddenRightsBinary.test(file)) {
    fail(`rights- or user-data-sensitive binary is tracked: ${file}`);
  }
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const classbotPackageJson = JSON.parse(
  fs.readFileSync(path.join(root, "apps/classbot/package.json"), "utf8"),
);
if (packageJson.license !== "AGPL-3.0-or-later") {
  fail("package.json license must be AGPL-3.0-or-later");
}
if (packageJson.private !== true) {
  fail("package.json must keep private=true to prevent accidental npm publication");
}
if (packageJson.repository?.url !== "git+https://github.com/fakeminjun7321/Quilo.git") {
  fail("package.json repository URL must point to the canonical public repository");
}

const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
if (!license.includes("GNU AFFERO GENERAL PUBLIC LICENSE") || !license.includes("Version 3")) {
  fail("LICENSE does not contain the GNU AGPL v3 text");
}

const auditPath = path.join(root, "docs/open-source/license-audit.md");
if (fs.existsSync(auditPath)) {
  const audit = fs.readFileSync(auditPath, "utf8").toLowerCase();
  for (const dependency of Object.keys(packageJson.dependencies || {})) {
    if (!audit.includes(dependency.toLowerCase())) {
      fail(`direct npm dependency is missing from the license audit: ${dependency}`);
    }
  }
  for (const dependency of Object.keys(classbotPackageJson.dependencies || {})) {
    if (!audit.includes(dependency.toLowerCase())) {
      fail(`direct Classbot npm dependency is missing from the license audit: ${dependency}`);
    }
  }
  const requirements = fs
    .readFileSync(path.join(root, "requirements.txt"), "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/[<>=!~[]/, 1)[0].trim().toLowerCase());
  for (const dependency of requirements) {
    if (!audit.includes(dependency)) {
      fail(`direct Python dependency is missing from the license audit: ${dependency}`);
    }
  }
}

if (failures.length) {
  console.error("Open-source release guard failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Open-source release guard passed: ${tracked.length} tracked files, ` +
    `${required.length} policy files, no forbidden distribution paths.`,
);
