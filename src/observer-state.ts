// Observer state + policy — config, per-session tracker, the shouldAct policy,
// intervention text, and an append-only log. Pure file I/O (mirrors src/registry.ts);
// no Pi ExtensionAPI dependency, fully unit-testable.
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import type { Intelligence } from "./registry.ts";
import type { ObserverTelemetry, ObserverVerdict, HelpSource } from "./observer-detector.ts";

/** How an intervention reaches the agent/human (orthogonal to the help *source*). */
export type ObserverActionMode = "notify" | "steer" | "nextTurn";

export interface ObserverConfig {
  version: 1;
  enabled: boolean;
  detectorModel: Intelligence;
  messageWindow: number;
  cadence: "every_turn";
  onStruggle: ObserverActionMode;
  minStreak: number;
  cooldownTurns: number;
  struggleFloor: 1 | 2 | 3;
  singleFlight: boolean;
  detectorTimeoutMs: number;
  failSilent: boolean;
  log: boolean;
  visible: boolean;
}

export interface ObservedAssistantTurn {
  turn: number;
  at: number;
  text: string;
  telemetry: ObserverTelemetry;
}

export interface LastNudge {
  key: string;
  turn: number;
  mode: ObserverActionMode;
}

export interface ObserverSessionState {
  sessionId: string;
  cwd: string;
  updatedAt: number;
  turnsSeen: number;
  recent: ObservedAssistantTurn[];
  struggleStreak: number;
  lastVerdict: ObserverVerdict | null;
  lastNudge: LastNudge | null;
}

interface ObserverStateFile {
  version: 1;
  sessions: Record<string, ObserverSessionState>;
}

export interface ShouldActDecision {
  act: boolean;
  reason: "disabled" | "below_floor" | "cooldown" | "need_more_streak" | "act";
  nextStreak: number;
  key: string | null;
}

export interface ObserverIntervention {
  key: string;
  source: HelpSource;
  /** One-line summary for ui.notify. */
  summary: string;
  /** Full nudge text for pi.sendMessage. */
  steerText: string;
}

// ── paths (PI_GPT_HOME convention, same as registry.ts) ────────────────────
const DATA_DIR = process.env.PI_GPT_HOME || join(homedir(), ".pi-gpt");
const OBSERVER_DIR = join(DATA_DIR, "observer");
const CONFIG_PATH = join(OBSERVER_DIR, "config.json");
const STATE_PATH = join(OBSERVER_DIR, "state.json");
const LOG_PATH = join(OBSERVER_DIR, "log.jsonl");
const RECENT_CAP = 8; // rolling window of stored turns (window sent to detector is smaller)

export const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
  version: 1,
  enabled: false, // opt-in — never nudges until the user enables via /gpt-observer
  detectorModel: "high", // gpt-5-5-thinking extended — only tier validated for 0-FP + real-struggle recall (medium under-scores to 1)
  messageWindow: 3,
  cadence: "every_turn",
  onStruggle: "notify", // passive-first: surface to the human, never auto-interrupt
  minStreak: 2,
  cooldownTurns: 6,
  struggleFloor: 2,
  singleFlight: true,
  detectorTimeoutMs: 30_000,
  failSilent: true,
  log: true,
  visible: true,
};

// ── config ─────────────────────────────────────────────────────────────────
export function loadObserverConfig(): ObserverConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_OBSERVER_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    // Merge over defaults so new fields backfill for old config files.
    return { ...DEFAULT_OBSERVER_CONFIG, ...parsed, version: 1 };
  } catch {
    return { ...DEFAULT_OBSERVER_CONFIG };
  }
}

export function saveObserverConfig(cfg: ObserverConfig): void {
  try {
    mkdirSync(OBSERVER_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify({ ...cfg, version: 1 }, null, 2));
  } catch {
    // best-effort — config is a convenience, never fatal
  }
}

export function patchObserverConfig(patch: Partial<ObserverConfig>): ObserverConfig {
  const next = { ...loadObserverConfig(), ...patch, version: 1 as const };
  saveObserverConfig(next);
  return next;
}

// ── session state ──────────────────────────────────────────────────────────
function loadStateFile(): ObserverStateFile {
  if (!existsSync(STATE_PATH)) return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions) return parsed as ObserverStateFile;
  } catch {
    /* fall through to empty */
  }
  return { version: 1, sessions: {} };
}

