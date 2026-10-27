import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveWorkspaceHandoffDir } from "./claude-session-parser.mjs";
import { connectRpcPost, discoverLanguageServer, findAgyCli } from "./ls-discovery.mjs";
import { resolveWorkspaceRoot } from "./state.mjs";
import { errorText, executionPrompt, failureKind, isWithin, scopeViolations, verifyFiles } from "./job-outcome.mjs";

const MAX_WINDOWS_SAFE_PROMPT_CHARS = 12000;

export const UNIFIED_MODEL_TIERS = Object.freeze({
  pro: Object.freeze({
    tier: "pro",
    aliases: Object.freeze(["pro", "gemini-pro"]),
    desktopModel: "pro",
    cliModel: "gemini-4-argon-high",
    description: "Flagship deep-reasoning Gemini Pro / Argon tier"
  }),
  flash: Object.freeze({
    tier: "flash",
    aliases: Object.freeze(["flash", "gemini-flash"]),
    desktopModel: "flash",
    cliModel: "gemini-3.8-flash-medium",
    description: "Balanced fast Gemini Flash tier"
  }),
  flash_lite: Object.freeze({
    tier: "flash_lite",
    aliases: Object.freeze(["flash_lite", "flash-lite", "lite", "fast"]),
    desktopModel: "flash_lite",
    cliModel: "gemini-3.8-flash-low",
    description: "Lowest-latency lightweight Gemini Flash tier"
  })
});

export const SUPPORTED_CLI_MODELS = Object.freeze([
  "gemini-4-argon-high",
  "gemini-4-argon-medium",
  "gemini-4-argon-low",
  "gemini-3.8-flash-high",
  "gemini-3.8-flash-medium",
  "gemini-3.8-flash-low",
  "claude-opus-5-5-high",
  "claude-opus-5-5-medium",
  "claude-opus-5-5-low",
  "claude-sonnet-5-5-high",
  "claude-sonnet-5-5-medium",
  "claude-sonnet-5-5-low",
  "gpt-oss-120b-medium"
]);

const TIER_BY_ALIAS = new Map();
for (const def of Object.values(UNIFIED_MODEL_TIERS)) {
  for (const alias of def.aliases) {
    TIER_BY_ALIAS.set(alias, def);
  }
}

const SUPPORTED_CLI_MODEL_SET = new Set(SUPPORTED_CLI_MODELS.map((m) => m.toLowerCase()));
const cliModelsProbeCache = new Map();

function probeDynamicCliModels(cliPath) {
  if (!cliPath || !fs.existsSync(cliPath)) return null;
  if (cliModelsProbeCache.has(cliPath)) return cliModelsProbeCache.get(cliPath);
  try {
    const out = execFileSync(cliPath, ["models"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
    const ids = new Set();
    for (const line of String(out ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("Fetching")) continue;
      const id = trimmed.split(/\s+/)[0]?.trim().toLowerCase();
      if (id && /^[a-z0-9][a-z0-9._-]{2,63}$/.test(id)) {
        ids.add(id);
      }
    }
    const result = ids.size > 0 ? ids : null;
    cliModelsProbeCache.set(cliPath, result);
    return result;
  } catch {
    cliModelsProbeCache.set(cliPath, null);
    return null;
  }
}

function createUnsupportedModelError(requestedModel, backend, extraHint = "") {
  const desktopList = Object.keys(UNIFIED_MODEL_TIERS).join(", ");
  const cliList = SUPPORTED_CLI_MODELS.join(", ");
  const suffix = extraHint ? ` ${extraHint}` : "";
  const err = new Error(
    `Unsupported --model "${requestedModel}" for backend "${backend}".` +
      `${suffix} Supported canonical tiers (both backends): ${desktopList}.` +
      ` Supported concrete CLI models (--backend cli): ${cliList}.`
  );
  err.code = "ERR_UNSUPPORTED_MODEL";
  return err;
}

export function normalizeBackendChoice(requestedBackend) {
  if (!requestedBackend) return "auto";
  const key = String(requestedBackend).trim().toLowerCase();
  if (key === "auto") return "auto";
  if (key === "desktop" || key === "desktop-live") return "desktop";
  if (key === "cli" || key === "cli-headless") return "cli";
  const err = new Error(`Invalid --backend "${requestedBackend}". Expected one of: auto, desktop, cli.`);
  err.code = "ERR_INVALID_BACKEND";
  throw err;
}

export function normalizeDesktopModelTier(requestedModel, defaultTier = "pro") {
  if (!requestedModel || !String(requestedModel).trim()) {
    return UNIFIED_MODEL_TIERS[defaultTier]?.desktopModel || "pro";
  }
  const raw = String(requestedModel).trim();
  const lower = raw.toLowerCase();
  const tierDef = TIER_BY_ALIAS.get(lower);
  if (tierDef) return tierDef.desktopModel;

  if (SUPPORTED_CLI_MODEL_SET.has(lower)) {
    throw createUnsupportedModelError(
      raw,
      "desktop-live",
      `"${raw}" is a concrete agy CLI model ID; Antigravity Desktop agentapi only accepts canonical tiers (pro, flash, flash_lite). Pass --backend cli to run "${raw}" via agy CLI.`
    );
  }
  throw createUnsupportedModelError(raw, "desktop-live");
}

function selectCliTierModel(tierDef, dynamicSet) {
  if (!dynamicSet || dynamicSet.has(tierDef.cliModel)) {
    return tierDef.cliModel;
  }
  const candidates = [...dynamicSet];
  if (tierDef.tier === "pro") {
    return (
      candidates.find((m) => m.startsWith("gemini-") && (m.includes("pro") || m.includes("argon")) && m.endsWith("-high")) ||
      candidates.find((m) => m.startsWith("gemini-") && (m.includes("pro") || m.includes("argon"))) ||
      tierDef.cliModel
    );
  }
  if (tierDef.tier === "flash") {
    return (
      candidates.find((m) => m.startsWith("gemini-") && m.includes("flash") && m.endsWith("-medium")) ||
      candidates.find((m) => m.startsWith("gemini-") && m.includes("flash")) ||
      tierDef.cliModel
    );
  }
  return (
    candidates.find((m) => m.startsWith("gemini-") && m.includes("flash") && (m.endsWith("-low") || m.includes("lite"))) ||
    tierDef.cliModel
  );
}

export function normalizeCliModelArgs(requestedModel, options = {}) {
  const defaultTier = UNIFIED_MODEL_TIERS.pro;
  if (!requestedModel || !String(requestedModel).trim()) {
    const dynamicSet = options.availableCliModels ?? null;
    return ["--model", selectCliTierModel(defaultTier, dynamicSet)];
  }

  const raw = String(requestedModel).trim();
  const lower = raw.toLowerCase();
  const tierDef = TIER_BY_ALIAS.get(lower);
  if (tierDef) {
    const dynamicSet = options.availableCliModels ?? null;
    return ["--model", selectCliTierModel(tierDef, dynamicSet)];
  }

  if (SUPPORTED_CLI_MODEL_SET.has(lower)) {
    return ["--model", lower];
  }

  const dynamicSet =
    options.availableCliModels ?? (options.cliPath ? probeDynamicCliModels(options.cliPath) : null);
  if (dynamicSet && dynamicSet.has(lower)) {
    return ["--model", lower];
  }

  throw createUnsupportedModelError(raw, "cli-headless");
}

export function validateModelForBackend(requestedModel, backend, options = {}) {
  const target = backend === "desktop" || backend === "desktop-live" ? "desktop-live" : "cli-headless";
  if (target === "desktop-live") {
    const resolved = normalizeDesktopModelTier(requestedModel, options.defaultTier || "pro");
    return { backend: "desktop-live", resolvedModel: resolved, args: [`--model=${resolved}`] };
  }
  const cliArgs = normalizeCliModelArgs(requestedModel, options);
  return { backend: "cli-headless", resolvedModel: cliArgs[1] || null, args: cliArgs };
}

export function normalizeUriPathForCompare(uriOrPath, platform = process.platform) {
  let raw = String(uriOrPath ?? "").trim();
  if (!raw) return "";
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.replace(/^file:\/\/\/?/i, "");
  if (platform === "win32" && /^\/[a-zA-Z]:/.test(raw)) {
    raw = raw.slice(1);
  } else if (platform !== "win32" && !raw.startsWith("/")) {
    raw = `/${raw}`;
  }
  raw = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  if (platform === "darwin") {
    raw = raw.replace(/^\/private\/(var|tmp|etc)(\/|$)/, "/$1$2");
  }
  return platform === "win32" ? raw.toLowerCase() : raw;
}

export function fileUriToLocalPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    try {
      return fileURLToPath(decodeURIComponent(uri));
    } catch {
      return uri;
    }
  }
}

