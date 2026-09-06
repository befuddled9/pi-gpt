// pi-observer — the silent supervisor.
// Reads the coding agent's VISIBLE messages (not reasoning, not the user), detects
// sustained struggle via a model (src/observer-detector.ts), and nudges it to
// "socialize": ask the user, consult gpt_chat, or run deep research. Smart, not a
// counter; never cries wolf; off by default until /gpt-observer enables it.
//
// Pi glue only — all logic lives in src/. Reuses pi-gpt's own ConversationClient.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackendClient } from "../src/client.ts";
import { ConversationClient } from "../src/conversation.ts";
import { redact, redactError } from "../src/redact.ts";
import { detect, type ObserverTelemetry } from "../src/observer-detector.ts";
import {
  loadObserverConfig,
  patchObserverConfig,
  getSessionState,
  saveSessionState,
  recordAssistantTurn,
  applyVerdict,
  shouldAct,
  buildIntervention,
  markIntervention,
  appendObserverLog,
  type ObserverActionMode,
  type ObserverConfig,
  type ObserverIntervention,
} from "../src/observer-state.ts";
import type { Intelligence } from "../src/registry.ts";

// Module-local lazy clients (independent of extensions/chatgpt.ts so neither
// touches the other).
let _backend: BackendClient | null = null;
let _conv: ConversationClient | null = null;
function conv(): ConversationClient {
  if (!_backend) _backend = new BackendClient();
  if (!_conv) _conv = new ConversationClient(_backend);
  return _conv;
}

// One detection in flight per session (rapid turns / reloads don't pile up).
const inflight = new Map<string, Promise<void>>();

// ── status-bar indicator ───────────────────────────────────────────────────
const OBSERVER_STATUS_KEY = "pi-observer";

function observerStatusLabel(cfg: ObserverConfig): string {
  return cfg.enabled
    ? `👁 observer: on · ${cfg.onStruggle} · ${cfg.detectorModel}`
    : `👁 observer: off`;
}

function refreshObserverStatus(ui: any, hasUI: boolean, cfg: ObserverConfig): void {
  if (!hasUI) return;
  try {
    // When disabled, clear the status entirely — don't render "off".
    ui?.setStatus?.(OBSERVER_STATUS_KEY, cfg.enabled ? observerStatusLabel(cfg) : undefined);
  } catch {
    /* best-effort — stale ctx etc. */
  }
}

// ── extraction (defensive over both "message" and "entry.message" shapes) ──

function extractVisibleAssistantText(eventMessages: unknown[]): string {
  const chunks: string[] = [];
  for (const raw of eventMessages || []) {
    const msg = raw as any;
    const role = msg?.role ?? msg?.message?.role;
    if (role !== "assistant") continue;
    const content = msg?.content ?? msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        const t = String(redact(part.text) ?? "").trim();
        if (t) chunks.push(t);
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function extractTelemetry(eventMessages: unknown[]): ObserverTelemetry {
  let toolCallsThisTurn = 0;
  let usedGptChatThisTurn = false;
  let usedDeepResearchThisTurn = false;
  for (const raw of eventMessages || []) {
    const msg = raw as any;
    const role = msg?.role ?? msg?.message?.role;
    if (role !== "assistant") continue;
    const content = msg?.content ?? msg?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || part.type !== "toolCall") continue;
      toolCallsThisTurn++;
      const name = String(part.name ?? part.toolName ?? part.tool?.name ?? "");
      if (name === "gpt_chat") {
        usedGptChatThisTurn = true;
        const chatType = part.arguments?.chat_type ?? part.args?.chat_type;
        if (chatType === "deep_research" || chatType === "deep_research_heavy") {
          usedDeepResearchThisTurn = true;
        }
      }
    }
  }
  // toolFailuresThisTurn is null: agent_end gives no structured failure signal;
  // never synthesize failures from prose via regex (that's the feature's whole point).
  return {
    toolCallsThisTurn,
    toolFailuresThisTurn: null,
    repeatedToolPattern: null,
    repeatedFailurePattern: null,
    usedGptChatThisTurn,
    usedDeepResearchThisTurn,
    note: null,
  };
}

// ── intervention delivery ──────────────────────────────────────────────────

