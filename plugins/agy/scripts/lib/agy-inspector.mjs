import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveWorkspaceHandoffDir } from "./claude-session-parser.mjs";
import { connectRpcPost, discoverLanguageServer } from "./ls-discovery.mjs";
import { fileUriToLocalPath, normalizeUriPathForCompare } from "./agy-runtime.mjs";
import {
  getLatestConversationId,
  listJobs,
  resolveWorkspaceRoot,
  setLatestConversationId
} from "./state.mjs";

function formatRelativeDuration(targetIso, nowMs = Date.now()) {
  if (!targetIso) return "n/a";
  const targetMs = Date.parse(targetIso);
  if (!Number.isFinite(targetMs)) return "n/a";
  const diffSec = Math.max(0, Math.round((targetMs - nowMs) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

export function renderProgressBar(fraction, width = 12) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  const empty = Math.max(0, width - filled);
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

function extractUserTextFromStep(step) {
  const ui = step?.userInput;
  if (!ui || typeof ui !== "object") return "";
  if (typeof ui.userResponse === "string" && ui.userResponse.trim()) {
    return ui.userResponse.trim();
  }
  if (Array.isArray(ui.items)) {
    const parts = ui.items
      .map((it) => it?.text || it?.chunk || "")
      .map((s) => String(s).trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

function buildStepsDialogueMarkdown(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return "";
  const blocks = [];
  let turnNum = 0;
  for (const step of steps) {
    const type = String(step?.type ?? "");
    if (type.includes("USER_INPUT")) {
      const text = extractUserTextFromStep(step);
      if (text) {
        turnNum += 1;
        blocks.push(`### Step ${turnNum} — User (in Antigravity)\n\n${text}`);
      }
      continue;
    }
    const pr = step?.plannerResponse;
    if (pr && typeof pr === "object") {
      const msg = String(pr.modifiedResponse || pr.response || "").trim();
      const tools = Array.isArray(pr.toolCalls)
        ? pr.toolCalls.map((tc) => `\`${tc.name || "tool"}\``).join(", ")
        : "";
      if (msg || tools) {
        turnNum += 1;
        const lines = [`### Step ${turnNum} — Antigravity Agent`];
        if (tools) lines.push(`*Tools called:* ${tools}`);
        if (msg) lines.push(msg);
        blocks.push(lines.join("\n\n"));
      }
    }
  }
  return blocks.join("\n\n---\n\n");
}

function scanOfflineAntigravityBrain(workspaceRoot, options = {}) {
  const brainRoots = options.brainRoots ?? [
    path.join(os.homedir(), ".gemini", "antigravity", "brain"),
    path.join(os.homedir(), ".gemini", "antigravity-cli", "brain")
  ];
  const entries = [];
  for (const root of brainRoots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const transcriptFile = path.join(root, d.name, ".system_generated", "logs", "transcript.jsonl");
      if (!fs.existsSync(transcriptFile)) continue;
      try {
        const stat = fs.statSync(transcriptFile);
        entries.push({
          conversationId: d.name,
          transcriptFile,
          lastModifiedTime: new Date(stat.mtimeMs).toISOString(),
          mtimeMs: stat.mtimeMs
        });
      } catch {}
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries;
}

function parseOfflineBrainTranscript(transcriptFile) {
  const raw = fs.readFileSync(transcriptFile, "utf8");
  const blocks = [];
  let stepCount = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      stepCount += 1;
      const type = String(obj.type ?? "");
      const content = String(obj.content ?? "").trim();
      if (!content) continue;
      if (type === "USER_INPUT") {
        blocks.push(`### Step ${stepCount} — User\n\n${content}`);
      } else if (type === "PLANNER_RESPONSE") {
        blocks.push(`### Step ${stepCount} — Antigravity Agent\n\n${content}`);
      }
    } catch {}
  }
  return { stepCount, markdown: blocks.join("\n\n---\n\n") };
}

export async function pullFromAntigravity(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const normWs = normalizeUriPathForCompare(workspaceRoot);
  const ls = await discoverLanguageServer(options.discoveryOptions);

  if (ls.available) {
    const allRes = await connectRpcPost(ls.address, "GetAllCascadeTrajectories", {}, ls.csrfToken, 6000);
    const summariesObj = allRes?.trajectorySummaries ?? {};
    const allItems = Object.entries(summariesObj).map(([cid, meta]) => {
      const wsUris = [
        ...(meta?.workspaces ?? []).map((w) => w?.workspaceFolderAbsoluteUri),
        ...(meta?.trajectoryMetadata?.workspaces ?? []).map((w) => w?.workspaceFolderAbsoluteUri)
      ].filter(Boolean);
      const matchesWorkspace = wsUris.some((u) => normalizeUriPathForCompare(u) === normWs);
      return {
        conversationId: cid,
        stepCount: Number(meta?.stepCount ?? 0),
        status: String(meta?.status ?? "UNKNOWN").replace(/^CASCADE_RUN_STATUS_/, ""),
        lastModifiedTime: meta?.lastModifiedTime || meta?.createdTime || null,
        matchesWorkspace,
        workspaces: wsUris
      };
    });

    allItems.sort((a, b) => Date.parse(b.lastModifiedTime || 0) - Date.parse(a.lastModifiedTime || 0));
    const filtered = options.all ? allItems : allItems.filter((it) => it.matchesWorkspace);
    const pool = filtered.length > 0 ? filtered : allItems;

    if (options.listOnly) {
      return {
        mode: "list",
        backend: "desktop-live",
        conversations: (options.all ? allItems : pool).slice(0, 20)
      };
    }

    const targetId =
      options.conversationId ||
      (filtered[0]?.conversationId ?? getLatestConversationId(workspaceRoot) ?? allItems[0]?.conversationId);

    if (!targetId) {
      throw new Error("No Antigravity conversations found to pull into Claude Code.");
    }

    const trajRes = await connectRpcPost(
      ls.address,
      "GetCascadeTrajectory",
      { cascadeId: targetId },
      ls.csrfToken,
      8000
    );
    const steps = trajRes?.trajectory?.steps ?? [];
    let markdown = buildStepsDialogueMarkdown(steps);

    if (!markdown) {
      try {
        const mdRes = await connectRpcPost(
          ls.address,
          "ConvertTrajectoryToMarkdown",
          { conversationId: targetId, trajectory: trajRes?.trajectory },
          ls.csrfToken,
          8000
        );
        markdown = String(mdRes?.markdown ?? "").trim();
      } catch {}
    }

    let touchedFiles = [];
    try {
      const diffRes = await connectRpcPost(
        ls.address,
        "GetTrajectoryFileDiffs",
        { conversationId: targetId },
        ls.csrfToken,
        6000
      );
      touchedFiles = (diffRes?.diffs ?? [])
        .map((d) => (d?.uri ? fileUriToLocalPath(d.uri) : null))
        .filter(Boolean);
    } catch {}

    const handoffDir = resolveWorkspaceHandoffDir(workspaceRoot);
    const archivePath = path.join(handoffDir, `pulled-${targetId}.md`);
    const fullArchive = [
      `# Antigravity 2.0 Conversation Pulled into Claude Code`,
      `- **Antigravity Conversation ID:** \`${targetId}\``,
      `- **Total Steps:** ${steps.length}`,
      touchedFiles.length > 0
        ? `- **Files Modified in Antigravity:**\n${[...new Set(touchedFiles)].map((f) => `  - \`${f}\``).join("\n")}`
        : `- **Files Modified in Antigravity:** (none reported)`,
      "",
      "## Chronological Trajectory",
      "",
      markdown || "*(No textual steps recorded)*"
    ].join("\n");
    fs.writeFileSync(archivePath, `${fullArchive}\n`, "utf8");
    setLatestConversationId(workspaceRoot, targetId);

    const maxInline = options.maxInlineChars ?? 9000;
    const inlineExcerpt =
      markdown.length > maxInline
        ? `*(Showing latest ${maxInline} chars — full trajectory saved at \`${archivePath}\`)*\n\n...${markdown.slice(-maxInline)}`
        : markdown;

    return {
      mode: "pull",
      backend: "desktop-live",
      conversationId: targetId,
      stepCount: steps.length,
      touchedFiles: [...new Set(touchedFiles)],
      archivePath,
      excerpt: inlineExcerpt
    };
  }

  // Offline fallback: read from ~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl
  const offlineEntries = scanOfflineAntigravityBrain(workspaceRoot, options);
  if (options.listOnly) {
    return {
      mode: "list",
      backend: "brain-offline",
      conversations: offlineEntries.slice(0, 20).map((e) => ({
        conversationId: e.conversationId,
        stepCount: null,
        status: "OFFLINE_LOG",
        lastModifiedTime: e.lastModifiedTime,
        matchesWorkspace: true
      }))
    };
  }

  const chosen = options.conversationId
    ? offlineEntries.find((e) => e.conversationId === options.conversationId)
    : offlineEntries[0];

  if (!chosen) {
    throw new Error(
      "Antigravity 2.0 Desktop is not running and no local brain transcripts were found in ~/.gemini/antigravity/brain."
    );
  }

  const parsed = parseOfflineBrainTranscript(chosen.transcriptFile);
  const handoffDir = resolveWorkspaceHandoffDir(workspaceRoot);
  const archivePath = path.join(handoffDir, `pulled-${chosen.conversationId}.md`);
  fs.writeFileSync(archivePath, `# Offline Pulled Antigravity Transcript (${chosen.conversationId})\n\n${parsed.markdown}\n`, "utf8");
  setLatestConversationId(workspaceRoot, chosen.conversationId);

  return {
    mode: "pull",
    backend: "brain-offline",
    conversationId: chosen.conversationId,
    stepCount: parsed.stepCount,
    touchedFiles: [],
    archivePath,
    excerpt: parsed.markdown.slice(-9000)
  };
}

export async function getQuotaHud(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const ls = await discoverLanguageServer(options.discoveryOptions);
  const jobs = listJobs(workspaceRoot);
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "queued");

  if (!ls.available) {
    return {
      available: false,
      backend: "unavailable",
      planName: null,
      models: [],
      activeJobs,
      recentJobsCount: jobs.length,
      detail: "Open Antigravity 2.0 Desktop to inspect live per-model quota bars and reset timers."
    };
  }

  let planName = "Unknown";
  let teamsTier = null;
  let accountLabel = null;
  try {
    const userRes = await connectRpcPost(ls.address, "GetUserStatus", {}, ls.csrfToken, 5000);
    const planInfo = userRes?.userStatus?.planStatus?.planInfo ?? {};
    planName = planInfo.planName || planInfo.teamsTier || "Active";
    teamsTier = planInfo.teamsTier || null;
    if (options.showAccount && userRes?.userStatus?.email) {
      accountLabel = userRes.userStatus.email;
    }
  } catch {}

  const modelRes = await connectRpcPost(ls.address, "GetCascadeModelConfigData", {}, ls.csrfToken, 5000);
  const configs = Array.isArray(modelRes?.clientModelConfigs) ? modelRes.clientModelConfigs : [];
  const models = configs.map((cfg) => {
    const rem = cfg?.quotaInfo?.remainingFraction;
    const remainingFraction = typeof rem === "number" ? rem : 1;
    const resetTime = cfg?.quotaInfo?.resetTime || null;
    return {
      label: cfg.label || "Model",
      remainingFraction,
      remainingPct: Math.round(remainingFraction * 1000) / 10,
      bar: renderProgressBar(remainingFraction, 12),
      resetTime,
      resetIn: formatRelativeDuration(resetTime, options.nowMs),
      supportsImages: Boolean(cfg.supportsImages),
      isRecommended: Boolean(cfg.isRecommended)
    };
  });

  return {
    available: true,
    backend: "desktop-live",
    address: ls.address,
    planName,
    teamsTier,
    accountLabel,
    models,
    activeJobs,
    recentJobsCount: jobs.length
  };
}

export async function forkAntigravityConversation(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const ls = await discoverLanguageServer(options.discoveryOptions);
  if (!ls.available) {
    throw new Error("`/agy:fork` requires Antigravity 2.0 Desktop to be running (`desktop-live`).");
  }

  const sourceId = options.conversationId || getLatestConversationId(workspaceRoot);
  if (!sourceId) {
    throw new Error("No active Antigravity conversation ID found to fork. Pass a <conversation-id> or run /agy:transfer first.");
  }

  let forkStep = options.stepIndex != null ? Number(options.stepIndex) : null;
  if (forkStep == null || !Number.isInteger(forkStep)) {
    const traj = await connectRpcPost(ls.address, "GetCascadeTrajectory", { cascadeId: sourceId }, ls.csrfToken, 6000);
    const len = traj?.trajectory?.steps?.length ?? 1;
    forkStep = Math.max(0, len - 1);
  }

  const res = await connectRpcPost(
    ls.address,
    "ForkConversation",
    {
      sourceCascadeId: sourceId,
      forkAtStepIndex: forkStep
    },
    ls.csrfToken,
    10000
  );

  const newConversationId = res?.newCascadeId || res?.new_cascade_id;
  if (!newConversationId) {
    throw new Error(`Antigravity ForkConversation did not return a newCascadeId: ${JSON.stringify(res)}`);
  }

  setLatestConversationId(workspaceRoot, newConversationId);
  if (options.focusUi !== false) {
    await connectRpcPost(ls.address, "SmartFocusConversation", { cascadeId: newConversationId }, ls.csrfToken, 3000).catch(() => {});
  }

  return {
    sourceConversationId: sourceId,
    newConversationId,
    forkedAtStepIndex: res?.forkedAtStepIndex ?? forkStep
  };
}

export async function undoAntigravityTurn(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const latestJob = options.jobId ? jobs.find((j) => j.id === options.jobId) : jobs[0];
  const targetId = options.conversationId || latestJob?.conversationId || getLatestConversationId(workspaceRoot);

  const ls = await discoverLanguageServer(options.discoveryOptions);
  let targetStep = options.stepIndex != null ? Number(options.stepIndex) : null;
  let previewEdits = [];
  let rpcSupported = false;

  if (ls.available && targetId) {
    try {
      const traj = await connectRpcPost(ls.address, "GetCascadeTrajectory", { cascadeId: targetId }, ls.csrfToken, 6000);
      const steps = traj?.trajectory?.steps ?? [];
      if (targetStep == null) {
        // Find the last USER_INPUT step index so reverting rolls back the last delegated turn
        for (let i = steps.length - 1; i >= 0; i -= 1) {
          if (String(steps[i]?.type ?? "").includes("USER_INPUT")) {
            targetStep = Math.max(0, i);
            break;
          }
        }
        if (targetStep == null) targetStep = Math.max(0, steps.length - 1);
      }

      const prev = await connectRpcPost(
        ls.address,
        "GetRevertPreview",
        { cascadeId: targetId, stepIndex: targetStep },
        ls.csrfToken,
        6000
      ).catch(() => ({}));
      previewEdits = Array.isArray(prev?.codeEdits) ? prev.codeEdits : [];
      rpcSupported = true;
    } catch {}
  }

  const touchedFiles = latestJob?.touchedFiles ?? [];

  if (!options.apply) {
    return {
      applied: false,
      conversationId: targetId || null,
      stepIndex: targetStep,
      rpcSupported,
      previewEditsCount: previewEdits.length,
      touchedFiles,
      message: "Dry-run preview complete. Re-run with `--apply` to execute the revert."
    };
  }

  let revertedViaRpc = false;
  if (ls.available && targetId && targetStep != null) {
    try {
      await connectRpcPost(
        ls.address,
        "RevertToCascadeStep",
        { cascadeId: targetId, stepIndex: targetStep },
        ls.csrfToken,
        10000
      );
      revertedViaRpc = true;
    } catch {}
  }

  let revertedGitFiles = [];
  if (!revertedViaRpc && touchedFiles.length > 0) {
    const res = spawnSync("git", ["checkout", "--", ...touchedFiles], {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000
    });
    if (res.status === 0) {
      revertedGitFiles = touchedFiles;
    }
  }

  if (!revertedViaRpc && revertedGitFiles.length === 0) {
    throw new Error(
      "Could not revert automatically (no active Desktop revert step or git-tracked touchedFiles found)."
    );
  }

  return {
    applied: true,
    revertedViaRpc,
    revertedGitFiles,
    conversationId: targetId || null,
    stepIndex: targetStep
  };
}