export async function getAntigravityStatus(cwd, options = {}) {
  const desktop = await discoverLanguageServer(options);
  const cli = findAgyCli(options);
  const activeBackend = desktop.available ? "desktop-live" : cli.available ? "cli-headless" : "unavailable";
  return {
    ready: desktop.available || cli.available,
    activeBackend,
    desktop,
    cli
  };
}

export async function ensureDesktopProjectId(conn, workspaceRoot) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const targetNorm = normalizeUriPathForCompare(resolvedRoot);
  let fallbackId = null;
  try {
    const listed = await connectRpcPost(conn.address, "ListProjects", {}, conn.csrfToken, 5000);
    const ids = Array.isArray(listed?.projectIds) ? listed.projectIds : [];
    if (ids.includes("default-cli-project")) fallbackId = "default-cli-project";
    else if (ids.includes("outside-of-project")) fallbackId = "outside-of-project";

    if (ids.length > 0) {
      const read = await connectRpcPost(conn.address, "ReadProjects", { ids }, conn.csrfToken, 8000);
      const projects = Array.isArray(read?.projects) ? read.projects : [];
      for (const proj of projects) {
        const resources = proj?.projectResources?.resources ?? [];
        for (const res of resources) {
          const resourceUri = res?.folderUri || res?.gitFolder?.folderUri || null;
          if (resourceUri && normalizeUriPathForCompare(resourceUri) === targetNorm) {
            return proj.id;
          }
        }
      }
    }

    // Create project in Antigravity Desktop if this folder has not been registered yet.
    // Note: CreateProject requires a non-empty `project.id` UUID and returns `{}` on HTTP 200.
    const folderUri = pathToFileURL(resolvedRoot).href;
    const isGitWorkspace = fs.existsSync(path.join(resolvedRoot, ".git"));
    const newId = randomUUID();
    const resourceEntry = isGitWorkspace
      ? { gitFolder: { folderUri, allowWrite: true } }
      : { folderUri };

    const created = await connectRpcPost(
      conn.address,
      "CreateProject",
      {
        project: {
          id: newId,
          name: path.basename(resolvedRoot) || "workspace",
          projectResources: {
            resources: [resourceEntry]
          }
        }
      },
      conn.csrfToken,
      8000
    );
    return created?.project?.id || newId;
  } catch {
    return fallbackId;
  }
}

