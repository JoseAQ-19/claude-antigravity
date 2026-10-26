#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { normalizeArgv, parseArgs } from "./lib/args.mjs";
import {
  forkAntigravityConversation,
  getQuotaHud,
  pullFromAntigravity,
  undoAntigravityTurn
} from "./lib/agy-inspector.mjs";
import {
  cancelAntigravityJob,
  getAntigravityStatus,
  resolveExecutionBackendAndValidateModel,
  runDualAntigravityTurn,
  SUPPORTED_CLI_MODELS,
  UNIFIED_MODEL_TIERS
} from "./lib/agy-runtime.mjs";
import {
  buildTransferHandoffBundle,
  resolveClaudeTranscriptPath
} from "./lib/claude-session-parser.mjs";
import { collectReviewContext } from "./lib/git.mjs";
import {
  buildMediaAnalysisBundle,
  buildPlanReviewBundle,
  syncAgentMemory
} from "./lib/media-plan-memory.mjs";
import {
  renderPullResult,
  renderQuotaHud,
  renderSetupReport,
  renderStatusTable,
  renderTransferResult,
  renderTurnResult
} from "./lib/render.mjs";
import {
  appendJobLog,
  generateJobId,
  getConfig,
  listJobs,
  nowIso,
  readJobFile,
  resolveJobLogFile,
  resolveWorkspaceRoot,
  SESSION_ID_ENV,
  setConfig,
  setLatestConversationId,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  applyWorktreePatch,
  captureWorktreeChanges,
  cleanupIsolatedWorktree,
  createIsolatedWorktree
} from "./lib/worktree.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

const MODEL_HELP_FOOTER = [
  "",
  "Canonical Model Tiers (work identically on both desktop-live and cli-headless):",
  ...Object.values(UNIFIED_MODEL_TIERS).map(
    (t) => `  ${t.tier.padEnd(11)} -> desktop: --model=${t.desktopModel} | cli: --model ${t.cliModel}`
  ),
  "",
  `Concrete CLI Models (require --backend cli when Desktop is running):`,
  `  ${SUPPORTED_CLI_MODELS.join(", ")}`,
  "",
  "CLI Execution & Permission Modes (cli-headless):",
  "  - Read-only default: uses --mode=plan (never auto-approves destructive commands).",
  "  - Write tasks (--write, --worktree, transfer w/ next-step, media): uses --mode=auto --dangerously-skip-permissions."
].join("\n");

