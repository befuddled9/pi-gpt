# pi-gpt

A **Pi** extension that lets your agent use your **ChatGPT account** — start
chats, run deep research, analyze code, and continue conversations — all from
inside Pi. No API key needed: it reuses your `codex login`.

## Install

```bash
pi install -l .               # from the pi-gpt directory
# or from anywhere:
pi install -l /path/to/pi-gpt
# or, once published:
pi install npm:pi-gpt
```

Requires a ChatGPT login:

```bash
codex login   # writes ~/.codex/auth.json
```

## What you get

| Tool | What it does |
|------|-------------|
| `gpt_account_status` | Shows your plan, quota (limit, used, reset time in your timezone), and available workspaces. |
| `gpt_list_models` | Lists available ChatGPT models and their thinking-effort options. |
| `gpt_chat` | Starts or continues a conversation. Supports normal chat, agent mode, and deep research. Accepts files and prompt files. |
| `gpt_list_chats` | Lists chats started from the current project. |
| `gpt_get_conversation` | Reads the full message history of a conversation. |
| `gpt_get_message` | Reads a single message by ID. |

## Chat types

| Type | When to use | Typical time |
|------|------------|-------------|
| `normal` | Quick questions, code review with files, general chat | seconds |
| `agent` | Multi-step tasks, tool use, deeper analysis with files | seconds–minutes |
| `deep_research` | Web research with citations (lighter model) | minutes |
| `deep_research_heavy` | In-depth research with GPT-5.5 Pro + web browsing | 5–30 min |

### Intelligence levels

For `normal` chats: `instant` → `medium` → `high` → `extra_high` → `pro`.
Higher levels use more capable models and deeper thinking. `pro` uses
`gpt-5-5-pro`. You can also pin a specific `model` and `thinking_effort`
(`min` / `standard` / `extended` / `max`).

### Files

Pass local files as context — the agent can't read your filesystem directly:

```
files: ["src/auth.ts", "tests/auth.test.ts"]
prompt: "Review these files for bugs."
```

- **Text/code/Markdown**: inlined into the prompt (all chat types).
- **Images (PNG/JPEG/GIF/BMP/WebP)**: uploaded (normal/agent only).
- **PDF**: uploaded (normal/agent only).
- **Deep Research**: text only — images and PDFs are rejected before starting.

You can also use `prompt_file` to load a prepared prompt from a file.

### Deep Research

Heavy deep research (`deep_research_heavy`) runs a multi-minute web research
session using GPT-5.5 Pro. The tool handles everything automatically:

- **Auto-starts**: the research plan is confirmed immediately, no manual approval.
- **Live progress**: streams progress updates so you can see it working.
- **Sources**: citations with URLs are captured automatically.
- **Timeouts**: defaults to a 2-hour wait. On timeout, you get the partial
  result plus the `conversation_id` to retrieve the full report later.

#### Deep Research quota

Your ChatGPT plan includes a limited number of deep research requests per
~24-hour window. Both light (`deep_research`) and heavy (`deep_research_heavy`)
share the same quota counter:

| Plan | Limit per window |
|------|-----------------|
| Pro | 40 |

When you run out, the tool tells you:
- How many you've used and the plan limit
- Exact reset time in **your local timezone**
- How many minutes until reset

Check your current usage anytime:
```
gpt_account_status
→ deep_research: { remaining: 12, limit: 40, reset_after_local: "Jul 28, 2026 at 2:25 AM" }
```

If a deep research request is rate-limited, the tool returns immediately with
the reset details in `details.deep_research_rate_limit` — it does **not** wait
or poll until the quota resets. Don't retry until the reported time.

### Continuing conversations

`gpt_chat` returns a `conversation_id`. Pass it back to continue the same thread:

```
# First message
gpt_chat(prompt: "Explain JWT", chat_type: "normal")
→ conversation_id: "abc-123"

# Follow-up
gpt_chat(prompt: "How does refresh work?", conversation_id: "abc-123")
```

### Multiple accounts

Give each ChatGPT login its own directory:

```bash
CODEX_HOME="$HOME/.codex-pro" codex login
CODEX_HOME="$HOME/.codex-work" codex login

CODEX_HOME="$HOME/.codex-pro" pi   # launch Pi with the Pro account
```

`pi-gpt` never switches accounts automatically. Call `gpt_account_status` to
see which account is active.

## Privacy

- Tool output is PII-redacted (emails, phone numbers, API keys, tokens).
- Files are contained to your working directory (path traversal blocked).
- No credentials are logged.

## License

MIT.