function spillLargePromptIfNeeded(workspaceRoot, prompt, label = "prompt") {
  const text = String(prompt ?? "");
  if (text.length <= MAX_WINDOWS_SAFE_PROMPT_CHARS) return text;
  const handoffDir = resolveWorkspaceHandoffDir(workspaceRoot);
  const promptFile = path.join(handoffDir, `${label}-${Date.now().toString(36)}.md`);
  fs.writeFileSync(promptFile, text, "utf8");
  return [
    `The full task/review specification (${text.length} chars) has been written inside the workspace at:`,
    `\`${promptFile}\``,
    "",
    "Read that file completely first, then follow all instructions in it accurately.",
    "",
    "Preview of the beginning of the specification:",
    text.slice(0, 4000),
    "\n...[read full file above for remaining content]..."
  ].join("\n");
}

function invokeAgentApi(conn, args, projectId = null) {
  if (!conn.exePath || !fs.existsSync(conn.exePath)) {
    throw new Error("Antigravity language_server binary path is unavailable for agentapi.");
  }
  const env = {
    ...process.env,
    ANTIGRAVITY_LS_ADDRESS: conn.address,
    ANTIGRAVITY_CSRF_TOKEN: conn.csrfToken,
    ANTIGRAVITY_AGENTAPI_EXE: conn.exePath
  };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  else delete env.ANTIGRAVITY_PROJECT_ID;
  delete env.ANTIGRAVITY_CONVERSATION_ID;

  let stdout = "";
  try {
    stdout = execFileSync(conn.exePath, ["agentapi", ...args], {
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024
    });
  } catch (err) {
    const errStdout = String(err?.stdout ?? "").trim();
    const errStderr = String(err?.stderr ?? "").trim();
    if (errStdout.startsWith("{")) {
      try {
        const parsedErr = JSON.parse(errStdout);
        if (parsedErr.error) throw new Error(`Antigravity agentapi error: ${parsedErr.error}`);
      } catch (inner) {
        if (inner instanceof Error && inner.message.startsWith("Antigravity agentapi error:")) throw inner;
      }
    }
    throw new Error(`Antigravity agentapi failed: ${(errStderr || errStdout || err.message).slice(0, 400)}`);
  }
  const parsed = stdout.trim() ? JSON.parse(stdout) : {};
  if (parsed.error) {
    throw new Error(`Antigravity agentapi error: ${parsed.error}`);
  }
  return parsed;
}

export function snapshotWorkspaceFiles(workspaceRoot) {
  try {
    const res = spawnSync("git", ["status", "--porcelain=v1", "-z", "-uall"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000
    });
    if (res.status !== 0) return null;
    const map = new Map();
    const entries = String(res.stdout ?? "").split("\0");
    for (let i = 0; i < entries.length; i += 1) {
      const line = entries[i];
      if (line.length < 4) continue;
      const gitCode = line.slice(0, 2);
      const rel = line.slice(3);
      if (/[RC]/.test(gitCode)) i += 1; // -z emits destination then original name.
      if (!rel || rel.replace(/\\/g, "/").includes(".claude/agy-handoffs")) continue;
      const abs = path.resolve(workspaceRoot, rel);
      let mtimeMs = 0;
      let size = -1;
      let digest = null;
      try {
        const st = fs.lstatSync(abs);
        mtimeMs = st.mtimeMs;
        size = st.size;
        if (st.isFile()) digest = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
      } catch {}
      map.set(abs, { gitCode, mtimeMs, size, digest });
    }
    return map;
  } catch {
    return null;
  }
}

export function diffWorkspaceSnapshots(preSnap, postSnap) {
  if (!preSnap || !postSnap) return [];
  const changed = [];
  for (const [abs, curr] of postSnap.entries()) {
    const prev = preSnap.get(abs);
    if (!prev || prev.gitCode !== curr.gitCode || prev.digest !== curr.digest || prev.size !== curr.size) {
      changed.push(abs);
    }
  }
  for (const abs of preSnap.keys()) {
    if (!postSnap.has(abs)) changed.push(abs); // Reverting a pre-existing dirty file is also a change.
  }
  return changed;
}

function isRpcMethodUnsupportedError(err) {
  const code = Number(err?.statusCode ?? 0);
  if (code === 404 || code === 405 || code === 501) return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("unimplemented") || msg.includes("unknown method") || msg.includes("unknown service");
}

function isStepTerminal(status) {
  const s = String(status ?? "").toUpperCase();
  return s.includes("DONE") || s.includes("ERROR") || s.includes("CANCELED") || s.includes("CANCELLED") || s.includes("FAILED");
}

export function isTrajectoryRunning(trajStatus) {
  const s = String(trajStatus ?? "").toUpperCase();
  if (!s) return false;
  return (
    s.includes("RUNNING") ||
    s.includes("QUEUED") ||
    s.includes("STARTING") ||
    s.includes("PENDING") ||
    s.includes("IN_PROGRESS")
  );
}

export function isTrajectoryError(trajStatus) {
  const s = String(trajStatus ?? "").toUpperCase();
  return s.includes("ERROR") || s.includes("FAILED");
}

export function isTrajectoryCanceled(trajStatus) {
  const s = String(trajStatus ?? "").toUpperCase();
  return s.includes("CANCELED") || s.includes("CANCELLED") || s.includes("ABORTED");
}

