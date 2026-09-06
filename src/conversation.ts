// Native SSE client for chatgpt.com /backend-api/conversation.
// Faithful port of gpt2agent's sse.py. No TLS impersonation — plain fetch works.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { BackendClient } from "./client.ts";
import { getSentinelTokens } from "./sentinel.ts";
import { redactError } from "./redact.ts";
import type { FileMeta } from "./files.ts";

const CONV_URL = "https://chatgpt.com/backend-api/conversation";
const F_CONV_URL = "https://chatgpt.com/backend-api/f/conversation";

const DR_MODEL = "research";
const HEAVY_DR_MODEL = "gpt-5-5-pro";
const HEAVY_DR_HINT = "connector:connector_openai_deep_research";
export const DEFAULT_HEAVY_DR_MAX_WAIT_MINUTES = 120;

const WIDGET_STATE_TEXT_PREFIX = "The latest state of the widget is: ";

const DR_IMPERATIVE_PREFIX =
  "Begin the deep research immediately without asking for confirmation. " +
  "Do not ask clarifying questions; proceed with the best interpretation. ";

export interface ChatMessage {
  id?: string;
  role: string;
  content: string;
}

export interface StreamEvent {
  type: "progress" | "tool" | "meta" | "tool_error" | "done" | "clarification_auto_reply" | "conversation";
  text?: string;
  conversation_id?: string;
  call?: string;
  data?: any;
  message?: string;
  content_references?: any[];
  search_result_groups?: any[];
  round?: number;
  question?: string;
  terminated_abnormally?: boolean;
  timeout?: boolean;
  connector_failed?: boolean;
  deep_research_status?: string;
}

interface ConvIdSentinel {
  _conversation_id: string;
}

// ── payloads ────────────────────────────────────────────────────────────────

function buildPayload(
  model: string,
  messages: ChatMessage[],
  opts: {
    gizmoId?: string;
    temporary?: boolean;
    thinkingEffort?: string;
    conversationId?: string;
    parentMessageId?: string;
    attachments?: FileMeta[];
  } = {},
): any {
  const { gizmoId, temporary = true, thinkingEffort, conversationId, parentMessageId, attachments } = opts;
  const hasAttachments = attachments && attachments.length > 0;
  const payload: any = {
    action: "next",
    messages: messages.map((m, idx) => {
      const isLastUser = m.role === "user" && idx === messages.length - 1;
      if (isLastUser && hasAttachments) {
        const images = attachments!.filter((a) => a.is_image);
        const parts: any[] = images.map((img) => ({
          content_type: "image_asset_pointer",
          asset_pointer: `file-service://${img.file_id}`,
          size_bytes: img.size_bytes,
          ...(img.width ? { width: img.width, height: img.height } : {}),
        }));
        parts.push(m.content);
        const attMetas = attachments!.map((a) =>
          a.is_image
            ? { name: a.file_name, id: a.file_id, size: a.size_bytes, mimeType: a.mime_type, ...(a.width ? { width: a.width, height: a.height } : {}) }
            : { name: a.file_name, id: a.file_id, size: a.size_bytes, mime_type: a.mime_type },
        );
        return {
          id: m.id || randomUUID(),
          author: { role: m.role },
          content: { content_type: images.length ? "multimodal_text" : "text", parts },
          metadata: { attachments: attMetas },
        };
      }
      return {
        id: m.id || randomUUID(),
        author: { role: m.role },
        content: { content_type: "text", parts: [m.content] },
      };
    }),
    parent_message_id: parentMessageId || randomUUID(),
    model,
    conversation_mode: { kind: "primary_assistant" },
    force_paragen: false,
    force_rate_limit: false,
    force_use_sse: true,
    timezone_offset_min: -480,
    history_and_training_disabled: temporary,
    system_hints: [],
  };
  if (thinkingEffort) payload.thinking_effort = thinkingEffort;
  if (conversationId) payload.conversation_id = conversationId;
  if (gizmoId) {
    payload.gizmo_id = gizmoId;
    payload.conversation_origin = { type: "custom_gpt", gizmo_id: gizmoId };
  }
  return payload;
}

function buildDrPayload(
  query: string,
  opts: { conversationId?: string; parentMessageId?: string } = {},
): any {
  const payload = buildPayload(DR_MODEL, [{ role: "user", content: query }], { temporary: false });
  payload.system_hints = ["research"];
  if (opts.conversationId) payload.conversation_id = opts.conversationId;
  if (opts.parentMessageId) payload.parent_message_id = opts.parentMessageId;
  return payload;
}

function buildHeavyDrPayload(
  query: string,
  model?: string,
  opts: { conversationId?: string; parentMessageId?: string } = {},
): any {
  const msgId = randomUUID();
  const payload: any = {
    action: "next",
    messages: [
      {
        id: msgId,
        author: { role: "user" },
        create_time: Date.now() / 1000,
        content: { content_type: "text", parts: [query] },
        metadata: {
          caterpillar_selected_sources: [],
          developer_mode_connector_ids: [],
          selected_mcp_sources: [],
          selected_sources: [],
          selected_github_repos: [],
          selected_all_github_repos: false,
          system_hints: [HEAVY_DR_HINT],
          deep_research_version: "standard",
          venus_model_variant: "standard",
          serialization_metadata: { custom_symbol_offsets: [] },
          user_timezone: "UTC",
        },
      },
    ],
    parent_message_id: randomUUID(),
    model: model || HEAVY_DR_MODEL,
    client_prepare_state: "success",
    timezone_offset_min: -480,
    timezone: "UTC",
    conversation_mode: { kind: "primary_assistant" },
    enable_message_followups: true,
    system_hints: [HEAVY_DR_HINT],
    thinking_effort: "extended",
    supports_buffering: true,
    supported_encodings: ["v1"],
    force_parallel_switch: "auto",
    paragen_cot_summary_display_override: "allow",
    history_and_training_disabled: false,
    force_use_sse: true,
  };
  if (opts.conversationId) payload.conversation_id = opts.conversationId;
  if (opts.parentMessageId) payload.parent_message_id = opts.parentMessageId;
  return payload;
}

