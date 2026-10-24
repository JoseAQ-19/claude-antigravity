import test from "node:test";
import assert from "node:assert/strict";
import { runReleaseAudit } from "../scripts/verify-release.mjs";

test("release readiness audit passes with synchronized versions, open-source governance files, and zero leaked personal paths", () => {
  const result = runReleaseAudit();
  assert.equal(result.ok, true, `Audit errors:\n${result.errors.join("\n")}`);
  assert.equal(result.marketplaceName, "antigravity-live");
});
