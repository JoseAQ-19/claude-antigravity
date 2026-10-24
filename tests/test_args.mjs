import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../plugins/agy/scripts/lib/args.mjs";

test("splitRawArgumentString handles quotes and spaces cleanly", () => {
  const tokens = splitRawArgumentString('--model pro --background "fix auth bug in login.ts"');
  assert.deepEqual(tokens, ["--model", "pro", "--background", "fix auth bug in login.ts"]);
});

test("parseArgs parses single-string $ARGUMENTS and short aliases", () => {
  const parsed = parseArgs(["-m flash --resume --wait continue implementing tests"], {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["resume", "wait", "background"],
    aliasMap: { m: "model", C: "cwd" }
  });
  assert.equal(parsed.options.model, "flash");
  assert.equal(parsed.options.resume, true);
  assert.equal(parsed.options.wait, true);
  assert.deepEqual(parsed.positionals, ["continue", "implementing", "tests"]);
});

test("parseArgs handles empty $ARGUMENTS string", () => {
  const parsed = parseArgs([""], { booleanOptions: ["json"] });
  assert.deepEqual(parsed.options, {});
  assert.deepEqual(parsed.positionals, []);
});