export function extractTurnDataFromSteps(steps, startIndex = 0) {
  const slice = Array.isArray(steps) ? steps.slice(startIndex) : [];
  let finalMessage = "";
  let notifyMessage = "";
  const reasoningSummary = [];
  let hasActiveSteps = false;
  let hasPlannerResponse = false;
  let hasErrorStep = false;
  let errorMessage = "";

  for (const step of slice) {
    const statusStr = String(step.status ?? "").toUpperCase();
    if (!isStepTerminal(statusStr)) {
      hasActiveSteps = true;
    }
    if (statusStr.includes("ERROR") || statusStr.includes("FAILED")) {
      hasErrorStep = true;
      errorMessage = errorText(step.error) || errorText(step.errorMessage) || errorText(step.errorStep) || errorMessage;
    }
    const pr = step.plannerResponse;
    if (pr && typeof pr === "object") {
      if (pr.thinking) {
        const firstLine = String(pr.thinking).trim().split(/\r?\n/)[0]?.trim();
        if (firstLine && !reasoningSummary.includes(firstLine)) {
          reasoningSummary.push(firstLine.slice(0, 180));
        }
      }
      const msg = String(pr.modifiedResponse || pr.response || "").trim();
      if (msg) {
        finalMessage = msg;
        if (!Array.isArray(pr.toolCalls) || pr.toolCalls.length === 0) {
          hasPlannerResponse = true;
        }
      }
    }
    const nu = step.notifyUser;
    if (nu && typeof nu === "object") {
      const nMsg = String(nu.message || nu.notificationContent || nu.text || "").trim();
      if (nMsg) notifyMessage = nMsg;
    }
  }

  return {
    stepCount: slice.length,
    hasActiveSteps,
    hasPlannerResponse,
    hasErrorStep,
    errorMessage,
    finalMessage: finalMessage || notifyMessage,
    reasoningSummary: reasoningSummary.slice(-6)
  };
}