const SUBCOMMAND_HELP = {
  setup: [
    "Usage: node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--cwd <dir>] [--json]",
    "",
    "Verify Google Antigravity 2.0 Desktop (live Connect RPC) and agy CLI readiness, or toggle the stop-time review gate."
  ].join("\n"),
  task: [
    "Usage: node scripts/agy-companion.mjs task [options] <prompt>",
    "",
    "Options:",
    "  --background                Run asynchronously in a detached worker process",
    "  --wait                      Run synchronously in foreground (default)",
    "  --write                     Allow file edits (enables --mode=auto --dangerously-skip-permissions on CLI)",
    "  --worktree                  Execute inside a clean, isolated git worktree (zero file collisions)",
    "  --keep-worktree             Preserve temporary git worktree directory after completion",
    "  --resume, --resume-last     Continue the latest workspace Antigravity conversation",
    "  --fresh                     Start a brand-new conversation even if a previous one exists",
    "  --conversation <id>         Resume a specific Antigravity conversation ID",
    "  --backend <auto|desktop|cli> Select engine explicitly (default: auto -> desktop-live if running, else cli)",
    "  --model, -m <tier|model-id> Model tier (pro|flash|flash_lite) or concrete CLI model ID (with --backend cli)",
    "  --prompt-file <path>        Read prompt text from a file instead of positional arguments",
    "  --focus-ui                  Bring Antigravity 2.0 Desktop conversation into visual focus",
    "  --cwd, -C <dir>             Override target workspace directory",
    "  --json                      Emit structured JSON output",
    "  --help, -h                  Show this help message and exit without creating a job",
    MODEL_HELP_FOOTER
  ].join("\n"),
  "task-resume-candidate": [
    "Usage: node scripts/agy-companion.mjs task-resume-candidate [--cwd <dir>] [--json]",
    "",
    "Inspect whether a resumable Antigravity conversation exists for this workspace."
  ].join("\n"),
  transfer: [
    "Usage: node scripts/agy-companion.mjs transfer [options] [next-step instruction]",
    "",
    "Teleport the active Claude Code session transcript into Google Antigravity and optionally execute the next step.",
    "",
    "Options:",
    "  --source <claude-jsonl>     Explicit path to Claude Code .jsonl session file",
    "  --handoff-only              Transfer context without executing the next pending step",
    "  --no-focus                  Do not focus the conversation in Antigravity 2.0 Desktop UI",
    "  --background | --wait       Run asynchronously or wait in foreground",
    "  --backend <auto|desktop|cli> Select engine explicitly (default: auto)",
    "  --model, -m <tier|model-id> Model tier (pro|flash|flash_lite) or concrete CLI model ID (with --backend cli)",
    "  --cwd, -C <dir>             Override target workspace directory",
    "  --json                      Emit structured JSON output",
    MODEL_HELP_FOOTER
  ].join("\n"),
  pull: [
    "Usage: node scripts/agy-companion.mjs pull [conversation-id] [--list] [--all] [--cwd <dir>] [--json]",
    "",
    "Pull a live or offline Antigravity 2.0 conversation trajectory and file diffs back into Claude Code."
  ].join("\n"),
  media: [
    "Usage: node scripts/agy-companion.mjs media <file...> [--no-correlate] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--focus-ui] [--json] [question]",
    "",
    "Analyze video (.mp4/.mov/.webm), audio (.mp3/.wav/.m4a), PDF, or image files natively via Gemini multimodal perception."
  ].join("\n"),
  review: [
    "Usage: node scripts/agy-companion.mjs review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json]",
    "",
    "Run a read-only Google Antigravity code review against uncommitted git changes or a branch diff."
  ].join("\n"),
  "adversarial-review": [
    "Usage: node scripts/agy-companion.mjs adversarial-review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
    "",
    "Run a skeptical, adversarial Google Antigravity security & edge-case review."
  ].join("\n"),
  "review-plan": [
    "Usage: node scripts/agy-companion.mjs review-plan [--plan <file>] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
    "",
    "Critique an implementation plan (PLAN.md, PRD.md, or Claude Plan Mode file) before writing code."
  ].join("\n"),
  quota: [
    "Usage: node scripts/agy-companion.mjs quota [--show-account] [--cwd <dir>] [--json]",
    "",
    "Display live per-model Antigravity 2.0 quota progress bars, model IDs, reset timers, and active jobs."
  ].join("\n"),
  undo: [
    "Usage: node scripts/agy-companion.mjs undo [job-id] [--conversation <id>] [--step <n>] [--apply] [--cwd <dir>] [--json]",
    "",
    "Preview (dry-run default) or apply (--apply) a surgical rollback of the latest Antigravity turn."
  ].join("\n"),
  fork: [
    "Usage: node scripts/agy-companion.mjs fork [conversation-id] [--step <n>] [--no-focus] [--cwd <dir>] [--json]",
    "",
    "Clone an existing Antigravity 2.0 Desktop conversation into a new branch via ForkConversation RPC."
  ].join("\n"),
  "sync-memory": [
    "Usage: node scripts/agy-companion.mjs sync-memory [--direction <both|claude-to-agy|agy-to-claude>] [--apply] [--cwd <dir>] [--json]",
    "",
    "Synchronize shared rules non-destructively between CLAUDE.md and AGENTS.md + .agents/rules/claude-memory-sync.md."
  ].join("\n"),
  status: [
    "Usage: node scripts/agy-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--cwd <dir>] [--json]",
    "",
    "List recorded Antigravity jobs for this workspace or inspect a specific job's status, exit code, and recent log."
  ].join("\n"),
  result: [
    "Usage: node scripts/agy-companion.mjs result [job-id] [--apply-worktree] [--cwd <dir>] [--json]",
    "",
    "Retrieve the rendered output of a completed Antigravity job, or apply its isolated git worktree patch."
  ].join("\n"),
  cancel: [
    "Usage: node scripts/agy-companion.mjs cancel [job-id] [--cwd <dir>] [--json]",
    "",
    "Cancel an active background Antigravity job and stop its remote Cascade invocation."
  ].join("\n")
};

function hasHelpFlag(rawArgv) {
  const tokens = normalizeArgv(rawArgv);
  for (const tok of tokens) {
    if (tok === "--") break;
    if (tok === "--help" || tok === "-h" || tok === "--help=true") return true;
  }
  return false;
}

function printSubcommandHelp(subcommand) {
  const body = SUBCOMMAND_HELP[subcommand];
  if (body) {
    console.log(body);
    return;
  }
  printUsage();
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs <command> [options]   (pass --help to any command for detailed options)",
      "",
      "Commands:",
      "  setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  task [--background|--wait] [--write] [--worktree] [--keep-worktree] [--resume|--fresh] [--conversation <id>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--focus-ui] [prompt]",
      "  task-resume-candidate [--json]",
      "  transfer [--source <claude-jsonl>] [--background|--wait] [--handoff-only] [--no-focus] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [instruction]",
      "  pull [conversation-id] [--list] [--all] [--json]",
      "  media <file...> [--no-correlate] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [question]",
      "  review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json]",
      "  adversarial-review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
      "  review-plan [--plan <file>] [--background|--wait] [--backend <auto|desktop|cli>] [--model <tier|model-id>] [--json] [focus text]",
      "  quota [--show-account] [--json]",
      "  undo [job-id] [--conversation <id>] [--step <n>] [--apply] [--json]",
      "  fork [conversation-id] [--step <n>] [--no-focus] [--json]",
      "  sync-memory [--direction <both|claude-to-agy|agy-to-claude>] [--apply] [--json]",
      "  status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  result [job-id] [--apply-worktree] [--json]",
      "  cancel [job-id] [--json]",
      MODEL_HELP_FOOTER
    ].join("\n")
  );
}

