import type { Context, Message } from "@earendil-works/pi-ai/compat";

const MAX_HISTORY_CHARS = 24_000;

function textOf(message: Message): string | undefined {
  if (message.role === "user" && typeof message.content === "string") return message.content;
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || undefined;
}

/** Render the latest Pi user request with a bounded transcript of prior turns. */
export function serializePiContext(context: Context): string {
  let currentIndex = -1;
  let currentRequest: string | undefined;
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index];
    if (message.role !== "user") continue;
    const text = textOf(message);
    if (text !== undefined) {
      currentIndex = index;
      currentRequest = text;
      break;
    }
  }
  if (currentRequest === undefined) {
    throw new Error("ChatGPT provider P3 requires a user text message.");
  }

  const turns: string[] = [];
  for (let index = 0; index < currentIndex; index++) {
    const message = context.messages[index];
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message);
    if (!text) continue;
    turns.push(`${message.role === "user" ? "USER" : "ASSISTANT"}:\n${text}`);
  }

  const recent: string[] = [];
  let remaining = MAX_HISTORY_CHARS;
  for (let index = turns.length - 1; index >= 0 && remaining > 0; index--) {
    const turn = turns[index];
    if (turn.length <= remaining) {
      recent.unshift(turn);
      remaining -= turn.length;
    } else {
      const marker = "[Earlier content truncated]\n";
      recent.unshift(
        remaining > marker.length
          ? `${marker}${turn.slice(-(remaining - marker.length))}`
          : marker.slice(0, remaining),
      );
      remaining = 0;
    }
  }

  const history = recent.length ? `[Conversation Context]\n\n${recent.join("\n\n")}\n\n` : "";
  return `${history}[Current Request]\n\n${currentRequest}`;
}
