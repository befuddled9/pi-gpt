// P1 only: static registration. P2 replaces the placeholder stream with ChatGPT transport.
import {
  type Api,
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "chatgpt";
const PROTOTYPE_MODEL_ID = "prototype-static";

function p1TransportPlaceholder(model: Model<Api>) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: "ChatGPT provider transport is not implemented in P1.",
    timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  stream.end();
  return stream;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider(PROVIDER_ID, {
    name: "ChatGPT",
    // A non-secret sentinel makes the static P1 model selectable. P2 replaces
    // it with pi-gpt's existing account authentication.
    apiKey: "p1-static-registration",
    baseUrl: "https://chatgpt.com/backend-api",
    api: "chatgpt-p1",
    models: [{
      id: PROTOTYPE_MODEL_ID,
      name: "ChatGPT Prototype (Static)",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    }],
    streamSimple: p1TransportPlaceholder,
  });
}
