// Project-scoped chat registry — the Pi-native feature.
// Maps each project path (cwd) to the ChatGPT conversations started from it,
// so an agent can answer "list all chats I started for THIS project".
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export type ChatType = "normal" | "agent" | "deep_research" | "deep_research_heavy";
export type Intelligence = "instant" | "medium" | "high" | "extra_high" | "pro";

export interface ChatRecord {
  conversation_id: string;
  title: string;
  chat_type: ChatType;
  intelligence: Intelligence | null;
  model: string;
  created_at: number;
  cwd: string;
}

const DATA_DIR = process.env.PI_GPT_HOME || join(homedir(), ".pi-gpt");
const REGISTRY_PATH = join(DATA_DIR, "registry.json");

interface Registry {
  [cwd: string]: ChatRecord[];
}

function load(): Registry {
  if (!existsSync(REGISTRY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  } catch {
    return {};
  }
}

function save(reg: Registry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
  } catch {
    // best-effort — registry is a convenience index, never fatal
  }
}

/** Record a chat against the cwd it was started from (idempotent on conversation_id). */
export function addChat(cwd: string, rec: ChatRecord): void {
  const reg = load();
  const key = normalizeCwd(cwd);
  const list = reg[key] || [];
  const idx = list.findIndex((c) => c.conversation_id === rec.conversation_id);
  if (idx >= 0) list[idx] = { ...list[idx], ...rec };
  else list.push(rec);
  reg[key] = list;
  save(reg);
}

/** Update title/fields for an existing conversation in the cwd's list. */
export function updateChat(cwd: string, conversationId: string, patch: Partial<ChatRecord>): void {
  const reg = load();
  const key = normalizeCwd(cwd);
  const list = reg[key];
  if (!list) return;
  const idx = list.findIndex((c) => c.conversation_id === conversationId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch };
    reg[key] = list;
    save(reg);
  }
}

/** List chats started from a given project path, newest first. */
export function listChats(cwd: string): ChatRecord[] {
  const reg = load();
  return (reg[normalizeCwd(cwd)] || []).slice().sort((a, b) => b.created_at - a.created_at);
}

/** Get one chat record by conversation id (searches all cwds). */
export function getChat(conversationId: string): ChatRecord | null {
  const reg = load();
  for (const cwd of Object.keys(reg)) {
    const found = reg[cwd].find((c) => c.conversation_id === conversationId);
    if (found) return found;
  }
  return null;
}

function normalizeCwd(cwd: string): string {
  // ponytail: case-insensitive on darwin/win is ignored — exact path match is fine for this use.
  return cwd.replace(/\/+$/, "") || "/";
}