function emitOutput(payload, rendered, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(rendered);
  }
}

function shorten(text, max = 80) {
  const s = String(text ?? "").trim().replace(/\s+/g, " ");
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
}

function readPromptTemplate(name, vars = {}) {
  let content = fs.readFileSync(path.join(ROOT_DIR, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(vars)) {
    content = content.replaceAll(`{{${k}}}`, String(v ?? ""));
  }
  return content;
}

function findResumableJob(workspaceRoot, currentSessionOnly = false) {
  const sessionId = process.env[SESSION_ID_ENV] || null;
  const jobs = listJobs(workspaceRoot).filter((j) =>
    !currentSessionOnly || !sessionId ? true : j.sessionId === sessionId
  );
  const eligible = jobs.filter(
    (j) =>
      (j.kind === "task" || j.kind === "transfer" || j.kind === "media") &&
      j.conversationId &&
      j.conversationId !== "null" &&
      j.status !== "queued" &&
      j.status !== "running"
  );
  return eligible.find((j) => j.status === "completed") ?? eligible[0] ?? null;
}

function spawnBackgroundWorker(workspaceRoot, jobId) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "job-worker", "--cwd", workspaceRoot, "--job-id", jobId], {
    cwd: workspaceRoot,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid ?? null;
}

async function executeJobRequest(workspaceRoot, jobId, request, logFile) {
  const onStarted = ({ conversationId, backend }) => {
    appendJobLog(logFile, `Connected via ${backend}; conversationId=${conversationId}`);
    if (conversationId) setLatestConversationId(workspaceRoot, conversationId);
    const current = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
    writeJobFile(workspaceRoot, jobId, { ...current, conversationId, backend, phase: "running" });
    upsertJob(workspaceRoot, { id: jobId, conversationId, backend, phase: "running" });
  };
  const onProgress = (ev) => {
    const msg = typeof ev === "string" ? ev : ev?.message;
    if (msg) appendJobLog(logFile, msg);
  };

  if (request.type === "transfer") {
    const turn = await runDualAntigravityTurn(workspaceRoot, {
      prompt: request.prompt,
      title: request.conversationTitle,
      backend: request.backend || "auto",
      model: request.model || "pro",
      write: request.executeNextStep !== false,
      focusUi: request.focusUi !== false,
      kind: "transfer",
      onStarted,
      onProgress
    });
    const payload = {
      status: turn.exitStatus,
      backend: turn.backend,
      conversationId: turn.conversationId || null,
      resumeCommand: turn.conversationId ? `agy --conversation ${turn.conversationId}` : null,
      sourcePath: request.sourcePath,
      handoffPath: request.handoffPath,
      focusedUi: request.focusUi !== false && turn.backend === "desktop-live",
      executeNextStep: request.executeNextStep !== false,
      finalMessage: turn.finalMessage,
      touchedFiles: turn.touchedFiles,
      reasoningSummary: turn.reasoningSummary
    };
    const rendered = renderTransferResult(payload);
    return {
      exitStatus: turn.exitStatus,
      conversationId: turn.conversationId,
      backend: turn.backend,
      touchedFiles: turn.touchedFiles,
      payload,
      rendered
    };
  }

  // Optional isolated git worktree execution (zero file collisions with Claude Code!)
  let wtInfo = null;
  let wtChanges = null;
  let targetCwd = workspaceRoot;

  if (request.worktree) {
    wtInfo = createIsolatedWorktree(workspaceRoot, jobId);
    targetCwd = wtInfo.worktreePath;
    appendJobLog(logFile, `Created isolated git worktree at ${wtInfo.worktreePath}`);
  }

  try {
    const turn = await runDualAntigravityTurn(targetCwd, {
      prompt: request.prompt,
      title: request.title,
      resumeConversationId: request.resumeConversationId || null,
      backend: request.backend || "auto",
      model: request.model || "pro",
      write: Boolean(request.write || request.worktree),
      focusUi: Boolean(request.focusUi),
      kind: request.type,
      onStarted,
      onProgress
    });

    if (wtInfo) {
      wtChanges = captureWorktreeChanges(workspaceRoot, wtInfo.worktreePath, jobId);
      if (wtChanges.changedFiles.length > 0) {
        turn.touchedFiles = wtChanges.changedFiles;
      }
    }

    const payload = {
      status: turn.exitStatus,
      backend: turn.backend,
      conversationId: turn.conversationId,
      rawOutput: turn.finalMessage,
      touchedFiles: turn.touchedFiles,
      reasoningSummary: turn.reasoningSummary,
      ...(wtChanges
        ? {
            worktreeIsolated: true,
            worktreePatchPath: wtChanges.patchPath,
            worktreeDiffStat: wtChanges.diffStat
          }
        : {}),
      ...(request.mediaReportPath ? { mediaReportPath: request.mediaReportPath } : {})
    };
    const rendered = renderTurnResult(turn, {
      title: request.title,
      jobId,
      worktreePatchPath: wtChanges?.patchPath || null,
      worktreeDiffStat: wtChanges?.diffStat || null,
      mediaReportPath: request.mediaReportPath || null
    });
    return {
      exitStatus: turn.exitStatus,
      conversationId: turn.conversationId,
      backend: turn.backend,
      touchedFiles: turn.touchedFiles,
      payload,
      rendered
    };
  } finally {
    if (wtInfo && !request.keepWorktree) {
      cleanupIsolatedWorktree(workspaceRoot, wtInfo.worktreePath);
    }
  }
}

