import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureStateDirs, resolveHandoffsDir, TRANSCRIPT_PATH_ENV } from "./state.mjs";

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function stripWinLongPrefix(p) {
  return String(p ?? "").replace(/^\\\\\?\\/, "");
}

function normalizeComparePath(p) {
  let clean = path.resolve(stripWinLongPrefix(p));
  if (process.platform === "darwin") {
    try {
      clean = fs.realpathSync.native(clean);
    } catch {
      clean = clean.replace(/^\/private\/(var|tmp|etc)(\/|$)/, "/$1$2");
    }
    clean = clean.replace(/^\/private\/(var|tmp|etc)(\/|$)/, "/$1$2");
  }
  return process.platform === "win32" ? clean.toLowerCase() : clean;
}

function encodeClaudeProjectDirName(cwd) {
  return path.resolve(cwd).replace(/[:\\/]/g, "-");
}

export function resolveClaudeTranscriptPath(cwd, options = {}) {
  const explicit = options.source || options.env?.[TRANSCRIPT_PATH_ENV] || process.env[TRANSCRIPT_PATH_ENV];
  if (explicit) {
    const cleaned = stripWinLongPrefix(explicit);
    const resolved = cleaned.startsWith("~/")
      ? path.join(os.homedir(), cleaned.slice(2))
      : path.resolve(cwd, cleaned);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Claude session transcript not found: ${resolved}`);
    }
    return resolved;
  }

  const projectsRoot = options.claudeProjectsDir || CLAUDE_PROJECTS_DIR;
  if (!fs.existsSync(projectsRoot)) {
    throw new Error(
      `Could not locate Claude projects directory (${projectsRoot}). Pass --source <path-to-session.jsonl>.`
    );
  }

  const targetCwdNorm = normalizeComparePath(cwd);
  const expectedSlug = encodeClaudeProjectDirName(cwd).toLowerCase();
  const candidates = [];

  for (const dirEntry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!dirEntry.isDirectory()) continue;
    const subDir = path.join(projectsRoot, dirEntry.name);
    let files = [];
    try {
      files = fs.readdirSync(subDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const fullPath = path.join(subDir, f.name);
      try {
        const stat = fs.statSync(fullPath);
        candidates.push({
          fullPath,
          dirNameLower: dirEntry.name.toLowerCase(),
          mtimeMs: stat.mtimeMs
        });
      } catch {}
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 1. Exact directory slug match
  const slugMatch = candidates.find((c) => c.dirNameLower === expectedSlug);
  if (slugMatch) return slugMatch.fullPath;

  // 2. Inspect header lines of recent transcripts for matching cwd
  for (const cand of candidates.slice(0, 30)) {
    try {
      const fd = fs.openSync(cand.fullPath, "r");
      const buf = Buffer.alloc(16384);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd && normalizeComparePath(obj.cwd) === targetCwdNorm) {
            return cand.fullPath;
          }
        } catch {}
      }
    } catch {}
  }

  throw new Error(
    `No active Claude Code session transcript found for workspace "${cwd}". Start a fresh Claude session (so SessionStart hook captures it) or pass --source <path-to-claude.jsonl>.`
  );
}

function isSelfTransferInvocation(text) {
  const t = String(text ?? "").trim();
  return (
    /^\/agy:transfer\b/i.test(t) ||
    t.includes("<command-name>/agy:transfer</command-name>") ||
    t.includes("<command-name>agy:transfer</command-name>") ||
    t.includes("scripts/agy-companion.mjs\" transfer")
  );
}

function cleanUserText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push(item.text.trim());
      }
    }
    return parts.filter(Boolean).join("\n\n").trim();
  }
  return "";
}

function summarizeToolUse(block, touchedFiles) {
  const name = block.name || "Tool";
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const filePath = input.file_path || input.path || input.notebook_path || null;
  if (filePath && /^(Edit|MultiEdit|Write|NotebookEdit)$/i.test(name)) {
    touchedFiles.add(String(filePath));
  }
  if (filePath) return `\`${name}(${filePath})\``;
  if (input.command) {
    const cmd = String(input.command).replace(/\s+/g, " ").trim();
    return `\`${name}(${cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd})\``;
  }
  if (input.pattern) return `\`${name}(${input.pattern})\``;
  return `\`${name}\``;
}

export function parseClaudeTranscript(transcriptPath) {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const turns = [];
  const touchedFiles = new Set();
  const seenAssistantMsgIds = new Map();

  let sessionId = path.basename(transcriptPath, ".jsonl");
  let cwd = null;
  let gitBranch = null;
  let customTitle = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (obj.isSidechain) continue;
    if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
    if (obj.cwd && !cwd) cwd = obj.cwd;
    if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
    if (obj.type === "custom-title" && obj.customTitle) {
      customTitle = String(obj.customTitle).trim();
      continue;
    }

    if (obj.type === "user" && obj.message) {
      const text = cleanUserText(obj.message.content);
      if (!text || isSelfTransferInvocation(text)) continue;
      // Ignore synthetic system/hook skill injections disguised as user blocks
      if (text.startsWith("<local-command-stdout>") || text.startsWith("<EXTREMELY_IMPORTANT>")) continue;
      turns.push({
        role: "user",
        timestamp: obj.timestamp || null,
        text,
        tools: []
      });
      continue;
    }

    if (obj.type === "assistant" && obj.message) {
      const msgId = obj.message.id || obj.uuid || `idx-${turns.length}`;
      const content = Array.isArray(obj.message.content) ? obj.message.content : [];
      let entry = seenAssistantMsgIds.get(msgId);
      if (!entry) {
        entry = {
          role: "assistant",
          timestamp: obj.timestamp || null,
          texts: [],
          seenTexts: new Set(),
          tools: [],
          seenToolIds: new Set()
        };
        seenAssistantMsgIds.set(msgId, entry);
        turns.push(entry);
      }
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          const t = block.text.trim();
          if (t && !entry.seenTexts.has(t)) {
            entry.seenTexts.add(t);
            entry.texts.push(t);
          }
        } else if (block.type === "tool_use") {
          const tid = block.id || `${block.name}:${JSON.stringify(block.input ?? {})}`;
          if (!entry.seenToolIds.has(tid)) {
            entry.seenToolIds.add(tid);
            entry.tools.push(summarizeToolUse(block, touchedFiles));
          }
        }
      }
    }
  }

  const normalizedTurns = turns
    .map((t) => {
      if (t.role === "user") return t;
      return {
        role: "assistant",
        timestamp: t.timestamp,
        text: t.texts.join("\n\n").trim(),
        tools: t.tools
      };
    })
    .filter((t) => t.text || t.tools.length > 0);

  const firstUserTurn = normalizedTurns.find((t) => t.role === "user");
  const rawTitle = customTitle || (firstUserTurn ? firstUserTurn.text.split(/\r?\n/)[0].slice(0, 72) : "Claude Session");
  const title = rawTitle.replace(/\s+/g, " ").trim() || "Claude Session";

  return {
    sessionId,
    transcriptPath,
    cwd,
    gitBranch,
    title,
    turns: normalizedTurns,
    touchedFiles: [...touchedFiles]
  };
}

