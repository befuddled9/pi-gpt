---
name: chatgpt
description: |
  Drive a ChatGPT/Codex account as Pi tools. Inspect the account, list models,
  start/continue chats (normal, agent, deep research, deep research heavy),
  pick an intelligence level, and read back conversation history — all scoped to
  the current project. Reuses `codex login` (~/.codex/auth.json); no API key.
  Deep research can run for many minutes; progress streams live.
---

# ChatGPT for Pi

`pi-gpt` lets you (the agent) interact with a **ChatGPT account** as if it were
another tool — useful for delegating research, getting a second opinion from
GPT-5, or running ChatGPT's Deep Research / Agent modes.

## Setup

Requires a ChatGPT login. The token is reused from Codex:

```bash
codex login   # writes ~/.codex/auth.json (also used by pi-gpt)
```

Verify with `gpt_account_status`.

For multiple logins, isolate credentials with `CODEX_HOME` and start a separate
Pi process for the selected account:

```bash
CODEX_HOME="$HOME/.codex-pro" codex login
CODEX_HOME="$HOME/.codex-work" codex login
CODEX_HOME="$HOME/.codex-pro" pi
```

For multiple workspaces under one login, `forced_chatgpt_workspace_id` in that
home's `config.toml` can restrict login to one workspace. `codex --profile` does
not isolate authentication. Never switch accounts automatically to evade a
quota; account choice crosses billing and data boundaries.

## Tools

| Tool | What it does |
|------|--------------|
| `gpt_account_status` | Auth profile, selected account, available workspaces, plan, expiry, features, and raw Deep Research quota. |
| `gpt_list_models` | Models + their `slug` and thinking-effort options. |
| `gpt_chat` | Start or continue a chat. The core tool. |
| `gpt_list_chats` | Chats started from the **current project path**. |
| `gpt_get_conversation` | Full message history of a conversation (redacted). |
| `gpt_get_message` | A single message by id. |

## Using `gpt_chat`

```
gpt_chat(
  prompt:           string,           # optional if prompt_file is given
  prompt_file:      "<path>",        # prepared UTF-8 prompt packet
  files:            ["<path>", ...], # local files supplied as review/context material
  chat_type:        normal | agent | deep_research | deep_research_heavy,  # default normal
  intelligence:     instant | medium | high | extra_high | pro,            # default medium
  model:            "<slug>",         # overrides the model for normal chats
  thinking_effort:  min | standard | extended | max,  # explicit normal-chat effort
  conversation_id:  "<id>",           # continue an existing thread
  auto_confirm:     true|false,       # deep research: start without asking (default true)
  max_wait_minutes: 120,              # Heavy DR wall-clock; increase as needed
  temporary:        true|false,       # default false (persistent / resumable)
)
```

- **prompt_file** reads one prepared UTF-8 prompt packet (relative to cwd) and
  appends it to the prompt. Either `prompt` or `prompt_file` is required.
- **files** supplies local context (relative to cwd). UTF-8 text/source/Markdown
  is embedded verbatim for every chat type. PNG, JPEG, GIF, BMP, WebP, and PDF
  use native uploads for normal/agent; both Deep Research modes reject them
  before starting. Unsupported or unrecognized formats fail explicitly—nothing
  is silently skipped.
- Before asking `gpt_chat` to review local work, include the actual diff and
  relevant source, tests, configs, and docs through `files` or a prepared
  `prompt_file`. ChatGPT cannot read Pi's working tree; paths and summaries are
  not review context. Send only necessary, non-secret material.

- **chat_type** selects the mode. `deep_research` = web research (30–120s);
  `deep_research_heavy` = Pro-tier gpt-5-5-pro (5–30+ min, uses monthly quota);
  `agent` = autonomous browsing/code (262K context, async).
- **intelligence** picks model + reasoning depth for normal chats:
  `instant` (no thinking) → `medium` → `high` → `extra_high` (max thinking) →
  `pro` (gpt-5-5-pro). Pass **model** + **thinking_effort** to pin both
  explicitly; use an effort listed by `gpt_list_models`. Agent mode uses
  `agent-mode`; Deep Research uses its own models.
- **conversation_id** continues a chat from `gpt_list_chats`. The tool returns
  the `conversation_id` of every chat it starts.
- Deep research streams progress and appends a **Sources** section with
  citations. If the report is truncated or the connector failed, the tool says so.
- **max_wait_minutes** (deep_research_heavy, default 120): increase it when the
  research scope warrants more than two hours; no maximum is configured. Heavy
  DR may show no visible text for long stretches while the connector researches
  in the background — a heartbeat keeps the run visibly alive and Esc aborts.
  App v2 plan preparation is normal progress. Terminal statuses such as
  `rate_limited` return immediately instead of waiting for the deadline. Read
  `details.deep_research_rate_limit.reset_after` and `retry_after_seconds`, and
  do not retry before that reset. `raw_remaining` is opaque backend data, not a
  reliable quota count. On timeout it returns whatever it has plus the
  `conversation_id` so you can retrieve the completed report later with
  `gpt_get_conversation`.

## Project-scoped chats

`gpt_list_chats` returns only the chats started from the **current working
directory** (this project). This lets you keep per-project threads separate
without remembering ids — call it to see what ChatGPT work exists for *this*
codebase, then pass a `conversation_id` back to `gpt_chat` to continue one.

## Tips

- For a quick GPT-5 answer use `gpt_chat` with `chat_type=normal, intelligence=medium`.
- For long web research use `deep_research`; reserve `deep_research_heavy` for
  cases that genuinely need the full multi-section Pro report (quota is limited).
- Tool output is PII-redacted (emails, tokens, phone numbers masked).
- If account access or quota looks wrong, call `gpt_account_status` and verify
  `auth_profile`, `account_id`, and the selected workspace before retrying.
- If you see `401 Unauthorized`, the token expired — ask the user to run
  `codex login` with the same `CODEX_HOME` used to launch Pi.
