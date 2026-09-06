import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/models.ts";

describe("explicit model reasoning effort", () => {
  test("preserves an explicit model and thinking effort", () => {
    expect(resolveModel({ model: "gpt-5.6-sol-wm", thinkingEffort: "max" })).toEqual({
      model: "gpt-5.6-sol-wm",
      thinkingEffort: "max",
      reasoningType: "reasoning",
    });
  });

  test("does not invent an effort for an explicit model", () => {
    expect(resolveModel({ model: "gpt-5.6-sol-wm" })).toEqual({
      model: "gpt-5.6-sol-wm",
      thinkingEffort: undefined,
      reasoningType: "auto",
    });
  });

  test("allows effort to override the intelligence mapping", () => {
    expect(resolveModel({ intelligence: "medium", thinkingEffort: "max" }).thinkingEffort).toBe("max");
  });
});
