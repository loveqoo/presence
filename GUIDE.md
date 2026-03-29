# Presence User Guide

A personal task-delegation agent platform.

## Quick Start

```bash
# 1. Install
npm install

# 2. Create config files
mkdir -p ~/.presence/instances ~/.presence/clients

# instances.json (required — instance list)
cat > ~/.presence/instances.json << 'EOF'
{
  "orchestrator": { "port": 3010, "host": "127.0.0.1" },
  "instances": [
    { "id": "my-agent", "port": 3001, "host": "127.0.0.1", "enabled": true, "autoStart": true }
  ]
}
EOF

# server.json (shared LLM config)
cat > ~/.presence/server.json << 'EOF'
{
  "llm": { "apiKey": "sk-..." }
}
EOF

# Instance config (override, can be empty)
echo '{}' > ~/.presence/instances/my-agent.json

# Client config (for TUI connection)
cat > ~/.presence/clients/my-agent.json << 'EOF'
{
  "instanceId": "my-agent",
  "server": { "url": "http://127.0.0.1:3001" }
}
EOF

# 3. Register a user (required — server won't start without users)
npm run user -- init --instance my-agent

# 4. Start server
npm start

# 5. Connect TUI client (enter password)
npm run start:cli -- --instance my-agent

# Run tests
npm test
```

## Configuration

### File Structure

```
~/.presence/
├── server.json              ← Shared server config (base for all instances)
├── instances.json           ← Instance list + ports (required)
├── instances/
│   ├── my-agent.json        ← Per-instance override
│   ├── my-agent.users.json  ← User list (managed via npm run user)
│   └── my-agent.secret.json ← JWT secret (auto-generated, 0600)
└── clients/
    └── my-agent.json        ← Client connection config
```

Config merge chain: `DEFAULTS → server.json → instances/{id}.json → environment variables`

### Minimal Config (OpenAI)

`~/.presence/server.json`:
```json
{
  "llm": { "apiKey": "sk-..." }
}
```

Defaults are applied for the rest (model: gpt-4o, responseFormat: json_schema).

### Local Model Config (MLX, Ollama, etc.)

`~/.presence/server.json`:
```json
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8045/v1",
    "model": "qwen3.5-35b",
    "apiKey": "local",
    "responseFormat": "json_object"
  }
}
```

Local models may not support `json_schema` well — use `json_object` instead.

### Multi-Instance Setup

`~/.presence/instances.json`:
```json
{
  "orchestrator": { "port": 3010, "host": "127.0.0.1" },
  "instances": [
    { "id": "anthony", "port": 3001, "host": "127.0.0.1", "enabled": true, "autoStart": true },
    { "id": "team-dev", "port": 3002, "host": "127.0.0.1", "enabled": true, "autoStart": true }
  ]
}
```

Override per-instance settings in `~/.presence/instances/{id}.json`:
```json
{
  "llm": { "model": "claude-sonnet-4-20250514" },
  "memory": { "path": "~/.presence/data/anthony" },
  "locale": "en"
}
```

### Full Config Options

| Path | Default | Description |
|------|---------|-------------|
| `llm.baseUrl` | `https://api.openai.com/v1` | LLM API endpoint |
| `llm.model` | `gpt-4o` | Model name |
| `llm.apiKey` | `null` | API key |
| `llm.responseFormat` | `json_schema` | `json_schema` / `json_object` / `none` |
| `llm.maxRetries` | `2` | Retries on JSON parse failure |
| `llm.timeoutMs` | `120000` | LLM request timeout (ms) |
| `maxIterations` | `10` | Max Incremental Planning iterations |
| `locale` | `ko` | UI language (`ko` / `en`) |
| `embed.provider` | `openai` | Embedding provider (`openai` / `cohere` / `custom`) |
| `embed.baseUrl` | `null` | Embedding API endpoint (for local servers) |
| `embed.apiKey` | `null` | Embedding API key (falls back to llm.apiKey) |
| `embed.model` | `null` | Embedding model (uses provider default) |
| `embed.dimensions` | `256` | Embedding vector dimensions |
| `memory.path` | `~/.presence/memory/graph.json` | Memory storage path |
| `mcp` | `[]` | MCP server list |
| `heartbeat.enabled` | `true` | Enable periodic check-ins |
| `heartbeat.intervalMs` | `300000` | Check-in interval (ms) |
| `heartbeat.prompt` | `정기 점검: 현황 확인` | Heartbeat prompt |
| `prompt.maxContextTokens` | `8000` | Max prompt context tokens |
| `prompt.reservedOutputTokens` | `1000` | Reserved output tokens |
| `tools.allowedDirs` | `[process.cwd()]` | Allowed directories for file tools |
| `delegatePolling.intervalMs` | `10000` | Remote delegate polling interval (ms) |

