import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToken } from "../src/auth.ts";

const originalCodexHome = process.env.CODEX_HOME;
let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

test("loads the selected account from an isolated CODEX_HOME", () => {
  dir = mkdtempSync(join(tmpdir(), "pi-gpt-auth-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({
    tokens: { access_token: "test-token-with-sufficient-length-for-validation", account_id: "account-pro" },
  }));
  process.env.CODEX_HOME = dir;

  expect(loadToken()).toMatchObject({
    token: "test-token-with-sufficient-length-for-validation",
    accountId: "account-pro",
    sourcePath: join(dir, "auth.json"),
  });
});
