import { describe, expect, test } from "bun:test";
import {
  discoverChatGptModels,
  discoveredModelRegistration,
  resolveDiscoveredModel,
} from "../src/models.ts";

const response = {
  models: [
    {
      slug: "account-model",
      title: "Account Model",
      reasoning_type: "reasoning",
      thinking_efforts: [{ thinking_effort: "standard" }, { thinking_effort: "extended" }],
    },
    { slug: "account-model", title: "Duplicate" },
    { slug: "instant-model", title: "Instant", reasoning_type: "none" },
  ],
};

describe("ChatGPT model discovery", () => {
  test("turns unique discovered slugs into deterministic Pi registrations", async () => {
    const models = await discoverChatGptModels({ get: async () => response });
    expect(models.map((model) => model.slug)).toEqual(["account-model", "instant-model"]);

    const registered = models.map(discoveredModelRegistration);
    expect(registered.map((model) => model.id)).toEqual(["account-model", "instant-model"]);
    expect(registered[0]).toMatchObject({
      name: "Account Model",
      reasoning: true,
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 16384,
    });
    expect(registered[0].thinkingLevelMap).toMatchObject({ medium: "standard", high: "extended", max: "extended" });
    expect(registered[1]).toMatchObject({ reasoning: false });
  });

  test("keeps the selected slug when applying supported P4 effort", () => {
    expect(resolveDiscoveredModel("account-model", ["standard", "extended"], "extended")).toEqual({
      model: "account-model",
      thinkingEffort: "extended",
      reasoningType: "reasoning",
    });
    expect(() => resolveDiscoveredModel("account-model", ["standard"], "extended"))
      .toThrow("does not support thinking effort extended");
  });

  test("surfaces discovery failures", async () => {
    await expect(discoverChatGptModels({ get: async () => { throw new Error("offline"); } }))
      .rejects.toThrow("offline");
  });
});
