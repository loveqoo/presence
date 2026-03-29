# Presence Test Scenarios

2526 tests, 46 test files.

```bash
npm test              # Run all
node test/core/agent.test.js   # Run individual file
```

---

## Phase 1: Core

### Op ADT (`test/core/makeOp.test.js`, `test/core/op.test.js`) — 84 tests

- makeOp factory: tag, data, next, Functor symbol, map applies to continuation
- DSL functions: askLLM, executeTool, respond, approve, delegate, observe, updateState, getState, parallel, spawn
- askLLM: messages array required, non-array → TypeError
- All Ops: lifted via Free.liftF, responseFormat/context preserved

### State + Hook (`test/infra/state.test.js`, `test/infra/hook.test.js`, `test/infra/reactiveState.test.js`) — 30 tests

- createState: get/set/snapshot, path-based access (dot notation), deepClone independence
- createHooks: on/off/fire, wildcard matching, recursion prevention (MAX_DEPTH)
- createReactiveState: auto-fires hooks on set, exposes hooks object

### Test Interpreter (`test/interpreter/test.test.js`) — 17 tests

- Default handlers: AskLLM → mock response, ExecuteTool → mock result, Respond → message passthrough
- UpdateState/GetState: state object integration
- Custom handler override, throw → Task.rejected, unknown Op → rejected
- Log accumulation: tag + data recorded

### Free + Interpreter Integration (`test/core/free-integration.test.js`) — 14 tests

- Free.of → Pure, Free.liftF → Impure
- chain composition, runWithTask execution
- updateState → getState roundtrip

### Plan Parser (`test/core/plan.test.js`) — 91 tests

**Utilities:**
- resolveRefs: 1-based index, null → empty array, out-of-range → filtered
- resolveStringRefs: $N substitution, missing → preserved
- resolveToolArgs: strings substituted, numbers preserved

**Step Validation (Either):**
- validateStep: op presence, string check, opHandlers registration
- argValidators: EXEC → tool required, ASK_LLM → prompt required, RESPOND → ref or message required
- APPROVE → description required, DELEGATE → target + task required
- LOOKUP_MEMORY → query is string or omitted

**Plan Execution:**
- direct_response → Either.Right(responded message)
- Single EXEC → result array
- Multi-step (EXEC → ASK_LLM → RESPOND): ctx reference, ref reference
- Unknown op → Either.Left, short-circuit (subsequent steps skipped)
- Empty steps → Either.Right([])
- RESPOND invalid ref → Either.Left
- EXEC without tool → Either.Left (PLANNER_SHAPE, not INTERPRETER)

**normalizeStep:**
- EXEC {tool: "delegate"} → auto-corrected to DELEGATE op
- tool_args fallback, no target → stays EXEC, passthrough for non-EXEC

**LOOKUP_MEMORY:**
- Query filtering, case-insensitive, non-string memory handling
- No memories → empty array, no match → empty array

**ASK_LLM:**
- Context passed when present, undefined when absent
- Empty ctx → undefined, out-of-range → undefined

### Prompt Builder (`test/core/prompt.test.js`) — 39 tests

- planSchema: type enum (plan, direct_response), 6 op types
- formatToolList: tool list formatting, empty list, required fields
- buildPlannerPrompt: system + user messages, response_format, memory section
- formatMemories, buildMemoryPrompt: memory formatting

### Assembly + Budget + History (`test/core/assembly.test.js`) — 108 tests

- measureMessages: token measurement for message arrays
- flattenHistory: turn → user/assistant message conversion
- fitHistory: history fitting within token budget (newest first)
- fitMemories: memory fitting with remaining budget
- buildIterationBlock: iteration context assembly (full/summarized)
- assemblePrompt integration: budget-based stepped fitting, assembly metadata
- Conversation history: rolling window, source filtering, truncation

### Agent Turn (`test/core/agent.test.js`) — 154 tests

**State Transition ADT:**
- beginTurn → turnState=working(input)
- finishSuccess → lastTurn=success, turnState=idle
- finishFailure → lastTurn=failure, turnState=idle
- Failure then success → lastTurn replaced with success

