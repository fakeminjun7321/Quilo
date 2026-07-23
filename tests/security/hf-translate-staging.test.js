const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");

function walkJs(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function resolveLocalRequire(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.js`, path.join(base, "index.js")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

test("HF PDF translation staging contains every local JavaScript dependency", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-hf-stage-test-"));
  const dest = path.join(parent, "staging");
  try {
    const built = spawnSync(
      "bash",
      [path.join(ROOT, "deploy/hf/build-staging.sh"), dest],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const missing = [];
    const requirePattern = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
    for (const file of walkJs(dest)) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(requirePattern)) {
        if (!resolveLocalRequire(file, match[1])) {
          missing.push(`${path.relative(dest, file)} -> ${match[1]}`);
        }
      }
    }

    assert.deepEqual(missing, []);
    assert.ok(fs.existsSync(path.join(dest, "lib/output-validate.js")));
    assert.ok(fs.existsSync(path.join(
      dest,
      "lib/pipelines/pdf-translate/resource-gate.js",
    )));
    for (const file of [
      "renderer-contract.js",
      "libreoffice-pdf.js",
      "libreoffice-gen.js",
      "libreoffice-docx.py",
    ]) {
      assert.ok(fs.existsSync(path.join(
        dest,
        "lib/pipelines/pdf-translate",
        file,
      )));
    }
    for (const file of ["STIXTwoMath.otf", "STIXTwoMath-LICENSE.txt"]) {
      const stagedFontAsset = path.join(dest, "lib/fonts", file);
      const sourceFontAsset = path.join(ROOT, "lib/fonts", file);
      assert.ok(fs.existsSync(stagedFontAsset), `${file} must be staged`);
      assert.deepEqual(
        fs.readFileSync(stagedFontAsset),
        fs.readFileSync(sourceFontAsset),
        `${file} must be copied byte-for-byte`,
      );
    }
    const requirements = fs.readFileSync(
      path.join(dest, "requirements.txt"),
      "utf8",
    );
    assert.match(requirements, /^fonttools==4\.63\.0 \\$/m);
    assert.match(requirements, /^lxml==6\.1\.1 \\$/m);
    assert.match(requirements, /^pdf2docx==0\.5\.13 \\$/m);
    assert.match(requirements, /^python-docx==1\.2\.0 \\$/m);
    const requiredPackages = [
      "pymupdf",
      "fonttools",
      "lxml",
      "pdf2docx",
      "python-docx",
      "typing_extensions",
      "numpy",
      "opencv-python-headless",
      "fire",
      "termcolor",
    ];
    for (const dependency of requiredPackages) {
      assert.match(
        requirements,
        new RegExp(`^${dependency}==[^\\n]+ \\\\$[\\s\\S]*?^\\s+--hash=sha256:`, "m"),
        `${dependency} must be exact-pinned with an allowed wheel hash`,
      );
    }
    assert.ok((requirements.match(/--hash=sha256:/g) || []).length >= requiredPackages.length);
    assert.ok(fs.existsSync(path.join(dest, "scripts/check-python-runtime.py")));
    assert.ok(fs.existsSync(path.join(dest, "package-lock.json")));
    const stagedPackage = JSON.parse(
      fs.readFileSync(path.join(dest, "package.json"), "utf8"),
    );
    assert.equal(stagedPackage.scripts.postinstall, undefined);
    const dockerfile = fs.readFileSync(path.join(dest, "Dockerfile"), "utf8");
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.match(dockerfile, /scripts\/check-python-runtime\.py/);
    assert.match(dockerfile, /scripts\/install-tectonic\.sh/);
    assert.match(dockerfile, /tectonic --version/);
    assert.doesNotMatch(dockerfile, /dependencies venv setup failed/);
    assert.doesNotMatch(dockerfile, /tectonic setup failed/);
    assert.doesNotMatch(dockerfile, /install-tectonic\.sh[\s\\]*\|\|/);
    const readme = fs.readFileSync(path.join(dest, "README.md"), "utf8");
    assert.match(readme, /MISTRAL_API_KEY/);
    assert.match(readme, /visual adjudicator/);
    assert.match(readme, /fail-closed/);
    assert.match(dockerfile, /libreoffice-writer/);
    assert.match(dockerfile, /LIBREOFFICE_BIN=\/usr\/bin\/libreoffice/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("HF clean Python runtime check fails closed and covers every staged third-party import", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-hf-python-clean-"));
  const dest = path.join(parent, "staging");
  try {
    const built = spawnSync(
      "bash",
      [path.join(ROOT, "deploy/hf/build-staging.sh"), dest],
      { cwd: ROOT, encoding: "utf8" },
    );
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const requirements = fs.readFileSync(path.join(dest, "requirements.txt"), "utf8");
    const declared = new Set(
      requirements
        .split(/\r?\n/u)
        .filter((line) => /^[a-z0-9_-]+==/iu.test(line.trim()))
        .map((line) => line.trim().toLowerCase().split(/[<>=!~\[]/u, 1)[0])
        .filter(Boolean),
    );
    assert.deepEqual(
      [...declared].sort(),
      [
        "fire",
        "fonttools",
        "lxml",
        "numpy",
        "opencv-python-headless",
        "pdf2docx",
        "pymupdf",
        "python-docx",
        "termcolor",
        "typing_extensions",
      ],
    );

    const checker = path.join(dest, "scripts/check-python-runtime.py");
    const empty = spawnSync("python3", ["-S", checker], {
      cwd: dest,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: "" },
    });
    assert.notEqual(empty.status, 0, "a dependency-free interpreter must fail closed");
    assert.match(`${empty.stdout}\n${empty.stderr}`, /PDF Python runtime check failed/);

    // A hermetic fake site verifies the checker imports exactly the packages
    // declared by the staged requirements, without network or global packages.
    const fakeSite = path.join(parent, "fake-site");
    fs.mkdirSync(path.join(fakeSite, "fontTools"), { recursive: true });
    fs.mkdirSync(path.join(fakeSite, "lxml"), { recursive: true });
    fs.mkdirSync(path.join(fakeSite, "pdf2docx"), { recursive: true });
    fs.mkdirSync(path.join(fakeSite, "docx"), { recursive: true });
    fs.writeFileSync(path.join(fakeSite, "fitz.py"), "", "utf8");
    fs.writeFileSync(path.join(fakeSite, "fontTools", "__init__.py"), "", "utf8");
    fs.writeFileSync(path.join(fakeSite, "lxml", "__init__.py"), "", "utf8");
    fs.writeFileSync(path.join(fakeSite, "lxml", "etree.py"), "", "utf8");
    fs.writeFileSync(path.join(fakeSite, "pdf2docx", "__init__.py"), "", "utf8");
    fs.writeFileSync(path.join(fakeSite, "docx", "__init__.py"), "", "utf8");
    const closed = spawnSync("python3", ["-S", checker], {
      cwd: dest,
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: fakeSite },
    });
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    assert.match(closed.stdout, /PDF Python runtime imports OK/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("Tectonic installer fails closed on an unsupported deployment architecture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quilo-tectonic-arch-"));
  try {
    const fakeBin = path.join(root, "bin");
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeUname = path.join(fakeBin, "uname");
    fs.writeFileSync(
      fakeUname,
      [
        "#!/bin/sh",
        "case \"$1\" in",
        "  -s) printf 'UnsupportedOS\\n' ;;",
        "  -m) printf 'unsupported-arch\\n' ;;",
        "  *) exit 2 ;;",
        "esac",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    const installed = spawnSync(
      "bash",
      [path.join(ROOT, "scripts/install-tectonic.sh")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:/usr/bin:/bin`,
          TRUST_SYSTEM_TECTONIC: "0",
        },
      },
    );
    assert.notEqual(installed.status, 0);
    assert.match(
      `${installed.stdout}\n${installed.stderr}`,
      /ERROR: no tectonic prebuilt for UnsupportedOS-unsupported-arch/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