function saveStateFile(state: ObserverStateFile): void {
  try {
    mkdirSync(OBSERVER_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // best-effort
  }
}

export function getSessionState(sessionId: string, cwd: string): ObserverSessionState {
  const state = loadStateFile();
  const existing = state.sessions[sessionId];
  if (existing) return existing;
  return {
    sessionId,
    cwd,
    updatedAt: Date.now(),
    turnsSeen: 0,
    recent: [],
    struggleStreak: 0,
    lastVerdict: null,
    lastNudge: null,
  };
}

export function saveSessionState(next: ObserverSessionState): void {
  const state = loadStateFile();
  state.sessions[next.sessionId] = { ...next, updatedAt: Date.now() };
  saveStateFile(state);
}

/** Append a turn to the rolling history + bump the turn counter. */
export function recordAssistantTurn(
  s: ObserverSessionState,
  text: string,
  telemetry: ObserverTelemetry,
): ObserverSessionState {
  const turn = s.turnsSeen + 1;
  const recent = [...s.recent, { turn, at: Date.now(), text, telemetry }].slice(-RECENT_CAP);
  return { ...s, turnsSeen: turn, recent, updatedAt: Date.now() };
}

/**
 * The policy — deliberately simple. No EMA/momentum: streak + cooldown + dedupe.
 * Returns nextStreak so applyVerdict can persist it without recomputing.
 */
export function shouldAct(
  cfg: ObserverConfig,
  s: ObserverSessionState,
  verdict: ObserverVerdict,
): ShouldActDecision {
  if (!cfg.enabled) {
    return { act: false, reason: "disabled", nextStreak: s.struggleStreak, key: null };
  }

  const eligible =
    verdict.source !== "none" &&
    verdict.kind !== "none" &&
    verdict.struggle >= cfg.struggleFloor;

  // sameTrack: same kind+source as last verdict, both at/above floor → streak grows.
  const sameTrack =
    !!s.lastVerdict &&
    verdict.kind === s.lastVerdict.kind &&
    verdict.source === s.lastVerdict.source &&
    verdict.struggle >= cfg.struggleFloor &&
    s.lastVerdict.struggle >= cfg.struggleFloor;

  const nextStreak = eligible ? (sameTrack ? s.struggleStreak + 1 : 1) : 0;
  const key = eligible ? `${verdict.source}:${verdict.kind}` : null;

  if (!eligible) return { act: false, reason: "below_floor", nextStreak, key };
  if (nextStreak < cfg.minStreak) return { act: false, reason: "need_more_streak", nextStreak, key };
  // Cooldown: suppress ANY intervention within cooldownTurns of the last nudge.
  // (This subsumes a separate "same-key dedupe" — once cooldown blocks every
  // nudge in the window, a key-specific check could never fire, so it's gone.)
  if (s.lastNudge && s.turnsSeen - s.lastNudge.turn < cfg.cooldownTurns) {
    return { act: false, reason: "cooldown", nextStreak, key };
  }
  return { act: true, reason: "act", nextStreak, key };
}

/** Persist the verdict + its computed streak. */
export function applyVerdict(
  s: ObserverSessionState,
  verdict: ObserverVerdict,
  nextStreak: number,
): ObserverSessionState {
  return {
    ...s,
    struggleStreak: nextStreak,
    lastVerdict: verdict,
    updatedAt: Date.now(),
  };
}

/** After delivering an intervention: record the nudge (drives cooldown) + reset the streak. */
export function markIntervention(
  s: ObserverSessionState,
  cfg: ObserverConfig,
  intervention: ObserverIntervention,
): ObserverSessionState {
  return {
    ...s,
    lastNudge: { key: intervention.key, turn: s.turnsSeen, mode: cfg.onStruggle },
    struggleStreak: 0, // reset so a just-nudged turn can't chain immediately
    updatedAt: Date.now(),
  };
}

/** Build the nudge text. Source-driven (detector picks WHO); phrasing nudges, never accuses. */
export function buildIntervention(verdict: ObserverVerdict, streak: number): ObserverIntervention {
  const key = `${verdict.source}:${verdict.kind}`;
  const help = verdict.suggested_help
    ? ` Specific next step: ${verdict.suggested_help}`
    : "";

  if (verdict.source === "user") {
    return {
      key,
      source: "user",
      summary: `Observer: possible ${verdict.kind} streak (${streak} turns). Best move: ask the user one concise clarification.`,
      steerText: `Observer nudge: you may be blocked by missing requirements or task sprawl. Stop guessing and ask the user one concise clarification question that unlocks the very next coding step.${help}`,
    };
  }

  if (verdict.source === "deep_research") {
    return {
      key,
      source: "deep_research",
      summary: `Observer: possible knowledge-gap streak (${streak} turns). Best move: run deep research for cited guidance.`,
      steerText: `Observer nudge: you may be blocked by missing external knowledge. Use gpt_chat with chat_type=deep_research, ask for a cited answer plus the best next implementation step, then continue.${help}`,
    };
  }

  // source === "gpt"
  return {
    key,
    source: "gpt",
    summary: `Observer: possible ${verdict.kind} streak (${streak} turns). Best move: consult gpt_chat for a second opinion.`,
    steerText: `Observer nudge: you may be stuck on approach. Before more local thrash, use gpt_chat for a second opinion — include the goal, relevant facts, and failed attempts, and ask for the best next step.${help}`,
  };
}

/** Append a structured event to the tuning log. Best-effort, never throws. */
export function appendObserverLog(entry: Record<string, unknown>): void {
  try {
    mkdirSync(OBSERVER_DIR, { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // logging is best-effort
  }
}