**Either-based Parsing/Validation:**
- safeJsonParse: valid JSON → Right, invalid → Left(PLANNER_PARSE)
- validatePlan: direct_response, plan, null, non-string message, empty steps, unknown type
- chain: safeJsonParse.chain(validatePlan) — short-circuits on parse failure

**Structural Validation:**
- Either.catch, Either.fold usage
- validateExecArgs: required field validation
- validateRefRange: RESPOND ref, ASK_LLM ctx range checks
- validateStepFull: Either Kleisli composition

**Invalid Plan Shapes (12 variants):**
- tool_calls, unknown type, plan without steps, empty steps, empty object, unrelated object
- null, number, array, direct_response without/null/numeric message

**Integration:**
- direct_response: normal response, turnState idle, lastResult stored
- Plan execution: Incremental Planning, iteration loops
- Conversation history: source=user only, truncation applied
- responseFormat: json_object
- JSON parse failure → finishFailure, parse error detail
- safeRunTurn: null state safe, state recovery
- createAgent: buildTurn injection, default fallback

---

## Phase 2: Real Integration

### LLM Client (`test/infra/llm.test.js`) — 20 tests

- chat: message passing, responseFormat, tools conversion
- tool_calls response: toolCalls array returned
- Errors: HTTP status codes, network failure, no choices
- Timeout: AbortController-based

### Production Interpreter (`test/interpreter/prod.test.js`) — 48 tests

- AskLLM: LLM chat call, responseFormat passing, context injection
- ExecuteTool: handler call, async handler, unknown tool → rejected
- Respond, Approve, UpdateState, GetState: basic behavior
- tool_calls: structure returned

**Delegate:**
- Local agent → DelegateResult.completed
- Unknown agent → DelegateResult.failed
- Local agent throws → failed (not interpreter exception)
- Remote agent completed → output returned (mock fetch)
- Remote agent network failure → failed
- Remote submitted → added to delegates.pending
- No agentRegistry → failed
- Integration: plan DELEGATE step → registry → local run → result

**Parallel:**
- allSettled: mixed success + failure → [{status, value/reason}]
- Empty array → []

### Traced Interpreter (`test/interpreter/traced.test.js`) — 14 tests

- Trace accumulation: tag, timestamp, duration
- Error: entry.error recorded
- Inner interpreter delegation

### Dry-run Interpreter (`test/interpreter/dryrun.test.js`) — 13 tests

- Stub returns, plan accumulation
- Per-op summary generation (dispatch object)
- Custom stub override

### Input Handler (`test/infra/input.test.js`) — 18 tests

- Line-by-line input: buffer → onLine callback
- Bracketed Paste Mode: paste start/end detection, onPaste callback
- flush: remaining buffer handling

### REPL (`test/core/repl.test.js`) — 28 tests

- Normal input → agent.run call, result returned
- /quit, /exit → running = false
- Agent error → onError, null returned
- /status → turnState, turn, lastTurn display
- /help → command list
- /tools → registered tool list
- /agents → registered agent list
- /todos → TODO list
- /events → queue + dead letter status
- COMMANDS export

---

## Phase 3: MCP + Tool Extensions

### Tool Registry (`test/infra/tools.test.js`) — 9 tests

- register/get/list: tool registration, lookup by name, full list
- Parameter schema validation

### MCP Integration (`test/infra/mcp.test.js`) — 40 tests

**extractContent:**
- Text extraction, multiple text joining, non-text notification, empty array, null

**ensureObjectSchema:**
- Valid → passthrough, non-object/null/undefined → fallback

**validateSchema → Either:**
- Valid → Right, null/non-object → Left

**connectMCPServer:**
- Tool name prefix ({serverName}_{toolName})
- Handler → callTool delegation, original name (without prefix) sent to server
- Schema fallback: non-object → object
- close: client + transport cleanup, idempotent
- connect/listTools failure → error propagation + cleanup

### Embedding (`test/infra/embedding.test.js`) — 26 tests

**Pure Functions:**
- dotSimilarity: identical/orthogonal/opposite vectors
- topK: top K items, returns all if insufficient
- toEmbeddingText: label + input + output, null skipped
- textHash: deterministic, different text → different hash
- mergeSearchResults: union, highest score first, overlaps take max

