import { measureMessages as measureTokens, estimateTokens } from '../lib/tokenizer.js'
import { PROMPT as PROMPT_POLICY } from './policies.js'

// --- Plan JSON Schema ---
const planSchema = {
  name: 'agent_plan',
  strict: true,
  schema: {
    type: 'object',
    required: ['type'],
    properties: {
      type: {
        type: 'string',
        enum: ['plan', 'direct_response'],
        description: '계획 실행이 필요하면 plan, 단순 대화면 direct_response',
      },
      message: {
        type: 'string',
        description: 'direct_response일 때의 응답 메시지',
      },
      steps: {
        type: 'array',
        description: 'plan일 때의 실행 단계들',
        items: {
          type: 'object',
          required: ['op'],
          properties: {
            op: {
              type: 'string',
              enum: ['LOOKUP_MEMORY', 'ASK_LLM', 'EXEC', 'RESPOND', 'APPROVE', 'DELEGATE'],
            },
            args: {
              type: 'object',
              description: 'Op별 인자',
              properties: {
                query:       { type: 'string' },
                prompt:      { type: 'string' },
                ctx:         { type: 'array', items: { type: 'integer' } },
                tool:        { type: 'string' },
                tool_args:   { type: 'object' },
                ref:         { type: 'integer' },
                description: { type: 'string' },
                target:      { type: 'string' },
                task:        { type: 'string' },
                message:     { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

// --- Prompt text constants ---
const ROLE_DEFINITION = `You are a planner for a task-delegation agent.
Analyze the user's request and respond with ONLY valid JSON. No explanation text, ONLY JSON.

## Response Format

If you can answer directly:
{"type": "direct_response", "message": "your response here"}

If you need to use tools to gather information:
{"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "tool_name", "tool_args": {}}}]}

To pass a step result directly to the user (fast exit):
{"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "tool_name", "tool_args": {}}}, {"op": "RESPOND", "args": {"ref": 1}}]}

## Iteration

You may receive results from previous steps. Based on those results:
- If you can now answer the user, use direct_response (preferred).
- If you need more information, return another plan without RESPOND.

## Examples

User: "hello"
→ {"type": "direct_response", "message": "Hello! How can I help you?"}

User: "what files are in src?"
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "file_list", "tool_args": {"path": "src"}}}]}
(After receiving results) → {"type": "direct_response", "message": "The src directory contains: agent.js, plan.js, ..."}

User: "read package.json"
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "file_read", "tool_args": {"path": "package.json"}}}, {"op": "RESPOND", "args": {"ref": 1}}]}
RESPOND is used here because the user wants the raw file content — no processing needed.

User: "read package.json and tell me the project name and version"
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "file_read", "tool_args": {"path": "package.json"}}}]}
(After receiving results) → {"type": "direct_response", "message": "Project: presence, version: 0.1.0"}
Do NOT use RESPOND here. The user wants a summary, not raw content. Return a plan WITHOUT RESPOND, then use direct_response after seeing the results.

User: "show the first 10 lines of src/main.js"
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "file_read", "tool_args": {"path": "src/main.js", "maxLines": 10}}}, {"op": "RESPOND", "args": {"ref": 1}}]}

IMPORTANT:
- All string values MUST be double-quoted (including op values)
- Use "message" field (NOT "content")
- RESPOND ref must reference a PREVIOUS step index (1-based)
- Respond in the user's language.`

const OP_REFERENCE = `Available ops:

LOOKUP_MEMORY: Search memory for relevant information
  args: { "query": "search term" }

ASK_LLM: Ask LLM a question (can reference previous step results)
  args: { "prompt": "question", "ctx": [1, 2] }
  ctx numbers are 1-based indices of previous steps

EXEC: Execute a tool
  args: { "tool": "tool_name", "tool_args": { ... } }

RESPOND: Send response to user (reference a previous step result)
  args: { "ref": 1 }
  Optional fast exit — passes step result directly to user

APPROVE: Request user approval
  args: { "description": "what needs approval" }

DELEGATE: Delegate to another agent
  args: { "target": "agent_id", "task": "task description" }`

const APPROVE_RULES = `Add APPROVE before any:
- file_write (creating/overwriting files)
- shell_exec (executing shell commands)
- Write operations (sending messages, creating issues)
- Irreversible actions (deletions, state changes)
Read-only actions (file_read, file_list, web_fetch) do NOT need APPROVE.`

const PLAN_RULES = `Rules:
1. If you have enough information to answer, use direct_response. This is the preferred way to respond.
2. If you need more data, return a plan WITHOUT RESPOND. Steps will execute and results will be shown to you in the next iteration.
3. RESPOND is optional — use it only to pass a step result directly to the user as a fast exit. If included, it must be the LAST step.
4. Only use available tools and agents.
5. ref and ctx numbers must reference EARLIER steps only (1-based). Cannot reference self or later steps.
6. Use "$N" strings in tool_args to reference previous step results.
7. ALWAYS use tools for real-time data. NEVER answer from memory for file/command requests.
8. Every EXEC tool_args MUST include all required parameters. Check each tool's required fields.
9. Do NOT use RESPOND to pass raw intermediate results. If the user's request requires further processing (calculation, summarization, comparison), continue planning instead of ending early with RESPOND.`

// --- Formatters ---
const formatToolList = (tools) => {
  if (!tools || tools.length === 0) {
    return 'Available tools:\n\nNo tools available'
  }
  const lines = tools.map(t => {
    const params = t.parameters?.properties || {}
    const required = t.parameters?.required || []
    const paramLines = Object.entries(params).map(([k, v]) => {
      const req = required.includes(k) ? ', required' : ''
      return `  - ${k} (${v.type}${req}): ${v.description || ''}`
    }).join('\n')
    return `${t.name}: ${t.description || ''}\n${paramLines}`
  })
  return `Available tools:\n\n${lines.join('\n\n')}`
}

const formatAgentList = (agents) => {
  if (!agents || agents.length === 0) return ''
  const lines = agents.map(a => `${a.name || a.id}: ${a.description || ''}`)
  return `Available agents for delegation:\n\n${lines.join('\n')}`
}

const formatMemories = (memories) => {
  if (!memories || memories.length === 0) return ''
  return memories.map((m, i) => `[${i + 1}] ${typeof m === 'string' ? m : JSON.stringify(m)}`).join('\n')
}

// 공통 메모리 프롬프트 (Plan, ReAct 양쪽에서 사용)
const buildMemoryPrompt = (memories) => {
  if (!memories || memories.length === 0) return ''
  return `Relevant memories:\n${formatMemories(memories)}`
}

// --- Result summarization (rolling context) ---

const summarizeResults = (results) =>
  (Array.isArray(results) ? results : [results])
    .map((r, i) => {
      const text = typeof r === 'string' ? r : JSON.stringify(r)
      return `[Step ${i + 1}] ${text.length > PROMPT_POLICY.RESULT_MAX_LEN ? text.slice(0, PROMPT_POLICY.RESULT_MAX_LEN) + '...(truncated)' : text}`
    }).join('\n')

// --- Budget helpers ---

const measureMessages = measureTokens

const flattenHistory = (turns) =>
  turns.flatMap(t => [
    { role: 'user', content: t.input },
    { role: 'assistant', content: t.output },
  ])

const fitHistory = (turns, charBudget) => {
  const fitted = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = measureMessages(flattenHistory([turns[i]]))
    if (used + cost > charBudget) break
    fitted.unshift(turns[i])
    used += cost
  }
  return fitted
}

// Cost of adding memories to system message (token 기반)
const MEMORY_PROMPT_OVERHEAD = estimateTokens('\n\nRelevant memories:\n')

const fitMemories = (memories, tokenBudget) => {
  if (!memories || memories.length === 0) return []
  if (tokenBudget <= MEMORY_PROMPT_OVERHEAD) return []
  const fitted = []
  let used = MEMORY_PROMPT_OVERHEAD
  for (let i = 0; i < memories.length; i++) {
    const m = memories[i]
    const text = typeof m === 'string' ? m : JSON.stringify(m)
    const formatted = `[${fitted.length + 1}] ${text}`
    const cost = estimateTokens(formatted) + 1
    if (used + cost > tokenBudget) break
    fitted.push(m)
    used += cost
  }
  return fitted
}

// --- Iteration context block ---


const buildIterationBlock = (iterationContext, mode = 'full') => {
  if (!iterationContext?.previousPlan || iterationContext.previousResults == null) return []

  const planJson = JSON.stringify(iterationContext.previousPlan)
  let results = iterationContext.previousResults

  if (mode === 'summarized' && results.length > PROMPT_POLICY.SUMMARIZED_RESULT_MAX_LEN) {
    results = results.slice(0, PROMPT_POLICY.SUMMARIZED_RESULT_MAX_LEN) + '...(summarized)'
  }

  return [
    { role: 'assistant', content: planJson },
    { role: 'user', content: `Step results:\n${results}\n\nBased on these results, continue or provide a final answer using direct_response.` },
  ]
}

// --- Prompt assembly with budget ---

const assemblePrompt = ({
  persona = {}, tools = [], agents = [], history = [],
  memories = [], input, iterationContext, budget,
  responseFormatMode = 'json_object',
}) => {
  const effectiveBudget = budget || { maxContextChars: Infinity, reservedOutputChars: 0 }
  const usable = effectiveBudget.maxContextChars - effectiveBudget.reservedOutputChars

  // 1. Fixed system sections (same order as original)
  const fixedSections = [
    persona.systemPrompt || ROLE_DEFINITION,
    OP_REFERENCE,
    formatToolList(tools),
    formatAgentList(agents),
    persona.rules && persona.rules.length > 0
      ? 'User rules:\n' + persona.rules.map(r => `- ${r}`).join('\n')
      : '',
    APPROVE_RULES,
    PLAN_RULES,
  ].filter(Boolean)
  const fixedSystemText = fixedSections.join('\n\n')

  const inputText = input
  let iterBlock = buildIterationBlock(iterationContext)

  // 2. Fixed cost + fallback — measureMessages consistently for accurate overhead
  let fixedCost = measureMessages([
    { role: 'system', content: fixedSystemText },
    { role: 'user', content: inputText },
    ...iterBlock,
  ])
  let remaining = usable - fixedCost

  if (remaining < 0 && iterationContext) {
    iterBlock = buildIterationBlock(iterationContext, 'summarized')
    fixedCost = measureMessages([
      { role: 'system', content: fixedSystemText },
      { role: 'user', content: inputText },
      ...iterBlock,
    ])
    remaining = usable - fixedCost
  }
  if (remaining < 0) remaining = 0

  // 3. Stepped fitting
  const fittedHistory = fitHistory(history, remaining)
  remaining -= measureMessages(flattenHistory(fittedHistory))

  const fittedMemories = fitMemories(memories, Math.max(0, remaining))

  // 4. Final system message
  const systemContent = [
    fixedSystemText,
    fittedMemories.length > 0 ? buildMemoryPrompt(fittedMemories) : '',
  ].filter(Boolean).join('\n\n')

  // 5. Assemble messages
  const messages = [
    { role: 'system', content: systemContent },
    ...flattenHistory(fittedHistory),
    { role: 'user', content: inputText },
    ...iterBlock,
  ]

  return {
    messages,
    response_format: buildResponseFormat(responseFormatMode),
    _assembly: {
      budget: usable,
      used: measureMessages(messages),
      historyUsed: fittedHistory.length,
      historyDropped: history.length - fittedHistory.length,
      memoriesUsed: fittedMemories.length,
    },
  }
}

// --- Prompt builders ---
// responseFormat 모드: 'json_schema' | 'json_object' | 'none'
const buildResponseFormat = (mode) => {
  if (mode === 'json_schema') return { type: 'json_schema', json_schema: planSchema }
  if (mode === 'json_object') return { type: 'json_object' }
  return undefined
}

const buildIterationPrompt = ({ tools = [], agents = [], memories = [], input, persona = {}, responseFormatMode = 'json_object', previousPlan = null, previousResults = null }) =>
  assemblePrompt({
    persona,
    tools,
    agents,
    memories,
    history: [],
    input,
    iterationContext: previousPlan && previousResults != null
      ? { previousPlan, previousResults }
      : null,
    responseFormatMode,
  })

const buildRetryPrompt = (originalPrompt, errorMessage) => ({
  messages: [
    ...originalPrompt.messages,
    { role: 'assistant', content: '(invalid JSON)' },
    { role: 'user', content: `Your previous response was not valid JSON. Error: ${errorMessage}\nPlease respond with ONLY valid JSON. No explanation, no markdown, ONLY the JSON object.` },
  ],
  response_format: originalPrompt.response_format,
})

export {
  planSchema,
  assemblePrompt,
  buildIterationPrompt,
  buildResponseFormat,
  buildRetryPrompt,
  summarizeResults,
  measureMessages,
  flattenHistory,
  fitHistory,
  fitMemories,
  buildIterationBlock,
  formatToolList,
  formatAgentList,
  formatMemories,
  buildMemoryPrompt,
  ROLE_DEFINITION,
  OP_REFERENCE,
  APPROVE_RULES,
  PLAN_RULES,
}