export function formatEmptyTurnMessage({
  workspaceRoot,
  backend,
  conversationId,
  touchedFiles = [],
  stepCount = 0,
  timedOut = false
}) {
  const relFiles = touchedFiles.map((f) => {
    const rel = workspaceRoot ? path.relative(workspaceRoot, f) : f;
    return (rel && !rel.startsWith("..") ? rel : f).replace(/\\/g, "/");
  });
  const filesList = relFiles.map((f) => `\`${f}\``).join(", ");
  const convRef = conversationId ? `\`${conversationId}\`` : "the session";

  if (timedOut) {
    return relFiles.length > 0
      ? `Antigravity turn reached its time limit (${stepCount} step(s) observed) on ${convRef}; partial file changes detected (${relFiles.length}): ${filesList}.`
      : `Antigravity turn reached its time limit (${stepCount} step(s) observed) on ${convRef} with no repository file changes detected.`;
  }

  if (relFiles.length > 0) {
    return `Completed without textual response; created/modified ${relFiles.length} file(s): ${filesList}.`;
  }

  const whereHint =
    backend === "desktop-live"
      ? `inspect conversation ${convRef} in Antigravity Desktop`
      : `resume with \`agy --conversation ${conversationId || "<id>"}\``;

  if (stepCount > 0) {
    return `Completed without textual response (${stepCount} step(s) executed; no repository file changes detected — ${whereHint}).`;
  }
  return `No textual response or repository file changes were produced (${whereHint}).`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runDesktopTurnOnce(conn, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const callAgentApi = options.invokeAgentApiFn ?? invokeAgentApi;
  const preSnap = snapshotWorkspaceFiles(workspaceRoot);
  const modelTier = normalizeDesktopModelTier(options.model, options.defaultModelTier || "pro");
  const projectId = await ensureDesktopProjectId(conn, workspaceRoot);
  const safePrompt = spillLargePromptIfNeeded(workspaceRoot, executionPrompt(options.prompt, options), options.kind || "task");

  let conversationId = options.resumeConversationId || null;
  let initialStepCount = 0;
  let trajectoryRpcUnsupported = false;

  if (conversationId) {
    try {
      const pre = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 6000);
      initialStepCount = pre?.trajectory?.steps?.length ?? 0;
    } catch (err) {
      if (isRpcMethodUnsupportedError(err)) trajectoryRpcUnsupported = true;
    }
    options.onProgress?.({ phase: "starting", message: `Sending follow-up turn to Antigravity conversation ${conversationId}.` });
    const args = ["send-message"];
    if (options.title) args.push(`--title=${options.title}`);
    args.push(conversationId, safePrompt);
    callAgentApi(conn, args, projectId);
  } else {
    options.onProgress?.({ phase: "starting", message: `Starting live Antigravity Desktop conversation (model=${modelTier}).` });
    const args = ["new-conversation", `--model=${modelTier}`];
    if (options.title) args.push(`--title=${options.title}`);
    args.push(safePrompt);
    const created = callAgentApi(conn, args, projectId);
    const ev = created?.response?.newConversation || created?.response?.new_conversation || {};
    conversationId = ev.conversationId || ev.conversation_id || null;
    if (!conversationId) {
      throw new Error(`Antigravity did not return a conversationId: ${JSON.stringify(created)}`);
    }
  }

  options.onStarted?.({ conversationId, backend: "desktop-live", projectId });

  if (options.focusUi) {
    await connectRpcPost(conn.address, "SmartFocusConversation", { cascadeId: conversationId }, conn.csrfToken, 3000).catch(() => {});
  }

  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  // 1. Wait briefly until the new user turn registers in GetCascadeTrajectory
  let steps = [];
  let lastTrajStatus = null;
  let trajectoryError = "";
  if (!trajectoryRpcUnsupported) {
    for (let i = 0; i < 25 && Date.now() < deadline; i += 1) {
      try {
        const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 5000);
        steps = traj?.trajectory?.steps ?? [];
        lastTrajStatus = traj?.status || traj?.trajectory?.status || null;
        trajectoryError = errorText(traj?.error) || errorText(traj?.trajectory?.error);
        if (steps.length > initialStepCount) break;
      } catch (err) {
        if (isRpcMethodUnsupportedError(err)) {
          trajectoryRpcUnsupported = true;
          break;
        }
      }
      await sleep(pollIntervalMs);
    }
  }

  // 2. Graceful fallback if a future Antigravity build removes internal trajectory Connect RPCs
  if (trajectoryRpcUnsupported) {
    let metadataNote = "";
    try {
      const meta = callAgentApi(conn, ["get-conversation-metadata", conversationId], projectId);
      const title = meta?.response?.title || meta?.title || "";
      if (title) metadataNote = ` ("${title}")`;
    } catch {}
    return {
      exitStatus: 0,
      completionVerified: false,
      backend: "desktop-live",
      conversationId,
      projectId,
      finalMessage: `Task dispatched live to Antigravity Desktop conversation \`${conversationId}\`${metadataNote}. (Live trajectory streaming RPC was unavailable on this Desktop build; inspect progress directly in Antigravity Desktop.)`,
      reasoningSummary: [],
      touchedFiles: []
    };
  }

  // 3. Wait for conversation idle + terminal trajectory status (never break while CASCADE_RUN_STATUS_RUNNING!)
  let lastLoggedStepCount = initialStepCount;
  let extracted = extractTurnDataFromSteps(steps, initialStepCount);
  let unchangedStepPolls = 0;
  const idleWaitSec = Math.max(1, Math.min(15, Math.ceil((options.idleSliceMs ?? 15000) / 1000)));
  const idleRpcTimeoutMs = (idleWaitSec + 5) * 1000;

  while (Date.now() < deadline) {
    try {
      await connectRpcPost(
        conn.address,
        "WaitForConversationFullyIdle",
        {
          conversationId,
          inactivityTimeoutSeconds: idleWaitSec,
          returnOnExecutorError: true
        },
        conn.csrfToken,
        idleRpcTimeoutMs
      );
    } catch {
      await sleep(Math.min(1000, pollIntervalMs * 2));
    }

    try {
      const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 8000);
      const prevLen = steps.length;
      steps = traj?.trajectory?.steps ?? [];
      lastTrajStatus = traj?.status || traj?.trajectory?.status || lastTrajStatus;
      trajectoryError = errorText(traj?.error) || errorText(traj?.trajectory?.error) || trajectoryError;

      if (steps.length > lastLoggedStepCount) {
        lastLoggedStepCount = steps.length;
        unchangedStepPolls = 0;
        options.onProgress?.({
          phase: "running",
          conversationId,
          message: `Antigravity trajectory progressed to ${steps.length} step(s) (status=${lastTrajStatus || "unknown"}).`
        });
      } else if (steps.length === prevLen) {
        unchangedStepPolls += 1;
      }

      extracted = extractTurnDataFromSteps(steps, initialStepCount);

      if (lastTrajStatus) {
        if ((isTrajectoryError(lastTrajStatus) || isTrajectoryCanceled(lastTrajStatus)) && extracted.stepCount > 0) break;
        // Authoritative trajectory status from Antigravity Hub: keep waiting while RUNNING/QUEUED/PENDING
        if (!isTrajectoryRunning(lastTrajStatus) && !extracted.hasActiveSteps && extracted.stepCount > 0) {
          break;
        }
      } else {
        // Minimal mock server without top-level `status`
        if (
          extracted.stepCount > 0 &&
          !extracted.hasActiveSteps &&
          (extracted.hasPlannerResponse || unchangedStepPolls >= 2)
        ) {
          break;
        }
      }
    } catch (err) {
      if (isRpcMethodUnsupportedError(err)) {
        return { exitStatus: 0, completionVerified: false, backend: "desktop-live", conversationId, projectId,
          finalMessage: "Task dispatched; trajectory monitoring became unavailable. Completion must be checked in Antigravity Desktop.",
          touchedFiles: diffWorkspaceSnapshots(preSnap, snapshotWorkspaceFiles(workspaceRoot)), reasoningSummary: extracted.reasoningSummary };
      }
    }

    await sleep(Math.min(1000, pollIntervalMs * 2));
  }

  const timedOut =
    Date.now() >= deadline &&
    (isTrajectoryRunning(lastTrajStatus) || extracted.hasActiveSteps || extracted.stepCount === 0);

  // 4. Collect touched files by merging GetTrajectoryFileDiffs + workspace git snapshot diff
  const touchedSet = new Set();
  const outOfWorkspaceFiles = [];
  try {
    const diffRes = await connectRpcPost(conn.address, "GetTrajectoryFileDiffs", { conversationId }, conn.csrfToken, 6000);
    const diffs = Array.isArray(diffRes?.diffs) ? diffRes.diffs : [];
    for (const d of diffs) {
      const localPath = d?.uri ? fileUriToLocalPath(d.uri) : null;
      if (!localPath) continue;
      if (!isWithin(workspaceRoot, localPath)) {
        outOfWorkspaceFiles.push(path.resolve(localPath));
      } else if (!options.resumeConversationId && !localPath.replace(/\\/g, "/").includes("/.claude/agy-handoffs/")) {
        touchedSet.add(path.resolve(localPath));
      }
    }
  } catch {}

  if (preSnap) {
    const postSnap = snapshotWorkspaceFiles(workspaceRoot);
    for (const changedPath of diffWorkspaceSnapshots(preSnap, postSnap)) {
      touchedSet.add(changedPath);
    }
  }
  const touchedFiles = [...touchedSet];

  let exitStatus = 0;
  if (timedOut) {
    exitStatus = 124;
  } else if (isTrajectoryCanceled(lastTrajStatus)) {
    exitStatus = 130;
  } else if (isTrajectoryError(lastTrajStatus)) {
    exitStatus = 1;
  } else if (extracted.errorMessage && !isTrajectoryRunning(lastTrajStatus)) {
    exitStatus = 1;
  } else if (extracted.stepCount === 0) {
    exitStatus = 1;
  }

  const errorMessage = timedOut ? `Antigravity Desktop timed out after ${Math.round(timeoutMs / 1000)}s (${extracted.stepCount} steps observed).` :
    exitStatus !== 0 ? trajectoryError || extracted.errorMessage || extracted.finalMessage || `Antigravity Desktop ended with ${lastTrajStatus || "no completed turn"}.` : null;
  const finalMessage =
    extracted.finalMessage ||
    (exitStatus !== 0 && !timedOut ? `${errorMessage} Partial file changes detected: ${touchedFiles.length}.` : "") ||
    formatEmptyTurnMessage({
      workspaceRoot,
      backend: "desktop-live",
      conversationId,
      touchedFiles,
      stepCount: extracted.stepCount,
      timedOut
    });

  return {
    exitStatus,
    backend: "desktop-live",
    conversationId,
    projectId,
    trajectoryStatus: lastTrajStatus,
    completionVerified: !timedOut,
    errorMessage,
    failureKind: exitStatus !== 0 ? failureKind(errorMessage, exitStatus) : null,
    timedOut,
    stepCount: extracted.stepCount,
    finalMessage,
    reasoningSummary: extracted.reasoningSummary,
    touchedFiles,
    outOfWorkspaceFiles
  };
}

