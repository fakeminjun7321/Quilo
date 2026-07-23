#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(repoRoot, ".harness", "config.json");
const schemaPath = path.join(repoRoot, ".harness", "state.schema.json");
const VALID_STATUS = new Set(["in_progress", "complete", "blocked", "budget_stopped", "abandoned"]);

function fail(message) {
  const error = new Error(message);
  error.isHarnessError = true;
  throw error;
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function loadConfig() {
  const config = await loadJson(configPath);
  if (config.version !== 1) fail(`Unsupported harness config version: ${config.version}`);
  if (!config.tiers || typeof config.tiers !== "object") fail("Harness config is missing tiers");
  return config;
}

function parseArgs(args) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.set(key, true);
      continue;
    }
    index += 1;
    const previous = flags.get(key);
    if (previous == null) flags.set(key, next);
    else if (Array.isArray(previous)) previous.push(next);
    else flags.set(key, [previous, next]);
  }
  return { positionals, flags };
}

function flagValues(flags, name) {
  const value = flags.get(name);
  if (value == null || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function safeRunId(runId) {
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(runId || "")) {
    fail("run-id must be 2-80 lowercase letters, numbers, dots, underscores, or hyphens");
  }
  return runId;
}

function runDirectory(config, runId = "") {
  const base = path.resolve(repoRoot, config.runDirectory);
  const target = path.resolve(base, runId);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) fail("Run path escaped the harness directory");
  return target;
}

