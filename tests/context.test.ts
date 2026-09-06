import { describe, expect, test } from "bun:test";
import { serializePiContext } from "../src/context.ts";

const context = (messages: any[]) => ({ messages }) as any;
const user = (content: any) => ({ role: "user", content, timestamp: 0 });
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  timestamp: 0,
});

describe("serializePiContext", () => {
  test("renders a single current user request", () => {
    expect(serializePiContext(context([user("hello")]))).toBe("[Current Request]\n\nhello");
  });

  test("includes prior user and assistant text before the current request", () => {
    const result = serializePiContext(context([
      user("Discuss priority integers."),
      assistant("An advantage is simple ordering."),
      user("Would you keep that design?"),
    ]));
    expect(result).toContain("USER:\nDiscuss priority integers.");
    expect(result).toContain("ASSISTANT:\nAn advantage is simple ordering.");
    expect(result).toEndWith("[Current Request]\n\nWould you keep that design?");
  });

  test("bounds old history while preserving the current request", () => {
    const result = serializePiContext(context([
      user("discard-me-".repeat(3_000)),
      assistant("recent-response"),
      user("keep-current"),
    ]));
    expect(result).toContain("[Earlier content truncated]");
    expect(result).toContain("ASSISTANT:\nrecent-response");
    expect(result.length).toBeLessThan(25_000);
    expect(result).toEndWith("[Current Request]\n\nkeep-current");
  });

  test("skips image, thinking, tool-call, and tool-result content", () => {
    const result = serializePiContext(context([
      user([{ type: "image", mimeType: "image/png", data: "ignored" }]),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "toolCall", id: "call", name: "hidden_tool", arguments: {} },
          { type: "text", text: "visible" },
        ],
        timestamp: 0,
      },
      { role: "toolResult", content: [{ type: "text", text: "tool output" }], timestamp: 0 },
      user("current"),
    ]));
    expect(result).toContain("ASSISTANT:\nvisible");
    expect(result).not.toContain("tool output");
    expect(result).toEndWith("[Current Request]\n\ncurrent");
  });
});
