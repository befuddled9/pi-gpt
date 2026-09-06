// Observer detector — judges whether the agent's VISIBLE messages show sustained struggle.
// Reuses pi-gpt's own ConversationClient (runs on the user's ChatGPT account, temporary:true).
// Validated prompt: 0 false positives on 29 healthy/trap msgs, 0 false negatives on 3 real-struggle.
import type { ConversationClient } from "./conversation.ts";
import { resolveModel } from "./models.ts";
import type { Intelligence } from "./registry.ts";
import { redact } from "./redact.ts";

export type StruggleLevel = 0 | 1 | 2 | 3;
export type StruggleKind =
  | "ambiguity"
  | "knowledge_gap"
  | "approach"
  | "looping"
  | "failed_attempt"
  | "scope_creep"
  | "none";
export type HelpSource = "user" | "gpt" | "deep_research" | "none";

export interface DetectorMessage {
  turn: number;
  text: string;
}

export interface ObserverTelemetry {
  toolCallsThisTurn?: number | null;
  toolFailuresThisTurn?: number | null;
  repeatedToolPattern?: boolean | null;
  repeatedFailurePattern?: boolean | null;
  usedGptChatThisTurn?: boolean | null;
  usedDeepResearchThisTurn?: boolean | null;
  note?: string | null;
}

export interface ObserverVerdict {
  struggle: StruggleLevel;
  kind: StruggleKind;
  source: HelpSource;
  evidence: string;
  suggested_help: string;
}

export interface DetectOptions {
  /** Intelligence level for the detector model (default "medium"). */
  detectorModel?: Intelligence;
  /** Per-call hard timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Optional external abort (e.g. session shutdown). */
  signal?: AbortSignal;
}

const KINDS: ReadonlySet<StruggleKind> = new Set([
  "ambiguity",
  "knowledge_gap",
  "approach",
  "looping",
  "failed_attempt",
  "scope_creep",
  "none",
]);
const SOURCES: ReadonlySet<HelpSource> = new Set(["user", "gpt", "deep_research", "none"]);
const MAX_MSG_CHARS = 1200;

// The validated detector prompt (v2). Anti-false-positive rules are the whole ballgame:
// healthy process narration and confident failure-mentions must score 0.
export const OBSERVER_DETECTOR_PROMPT = `You are grading whether a coding agent's OWN VISIBLE assistant messages show sustained struggle.

Important boundaries:
- You only see the agent's visible assistant messages.
- You do NOT see the user's messages.
- You do NOT see hidden reasoning.
- You may receive a small telemetry summary derived from observable runtime behavior.
- Your job is to be HIGH PRECISION. False positives are worse than false negatives.

Return STRICT JSON only, with this exact schema:
{"struggle":0|1|2|3,"kind":"ambiguity"|"knowledge_gap"|"approach"|"looping"|"failed_attempt"|"scope_creep"|"none","source":"user"|"gpt"|"deep_research"|"none","evidence":"string","suggested_help":"string"}

How to score:
- 0 = healthy progress or healthy exploration. The agent has a path forward, is executing a plan, is diagnosing confidently, is asking for needed info already, or is otherwise not meaningfully stuck.
- 1 = mild uncertainty or a small blocker, but the agent still seems to have a plausible next step.
- 2 = clear struggle. The agent appears blocked, drifting, or stuck enough that outside help would likely improve the next step.
- 3 = severe struggle. The agent explicitly has no path forward, is looping, or is repeatedly failing without a credible next move.

Very important anti-false-positive rules:
- Healthy process narration is NOT struggle.
- "let me check", "I'll inspect", "I'll verify", "next I'll test", "I found the likely cause", and similar concrete-next-step narration are usually 0.
- A confident message that merely mentions a failure, bug, problem, failed test, or broken behavior is usually 0.
- Step-by-step debugging is usually 0.
- A message can mention multiple failed attempts and still be 0 if it ends with a concrete, credible next step.
- Do NOT punish verbosity.
- Do NOT infer struggle from the words "failed", "bug", "issue", "problem", "not working", or "stuck" alone.
- Reserve 2 or 3 for cases where the agent's own wording shows it has LITTLE OR NO PATH FORWARD, is second-guessing itself, cycling, or has begun thrashing under a blocker.

How to use telemetry:
- Telemetry is only a weak prior.
- Repeated tool failures can support looping or failed_attempt, but ONLY if the messages do not show a concrete recovery path.
- If telemetry says the agent already asked the user, already used gpt_chat, or already started deep research, do NOT recommend the same help again unless the messages still show a new unresolved blocker.

Analyze the message WINDOW as a trajectory, with extra weight on the most recent message.

Kind meanings:
- ambiguity = missing or underspecified requirements
- knowledge_gap = missing external/domain knowledge or research
- approach = unclear implementation strategy / needs a second opinion
- looping = cycling, revisiting the same ideas, repeating itself
- failed_attempt = repeated attempts are not working
- scope_creep = the task has broadened or split and should be narrowed
- none = no meaningful struggle

Source mapping rules:
- ambiguity -> user
- scope_creep -> user
- knowledge_gap -> deep_research
- approach -> gpt
- looping -> gpt
- failed_attempt -> gpt
- none -> none

Output rules:
- If struggle=0, then kind must be "none" and source must be "none".
- evidence must be one short sentence citing the exact visible signal(s).
- suggested_help must be one concrete next action, under 25 words.
- If you are unsure between adjacent scores, choose the LOWER score.

VISIBLE ASSISTANT MESSAGE WINDOW:
{{WINDOW}}

OBSERVABLE TELEMETRY:
{{TELEMETRY}}

Return JSON only.`;

