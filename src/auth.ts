// Token loading — mirrors gpt2agent's search order, reuses `codex login`.
import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenSource {
  token: string;
  accountId: string | null;
  sourcePath: string | null;
  mtime: number | null;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Load the ChatGPT bearer token + its source file (for mtime-based refresh). */
export function loadToken(): TokenSource {
  // Source 1: codex login (honor CODEX_HOME for multi-account)
  const codexHome = process.env.CODEX_HOME;
  const codexPath = join(codexHome ? codexHome : join(homedir(), ".codex"), "auth.json");
  let codexErr: string | null = null;
  if (existsSync(codexPath)) {
    try {
      const data = readJson(codexPath);
      const token = data?.tokens?.access_token;
      if (typeof token === "string" && token.length > 20) return {
        token,
        accountId: data?.tokens?.account_id || data?.account_id || null,
        sourcePath: codexPath,
        mtime: mtimeOf(codexPath),
      };
      codexErr = "tokens.access_token missing or invalid in codex auth";
    } catch (e: any) {
      codexErr = `Failed to read ~/.codex/auth.json: ${e.message}`;
    }
  }

  // Source 2: gpt2agent setup wizard
  const wizardPath = join(homedir(), ".gpt2agent", "token.json");
  let wizardErr: string | null = null;
  if (existsSync(wizardPath)) {
    try {
      const data = readJson(wizardPath);
      const token = data?.token || data?.access_token || data?.tokens?.access_token;
      if (typeof token === "string" && token.length > 20) return {
        token,
        accountId: data?.account_id || data?.tokens?.account_id || null,
        sourcePath: wizardPath,
        mtime: mtimeOf(wizardPath),
      };
      wizardErr = "token missing or invalid in gpt2agent config";
    } catch (e: any) {
      wizardErr = `Failed to read ~/.gpt2agent/token.json: ${e.message}`;
    }
  }

  const details = [codexErr, wizardErr].filter(Boolean).join("; ");
  throw new Error(
    `No ChatGPT token found — run \`codex login\`${
      details ? ` (${details})` : ""
    }`,
  );
}

function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

export function mtimeOfPath(p: string): number | null {
  return mtimeOf(p);
}
