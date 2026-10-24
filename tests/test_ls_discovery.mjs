import test from "node:test";
import assert from "node:assert/strict";
import {
  discoverLanguageServer,
  extractCsrfTokenFromCmd,
  extractExeFromCmd
} from "../plugins/agy/scripts/lib/ls-discovery.mjs";

test("extractCsrfTokenFromCmd and extractExeFromCmd parse Windows and POSIX command lines", () => {
  const cmd = 'C:\\Users\\usuario\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe --standalone --csrf_token 083a19f3-4f07-4c7e-aa92-5a1387d658af --app_data_dir antigravity';
  assert.equal(extractCsrfTokenFromCmd(cmd), "083a19f3-4f07-4c7e-aa92-5a1387d658af");
  assert.equal(
    extractExeFromCmd(cmd),
    "C:\\Users\\usuario\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe"
  );
});

test("discoverLanguageServer auto-discovers live Antigravity Desktop WITHOUT env vars", async () => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.ANTIGRAVITY_LS_ADDRESS;
  delete cleanEnv.ANTIGRAVITY_CSRF_TOKEN;
  delete cleanEnv.ANTIGRAVITY_AGENTAPI_EXE;

  const conn = await discoverLanguageServer({ env: cleanEnv });
  assert.equal(conn.available, true, "Expected live Antigravity Desktop Language Server to be auto-discovered");
  assert.equal(conn.source, "process-scan");
  assert.match(conn.address, /^localhost:\d+$/);
  assert.ok(conn.csrfToken && conn.csrfToken.length > 8);
  assert.ok(conn.exePath && conn.exePath.toLowerCase().includes("language_server"));
});