async function runTrackedForeground(workspaceRoot, jobRecord, request, asJson) {
  const logFile = resolveJobLogFile(workspaceRoot, jobRecord.id);
  fs.writeFileSync(logFile, "", "utf8");
  appendJobLog(logFile, `Starting foreground ${jobRecord.kind}: ${jobRecord.title}`);

  const running = {
    ...jobRecord,
    status: "running",
    phase: "starting",
    startedAt: nowIso(),
    pid: process.pid,
    logFile,
    request
  };
  writeJobFile(workspaceRoot, jobRecord.id, running);
  upsertJob(workspaceRoot, running);

  try {
    const execRes = await executeJobRequest(workspaceRoot, jobRecord.id, request, logFile);
    const finalStatus = execRes.exitStatus === 0 ? "completed" : "failed";
    appendJobLog(
      logFile,
      `Finished job (${finalStatus}): exitStatus=${execRes.exitStatus}, backend=${execRes.backend || "unknown"}, conversationId=${execRes.conversationId || "none"}, touchedFiles=${(execRes.touchedFiles ?? []).length}`
    );
    const completed = {
      ...readJobFile(workspaceRoot, jobRecord.id),
      ...running,
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      exitStatus: execRes.exitStatus,
      conversationId: execRes.conversationId,
      backend: execRes.backend,
      touchedFiles: execRes.touchedFiles ?? [],
      pid: null,
      completedAt: nowIso(),
      result: execRes.payload,
      rendered: execRes.rendered
    };
    writeJobFile(workspaceRoot, jobRecord.id, completed);
    upsertJob(workspaceRoot, {
      id: jobRecord.id,
      status: finalStatus,
      phase: completed.phase,
      exitStatus: execRes.exitStatus,
      conversationId: execRes.conversationId,
      backend: execRes.backend,
      touchedFiles: execRes.touchedFiles ?? [],
      pid: null,
      completedAt: completed.completedAt
    });
    emitOutput(execRes.payload, execRes.rendered, asJson);
    if (execRes.exitStatus !== 0) process.exitCode = execRes.exitStatus;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendJobLog(logFile, `ERROR: ${msg}`);
    writeJobFile(workspaceRoot, jobRecord.id, {
      ...running,
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: msg,
      completedAt: nowIso()
    });
    upsertJob(workspaceRoot, { id: jobRecord.id, status: "failed", phase: "failed", pid: null, errorMessage: msg });
    throw err;
  }
}

function enqueueBackground(workspaceRoot, jobRecord, request, asJson) {
  const logFile = resolveJobLogFile(workspaceRoot, jobRecord.id);
  fs.writeFileSync(logFile, "", "utf8");
  appendJobLog(logFile, `Queued background ${jobRecord.kind}: ${jobRecord.title}`);

  const queued = {
    ...jobRecord,
    status: "queued",
    phase: "queued",
    logFile,
    request
  };
  writeJobFile(workspaceRoot, jobRecord.id, queued);
  upsertJob(workspaceRoot, queued);

  const pid = spawnBackgroundWorker(workspaceRoot, jobRecord.id);
  writeJobFile(workspaceRoot, jobRecord.id, { ...queued, pid });
  upsertJob(workspaceRoot, { id: jobRecord.id, pid });

  const payload = {
    jobId: jobRecord.id,
    status: "queued",
    kind: jobRecord.kind,
    title: jobRecord.title,
    summary: jobRecord.summary,
    worktreeIsolated: Boolean(request.worktree),
    logFile
  };
  const wtNote = request.worktree ? " (isolated in clean git worktree — zero file collisions)" : "";
  const rendered = `${jobRecord.title} started in background as \`${jobRecord.id}\`${wtNote}.\nCheck \`/agy:status ${jobRecord.id}\` for progress or \`/agy:result ${jobRecord.id}\` once complete.\n`;
  emitOutput(payload, rendered, asJson);
}

