import { describe, expect, test } from "bun:test";
import { resolveProviderModel } from "../src/reasoning.ts";

describe("ChatGPT provider reasoning mapping", () => {
  test("uses pi-gpt instant mode when Pi thinking is off", () => {
    const resolved = resolveProviderModel();
    expect(resolved.model).toBe("gpt-5-5-instant");
    expect(resolved.thinkingEffort).toBeUndefined();
  });

  test("maps standard Pi thinking levels through pi-gpt", () => {
    expect(resolveProviderModel("minimal")).toMatchObject({ model: "gpt-5-5-thinking", thinkingEffort: "standard" });
    expect(resolveProviderModel("high")).toMatchObject({ model: "gpt-5-5-thinking", thinkingEffort: "extended" });
  });

  test("maps Pi extended levels to pi-gpt extra-high and Pro modes", () => {
    expect(resolveProviderModel("xhigh")).toMatchObject({ model: "gpt-5-5-thinking", thinkingEffort: "max" });
    expect(resolveProviderModel("max")).toMatchObject({ model: "gpt-5-5-pro", thinkingEffort: "extended" });
  });
});