**createEmbedder:**
- Custom embedFn → direct use
- OpenAI provider: mock fetch, dimensions applied
- API error: status code included
- Unknown provider → throw

### Memory Graph (`test/infra/memory.test.js`) — 82 tests

- addNode, findNode (Maybe), addEdge, query (depth 1/2)
- recall: keyword matching, connected node expansion
- Tier management: getByTier, removeByTier, promoteNode
- removeNodes(predicate): node removal + orphan edge cleanup
- Persistence: lowdb save/restore, MemoryGraph.fromFile

**Embedding Integration:**
- embedPending: vector assignment, model/dimensions/timestamp/hash recorded
- Already embedded nodes skipped, hash mismatch → re-embed
- Embed failure → skip and continue
- Model/dimension change → re-embed, all identical → skip
- Dimension-mismatched vectors → excluded from search (NaN prevention)
- Hybrid recall: vector + keyword merge
- Recall without embedder → empty array
- Persistence roundtrip: add episodic → save → reload → recall

**Deduplication:**
- Conversation: same label hash → existing node updated
- Entity: label + data hash → existing returned
- Working tier: duplicates allowed
- Cross-tier: adding episodic to existing semantic → existing returned

### Memory Hook Integration (`test/infra/memory-hook.test.js`) — 18 tests

- Turn start → memory recall → context.memories injected
- Turn end → working memory cleared
- Turn end → episodic record added
- Failed turn → not saved to episodic, working cleared
- Success then failure → only success saved
- Promotion: 3+ mentions → episodic → semantic

---

## Phase 4: Heartbeat + Event Sources

### Event System (`test/infra/events.test.js`) — 43 tests

**createEventReceiver:**
- emit → added to queue, id/receivedAt auto-assigned
- Sequential emits → no loss, order preserved
- Custom id preserved

**wireEventHooks:**
- On idle: process queue head → agent.run call
- While working → queued
- agent.run failure → deadLetter (error + stack trace)

**wireTodoHooks:**
- event.todo present → TODO created (sourceEventId)
- event.todo absent → not created
- Idempotency: same event reprocessed → no duplicates

**Pure Functions:**
- withEventMeta: id, receivedAt assigned, existing id preserved
- eventToPrompt: prompt > message > type fallback
- todoFromEvent: Maybe — Just(todo) / Nothing
- isDuplicate: sourceEventId comparison

### Heartbeat (`test/infra/heartbeat.test.js`) — 19 tests

- start → emit called, type=heartbeat, prompt passed
- stop → no more emits
- Duplicate start prevention
- emit error → onError, continues running
- setTimeout self-scheduling → no nesting
- Coalesce: unprocessed heartbeat in queue → skip
- Queue cleared → resume emitting
- Different event types in queue → no heartbeat impact
- inFlight heartbeat → skip
- inFlight different type → no impact

---

## Phase 5: Multi-Agent + A2A

### Agent Registry (`test/infra/agent-registry.test.js`) — 27 tests

**DelegateResult Shape:**
- completed: mode, target, status, output
- submitted: taskId, output null
- failed: error message, mode null

**Registry:**
- register + get → Maybe(entry)
- get unknown → Nothing
- list, has
- Remote agent: type, endpoint
- Local agent: run function call

### A2A Client (`test/infra/a2a-client.test.js`) — 50 tests

**Pure Functions:**
- extractArtifactText: text extraction, null/empty array, non-text
- buildTaskSendRequest: JSON-RPC 2.0, message/send method
- buildTaskGetRequest: tasks/get method
- responseToResult: completed/submitted/working/failed/rpc error/invalid

**sendA2ATask:**
- Completed immediate return, submitted taskId, HTTP error, network error, JSON-RPC error
- Request format: endpoint, jsonrpc 2.0, method, task text

**getA2ATaskStatus:**
- completed → output, network error → failed

**wireDelegatePolling:**
- On idle: poll pending → completed → emit + remove from pending
- Still working → pending preserved
- Periodic timer: first tick working → second tick completed → emit
- Polling guard: concurrent execution prevention

### Local Tools (`test/infra/local-tools.test.js`) — 26 tests