async function git(args) {
  const { stdout } = await execFile("git", args, { cwd: repoRoot, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trimEnd();
}

function validateConfiguredCommands(config) {
  const allowed = new Set(config.allowedExecutables || []);
  for (const [tierName, entries] of Object.entries(config.tiers)) {
    if (!Array.isArray(entries) || entries.length === 0) fail(`Tier ${tierName} has no commands`);
    for (const entry of entries) {
      if (!entry || !Array.isArray(entry.argv) || entry.argv.length === 0) fail(`Tier ${tierName} has invalid argv`);
      if (!allowed.has(entry.argv[0])) fail(`Executable is not allowlisted: ${entry.argv[0]}`);
      if (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1000) fail(`Invalid timeout for ${entry.name}`);
    }
  }
}

async function doctor({ quiet = false } = {}) {
  const config = await loadConfig();
  validateConfiguredCommands(config);

  const actualRoot = path.resolve(await git(["rev-parse", "--show-toplevel"]));
  if (actualRoot !== repoRoot) fail(`Expected repository root ${repoRoot}, got ${actualRoot}`);

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor !== config.nodeMajor) fail(`Node ${config.nodeMajor}.x is required; current is ${process.versions.node}`);

  for (const required of config.requiredFiles || []) {
    await access(path.join(repoRoot, required), fsConstants.R_OK);
  }
  await access(schemaPath, fsConstants.R_OK);

  const claudeInstructions = await readFile(path.join(repoRoot, "CLAUDE.md"), "utf8");
  if (!claudeInstructions.includes("@AGENTS.md")) fail("CLAUDE.md must import @AGENTS.md");
  const agentInstructions = await readFile(path.join(repoRoot, "AGENTS.md"), "utf8");
  if (!agentInstructions.includes("docs/engineering/agent-harness.md")) fail("AGENTS.md must route to the harness guide");

  const trackedSecrets = await git(["ls-files", ".env", ".env.local"]);
  if (trackedSecrets) fail(`Secret-bearing environment file is tracked: ${trackedSecrets.split("\n").join(", ")}`);

  await execFile("git", ["diff", "--check"], { cwd: repoRoot });

  if (!quiet) {
    const dirty = await git(["status", "--short"]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      repository: repoRoot,
      node: process.versions.node,
      revision: await git(["rev-parse", "HEAD"]),
      dirtyFiles: dirty ? dirty.split("\n").length : 0,
      externalQaBlocked: Boolean(process.env.QA_BASE_URL),
    }, null, 2)}\n`);
  }
  return config;
}

function validateState(state) {
  const required = [
    "version", "runId", "tool", "objective", "acceptanceCriteria", "allowedPaths",
    "baseRevision", "dirtyBaseline", "iteration", "hypothesis", "changedFiles", "commands",
    "openRisks", "blockers", "status", "nextAction", "ruleReview", "promotedRules", "createdAt", "updatedAt",
  ];
  for (const key of required) {
    if (!(key in state)) fail(`Checkpoint is missing ${key}`);
  }
  if (state.version !== 2) fail("Checkpoint version must be 2");
  safeRunId(state.runId);
  if (!["codex", "claude-code", "other"].includes(state.tool)) fail(`Unsupported tool: ${state.tool}`);
  if (typeof state.objective !== "string" || !state.objective.trim()) fail("Checkpoint objective is empty");
  for (const key of ["acceptanceCriteria", "allowedPaths", "dirtyBaseline", "changedFiles", "commands", "openRisks", "blockers", "promotedRules"]) {
    if (!Array.isArray(state[key])) fail(`Checkpoint ${key} must be an array`);
  }
  if (!Number.isInteger(state.iteration) || state.iteration < 0) fail("Checkpoint iteration must be a non-negative integer");
  if (!VALID_STATUS.has(state.status)) fail(`Unsupported checkpoint status: ${state.status}`);
  if (typeof state.ruleReview !== "string") fail("Checkpoint ruleReview must be a string");
  return state;
}

function migrateState(state) {
  if (state.version !== 1) return { state, migrated: false };
  return {
    migrated: true,
    state: {
      ...state,
      version: 2,
      ruleReview: state.status === "complete"
        ? "Legacy checkpoint completed before the continuous rule-review gate existed."
        : "",
      promotedRules: [],
    },
  };
}

async function initRun(config, parsed) {
  const runId = safeRunId(parsed.positionals[0]);
  const objective = parsed.flags.get("objective");
  if (typeof objective !== "string" || !objective.trim()) fail("init requires --objective \"...\"");
  const tool = parsed.flags.get("tool") || "other";
  if (!["codex", "claude-code", "other"].includes(tool)) fail("--tool must be codex, claude-code, or other");

  const target = runDirectory(config, runId);
  try {
    await access(target);
    fail(`Run already exists: ${runId}. Use harness:resume or choose a new run-id.`);
  } catch (error) {
    if (error.isHarnessError) throw error;
  }

  await mkdir(path.join(target, "evidence"), { recursive: true });
  await mkdir(path.join(target, "artifacts"), { recursive: true });
  const now = new Date().toISOString();
  const dirty = await git(["status", "--short"]);
  const state = {
    version: 2,
    runId,
    tool,
    objective: objective.trim(),
    acceptanceCriteria: flagValues(parsed.flags, "acceptance"),
    allowedPaths: flagValues(parsed.flags, "path"),
    baseRevision: await git(["rev-parse", "HEAD"]),
    dirtyBaseline: dirty ? dirty.split("\n") : [],
    iteration: 0,
    hypothesis: "",
    changedFiles: [],
    commands: [],
    openRisks: [],
    blockers: [],
    status: "in_progress",
    nextAction: "Define the first reproducible failure or baseline observation.",
    ruleReview: "",
    promotedRules: [],
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  validateState(state);
  await writeFile(path.join(target, "state.json"), `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${path.relative(repoRoot, path.join(target, "state.json"))}\n`);
}

async function findLatestRun(config) {
  const base = runDirectory(config);
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") fail("No harness runs exist yet");
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statePath = path.join(base, entry.name, "state.json");
    try {
      candidates.push({ runId: entry.name, mtimeMs: (await stat(statePath)).mtimeMs });
    } catch (_) {
      // Ignore incomplete directories; validate reports them when explicitly requested.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates[0]) fail("No valid harness run exists");
  return candidates[0].runId;
}

async function readState(config, runId) {
  const resolvedRunId = runId ? safeRunId(runId) : await findLatestRun(config);
  const statePath = path.join(runDirectory(config, resolvedRunId), "state.json");
  const migrated = migrateState(await loadJson(statePath));
  const state = validateState(migrated.state);
  if (migrated.migrated) await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  return { statePath, state };
}

async function resumeRun(config, parsed) {
  const { statePath, state } = await readState(config, parsed.positionals[0]);
  process.stdout.write(`${JSON.stringify({ path: path.relative(repoRoot, statePath), ...state }, null, 2)}\n`);
}

async function checkpointRun(config, parsed) {
  const { statePath, state } = await readState(config, parsed.positionals[0]);
  const status = parsed.flags.get("status");
  if (status != null) {
    if (!VALID_STATUS.has(status)) fail(`--status must be one of ${[...VALID_STATUS].join(", ")}`);
    state.status = status;
  }
  const next = parsed.flags.get("next");
  if (typeof next === "string") state.nextAction = next;
  const hypothesis = parsed.flags.get("hypothesis");
  if (typeof hypothesis === "string") state.hypothesis = hypothesis;
  const ruleReview = parsed.flags.get("rule-review");
  if (typeof ruleReview === "string") state.ruleReview = ruleReview.trim();
  const promotedRules = flagValues(parsed.flags, "promoted-rule").map((value) => value.trim()).filter(Boolean);
  if (promotedRules.length) state.promotedRules = [...new Set([...state.promotedRules, ...promotedRules])];
  const changed = flagValues(parsed.flags, "changed").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (changed.length) state.changedFiles = [...new Set([...state.changedFiles, ...changed])].sort();
  const notes = flagValues(parsed.flags, "note");
  if (notes.length) state.notes = [...(state.notes || []), ...notes];
  const iteration = parsed.flags.get("iteration");
  state.iteration = iteration == null ? state.iteration + 1 : Number.parseInt(iteration, 10);
  state.updatedAt = new Date().toISOString();
  validateState(state);
  if (state.status === "complete" && config.learning?.reviewRequiredOnComplete && !state.ruleReview) {
    fail("complete requires --rule-review with the durable-rule review result");
  }
  if (state.status === "complete" && state.promotedRules.length > 0) {
    const durableSources = new Set(config.learning?.durableSources || []);
    if (!state.changedFiles.some((file) => durableSources.has(file))) {
      fail("--promoted-rule requires a durable rule source in --changed");
    }
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  process.stdout.write(`${path.relative(repoRoot, statePath)}\n`);
}

function terminateOwnedProcess(child, signal) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (_) {
      // Fall back to the exact child PID if the process group is already gone.
    }
  }
  try {
    child.kill(signal);
  } catch (_) {
    // The child already exited.
  }
}

async function runConfiguredCommand(entry) {
  const [executable, ...args] = entry.argv;
  process.stdout.write(`\n[harness] ${entry.name}\n$ ${entry.argv.join(" ")}\n`);
  const startedAt = Date.now();
  const child = spawn(executable, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminateOwnedProcess(child, "SIGTERM");
    setTimeout(() => terminateOwnedProcess(child, "SIGKILL"), 2000).unref();
  }, entry.timeoutMs);
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  const durationMs = Date.now() - startedAt;
  const result = {
    command: entry.argv.join(" "),
    exitCode: timedOut ? 124 : (Number.isInteger(exit.code) ? exit.code : 1),
    durationMs,
    ranAt: new Date().toISOString(),
  };
  if (timedOut || exit.code !== 0) {
    const message = timedOut
      ? `${entry.name} timed out after ${entry.timeoutMs}ms`
      : `${entry.name} failed with ${exit.signal || `exit code ${exit.code}`}`;
    const error = new Error(message);
    error.isHarnessError = true;
    error.harnessResult = result;
    throw error;
  }
  process.stdout.write(`[harness] passed in ${(durationMs / 1000).toFixed(1)}s\n`);
  return result;
}

async function appendCommandResults(config, runId, results) {
  if (!runId || results.length === 0) return;
  const { statePath, state } = await readState(config, runId);
  state.commands.push(...results);
  state.updatedAt = new Date().toISOString();
  validateState(state);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function verify(config, parsed) {
  const tierName = parsed.positionals[0] || "quick";
  const tier = config.tiers[tierName];
  const runId = parsed.flags.get("run");
  if (runId != null && typeof runId !== "string") fail("--run requires a run-id");
  if (!tier) fail(`Unknown verify tier: ${tierName}`);
  if (tierName === "release" && process.env.QA_BASE_URL) {
    fail("Release QA refuses QA_BASE_URL. Unset it so tests use isolated local servers.");
  }
  if (tierName === "release") await doctor({ quiet: true });
  const results = [];
  for (const entry of tier) {
    try {
      results.push(await runConfiguredCommand(entry));
    } catch (error) {
      if (error.harnessResult) results.push(error.harnessResult);
      await appendCommandResults(config, runId, results);
      throw error;
    }
  }
  await appendCommandResults(config, runId, results);
  process.stdout.write(`\n[harness] ${tierName} verification passed (${tier.length} commands)\n`);
}

async function validateRuns(config, parsed) {
  if (parsed.positionals[0]) {
    const { statePath, state } = await readState(config, parsed.positionals[0]);
    validateState(state);
    process.stdout.write(`${path.relative(repoRoot, statePath)}: valid\n`);
    return;
  }
  const base = runDirectory(config);
  let entries = [];
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      process.stdout.write("No harness runs to validate\n");
      return;
    }
    throw error;
  }
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const { statePath, state } = await readState(config, entry.name);
    validateState(state);
    process.stdout.write(`${path.relative(repoRoot, statePath)}: valid\n`);
  }
}

function help() {
  process.stdout.write(`Quilo agent harness\n\n` +
    `  doctor\n` +
    `  init <run-id> --objective "..." [--tool codex|claude-code] [--acceptance "..."] [--path "..."]\n` +
    `  checkpoint <run-id> [--status ...] [--next "..."] [--hypothesis "..."] [--changed path] [--note "..."]\n` +
    `    completion: --rule-review "..." [--promoted-rule "..." --changed <durable-source>]\n` +
    `  resume [run-id]\n` +
    `  validate [run-id]\n` +
    `  verify quick|core|release [--run <run-id>]\n`);
}

async function main() {
  const command = process.argv[2] || "help";
  const parsed = parseArgs(process.argv.slice(3));
  if (command === "help" || command === "--help" || command === "-h") return help();
  if (command === "doctor") return doctor();
  const config = await loadConfig();
  validateConfiguredCommands(config);
  if (command === "init") return initRun(config, parsed);
  if (command === "checkpoint") return checkpointRun(config, parsed);
  if (command === "resume") return resumeRun(config, parsed);
  if (command === "validate") return validateRuns(config, parsed);
  if (command === "verify") return verify(config, parsed);
  fail(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`[harness] ${error.message}\n`);
  process.exitCode = 1;
});