async function deliver(
  pi: ExtensionAPI,
  ui: any,
  onStruggle: ObserverActionMode,
  visible: boolean,
  iv: ObserverIntervention,
): Promise<void> {
  if (onStruggle === "notify") {
    // Surface to the human only — no turn forced.
    try {
      ui?.notify?.(iv.summary, "warning");
    } catch {
      /* stale ctx after await — best-effort */
    }
    return;
  }
  // steer (push the agent now) or nextTurn (queue for next prompt).
  try {
    await pi.sendMessage(
      { customType: "gpt_observer_nudge", content: iv.steerText, display: visible },
      {
        deliverAs: onStruggle === "steer" ? "steer" : "nextTurn",
        triggerTurn: onStruggle === "steer",
      },
    );
  } catch {
    /* best-effort */
  }
}

// ── extension entry ────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("agent_end", async (event, ctx) => {
    const cfg = loadObserverConfig();
    if (!cfg.enabled) return;

    // Capture ctx fields synchronously (ctx can go stale across awaits).
    const sm = (ctx as any)?.sessionManager;
    const sessionId: string = sm?.getSessionId?.() || "default";
    const cwd: string = sm?.getCwd?.() || (ctx as any)?.cwd || process.cwd();
    const ui = (ctx as any)?.ui;
    const eventMessages = (event as any)?.messages || [];

    const text = extractVisibleAssistantText(eventMessages);
    if (!text) return; // no visible assistant prose this turn → nothing to judge

    // Single-flight: one detection per session at a time.
    if (cfg.singleFlight && inflight.has(sessionId)) return;

    const task = (async (): Promise<void> => {
      const telemetry = extractTelemetry(eventMessages);
      let session = getSessionState(sessionId, cwd);

      // Observation-layer dedupe: skip byte-identical to the last recorded turn
      // (reloads / no-op duplicate deliveries shouldn't double-count).
      const last = session.recent[session.recent.length - 1];
      if (last && last.text === text) return;

      // Reset-on-help-used: if the agent already socialized this turn (called
      // gpt_chat / deep research), don't pile on — clear the streak.
      if (telemetry.usedGptChatThisTurn || telemetry.usedDeepResearchThisTurn) {
        session = { ...session, struggleStreak: 0 };
      }

      session = recordAssistantTurn(session, text, telemetry);

      const window = session.recent
        .slice(-cfg.messageWindow)
        .map((m) => ({ turn: m.turn, text: m.text }));

      try {
        const verdict = await detect(conv(), window, telemetry, {
          detectorModel: cfg.detectorModel,
          timeoutMs: cfg.detectorTimeoutMs,
        });

        const decision = shouldAct(cfg, session, verdict);
        session = applyVerdict(session, verdict, decision.nextStreak);

        let action: Record<string, unknown> | null = null;
        if (decision.act) {
          const intervention = buildIntervention(verdict, decision.nextStreak);
          await deliver(pi, ui, cfg.onStruggle, cfg.visible, intervention);
          session = markIntervention(session, cfg, intervention);
          action = { mode: cfg.onStruggle, key: intervention.key, source: intervention.source };
        }

        saveSessionState(session);
        if (cfg.log) {
          appendObserverLog({
            ts: Date.now(),
            session_id: sessionId,
            cwd,
            turn: session.turnsSeen,
            model: cfg.detectorModel,
            telemetry,
            messages: window,
            verdict,
            decision,
            action,
          });
        }
      } catch (err: any) {
        const msg = redactError(String((err && err.message) || err || "observer error"));
        if (cfg.log) {
          appendObserverLog({
            ts: Date.now(),
            session_id: sessionId,
            cwd,
            turn: session.turnsSeen,
            error: msg,
          });
        }
        if (!cfg.failSilent) {
          try {
            ui?.notify?.(`Observer detector error: ${msg}`, "error");
          } catch {
            /* best-effort */
          }
        }
      }
    })();

    if (cfg.singleFlight) {
      inflight.set(sessionId, task);
      try {
        await task;
      } finally {
        inflight.delete(sessionId);
      }
    } else {
      await task;
    }
  });

  // Status-bar indicator: 👁 observer: on/off · mode · model. Set on session
  // start and refreshed from the /gpt-observer menu whenever settings change.
  pi.on("session_start", async (_event, ctx) => {
    refreshObserverStatus((ctx as any)?.ui, !!(ctx as any)?.hasUI, loadObserverConfig());
  });

  registerObserverCommand(pi);
}

// ── /gpt-observer settings + status menu ───────────────────────────────────