// ── SSE line reader over a fetch web stream ─────────────────────────────────

async function* sseDataLines(r: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!r.body) throw new Error("no response body");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) {
        try {
          await reader.cancel();
        } catch {}
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed.startsWith("event:")) continue;
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") return;
        yield data;
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") yield data;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function raiseForSseError(obj: any): void {
  let raw: any = undefined;
  const err = obj.error;
  if (err && typeof err === "object") raw = err.message || err.detail || err.code || err;
  else if (typeof err === "string") raw = err;
  else if (obj.type === "error" || obj.type === "conversation_error")
    raw = obj.message || obj.detail || obj.code || obj;
  if (raw === undefined || raw === null) return;
  if (typeof raw !== "string") raw = JSON.stringify(raw);
  throw new Error(`ChatGPT SSE error: ${redactError(raw, 500)}`);
}

function safeBody(r: Response): Promise<string> {
  return r.text().then((t) => (t ? redactError(t) : "")).catch(() => "");
}

async function sseError(r: Response, url: string): Promise<never> {
  const body = await safeBody(r);
  throw new Error(`HTTP ${r.status} from ${url}` + (body ? `: ${body}` : ""));
}

// ── deep-research helpers ───────────────────────────────────────────────────

const CLARIFICATION_HINTS = [
  "could you confirm","could you clarify","could you tell me","would you like",
  "do you want me","shall i proceed","before i start","before i begin",
  "to make sure","to ensure i","i'd like to clarif","i'd like to confirm",
  "can you specify","just one key clarif","one quick clarif","one clarif",
  "a quick question","i have one question","i need to confirm",
];
const CLARIFICATION_MAX_LEN = 1200;
const DR_AUTO_PROCEED =
  "Proceed with your best interpretation of any ambiguity. " +
  "Do not ask further clarifying questions. Begin the research now.";

function looksLikeClarification(text: string): boolean {
  if (!text) return false;
  const stripped = text.trim();
  if (!stripped || stripped.length > CLARIFICATION_MAX_LEN) return false;
  const lower = stripped.toLowerCase();
  return CLARIFICATION_HINTS.some((p) => lower.includes(p));
}

function hasCitationPayload(meta: any): boolean {
  if (!meta || typeof meta !== "object") return false;
  return !!(meta.content_references || meta.search_result_groups);
}

/** Normalize App v2 websocket citations into the legacy content_references
 *  ref format ({items:[{title,url}]}) so the existing source renderer is
 *  unchanged. App v2 delivers source data ONLY via websocket frames as
 *  report_message.metadata.citations; REST polling never populates them. */
function citationsToRefs(citations: any[]): any[] {
  if (!Array.isArray(citations) || !citations.length) return [];
  const seen = new Set<string>();
  const items: { title: string; url: string }[] = [];
  for (const c of citations) {
    const url = c?.metadata?.url;
    if (!url || typeof url !== "string" || seen.has(url)) continue;
    seen.add(url);
    items.push({ title: c.metadata.title || url, url });
  }
  return items.length ? [{ items }] : [];
}

/** Open a websocket to the Deep Research connector's websocket_url and collect
 *  App v2 source citations for the target conversation. Returns refs in legacy
 *  format. The WS is user-wide (all conversations stream through it), so
 *  frames are filtered by conversation_id. Resolves on close, deadline, or
 *  when a report_message with citations is captured. Never throws — WS is
 *  best-effort; REST polling remains the completion authority. */
function captureDrCitationsViaWS(
  wsUrl: string,
  convId: string,
  headers: Record<string, string>,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<any[]> {
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    let resolved = false;
    const onAbort = () => { clearTimeout(timer); finish([]); };
    const finish = (refs: any[]) => {
      if (resolved) return;
      resolved = true;
      try { ws?.close(); } catch {}
      try { signal?.removeEventListener("abort", onAbort); } catch {}
      resolve(refs);
    };
    // If the deadline has already passed, don't bother connecting.
    if (Date.now() >= deadline) return finish([]);
    // Cap WS capture at 30s after the overall deadline — don't hold the
    // promise open for the full 2-hour DR window.
    const wsDeadline = Math.min(deadline, Date.now() + 30000);
    const timer = setTimeout(() => finish([]), Math.max(0, wsDeadline - Date.now()));
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return finish([]); }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      ws = new WebSocket(wsUrl, { headers });
    } catch {
      clearTimeout(timer);
      return finish([]);
    }
    ws.onmessage = (event) => {
      const frame = event.data;
      if (typeof frame !== "string" || !frame.includes(convId) || !frame.includes("citations")) return;
      let parsed: any;
      try { parsed = JSON.parse(frame); } catch { return; }
      // Validate conversation_id before trusting the frame.
      const frameConvId = parsed?.payload?.conversation_id || parsed?.conversation_id;
      if (frameConvId !== convId) return;
      const updates = parsed?.payload?.update_content?.updates;
      if (!Array.isArray(updates)) return;
      for (const upd of updates) {
        const ws2 = upd?.widget_state;
        const rm = ws2?.report_message;
        if (rm?.status === "finished_successfully" || (ws2?.status === "completed" && rm)) {
          const citations = rm?.metadata?.citations;
          if (Array.isArray(citations) && citations.length) {
            clearTimeout(timer);
            return finish(citationsToRefs(citations));
          }
        }
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => { clearTimeout(timer); finish([]); };
  });
}

function citationPayload(...metas: any[]): [any[], any[]] {
  let refs: any[] = [];
  let groups: any[] = [];
  for (const meta of metas) {
    if (!meta || typeof meta !== "object") continue;
    if (!refs.length) refs = meta.content_references || [];
    if (!groups.length) groups = meta.search_result_groups || [];
  }
  return [refs, groups];
}

