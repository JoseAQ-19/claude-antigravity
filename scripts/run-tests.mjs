import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const testsDir = path.resolve("tests");
const files = fs
  .readdirSync(testsDir)
  .filter((f) => f.startsWith("test_") && f.endsWith(".mjs"))
  .sort()
  .map((f) => path.join("tests", f));

const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status ?? 1);
