# Presence Usage Scenarios

Hands-on scenarios you can try at the `>` prompt after startup.

## Getting Started

```bash
npm start
```

---

## 1. Basic Conversation

Cases where the agent responds directly with `direct_response`.

```
> Hello
> What is a closure in JavaScript?
> What can you help me with today?
> Explain monads in FP in simple terms
```

**Verify:** Responses come without any tool calls.

---

## 2. File Tools

### Reading Files

```
> Show me the contents of package.json
> Show just the first 10 lines of src/core/agent.js
> What does CLAUDE.md say?
```

### Directory Exploration

```
> What files are in the current directory?
> What's in the src/infra folder?
> Show me the test directory structure
```

### Writing Files (approval required)

```
> Write "Hello World" to /tmp/hello.txt
```

**Verify:** The `⚠ Approval required` prompt appears. After approving with `y`, the file is created.

```
> Read /tmp/hello.txt
```

**Verify:** The content matches what was just written.

---

## 3. Shell Commands (approval required)

```
> What's the current git branch?
> Show me the last 3 git log entries for this project
> What version of node am I running?
> Show disk usage for the current directory
```

**Verify:** Approval prompt appears before each command. Also test rejecting with `n`.

---

## 4. Calculation

```
> Calculate 7 * 13
> What's (100 + 200) * 3?
> What's the sum of 1 to 10?
```

**Verify:** The `calculate` tool is used and returns accurate results.

---

## 5. Web Fetch

```
> Fetch the content of https://httpbin.org/get
> Show me what's at https://jsonplaceholder.typicode.com/todos/1
```

**Verify:** URL content is fetched and summarized.

---

## 6. Multi-step Tasks

Requests that require multiple tools:

```
> Read the project name and version from package.json and summarize in one line
> List the files in src/core and briefly explain what each one does
> Show the last 5 git log entries and summarize the key changes
```

**Verify:** The agent generates a plan with multiple steps executed in order.

---

## 7. Commands

```
> /help              ← Full command list + shortcuts
> /status            ← Current state (turnState, turn, lastTurn)
> /tools             ← Registered tools
> /agents            ← Registered agents
> /memory            ← Memory summary (nodes per tier)
> /memory list       ← Full memory node list
> /todos             ← TODO list
> /events            ← Event queue status
```

**Verify:** Each command responds immediately (no agent turn).

---

## 8. Memory Verification

After a few conversations:

```
> Hello
> What is JavaScript?
> /memory            ← Check if above conversations were saved as episodic
```

Then:

```
> What did I ask about earlier?
```

**Verify:** The agent remembers and answers based on previous conversations (memory recall).

---

## 9. Error Handling

Testing graceful failure:

```
> Read /nonexistent/path/file.txt
```

**Verify:** "Access denied" or "File not found" error appears, but the agent doesn't crash.

```
> /status
```

**Verify:** lastTurn is failure but turnState is idle.

---

## 10. Approval Rejection

```
> Write something to /tmp/test.txt
```

At the approval prompt, enter `n`:

```
⚠ Approval required: ...
  Continue? (y/n) > n
```

**Verify:** Agent reports the action was rejected and returns to the prompt without crashing.

---

## 11. Restart Persistence

```
> Hello
> Read package.json
> /quit
```

Restart:

```bash
npm start
```

```
> /status
```

**Verify:** Turn counter continues from the previous value (state restore).

---

## 12. Conversation History Management

### Clear history with /clear

```
> Hello
> How's the weather?
> /status            ← Check turn count
> /clear             ← Clear conversation history
> /status            ← Turn preserved, only history cleared
```

**Verify:** Conversation history is cleared but memory and turn counter are preserved.

### Memory management

```
> /memory            ← Current memory summary
> /memory list       ← Full list
> /memory clear 7d   ← Delete memories older than 7 days
> /memory clear episodic  ← Clear entire episodic tier
```

---

## 13. Debug

### Transcript

```
> Read package.json
```

After the response, press `Ctrl+T`:

**Verify:** Op Chain, Turn info, Prompt, and Response tabs are shown. Use `←→` to switch tabs, `↑↓` to scroll.

### Debug report

```
> List files in the src directory
> /report
```

**Verify:** A markdown report is generated in `~/.presence/reports/` and copied to clipboard.

---

## 14. Model Switching

```
> /models            ← List available models
> /models gpt-4o-mini   ← Switch model at runtime
> Hello              ← Verify response comes from the new model
```

**Verify:** Model switches and responses come from the new model.

---

## 15. No-tool Responses

When tools aren't needed:

```
> What's the English word for apple?
> What's 1+1?
```

**Verify:** Agent responds with `direct_response` without generating unnecessary plans.

---

## Troubleshooting

### Responses are too slow

- Change `responseFormat` to `json_object` in `~/.presence/config.json`
- Local models: `json_object` instead of `json_schema` is required

### Repeated "LLM API error"

- Check status with `/status`
- Verify `llm.apiKey` and `llm.baseUrl` in `~/.presence/config.json`

### Tools not showing up

- Check with `/tools`
- For local tools, verify `tools.allowedDirs` setting

### Memory not accumulating

- Check with `/memory`
- Failed turns are intentionally not saved to memory
- Verify `~/.presence/memory/graph.json` exists
