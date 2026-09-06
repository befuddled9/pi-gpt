// P5: discovered ChatGPT model registration with text-only native-provider transport.
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  type Model,
  registerApiProvider,
  type StreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadToken } from "../src/auth.ts";
import { getChatGptClients } from "../src/clients.ts";
import { discoverChatGptModels, discoveredModelRegistration, resolveDiscoveredModel } from "../src/models.ts";
import { resolveProviderModel } from "../src/reasoning.ts";
import { serializePiContext } from "../src/context.ts";

const PROVIDER_ID = "chatgpt";
const modelThinkingEfforts = new Map<string, string[]>();
type ChatGptStreamOptions = StreamOptions & { reasoning?: ThinkingLevel };

function streamChatGpt(
  model: Model<Api>,
  context: Context,
  options?: ChatGptStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
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
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    try {
      stream.push({ type: "start", partial: output });
      const prompt = serializePiContext(context);
      let contentIndex: number | undefined;

      const requested = resolveProviderModel(options?.reasoning);
      const backend = resolveDiscoveredModel(model.id, modelThinkingEfforts.get(model.id) || [], requested.thinkingEffort);
      for await (const event of getChatGptClients().conversation.stream(
        backend.model,
        [{ role: "user", content: prompt }],
        { temporary: true, thinkingEffort: backend.thinkingEffort, pollAsync: true, signal: options?.signal },
      )) {
        if (typeof event !== "string") continue;
        if (contentIndex === undefined) {
          contentIndex = output.content.length;
          output.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex, partial: output });
        }
        const block = output.content[contentIndex];
        if (block.type !== "text") continue;
        block.text += event;
        stream.push({ type: "text_delta", contentIndex, delta: event, partial: output });
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (contentIndex !== undefined) {
        const block = output.content[contentIndex];
        if (block.type === "text") {
          stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        }
      }
      output.stopReason = "stop";
      stream.push({ type: "done", reason: "stop", message: output });
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
    } finally {
      stream.end();
    }
  })();

  return stream;
}

export default async function (pi: ExtensionAPI) {
  let discovered;
  try {
    discovered = await discoverChatGptModels(getChatGptClients().backend);
  } catch (error) {
    throw new Error(`ChatGPT model discovery failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (discovered.length === 0) throw new Error("ChatGPT model discovery returned no usable models.");
  for (const model of discovered) modelThinkingEfforts.set(model.slug, model.thinking_efforts);

  registerApiProvider({ api: "chatgpt-p2", stream: streamChatGpt, streamSimple: streamChatGpt }, "pi-gpt-provider");
  pi.registerProvider(createProvider({
    id: PROVIDER_ID,
    name: "ChatGPT",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: {
      apiKey: {
        name: "ChatGPT account from codex login",
        async resolve() {
          const token = loadToken();
          return { auth: { apiKey: token.token }, source: token.sourcePath ?? "ChatGPT account" };
        },
      },
    },
    models: discovered.map(discoveredModelRegistration),
    api: { stream: streamChatGpt, streamSimple: streamChatGpt },
  }));
}
