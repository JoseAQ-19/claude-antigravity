import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function errorText(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join("; ");
  return errorText(value.message) || errorText(value.errorMessage) || errorText(value.userErrorMessage) ||
    errorText(value.error) || errorText(value.details) || JSON.stringify(value);
}

export function failureKind(message = "", exitStatus = 1) {
  if (/quota|resource.?exhausted|rate.?limit|resets? in/i.test(message)) return "quota";
  if (/step.?limit|max(?:imum)?[^\n]{0,30}steps|too many steps|step budget/i.test(message)) return "step_limit";
  if (exitStatus === 124 || /timed? out|timeout|deadline.?exceeded/i.test(message)) return "timeout";
  if (/EACCES|EPERM|ENOSPC|EROFS|permission denied|failed to write|write error/i.test(message)) return "write_error";
  return "execution_error";
}

export function jobStatus(result) {
  if (result.completionVerified === false && result.exitStatus === 0) return "dispatched";
  if (result.failureKind === "timeout" || result.failureKind === "step_limit") return "interrupted";
  if (result.exitStatus === 130) return "canceled";
  return result.exitStatus === 0 ? "completed" : "failed";
}

export function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

export function isWithin(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export function verifyFiles(files = []) {
  return [...new Set(files)].map((file) => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) return { path: file, state: stat.isSymbolicLink() ? "symlink" : "other" };
      return { path: file, state: "present", size: stat.size, sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
    } catch (err) {
      return { path: file, state: err.code === "ENOENT" ? "absent" : "unreadable", error: err.code };
    }
  });
}

export function scopeViolations(workspaceRoot, files, options = {}) {
  const allowed = (options.allowedPaths || []).map((p) => path.resolve(workspaceRoot, p));
  return files.filter((file) => !isWithin(workspaceRoot, file) ||
    options.write === false ||
    (allowed.length > 0 && !allowed.some((root) => isWithin(root, file))));
}

export function executionPrompt(prompt, options = {}) {
  return [
    String(prompt || ""), "", "Execution boundaries:",
    options.write ? "Only edit files needed for this task. Preserve unrelated changes. Do not commit or push unless explicitly requested in the task." :
      "This is a read-only task. Do not create, edit, delete, commit, or push repository files.",
    options.allowedPaths?.length ? `Only these workspace paths may be changed: ${JSON.stringify(options.allowedPaths)}.` : null,
    "Keep work inside the assigned workspace. Before finishing, verify the requested result and report changed files, checks, and remaining work."
  ].filter((line) => line !== null).join("\n");
}