/** Render the detector prompt with the message window + telemetry. Pure. */
export function buildDetectorPrompt(
  messages: DetectorMessage[],
  telemetry: ObserverTelemetry = {},
): string {
  const windowText = messages.length
    ? messages
        .map((m) => `[turn ${m.turn}] ${String(redact(m.text) ?? "").slice(0, MAX_MSG_CHARS)}`)
        .join("\n\n")
    : "(no visible assistant text)";

  const telemetryText = JSON.stringify({
    toolCallsThisTurn: telemetry.toolCallsThisTurn ?? null,
    toolFailuresThisTurn: telemetry.toolFailuresThisTurn ?? null,
    repeatedToolPattern: telemetry.repeatedToolPattern ?? null,
    repeatedFailurePattern: telemetry.repeatedFailurePattern ?? null,
    usedGptChatThisTurn: telemetry.usedGptChatThisTurn ?? null,
    usedDeepResearchThisTurn: telemetry.usedDeepResearchThisTurn ?? null,
    note: telemetry.note ? String(redact(telemetry.note)) : null,
  });

  return OBSERVER_DETECTOR_PROMPT.replace("{{WINDOW}}", windowText).replace(
    "{{TELEMETRY}}",
    telemetryText,
  );
}

/**
 * Strict verdict parser. Throws on malformed JSON or illegal enum values so the
 * extension layer can apply failSilent — bad output must never become a neutral
 * 0 by accident (that would hide real signal).
 */
export function parseVerdict(raw: string): ObserverVerdict {
  if (!raw || !raw.trim()) throw new Error("empty detector response");

  let s = raw.trim();
  // Strip a ```json / ``` fence if the model wrapped the JSON.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in detector response");

  const obj = JSON.parse(s.slice(start, end + 1));

  const struggleNum = Number(obj.struggle);
  if (![0, 1, 2, 3].includes(struggleNum)) throw new Error(`invalid struggle: ${obj.struggle}`);

  const kindRaw = String(obj.kind);
  if (!KINDS.has(kindRaw as StruggleKind)) throw new Error(`invalid kind: ${obj.kind}`);
  const sourceRaw = String(obj.source);
  if (!SOURCES.has(sourceRaw as HelpSource)) throw new Error(`invalid source: ${obj.source}`);

  // Enforce struggle=0 => none/none consistency.
  const struggle = struggleNum as StruggleLevel;
  const kind = (struggle === 0 ? "none" : kindRaw) as StruggleKind;
  const source = (struggle === 0 ? "none" : sourceRaw) as HelpSource;

  return {
    struggle,
    kind,
    source,
    evidence: typeof obj.evidence === "string" ? obj.evidence.slice(0, 300) : "none",
    suggested_help: typeof obj.suggested_help === "string" ? obj.suggested_help.slice(0, 500) : "",
  };
}

/**
 * Run the detector on a window of visible assistant messages.
 * One-shot via ConversationClient.complete on the user's ChatGPT account
 * (temporary:true so detector calls never pollute gpt_list_chats).
 */
export async function detect(
  conv: ConversationClient,
  messages: DetectorMessage[],
  telemetry: ObserverTelemetry = {},
  opts: DetectOptions = {},
): Promise<ObserverVerdict> {
  const choice = resolveModel({ intelligence: opts.detectorModel || "medium" });
  const prompt = buildDetectorPrompt(messages, telemetry);

  // Portable abort: hard timeout, plus forward an external signal if given.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 30_000);
  const onExternal = () => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onExternal, { once: true });
  }
  try {
    const res = await conv.complete(
      choice.model,
      [{ role: "user", content: prompt }],
      {
        temporary: true,
        thinkingEffort: choice.thinkingEffort,
        signal: ac.signal,
      },
    );
    return parseVerdict(res.text || "");
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternal);
  }
}
