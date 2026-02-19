# AFK — Remote control for Claude Code via Telegram

Control Claude Code from your phone. Get Telegram notifications when Claude needs permission, approve or deny from anywhere. No dependencies. No cloud services, no third-party servers — just your Telegram bot.

## Quick Start

```bash
git clone https://github.com/tectiv3/afk
cd afk
./bin/afk setup     # Create Telegram bot, configure token + chat ID
./bin/afk install   # Install Claude Code hooks
./bin/afk on        # Enable remote mode
```

Claude Code will now send approval requests to Telegram instead of prompting in the terminal.

## How It Works

AFK registers three Claude Code hooks:

-   **PermissionRequest** — When Claude needs permission for a tool call (edit, bash, etc.), AFK sends the request to Telegram with Approve/Deny/Allow All buttons. Claude waits for your response.
-   **Stop** — When Claude finishes a task, you get a notification with Reply/Finish buttons. Reply injects your message back into the conversation.
-   **SessionStart** — When a new session starts, you can send initial instructions from Telegram.

All communication goes directly between your machine and the Telegram Bot API. State is stored locally in `~/.afk/`.

## Commands

```bash
./bin/afk              # Toggle remote mode (local <-> remote)
./bin/afk on           # Enable remote approvals
./bin/afk off          # Disable (use Claude's built-in prompts)
./bin/afk readonly     # Notifications only, no blocking
./bin/afk status       # Show current mode
```

```bash
./bin/afk setup        # Interactive Telegram bot setup
./bin/afk install      # Install Claude Code hooks
./bin/afk uninstall    # Remove hooks
./bin/afk telegram test   # Test Telegram connection
./bin/afk debug on/off    # Toggle debug logging (~/.afk/debug.log)
```

## Modes

**Remote** (`afk on`) — All permissioned tool calls require Telegram approval. Claude blocks until you respond.

**Local** (`afk off`) — Default Claude Code behavior. No Telegram interaction.

**Read-only** (`afk readonly`) — Sends notifications on session start/stop but doesn't block tool calls.

Mode hierarchy: session > project > global.

## Approval Buttons

-   **Approve** — Allow this one tool call
-   **Deny** — Block this tool call
-   **Allow All** — Allow and apply the "always allow" rule via Claude Code's native `updatedPermissions` (session-scoped for edits, persistent for commands)
-   **Ask Claude UI** — Fall through to Claude Code's built-in permission prompt

## Configuration

`~/.afk/config.json`:

```json
{
    "telegram_bot_token": "...",
    "telegram_chat_id": "...",
    "timeout_seconds": 3600,
    "timeout_action": "deny"
}
```

| Option            | Default  | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `timeout_seconds` | `3600`   | How long to wait for approval. `0` = infinite        |
| `timeout_action`  | `"deny"` | What to do on timeout: `"deny"`, `"allow"`, `"wait"` |

Environment variables `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` override config file values.

## Installation

Requires Node.js >= 18, Claude Code, and a Telegram account.

```bash
git clone https://github.com/tectiv3/afk.git
cd afk
./bin/afk setup
./bin/afk install              # Copies to ~/.afk/ and installs hooks
```

Install hooks at different scopes:

```bash
./bin/afk install --scope user      # All projects (~/.claude/settings.json)
./bin/afk install --scope project   # Current project (.claude/settings.json)
```

## Troubleshooting

**No Telegram messages?** Check `afk status` and `afk telegram test`.

**Buttons not working?** Check that only one polling instance is active. Enable debug logging with `afk debug on` and check `~/.afk/debug.log`.

**Hook errors in Claude Code?** Claude Code shows all hook stderr as "hook error". Most of these are informational (e.g. "Waiting for user response"). Enable debug mode for detailed logs.

## License

MIT
