import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureDesktopProjectId,
  extractTurnDataFromSteps,
  getAntigravityStatus,
  normalizeDesktopModelTier,
  normalizeUriPathForCompare
} from "../plugins/agy/scripts/lib/agy-runtime.mjs";

test("normalizeUriPathForCompare normalizes encoded Windows URIs and paths identically", () => {
  const fromLs = "file:///c%3A/Users/usuario/Desktop/plugin%20antigravity";
  const fromCwd = "C:\\Users\\usuario\\Desktop\\plugin antigravity\\";
  assert.equal(normalizeUriPathForCompare(fromLs), normalizeUriPathForCompare(fromCwd));
});

test("normalizeDesktopModelTier maps aliases accurately", () => {
  assert.equal(normalizeDesktopModelTier("flash"), "flash");
  assert.equal(normalizeDesktopModelTier("lite"), "flash_lite");
  assert.equal(normalizeDesktopModelTier(null, "pro"), "pro");
});

test("extractTurnDataFromSteps extracts final response and detects active steps", () => {
  const steps = [
    { type: "CORTEX_STEP_TYPE_USER_INPUT", status: "CORTEX_STEP_STATUS_DONE" },
    {
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      status: "CORTEX_STEP_STATUS_DONE",
      plannerResponse: {
        thinking: "Checking codebase structure\nMore details",
        toolCalls: [{ id: "1", name: "read_file" }]
      }
    },
    {
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      status: "CORTEX_STEP_STATUS_DONE",
      plannerResponse: {
        thinking: "Formulating final answer",
        modifiedResponse: "Fixed the bug in `auth.ts`."
      }
    }
  ];
  const out = extractTurnDataFromSteps(steps, 0);
  assert.equal(out.hasActiveSteps, false);
  assert.equal(out.hasPlannerResponse, true);
  assert.equal(out.finalMessage, "Fixed the bug in `auth.ts`.");
  assert.equal(out.reasoningSummary.length, 2);
});

test("getAntigravityStatus and ensureDesktopProjectId resolve current workspace projectId live", async () => {
  const status = await getAntigravityStatus("c:\\Users\\usuario\\Desktop\\plugin antigravity");
  assert.equal(status.ready, true);
  assert.equal(status.activeBackend, "desktop-live");
  const projectId = await ensureDesktopProjectId(status.desktop, "c:\\Users\\usuario\\Desktop\\plugin antigravity");
  assert.equal(projectId, "356fd667-3fa6-4cf7-80e4-d6de6078baef");
});
