# afk - Project Overview

## Purpose
Remote control for Claude Code via Telegram. Allows AFK (away from keyboard) operation where
Claude Code tool permission requests are forwarded to Telegram for approval.

## Tech Stack
- Node.js (>=20), CommonJS modules
- No external dependencies (pure stdlib: `https`, `fs`, `path`, `os`, `readline`)
- Telegram Bot API for remote interaction

## Structure
```
bin/afk              - Entry point / command router
lib/core/config.js   - ConfigManager class (config loading, mode management)
lib/core/logger.js   - Logger class (debug logging)
lib/core/utils.js    - Utils class (static utilities)
lib/services/telegram.js    - TelegramService (Bot API)
lib/services/permissions.js - PermissionsService (permission patterns, Claude settings)
lib/services/sessions.js    - SessionsService (session tracking, reply locks)
lib/services/queue.js       - QueueService (message queue, distributed polling)
lib/services/install.js     - InstallService (hook installation)
lib/integration/claude-hooks.js - ClaudeHooksService (main hook handlers)
lib/integration/file-system.js  - FileSystemService (DEAD CODE - never imported)
lib/ui/cli.js       - CLIService (help text, mode display)
lib/ui/prompts.js   - PromptsService (interactive setup wizard)
```

## Key Commands
- `node bin/afk` - Smart toggle (install or toggle mode)
- `node bin/afk install` - Install Claude Code hooks
- `node bin/afk setup` - Interactive Telegram setup wizard
- `node bin/afk on/off/toggle/status` - Mode management

## Architecture
- Manual dependency injection in bin/afk (no DI container)
- Services instantiated at startup and passed via constructors
- Extensive backward-compat wrapper functions (all dead code as of last review)
- No test suite exists

## Conventions
- No semicolons in lib/ files, semicolons in bin/afk
- JSDoc comments on all public methods
- Config stored at ~/.config/afk/
