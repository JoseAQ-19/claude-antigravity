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
        : `Not installed (optional fallback: \`${report.cli.installCommand}\`)`
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
  const lines = [
    `## ${meta.title || "Antigravity Result"}`,
    `- **Engine:** \`${result.backend}\``,
    result.conversationId ? `- **Antigravity Conversation ID:** \`${result.conversationId}\`` : null,
    result.conversationId ? `- **Resume in CLI:** \`agy --conversation ${result.conversationId}\`` : null,
    meta.jobId ? `- **Job ID:** \`${meta.jobId}\`` : null,
    result.touchedFiles?.length
      ? `- **Touched Files (${result.touchedFiles.length}):** ${result.touchedFiles.map((f) => `\`${f}\``).join(", ")}`
      : null,
    "",
    result.finalMessage || "(No output returned)"
  ].filter((x) => x !== null);
  return `${lines.join("\n")}\n`;
}

export function renderTransferResult(payload) {
  const lines = [
    `## Claude Session Transferred to Google Antigravity`,
    `- **Engine:** \`${payload.backend}\`${payload.focusedUi ? " (Opened & focused in Antigravity 2.0 Desktop)" : ""}`,
    `- **Antigravity Conversation ID:** \`${payload.conversationId}\``,
    `- **Resume in Antigravity CLI:** \`${payload.resumeCommand}\``,
    `- **Continue from Claude Code:** \`/agy:rescue --resume "<next instruction>"\``,
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

export function renderStatusTable(jobs, reviewGateEnabled = false) {
  if (!jobs.length) {
    return `No Antigravity jobs recorded for this workspace yet. (Stop review gate: ${reviewGateEnabled ? "enabled" : "disabled"})\n`;
  }
  const rows = [
    `| Job ID | Kind | Status | Phase | Conversation ID | Summary |`,
    `| :--- | :--- | :--- | :--- | :--- | :--- |`
  ];
  for (const j of jobs.slice(0, 15)) {
    const summary = String(j.summary ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 64);
    rows.push(
      `| \`${j.id}\` | ${j.kind} | **${j.status}** | ${j.phase || "-"} | ${j.conversationId ? `\`${j.conversationId}\`` : "-"} | ${summary} |`
    );
  }
  rows.push("", `Stop review gate: **${reviewGateEnabled ? "enabled" : "disabled"}**. Use \`/agy:result <job-id>\` or \`/agy:cancel <job-id>\`.`);
  return `${rows.join("\n")}\n`;
}