async function stopDesktopBeforeResume(conn, conversationId, options) {
  try {
    await connectRpcPost(conn.address, "CancelCascadeInvocation", { cascadeId: conversationId, killBackgroundTasks: true }, conn.csrfToken, 5000);
    const deadline = Date.now() + (options.stopTimeoutMs ?? 15000);
    do {
      const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 5000);
      const status = traj?.status || traj?.trajectory?.status;
      if (status && !isTrajectoryRunning(status) &&
        (!extractTurnDataFromSteps(traj?.trajectory?.steps).hasActiveSteps || isTrajectoryCanceled(status) || isTrajectoryError(status))) return true;
      await sleep(options.pollIntervalMs ?? 400);
    } while (Date.now() < deadline);
  } catch {}
  return false;
}

export async function runDesktopTurn(conn, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const initialSnapshot = snapshotWorkspaceFiles(workspaceRoot);
  const maxResumes = options.maxResumes ?? 2;
  const checkpoints = [];
  const touched = new Set();
  let resumeConversationId = options.resumeConversationId;
  let prompt = options.prompt;
  for (let attempt = 0; ; attempt += 1) {
    let turn;
    try {
      turn = await runDesktopTurnOnce(conn, cwd, { ...options, prompt, resumeConversationId });
    } catch (err) {
      if (!checkpoints.length) throw err;
      turn = { exitStatus: 1, backend: "desktop-live", conversationId: resumeConversationId,
        errorMessage: err.message, failureKind: failureKind(err.message), finalMessage: err.message, touchedFiles: [] };
    }
    for (const file of turn.touchedFiles || []) touched.add(file);
    turn.touchedFiles = [...touched];
    turn.fileVerification = verifyFiles(turn.touchedFiles);
    turn.scopeViolations = scopeViolations(workspaceRoot, [...turn.touchedFiles, ...(turn.outOfWorkspaceFiles || [])], options);
    if (turn.scopeViolations.length) {
      if (turn.timedOut) turn.remoteStopped = await stopDesktopBeforeResume(conn, turn.conversationId, options);
      turn.exitStatus = 1;
      turn.failureKind = "scope_violation";
      turn.errorMessage = `Changes outside the assigned scope detected: ${turn.scopeViolations.join(", ")}`;
    }
    turn.resumeCount = attempt;
    turn.checkpoints = checkpoints;
    if (!["timeout", "step_limit"].includes(turn.failureKind) || !turn.conversationId) return turn;
    turn.exitStatus = 124;
    const checkpoint = { attempt: attempt + 1, savedAt: new Date().toISOString(), conversationId: turn.conversationId,
      reason: turn.errorMessage, stepCount: turn.stepCount, touchedFiles: turn.touchedFiles,
      fileVerification: turn.fileVerification, summary: turn.finalMessage, remainingWork: "Verify current files against the original task and finish pending work." };
    checkpoints.push(checkpoint);
    options.onCheckpoint?.(checkpoint);
    // Never overlap follow-up messages with an executor still writing files.
    const stopped = turn.timedOut ? await stopDesktopBeforeResume(conn, turn.conversationId, options) : turn.completionVerified;
    turn.remoteStopped = Boolean(stopped);
    for (const file of diffWorkspaceSnapshots(initialSnapshot, snapshotWorkspaceFiles(workspaceRoot))) touched.add(file);
    turn.touchedFiles = [...touched];
    turn.fileVerification = verifyFiles(turn.touchedFiles);
    checkpoint.touchedFiles = turn.touchedFiles;
    checkpoint.fileVerification = turn.fileVerification;
    checkpoint.remoteStopped = turn.remoteStopped;
    options.onCheckpoint?.(checkpoint);
    turn.scopeViolations = scopeViolations(workspaceRoot, turn.touchedFiles, options);
    if (turn.scopeViolations.length) {
      turn.exitStatus = 1;
      turn.failureKind = "scope_violation";
      turn.errorMessage = `Changes outside the assigned scope detected: ${turn.scopeViolations.join(", ")}`;
      return turn;
    }
    if (!stopped || attempt >= maxResumes) return turn;
    resumeConversationId = turn.conversationId;
    options.onProgress?.({ phase: "resuming", conversationId: resumeConversationId,
      message: `Checkpoint saved; resuming the same conversation (${attempt + 1}/${maxResumes}).` });
    prompt = ["Continue the interrupted task in this same conversation. Inspect existing changes first and preserve completed work.",
      `Original task:\n${options.prompt}`, `Recovery checkpoint:\n${JSON.stringify(checkpoint)}`,
      "Finish remaining work, run the relevant checks, and report the result. Do not repeat completed actions."].join("\n\n");
  }
}

