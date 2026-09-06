// Authenticated chatgpt.com backend client — get/post with token-reload-if-stale.
import { randomUUID } from "node:crypto";
import { loadToken, mtimeOfPath, type TokenSource } from "./auth.ts";
import { redactError } from "./redact.ts";

const BASE = "https://chatgpt.com";
const CLIENT_VERSION = "prod-be885abbfcfe7b1f511e88b3003d9ee44757fbad";
const CLIENT_BUILD = "5955942";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

export class BackendClient {
  private source: TokenSource;
  readonly headers: Record<string, string>;

  constructor() {
    this.source = loadToken();
    this.headers = {
      "User-Agent": UA,
      Authorization: `Bearer ${this.source.token}`,
      "OAI-Device-Id": randomUUID(),
      "OAI-Session-Id": randomUUID(),
      "OAI-Language": "en-US",
      "OAI-Client-Version": CLIENT_VERSION,
      "OAI-Client-Build-Number": CLIENT_BUILD,
      Origin: BASE,
      Referer: BASE + "/",
      Accept: "*/*",
    };
  }

  /** Re-read token file if its mtime changed (codex CLI background-refreshes it). */
  reloadTokenIfStale(): void {
    if (!this.source.sourcePath) return;
    const mtime = mtimeOfPath(this.source.sourcePath);
    if (this.source.mtime !== null && mtime === this.source.mtime) return;
    try {
      const next = loadToken();
      this.source = next;
      this.headers.Authorization = `Bearer ${next.token}`;
    } catch {
      // keep stale token; next 401 surfaces a clearer error
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: any,
    targetPath?: string,
    targetRoute?: string,
    signal?: AbortSignal,
  ): Promise<any> {
    this.reloadTokenIfStale();
    const headers: Record<string, string> = { ...this.headers };
    if (targetPath) headers["X-OpenAI-Target-Path"] = targetPath;
    if (targetRoute) headers["X-OpenAI-Target-Route"] = targetRoute;

    let r: Response;
    if (method === "GET") {
      r = await fetch(BASE + path, { headers, signal });
    } else {
      headers["Content-Type"] = "application/json";
      r = await fetch(BASE + path, { method: "POST", headers, body: JSON.stringify(body), signal });
    }

    if (r.status === 401) throw new Error("401 Unauthorized — token expired, run `codex login`");
    if (r.status === 403) throw new Error(`403 Forbidden for ${path}`);
    if (r.status === 404) throw new Error(`404 Not Found: ${path}`);
    if (r.status === 405) throw new Error(`405 Method Not Allowed: ${path}`);
    if (!(r.status >= 200 && r.status < 300))
      throw new Error(`HTTP ${r.status} for ${path}: ${redactError(await r.text(), 500)}`);

    const text = await r.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch (e: any) {
      throw new Error(`Expected JSON from ${path} but got non-JSON 2xx: ${redactError(text)}`);
    }
  }

  async get(path: string, targetPath?: string, targetRoute?: string, signal?: AbortSignal): Promise<any> {
    return this.request("GET", path, null, targetPath, targetRoute, signal);
  }

  async post(path: string, body: any = null, targetPath?: string, targetRoute?: string, signal?: AbortSignal): Promise<any> {
    return this.request("POST", path, body, targetPath, targetRoute, signal);
  }

  get accountId(): string | null {
    return this.source.accountId;
  }

  get baseUrl(): string {
    return BASE;
  }
}