async function handleJobWorker(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["cwd", "job-id"] });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobId = options["job-id"];
  const stored = readJobFile(workspaceRoot, jobId);
  if (!stored?.request) return;

  const logFile = stored.logFile || resolveJobLogFile(workspaceRoot, jobId);
  const running = { ...stored, status: "running", phase: "starting", startedAt: nowIso(), pid: process.pid };
  writeJobFile(workspaceRoot, jobId, running);
  upsertJob(workspaceRoot, { id: jobId, status: "running", phase: "starting", pid: process.pid });

  try {
    const execRes = await executeJobRequest(workspaceRoot, jobId, stored.request, logFile);
    const finalStatus = execRes.exitStatus === 0 ? "completed" : "failed";
    appendJobLog(
      logFile,
      `Finished job (${finalStatus}): exitStatus=${execRes.exitStatus}, backend=${execRes.backend || "unknown"}, conversationId=${execRes.conversationId || "none"}, touchedFiles=${(execRes.touchedFiles ?? []).length}`
    );
    writeJobFile(workspaceRoot, jobId, {
      ...readJobFile(workspaceRoot, jobId),
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      exitStatus: execRes.exitStatus,
      conversationId: execRes.conversationId,
      backend: execRes.backend,
      touchedFiles: execRes.touchedFiles ?? [],
      pid: null,
      completedAt: nowIso(),
      result: execRes.payload,
      rendered: execRes.rendered
    });
    upsertJob(workspaceRoot, {
      id: jobId,
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      exitStatus: execRes.exitStatus,
      conversationId: execRes.conversationId,
      backend: execRes.backend,
      touchedFiles: execRes.touchedFiles ?? [],
      pid: null,
      completedAt: nowIso()
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendJobLog(logFile, `WORKER ERROR: ${msg}`);
    writeJobFile(workspaceRoot, jobId, {
      ...readJobFile(workspaceRoot, jobId),
      status: "failed",
      phase: "failed",
      pid: null,
      errorMessage: msg,
      completedAt: nowIso()
    });
    upsertJob(workspaceRoot, { id: jobId, status: "failed", phase: "failed", pid: null, errorMessage: msg });
  }
}

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled stop-time Antigravity review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled stop-time Antigravity review gate for ${workspaceRoot}.`);
  }

  const status = await getAntigravityStatus(workspaceRoot);
  const config = getConfig(workspaceRoot);
  const nextSteps = [];
  if (!status.desktop.available) {
    nextSteps.push("Open Antigravity 2.0 Desktop to enable live visual conversation handoffs, quota HUD & RPC.");
  }
  if (!status.cli.available) {
    const installHint = status.cli.installUrl || status.cli.installCommand || "https://antigravity.google/download";
    nextSteps.push(`Optional headless fallback: install \`agy\` CLI from ${installHint}.`);
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/agy:setup --enable-review-gate` to verify Claude turns before stopping.");
  }

  const report = {
    ...status,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
  emitOutput(report, renderSetupReport(report), Boolean(options.json));
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, { valueOptions: ["cwd"], booleanOptions: ["json"], aliasMap: { C: "cwd" } });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const candidate = findResumableJob(workspaceRoot, false);
  const payload = {
    available: Boolean(candidate?.conversationId),
    conversationId: candidate?.conversationId ?? null,
    jobId: candidate?.id ?? null,
    summary: candidate?.summary ?? null
  };
  emitOutput(payload, `${JSON.stringify(payload)}\n`, Boolean(options.json));
}

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "backend", "model", "conversation", "prompt-file"],
    booleanOptions: [
      "json",
      "background",
      "wait",
      "write",
      "worktree",
      "keep-worktree",
      "resume",
      "resume-last",
      "fresh",
      "focus-ui"
    ],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  if (options.help) {
    printSubcommandHelp("task");
    return;
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ").trim();

  let resumeConversationId =
    options.conversation && options.conversation !== "null" && options.conversation !== "undefined"
      ? options.conversation
      : null;
  if (!resumeConversationId && (options.resume || options["resume-last"]) && !options.fresh) {
    const prev = findResumableJob(workspaceRoot, false);
    if (!prev?.conversationId) {
      throw new Error("No previous Antigravity conversation found for this workspace to resume.");
    }
    resumeConversationId = prev.conversationId;
  }

  if (!prompt && resumeConversationId) {
    prompt = "Continue from the current conversation state. Execute the next highest-value pending step and verify it.";
  }
  if (!prompt) {
    throw new Error("Provide a task prompt for Antigravity (or use --resume).");
  }

  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const jobId = generateJobId("task");
  const title = resumeConversationId
    ? "Antigravity Follow-up Task"
    : options.worktree
      ? `Antigravity Worktree Task: ${shorten(prompt, 42)}`
      : `Antigravity Task: ${shorten(prompt, 48)}`;
  const jobRecord = {
    id: jobId,
    kind: "task",
    title,
    summary: shorten(prompt, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "task",
    prompt,
    title,
    resumeConversationId,
    backend: options.backend || "auto",
    model: options.model || "pro",
    write: Boolean(options.write || options.worktree),
    worktree: Boolean(options.worktree),
    keepWorktree: Boolean(options["keep-worktree"]),
    focusUi: Boolean(options["focus-ui"])
  };

  if (options.background) {
    enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleTransfer(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "source", "backend", "model"],
    booleanOptions: ["json", "background", "wait", "handoff-only", "no-focus"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  if (options.help) {
    printSubcommandHelp("transfer");
    return;
  }
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const extraInstruction = positionals.join(" ").trim();
  const executeNextStep = !options["handoff-only"];
  const focusUi = !options["no-focus"];

  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const sourcePath = resolveClaudeTranscriptPath(cwd, { source: options.source });
  const bundle = buildTransferHandoffBundle(sourcePath, workspaceRoot, {
    executeNextStep,
    extraInstruction
  });

  const jobId = generateJobId("transfer");
  const jobRecord = {
    id: jobId,
    kind: "transfer",
    title: bundle.conversationTitle,
    summary: shorten(extraInstruction || `Session transfer: ${bundle.title}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "transfer",
    sourcePath,
    handoffPath: bundle.handoffPath,
    conversationTitle: bundle.conversationTitle,
    prompt: bundle.prompt,
    backend: options.backend || "auto",
    model: options.model || "pro",
    executeNextStep,
    focusUi
  };

  if (options.background) {
    enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handlePull(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "list", "all"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await pullFromAntigravity(cwd, {
    conversationId: positionals[0] || null,
    listOnly: Boolean(options.list),
    all: Boolean(options.all)
  });
  emitOutput(res, renderPullResult(res), Boolean(options.json));
}

async function handleMedia(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "backend", "model"],
    booleanOptions: ["json", "background", "wait", "no-correlate", "focus-ui"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const bundle = buildMediaAnalysisBundle(cwd, positionals, {
    correlate: !options["no-correlate"]
  });

  const jobId = generateJobId("media");
  const jobRecord = {
    id: jobId,
    kind: "media",
    title: bundle.conversationTitle,
    summary: shorten(bundle.focusQuestion || `Media analysis: ${bundle.mediaFiles.map((m) => m.name).join(", ")}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "media",
    prompt: bundle.prompt,
    title: bundle.conversationTitle,
    mediaReportPath: bundle.fullReportPath,
    backend: options.backend || "auto",
    model: options.model || "pro",
    write: true,
    focusUi: Boolean(options["focus-ui"])
  };

  if (options.background) {
    enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleReview(argv, adversarial = false) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "base", "scope", "backend", "model"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();

  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  const ctx = collectReviewContext(workspaceRoot, {
    base: options.base || null,
    scope: options.scope || "auto"
  });
  const prompt = adversarial
    ? readPromptTemplate("adversarial-review", {
        TARGET_LABEL: ctx.targetLabel,
        USER_FOCUS: focusText || "Challenge assumptions, edge cases, and architectural risks.",
        REVIEW_INPUT: ctx.content
      })
    : readPromptTemplate("review", {
        TARGET_LABEL: ctx.targetLabel,
        REVIEW_INPUT: ctx.content
      });

  const kind = adversarial ? "adversarial-review" : "review";
  const title = adversarial
    ? `Antigravity Adversarial Review (${ctx.targetLabel})`
    : `Antigravity Code Review (${ctx.targetLabel})`;
  const jobId = generateJobId("review");
  const jobRecord = {
    id: jobId,
    kind,
    title,
    summary: shorten(`${title} ${focusText}`.trim(), 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: kind,
    prompt,
    title,
    backend: options.backend || "auto",
    model: options.model || "pro",
    write: false,
    focusUi: false
  };

  if (options.background) {
    enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleReviewPlan(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "plan", "backend", "model"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { C: "cwd", m: "model", b: "backend" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  await resolveExecutionBackendAndValidateModel(workspaceRoot, {
    backend: options.backend,
    model: options.model
  });

  let explicitPlan = options.plan || null;
  const focusParts = [...positionals];
  if (!explicitPlan && focusParts.length > 0) {
    const maybeFile = path.resolve(cwd, focusParts[0]);
    if (fs.existsSync(maybeFile) && fs.statSync(maybeFile).isFile()) {
      explicitPlan = focusParts.shift();
    }
  }

  const rubric = readPromptTemplate("review-plan");
  const bundle = buildPlanReviewBundle(cwd, rubric, {
    planFile: explicitPlan,
    focus: focusParts.join(" ").trim()
  });

  const jobId = generateJobId("plan-review");
  const jobRecord = {
    id: jobId,
    kind: "review-plan",
    title: bundle.conversationTitle,
    summary: shorten(`Plan critique: ${path.basename(bundle.target.label)}`, 80),
    workspaceRoot,
    ...(process.env[SESSION_ID_ENV] ? { sessionId: process.env[SESSION_ID_ENV] } : {})
  };
  const request = {
    type: "review-plan",
    prompt: bundle.prompt,
    title: bundle.conversationTitle,
    backend: options.backend || "auto",
    model: options.model || "pro",
    write: false,
    focusUi: false
  };

  if (options.background) {
    enqueueBackground(workspaceRoot, jobRecord, request, Boolean(options.json));
  } else {
    await runTrackedForeground(workspaceRoot, jobRecord, request, Boolean(options.json));
  }
}

async function handleQuota(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "show-account"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const hud = await getQuotaHud(cwd, { showAccount: Boolean(options["show-account"]) });
  emitOutput(hud, renderQuotaHud(hud), Boolean(options.json));
}

async function handleUndo(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "conversation", "step"],
    booleanOptions: ["json", "apply"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await undoAntigravityTurn(cwd, {
    jobId: positionals[0] || null,
    conversationId: options.conversation || null,
    stepIndex: options.step != null ? Number(options.step) : null,
    apply: Boolean(options.apply)
  });

  const rendered = res.applied
    ? [
        `## Antigravity Turn Reverted`,
        res.conversationId ? `- **Conversation ID:** \`${res.conversationId}\` (reverted to step ${res.stepIndex})` : null,
        res.revertedViaRpc ? `- **Method:** Live Antigravity Desktop RPC (\`RevertToCascadeStep\`)` : null,
        res.revertedGitFiles?.length
          ? `- **Reverted Git Files:** ${res.revertedGitFiles.map((f) => `\`${f}\``).join(", ")}`
          : null
      ]
        .filter(Boolean)
        .join("\n") + "\n"
    : [
        `## Antigravity Revert Preview (Dry Run)`,
        `- **Target Conversation:** \`${res.conversationId || "none"}\``,
        res.stepIndex != null ? `- **Revert Target Step Index:** ${res.stepIndex}` : null,
        `- **Desktop Revert Preview Edits:** ${res.previewEditsCount}`,
        res.touchedFiles?.length
          ? `- **Tracked Touched Files:** ${res.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
          : `- **Tracked Touched Files:** (none recorded)`,
        "",
        `> ${res.message}`
      ]
        .filter(Boolean)
        .join("\n") + "\n";

  emitOutput(res, rendered, Boolean(options.json));
}

async function handleFork(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "step"],
    booleanOptions: ["json", "no-focus"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = await forkAntigravityConversation(cwd, {
    conversationId: positionals[0] || null,
    stepIndex: options.step != null ? Number(options.step) : null,
    focusUi: !options["no-focus"]
  });
  const rendered = [
    `## Forked Antigravity Conversation`,
    `- **Source Conversation ID:** \`${res.sourceConversationId}\``,
    `- **New Forked Conversation ID:** \`${res.newConversationId}\` *(now set as active \`--resume\` target)*`,
    `- **Forked at Step Index:** ${res.forkedAtStepIndex}`,
    `- **Continue on Fork:** \`/agy:rescue --resume "<explore alternative approach>"\``
  ].join("\n") + "\n";
  emitOutput(res, rendered, Boolean(options.json));
}