### Environment Variable Overrides

Environment variables are the last step in the merge chain, overriding all file settings.

```bash
OPENAI_API_KEY=sk-...           # llm.apiKey
OPENAI_MODEL=gpt-4o-mini        # llm.model
OPENAI_BASE_URL=http://...      # llm.baseUrl
PRESENCE_RESPONSE_FORMAT=json_object
PRESENCE_MEMORY_PATH=/custom/path
PRESENCE_EMBED_PROVIDER=cohere
PRESENCE_EMBED_API_KEY=...
PRESENCE_EMBED_DIMENSIONS=512
PRESENCE_DIR=/custom/presence   # Override ~/.presence/ path
PRESENCE_JWT_SECRET=...         # JWT secret override
```

## Authentication

### User Management

```bash
# Initialize instance (secret + first user)
npm run user -- init --instance my-agent

# Add user
npm run user -- add --instance my-agent --username bob

# List users
npm run user -- list --instance my-agent

# Change password (invalidates all existing sessions)
npm run user -- passwd --instance my-agent --username bob

# Remove user
npm run user -- remove --instance my-agent --username bob
```

### Auth Flow

- **Server**: Won't start without users → run `npm run user -- init` first
- **TUI**: `npm run start:cli -- --instance <id>` → password prompt → login
- **Web**: Browser access → login form → authenticate

### Token Structure

- **Access token** (15 min): Used for all API requests. Stored in memory only.
- **Refresh token** (7 days): For access token renewal. Web uses HttpOnly cookie, TUI uses memory.
- Password change immediately invalidates all existing tokens.
- Refresh token rotation: old token revoked on refresh; replaying a revoked token triggers full session revocation (theft detection).

## Usage

### Commands

Enter commands at the `>` prompt after startup.

**Conversation:**

| Command | Description |
|---------|-------------|
| `/clear` | Clear conversation history (memory is preserved) |

**Information:**

| Command | Description |
|---------|-------------|
| `/status` | Current state (turn, mode, queue status) |
| `/tools` | List registered tools |
| `/agents` | List registered agents |
| `/todos` | TODO list |
| `/events` | Event queue + dead letter status |

**Settings:**

| Command | Description |
|---------|-------------|
| `/models` | List/switch models (e.g., `/models gpt-4`) |
| `/memory` | Memory management (e.g., `/memory list`, `/memory clear 7d`) |
| `/statusline` | Configure status bar display (e.g., `/statusline +turn`) |

**Display:**

| Command | Description |
|---------|-------------|
| `/panel` | Toggle side panel |
| `/report` | Save debug report to `~/.presence/reports/` |
| `/quit` | Exit |

### Keyboard Shortcuts

| Key | Description |
|-----|-------------|
| `Ctrl+T` | Transcript overlay (Op trace, prompt, response) |
| `Ctrl+O` | Toggle detail view (expand tool results) |
| `ESC` | Cancel turn (working) / dismiss help (idle) |
| `↑ / ↓` | Browse input history |

### How the Agent Works

Incremental Planning Engine:
1. LLM generates an execution plan as JSON
2. Plan is parsed into a Free Monad program
3. Interpreter executes steps sequentially
4. Results are observed; if more info is needed, return to step 1 (up to `maxIterations`)
5. When sufficient information is gathered, respond with `direct_response`

### Built-in Tools

| Tool | Description | APPROVE |
|------|-------------|---------|
| `file_read` | Read a file | No |
| `file_write` | Write a file | **Yes** |
| `file_list` | List directory contents (tree format) | No |
| `web_fetch` | Fetch URL content (15s timeout, 10KB max) | No |
| `shell_exec` | Execute shell command (30s timeout) | **Yes** |
| `calculate` | Evaluate math expressions | No |

`file_write` and `shell_exec` require user approval before execution.
File tools only access directories listed in `tools.allowedDirs`.

### Approval (APPROVE) System

The agent requests approval before dangerous actions:

```
⚠ Approval required: Execute shell command: rm -rf /tmp/old
  Continue? (y/n) >
```

