import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export function connectRpcPost(address, serviceMethod, payload = {}, csrfToken = "", timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const [host, portStr] = String(address).split(":");
    const port = Number(portStr);
    if (!host || !port) {
      reject(new Error(`Invalid Language Server address: ${address}`));
      return;
    }
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = http.request(
      {
        hostname: host,
        port,
        path: `/exa.language_server_pb.LanguageServerService/${serviceMethod}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          ...(csrfToken ? { "x-codeium-csrf-token": csrfToken } : {})
        },
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(text.trim() ? JSON.parse(text) : {});
            } catch (err) {
              reject(new Error(`Invalid JSON from ${serviceMethod}: ${err.message}`));
            }
          } else {
            const err = new Error(`RPC ${serviceMethod} HTTP ${res.statusCode}: ${text.slice(0, 300)}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`RPC ${serviceMethod} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export function extractCsrfTokenFromCmd(commandLine) {
  const m = String(commandLine ?? "").match(/--csrf_token(?:=|\s+)["']?([a-zA-Z0-9_-]+)["']?/);
  return m ? m[1] : null;
}

export function extractExeFromCmd(commandLine) {
  const cmd = String(commandLine ?? "").trim();
  if (!cmd) return null;
  if (cmd.startsWith('"')) {
    const end = cmd.indexOf('"', 1);
    if (end > 1) return cmd.slice(1, end);
  }
  const winMatch = cmd.match(/^([a-zA-Z]:\\[^\n\r]*?language_server[^\s"']*\.exe)/i);
  if (winMatch) return winMatch[1];
  const posixMatch = cmd.match(/^(\/[^\n\r]*?\/language_server[^\s"']*)/);
  if (posixMatch) return posixMatch[1];
  return cmd.split(/\s+/)[0] || null;
}

export function parseLsofListeningPorts(lsofOutput) {
  const ports = [];
  for (const line of String(lsofOutput ?? "").split(/\r?\n/)) {
    const pm = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (pm) ports.push(Number(pm[1]));
  }
  return [...new Set(ports)];
}

export function parseSsListeningPortsForPid(ssOutput, pid) {
  const ports = [];
  const pidToken = `pid=${pid},`;
  const pidTokenAlt = `pid=${pid})`;
  for (const line of String(ssOutput ?? "").split(/\r?\n/)) {
    if (!line.includes(pidToken) && !line.includes(pidTokenAlt)) continue;
    const cols = line.trim().split(/\s+/);
    const localAddr = cols.find((c) => /:\d+$/.test(c));
    if (!localAddr) continue;
    const pm = localAddr.match(/:(\d+)$/);
    if (pm) ports.push(Number(pm[1]));
  }
  return [...new Set(ports)];
}

export function findDefaultLanguageServerExe() {
  if (process.env.ANTIGRAVITY_AGENTAPI_EXE && fs.existsSync(process.env.ANTIGRAVITY_AGENTAPI_EXE)) {
    return process.env.ANTIGRAVITY_AGENTAPI_EXE;
  }
  const candidates =
    process.platform === "win32"
      ? [
          path.join(
            process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
            "Programs",
            "Antigravity",
            "resources",
            "bin",
            "language_server.exe"
          ),
          path.join(
            process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
            "Programs",
            "Antigravity IDE",
            "resources",
            "app",
            "extensions",
            "antigravity",
            "bin",
            "language_server_windows_x64.exe"
          )
        ]
      : [
          "/Applications/Antigravity.app/Contents/Resources/bin/language_server",
          "/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm",
          "/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_x64",
          "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
          "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64",
          "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm",
          "/Applications/Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_x64",
          path.join(os.homedir(), "Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"),
          path.join(
            os.homedir(),
            "Applications",
            "Antigravity.app",
            "Contents",
            "Resources",
            "app",
            "extensions",
            "antigravity",
            "bin",
            "language_server_macos_arm"
          ),
          "/opt/Antigravity/resources/bin/language_server",
          "/usr/share/antigravity/resources/bin/language_server",
          path.join(os.homedir(), ".local", "share", "Antigravity", "resources", "bin", "language_server")
        ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

function listCandidateProcessesWindows() {
  const psScript = [
    "$ErrorActionPreference='SilentlyContinue';",
    "$procs = Get-CimInstance Win32_Process -Filter \"Name LIKE 'language_server%'\" | ForEach-Object {",
    "  $ports = @(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen | Select-Object -ExpandProperty LocalPort);",
    "  [PSCustomObject]@{ pid = $_.ProcessId; cmd = $_.CommandLine; ports = $ports }",
    "};",
    "if ($procs) { $procs | ConvertTo-Json -Compress } else { '[]' }"
  ].join(" ");

  const res = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 6000
  });
  if (res.status !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout.trim());
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function listCandidateProcessesPosix() {
  // Use -axww so BSD/macOS `ps` never truncates long command lines when COLUMNS is narrow
  const psRes = spawnSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", timeout: 4000 });
  if (psRes.status !== 0) return [];
  let cachedSsOutput = null;
  const results = [];
  for (const line of psRes.stdout.split(/\r?\n/)) {
    if (!line.includes("language_server")) continue;
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const cmd = m[2];
    const lsof = spawnSync("lsof", ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      timeout: 3000
    });
    let ports = parseLsofListeningPorts(lsof.stdout);
    if (ports.length === 0) {
      if (cachedSsOutput === null) {
        const ss = spawnSync("ss", ["-tlnp"], { encoding: "utf8", timeout: 3000 });
        cachedSsOutput = ss.status === 0 ? String(ss.stdout ?? "") : "";
      }
      if (cachedSsOutput) {
        ports = parseSsListeningPortsForPid(cachedSsOutput, pid);
      }
    }
    results.push({ pid, cmd, ports });
  }
  return results;
}

export async function discoverLanguageServer(options = {}) {
  const env = options.env ?? process.env;
  const defaultExe = findDefaultLanguageServerExe();

  if (env.ANTIGRAVITY_LS_ADDRESS && env.ANTIGRAVITY_CSRF_TOKEN) {
    try {
      await connectRpcPost(env.ANTIGRAVITY_LS_ADDRESS, "Heartbeat", {}, env.ANTIGRAVITY_CSRF_TOKEN, 1500);
      return {
        available: true,
        source: "env",
        address: env.ANTIGRAVITY_LS_ADDRESS,
        csrfToken: env.ANTIGRAVITY_CSRF_TOKEN,
        exePath: env.ANTIGRAVITY_AGENTAPI_EXE || defaultExe,
        pid: null
      };
    } catch {
      // Fall through to live process scan if env vars are stale.
    }
  }

  const candidates = [
    ...(options.mockCandidates ??
      (process.platform === "win32" ? listCandidateProcessesWindows() : listCandidateProcessesPosix()))
  ];

  // Prefer Antigravity Hub ("--subclient_type hub" / "--app_data_dir antigravity") first
  candidates.sort((a, b) => {
    const aHub = String(a.cmd ?? "").includes("subclient_type hub") ? 1 : 0;
    const bHub = String(b.cmd ?? "").includes("subclient_type hub") ? 1 : 0;
    return bHub - aHub;
  });

  for (const proc of candidates) {
    const csrfToken = extractCsrfTokenFromCmd(proc.cmd);
    if (!csrfToken) continue;
    const exePath = extractExeFromCmd(proc.cmd) || defaultExe;
    const ports = Array.isArray(proc.ports) ? [...new Set(proc.ports)] : [];
    for (const port of ports) {
      // Probe IPv4 127.0.0.1 first (avoids macOS Node ::1 ECONNREFUSED when daemon binds 127.0.0.1), then localhost
      for (const host of ["127.0.0.1", "localhost"]) {
        const address = `${host}:${port}`;
        try {
          await connectRpcPost(address, "Heartbeat", {}, csrfToken, 1500);
          return {
            available: true,
            source: "process-scan",
            address,
            csrfToken,
            exePath,
            pid: proc.pid ?? null
          };
        } catch {
          // Port may be HTTPS/LSP port or bound on the other loopback family; keep probing.
        }
      }
    }
  }

  return {
    available: false,
    source: "none",
    address: null,
    csrfToken: null,
    exePath: defaultExe,
    pid: null,
    detail: defaultExe
      ? "Antigravity 2.0 is installed, but no active Desktop Language Server is currently running."
      : "Antigravity 2.0 Desktop Language Server was not found."
  };
}

export function findAgyCli(options = {}) {
  const env = options.env ?? process.env;
  if (env.AGY_DISABLE_CLI_SCAN === "1" && !env.AGY_CLI_PATH) {
    return {
      available: false,
      path: null,
      version: null,
      installUrl: "https://antigravity.google/download"
    };
  }
  const explicit = env.AGY_CLI_PATH;
  const candidates = [
    explicit,
    ...(process.platform === "win32"
      ? [
          "agy.exe",
          "agy.cmd",
          path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.exe"),
          path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.cmd"),
          path.join(os.homedir(), ".local", "bin", "agy.exe")
        ]
      : [
          "agy",
          "/opt/homebrew/bin/agy",
          "/usr/local/bin/agy",
          path.join(os.homedir(), ".local", "bin", "agy"),
          "/Applications/Antigravity.app/Contents/Resources/app/bin/agy"
        ])
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      const isCmd = process.platform === "win32" && bin.toLowerCase().endsWith(".cmd");
      const file = isCmd ? (process.env.ComSpec || "cmd.exe") : bin;
      const args = isCmd ? ["/d", "/s", "/c", bin, "--version"] : ["--version"];
      const res = spawnSync(file, args, {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000
      });
      if (res.status === 0) {
        const version = String(res.stdout || res.stderr || "").trim().split(/\r?\n/)[0] || "installed";
        return { available: true, path: bin, version };
      }
    } catch {}
  }

  return {
    available: false,
    path: null,
    version: null,
    installUrl: "https://antigravity.google/download"
  };
}
