import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  discoverLanguageServer,
  extractCsrfTokenFromCmd,
  extractExeFromCmd,
  parseLsofListeningPorts,
  parseSsListeningPortsForPid
} from "../plugins/agy/scripts/lib/ls-discovery.mjs";

test("extractCsrfTokenFromCmd and extractExeFromCmd parse Windows and macOS command lines", () => {
  const winCmd =
    "C:\\LocalApp\\Programs\\Antigravity\\resources\\bin\\language_server.exe --standalone --csrf_token tok_win_123 --app_data_dir antigravity";
  assert.equal(extractCsrfTokenFromCmd(winCmd), "tok_win_123");
  assert.equal(extractExeFromCmd(winCmd), "C:\\LocalApp\\Programs\\Antigravity\\resources\\bin\\language_server.exe");

  const macCmd =
    "/Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token=tok_mac_456 --subclient_type hub";
  assert.equal(extractCsrfTokenFromCmd(macCmd), "tok_mac_456");
  assert.equal(extractExeFromCmd(macCmd), "/Applications/Antigravity.app/Contents/Resources/bin/language_server");

  const macArmSpacesCmd =
    "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm --csrf_token tok_arm_789 --app_data_dir antigravity";
  assert.equal(extractCsrfTokenFromCmd(macArmSpacesCmd), "tok_arm_789");
  assert.equal(
    extractExeFromCmd(macArmSpacesCmd),
    "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm"
  );
});

test("parseLsofListeningPorts and parseSsListeningPortsForPid parse POSIX port outputs", () => {
  const lsofSample = [
    "COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "language_ 41200 dev    11u  IPv4 0x1234      0t0  TCP 127.0.0.1:58123 (LISTEN)",
    "language_ 41200 dev    12u  IPv4 0x1235      0t0  TCP 127.0.0.1:58124 (LISTEN)"
  ].join("\n");
  assert.deepEqual(parseLsofListeningPorts(lsofSample), [58123, 58124]);

  const ssSample = [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    'LISTEN 0      4096   127.0.0.1:49321     0.0.0.0:*         users:(("language_server",pid=8842,fd=9))',
    'LISTEN 0      4096   127.0.0.1:49999     0.0.0.0:*         users:(("other_proc",pid=1111,fd=4))'
  ].join("\n");
  assert.deepEqual(parseSsListeningPortsForPid(ssSample, 8842), [49321]);
});

test("discoverLanguageServer probes mock candidate ports, validates CSRF token, and prefers hub process", async () => {
  const expectedToken = "csrf-mock-hub-token";
  const server = http.createServer((req, res) => {
    if (
      req.url === "/exa.language_server_pb.LanguageServerService/Heartbeat" &&
      req.headers["x-codeium-csrf-token"] === expectedToken
    ) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const conn = await discoverLanguageServer({
      env: {},
      mockCandidates: [
        {
          pid: 1001,
          cmd: `/opt/Antigravity/resources/bin/language_server --csrf_token wrong-token`,
          ports: [port]
        },
        {
          pid: 1002,
          cmd: `/opt/Antigravity/resources/bin/language_server --subclient_type hub --csrf_token ${expectedToken}`,
          ports: [65530, port]
        }
      ]
    });

    assert.equal(conn.available, true);
    assert.equal(conn.source, "process-scan");
    assert.equal(conn.address, `127.0.0.1:${port}`);
    assert.equal(conn.csrfToken, expectedToken);
    assert.equal(conn.pid, 1002);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