- `y` → Execute
- `n` → Reject, agent suggests alternatives

Background turns (heartbeat, events) auto-reject APPROVE requests.

### MCP Server Integration

Add external MCP servers in the `mcp` array of the config file.

```json
{
  "mcp": [
    {
      "serverName": "github",
      "enabled": true,
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
    }
  ]
}
```

Tools are registered as `{serverName}_{toolName}` (e.g., `github_list_pull_requests`).

### Memory System

Conversations are automatically saved as episodic memory.

- **Persistence**: `~/.presence/memory/graph.json` (lowdb)
- **Search**: Hybrid vector + keyword similarity
- **Embedding**: Auto-generates vectors when API key is available (disabled otherwise)
- **Tiers**: working (temporary) → episodic (conversations) → semantic (generalized)
- **Auto-promotion**: Topics mentioned 3+ times are promoted from episodic → semantic
- **Management**: `/memory list`, `/memory clear 7d`, etc.

### History Compaction

When conversation exceeds 15 turns, older history is automatically summarized by the LLM.

- Most recent 5 turns are kept verbatim; the rest are replaced with a 3-5 sentence summary
- When new turns accumulate above the summary, compaction runs again (incremental merge)
- Use `/clear` to reset entirely

### Prompt Budget

Prompts are automatically assembled within a token budget.

1. Fixed system message (role, rules, tool list)
2. Conversation history (newest first, as much as budget allows)
3. Related memories (with remaining budget)

A warning is displayed when budget usage exceeds 90% or when history entries are dropped.

### Heartbeat

Runs agent turns periodically (default: every 5 minutes).

```json
{
  "heartbeat": {
    "enabled": true,
    "intervalMs": 300000,
    "prompt": "Routine check: review current status"
  }
}
```

Executed via the event queue; queued if the agent is busy.

## Architecture

```
Orchestrator (:3010) ─── Management API
  ├── Instance A (:3001) ─── Express + WS + JWT Auth
  │     ├── SessionManager → N sessions
  │     ├── GlobalContext (LLM, Memory, MCP, Scheduler)
  │     └── A2A (direct agent-to-agent communication)
  └── Instance B (:3002) ─── Separate process, separate config
```

```
User Input → Free Monad Program → Interpreter → Side Effects
                                              ↓
                                    State + Hook → Memory, Persistence, Events
```

- **Free Monad**: Separation of program declaration and execution
- **ADT**: State transitions expressed as sum types (Phase, TurnResult, ErrorInfo)
- **Either/Maybe**: Errors and nulls handled as values
- **Interpreter**: prod (real), test (mock), traced (logging), dryrun (validation)
- **Multi-instance**: Separate process per instance, crash isolation, scheduler contention prevention
- **Auth**: Password + JWT (bcrypt hash, HMAC-SHA256, refresh rotation)

## Tests

```bash
npm test                          # Full suite (2526 tests, 46 files)
node test/core/agent.test.js      # Individual file
node test/run.js --no-network     # Skip network-binding tests
```

All mock-based tests run without external dependencies.

### Live Tests (real LLM)

```bash
npm start                         # Start orchestrator
node test/e2e/multi-instance-live.test.js --orchestrator http://127.0.0.1:3010
```

## Troubleshooting

### Server won't start

- `No users configured` → Run `npm run user -- init --instance <id>` to register a user
- `instances.json not found` → Create `~/.presence/instances.json`

### Login failure

- Verify user exists: `npm run user -- list --instance <id>`
- Reset password: `npm run user -- passwd --instance <id> --username <name>`
- Rate limited (429): Wait 1 minute and retry

### Responses are too slow

- Change `responseFormat` to `json_object` in `~/.presence/server.json`
- Local models: `json_object` instead of `json_schema` is required

### Repeated "LLM API error"

- Check status with `/status`
- Verify `llm.apiKey` and `llm.baseUrl` in `~/.presence/server.json`

### Tools not showing up

- Check with `/tools`
- For local tools, verify `tools.allowedDirs` setting

### Memory not accumulating

- Check with `/memory`
- Failed turns are intentionally not saved to memory
- Verify `~/.presence/memory/graph.json` exists

### Prompt budget warnings

- Use `/clear` to reset conversation history
- Use `/memory clear 7d` to clean old memories
- Consider increasing `prompt.maxContextTokens`

### Switching models

- Use `/models` to list available models
- Use `/models gpt-4o-mini` to switch at runtime
- Change `llm.model` in config for the default
