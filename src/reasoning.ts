import type { ThinkingLevel } from "@earendil-works/pi-ai/compat";
import { resolveModel, type ModelChoice } from "./models.ts";
import type { Intelligence } from "./registry.ts";

const INTELLIGENCE_BY_THINKING: Record<ThinkingLevel | "off", Intelligence> = {
  off: "instant",
  minimal: "medium",
  low: "medium",
  medium: "medium",
  high: "high",
  xhigh: "extra_high",
  max: "pro",
};

/** Translate Pi's per-request thinking level through pi-gpt's existing model map. */
export function resolveProviderModel(reasoning?: ThinkingLevel): ModelChoice {
  return resolveModel({ intelligence: INTELLIGENCE_BY_THINKING[reasoning ?? "off"] });
}
