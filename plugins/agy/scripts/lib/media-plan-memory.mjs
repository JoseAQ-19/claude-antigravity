import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseClaudeTranscript,
  resolveClaudeTranscriptPath,
  resolveWorkspaceHandoffDir
} from "./claude-session-parser.mjs";
import { getGitSummary } from "./git.mjs";
import { resolveWorkspaceRoot } from "./state.mjs";

const MEDIA_KIND_BY_EXT = new Map([
  [".mp4", "video"],
  [".mov", "video"],
  [".webm", "video"],
  [".mkv", "video"],
  [".avi", "video"],
  [".m4v", "video"],
  [".mp3", "audio"],
  [".wav", "audio"],
  [".m4a", "audio"],
  [".ogg", "audio"],
  [".flac", "audio"],
  [".aac", "audio"],
  [".pdf", "document"],
  [".png", "image"],
  [".jpg", "image"],
  [".jpeg", "image"],
  [".webp", "image"],
  [".gif", "image"]
]);

export function classifyMediaFile(filePath) {
  const ext = path.extname(String(filePath ?? "")).toLowerCase();
  return MEDIA_KIND_BY_EXT.get(ext) || null;
}

function resolveUserPath(cwd, rawPath) {
  const cleaned = String(rawPath ?? "").trim().replace(/^["']|["']$/g, "");
  if (cleaned.startsWith("~/") || cleaned.startsWith("~\\")) {
    return path.join(os.homedir(), cleaned.slice(2));
  }
  return path.resolve(cwd, cleaned);
}

export function buildMediaAnalysisBundle(cwd, mediaArgs = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const mediaFiles = [];
  const questionTokens = [];

  for (const token of mediaArgs) {
    const candidate = resolveUserPath(cwd, token);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile() && classifyMediaFile(candidate)) {
      const stat = fs.statSync(candidate);
      mediaFiles.push({
        path: candidate,
        name: path.basename(candidate),
        kind: classifyMediaFile(candidate),
        sizeBytes: stat.size
      });
    } else {
      questionTokens.push(token);
    }
  }

  if (mediaFiles.length === 0) {
    throw new Error(
      "Usage: `/agy:media <video/audio/pdf/image-file> [focus or bug question]`. Supported formats: .mp4, .mov, .webm, .mkv, .mp3, .wav, .m4a, .pdf, .png, .jpg, .webp, .gif."
    );
  }

  const handoffDir = resolveWorkspaceHandoffDir(workspaceRoot);
  const slug = mediaFiles[0].name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  const fullReportPath = path.join(handoffDir, `media-${Date.now().toString(36)}-${slug}.md`);
  const focusQuestion = questionTokens.join(" ").trim();
  const correlateWithCode = options.correlate !== false;

  const filesBulletList = mediaFiles
    .map((m) => `- **${m.kind.toUpperCase()}**: \`${m.path}\` (${(m.sizeBytes / (1024 * 1024)).toFixed(2)} MB)`)
    .join("\n");

  const prompt = [
    "# Multimodal Perception & Root-Cause Analysis Request (Eyes & Ears for Claude Code)",
    "",
    "Claude Code cannot natively watch videos or listen to audio recordings, so it is delegating multimodal perception to you (Google Antigravity / Gemini).",
    "",
    "## Target Media File(s) to Inspect",
    filesBulletList,
    "",
    focusQuestion
      ? `## Specific Question / Bug Focus\n> ${focusQuestion}`
      : "## Specific Question / Bug Focus\n> Analyze the media thoroughly, extract key visual/audio events with exact timestamps, and identify any UI/UX bugs, errors, or actionable requirements.",
    "",
    "## Mandatory Execution Protocol",
    "1. **Direct Multimodal Read:** Call your native `read_file` tool on EVERY media path listed above (`read_file` natively ingests video, audio, PDF, and image files).",
    `2. **Write Full Exhaustive Breakdown to Disk (Save Claude Context):** Write the complete chronological/frame-by-frame/timestamped breakdown or transcript to:\n   \`${fullReportPath}\``,
    correlateWithCode
      ? `3. **Correlate with Workspace Codebase (\`${workspaceRoot}\`):** Search and read the relevant frontend/backend files in this workspace to pinpoint the exact \`file:line\` responsible for what appears in the media.`
      : "3. **Read-Only Media Focus:** Do not modify workspace source files.",
    "4. **Return a High-Signal Digest to Claude Code:** In your final reply, return ONLY a crisp, structured digest (< 600 words) containing:",
    "   - **Timestamped Visual / Audio Timeline** (`MM:SS` -> exact observation)",
    "   - **Root Cause / Technical Diagnosis** (with exact `file:line` references if applicable)",
    "   - **Recommended Fix for Claude Code**",
    `   - Confirmation that the full transcript/breakdown is saved at \`${fullReportPath}\`.`
  ].join("\n");

  return {
    mediaFiles,
    focusQuestion,
    fullReportPath,
    conversationTitle: `[Media Eyes] ${mediaFiles[0].name}`.slice(0, 90),
    prompt
  };
}

export function resolvePlanTarget(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  // 1. Explicit file path passed by user
  if (options.planFile) {
    const candidate = resolveUserPath(cwd, options.planFile);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return {
        sourceType: "file",
        label: candidate,
        content: fs.readFileSync(candidate, "utf8")
      };
    }
  }

  // 2. Check Claude Code's native ~/.claude/plans/*.md (most recent within last 48h)
  const claudePlansDir = options.claudePlansDir || path.join(os.homedir(), ".claude", "plans");
  if (fs.existsSync(claudePlansDir)) {
    const recentPlans = fs
      .readdirSync(claudePlansDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => {
        const full = path.join(claudePlansDir, e.name);
        const st = fs.statSync(full);
        return { full, mtimeMs: st.mtimeMs };
      })
      .filter((p) => Date.now() - p.mtimeMs < 48 * 3600 * 1000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (recentPlans.length > 0 && options.preferClaudePlansDir !== false) {
      return {
        sourceType: "claude-plan-mode",
        label: recentPlans[0].full,
        content: fs.readFileSync(recentPlans[0].full, "utf8")
      };
    }
  }

  // 3. Check standard workspace plan files
  const wsCandidates = ["PLAN.md", "plan.md", ".claude/plan.md", "PRD.md", "SPEC.md"];
  for (const rel of wsCandidates) {
    const full = path.join(workspaceRoot, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return {
        sourceType: "workspace-doc",
        label: full,
        content: fs.readFileSync(full, "utf8")
      };
    }
  }

  // 4. Fallback: extract latest assistant message from active Claude .jsonl transcript
  try {
    const transcriptPath = resolveClaudeTranscriptPath(workspaceRoot, options);
    const parsed = parseClaudeTranscript(transcriptPath);
    const lastAssistant = [...parsed.turns].reverse().find((t) => t.role === "assistant" && t.text.length > 120);
    if (lastAssistant) {
      return {
        sourceType: "claude-session-turn",
        label: `${transcriptPath} (latest assistant turn)`,
        content: lastAssistant.text
      };
    }
  } catch {}

  throw new Error(
    "No plan found to review. Pass a path (`/agy:review-plan docs/plan.md`), create `PLAN.md`/`PRD.md`, or generate a plan in Claude Plan Mode first."
  );
}

export function buildPlanReviewBundle(cwd, rubricTemplate, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const target = resolvePlanTarget(cwd, options);
  const git = getGitSummary(workspaceRoot);
  const focus = String(options.focus ?? "").trim();

  const prompt = [
    rubricTemplate.trim(),
    "",
    focus ? `## Extra Review Focus from User\n> ${focus}\n` : "",
    "## Workspace Context",
    `- Workspace Root: \`${workspaceRoot}\``,
    git.isGitRepo ? `- Git Branch: \`${git.branch}\`` : "- Git Repo: no",
    `- Plan Source (${target.sourceType}): \`${target.label}\``,
    "",
    "## Implementation Plan Under Review",
    "",
    target.content.slice(0, 50000)
  ]
    .filter(Boolean)
    .join("\n");

  return {
    target,
    conversationTitle: `[Plan Review] ${path.basename(target.label)}`.slice(0, 90),
    prompt
  };
}

const SYNC_START = "<!-- claude-antigravity:sync:start -->";
const SYNC_END = "<!-- claude-antigravity:sync:end -->";

function stripManagedBlock(text) {
  const pattern = new RegExp(`${SYNC_START}[\\s\\S]*?${SYNC_END}\\r?\\n?`, "g");
  return String(text ?? "").replace(pattern, "").trim();
}

function upsertManagedBlock(existingContent, syncedBody, headerComment) {
  const block = [SYNC_START, headerComment, "", syncedBody.trim(), "", SYNC_END].join("\n");
  const str = String(existingContent ?? "");
  if (str.includes(SYNC_START) && str.includes(SYNC_END)) {
    const pattern = new RegExp(`${SYNC_START}[\\s\\S]*?${SYNC_END}`);
    return str.replace(pattern, block);
  }
  if (!str.trim()) return `${block}\n`;
  return `${str.trimEnd()}\n\n${block}\n`;
}

function backupFileOnce(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const bakPath = `${filePath}.bak`;
  if (!fs.existsSync(bakPath)) {
    fs.copyFileSync(filePath, bakPath);
  }
  return bakPath;
}

export function syncAgentMemory(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const direction = options.direction || "both";
  const apply = Boolean(options.apply);

  const claudeMdPath = path.join(workspaceRoot, "CLAUDE.md");
  const agentsMdPath = path.join(workspaceRoot, "AGENTS.md");
  const geminiMdPath = path.join(workspaceRoot, "GEMINI.md");
  const agyRulePath = path.join(workspaceRoot, ".agents", "rules", "claude-memory-sync.md");

  const hasClaudeMd = fs.existsSync(claudeMdPath);
  const hasAgentsMd = fs.existsSync(agentsMdPath);
  const hasGeminiMd = fs.existsSync(geminiMdPath);

  const claudeCore = hasClaudeMd ? stripManagedBlock(fs.readFileSync(claudeMdPath, "utf8")) : "";
  const agySourcePath = hasAgentsMd ? agentsMdPath : hasGeminiMd ? geminiMdPath : null;
  const agyCore = agySourcePath ? stripManagedBlock(fs.readFileSync(agySourcePath, "utf8")) : "";

  const actions = [];

  if ((direction === "both" || direction === "claude-to-agy") && claudeCore) {
    actions.push({
      direction: "claude-to-agy",
      source: claudeMdPath,
      targets: [agentsMdPath, agyRulePath],
      chars: claudeCore.length
    });
    if (apply) {
      backupFileOnce(agentsMdPath);
      const existingAgents = hasAgentsMd ? fs.readFileSync(agentsMdPath, "utf8") : "";
      const nextAgents = upsertManagedBlock(
        existingAgents,
        `## Synced Rules from \`CLAUDE.md\`\n\n${claudeCore}`,
        "<!-- Managed automatically by /agy:sync-memory — edits outside this block are preserved -->"
      );
      fs.writeFileSync(agentsMdPath, nextAgents, "utf8");

      // Also write Antigravity 2.0 native `.agents/rules/claude-memory-sync.md` with mandatory `trigger: always_on`
      fs.mkdirSync(path.dirname(agyRulePath), { recursive: true });
      const ruleFileContent = [
        "---",
        "trigger: always_on",
        "description: Shared project rules synced from Claude Code (CLAUDE.md)",
        "---",
        "",
        claudeCore,
        ""
      ].join("\n");
      fs.writeFileSync(agyRulePath, ruleFileContent, "utf8");
    }
  }

  if ((direction === "both" || direction === "agy-to-claude") && agyCore && agyCore !== claudeCore) {
    actions.push({
      direction: "agy-to-claude",
      source: agySourcePath,
      targets: [claudeMdPath],
      chars: agyCore.length
    });
    if (apply) {
      backupFileOnce(claudeMdPath);
      const existingClaude = hasClaudeMd ? fs.readFileSync(claudeMdPath, "utf8") : "";
      const nextClaude = upsertManagedBlock(
        existingClaude,
        `## Synced Rules from \`${path.basename(agySourcePath)}\`\n\n${agyCore}`,
        "<!-- Managed automatically by /agy:sync-memory — edits outside this block are preserved -->"
      );
      fs.writeFileSync(claudeMdPath, nextClaude, "utf8");
    }
  }

  return {
    applied: apply,
    direction,
    workspaceRoot,
    detected: {
      claudeMd: hasClaudeMd,
      agentsMd: hasAgentsMd,
      geminiMd: hasGeminiMd
    },
    actions
  };
}
