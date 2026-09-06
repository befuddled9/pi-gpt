// Intelligence-level → model + thinking_effort mapping.
import type { Intelligence } from "./registry.ts";

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
