import { execFileSync, spawn, spawnSync } from "node:child_process";
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

export function normalizeUriPathForCompare(uriOrPath) {
  let raw = String(uriOrPath ?? "").trim();
  if (!raw) return "";
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.replace(/^file:\/\/\/?/i, "");
  if (process.platform === "win32" && /^\/[a-zA-Z]:/.test(raw)) {
    raw = raw.slice(1);
  }
  raw = raw.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? raw.toLowerCase() : raw;
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
  const targetNorm = normalizeUriPathForCompare(workspaceRoot);
  try {
    const listed = await connectRpcPost(conn.address, "ListProjects", {}, conn.csrfToken, 5000);
    const ids = Array.isArray(listed?.projectIds) ? listed.projectIds : [];
    if (ids.length > 0) {
      const read = await connectRpcPost(conn.address, "ReadProjects", { ids }, conn.csrfToken, 8000);
      const projects = Array.isArray(read?.projects) ? read.projects : [];
      for (const proj of projects) {
        const resources = proj?.projectResources?.resources ?? [];
        for (const res of resources) {
          if (res?.folderUri && normalizeUriPathForCompare(res.folderUri) === targetNorm) {
            return proj.id;
          }
        }
      }
    }

    // Create project in Antigravity Desktop if this folder has not been registered yet
    const folderUri = pathToFileURL(path.resolve(workspaceRoot)).href;
    const created = await connectRpcPost(
      conn.address,
      "CreateProject",
      {
        project: {
          name: path.basename(workspaceRoot) || "workspace",
          projectResources: {
            resources: [{ folderUri }]
          }
        }
      },
      conn.csrfToken,
      8000
    );
    if (created?.project?.id) return created.project.id;
  } catch {
    // Non-fatal: agentapi still starts conversations even if project resolution fails.
  }
  return null;
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

  const stdout = execFileSync(conn.exePath, ["agentapi", ...args], {
    encoding: "utf8",
    env,
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024
  });
  const parsed = stdout.trim() ? JSON.parse(stdout) : {};
  if (parsed.error) {
    throw new Error(`Antigravity agentapi error: ${parsed.error}`);
  }
  return parsed;
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
  const projectId = await ensureDesktopProjectId(conn, workspaceRoot);
  const safePrompt = spillLargePromptIfNeeded(workspaceRoot, options.prompt, options.kind || "task");
  const modelTier = normalizeDesktopModelTier(options.model, options.defaultModelTier || "pro");

  let conversationId = options.resumeConversationId || null;
  let initialStepCount = 0;

  if (conversationId) {
    try {
      const pre = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 6000);
      initialStepCount = pre?.trajectory?.steps?.length ?? 0;
    } catch {}
    options.onProgress?.({ phase: "starting", message: `Sending follow-up turn to Antigravity conversation ${conversationId}.` });
    const args = ["send-message"];
    if (options.title) args.push(`--title=${options.title}`);
    args.push(conversationId, safePrompt);
    invokeAgentApi(conn, args, projectId);
  } else {
    options.onProgress?.({ phase: "starting", message: `Starting live Antigravity Desktop conversation (model=${modelTier}).` });
    const args = ["new-conversation", `--model=${modelTier}`];
    if (options.title) args.push(`--title=${options.title}`);
    args.push(safePrompt);
    const created = invokeAgentApi(conn, args, projectId);
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
  const deadline = Date.now() + timeoutMs;

  // 1. Wait briefly until the new user turn registers in GetCascadeTrajectory
  let steps = [];
  for (let i = 0; i < 25 && Date.now() < deadline; i += 1) {
    try {
      const traj = await connectRpcPost(conn.address, "GetCascadeTrajectory", { cascadeId: conversationId }, conn.csrfToken, 5000);
      steps = traj?.trajectory?.steps ?? [];
      if (steps.length > initialStepCount) break;
    } catch {}
    await sleep(400);
  }

  // 2. Wait for conversation idle + terminal planner response
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
      await sleep(1500);
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
    } catch {}

    await sleep(1000);
  }

  // 3. Collect touched files from GetTrajectoryFileDiffs
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

export async function runCliTurn(cliInfo, cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const args = ["--print", "--output-format", "stream-json"];
  if (options.resumeConversationId) {
    args.push("--conversation", options.resumeConversationId);
  }
  if (options.write) {
    args.push("--mode=auto", "--dangerously-skip-permissions");
  } else {
    args.push("--mode=plan");
  }
  if (options.model) {
    args.push("--model", String(options.model));
  }
  args.push(options.prompt);

  const isCmd = process.platform === "win32" && cliInfo.path.toLowerCase().endsWith(".cmd");
  const spawnFile = isCmd ? (process.env.ComSpec || "cmd.exe") : cliInfo.path;
  const spawnArgs = isCmd ? ["/d", "/s", "/c", cliInfo.path, ...args] : args;

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
    const textParts = [];
    const reasoningSummary = [];

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (!trimmed.startsWith("{")) {
        textParts.push(trimmed);
        return;
      }
      try {
        const ev = JSON.parse(trimmed);
        const cid = ev.conversation_id || ev.conversationId || ev.session_id || ev.sessionId;
        if (cid && !conversationId) {
          conversationId = cid;
          options.onStarted?.({ conversationId, backend: "cli-headless" });
        }
        if (typeof ev.result === "string") textParts.push(ev.result);
        else if (typeof ev.text === "string") textParts.push(ev.text);
        else if (typeof ev.content === "string" && (ev.type === "assistant" || ev.type === "message" || ev.type === "result")) {
          textParts.push(ev.content);
        }
        if (typeof ev.thinking === "string") {
          reasoningSummary.push(ev.thinking.trim().split(/\r?\n/)[0].slice(0, 180));
        }
      } catch {
        textParts.push(trimmed);
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
    child.on("error", reject);
    child.on("close", (code) => {
      if (stdoutBuf.trim()) processLine(stdoutBuf);
      const finalMessage = textParts.join("\n").trim();
      resolve({
        exitStatus: code ?? 0,
        backend: "cli-headless",
        conversationId,
        projectId: null,
        finalMessage: finalMessage || stderrBuf.trim(),
        reasoningSummary: reasoningSummary.slice(-6),
        touchedFiles: [],
        stderr: stderrBuf.trim()
      });
    });
  });
}

export async function runDualAntigravityTurn(cwd, options = {}) {
  const status = await getAntigravityStatus(cwd, options.discoveryOptions);
  if (!status.ready) {
    throw new Error(
      `Google Antigravity is not running and 'agy' CLI is not installed. Open Antigravity 2.0 Desktop or install the CLI (${status.cli.installCommand}), then run /agy:setup.`
    );
  }

  const preferCli = options.backend === "cli";
  if (!preferCli && status.desktop.available) {
    return runDesktopTurn(status.desktop, cwd, options);
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
