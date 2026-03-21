import {
  buildPlannerPrompt, buildFormatterPrompt,
  formatToolList, formatAgentList, formatMemories,
  planSchema,
} from '../../src/core/prompt.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) { passed++; console.log(`  ✓ ${msg}`) }
  else { failed++; console.error(`  ✗ ${msg}`) }
}

console.log('Prompt builder tests')

// 1. formatToolList: 0 tools
{
  const result = formatToolList([])
  assert(result.includes('No tools available'), 'formatToolList: 0 tools shows empty')
}

// 2. formatToolList: 2 tools
{
  const tools = [
    { name: 'github_list_prs', description: 'PR 목록 조회', parameters: {
      type: 'object', required: ['repo'],
      properties: { repo: { type: 'string', description: '저장소' }, state: { type: 'string' } }
    }},
    { name: 'slack_send', description: '슬랙 발송', parameters: {
      type: 'object', required: ['channel'],
      properties: { channel: { type: 'string', description: '채널' } }
    }},
  ]
  const result = formatToolList(tools)
  assert(result.includes('github_list_prs'), 'formatToolList: includes first tool')
  assert(result.includes('slack_send'), 'formatToolList: includes second tool')
  assert(result.includes('required'), 'formatToolList: marks required params')
}

// 3. formatMemories: 0 memories
{
  const result = formatMemories([])
  assert(result === '', 'formatMemories: 0 → empty string')
}

// 4. formatMemories: 3 memories
{
  const result = formatMemories(['mem1', 'mem2', 'mem3'])
  assert(result.includes('[1] mem1'), 'formatMemories: includes [1]')
  assert(result.includes('[3] mem3'), 'formatMemories: includes [3]')
}

// 5. formatAgentList: 0 agents
{
  const result = formatAgentList([])
  assert(result === '', 'formatAgentList: 0 → empty')
}

// 6. formatAgentList: with agents
{
  const result = formatAgentList([{ id: 'backend', description: '백엔드 팀' }])
  assert(result.includes('backend'), 'formatAgentList: includes agent id')
}

// 7. buildPlannerPrompt: basic structure
{
  const prompt = buildPlannerPrompt({ tools: [], agents: [], memories: [], input: '안녕' })
  assert(prompt.messages.length === 2, 'plannerPrompt: 2 messages (system + user)')
  assert(prompt.messages[0].role === 'system', 'plannerPrompt: first is system')
  assert(prompt.messages[1].role === 'user', 'plannerPrompt: second is user')
  assert(prompt.messages[1].content === '안녕', 'plannerPrompt: user content is input')
  assert(prompt.response_format.type === 'json_object', 'plannerPrompt: response_format is json_object')
}

// 8. buildPlannerPrompt: with memories
{
  const prompt = buildPlannerPrompt({ tools: [], memories: ['past event'], input: 'test' })
  assert(prompt.messages[0].content.includes('Relevant memories'), 'plannerPrompt: includes memory section')
  assert(prompt.messages[0].content.includes('past event'), 'plannerPrompt: includes memory content')
}

// 9. buildPlannerPrompt: without memories, no memory section
{
  const prompt = buildPlannerPrompt({ tools: [], memories: [], input: 'test' })
  assert(!prompt.messages[0].content.includes('Relevant memories'), 'plannerPrompt: no memory section when empty')
}

// 10. buildPlannerPrompt: persona support
{
  const prompt = buildPlannerPrompt({
    tools: [], memories: [], input: 'test',
    persona: {
      systemPrompt: '나는 커스텀 에이전트다.',
      rules: ['한국어로 답해', '보안 우선'],
    }
  })
  assert(prompt.messages[0].content.includes('나는 커스텀 에이전트다'), 'plannerPrompt: custom systemPrompt')
  assert(prompt.messages[0].content.includes('한국어로 답해'), 'plannerPrompt: persona rules included')
}

// 11. buildFormatterPrompt
{
  const prompt = buildFormatterPrompt('PR 알려줘', ['PR 3건', '이슈 2건'])
  assert(prompt.messages.length === 2, 'formatterPrompt: 2 messages')
  assert(prompt.messages[1].content.includes('PR 알려줘'), 'formatterPrompt: includes original input')
  assert(prompt.messages[1].content.includes('[Step 1]'), 'formatterPrompt: includes step results')
}

// 12. planSchema has correct structure
{
  assert(planSchema.name === 'agent_plan', 'planSchema: name is agent_plan')
  assert(planSchema.strict === true, 'planSchema: strict mode')
  const props = planSchema.schema.properties
  assert(props.type.enum.includes('plan'), 'planSchema: type enum has plan')
  assert(props.type.enum.includes('direct_response'), 'planSchema: type enum has direct_response')
  assert(props.steps.items.properties.op.enum.length === 6, 'planSchema: 6 op types')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