async function handleSyncMemory(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "direction"],
    booleanOptions: ["json", "apply"],
    aliasMap: { C: "cwd" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const res = syncAgentMemory(cwd, {
    direction: options.direction || "both",
    apply: Boolean(options.apply)
  });

  const lines = [
    `## Cross-Agent Memory Sync (${res.applied ? "APPLIED" : "DRY-RUN PREVIEW"})`,
    `- **Workspace:** \`${res.workspaceRoot}\``,
    `- **Direction:** \`${res.direction}\``,
    `- **Detected Files:** \`CLAUDE.md\`=${res.detected.claudeMd ? "yes" : "no"}, \`AGENTS.md\`=${res.detected.agentsMd ? "yes" : "no"}, \`GEMINI.md\`=${res.detected.geminiMd ? "yes" : "no"}`
  ];
  if (res.actions.length === 0) {
    lines.push("", "No unsynced memory blocks found (create `CLAUDE.md` or `AGENTS.md` first, or files are already identical).");
  } else {
    lines.push("", "### Sync Operations");
    for (const a of res.actions) {
      lines.push(`- **${a.direction}**: \`${path.basename(a.source)}\` (${a.chars} chars) -> ${a.targets.map((t) => `\`${path.relative(res.workspaceRoot, t)}\``).join(", ")}`);
    }
    if (!res.applied) {
      lines.push("", "> Re-run `/agy:sync-memory --apply` to write these non-destructive managed blocks (with `.bak` backups).");
    }
  }
  emitOutput(res, `${lines.join("\n")}\n`, Boolean(options.json));
}

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "wait", "all"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobId = positionals[0] || null;
  const config = getConfig(workspaceRoot);

  if (jobId) {
    const deadline = Date.now() + (Number(options["timeout-ms"]) || 240000);
    let stored = readJobFile(workspaceRoot, jobId);
    if (!stored) throw new Error(`Job not found: ${jobId}`);
    while (options.wait && (stored.status === "queued" || stored.status === "running") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      stored = readJobFile(workspaceRoot, jobId) ?? stored;
    }
    const logTail =
      stored.logFile && fs.existsSync(stored.logFile)
        ? fs.readFileSync(stored.logFile, "utf8").trim().split(/\r?\n/).slice(-12).join("\n")
        : "";
    const rendered =
      [
        `## Job \`${stored.id}\` — **${stored.status}**`,
        `- **Title:** ${stored.title}`,
        `- **Phase:** ${stored.phase || "-"}`,
        stored.exitStatus != null ? `- **Exit Code:** \`${stored.exitStatus}\`` : null,
        stored.conversationId ? `- **Antigravity Conversation ID:** \`${stored.conversationId}\`` : null,
        stored.errorMessage ? `- **Error:** ${stored.errorMessage}` : null,
        logTail ? `\n### Recent Log\n\`\`\`text\n${logTail}\n\`\`\`` : null
      ]
        .filter(Boolean)
        .join("\n") + "\n";
    emitOutput(stored, rendered, Boolean(options.json));
    return;
  }

  const sessionId = process.env[SESSION_ID_ENV] || null;
  const jobs = listJobs(workspaceRoot).filter((j) => options.all || !sessionId || j.sessionId === sessionId);
  emitOutput(
    { jobs, reviewGateEnabled: Boolean(config.stopReviewGate) },
    renderStatusTable(jobs, config.stopReviewGate),
    Boolean(options.json)
  );
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "apply-worktree"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const requestedId = positionals[0] || listJobs(workspaceRoot)[0]?.id;
  if (!requestedId) throw new Error("No jobs recorded in this workspace yet.");
  const stored = readJobFile(workspaceRoot, requestedId);
  if (!stored) throw new Error(`Job not found: ${requestedId}`);

  if (options["apply-worktree"]) {
    const patchPath = stored.result?.worktreePatchPath;
    if (!patchPath) {
      throw new Error(`Job ${requestedId} has no isolated worktree patch to apply.`);
    }
    const applied = applyWorktreePatch(workspaceRoot, patchPath);
    const msg = `Applied isolated worktree patch from job \`${requestedId}\` (\`${patchPath}\`) cleanly into working tree.\n`;
    emitOutput({ jobId: requestedId, ...applied }, msg, Boolean(options.json));
    return;
  }

  const rendered =
    stored.rendered ||
    (stored.errorMessage
      ? `Job ${requestedId} failed: ${stored.errorMessage}\n`
      : `Job ${requestedId} is currently ${stored.status}.\n`);
  emitOutput(stored, rendered, Boolean(options.json));
}

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const jobs = listJobs(workspaceRoot);
  const targetId = positionals[0] || jobs.find((j) => j.status === "queued" || j.status === "running")?.id;
  if (!targetId) throw new Error("No active Antigravity job found to cancel.");
  const stored = readJobFile(workspaceRoot, targetId);
  if (!stored) throw new Error(`Job not found: ${targetId}`);

  const cancelRes = await cancelAntigravityJob(workspaceRoot, stored);
  const updated = { ...stored, status: "canceled", phase: "canceled", pid: null, completedAt: nowIso() };
  writeJobFile(workspaceRoot, targetId, updated);
  upsertJob(workspaceRoot, {
    id: targetId,
    status: "canceled",
    phase: "canceled",
    pid: null,
    completedAt: updated.completedAt
  });

  const payload = { jobId: targetId, status: "canceled", ...cancelRes };
  const rendered = `Canceled Antigravity job \`${targetId}\`${stored.conversationId ? ` (conversation \`${stored.conversationId}\`)` : ""}.\n`;
  emitOutput(payload, rendered, Boolean(options.json));
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return;
  }
  if (subcommand === "help") {
    const target = normalizeArgv(rest)[0];
    printSubcommandHelp(target);
    return;
  }
  if (subcommand !== "job-worker" && SUBCOMMAND_HELP[subcommand] && hasHelpFlag(rest)) {
    printSubcommandHelp(subcommand);
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(rest);
      break;
    case "task":
      await handleTask(rest);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(rest);
      break;
    case "transfer":
      await handleTransfer(rest);
      break;
    case "pull":
      await handlePull(rest);
      break;
    case "media":
      await handleMedia(rest);
      break;
    case "review":
      await handleReview(rest, false);
      break;
    case "adversarial-review":
      await handleReview(rest, true);
      break;
    case "review-plan":
      await handleReviewPlan(rest);
      break;
    case "quota":
      await handleQuota(rest);
      break;
    case "undo":
      await handleUndo(rest);
      break;
    case "fork":
      await handleFork(rest);
      break;
    case "sync-memory":
      await handleSyncMemory(rest);
      break;
    case "status":
      await handleStatus(rest);
      break;
    case "result":
      await handleResult(rest);
      break;
    case "cancel":
      await handleCancel(rest);
      break;
    case "job-worker":
      await handleJobWorker(rest);
      break;
    default:
      throw new Error(`Unknown command "${subcommand}". Run with --help for usage.`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
