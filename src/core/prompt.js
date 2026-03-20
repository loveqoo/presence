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
const ROLE_DEFINITION = `당신은 업무 대리 에이전트의 계획 설계자입니다.
사용자의 요청을 분석하고, JSON 형식으로 실행 계획을 작성하세요.

- 도구 호출, 정보 조회 등이 필요하면 type: "plan"으로 steps를 작성하세요.
- 단순 대화 (인사, 간단한 질문 등)에는 type: "direct_response"로 바로 답하세요.`

const OP_REFERENCE = `사용 가능한 op:

LOOKUP_MEMORY: 메모리에서 관련 정보를 조회
  args: { query: "검색어" }

ASK_LLM: LLM에게 질문 (이전 단계 결과 참조 가능)
  args: { prompt: "질문", ctx: [1, 2] }
  ctx의 숫자는 이전 step의 1-based 인덱스

EXEC: 도구 실행
  args: { tool: "도구이름", tool_args: { ... } }

RESPOND: 사용자에게 응답 (이전 단계 결과 참조)
  args: { ref: 3 }
  반드시 계획의 마지막에 포함

APPROVE: 사용자 승인 요청
  args: { description: "승인 요청 설명" }

DELEGATE: 다른 에이전트에게 위임
  args: { target: "에이전트id", task: "작업 내용" }`

const APPROVE_RULES = `다음 행동 전에는 반드시 APPROVE를 넣으세요:
- 외부에 데이터를 쓰는 행동 (메시지 발송, 이슈 생성 등)
- 되돌리기 어려운 행동 (삭제, 상태 변경 등)
읽기 전용 행동에는 APPROVE가 필요 없습니다.`

const PLAN_RULES = `규칙:
1. plan의 마지막 step은 반드시 RESPOND여야 합니다.
2. 사용 가능한 도구와 에이전트만 사용하세요.
3. ctx와 ref의 숫자는 해당 step보다 앞선 step의 인덱스(1-based)여야 합니다.
4. EXEC의 tool_args 안에서 이전 결과를 참조할 때는 "$N" 문자열을 사용합니다.`

// --- Formatters ---
const formatToolList = (tools) => {
  if (!tools || tools.length === 0) {
    return '사용 가능한 도구:\n\n사용 가능한 도구 없음'
  }
  const lines = tools.map(t => {
    const params = t.parameters?.properties || {}
    const required = t.parameters?.required || []
    const paramLines = Object.entries(params).map(([k, v]) => {
      const req = required.includes(k) ? ', 필수' : ''
      return `  - ${k} (${v.type}${req}): ${v.description || ''}`
    }).join('\n')
    return `${t.name}: ${t.description || ''}\n${paramLines}`
  })
  return `사용 가능한 도구:\n\n${lines.join('\n\n')}`
}

const formatAgentList = (agents) => {
  if (!agents || agents.length === 0) return ''
  const lines = agents.map(a => `${a.id}: ${a.description || ''}`)
  return `위임 가능한 에이전트:\n\n${lines.join('\n')}`
}

const formatMemories = (memories) => {
  if (!memories || memories.length === 0) return ''
  return memories.map((m, i) => `[${i + 1}] ${typeof m === 'string' ? m : JSON.stringify(m)}`).join('\n')
}

// --- Prompt builders ---
const buildPlannerPrompt = ({ tools = [], agents = [], memories = [], input, persona = {} }) => {
  const sections = [
    persona.systemPrompt || ROLE_DEFINITION,
    OP_REFERENCE,
    formatToolList(tools),
  ]

  const agentSection = formatAgentList(agents)
  if (agentSection) sections.push(agentSection)

  if (persona.rules && persona.rules.length > 0) {
    sections.push('사용자 규칙:\n' + persona.rules.map(r => `- ${r}`).join('\n'))
  }

  sections.push(APPROVE_RULES)
  sections.push(PLAN_RULES)

  if (memories.length > 0) {
    sections.push(`관련 기억:\n${formatMemories(memories)}`)
  }

  return {
    messages: [
      { role: 'system', content: sections.join('\n\n') },
      { role: 'user', content: input },
    ],
    response_format: { type: 'json_schema', json_schema: planSchema },
  }
}

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
  formatToolList,
  formatAgentList,
  formatMemories,
  ROLE_DEFINITION,
  OP_REFERENCE,
  APPROVE_RULES,
  PLAN_RULES,
}
