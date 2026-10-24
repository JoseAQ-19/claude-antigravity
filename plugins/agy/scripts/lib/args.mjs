export function splitRawArgumentString(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return [];
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === "\\" && i + 1 < input.length && (input[i + 1] === quote || input[i + 1] === "\\")) {
        current += input[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !String(raw).trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv.filter((arg) => arg !== "");
}

export function parseArgs(rawArgv, config = {}) {
  const argv = normalizeArgv(rawArgv);
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      const rawName = eqIdx === -1 ? token.slice(2) : token.slice(2, eqIdx);
      const name = aliasMap[rawName] ?? rawName;
      if (booleanOptions.has(name)) {
        options[name] = eqIdx === -1 ? true : token.slice(eqIdx + 1) !== "false";
        continue;
      }
      if (valueOptions.has(name)) {
        if (eqIdx !== -1) {
          options[name] = token.slice(eqIdx + 1);
        } else {
          if (i + 1 >= argv.length) throw new Error(`Missing value for --${rawName}`);
          options[name] = argv[i + 1];
          i += 1;
        }
        continue;
      }
      positionals.push(token);
      continue;
    }
    if (token.startsWith("-") && token.length === 2) {
      const shortName = token.slice(1);
      const mapped = aliasMap[shortName] ?? shortName;
      if (booleanOptions.has(mapped)) {
        options[mapped] = true;
        continue;
      }
      if (valueOptions.has(mapped)) {
        if (i + 1 >= argv.length) throw new Error(`Missing value for -${shortName}`);
        options[mapped] = argv[i + 1];
        i += 1;
        continue;
      }
    }
    positionals.push(token);
  }

  return { options, positionals };
}
