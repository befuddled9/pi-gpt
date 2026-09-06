// Sentinel gate: fetch chat-requirements, solve POW + turnstile.
import { getRequirementsToken, solvePow } from "./pow.ts";
import { solveTurnstile } from "./turnstile.ts";

export interface SentinelTokens {
  "chat-requirements": string;
  proof?: string;
  turnstile?: string;
}

const SENTINEL_URL = "https://chatgpt.com/backend-api/sentinel/chat-requirements";

/**
 * @param headers base session headers (Authorization, OAI-*, User-Agent)
 */
export async function getSentinelTokens(headers: Record<string, string>): Promise<SentinelTokens> {
  const ua = headers["User-Agent"] || "";
  const p = getRequirementsToken(ua);

  const r = await fetch(SENTINEL_URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Accept: "*/*" },
    body: JSON.stringify({ p }),
  });
  if (r.status !== 200) {
    throw new Error(`sentinel/chat-requirements HTTP ${r.status}`);
  }
  const resp: any = await r.json();
  if (!resp || typeof resp !== "object") throw new Error("sentinel unexpected response shape");
  const chatToken: string = resp.token;
  if (!chatToken) throw new Error("sentinel/chat-requirements no token");

  const out: SentinelTokens = { "chat-requirements": chatToken };

  const powBlock = resp.proofofwork || {};
  if (powBlock.required) {
    const seed = powBlock.seed;
    const diff = powBlock.difficulty;
    if (!seed || !diff) throw new Error(`sentinel POW missing seed/difficulty`);
    out.proof = solvePow(seed, diff, ua);
  } else {
    out.proof = "";
  }

  const turnBlock = resp.turnstile || {};
  if (turnBlock.required) {
    const dx = turnBlock.dx;
    if (dx) {
      const proofForXor = out.proof || p;
      const tok = solveTurnstile(dx, proofForXor);
      if (tok) out.turnstile = tok;
    }
  }
  return out;
}