export function buildCliTurnArgs(workspaceRoot, options = {}) {
  const safePrompt = spillLargePromptIfNeeded(workspaceRoot, executionPrompt(options.prompt, options), options.kind || "cli");
  const args = ["--output-format", "stream-json", "--disable-slash-commands"];
  if (options.resumeConversationId) {
    args.push("--conversation", options.resumeConversationId);
  }
  if (options.write) {
    args.push("--mode=auto", "--dangerously-skip-permissions");
  } else {
    args.push("--mode=plan");
  }
  args.push(...normalizeCliModelArgs(options.model, { cliPath: options.cliPath, availableCliModels: options.availableCliModels }));
  // Attach prompt directly to `--print=...` at the end so `agy` never consumes another flag as the prompt.
  args.push(`--print=${safePrompt}`);
  return args;
}

export function extractCliStreamEvent(ev) {
  if (!ev || typeof ev !== "object") {
    return { conversationId: null, streamedDelta: "", finalResponse: null, errorMessage: null, thinking: null };
  }

  const conversationId =
    ev.conversation_id ||
    ev.conversationId ||
    ev.session_id ||
    ev.sessionId ||
    ev.init?.conversation_id ||
    ev.step_update?.conversation_id ||
    ev.result?.conversation_id ||
    null;

  let streamedDelta = "";
  let finalResponse = null;
  let errorMessage = null;
  let thinking = typeof ev.thinking === "string" ? ev.thinking : null;

  // Real `agy --output-format stream-json` v1.4+ schema (`event: "init" | "step_update" | "result"`)
  if (ev.step_update && typeof ev.step_update === "object") {
    const su = ev.step_update;
    if ((su.step_type === "agent_response" || !su.step_type) && typeof su.text_delta === "string") {
      streamedDelta = su.text_delta;
    }
    if (typeof su.thinking_delta === "string" && su.thinking_delta.trim()) {
      thinking = su.thinking_delta;
    }
  }

  if (ev.result && typeof ev.result === "object") {
    if (ev.result.status === "ERROR" || ev.result.error) {
      errorMessage = errorText(ev.result.error) || errorText(ev.result.message) || errorText(ev.result.response) || "agy CLI returned status ERROR";
    }
    if (typeof ev.result.response === "string" && ev.result.response.trim()) {
      finalResponse = ev.result.response;
    }
  } else if (typeof ev.result === "string") {
    finalResponse = ev.result;
  } else if (ev.error) {
    errorMessage = errorText(ev.error) || "agy CLI returned an error";
  } else if (typeof ev.text === "string") {
    streamedDelta = ev.text;
  } else if (typeof ev.content === "string" && (ev.type === "assistant" || ev.type === "message" || ev.type === "result")) {
    finalResponse = ev.content;
  }

  return { conversationId, streamedDelta, finalResponse, errorMessage, thinking };
}

export async function runCliTurn(cliInfo, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const preSnap = snapshotWorkspaceFiles(workspaceRoot);

  let resolvedCliPath = cliInfo.path;
  if (process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd")) {
    const siblingExe = resolvedCliPath.slice(0, -4) + ".exe";
    if (fs.existsSync(siblingExe)) resolvedCliPath = siblingExe;
  }

  const args = buildCliTurnArgs(workspaceRoot, { ...options, cliPath: resolvedCliPath });

  const isCmd = process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd");
  const safeCmdArgs = isCmd ? args.map((a) => String(a).replace(/\r?\n/g, " ")) : args;
  const spawnFile = isCmd ? (process.env.ComSpec || "cmd.exe") : resolvedCliPath;
  const spawnArgs = isCmd ? ["/d", "/s", "/c", resolvedCliPath, ...safeCmdArgs] : args;
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const child = spawn(spawnFile, spawnArgs, {
      cwd: workspaceRoot,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let conversationId = options.resumeConversationId || null;
    let timedOut = false;
    let streamedText = "";
    let explicitResultText = null;
    let explicitError = null;
    let stepEventsCount = 0;
    const nonJsonLines = [];
    const reasoningSummary = [];

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
    }, timeoutMs);

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith("{")) {
        nonJsonLines.push(trimmed);
        return;
      }
      try {
        const ev = JSON.parse(trimmed);
        stepEventsCount += 1;
        const parsed = extractCliStreamEvent(ev);
        if (parsed.conversationId && !conversationId) {
          conversationId = parsed.conversationId;
          options.onStarted?.({ conversationId, backend: "cli-headless" });
        }
        if (parsed.streamedDelta) streamedText += parsed.streamedDelta;
        if (parsed.finalResponse != null) explicitResultText = parsed.finalResponse;
        if (parsed.errorMessage) explicitError = parsed.errorMessage;
        if (parsed.thinking) {
          const line0 = parsed.thinking.trim().split(/\r?\n/)[0]?.slice(0, 180);
          if (line0 && !reasoningSummary.includes(line0)) reasoningSummary.push(line0);
        }
      } catch {
        nonJsonLines.push(trimmed);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx = stdoutBuf.indexOf("\n");
      while (idx !== -1) {
        processLine(stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
        idx = stdoutBuf.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBuf += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (stdoutBuf.trim()) processLine(stdoutBuf);

      let touchedFiles = [];
      if (preSnap) {
        const postSnap = snapshotWorkspaceFiles(workspaceRoot);
        touchedFiles = diffWorkspaceSnapshots(preSnap, postSnap);
      }

      const rawExit = timedOut ? 124 : code ?? (signal ? 130 : 1);
      let exitStatus = explicitError && rawExit === 0 ? 1 : rawExit;
      const assembledText = (
        explicitResultText ??
        (streamedText.trim() || nonJsonLines.join("\n").trim())
      ).trim();

      let errorMessage = timedOut ? `agy CLI timed out after ${Math.round(timeoutMs / 1000)}s.` :
        exitStatus !== 0 ? explicitError || stderrBuf.trim() || assembledText || `agy CLI exited with code ${exitStatus}${signal ? ` (${signal})` : ""}.` : null;
      const violations = scopeViolations(workspaceRoot, touchedFiles, options);
      if (violations.length) { exitStatus = 1; errorMessage = `Changes outside the assigned scope detected: ${violations.join(", ")}`; }
      const finalMessage =
        assembledText ||
        explicitError ||
        (timedOut
          ? `agy CLI timed out after ${Math.round(timeoutMs / 1000)}s.`
          : stderrBuf.trim() ||
            formatEmptyTurnMessage({
              workspaceRoot,
              backend: "cli-headless",
              conversationId,
              touchedFiles,
              stepCount: stepEventsCount,
              timedOut: false
            }));

      resolve({
        exitStatus,
        backend: "cli-headless",
        conversationId: conversationId || null,
        projectId: null,
        finalMessage,
        reasoningSummary: reasoningSummary.slice(-6),
        touchedFiles,
        fileVerification: verifyFiles(touchedFiles),
        scopeViolations: violations,
        errorMessage,
        failureKind: violations.length ? "scope_violation" : exitStatus !== 0 ? failureKind(errorMessage, exitStatus) : null,
        stderr: stderrBuf.trim()
      });
    });
  });
}