function registerObserverCommand(pi: ExtensionAPI): void {
  pi.registerCommand("gpt-observer", {
    description: "Configure the observer (detects agent struggle, nudges it to ask for help).",
    handler: async (_args, ctx) => {
      const ui = (ctx as any)?.ui;
      const hasUI = !!(ctx as any)?.hasUI;
      const sm = (ctx as any)?.sessionManager;
      const sessionId: string = sm?.getSessionId?.() || "default";
      const cwd: string = sm?.getCwd?.() || (ctx as any)?.cwd || process.cwd();

      const pick = async (message: string, options: string[]): Promise<string | undefined> => {
        if (!hasUI) {
          try {
            ui?.notify?.(`${message} (no interactive UI here — edit ~/.pi-gpt/observer/config.json)`, "info");
          } catch {}
          return undefined;
        }
        return ui.select(message, options);
      };

      const flash = (message: string, type: "info" | "warning" = "info"): void => {
        try {
          ui?.notify?.(message, type);
        } catch {}
      };

      let cfg = loadObserverConfig();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        refreshObserverStatus(ui, hasUI, cfg);
        const main = await pick(
          `Observer — enabled:${cfg.enabled ? "ON" : "off"} · ${cfg.onStruggle} · model:${cfg.detectorModel} · window:${cfg.messageWindow} · streak:${cfg.minStreak} · floor:${cfg.struggleFloor} · cooldown:${cfg.cooldownTurns}`,
          [
            cfg.enabled ? "Disable observer" : "Enable observer",
            `Delivery mode (${cfg.onStruggle})`,
            `Detector model (${cfg.detectorModel})`,
            `Sensitivity / floor (${cfg.struggleFloor})`,
            `Required streak (${cfg.minStreak})`,
            `Message window (${cfg.messageWindow})`,
            `Cooldown turns (${cfg.cooldownTurns})`,
            `Nudge visibility (${cfg.visible ? "visible" : "hidden"})`,
            "Show session status",
            "Done",
          ],
        );
        if (main === undefined || main === "Done") break;

        if (main.startsWith("Enable") || main.startsWith("Disable")) {
          cfg = patchObserverConfig({ enabled: !cfg.enabled });
          flash(`Observer ${cfg.enabled ? "enabled" : "disabled"}.`);
        } else if (main.startsWith("Delivery mode")) {
          const m = await pick("Delivery mode", ["notify", "steer", "nextTurn"]);
          if (m) cfg = patchObserverConfig({ onStruggle: m as ObserverActionMode });
        } else if (main.startsWith("Detector model")) {
          const m = await pick("Detector model", ["instant", "medium", "high", "extra_high", "pro"]);
          if (m) cfg = patchObserverConfig({ detectorModel: m as Intelligence });
        } else if (main.startsWith("Sensitivity")) {
          const m = await pick("struggle floor (1=eager, 2=default, 3=severe only)", ["1", "2", "3"]);
          if (m) cfg = patchObserverConfig({ struggleFloor: Number(m) as 1 | 2 | 3 });
        } else if (main.startsWith("Required streak")) {
          const m = await pick("Required streak (1=eager, 2=default, 3=strict)", ["1", "2", "3"]);
          if (m) cfg = patchObserverConfig({ minStreak: Number(m) });
        } else if (main.startsWith("Message window")) {
          const m = await pick("Message window (turns sent to detector)", ["1", "3", "4"]);
          if (m) cfg = patchObserverConfig({ messageWindow: Number(m) });
        } else if (main.startsWith("Cooldown")) {
          const m = await pick("Cooldown turns between interventions", ["3", "6", "10"]);
          if (m) cfg = patchObserverConfig({ cooldownTurns: Number(m) });
        } else if (main.startsWith("Nudge visibility")) {
          const m = await pick("Nudge visibility", ["visible", "hidden"]);
          if (m) cfg = patchObserverConfig({ visible: m === "visible" });
        } else if (main === "Show session status") {
          const s = getSessionState(sessionId, cwd);
          const lv = s.lastVerdict;
          const lines = [
            `session: ${sessionId.slice(0, 8)}`,
            `turns seen: ${s.turnsSeen}`,            
            `struggle streak: ${s.struggleStreak}`,            
            `last verdict: ${lv ? `struggle=${lv.struggle} kind=${lv.kind} source=${lv.source}` : "(none yet)"}`,
            `last nudge: ${s.lastNudge ? `${s.lastNudge.key} @turn ${s.lastNudge.turn}` : "(none)"}`,
            `log: ~/.pi-gpt/observer/log.jsonl`,
          ];
          flash(lines.join("\n"));
        }
      }
    },
  });
}
