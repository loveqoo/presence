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

Simple conversation (greetings, Q&A):
{"type": "direct_response", "message": "your response here"}

When tool execution is needed:
{"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "tool_name", "tool_args": {}}}, {"op": "RESPOND", "args": {"ref": 1}}]}

## Examples

User: "hello"
→ {"type": "direct_response", "message": "Hello! How can I help you?"}

User: "what time is it?" (get_time tool available)
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "get_time", "tool_args": {}}}, {"op": "RESPOND", "args": {"ref": 1}}]}

User: "calculate 123 * 456" (calculate tool available)
→ {"type": "plan", "steps": [{"op": "EXEC", "args": {"tool": "calculate", "tool_args": {"expression": "123 * 456"}}}, {"op": "RESPOND", "args": {"ref": 1}}]}

IMPORTANT:
- All string values MUST be double-quoted (including op values)
- Use "message" field (NOT "content")
- RESPOND ref must reference a PREVIOUS step index (1-based). With 2 steps, ref can only be 1.
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
  Must be the last step in a plan

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
1. The last step in a plan MUST be {"op": "RESPOND", "args": {"ref": N}}.
2. Only use available tools and agents.
3. ref and ctx numbers must reference EARLIER steps only (1-based). Cannot reference self or later steps.
4. Use "$N" strings in tool_args to reference previous step results.
5. For general questions that don't need tools, use direct_response instead of plan.
6. ALWAYS use tools for real-time data. When user asks to read/show/list files, execute commands, or fetch URLs, ALWAYS use the appropriate tool. NEVER answer from memory for these requests — file contents and system state can change.
7. Every EXEC tool_args MUST include all required parameters. Check each tool's required fields.
8. To explore files, start with file_list to get the listing, then use ASK_LLM with ctx to analyze the results.`

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

// --- Prompt builders ---
// responseFormat 모드: 'json_schema' | 'json_object' | 'none'
const buildResponseFormat = (mode) => {
  if (mode === 'json_schema') return { type: 'json_schema', json_schema: planSchema }
  if (mode === 'json_object') return { type: 'json_object' }
  return undefined
}

const buildPlannerPrompt = ({ tools = [], agents = [], memories = [], input, persona = {}, responseFormatMode = 'json_object' }) => {
  const sections = [
    persona.systemPrompt || ROLE_DEFINITION,
    OP_REFERENCE,
    formatToolList(tools),
    formatAgentList(agents),
    persona.rules && persona.rules.length > 0
      ? 'User rules:\n' + persona.rules.map(r => `- ${r}`).join('\n')
      : '',
    APPROVE_RULES,
    PLAN_RULES,
    buildMemoryPrompt(memories),
  ].filter(Boolean)

  return {
    messages: [
      { role: 'system', content: sections.join('\n\n') },
      { role: 'user', content: input },
    ],
    response_format: buildResponseFormat(responseFormatMode),
  }
}

const buildRetryPrompt = (originalPrompt, errorMessage) => ({
  messages: [
    ...originalPrompt.messages,
    { role: 'assistant', content: '(invalid JSON)' },
    { role: 'user', content: `Your previous response was not valid JSON. Error: ${errorMessage}\nPlease respond with ONLY valid JSON. No explanation, no markdown, ONLY the JSON object.` },
  ],
  response_format: originalPrompt.response_format,
})

const buildFormatterPrompt = (input, results) => {
  const resultText = Array.isArray(results)
    ? results.map((r, i) => `[Step ${i + 1}] ${typeof r === 'string' ? r : JSON.stringify(r)}`).join('\n')
    : String(results)

  return {
    messages: [
      { role: 'system', content: '사용자의 원래 요청과 실행 결과를 바탕으로, 사용자에게 전달할 자연어 응답을 작성하세요. 간결하고 명확하게 답하세요.' },
      { role: 'user', content: `원래 요청: ${input}\n\n실행 결과:\n${resultText}` },
    ],
  }
}

export {
  planSchema,
  buildPlannerPrompt,
  buildFormatterPrompt,
  buildResponseFormat,
  buildRetryPrompt,
  formatToolList,
  formatAgentList,
  formatMemories,
  buildMemoryPrompt,
  ROLE_DEFINITION,
  OP_REFERENCE,
  APPROVE_RULES,
  PLAN_RULES,
}