export async function resolveExecutionBackendAndValidateModel(cwd, options = {}) {
  const backendChoice = normalizeBackendChoice(options.backend);
  const status = options.statusSnapshot ?? (await getAntigravityStatus(cwd, options.discoveryOptions));

  if (!status.ready) {
    const installHint = status.cli.installUrl || status.cli.installCommand || "https://antigravity.google/download";
    throw new Error(
      `Google Antigravity is not running and 'agy' CLI is not installed. Open Antigravity 2.0 Desktop or install from ${installHint}, then run /agy:setup.`
    );
  }

  let selectedBackend;
  if (backendChoice === "desktop") {
    if (!status.desktop.available) {
      throw new Error(
        "Antigravity 2.0 Desktop is not running (--backend desktop was requested). Open Antigravity Desktop or pass --backend cli."
      );
    }
    selectedBackend = "desktop-live";
  } else if (backendChoice === "cli") {
    if (!status.cli.available) {
      const installHint = status.cli.installUrl || "https://antigravity.google/download";
      throw new Error(
        `'agy' CLI is not installed (--backend cli was requested). Install from ${installHint} or omit --backend cli to use Antigravity Desktop.`
      );
    }
    selectedBackend = "cli-headless";
  } else {
    selectedBackend = status.desktop.available ? "desktop-live" : "cli-headless";
  }

  const validation = validateModelForBackend(options.model, selectedBackend, {
    defaultTier: options.defaultModelTier || "pro",
    cliPath: status.cli?.path || null
  });

  return {
    status,
    backendChoice,
    selectedBackend,
    resolvedModel: validation.resolvedModel
  };
}

export async function runDualAntigravityTurn(cwd, options = {}) {
  const { status, backendChoice, selectedBackend } = await resolveExecutionBackendAndValidateModel(cwd, options);

  if (selectedBackend === "desktop-live") {
    let startedDesktopConversation = false;
    try {
      return await runDesktopTurn(status.desktop, cwd, {
        ...options,
        onStarted: (info) => {
          startedDesktopConversation = true;
          options.onStarted?.(info);
        }
      });
    } catch (err) {
      if (err?.code === "ERR_UNSUPPORTED_MODEL" || err?.code === "ERR_INVALID_BACKEND") {
        throw err;
      }
      if (backendChoice === "auto" && !startedDesktopConversation && status.cli.available) {
        options.onProgress?.({
          phase: "fallback",
          message: `Desktop dispatch failed (${err.message}); falling back automatically to agy CLI.`
        });
        return runCliTurn(status.cli, cwd, options);
      }
      throw err;
    }
  }

  return runCliTurn(status.cli, cwd, options);
}

export function terminateProcessTree(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5000 });
    } else {
      process.kill(pid, "SIGTERM");
    }
    return true;
  } catch {
    return false;
  }
}

export async function cancelAntigravityJob(cwd, job, options = {}) {
  let cancelledRemote = false;
  if (job?.conversationId) {
    const desktop = await discoverLanguageServer(options);
    if (desktop.available) {
      try {
        await connectRpcPost(
          desktop.address,
          "CancelCascadeInvocation",
          { cascadeId: job.conversationId, killBackgroundTasks: true },
          desktop.csrfToken,
          4000
        );
        cancelledRemote = true;
      } catch {}
      try {
        await connectRpcPost(
          desktop.address,
          "ForceStopCascadeTree",
          { conversationId: job.conversationId },
          desktop.csrfToken,
          4000
        );
        cancelledRemote = true;
      } catch {}
    }
  }
  const killedPid = job?.pid ? terminateProcessTree(job.pid) : false;
  return { cancelledRemote, killedPid };
}
