import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveWorkspaceHandoffDir } from "./claude-session-parser.mjs";
import { connectRpcPost, discoverLanguageServer, findAgyCli } from "./ls-discovery.mjs";
import { resolveWorkspaceRoot } from "./state.mjs";

const MAX_WINDOWS_SAFE_PROMPT_CHARS = 12000;

const MODEL_TIER_MAP = new Map([
  ["pro", "pro"],
  ["gemini-pro", "pro"],
  ["flash", "flash"],
  ["gemini-flash", "flash"],
  ["flash_lite", "flash_lite"],
  ["flash-lite", "flash_lite"],
  ["lite", "flash_lite"],
  ["fast", "flash_lite"]
]);

export function normalizeDesktopModelTier(requestedModel, defaultTier = "pro") {
  if (!requestedModel) return defaultTier;
  const key = String(requestedModel).trim().toLowerCase();
  if (MODEL_TIER_MAP.has(key)) return MODEL_TIER_MAP.get(key);
  if (key.includes("lite")) return "flash_lite";
  if (key.includes("flash")) return "flash";
  return "pro";
}

export function normalizeCliModelArgs(requestedModel) {
  if (!requestedModel) return [];
  const raw = String(requestedModel).trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  // Desktop tier aliases ("pro", "flash", "flash_lite") are not model IDs in `agy` CLI:
  // omit `--model` for "pro" (uses user's configured default model) and map fast tiers to `--effort`.
  if (lower === "pro" || lower === "gemini-pro") {
    return [];
  }
  if (lower === "flash" || lower === "gemini-flash") {
    return ["--effort", "medium"];
  }
  if (lower === "flash_lite" || lower === "flash-lite" || lower === "lite" || lower === "fast") {
    return ["--effort", "low"];
  }
  return ["--model", raw];
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

function snapshotGitStatusPaths(workspaceRoot) {
  try {
    const res = spawnSync("git", ["status", "--porcelain"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 4000
    });
    if (res.status !== 0) return null;
    const set = new Set();
    for (const line of String(res.stdout ?? "").split(/\r?\n/)) {
      if (line.length < 4) continue;
      const rel = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
      if (rel && !rel.includes(".claude/agy-handoffs")) {
        set.add(path.resolve(workspaceRoot, rel));
      }
    }
    return set;
  } catch {
    return null;
  }
}

function isRpcMethodUnsupportedError(err) {
  const code = Number(err?.statusCode ?? 0);
  if (code === 404 || code === 405 || code === 501) return true;
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("unimplemented") || msg.includes("unknown method") || msg.includes("unknown service");
}

function isStepTerminal(status) {
  const s = String(status ?? "");
  return s.includes("DONE") || s.includes("ERROR") || s.includes("CANCELED") || s.includes("CANCELLED") || s.includes("FAILED");
}

export function extractTurnDataFromSteps(steps, startIndex = 0) {
  const slice = Array.isArray(steps) ? steps.slice(startIndex) : [];
  let finalMessage = "";
  const reasoningSummary = [];
  let hasActiveSteps = false;
  let hasPlannerResponse = false;

  for (const step of slice) {
    if (!isStepTerminal(step.status)) {
      hasActiveSteps = true;
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
  }

  return {
    stepCount: slice.length,
    hasActiveSteps,
    hasPlannerResponse,
    finalMessage,
    reasoningSummary: reasoningSummary.slice(-6)
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runDesktopTurn(conn, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const callAgentApi = options.invokeAgentApiFn ?? invokeAgentApi;
  const preGitPaths = snapshotGitStatusPaths(workspaceRoot);
  const projectId = await ensureDesktopProjectId(conn, workspaceRoot);
  const safePrompt = spillLargePromptIfNeeded(workspaceRoot, options.prompt, options.kind || "task");
  const modelTier = normalizeDesktopModelTier(options.model, options.defaultModelTier || "pro");

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
  if (!trajectoryRpcUnsupported) {
    for (let i = 0; i < 25 && Date.now() < deadline; i += 1) {
      try {
        const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 5000);
        steps = traj?.trajectory?.steps ?? [];
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
      backend: "desktop-live",
      conversationId,
      projectId,
      finalMessage: `Task dispatched live to Antigravity Desktop conversation \`${conversationId}\`${metadataNote}. (Live trajectory streaming RPC was unavailable on this Desktop build; inspect progress directly in Antigravity Desktop.)`,
      reasoningSummary: [],
      touchedFiles: []
    };
  }

  // 3. Wait for conversation idle + terminal planner response
  let lastLoggedStepCount = initialStepCount;
  let extracted = extractTurnDataFromSteps(steps, initialStepCount);

  while (Date.now() < deadline) {
    try {
      await connectRpcPost(
        conn.address,
        "WaitForConversationFullyIdle",
        {
          conversationId,
          inactivityTimeoutSeconds: 45,
          returnOnExecutorError: true
        },
        conn.csrfToken,
        55000
      );
    } catch {
      await sleep(Math.min(1500, pollIntervalMs * 2));
    }

    try {
      const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 8000);
      steps = traj?.trajectory?.steps ?? [];
      if (steps.length > lastLoggedStepCount) {
        lastLoggedStepCount = steps.length;
        options.onProgress?.({
          phase: "running",
          conversationId,
          message: `Antigravity trajectory progressed to ${steps.length} step(s).`
        });
      }
      extracted = extractTurnDataFromSteps(steps, initialStepCount);
      if (extracted.stepCount > 0 && !extracted.hasActiveSteps && (extracted.hasPlannerResponse || steps.length > initialStepCount + 1)) {
        break;
      }
    } catch (err) {
      if (isRpcMethodUnsupportedError(err)) {
        break;
      }
    }

    await sleep(Math.min(1000, pollIntervalMs * 2));
  }

  // 4. Collect touched files from GetTrajectoryFileDiffs (with git status fallback)
  let touchedFiles = [];
  try {
    const diffRes = await connectRpcPost(conn.address, "GetTrajectoryFileDiffs", { conversationId }, conn.csrfToken, 6000);
    const diffs = Array.isArray(diffRes?.diffs) ? diffRes.diffs : [];
    const normWs = normalizeUriPathForCompare(workspaceRoot);
    touchedFiles = diffs
      .map((d) => (d?.uri ? fileUriToLocalPath(d.uri) : null))
      .filter(Boolean)
      .filter((p) => {
        const np = normalizeUriPathForCompare(p);
        return np.startsWith(normWs) && !np.includes("/.claude/agy-handoffs/");
      });
  } catch {}

  if (touchedFiles.length === 0 && preGitPaths) {
    const postGitPaths = snapshotGitStatusPaths(workspaceRoot);
    if (postGitPaths) {
      touchedFiles = [...postGitPaths].filter((p) => !preGitPaths.has(p));
    }
  }

  return {
    exitStatus: extracted.finalMessage ? 0 : 1,
    backend: "desktop-live",
    conversationId,
    projectId,
    finalMessage: extracted.finalMessage || "(Antigravity completed without a textual response — check the conversation in Antigravity Desktop.)",
    reasoningSummary: extracted.reasoningSummary,
    touchedFiles: [...new Set(touchedFiles)]
  };
}

export function buildCliTurnArgs(workspaceRoot, options = {}) {
  const safePrompt = spillLargePromptIfNeeded(workspaceRoot, options.prompt, options.kind || "cli");
  const args = ["--output-format", "stream-json", "--disable-slash-commands"];
  if (options.resumeConversationId) {
    args.push("--conversation", options.resumeConversationId);
  }
  if (options.write) {
    args.push("--mode=auto", "--dangerously-skip-permissions");
  } else {
    args.push("--mode=plan");
  }
  args.push(...normalizeCliModelArgs(options.model));
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
      errorMessage = String(ev.result.error || "agy CLI returned status ERROR");
    }
    if (typeof ev.result.response === "string" && ev.result.response.trim()) {
      finalResponse = ev.result.response;
    }
  } else if (typeof ev.result === "string") {
    finalResponse = ev.result;
  } else if (typeof ev.error === "string" && ev.error.trim()) {
    errorMessage = ev.error;
  } else if (typeof ev.text === "string") {
    streamedDelta = ev.text;
  } else if (typeof ev.content === "string" && (ev.type === "assistant" || ev.type === "message" || ev.type === "result")) {
    finalResponse = ev.content;
  }

  return { conversationId, streamedDelta, finalResponse, errorMessage, thinking };
}

export async function runCliTurn(cliInfo, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const preGitPaths = snapshotGitStatusPaths(workspaceRoot);
  const args = buildCliTurnArgs(workspaceRoot, options);

  let resolvedCliPath = cliInfo.path;
  if (process.platform === "win32" && resolvedCliPath.toLowerCase().endsWith(".cmd")) {
    const siblingExe = resolvedCliPath.slice(0, -4) + ".exe";
    if (fs.existsSync(siblingExe)) resolvedCliPath = siblingExe;
  }

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
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stdoutBuf.trim()) processLine(stdoutBuf);

      let touchedFiles = [];
      if (preGitPaths) {
        const postGitPaths = snapshotGitStatusPaths(workspaceRoot);
        if (postGitPaths) {
          touchedFiles = [...postGitPaths].filter((p) => !preGitPaths.has(p));
        }
      }

      const rawExit = timedOut ? 124 : code ?? 0;
      const exitStatus = explicitError && rawExit === 0 ? 1 : rawExit;
      const assembledText = (
        explicitResultText ??
        (streamedText.trim() || nonJsonLines.join("\n").trim())
      ).trim();

      const finalMessage =
        assembledText ||
        explicitError ||
        (timedOut ? `agy CLI timed out after ${Math.round(timeoutMs / 1000)}s.` : stderrBuf.trim());

      resolve({
        exitStatus,
        backend: "cli-headless",
        conversationId: conversationId || null,
        projectId: null,
        finalMessage,
        reasoningSummary: reasoningSummary.slice(-6),
        touchedFiles,
        stderr: stderrBuf.trim()
      });
    });
  });
}

export async function runDualAntigravityTurn(cwd, options = {}) {
  const status = await getAntigravityStatus(cwd, options.discoveryOptions);
  if (!status.ready) {
    const installHint = status.cli.installUrl || status.cli.installCommand || "https://antigravity.google/download";
    throw new Error(
      `Google Antigravity is not running and 'agy' CLI is not installed. Open Antigravity 2.0 Desktop or install from ${installHint}, then run /agy:setup.`
    );
  }

  const preferCli = options.backend === "cli";
  if (!preferCli && status.desktop.available) {
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
      if (!startedDesktopConversation && status.cli.available) {
        options.onProgress?.({
          phase: "fallback",
          message: `Desktop dispatch failed (${err.message}); falling back automatically to agy CLI.`
        });
        return runCliTurn(status.cli, cwd, options);
      }
      throw err;
    }
  }
  if (status.cli.available) {
    return runCliTurn(status.cli, cwd, options);
  }
  return runDesktopTurn(status.desktop, cwd, options);
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