function coerceWidgetState(obj: any): any | null {
  if (typeof obj === "string") {
    const brace = obj.indexOf("{");
    if (brace < 0) return null;
    try {
      obj = JSON.parse(obj.slice(brace));
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  // The widget state itself (has status/plan/report_message directly).
  if ("status" in obj || "report_message" in obj || "plan" in obj) return obj;
  // Wrapped inside {widget_state: {...}}.
  const inner = obj.widget_state;
  return inner && typeof inner === "object" ? inner : null;
}

export interface DeepResearchAppState {
  status: string;
  planTitle?: string;
  stepCount?: number;
  planWaitUntil?: string;
}

export function drAppStateFromMessage(msg: any): DeepResearchAppState | null {
  if (!msg || typeof msg !== "object") return null;
  const metadata = msg.metadata || {};
  let state: any;
  if (msg.author?.role === "tool") {
    const sdk = metadata.chatgpt_sdk;
    const resource = metadata.invoked_resource?.resource_uri;
    if (
      sdk?.resolved_pineapple_uri !== "connectors://connector_openai_deep_research" ||
      typeof resource !== "string" ||
      !resource.startsWith("/connector_openai_deep_research/")
    ) return null;
    // App v2 widget state can be in tool_response_metadata.venus_widget_state
    // (object, during SSE) OR in chatgpt_sdk.widget_state (string, in persisted
    // REST data). Normalize both through coerceWidgetState.
    const raw = sdk.tool_response_metadata?.venus_widget_state ?? sdk.widget_state;
    state = coerceWidgetState(raw);
  } else if (
    msg.author?.role === "system" &&
    metadata.venus_message_type === "final_widget_status_signal"
  ) {
    state = metadata.venus_widget_state;
  } else {
    return null;
  }
  if (!state || typeof state !== "object" || typeof state.status !== "string") return null;
  const plan = state.plan;
  return {
    status: state.status,
    ...(typeof plan?.title === "string" ? { planTitle: plan.title } : {}),
    ...(Array.isArray(plan?.steps) ? { stepCount: plan.steps.length } : {}),
    ...(typeof state.waiting_for_user_response_on_plan_until === "string"
      ? { planWaitUntil: state.waiting_for_user_response_on_plan_until }
      : {}),
  };
}

function drAppTerminalMessage(status: string): string | null {
  if (status === "rate_limited") return "Deep Research is currently rate-limited by ChatGPT; no research task was started.";
  if (status === "failed")
    return "Deep Research failed to complete. This is often caused by content that matches ChatGPT's safety categories (cybersecurity topics, configuration details, or meta-content about AI systems). Try chat_type=agent for code analysis, or reduce the amount of inlined code.";
  if (["error", "cancelled", "canceled", "expired"].includes(status))
    return `Deep Research stopped with status: ${status}.`;
  return null;
}

export interface DeepResearchWidgetReport {
  id: string;
  text: string;
  refs: any[];
  createTime: number;
}

export function drReportsFromWidgetState(
  detail: any,
  opts: {
    includedNodeIds?: ReadonlySet<string>;
    excludedNodeIds?: ReadonlySet<string>;
  } = {},
): DeepResearchWidgetReport[] {
  const mapping = detail?.mapping || {};
  const reports = new Map<string, DeepResearchWidgetReport>();
  for (const [nodeId, node] of Object.entries<any>(mapping)) {
    if (opts.includedNodeIds && !opts.includedNodeIds.has(nodeId)) continue;
    if (opts.excludedNodeIds?.has(nodeId)) continue;
    const msg = node?.message;
    if (!msg || typeof msg !== "object") continue;
    const role = msg.author?.role;
    if (role !== "tool" && role !== "assistant") continue;
    const carriers: any[] = [];
    const parts = msg.content?.parts || [];
    if (parts.length && typeof parts[0] === "string" && parts[0].startsWith(WIDGET_STATE_TEXT_PREFIX))
      carriers.push(parts[0]);
    const sdk = msg.metadata?.chatgpt_sdk;
    if (sdk && typeof sdk === "object" && sdk.widget_state) carriers.push(sdk.widget_state);
    for (const carrier of carriers) {
      const state = coerceWidgetState(carrier);
      const report = state?.report_message;
      if (!report || typeof report !== "object") continue;
      const status = report.status;
      if (status !== undefined && status !== null) {
        if (status !== "finished_successfully") continue;
      } else if (state?.status && state.status !== "completed") continue;
      const reportTime = Number(report.create_time || msg.update_time || msg.create_time || 0);
      const rparts = report.content?.parts || [];
      const text = rparts.length && typeof rparts[0] === "string" ? rparts[0] : "";
      if (!text) continue;
      const id = String(report.id || `${reportTime}:${text}`);
      const previous = reports.get(id);
      if (!previous || reportTime > previous.createTime || text.length > previous.text.length) {
        reports.set(id, {
          id,
          text,
          refs: report.metadata?.content_references || [],
          createTime: reportTime,
        });
      }
    }
  }
  return [...reports.values()].sort((a, b) => a.createTime - b.createTime || a.text.length - b.text.length);
}

export function drReportFromWidgetState(
  detail: any,
  excludedNodeIds: ReadonlySet<string> = new Set(),
): [string, any[], number] {
  const report = drReportsFromWidgetState(detail, { excludedNodeIds }).at(-1);
  return report ? [report.text, report.refs, report.createTime] : ["", [], 0];
}

function isConnectorDispatchText(text: string): boolean {
  return text.startsWith('{"path":') && text.includes("connector_openai_deep_research");
}

function pointerParts(path: string, prefix: string): string[] {
  const tail = path.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  if (!tail) return [];
  return tail.split("/").map((p) => p.replace("~1", "/").replace("~0", "~"));
}

function newContainer(nextPart: string): any[] | Record<string, any> {
  return nextPart === "-" || /^\d+$/.test(nextPart) ? [] : {};
}

function ensureListSlot(seq: any[], part: string, factory: () => any): any {
  if (part === "-") {
    seq.push(factory());
    return seq[seq.length - 1];
  }
  if (!/^\d+$/.test(part)) return null;
  const idx = parseInt(part, 10);
  while (seq.length <= idx) seq.push(null);
  if (!(seq[idx] && typeof seq[idx] === "object")) seq[idx] = factory();
  return seq[idx];
}

function mergeMetadataPath(meta: any, path: string, op: string, value: any): any {
  if (path === "/message/metadata") {
    if ((op === "append" || op === "patch") && value && typeof value === "object") return { ...meta, ...value };
    if (op === "replace" && value && typeof value === "object") return value;
    return meta;
  }
  if (!path.startsWith("/message/metadata/")) return meta;
  const out: any = Array.isArray(meta) ? [...meta] : { ...meta };
  const parts = pointerParts(path, "/message/metadata");
  if (!parts.length) return out;
  let cur: any = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextPart = parts[i + 1];
    if (cur && typeof cur === "object" && !Array.isArray(cur)) {
      let nxt = cur[part];
      if (!(nxt && typeof nxt === "object")) {
        nxt = newContainer(nextPart);
        cur[part] = nxt;
      }
      cur = nxt;
    } else if (Array.isArray(cur)) {
      const nxt = ensureListSlot(cur, part, () => newContainer(nextPart));
      if (nxt === null) return out;
      cur = nxt;
    }
  }
  const key = parts[parts.length - 1];
  if (cur && typeof cur === "object" && !Array.isArray(cur)) {
    if (op === "append") {
      const existing = cur[key];
      if (Array.isArray(existing)) cur[key] = [...existing, value];
      else if (typeof existing === "string" && typeof value === "string") cur[key] = existing + value;
      else cur[key] = value;
    } else if (op === "patch" && value && typeof value === "object" && cur[key] && typeof cur[key] === "object") {
      cur[key] = { ...cur[key], ...value };
    } else {
      cur[key] = value;
    }
  } else if (Array.isArray(cur)) {
    if (key === "-" || op === "append") cur.push(value);
    else if (/^\d+$/.test(key)) {
      const idx = parseInt(key, 10);
      while (cur.length <= idx) cur.push(null);
      cur[idx] = value;
    }
  }
  return out;
}

// ── ConversationClient ──────────────────────────────────────────────────────

export class ConversationClient {
  constructor(private backend: BackendClient) {}

  private async sentinelHeaders(): Promise<Record<string, string>> {
    this.backend.reloadTokenIfStale();
    const headers: Record<string, string> = {
      ...this.backend.headers,
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    };
    const sentinel = await getSentinelTokens(this.backend.headers);
    headers["Openai-Sentinel-Chat-Requirements-Token"] = sentinel["chat-requirements"];
    if (sentinel.proof) headers["Openai-Sentinel-Proof-Token"] = sentinel.proof;
    if (sentinel.turnstile) headers["Openai-Sentinel-Turnstile-Token"] = sentinel.turnstile;
    return headers;
  }

  /** Stream text chunks; final item may be a {_conversation_id} sentinel. */
  /** Return the leaf (current_node) message id of a conversation, for continuation. */
  async leafMessageId(conversationId: string): Promise<string | null> {
    const det: any = await this.backend.get(`/backend-api/conversation/${conversationId}`);
    if (!det) return null;
    const mapping = det.mapping || {};
    const current = det.current_node;
    if (current && mapping[current]) return (mapping[current].message || {}).id || current;
    return null;
  }

  async *stream(
    model: string,
    messages: ChatMessage[],
    opts: {
      gizmoId?: string;
      temporary?: boolean;
      thinkingEffort?: string;
      conversationId?: string;
      parentMessageId?: string;
      attachments?: FileMeta[];
      signal?: AbortSignal;
    } = {},
  ): AsyncGenerator<string | ConvIdSentinel> {
    const headers = await this.sentinelHeaders();
    const payload = buildPayload(model, messages, opts);
    const r = await fetch(CONV_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: opts.signal,
    });
    if (r.status === 401) throw new Error("401 Unauthorized — run `codex login`");
    if (r.status === 403) throw new Error("403 Forbidden — token may have expired");
    if (r.status !== 200 && r.status !== 201) await sseError(r, CONV_URL);

    let currentMsgId: string | null = null;
    let lastText = "";
    let conversationId: string | null = opts.conversationId || null;

    for await (const data of sseDataLines(r, opts.signal)) {
      let obj: any;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      raiseForSseError(obj);

      const cid = obj.conversation_id;
      if (cid) conversationId = cid;

      const v = obj.v;
      if (v !== undefined && v !== null) {
        if (typeof v === "string") {
          if (v) {
            yield v;
            lastText += v;
          }
          continue;
        }
        if (typeof v === "object") {
          const vmsg = v.message || {};
          const msgId = vmsg.id;
          const isNew = msgId && msgId !== currentMsgId;
          if (isNew) {
            currentMsgId = msgId;
            lastText = "";
          }
          const parts = vmsg.content?.parts || [];
          if (parts.length && typeof parts[0] === "string") {
            const nw = parts[0];
            if (isNew) {
              if (nw) {
                yield nw;
                lastText = nw;
              }
            } else if (nw.startsWith(lastText)) {
              const delta = nw.slice(lastText.length);
              if (delta) yield delta;
              lastText = nw;
            } else if (nw) {
              yield nw;
              lastText = nw;
            }
          }
          continue;
        }
      }

      const msg = obj.message;
      if (!msg || typeof msg !== "object") continue;
      if (msg.author?.role !== "assistant") continue;
      const content = msg.content || {};
      const ct = content.content_type;
      if (ct !== "text" && ct !== "multimodal_text") continue;
      const parts = content.parts || [];
      if (!parts.length || typeof parts[0] !== "string") continue;
      const msgId = msg.id;
      const isNew = msgId && msgId !== currentMsgId;
      if (isNew) {
        currentMsgId = msgId;
        lastText = "";
      }
      const nw = parts[0];
      if (isNew) {
        if (nw) {
          yield nw;
          lastText = nw;
        }
      } else if (nw.startsWith(lastText)) {
        const delta = nw.slice(lastText.length);
        if (delta) yield delta;
        lastText = nw;
      } else if (nw) {
        yield nw;
        lastText = nw;
      }
    }

    if (conversationId) yield { _conversation_id: conversationId };
  }

  async complete(
    model: string,
    messages: ChatMessage[],
    opts: {
      gizmoId?: string;
      temporary?: boolean;
      thinkingEffort?: string;
      conversationId?: string;
      parentMessageId?: string;
      attachments?: FileMeta[];
      pollAsync?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<{ text: string; conversationId: string | null }> {
    const chunks: string[] = [];
    let convId: string | null = null;
    const preparedMessages = messages.map((message) => ({ ...message, id: message.id || randomUUID() }));
    const sentMessageIds = new Set(preparedMessages.map((message) => message.id!));
    for await (const ev of this.stream(model, preparedMessages, opts)) {
      if (typeof ev === "object") {
        if (ev._conversation_id) convId = ev._conversation_id;
        continue;
      }
      chunks.push(ev);
    }
    let text = chunks.join("");
    // Extended/max thinking and agent mode return async: the initial SSE stream
    // closes with [DONE] and ZERO text frames, and the real answer lands in the
    // conversation later. Zero frames is the definitive async signature (a
    // genuine inline response always streams something), so poll whenever we
    // got nothing inline and have a conversation to poll. Bounded by
    // pollAsyncResponse's maxWait; user can Esc-abort via signal.
    if (!text && convId) {
      text = await this.pollAsyncResponse(convId, opts.signal, 3.0, 300.0, sentMessageIds);
    }
    return { text, conversationId: convId };
  }

  private async pollAsyncResponse(
    conversationId: string,
    signal?: AbortSignal,
    pollInterval = 3.0,
    maxWait = 300.0,
    requiredAncestorIds: ReadonlySet<string> = new Set(),
  ): Promise<string> {
    const path = `/backend-api/conversation/${conversationId}`;
    const deadline = Date.now() + maxWait * 1000;
    let pollErrors = 0;
    while (Date.now() < deadline) {
      await sleep(Math.min(pollInterval * 1000, deadline - Date.now()), signal);
      if (signal?.aborted) return "";
      if (Date.now() >= deadline) break;
      let det: any;
      try {
        det = await this.backend.get(path, undefined, undefined, deadlineSignal(signal, deadline));
        pollErrors = 0;
      } catch (e: any) {
        if (signal?.aborted) return "";
        pollErrors++;
        if (pollErrors >= 5) throw new Error(`Agent poll: ${pollErrors} consecutive errors`);
        continue;
      }
      const mapping = det?.mapping || {};
      let bestText = "";
      let bestTime = 0;
      const descendsFromNewMessage = (node: any): boolean => {
        if (!requiredAncestorIds.size) return true;
        const seen = new Set<any>();
        let current = node;
        while (current && !seen.has(current)) {
          seen.add(current);
          if (requiredAncestorIds.has(current.id) || requiredAncestorIds.has(current.message?.id)) return true;
          current = current.parent ? mapping[current.parent] : null;
        }
        return false;
      };
      for (const node of Object.values<any>(mapping)) {
        const msg = node?.message;
        if (!msg || typeof msg !== "object") continue;
        if (msg.author?.role !== "assistant" || !descendsFromNewMessage(node)) continue;
        const content = msg.content || {};
        const ct = content.content_type || "";
        if (ct !== "text" && ct !== "multimodal_text") continue;
        const parts = content.parts || [];
        const strParts = parts.filter((p: any) => typeof p === "string");
        if (strParts.length && msg.status === "finished_successfully") {
          const t = msg.create_time || 0;
          if (t > bestTime) {
            bestTime = t;
            bestText = strParts[0];
          }
        }
      }
      if (bestText) return bestText;
    }
    return "";
  }

  /** Stream legacy Deep Research events (model=research). */
  async *deepResearch(
    query: string,
    signal?: AbortSignal,
    maxClarificationRounds = 2,
    continuation: { conversationId?: string; parentMessageId?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    let conversationId: string | null = continuation.conversationId || null;
    let lastAssistantMsgId: string | null = continuation.parentMessageId || null;
    let currentQuery = query;
    let emittedConversationId: string | null = null;

    if (conversationId) {
      yield { type: "conversation", conversation_id: conversationId };
      emittedConversationId = conversationId;
    }

    for (let roundNum = 0; roundNum <= maxClarificationRounds; roundNum++) {
      const headers = await this.sentinelHeaders();
      const payload = buildDrPayload(currentQuery, {
        conversationId: conversationId || undefined,
        parentMessageId: lastAssistantMsgId || undefined,
      });
      const r = await fetch(CONV_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal,
      });
      if (r.status === 401) throw new Error("401 Unauthorized — run `codex login`");
      if (r.status === 403) throw new Error("403 Forbidden — token may have expired");
      if (r.status !== 200 && r.status !== 201) await sseError(r, CONV_URL);

      let lastText = "";
      let doneEmitted = false;
      let doneText = "";
      let streamSucceeded = false;
      try {
        for await (const data of sseDataLines(r, signal)) {
          let obj: any;
          try {
            obj = JSON.parse(data);
          } catch {
            continue;
          }
          if (!obj || typeof obj !== "object") continue;
          raiseForSseError(obj);

          const cid = obj.conversation_id;
          if (cid) conversationId = cid;
          if (conversationId && conversationId !== emittedConversationId) {
            yield { type: "conversation", conversation_id: conversationId };
            emittedConversationId = conversationId;
          }

          const msg = obj.message;
          if (!msg || typeof msg !== "object") continue;
          const role = msg.author?.role || "";
          const content = msg.content || {};
          const ct = content.content_type || "";
          const status = msg.status || "";
          const meta = msg.metadata || {};

          const msgId = msg.id;
          if (msgId && role === "assistant") lastAssistantMsgId = msgId;

          if (ct === "code" && role === "assistant") {
            const callText = content.text || "";
            if (callText) yield { type: "tool", call: callText };
            continue;
          }

          if (role === "assistant" && ct === "text") {
            const parts = content.parts || [];
            const nw = parts.length && typeof parts[0] === "string" ? parts[0] : "";
            if (status === "finished_successfully") {
              yield {
                type: "done",
                text: nw,
                content_references: meta.content_references || [],
                search_result_groups: meta.search_result_groups || [],
              };
              doneEmitted = true;
              lastText = nw;
              doneText = nw;
            } else if (status === "in_progress" && nw) {
              if (nw.startsWith(lastText)) {
                const delta = nw.slice(lastText.length);
                if (delta) yield { type: "progress", text: delta };
              } else {
                yield { type: "progress", text: nw };
              }
              lastText = nw;
            }
          }
        }
        streamSucceeded = true;
      } finally {
        if (streamSucceeded && lastText && !doneEmitted) {
          yield {
            type: "done",
            text: lastText,
            content_references: [],
            search_result_groups: [],
            terminated_abnormally: true,
          };
          doneText = lastText;
          doneEmitted = true;
        }
      }

      if (!doneEmitted) return;
      if (
        conversationId &&
        lastAssistantMsgId &&
        looksLikeClarification(doneText) &&
        roundNum < maxClarificationRounds
      ) {
        yield { type: "clarification_auto_reply", round: roundNum + 1, question: doneText };
        currentQuery = DR_AUTO_PROCEED;
        continue;
      }
      return;
    }
  }

  /** Stream true Pro-tier Deep Research (gpt-5-5-pro, connector). */
  async *deepResearchHeavy(
    query: string,
    signal?: AbortSignal,
    model?: string,
    maxWaitSec?: number,
    continuation: { conversationId?: string; parentMessageId?: string } = {},
  ): AsyncGenerator<StreamEvent> {
    const excludedNodeIds = new Set<string>();
    if (continuation.conversationId) {
      const detail: any = await this.backend.get(
        `/backend-api/conversation/${continuation.conversationId}?include_visually_hidden_messages=true&include_widget_state=true`,
      );
      for (const nodeId of Object.keys(detail?.mapping || {})) excludedNodeIds.add(nodeId);
    }

    const headers = await this.sentinelHeaders();
    const payload = buildHeavyDrPayload(query, model, continuation);

    const state: any = {
      conversation_id: continuation.conversationId || null,
      resume_token: null,
      current_asst_id: null,
      asst_text: "",
      asst_status: "",
      asst_metadata: {},
      last_path: null,
      tool_invoked: false,
      tool_failed: false,
      done_emitted: false,
      deep_research_status: null,
      citation_metadata: {},
      is_connector_dispatch: false,
    };
    let emittedConversationId: string | null = null;

    if (state.conversation_id) {
      yield { type: "conversation", conversation_id: state.conversation_id };
      emittedConversationId = state.conversation_id;
    }

    const emitDone = (events: StreamEvent[]) => {
      if (state.done_emitted) return;
      const md = state.asst_metadata || {};
      const citationMd = state.citation_metadata || {};
      const [refs, groups] = citationPayload(md, citationMd);
      const ev: StreamEvent = {
        type: "done",
        text: state.asst_text,
        content_references: refs,
        search_result_groups: groups,
      };
      if (state.tool_failed) ev.connector_failed = true;
      if (state.deep_research_status) ev.deep_research_status = state.deep_research_status;
      events.push(ev);
      state.done_emitted = true;
    };

    const onEnvelope = (env: any, events: StreamEvent[]) => {
      const msg = env.message || {};
      const role = msg.author?.role;
      const recipient = msg.recipient;
      const content = msg.content || {};
      const ct = content.content_type;
      const appState = drAppStateFromMessage(msg);
      if (appState) {
        const terminal = drAppTerminalMessage(appState.status);
        if (terminal) {
          state.deep_research_status = appState.status;
          state.asst_text = terminal;
          emitDone(events);
          return;
        }
        if (appState.status === "completed") state.deep_research_status = appState.status;
        if (appState.status === "waiting_for_user_response_on_plan") {
          const plan = appState.planTitle ? `: ${appState.planTitle}` : "";
          events.push({ type: "progress", text: `Deep Research plan prepared${plan}; waiting for confirmation/start.` });
        }
      }
      if (role === "assistant" && recipient === "all" && (ct === "text" || ct === "multimodal_text")) {
        state.current_asst_id = msg.id;
        const parts = content.parts || [];
        const initial = parts.length && typeof parts[0] === "string" ? parts[0] : "";
        state.asst_text = initial;
        state.asst_status = msg.status || "";
        state.asst_metadata = msg.metadata || {};
        if (hasCitationPayload(state.asst_metadata)) state.citation_metadata = state.asst_metadata;
        state.is_connector_dispatch = isConnectorDispatchText(initial);
        if (initial && !state.is_connector_dispatch) events.push({ type: "progress", text: initial });
        if (
          state.asst_status === "finished_successfully" &&
          !state.is_connector_dispatch &&
          state.asst_text
        ) {
          emitDone(events);
        }
      } else if (role === "assistant" && typeof recipient === "string" && recipient.startsWith("api_tool")) {
        const parts = content.parts || [];
        const call = parts.length && typeof parts[0] === "string" ? parts[0] : "";
        if (call) events.push({ type: "tool", call });
        state.tool_invoked = true;
      } else if (role === "tool" && recipient === "all") {
        const parts = content.parts || [];
        const text = parts.length && typeof parts[0] === "string" ? parts[0] : "";
        if (text && (text.includes("Resource not found") || text.startsWith("Error"))) {
          events.push({ type: "tool_error", message: text });
          state.tool_failed = true;
        }
      }
    };

    const applyPath = (path: string, op: string, value: any, events: StreamEvent[]) => {
      if (path === "/message/content/parts/0") {
        if (op === "append" && typeof value === "string") {
          const nextText = state.asst_text + value;
          const wasDispatch = !!state.is_connector_dispatch;
          const nextIsDispatch = wasDispatch || isConnectorDispatchText(nextText);
          state.asst_text = nextText;
          state.is_connector_dispatch = nextIsDispatch;
          if (value && !nextIsDispatch) events.push({ type: "progress", text: value });
        } else if (op === "replace" && typeof value === "string") {
          const newIsDispatch = isConnectorDispatchText(value);
          if (!newIsDispatch && value.startsWith(state.asst_text)) {
            const delta = value.slice(state.asst_text.length);
            if (delta) events.push({ type: "progress", text: delta });
          } else if (value && !newIsDispatch) {
            events.push({ type: "progress", text: value });
          }
          state.asst_text = value;
          state.is_connector_dispatch = newIsDispatch;
        }
      } else if (path === "/message/status") {
        if (op === "replace" && typeof value === "string") {
          state.asst_status = value;
          if (
            value === "finished_successfully" &&
            !state.is_connector_dispatch &&
            state.asst_text
          ) {
            emitDone(events);
          }
        }
      } else if (path === "/message/metadata" || path.startsWith("/message/metadata/")) {
        state.asst_metadata = mergeMetadataPath(state.asst_metadata, path, op, value);
        if (hasCitationPayload(state.asst_metadata)) state.citation_metadata = state.asst_metadata;
      }
    };

    const applyPatch = (obj: any, events: StreamEvent[]) => {
      const t = obj.type;
      if (t === "resume_conversation_token") {
        state.resume_token = obj.token;
        if (obj.conversation_id) state.conversation_id = obj.conversation_id;
        return;
      }
      if (t === "message_marker" || t === "message_stream_complete") {
        if (obj.conversation_id) state.conversation_id = obj.conversation_id;
        return;
      }
      if (t === "server_ste_metadata") {
        const md = obj.metadata || {};
        if (md.tool_invoked) state.tool_invoked = true;
        events.push({ type: "meta", data: md });
        return;
      }
      if (t === "input_message") return;
      if (t !== undefined && t !== null) return;

      const p = obj.p;
      const o = obj.o;
      const hasV = "v" in obj;
      const v = obj.v;

      if (
        v &&
        typeof v === "object" &&
        "message" in v &&
        ((p === "" && o === "add") || (p === undefined && o === undefined))
      ) {
        onEnvelope(v, events);
        state.last_path = null;
        return;
      }
      if (p === "" && o === "patch" && Array.isArray(v)) {
        for (const sub of v) if (sub && typeof sub === "object") applyPatch(sub, events);
        return;
      }
      if (typeof p === "string" && p) {
        applyPath(p, o || "replace", v, events);
        state.last_path = p;
        return;
      }
      if (p === undefined && o === undefined && hasV && state.last_path) {
        applyPath(state.last_path, "append", v, events);
        return;
      }
    };

    const r = await fetch(F_CONV_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });
    if (r.status === 401) throw new Error("401 Unauthorized — run `codex login`");
    if (r.status === 403) throw new Error("403 Forbidden — token may have expired");
    if (r.status !== 200 && r.status !== 201) await sseError(r, F_CONV_URL);

    for await (const data of sseDataLines(r, signal)) {
      let obj: any;
      try {
        obj = JSON.parse(data);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== "object") continue;
      raiseForSseError(obj);
      if (obj.conversation_id) state.conversation_id = obj.conversation_id;
      const events: StreamEvent[] = [];
      applyPatch(obj, events);
      if (state.conversation_id && state.conversation_id !== emittedConversationId) {
        yield { type: "conversation", conversation_id: state.conversation_id };
        emittedConversationId = state.conversation_id;
      }
      for (const e of events) yield e;
    }

    if (!state.done_emitted && state.conversation_id && state.tool_invoked) {
      yield* this.pollDrCompletion(state.conversation_id, signal, state.asst_text, undefined, maxWaitSec, excludedNodeIds);
      return;
    }
    if (!state.done_emitted && state.asst_text) {
      yield {
        type: "done",
        text: state.asst_text,
        content_references: [],
        search_result_groups: [],
        terminated_abnormally: true,
      };
    }
  }

  private async *pollDrCompletion(
    convId: string,
    signal: AbortSignal | undefined,
    seedText = "",
    interval = 120.0,
    // Two-hour default — heavy DR can show no visible text for long stretches
    // while the connector researches, then deliver the report all at once. Do
    // NOT stall-detect on text growth; only this wall-clock + user abort end it.
    maxWait = DEFAULT_HEAVY_DR_MAX_WAIT_MINUTES * 60,
    excludedNodeIds: ReadonlySet<string> = new Set(),
  ): AsyncGenerator<StreamEvent> {
    const path = `/backend-api/conversation/${convId}?include_visually_hidden_messages=true&include_widget_state=true`;
    const deadline = Date.now() + maxWait * 1000;
    let lastEmitted = seedText;
    let lastDeepResearchStatus = "";
    let firstPoll = true;
    let nextSleepOverride: number | null = null;
    let planSubmitted = false;
    // App v2 delivers source citations ONLY via websocket. Start capturing in
    // parallel with REST polling; merge the result into the done event.
    let wsCitationsPromise: Promise<any[]> | null = null;

    // When auto_confirm is on and the plan form appears, submit it immediately
    // instead of waiting for the server-side auto-start timeout.
    // Returns true if the confirmation POST was sent (plan submitted).
    const submitPlan = async (convId: string): Promise<boolean> => {
      try {
        const detail = await this.backend.get(
          `/backend-api/conversation/${convId}?include_visually_hidden_messages=true&include_widget_state=true`,
        );
        const leafId = detail?.current_node;
        if (!leafId) return false;
        const sentinel = await getSentinelTokens(this.backend);
        await this.backend.post(
          "/backend-api/conversation",
          {
            action: "next",
            messages: [{
              id: randomUUID(),
              author: { role: "user" },
              content: { content_type: "text", parts: ["Start the research now."] },
            }],
            parent_message_id: leafId,
            model: "gpt-4o",
            conversation_id: convId,
            conversation_mode: { kind: "primary_assistant" },
            force_paragen: false,
            force_rate_limit: false,
            force_use_sse: false,
            timezone_offset_min: -480,
            history_and_training_disabled: false,
            system_hints: [],
            ...sentinel,
          },
          "/backend-api/conversation",
        );
        return true;
      } catch {
        // Fail silently — auto-start timeout is the fallback.
        return false;
      }
    };

    const startWSCapture = (det: any) => {
      if (wsCitationsPromise) return;
      for (const node of Object.values<any>(det?.mapping || {})) {
        const wsUrl = node?.message?.metadata?.chatgpt_sdk?.tool_response_metadata?.websocket_url;
        if (typeof wsUrl === "string" && wsUrl.startsWith("wss://")) {
          wsCitationsPromise = captureDrCitationsViaWS(wsUrl, convId, this.backend.headers, deadline, signal);
          return;
        }
      }
    };

    while (Date.now() < deadline) {
      if (!firstPoll) {
        const sleepMs = nextSleepOverride !== null
          ? Math.min(nextSleepOverride, deadline - Date.now())
          : Math.min(interval * 1000, deadline - Date.now());
        nextSleepOverride = null;
        await sleep(sleepMs, signal);
        if (signal?.aborted) return;
        if (Date.now() >= deadline) break;
      }
      firstPoll = false;
      let det: any;
      try {
        det = await this.backend.get(path, undefined, undefined, deadlineSignal(signal, deadline));
      } catch (e: any) {
        if (signal?.aborted) return;
        if (String(e).includes("HTTP 429")) {
          await sleep(Math.min(Math.max(interval * 2, 300) * 1000, Math.max(0, deadline - Date.now())), signal);
        }
        continue;
      }
      startWSCapture(det);
      const mapping = det?.mapping || {};
      const candidates: [number, string, string, any][] = [];
      const citationCandidates: [number, any][] = [];
      let latestAppState: [number, DeepResearchAppState] | null = null;
      for (const [nodeId, node] of Object.entries<any>(mapping)) {
        if (excludedNodeIds.has(nodeId)) continue;
        const msg = node?.message;
        if (!msg || typeof msg !== "object") continue;
        const meta = msg.metadata || {};
        const appState = drAppStateFromMessage(msg);
        const messageTime = Number(msg.update_time || msg.create_time || 0);
        if (appState && (!latestAppState || messageTime >= latestAppState[0]))
          latestAppState = [messageTime, appState];
        if (hasCitationPayload(meta)) citationCandidates.push([msg.create_time || 0, meta]);
        if (msg.author?.role !== "assistant") continue;
        const recipient = msg.recipient;
        if (recipient && recipient !== "all") continue;
        const content = msg.content || {};
        if (content.content_type !== "text" && content.content_type !== "multimodal_text") continue;
        const parts = content.parts || [];
        const text = parts.length && typeof parts[0] === "string" ? parts[0] : "";
        if (!text) continue;
        candidates.push([msg.create_time || 0, msg.status || "", text, meta]);
      }
      const [widgetText, widgetRefs] = drReportFromWidgetState(det, excludedNodeIds);
      if (widgetText) {
        if (widgetText !== lastEmitted) yield { type: "progress", text: widgetText };
        let refs = widgetRefs;
        if (!refs.length && wsCitationsPromise) refs = await wsCitationsPromise;
        yield { type: "done", text: widgetText, content_references: refs, search_result_groups: [], deep_research_status: "completed" };
        return;
      }
      if (latestAppState) {
        const appState: DeepResearchAppState = latestAppState[1];
        const terminal = drAppTerminalMessage(appState.status);
        if (terminal) {
          yield { type: "done", text: terminal, content_references: [], search_result_groups: [], deep_research_status: appState.status };
          return;
        }
        if (appState.status !== lastDeepResearchStatus) {
          lastDeepResearchStatus = appState.status;
          if (appState.status === "waiting_for_user_response_on_plan") {
            yield { type: "progress", text: "Deep Research plan prepared; submitting…" };
            // Auto-submit the plan immediately instead of waiting for the
            // 60-second server-side auto-start timeout.
            if (!planSubmitted) {
              // Only set the flag if the POST actually went out — if it fails,
              // expiry detection must keep working.
              void submitPlan(convId).then(ok => { if (ok) planSubmitted = true; });
            }
          }
        }
        // Plan-wait deadline handling: when waiting_for_user_response_on_plan,
        // poll sooner (30s) so we catch the server-side auto-start quickly.
        // Never declare plan_expired — the server auto-starts the research at
        // the deadline and it may take minutes to complete. Keep polling until
        // maxWait, matching upstream gpt2agent behavior.
        if (appState.status === "waiting_for_user_response_on_plan") {
          nextSleepOverride = 30000;
        }
      }
      if (!candidates.length) continue;
      candidates.sort((a, b) => a[0] - b[0]);
      const [, latestStatus, latestText, latestMeta] = candidates[candidates.length - 1];

      if (latestText !== lastEmitted) {
        if (latestText.startsWith(lastEmitted)) {
          const delta = latestText.slice(lastEmitted.length);
          if (delta) yield { type: "progress", text: delta };
        } else {
          yield { type: "progress", text: latestText };
        }
        lastEmitted = latestText;
      }
      if (latestStatus === "finished_successfully") {
        let refs = latestMeta.content_references || [];
        let groups = latestMeta.search_result_groups || [];
        if ((citationCandidates.length && (!refs.length || !groups.length))) {
          const turnKeys = ["working_turn_id", "turn_exchange_id"];
          const sameTurn = citationCandidates
            .sort((a, b) => a[0] - b[0])
            .filter(([, meta]) => turnKeys.some((k) => latestMeta[k] && latestMeta[k] === meta[k]));
          const fallback = sameTurn.length
            ? sameTurn
            : citationCandidates.sort((a, b) => a[0] - b[0]);
          for (let i = fallback.length - 1; i >= 0; i--) {
            const meta = fallback[i][1];
            if (!refs.length) refs = meta.content_references || [];
            if (!groups.length) groups = meta.search_result_groups || [];
            if (refs.length && groups.length) break;
          }
        }
        yield { type: "done", text: latestText, content_references: refs.length ? refs : (wsCitationsPromise ? await wsCitationsPromise : []), search_result_groups: groups };
        return;
      }
    }
    // Never throw on timeout: the research may still be running server-side.
    // Return whatever we have + the conv id so the caller can poll later.
    if (lastEmitted) {
      yield {
        type: "done",
        text: lastEmitted,
        content_references: [],
        search_result_groups: [],
        terminated_abnormally: true,
        timeout: true,
      };
    } else {
      yield {
        type: "done",
        text: `Deep Research did not return a report within ${Math.round(maxWait / 60)} min, but it may still be running on the server. Conversation id: ${convId}. Call gpt_get_conversation with this id later to retrieve the completed report.`,
        content_references: [],
        search_result_groups: [],
        timeout: true,
      };
    }
  }
}

function deadlineSignal(signal: AbortSignal | undefined, deadline: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export { DR_IMPERATIVE_PREFIX };
