"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("Hugging Face build inputs are immutable and lifecycle scripts stay disabled", () => {
  const dockerfile = read("deploy", "hf", "Dockerfile");
  const pkg = JSON.parse(read("deploy", "hf", "package.json"));
  const lock = JSON.parse(read("deploy", "hf", "package-lock.json"));
  const requirements = read("deploy", "hf", "requirements.txt");
  const staging = read("deploy", "hf", "build-staging.sh");

  assert.match(dockerfile, /^FROM node:20-bookworm@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /install -d -o node -g node \/home\/node\/app/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /--require-hashes/);
  assert.match(dockerfile, /--only-binary=:all:/);
  assert.equal(pkg.scripts?.postinstall, undefined);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages?.[""]?.hasInstallScript, undefined);
  assert.match(staging, /deploy\/hf\/package-lock\.json/);

  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must be exact`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version);
  }
  for (const [name, metadata] of Object.entries(lock.packages).filter(([name]) => name)) {
    assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\//, `${name} must come from npm`);
    assert.match(metadata.integrity, /^sha512-/, `${name} must have an integrity digest`);
  }
  for (const line of requirements.split("\n").filter((line) => /^[a-z]/i.test(line))) {
    assert.match(line, /^[a-z0-9_-]+==[^ ]+ \\$/i);
  }
  assert.ok((requirements.match(/--hash=sha256:/g) || []).length >= 6);
});

test("PyPI publishing uses immutable actions and a hash-locked wheel-only toolchain", () => {
  const workflow = read(".github", "workflows", "publish-pypi.yml");
  const pyproject = read("sdk", "python", "pyproject.toml");
  const buildRequirements = read("sdk", "python", "build-requirements.txt");
  const actionRefs = [...workflow.matchAll(/^\s*-?\s*uses:\s*\S+@([^\s#]+)/gm)].map((match) => match[1]);

  assert.ok(actionRefs.length >= 5);
  for (const ref of actionRefs) assert.match(ref, /^[a-f0-9]{40}$/);
  assert.doesNotMatch(workflow, /runs-on:\s*ubuntu-latest/);
  assert.match(workflow, /python-version:\s*"3\.12\.13"/);
  assert.match(workflow, /pip install .*--require-hashes .*--only-binary=:all:/);
  assert.match(workflow, /python -m build --no-isolation/);
  assert.match(pyproject, /requires = \["hatchling==1\.31\.0"\]/);
  assert.match(buildRequirements, /^build==1\.5\.0 \\$/m);
  assert.match(buildRequirements, /^hatchling==1\.31\.0 \\$/m);
  assert.ok((buildRequirements.match(/--hash=sha256:/g) || []).length >= 14);
});
