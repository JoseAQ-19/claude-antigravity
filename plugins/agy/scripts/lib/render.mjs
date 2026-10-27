import { jobStatus } from "./job-outcome.mjs";

function escapeMarkdownCell(val) {
  return String(val ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
}

export function renderSetupReport(report) {
  const lines = [
    `# Antigravity Companion Setup (${report.ready ? "READY" : "ACTION NEEDED"})`,
    `- **Active Primary Engine:** \`${report.activeBackend}\``,
    `- **Antigravity 2.0 Desktop Live RPC:** ${
      report.desktop.available
        ? `Connected (\`${report.desktop.address}\`, source: ${report.desktop.source})`
        : `Offline (${report.desktop.detail})`
    }`,
    `- **Antigravity CLI (\`agy\`):** ${
      report.cli.available
        ? `Installed (\`${report.cli.path}\` — ${report.cli.version})`
        : `Not installed (optional fallback: ${report.cli.installUrl || report.cli.installCommand || "https://antigravity.google/download"})`
    }`,
    `- **Stop Review Gate:** ${report.reviewGateEnabled ? "Enabled" : "Disabled"}`
  ];
  if (report.actionsTaken?.length) {
    lines.push("", "## Actions Taken", ...report.actionsTaken.map((a) => `- ${a}`));
  }
  if (report.nextSteps?.length) {
    lines.push("", "## Recommended Next Steps", ...report.nextSteps.map((s) => `- ${s}`));
  }
  return `${lines.join("\n")}\n`;
}

export function renderTurnResult(result, meta = {}) {
  const status = jobStatus(result);
  const heading = `## ${meta.title || "Antigravity Result"}${status === "completed" ? "" : ` (${status.toUpperCase()})`}`;
  const lines = [
    heading,
    `- **Engine:** \`${result.backend}\``,
    `- **Job Status:** ${status} (exit ${result.exitStatus ?? 0})`,
    result.errorMessage ? `- **Reason:** ${result.errorMessage}` : null,
    result.resumeCount ? `- **Automatic Continuations:** ${result.resumeCount}` : null,
    result.checkpoints?.length ? `- **Saved Recovery Checkpoints:** ${result.checkpoints.length}` : null,
    result.conversationId ? `- **Antigravity Conversation ID:** \`${result.conversationId}\`` : null,
    result.conversationId ? `- **Resume in CLI:** \`agy --conversation ${result.conversationId}\`` : null,
    meta.jobId ? `- **Job ID:** \`${meta.jobId}\`` : null,
    meta.worktreePatchPath
      ? `- **Isolated Worktree Patch:** \`${meta.worktreePatchPath}\` *(apply cleanly via \`/agy:result ${meta.jobId} --apply-worktree\`)*`
      : null,
    meta.worktreeDiffStat ? `- **Worktree Diff Summary:** \`${meta.worktreeDiffStat}\`` : null,
    meta.retainedWorktreePath ? `- **Retained Worktree for Recovery:** \`${meta.retainedWorktreePath}\`` : null,
    meta.mediaReportPath ? `- **Full Media Transcript Archive:** \`${meta.mediaReportPath}\`` : null,
    result.touchedFiles?.length
      ? `- **Touched Files (${result.touchedFiles.length}):** ${result.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
      : null,
    result.fileVerification?.length ? `- **Observed File State:** ${result.fileVerification.map((file) => `${file.path} (${file.state})`).join(", ")}` : null,
    "",
    result.finalMessage || "(No output returned)"
  ].filter((x) => x !== null);
  return `${lines.join("\n")}\n`;
}

export function renderTransferResult(payload) {
  const hasConversation = Boolean(payload.conversationId && payload.conversationId !== "null");
  const failed = Number(payload.status ?? 0) !== 0 || !hasConversation;

  if (failed) {
    const failLines = [
      `## Google Antigravity Transfer Failed`,
      `- **Attempted Engine:** \`${payload.backend}\``,
      `- **Status:** ${hasConversation ? payload.jobStatus || "failed" : "No Antigravity conversation was created"} (\`exit ${payload.status ?? 1}\`)`,
      hasConversation ? `- **Antigravity Conversation ID:** \`${payload.conversationId}\`` : null,
      payload.errorMessage ? `- **Reason:** ${payload.errorMessage}` : null,
      payload.touchedFiles?.length ? `- **Partial Files:** ${payload.touchedFiles.join(", ")}` : null,
      payload.handoffPath ? `- **Saved Session Archive (preserved):** \`${payload.handoffPath}\`` : null,
      "",
      "### Error Details",
      "",
      payload.finalMessage || "Antigravity failed before creating a conversation. Run `/agy:setup` to verify your Desktop / CLI connection."
    ].filter((x) => x !== null);
    return `${failLines.join("\n")}\n`;
  }

  const lines = [
    `## Claude Session ${payload.completionVerified === false ? "Dispatched" : "Transferred"} to Google Antigravity`,
    payload.completionVerified === false ? "- **Status:** dispatched; completion has not been verified." : null,
    `- **Engine:** \`${payload.backend}\`${payload.focusedUi ? " (Opened & focused in Antigravity 2.0 Desktop)" : ""}`,
    `- **Antigravity Conversation ID:** \`${payload.conversationId}\``,
    `- **Resume in Antigravity CLI:** \`agy --conversation ${payload.conversationId}\``,
    `- **Continue from Claude Code:** \`/agy:rescue --resume "<next instruction>"\``,
    `- **Pull Back into Claude Later:** \`/agy:pull ${payload.conversationId}\``,
    `- **Verbatim Session Archive:** \`${payload.handoffPath}\``,
    payload.touchedFiles?.length
      ? `- **Files Touched During Executed Next Step:** ${payload.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
      : null,
    "",
    "### Executed Next-Step Output from Antigravity",
    "",
    payload.finalMessage || "(Context synced)"
  ].filter((x) => x !== null);
  return `${lines.join("\n")}\n`;
}

export function renderPullResult(payload) {
  if (payload.mode === "list") {
    if (!payload.conversations.length) {
      return "No Antigravity conversations found for this workspace. Pass `--all` to list across all workspaces.\n";
    }
    const rows = [
      `## Antigravity Conversations (${payload.backend})`,
      `| Conversation ID | Status | Steps | Last Modified | Workspace Match |`,
      `| :--- | :--- | ---: | :--- | :---: |`
    ];
    for (const c of payload.conversations) {
      rows.push(
        `| \`${c.conversationId}\` | ${c.status} | ${c.stepCount ?? "-"} | ${c.lastModifiedTime || "-"} | ${c.matchesWorkspace ? "Yes" : "Other"} |`
      );
    }
    rows.push("", "Run `/agy:pull <conversation-id>` to import any conversation into Claude Code.");
    return `${rows.join("\n")}\n`;
  }

  const lines = [
    `## Antigravity 2.0 Conversation Pulled into Claude Code`,
    `- **Source Engine:** \`${payload.backend}\``,
    `- **Antigravity Conversation ID:** \`${payload.conversationId}\``,
    `- **Total Steps:** ${payload.stepCount}`,
    `- **Full Trajectory Archive:** \`${payload.archivePath}\``,
    payload.touchedFiles?.length
      ? `- **Files Modified in Antigravity:** ${payload.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
      : `- **Files Modified in Antigravity:** (none reported)`,
    "",
    "### Imported Conversation Context",
    "",
    payload.excerpt || "*(No textual steps recorded — inspect archive file if needed)*"
  ];
  return `${lines.join("\n")}\n`;
}

export function renderQuotaHud(hud) {
  const lines = [
    `# Antigravity 2.0 Live HUD & Quota Monitor`,
    `- **Desktop Engine:** ${hud.available ? `Connected (\`${hud.address}\`)` : "Offline"}`,
    hud.planName ? `- **Plan Tier:** **${hud.planName}**${hud.accountLabel ? ` (\`${hud.accountLabel}\`)` : ""}` : null,
    `- **Workspace Jobs:** ${hud.activeJobs.length} running / ${hud.recentJobsCount} total recorded`
  ].filter(Boolean);

  if (!hud.available) {
    lines.push("", `> ${hud.detail}`);
    return `${lines.join("\n")}\n`;
  }

  if (hud.models.length > 0) {
    lines.push(
      "",
      "## Live Per-Model Quota & Reset Timers",
      "",
      "| Model | Quota Bar | Remaining | Resets In | Multimodal |",
      "| :--- | :--- | ---: | :--- | :---: |"
    );
    for (const m of hud.models) {
      const tag = m.isRecommended ? " *(Recommended)*" : "";
      const idBadge = m.modelId ? ` (\`${escapeMarkdownCell(m.modelId)}\`)` : "";
      lines.push(
        `| **${escapeMarkdownCell(m.label)}**${idBadge}${tag} | \`${m.bar}\` | **${m.remainingPct.toFixed(1)}%** | ${m.resetIn} | ${m.supportsImages ? "Yes" : "-"} |`
      );
    }
  }

  if (hud.activeJobs.length > 0) {
    lines.push("", "## Active Background Jobs");
    for (const j of hud.activeJobs) {
      lines.push(`- \`${j.id}\` (${j.kind}) — **${j.status}**: ${j.summary}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function renderStatusTable(jobs, reviewGateEnabled = false) {
  if (!jobs.length) {
    return `No Antigravity jobs recorded for this workspace yet. (Stop review gate: ${reviewGateEnabled ? "enabled" : "disabled"})\n`;
  }
  const rows = [
    `| Job ID | Kind | Status | Phase | Conversation ID | Summary |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`
  ];
  for (const j of jobs.slice(0, 15)) {
    const summary = escapeMarkdownCell(j.errorMessage || j.summary).slice(0, 320);
    rows.push(
      `| \`${j.id}\` | ${j.kind} | **${j.status}** | ${j.phase || "-"} | ${j.conversationId ? `\`${j.conversationId}\`` : "-"} | ${summary} |`
    );
  }
  rows.push("", `Stop review gate: **${reviewGateEnabled ? "enabled" : "disabled"}**. Use \`/agy:result <job-id>\` or \`/agy:cancel <job-id>\`.`);
  return `${rows.join("\n")}\n`;
}
