# Presence

**[한국어](README.ko.md)**

A personal task-delegation agent platform.

![Presence Demo](docs/presence_capture_0.gif)

## Quick Start

```bash
npm install

# Create config and set your API key
cp config.example.json ~/.presence/config.json

npm start
```

### Minimal Config

```json
{
  "llm": { "apiKey": "sk-..." }
}
```

Local models (MLX, Ollama, etc.) are also supported. See [GUIDE.md](GUIDE.md) for details.

## Key Features

- **Incremental Planning** — LLM generates JSON plans, converted to Free Monad programs for execution. Observes results and iterates as needed.
- **6 Built-in Tools** — File read/write, directory listing, web fetch, shell exec, calculate
- **MCP Server Integration** — Connect external tools via Model Context Protocol
- **Memory** — Auto-saves conversations, injects relevant memories into prompts via hybrid vector + keyword search
- **History Compaction** — Auto-summarizes old conversation history when exceeding 15 turns
- **Token Budget Management** — Stepped prompt assembly within budget (system → history → memories)
- **Approval System** — Dangerous actions (file write, shell exec) require user confirmation
- **Multi-Agent** — Agent-to-agent delegation via A2A protocol
- **Heartbeat** — Periodic background check-ins
- **Terminal UI** — Ink-based. Transcript overlay (Ctrl+T), side panel, debug reports

## Commands

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history |
| `/status` | Show current state |
| `/tools` | List registered tools |
| `/models` | List/switch models |
| `/memory` | Memory management |
| `/report` | Save debug report |
| `/help` | All commands + shortcuts |

## Architecture

```
User → Incremental Planning Loop → Free Monad Program → Interpreter → Side Effects
                                                                    ↓
                                                          State + Hook → Memory, Persistence, Events
```

- **Free Monad** — Separation of program declaration and execution
- **Interpreter** — prod (real), test (mock), traced (logging), dryrun (validation)
- **State + Hook** — Side effects isolated as reactions to state changes
- **Either/Maybe** — Errors and nulls handled as values

## Tests

```bash
npm test    # 1590 tests, 39 files
```

All tests run without external dependencies.

## Documentation

- [GUIDE.md](GUIDE.md) — Configuration, usage, troubleshooting
- [SCENARIOS.md](SCENARIOS.md) — Hands-on usage scenarios
- [TESTS.md](TESTS.md) — Test coverage details
- [PLAN.md](PLAN.md) — Implementation plan + architecture design

## Tech Stack

- Node.js (ESM)
- [fun-fp-js](https://github.com/loveqoo/fun-fp-js) — Free Monad, Task, Either, Maybe
- [Ink](https://github.com/vadimdemedes/ink) — React-based terminal UI
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) — Tool integration
- lowdb — Memory persistence
- i18next — Internationalization (ko/en)
