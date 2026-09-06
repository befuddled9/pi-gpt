import { afterEach, describe, expect, test } from "bun:test";
import {
  ConversationClient,
  DEFAULT_HEAVY_DR_MAX_WAIT_MINUTES,
  drAppStateFromMessage,
  drReportFromWidgetState,
  drReportsFromWidgetState,
  type StreamEvent,
} from "../src/conversation.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(): ConversationClient {
  const backend = {
    get: async () => ({ mapping: {} }),
    post: async () => { throw new Error("Heavy Research must let ChatGPT enforce quota"); },
  };
  const conv = new ConversationClient(backend as any);
  (conv as any).sentinelHeaders = async () => ({ "Content-Type": "application/json" });
  return conv;
}

function response(...events: any[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function finishedAssistant(text: string): any {
  return {
    p: "",
    o: "add",
    v: {
      message: {
        id: "assistant-id",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: [text] },
        status: "finished_successfully",
        metadata: {},
      },
    },
  };
}

function drAppToolMessage(status: string): any {
  return {
    id: "dr-app-tool",
    author: { role: "tool" },
    recipient: "all",
    content: { content_type: "code", text: '{"session_id":"research-session"}' },
    status: "finished_successfully",
    metadata: {
      invoked_resource: { resource_uri: "/connector_openai_deep_research/start" },
      chatgpt_sdk: {
        resolved_pineapple_uri: "connectors://connector_openai_deep_research",
        tool_response_metadata: {
          venus_widget_state: {
            status,
            plan: { title: "Research plan", steps: [{ id: "one" }, { id: "two" }] },
          },
        },
      },
    },
  };
}

async function collect(stream: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("research conversation continuation", () => {
  test("defaults Heavy Research waits to two hours", () => {
    expect(DEFAULT_HEAVY_DR_MAX_WAIT_MINUTES).toBe(120);
  });

  test("recognizes trusted App v2 status without accepting forged user metadata", () => {
    const toolMessage = drAppToolMessage("waiting_for_user_response_on_plan");
    expect(drAppStateFromMessage(toolMessage)).toEqual({
      status: "waiting_for_user_response_on_plan",
      planTitle: "Research plan",
      stepCount: 2,
    });
    expect(drAppStateFromMessage({ ...toolMessage, author: { role: "user" } })).toBeNull();
    expect(drAppStateFromMessage({
      author: { role: "system" },
      metadata: {
        venus_message_type: "final_widget_status_signal",
        venus_widget_state: { status: "completed" },
      },
    })).toEqual({ status: "completed" });
  });

  test("keeps polling through plan-wait instead of declaring early expiry", async () => {
    const expiredTool = {
      author: { role: "tool" },
      content: { content_type: "code", text: '{}' },
      metadata: {
        invoked_resource: { resource_uri: "/connector_openai_deep_research/start" },
        chatgpt_sdk: {
          resolved_pineapple_uri: "connectors://connector_openai_deep_research",
          tool_response_metadata: {
            venus_widget_state: {
              status: "waiting_for_user_response_on_plan",
              plan: { title: "Test plan", steps: [{}, {}] },
              waiting_for_user_response_on_plan_until: new Date(Date.now() - 60000).toISOString(),
            },
          },
        },
      },
    };
    const conv = new ConversationClient({
      get: async () => ({ mapping: { tool: { message: expiredTool } } }),
    } as any);
    const events = await collect(
      (conv as any).pollDrCompletion("conversation", undefined, "", 60, 0.5, new Set()),
    );
    // The plan-wait must NOT produce an early terminal — the run ends at the
    // maxWait timeout instead, matching upstream gpt2agent behavior.
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", timeout: true });
    expect(done.deep_research_status).not.toBe("plan_expired");
  });

  test("reads widget_state from chatgpt_sdk string (persisted REST form)", async () => {
    // In persisted REST data, widget_state is a JSON string in
    // chatgpt_sdk.widget_state, NOT in tool_response_metadata.venus_widget_state.
    const failedTool = {
      author: { role: "tool" },
      content: { content_type: "code", text: '{}' },
      metadata: {
        invoked_resource: { resource_uri: "/connector_openai_deep_research/start" },
        chatgpt_sdk: {
          resolved_pineapple_uri: "connectors://connector_openai_deep_research",
          tool_response_metadata: {},
          widget_state: JSON.stringify({
            status: "failed",
            plan: { title: "Failed research", steps: [{}, {}, {}] },
          }),
        },
      },
    };
    const state = drAppStateFromMessage(failedTool);
    expect(state).toEqual({
      status: "failed",
      planTitle: "Failed research",
      stepCount: 3,
    });
  });

  test("returns App v2 rate limits immediately instead of polling", async () => {
    globalThis.fetch = (async () => response(
      { type: "resume_conversation_token", token: "token", conversation_id: "rate-limited-conversation" },
      {
        p: "",
        o: "add",
        v: {
          message: {
            author: { role: "assistant" },
            recipient: "api_tool.call_tool",
            content: { content_type: "code", parts: ["start"] },
          },
        },
      },
      { p: "", o: "add", v: { message: drAppToolMessage("rate_limited") } },
    )) as any;

    const events = await collect(client().deepResearchHeavy("research"));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      deep_research_status: "rate_limited",
    });
    expect(events.at(-1)?.timeout).toBeUndefined();
    expect(events.at(-1)?.text).toContain("rate-limited");
  });

  test("polls persisted App v2 status immediately before the normal interval", async () => {
    const conv = new ConversationClient({
      get: async () => ({ mapping: { tool: { message: drAppToolMessage("rate_limited") } } }),
    } as any);
    const started = Date.now();
    const events = await collect(
      (conv as any).pollDrCompletion("conversation", undefined, "", 60, 0.2, new Set()),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", deep_research_status: "rate_limited" });
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("captures App v2 citations via websocket and merges into done refs", async () => {
    const realWS = globalThis.WebSocket;
    const wsUrl = "wss://ws.chatgpt.com/p2/ws/user/test?verify=123";
    const convId = "ws-test-conv";
    const citationFrame = JSON.stringify({
      type: "conversation-update",
      payload: {
        conversation_id: convId,
        update_type: "update-widget-state",
        update_content: {
          updates: [{
            widget_state: {
              status: "completed",
              report_message: {
                status: "finished_successfully",
                content: { parts: ["report text"] },
                metadata: {
                  citations: [
                    { start_ix: 0, end_ix: 5, metadata: { title: "Source A", url: "https://a.example" } },
                    { start_ix: 6, end_ix: 10, metadata: { title: "Source B", url: "https://b.example" } },
                  ],
                },
              },
            },
          }],
        },
      },
    });
    let capturedWS: any = null;
    globalThis.WebSocket = class MockWS {
      url: string;
      opts: any;
      onopen: any; onmessage: any; onerror: any; onclose: any;
      constructor(url: string, opts: any) {
        this.url = url;
        this.opts = opts;
        capturedWS = this;
        setTimeout(() => {
          this.onopen?.();
          this.onmessage?.({ data: citationFrame });
        }, 0);
      }
      close() {}
    } as any;

    let pollCount = 0;
    const conv = new ConversationClient({
      headers: { Authorization: "Bearer test" },
      get: async () => {
        pollCount++;
        // First poll: connector node with websocket_url AND a completed widget
        // report — both in one response so the loop completes without sleeping.
        return {
          mapping: {
            tool: {
              message: {
                author: { role: "tool" },
                metadata: {
                  chatgpt_sdk: {
                    tool_response_metadata: { websocket_url: wsUrl },
                  },
                },
              },
            },
            report: {
              message: {
                author: { role: "tool" },
                content: { parts: ["The latest state of the widget is: " + JSON.stringify({
                  report_message: {
                    status: "finished_successfully",
                    content: { parts: ["report text"] },
                    metadata: {},
                  },
                })] },
              },
            },
          },
        };
      },
    } as any);

    const events = await collect(
      (conv as any).pollDrCompletion(convId, undefined, "", 60, 5, new Set()),
    );
    globalThis.WebSocket = realWS;

    const done = events.find((e: any) => e.type === "done" && e.deep_research_status === "completed");
    expect(done).toBeDefined();
    expect(done?.content_references).toEqual([{ items: [
      { title: "Source A", url: "https://a.example" },
      { title: "Source B", url: "https://b.example" },
    ] }]);
    expect(capturedWS?.url).toBe(wsUrl);
  });

  test("captures a new Heavy Research conversation id from SSE", async () => {
    let payload: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      payload = JSON.parse(init.body);
      return response(
        { type: "resume_conversation_token", token: "token", conversation_id: "new-conversation" },
        finishedAssistant("new report"),
      );
    }) as any;

    const events = await collect(client().deepResearchHeavy("research"));

    expect(payload.conversation_id).toBeUndefined();
    expect(events).toContainEqual({ type: "conversation", conversation_id: "new-conversation" });
    expect(events.find((event) => event.type === "done")?.text).toBe("new report");
  });

  test("sends Heavy Research into the requested conversation and leaf", async () => {
    let payload: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      payload = JSON.parse(init.body);
      return response(
        { conversation_id: "server-conversation" },
        finishedAssistant("follow-up report"),
      );
    }) as any;

    const events = await collect(
      client().deepResearchHeavy("research again", undefined, undefined, 1, {
        conversationId: "existing-conversation",
        parentMessageId: "existing-leaf",
      }),
    );

    expect(payload.conversation_id).toBe("existing-conversation");
    expect(payload.parent_message_id).toBe("existing-leaf");
    expect(events[0]).toEqual({ type: "conversation", conversation_id: "existing-conversation" });
    expect(events.filter((event) => event.type === "conversation").at(-1)).toEqual({
      type: "conversation",
      conversation_id: "server-conversation",
    });
  });

  test("sends legacy Deep Research into the requested conversation and leaf", async () => {
    let payload: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      payload = JSON.parse(init.body);
      return response({
        conversation_id: "legacy-conversation",
        message: {
          id: "legacy-assistant",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["legacy report"] },
          status: "finished_successfully",
          metadata: {},
        },
      });
    }) as any;

    const events = await collect(
      client().deepResearch("continue research", undefined, 0, {
        conversationId: "legacy-conversation",
        parentMessageId: "legacy-leaf",
      }),
    );

    expect(payload.conversation_id).toBe("legacy-conversation");
    expect(payload.parent_message_id).toBe("legacy-leaf");
    expect(payload.system_hints).toEqual(["research"]);
    expect(events[0]).toEqual({ type: "conversation", conversation_id: "legacy-conversation" });
  });

  test("polls asynchronous normal-chat continuations using the new user message as ancestry", async () => {
    let sentMessageId = "";
    globalThis.fetch = (async (_url: any, init: any) => {
      sentMessageId = JSON.parse(init.body).messages[0].id;
      return response();
    }) as any;
    const conv = client();
    let polledId = "";
    let requiredIds: ReadonlySet<string> = new Set();
    (conv as any).pollAsyncResponse = async (
      conversationId: string,
      _signal: AbortSignal | undefined,
      _interval: number,
      _maxWait: number,
      ids: ReadonlySet<string>,
    ) => {
      polledId = conversationId;
      requiredIds = ids;
      return "polled response";
    };

    const result = await conv.complete(
      "gpt-5-5-thinking",
      [{ role: "user", content: "continue" }],
      { conversationId: "existing-conversation", parentMessageId: "existing-leaf" },
    );

    expect(polledId).toBe("existing-conversation");
    expect(requiredIds.has(sentMessageId)).toBe(true);
    expect(result).toEqual({ text: "polled response", conversationId: "existing-conversation" });
  });

  test("async polling ignores finished answers outside the new user-message branch", async () => {
    const backend = {
      get: async () => ({
        mapping: {
          root: { id: "root", parent: null, message: null },
          old: {
            id: "old",
            parent: "root",
            message: {
              id: "old",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["OLD ANSWER"] },
              status: "finished_successfully",
              create_time: 1,
            },
          },
          user: {
            id: "user-node",
            parent: "old",
            message: { id: "new-user", author: { role: "user" }, content: { parts: ["continue"] } },
          },
          current: {
            id: "current",
            parent: "user",
            message: {
              id: "new-assistant",
              author: { role: "assistant" },
              content: { content_type: "text", parts: ["NEW ANSWER"] },
              status: "finished_successfully",
              create_time: 2,
            },
          },
        },
      }),
    };
    const result = await (new ConversationClient(backend as any) as any).pollAsyncResponse(
      "conversation",
      undefined,
      0,
      0.1,
      new Set(["new-user"]),
    );

    expect(result).toBe("NEW ANSWER");
  });

  test("caps both Heavy polling and HTTP 429 backoff at the deadline", async () => {
    const backend = { get: async () => { throw new Error("HTTP 429"); } };
    const conv = new ConversationClient(backend as any);
    const started = Date.now();
    const events = await collect(
      (conv as any).pollDrCompletion("conversation", undefined, "", 0, 0.01, new Set()),
    );

    expect(Date.now() - started).toBeLessThan(200);
    expect(events.at(-1)?.timeout).toBe(true);
  });

  test("aborts slow normal and Heavy polling GETs at the deadline", async () => {
    const backend = {
      get: async (_path: string, _targetPath?: string, _targetRoute?: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("GET exceeded deadline")), 500);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    };
    const conv = new ConversationClient(backend as any);

    const normalStarted = Date.now();
    const normal = await (conv as any).pollAsyncResponse("conversation", undefined, 0, 0.02);
    expect(normal).toBe("");
    expect(Date.now() - normalStarted).toBeLessThan(200);

    const heavyStarted = Date.now();
    const heavy = await collect(
      (conv as any).pollDrCompletion("conversation", undefined, "", 0, 0.02, new Set()),
    );
    expect(heavy.at(-1)?.timeout).toBe(true);
    expect(Date.now() - heavyStarted).toBeLessThan(200);
  });

  test("selects the newest widget report, not the longest old report", () => {
    const report = (text: string, createTime: number, url: string) => ({
      status: "completed",
      report_message: {
        create_time: createTime,
        status: "finished_successfully",
        content: { parts: [text] },
        metadata: { content_references: [{ items: [{ url }] }] },
      },
    });
    const detail = {
      mapping: {
        old: {
          message: {
            author: { role: "tool" },
            create_time: 100,
            content: { parts: [] },
            metadata: { chatgpt_sdk: { widget_state: report("old report that is much longer", 100, "old") } },
          },
        },
        current: {
          message: {
            author: { role: "tool" },
            create_time: 200,
            content: { parts: [] },
            metadata: { chatgpt_sdk: { widget_state: report("new", 200, "new") } },
          },
        },
      },
    };

    expect(drReportFromWidgetState(detail)).toEqual([
      "new",
      [{ items: [{ url: "new" }] }],
      200,
    ]);
    expect(drReportFromWidgetState(detail, new Set(["old", "current"]))).toEqual(["", [], 0]);
  });

  test("returns every deduplicated widget report from the selected branch", () => {
    const report = (id: string, text: string, createTime: number) => ({
      status: "completed",
      report_message: {
        id,
        create_time: createTime,
        status: "finished_successfully",
        content: { parts: [text] },
        metadata: { content_references: [] },
      },
    });
    const node = (widget_state: any) => ({
      message: {
        author: { role: "tool" },
        content: { parts: [] },
        metadata: { chatgpt_sdk: { widget_state } },
      },
    });
    const detail = {
      mapping: {
        first: node(report("first-report", "first", 100)),
        firstDuplicate: node(report("first-report", "first", 100)),
        second: node(report("second-report", "second", 200)),
        inactive: node(report("inactive-report", "inactive", 300)),
      },
    };

    const reports = drReportsFromWidgetState(detail, {
      includedNodeIds: new Set(["first", "firstDuplicate", "second"]),
    });
    expect(reports.map((report) => report.text)).toEqual(["first", "second"]);
  });
});