**Path Validation:**
- isPathAllowed: empty list → allowed, inside → allowed, outside → denied
- Sibling-prefix bypass prevention (/tmp/project-evil)
- Exact directory matching

**Per-tool:**
- file_read: content reading, missing file → error, access denied → error
- file_write: write + read verification, access denied
- file_list: file/directory distinction, missing path
- web_fetch: handler exists, url required
- shell_exec: stdout capture, failed command → error
- calculate: expression evaluation

**Metadata:**
- 6 tools registered, required fields present
- file_write, shell_exec descriptions mention APPROVE

---

## Phase 6: Terminal UI (Ink)

### UI Components (`test/ui/app.test.js`) — 143 tests

- StatusBar: status/turn/memoryCount rendering, error state
- ChatArea: user/agent messages, tags, empty list
- SidePanel: agent list, state display
- MarkdownText: markdown rendering
- PlanView: plan step visualization
- ToolResultView: tool result display
- deriveStatus selector: working/error/idle determination
- deriveMemoryCount selector: array length, 0 if absent

### Interactive UI (`test/ui/interactive.test.js`) — 29 tests

- StatusBar: idle/working state rendering, activity text, visibility flags
- ChatArea: message display
- App component: full app rendering + state integration

### History Compaction (`test/core/compaction.test.js`) — 91 tests

**Pure Functions:**
- extractForCompaction: threshold/keep-based splitting, boundary conditions
- buildCompactionPrompt: with/without previous summary, system message branching
- createSummaryEntry: summary marker, timestamp, random suffix
- migrateHistoryIds: legacy entry ID assignment

**Integration:**
- Placeholder insertion → async summarization → replacement
- Epoch-based /clear collision prevention
- Rolling window: MAX_HISTORY ceiling maintained
- Summary failure: placeholder removed, remaining preserved

---

## Integration Tests

### Phase 5 Integration (`test/integration/phase5.test.js`) — 23 tests

**Heartbeat → Event → Agent:**
- heartbeat emit → event hook → agent.run call, correct prompt
- Events queued while working → processed after idle

**Plan DELEGATE → Registry → Local Agent:**
- Planner DELEGATE step → registry lookup → local run → result
- Failed delegate → included in plan results

**Parallel:**
- Multiple Free programs executed in parallel

**Event FIFO:**
- 3 events → one processed per idle transition, in order

**deadLetter:**
- agent.run failure → error recorded, original event preserved

---

## Infrastructure

### Config (`test/infra/config.test.js`) — 44 tests

- mergeConfig: nested merge, array replacement, empty override → defaults
- readConfigFile: missing file → {}, valid JSON → parsed, invalid JSON → {} + warning
- loadInstanceConfig: instanceId required, no files → defaults, 3-layer merge chain (DEFAULTS → server.json → instances/{id}.json → env)
- loadInstancesFile: required file, Zod validation, empty instances array → error
- loadClientConfig: required file, Zod validation, default locale
- env override: PRESENCE_MAX_RETRIES, PRESENCE_TIMEOUT_MS, non-numeric ignored

### Auth UserStore (`test/infra/auth-user-store.test.js`) — 39 tests

- addUser: first user admin, duplicate rejected, password < 8 chars rejected, invalid username rejected
- verifyPassword: correct/incorrect/nonexistent user
- findUser/listUsers: lookup, passwordHash not exposed
- removeUser: removed, nonexistent throws
- changePassword: tokenVersion bump, refreshSessions cleared, new password works
- refreshSessions: add/check/remove/revokeAll (theft detection)

### Auth Token (`test/infra/auth-token.test.js`) — 41 tests

- sign/verify: valid token, wrong secret, expired, wrong iss/aud
- Edge cases: null, undefined, empty string, 4-part string
- secret.json: auto-generated, file permissions 0600, idempotent
- TokenService: access token (sub, roles, iss, aud, exp), refresh token (jti, tokenVersion, type)
- Cross-instance: token from instance A rejected by instance B
- PRESENCE_JWT_SECRET env override

### Auth Provider (`test/infra/auth-provider.test.js`) — 24 tests