function formatTurnMarkdown(turn, index) {
  const header = turn.role === "user" ? `### Turn ${index + 1} — User` : `### Turn ${index + 1} — Claude Code`;
  const parts = [header];
  if (turn.tools?.length) {
    parts.push(`*Tools executed:* ${turn.tools.join(", ")}`);
  }
  if (turn.text) {
    parts.push(turn.text);
  }
  return parts.join("\n\n");
}

export function resolveWorkspaceHandoffDir(workspaceCwd) {
  const dir = path.join(path.resolve(workspaceCwd), ".claude", "agy-handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    fs.writeFileSync(gitignore, "*\n", "utf8");
  }
  return dir;
}

export function buildTransferHandoffBundle(transcriptPath, workspaceCwd, options = {}) {
  const parsed = parseClaudeTranscript(transcriptPath);
  ensureStateDirs(workspaceCwd);
  const handoffDir = options.useTempHandoffDir
    ? resolveHandoffsDir(workspaceCwd)
    : resolveWorkspaceHandoffDir(workspaceCwd);
  const handoffPath = path.join(handoffDir, `${parsed.sessionId}.md`);

  const fullDialogueMd = parsed.turns.map((t, i) => formatTurnMarkdown(t, i)).join("\n\n---\n\n");
  const fullMarkdown = [
    `# Claude Code Session Handoff — ${parsed.title}`,
    `- **Claude Session ID:** \`${parsed.sessionId}\``,
    `- **Source Transcript:** \`${parsed.transcriptPath}\``,
    `- **Workspace:** \`${parsed.cwd || workspaceCwd}\``,
    parsed.gitBranch ? `- **Git Branch:** \`${parsed.gitBranch}\`` : null,
    parsed.touchedFiles.length > 0
      ? `- **Files Modified in Claude Session:**\n${parsed.touchedFiles.map((f) => `  - \`${f}\``).join("\n")}`
      : `- **Files Modified in Claude Session:** (none recorded)`,
    "",
    "## Complete Chronological Conversation",
    "",
    fullDialogueMd || "*(No user/assistant turns found in transcript)*"
  ].filter((x) => x !== null).join("\n");

  fs.writeFileSync(handoffPath, `${fullMarkdown}\n`, "utf8");

  // Keep inline CLI prompt <= 10k chars (well under Windows 32k CreateProcess limit)
  // while storing 100% verbatim history inside workspace .claude/agy-handoffs/<sessionId>.md
  const maxInlineChars = options.maxInlineChars ?? 10000;
  let inlineDialogue = fullDialogueMd;
  let truncatedNote = "";
  if (inlineDialogue.length > maxInlineChars && parsed.turns.length > 4) {
    const head = formatTurnMarkdown(parsed.turns[0], 0);
    const tailTurns = [];
    let budget = maxInlineChars - head.length - 500;
    for (let i = parsed.turns.length - 1; i >= 1; i -= 1) {
      const formatted = formatTurnMarkdown(parsed.turns[i], i);
      if (formatted.length > budget && tailTurns.length >= 2) break;
      tailTurns.unshift(formatted);
      budget -= formatted.length;
    }
    truncatedNote = `\n> NOTE: Older middle turns were condensed for prompt efficiency. Full verbatim transcript is saved at \`${handoffPath}\` — read it if you need any earlier detail.\n`;
    inlineDialogue = [head, `*(... middle turns archived in \`${handoffPath}\` ...)*`, ...tailTurns].join("\n\n---\n\n");
  }

  const executeNextStep = options.executeNextStep !== false;
  const extraInstruction = String(options.extraInstruction ?? "").trim();

  const directiveBlock = executeNextStep
    ? [
        "## Execution Directive (Execute Next Step Immediately)",
        extraInstruction
          ? `The user transferred this active Claude Code conversation to you (Google Antigravity) with the following immediate instruction:\n\n> ${extraInstruction}\n\nUsing the full conversation history below and the current workspace state, **execute this step right now end-to-end** (inspect/edit files, run tests/commands as needed, and report results).`
          : "The user transferred this active Claude Code conversation to you (Google Antigravity) and wants you to **take over and immediately execute the next logical pending step**.\n\n1. Review the conversation history below and check the workspace files/git state if needed.\n2. Identify the immediate pending task, fix, or implementation step where Claude Code left off.\n3. **Execute that next step right now end-to-end** (write code, run verification/tests).\n4. Conclude with a concise summary of what you executed, touched files, and the next milestone."
      ].join("\n")
    : [
        "## Handoff Directive (Context Sync Only)",
        "Ingest this transferred Claude Code session context, verify current workspace state in read-only mode, briefly confirm what has been done so far, and state the exact next step you are ready to execute when asked."
      ].join("\n");

  const prompt = [
    `# Session Transfer from Claude Code: ${parsed.title}`,
    `- Workspace: \`${workspaceCwd}\``,
    parsed.gitBranch ? `- Git Branch: \`${parsed.gitBranch}\`` : null,
    `- Full Handoff Archive: \`${handoffPath}\``,
    parsed.touchedFiles.length > 0 ? `- Previously Touched Files: ${parsed.touchedFiles.map((f) => `\`${f}\``).join(", ")}` : null,
    truncatedNote,
    directiveBlock,
    "",
    "## Transferred Conversation Context",
    "",
    inlineDialogue || "*(Empty session)*"
  ].filter(Boolean).join("\n");

  return {
    ...parsed,
    handoffPath,
    conversationTitle: `[Claude Transfer] ${parsed.title}`.slice(0, 90),
    prompt
  };
}
