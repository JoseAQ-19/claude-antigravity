import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runReleaseAudit(rootDir = ROOT) {
  const errors = [];

  const requiredFiles = [
    "package.json",
    ".claude-plugin/marketplace.json",
    "plugins/agy/.claude-plugin/plugin.json",
    "plugins/agy/hooks/hooks.json",
    "plugins/agy/scripts/agy-companion.mjs",
    "skills/antigravity-bridge/SKILL.md",
    "LICENSE",
    "NOTICE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "README.md",
    ".github/workflows/ci.yml"
  ];

  for (const rel of requiredFiles) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) {
      errors.push(`Missing or empty required file: ${rel}`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const marketplace = JSON.parse(fs.readFileSync(path.join(rootDir, ".claude-plugin/marketplace.json"), "utf8"));
  const plugin = JSON.parse(fs.readFileSync(path.join(rootDir, "plugins/agy/.claude-plugin/plugin.json"), "utf8"));

  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    errors.push("package.json must have zero runtime dependencies.");
  }

  const mPlugin = marketplace.plugins?.[0];
  if (pkg.version !== plugin.version || pkg.version !== mPlugin?.version) {
    errors.push(
      `Version mismatch across manifests: package=${pkg.version}, plugin=${plugin.version}, marketplace=${mPlugin?.version}`
    );
  }

  if (marketplace.name === "antigravity-cc") {
    errors.push("Marketplace name 'antigravity-cc' collides with existing community repos; expected 'antigravity-live'.");
  }

  // Scan all files for accidental personal paths or machine-specific UUIDs
  const forbiddenPatterns = [
    { label: "Windows local user path", regex: /Users[\\/]+usuario/i },
    { label: "Placeholder author 'Local Engineering'", regex: /Local Engineering/ },
    { label: "Hardcoded local workspace UUID", regex: /356fd667-3fa6-4cf7-80e4-d6de6078baef/i }
  ];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".claude") {
        if (entry.name !== ".claude-plugin") continue;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (rel === ".git" || rel === "node_modules") continue;
        walk(full);
      } else {
        if (rel === "scripts/verify-release.mjs") continue;
        const text = fs.readFileSync(full, "utf8");
        for (const pat of forbiddenPatterns) {
          if (pat.regex.test(text)) {
            errors.push(`Forbidden ${pat.label} found in ${rel}`);
          }
        }
      }
    }
  }

  walk(rootDir);

  return { ok: errors.length === 0, errors, version: pkg.version, marketplaceName: marketplace.name };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runReleaseAudit(ROOT);
  if (!result.ok) {
    console.error("Release readiness audit FAILED:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }
  console.log(`Release audit PASSED (v${result.version}, marketplace=${result.marketplaceName}).`);
}