- authenticate: success, wrong password, nonexistent user (timing attack prevention)
- Null/empty input handling
- tokenVersion change after password update
- Refresh token rotation full flow: login → refresh → revoke old jti → replay revoked jti → theft detection

### Auth E2E (`test/server/auth-e2e.test.js`) — 38 tests (network)

- AE1-AE3: unauthenticated 401, login success (accessToken + HttpOnly cookie), login failure (user existence hidden)
- AE4-AE6: authenticated requests OK, invalid token 401, expired token 401
- AE7-AE9: refresh rotation + new token, revoked jti theft detection, password change → refresh 401
- AE10-AE12: logout (cookie expired + jti revoked), /api/instance authRequired, rate limiting 429
- AE13-AE14: WS unauthenticated 4001 close, WS authenticated init received

### Persistence (`test/infra/persistence.test.js`) — 15 tests

- save → restore: data preserved
- Empty restore → null
- Debounce: only last value saved
- connectToState: auto-save on state change
- try-catch wrapping: crash prevention on I/O failure

### Persona (`test/infra/persona.test.js`) — 13 tests

- Default merging, save/restore, tool filtering

### Logger (`test/infra/logger.test.js`) — 8 tests

- info/warn/error levels, config changes

---

## Regression Tests

### LLM Malformed Output (`test/regression/llm-output.test.js`) — 70 tests

- Invalid JSON: trailing text, structural errors, incomplete JSON
- Agent handles malformed responses gracefully (no crashes)
- extractJson: removes text before JSON (`<think>` tags, etc.)

### Tool Handler Defense (`test/regression/tool-defense.test.js`) — 34 tests

- All tool handlers tested with null, undefined, empty string, wrong types
- Proper error throws confirmed (no crashes)

### Plan Fuzz (`test/regression/plan-fuzz.test.js`) — 57 tests

- validatePlan: random plan structures → always returns Either (no throws)
- safeJsonParse: any input → returns Either (no throws)

### E2E Scenario (`test/regression/e2e-scenario.test.js`) — 62 tests

- Path normalization: absolute path → allowed-directory-relative
- Full agent pipeline: planner → parse → validate → (retry) → execute → finish
- Various scenarios: file read, shell command, multi-step, approval, delegation

---

## Orchestrator

### ChildManager (`test/orchestrator/child-manager.test.js`) — 11 tests

- createChildManager: API interface (forkInstance, stopInstance, restartInstance, getStatus, listStatus, shutdownAll)
- listStatus: initially empty array
- getStatus: nonexistent instance → null
- stopInstance/restartInstance: nonexistent instance → no-op / null

### Orchestrator E2E (`test/orchestrator/orchestrator-e2e.test.js`) — 33 tests (network)

**Infrastructure (OE1-OE3):** orchestrator start → management API, instance fork → health endpoint

**Management API (OE4-OE6):** multi-instance list, stop/start lifecycle, restart

**Isolation (OE7-OE9):** parallel chat → independent responses, config separation (different models), disabled instance not forked

**WebSocket (OE10):** direct WS connection → init message

---

## Multi-Instance Live Tests

### Multi-Instance Live E2E (`test/e2e/multi-instance-live.test.js`) — 86 tests (manual)

> Real LLM + real orchestrator. Run `npm start` first, then execute separately.

**Infrastructure (ML1-ML3):** management API, health (uptime), config separation (apiKey hidden)

**Chat + Tools (ML4-ML6):** real LLM response, file_list tool execution, multi-turn context retention

**Isolation (ML7-ML9):** cross-instance isolation, independent history, cross-session isolation

**Concurrency (ML10-ML11):** parallel chat across instances, parallel chat within same instance different sessions

**Slash Commands (ML12-ML14):** /tools, /status per-instance, /clear isolation

**WebSocket (ML15-ML17):** init, state push (turn + turnState), multi-client

**Session CRUD (ML18-ML19):** create/chat/delete lifecycle, 404 after delete

**Error/Boundary (ML20-ML23):** empty input 400, malformed JSON → error + instance healthy, nonexistent instance 404, idle recovery after complex input

**Operations (ML24-ML25):** orchestrator restart API → service recovery, chat works after restart
