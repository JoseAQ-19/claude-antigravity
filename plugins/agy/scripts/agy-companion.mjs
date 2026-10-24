#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/args.mjs";
import {
  cancelAntigravityJob,
  getAntigravityStatus,
  runDualAntigravityTurn
} from "./lib/agy-runtime.mjs";
import {
  buildTransferHandoffBundle,
  resolveClaudeTranscriptPath
} from "./lib/claude-session-parser.mjs";
import { collectReviewContext } from "./lib/git.mjs";
import {
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
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/agy-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/agy-companion.mjs task [--background|--wait] [--write] [--resume|--resume-last|--fresh] [--conversation <id>] [--model <pro|flash|flash_lite>] [--focus-ui] [prompt]",
      "  node scripts/agy-companion.mjs task-resume-candidate [--json]",
      "  node scripts/agy-companion.mjs transfer [--source <claude-jsonl>] [--background|--wait] [--handoff-only] [--no-focus] [--model <pro|flash|flash_lite>] [--json] [instruction]",
      "  node scripts/agy-companion.mjs review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--json]",
      "  node scripts/agy-companion.mjs adversarial-review [--background|--wait] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--json] [focus text]",
      "  node scripts/agy-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  node scripts/agy-companion.mjs result [job-id] [--json]",
      "  node scripts/agy-companion.mjs cancel [job-id] [--json]"
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
  return (
    jobs.find(
      (j) =>
        (j.kind === "task" || j.kind === "transfer") &&
        j.conversationId &&
        j.status !== "queued" &&
        j.status !== "running"
    ) ?? null
  );
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
      conversationId: turn.conversationId,
      resumeCommand: `agy --conversation ${turn.conversationId}`,
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
      payload,
      rendered
    };
  }

  // task / review / adversarial-review
  const turn = await runDualAntigravityTurn(workspaceRoot, {
    prompt: request.prompt,
    title: request.title,
    resumeConversationId: request.resumeConversationId || null,
    model: request.model || "pro",
    write: Boolean(request.write),
    focusUi: Boolean(request.focusUi),
    kind: request.type,
    onStarted,
    onProgress
  });

  const payload = {
    status: turn.exitStatus,
    backend: turn.backend,
    conversationId: turn.conversationId,
    rawOutput: turn.finalMessage,
    touchedFiles: turn.touchedFiles,
    reasoningSummary: turn.reasoningSummary
  };
  const rendered = renderTurnResult(turn, { title: request.title, jobId });
  return {
    exitStatus: turn.exitStatus,
    conversationId: turn.conversationId,
    backend: turn.backend,
    payload,
    rendered
  };
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
    const completed = {
      ...readJobFile(workspaceRoot, jobRecord.id),
      ...running,
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      conversationId: execRes.conversationId,
      backend: execRes.backend,
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
      conversationId: execRes.conversationId,
      backend: execRes.backend,
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
    logFile
  };
  const rendered = `${jobRecord.title} started in background as \`${jobRecord.id}\`.\nCheck \`/agy:status ${jobRecord.id}\` for progress or \`/agy:result ${jobRecord.id}\` once complete.\n`;
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
    writeJobFile(workspaceRoot, jobId, {
      ...readJobFile(workspaceRoot, jobId),
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      conversationId: execRes.conversationId,
      backend: execRes.backend,
      pid: null,
      completedAt: nowIso(),
      result: execRes.payload,
      rendered: execRes.rendered
    });
    upsertJob(workspaceRoot, {
      id: jobId,
      status: finalStatus,
      phase: finalStatus === "completed" ? "done" : "failed",
      conversationId: execRes.conversationId,
      backend: execRes.backend,
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
    nextSteps.push("Open Antigravity 2.0 Desktop to enable live visual conversation handoffs & RPC.");
  }
  if (!status.cli.available) {
    nextSteps.push(`Optional headless fallback: install \`agy\` CLI via \`${status.cli.installCommand}\`.`);
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
    valueOptions: ["cwd", "model", "conversation", "prompt-file"],
    booleanOptions: ["json", "background", "wait", "write", "resume", "resume-last", "fresh", "focus-ui"],
    aliasMap: { C: "cwd", m: "model" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  let prompt = options["prompt-file"]
    ? fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8")
    : positionals.join(" ").trim();

  let resumeConversationId = options.conversation || null;
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

  const jobId = generateJobId("task");
  const title = resumeConversationId ? "Antigravity Follow-up Task" : `Antigravity Task: ${shorten(prompt, 48)}`;
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
    model: options.model || "pro",
    write: Boolean(options.write),
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
    valueOptions: ["cwd", "source", "model"],
    booleanOptions: ["json", "background", "wait", "handoff-only", "no-focus"],
    aliasMap: { C: "cwd", m: "model" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const extraInstruction = positionals.join(" ").trim();
  const executeNextStep = !options["handoff-only"];
  const focusUi = !options["no-focus"];

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

async function handleReview(argv, adversarial = false) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd", "base", "scope", "model"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { C: "cwd", m: "model" }
  });
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();

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
    const logTail = stored.logFile && fs.existsSync(stored.logFile)
      ? fs.readFileSync(stored.logFile, "utf8").trim().split(/\r?\n/).slice(-12).join("\n")
      : "";
    const rendered = [
      `## Job \`${stored.id}\` — **${stored.status}**`,
      `- **Title:** ${stored.title}`,
      `- **Phase:** ${stored.phase || "-"}`,
      stored.conversationId ? `- **Antigravity Conversation ID:** \`${stored.conversationId}\`` : null,
      stored.errorMessage ? `- **Error:** ${stored.errorMessage}` : null,
      logTail ? `\n### Recent Log\n\`\`\`text\n${logTail}\n\`\`\`` : null
    ].filter(Boolean).join("\n") + "\n";
    emitOutput(stored, rendered, Boolean(options.json));
    return;
  }

  const sessionId = process.env[SESSION_ID_ENV] || null;
  const jobs = listJobs(workspaceRoot).filter((j) => options.all || !sessionId || j.sessionId === sessionId);
  emitOutput({ jobs, reviewGateEnabled: Boolean(config.stopReviewGate) }, renderStatusTable(jobs, config.stopReviewGate), Boolean(options.json));
}

async function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
    aliasMap: { C: "cwd" }
  });
  const workspaceRoot = resolveWorkspaceRoot(options.cwd || process.cwd());
  const requestedId = positionals[0] || listJobs(workspaceRoot)[0]?.id;
  if (!requestedId) throw new Error("No jobs recorded in this workspace yet.");
  const stored = readJobFile(workspaceRoot, requestedId);
  if (!stored) throw new Error(`Job not found: ${requestedId}`);
  const rendered = stored.rendered || (stored.errorMessage ? `Job ${requestedId} failed: ${stored.errorMessage}\n` : `Job ${requestedId} is currently ${stored.status}.\n`);
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
  upsertJob(workspaceRoot, { id: targetId, status: "canceled", phase: "canceled", pid: null, completedAt: updated.completedAt });

  const payload = { jobId: targetId, status: "canceled", ...cancelRes };
  const rendered = `Canceled Antigravity job \`${targetId}\`${stored.conversationId ? ` (conversation \`${stored.conversationId}\`)` : ""}.\n`;
  emitOutput(payload, rendered, Boolean(options.json));
}

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);
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
    case "review":
      await handleReview(rest, false);
      break;
    case "adversarial-review":
      await handleReview(rest, true);
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
    case "--help":
    case "-h":
    case undefined:
      printUsage();
      break;
    default:
      throw new Error(`Unknown command "${subcommand}". Run with --help for usage.`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
