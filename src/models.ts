// Intelligence-level → model + thinking_effort mapping.
import type { Intelligence } from "./registry.ts";

const MODEL_DISCOVERY_PATH = "/backend-api/models?history_and_training_disabled=false";
const CONSERVATIVE_CONTEXT_WINDOW = 128000;
const CONSERVATIVE_MAX_TOKENS = 16384;

export interface DiscoveredChatGptModel {
  slug: string;
  title?: string;
  reasoning_type?: string;
  thinking_efforts: string[];
  tags?: string[];
  enabled_tools?: string[];
}

type ModelBackend = { get(path: string, targetPath?: string): Promise<any> };

/** Read the authenticated account's ChatGPT model catalog. */
export async function discoverChatGptModels(backend: ModelBackend): Promise<DiscoveredChatGptModel[]> {
  const data = await backend.get(MODEL_DISCOVERY_PATH, "/backend-api/models") || {};
  const models = new Map<string, DiscoveredChatGptModel>();
  for (const model of data.models || []) {
    if (typeof model?.slug !== "string" || !model.slug || models.has(model.slug)) continue;
    models.set(model.slug, {
      slug: model.slug,
      title: typeof model.title === "string" ? model.title : undefined,
      reasoning_type: typeof model.reasoning_type === "string" ? model.reasoning_type : undefined,
      thinking_efforts: (model.thinking_efforts || [])
        .map((effort: any) => effort?.thinking_effort)
        .filter((effort: any): effort is string => typeof effort === "string"),
      tags: Array.isArray(model.tags) ? model.tags : undefined,
      enabled_tools: Array.isArray(model.enabled_tools) ? model.enabled_tools : undefined,
    });
  }
  return [...models.values()];
}

export function discoveredModelRegistration(model: DiscoveredChatGptModel) {
  const efforts = new Set(model.thinking_efforts);
  const reasoning = model.reasoning_type !== "none";
  return {
    id: model.slug,
    name: model.title || model.slug,
    api: "chatgpt-p2",
    provider: "chatgpt",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning,
    ...(model.thinking_efforts.length ? {
      thinkingLevelMap: {
        minimal: efforts.has("standard") ? "standard" : null,
        low: efforts.has("standard") ? "standard" : null,
        medium: efforts.has("standard") ? "standard" : null,
        high: efforts.has("extended") ? "extended" : null,
        xhigh: efforts.has("max") ? "max" : null,
        max: efforts.has("extended") ? "extended" : null,
      },
    } : {}),
    input: ["text"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // ChatGPT discovery does not publish these limits; shared conservative fallbacks.
    contextWindow: CONSERVATIVE_CONTEXT_WINDOW,
    maxTokens: CONSERVATIVE_MAX_TOKENS,
  };
}

/** Keep a selected ChatGPT slug authoritative while applying a supported effort. */
export function resolveDiscoveredModel(slug: string, thinkingEfforts: string[], thinkingEffort?: string): ModelChoice {
  if (!thinkingEffort || thinkingEfforts.length === 0) return { model: slug, reasoningType: "auto" };
  if (!thinkingEfforts.includes(thinkingEffort)) {
    throw new Error(`ChatGPT model ${slug} does not support thinking effort ${thinkingEffort}.`);
  }
  return { model: slug, thinkingEffort, reasoningType: "reasoning" };
}

export interface ModelChoice {
  model: string;
  thinkingEffort?: string;
  reasoningType: string;
}

// Default family: gpt-5-5 (latest at time of writing). `model` param overrides.
// Each level picks the reasoning depth that ChatGPT exposes for that family.
export const INTELLIGENCE_MAP: Record<Intelligence, ModelChoice> = {
  instant: { model: "gpt-5-5-instant", reasoningType: "none" },
  medium: { model: "gpt-5-5-thinking", thinkingEffort: "standard", reasoningType: "reasoning" },
  high: { model: "gpt-5-5-thinking", thinkingEffort: "extended", reasoningType: "reasoning" },
  extra_high: { model: "gpt-5-5-thinking", thinkingEffort: "max", reasoningType: "reasoning" },
  pro: { model: "gpt-5-5-pro", thinkingEffort: "extended", reasoningType: "pro" },
};

export const INTELLIGENCE_LEVELS = Object.keys(INTELLIGENCE_MAP) as Intelligence[];

export function resolveModel(opts: {
  intelligence?: Intelligence;
  model?: string;
  thinkingEffort?: string;
}): ModelChoice {
  if (opts.model) {
    return {
      model: opts.model,
      thinkingEffort: opts.thinkingEffort,
      reasoningType: opts.thinkingEffort ? "reasoning" : "auto",
    };
  }
  const choice = INTELLIGENCE_MAP[opts.intelligence || "medium"];
  return opts.thinkingEffort ? { ...choice, thinkingEffort: opts.thinkingEffort } : choice;
}

/** Map a model slug to its thinking-effort options, if the model is a thinker. */
export function effortsForModel(slug: string, models: any[]): string[] {
  const m = models.find((x) => x.slug === slug);
  if (!m) return [];
  return (m.thinking_efforts || []).map((e: any) => e.thinking_effort);
}
