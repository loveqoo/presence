import { buildIterationPrompt } from '@presence/core/core/prompt/assembly.js'
import { flattenHistory, fitHistory } from '@presence/core/core/prompt/budget.js'
import { formatToolList, formatAgentList, formatMemories } from '@presence/core/core/prompt/formatters.js'
import { summarizeResults } from '@presence/core/core/plan-executor.js'
import { planSchema } from '@presence/core/core/prompt/schema.js'
import { PROMPT_SECTIONS } from '@presence/core/core/prompt/sections.js'
import { HISTORY_ENTRY_TYPE } from '@presence/core/core/policies.js'

import { assert, summary } from '../../../../test/lib/assert.js'

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

// 7. buildIterationPrompt: basic structure
{
  const prompt = buildIterationPrompt({ tools: [], agents: [], memories: [], input: '안녕' })
  assert(prompt.messages.length === 2, 'iterationPrompt: 2 messages (system + user)')
  assert(prompt.messages[0].role === 'system', 'iterationPrompt: first is system')
  assert(prompt.messages[1].role === 'user', 'iterationPrompt: second is user')
  assert(prompt.messages[1].content === '안녕', 'iterationPrompt: user content is input')
  assert(prompt.response_format.type === 'json_object', 'iterationPrompt: response_format is json_object')
}

// 8. buildIterationPrompt: with memories
{
  const prompt = buildIterationPrompt({ tools: [], memories: ['past event'], input: 'test' })
  assert(prompt.messages[0].content.includes('Relevant memories'), 'iterationPrompt: includes memory section')
  assert(prompt.messages[0].content.includes('past event'), 'iterationPrompt: includes memory content')
}

// 9. buildIterationPrompt: without memories, no memory section
{
  const prompt = buildIterationPrompt({ tools: [], memories: [], input: 'test' })
  assert(!prompt.messages[0].content.includes('Relevant memories'), 'iterationPrompt: no memory section when empty')
}

// 10. buildIterationPrompt: persona support
{
  const prompt = buildIterationPrompt({
    tools: [], memories: [], input: 'test',
    persona: {
      systemPrompt: '나는 커스텀 에이전트다.',
      rules: ['한국어로 답해', '보안 우선'],
    }
  })
  assert(prompt.messages[0].content.includes('나는 커스텀 에이전트다'), 'iterationPrompt: custom systemPrompt')
  assert(prompt.messages[0].content.includes('한국어로 답해'), 'iterationPrompt: persona rules included')
}

// 11. buildIterationPrompt: rolling context
{
  const prompt = buildIterationPrompt({
    tools: [], memories: [], input: 'test',
    previousPlan: { type: 'plan', steps: [{ op: 'EXEC', args: { tool: 'x', tool_args: {} } }] },
    previousResults: '[Step 1] some result',
  })
  assert(prompt.messages.length === 4, 'iterationPrompt rolling: 4 messages (system + user + assistant + user)')
  assert(prompt.messages[2].role === 'assistant', 'iterationPrompt rolling: assistant has previous plan')
  assert(prompt.messages[3].role === 'user', 'iterationPrompt rolling: user has step results')
  assert(prompt.messages[3].content.includes('Step results'), 'iterationPrompt rolling: includes step results')
  assert(prompt.messages[3].content.includes('some result'), 'iterationPrompt rolling: includes actual result')
}

// 12. buildIterationPrompt: no rolling context when previousPlan is null
{
  const prompt = buildIterationPrompt({ tools: [], memories: [], input: 'test', previousPlan: null, previousResults: null })
  assert(prompt.messages.length === 2, 'iterationPrompt no rolling: only 2 messages')
}

// 13. planSchema has correct structure
{
  assert(planSchema.name === 'agent_plan', 'planSchema: name is agent_plan')
  assert(planSchema.strict === true, 'planSchema: strict mode')
  const props = planSchema.schema.properties
  assert(props.type.enum.includes('plan'), 'planSchema: type enum has plan')
  assert(props.type.enum.includes('direct_response'), 'planSchema: type enum has direct_response')
  assert(props.steps.items.properties.op.enum.length === 6, 'planSchema: 6 op types')
}

// 14. summarizeResults: basic
{
  const result = summarizeResults(['hello', 'world'])
  assert(result.includes('[Step 1] hello'), 'summarizeResults: step 1')
  assert(result.includes('[Step 2] world'), 'summarizeResults: step 2')
}

// 15. summarizeResults: truncation
{
  const longText = 'x'.repeat(1000)
  const result = summarizeResults([longText])
  assert(result.includes('...(truncated)'), 'summarizeResults: long text truncated')
  assert(result.length < 1000, 'summarizeResults: result is shorter than input')
}

// 16. summarizeResults: object values
{
  const result = summarizeResults([{ key: 'value' }])
  assert(result.includes('{"key":"value"}'), 'summarizeResults: objects stringified')
}

// 17. summarizeResults: single non-array value
{
  const result = summarizeResults('single')
  assert(result.includes('[Step 1] single'), 'summarizeResults: single value wrapped')
}

// 18. prompt includes iteration guidance
{
  const prompt = buildIterationPrompt({ tools: [], memories: [], input: 'test' })
  const system = prompt.messages[0].content
  assert(system.includes('Iteration'), 'prompt: includes iteration section')
  assert(system.includes('direct_response'), 'prompt: mentions direct_response')
  assert(system.includes('without RESPOND'), 'prompt: mentions plan without RESPOND')
}

// 19. PROMPT_SECTIONS: structure
{
  const ids = ['role_definition', 'op_reference', 'approve_rules', 'plan_rules']
  ids.forEach(id => {
    const key = id.replace(/_([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, c => c.toUpperCase()).replace('Definition', 'DEFINITION').replace('Reference', 'REFERENCE').replace('Rules', 'RULES')
    // Just check by iterating values
  })
  // WORKING_DIR 은 factory 함수 (동적 섹션) 로 추가됨. 고정 섹션만 필터.
  const fixedSections = Object.values(PROMPT_SECTIONS).filter(s => typeof s === 'object' && s !== null)
  assert(fixedSections.length === 4, 'PROMPT_SECTIONS: 4 fixed named sections')
  assert(fixedSections.every(s => typeof s.id === 'string' && s.id.length > 0), 'PROMPT_SECTIONS: all have id')
  assert(fixedSections.every(s => typeof s.content === 'string' && s.content.length > 0), 'PROMPT_SECTIONS: all have content')
  // WORKING_DIR factory 는 호출 시 정상 섹션 생성
  const wdSection = PROMPT_SECTIONS.WORKING_DIR('/some/dir')
  assert(wdSection.id === 'working_dir' && wdSection.content.includes('/some/dir'),
    'PROMPT_SECTIONS: WORKING_DIR factory 생성')
}

// 20. PROMPT_SECTIONS: known IDs
{
  assert(PROMPT_SECTIONS.ROLE_DEFINITION.id === 'role_definition', 'PROMPT_SECTIONS: role_definition id')
  assert(PROMPT_SECTIONS.OP_REFERENCE.id === 'op_reference', 'PROMPT_SECTIONS: op_reference id')
  assert(PROMPT_SECTIONS.APPROVE_RULES.id === 'approve_rules', 'PROMPT_SECTIONS: approve_rules id')
  assert(PROMPT_SECTIONS.PLAN_RULES.id === 'plan_rules', 'PROMPT_SECTIONS: plan_rules id')
}

// 21. PROMPT_SECTIONS: content signatures (regression — fails if content changes unexpectedly)
{
  assert(PROMPT_SECTIONS.ROLE_DEFINITION.content.includes('planner for a task-delegation agent'), 'PROMPT_SECTIONS: role_definition signature')
  assert(PROMPT_SECTIONS.OP_REFERENCE.content.includes('LOOKUP_MEMORY') && PROMPT_SECTIONS.OP_REFERENCE.content.includes('DELEGATE'), 'PROMPT_SECTIONS: op_reference has all ops')
  assert(PROMPT_SECTIONS.APPROVE_RULES.content.includes('file_write') && PROMPT_SECTIONS.APPROVE_RULES.content.includes('shell_exec'), 'PROMPT_SECTIONS: approve_rules signature')
  assert(PROMPT_SECTIONS.PLAN_RULES.content.includes('direct_response') && PROMPT_SECTIONS.PLAN_RULES.content.match(/^\d+\./m), 'PROMPT_SECTIONS: plan_rules has numbered rules')
}

// 23. assemblePrompt _assembly.sections tracks active section IDs
{
  const prompt = buildIterationPrompt({ tools: [], memories: [], input: 'test' })
  assert(Array.isArray(prompt._assembly.sections), '_assembly.sections: is array')
  assert(prompt._assembly.sections.includes('role_definition'), '_assembly.sections: has role_definition')
  assert(prompt._assembly.sections.includes('op_reference'), '_assembly.sections: has op_reference')
  assert(prompt._assembly.sections.includes('plan_rules'), '_assembly.sections: has plan_rules')
}

// 24. assemblePrompt _assembly.sections: custom_role when persona.systemPrompt set
{
  const prompt = buildIterationPrompt({
    tools: [], memories: [], input: 'test',
    persona: { systemPrompt: '커스텀 역할' },
  })
  assert(prompt._assembly.sections.includes('custom_role'), '_assembly.sections: custom_role with persona')
  assert(!prompt._assembly.sections.includes('role_definition'), '_assembly.sections: no default role with persona')
}

// 24b. assemblePrompt: workingDir 주입 시 working_dir 섹션 포함
{
  const prompt = buildIterationPrompt({
    tools: [], memories: [], input: 'test',
    workingDir: '/project/root',
  })
  assert(prompt._assembly.sections.includes('working_dir'),
    '_assembly.sections: workingDir 주입 시 섹션 포함')
  // system prompt 내용에도 경로가 들어가야
  const sys = prompt.messages.find(m => m.role === 'system')?.content || ''
  assert(sys.includes('/project/root'),
    'assemblePrompt: system prompt 에 workingDir 경로 포함')
}

// 24c. assemblePrompt: workingDir 없으면 working_dir 섹션 제외
{
  const prompt = buildIterationPrompt({ tools: [], memories: [], input: 'test' })
  assert(!prompt._assembly.sections.includes('working_dir'),
    '_assembly.sections: workingDir 미주입 시 섹션 없음')
}

// 25. flattenHistory: SYSTEM entry 배제 (INV-SYS-1)
{
  const history = [
    { id: '1', input: 'q1', output: 'a1' },
    { id: '2', type: HISTORY_ENTRY_TYPE.SYSTEM, content: '사용자가 응답을 취소함', tag: 'cancel' },
    { id: '3', input: 'q2', output: 'a2' },
  ]
  const msgs = flattenHistory(history)
  assert(msgs.length === 4, 'flattenHistory: SYSTEM excluded → 4 msgs (2 turns × 2)')
  assert(msgs[0].content === 'q1', 'flattenHistory: first user = q1')
  assert(msgs[2].content === 'q2', 'flattenHistory: third user = q2 (SYSTEM skipped)')
  assert(!msgs.some(m => m.content === '사용자가 응답을 취소함'), 'flattenHistory: SYSTEM content not in prompt')
}

// 26. flattenHistory: type 생략 = turn (하위 호환)
{
  const history = [{ input: 'legacy', output: 'ok' }]
  const msgs = flattenHistory(history)
  assert(msgs.length === 2, 'flattenHistory: no-type entry treated as turn')
  assert(msgs[0].content === 'legacy', 'flattenHistory: legacy input preserved')
}

// 27. fitHistory: SYSTEM 포함하지만 비용 0 (자리 유지)
{
  const history = [
    { input: 'q1', output: 'a1' },
    { type: HISTORY_ENTRY_TYPE.SYSTEM, content: 's' },
    { input: 'q2', output: 'a2' },
  ]
  const fitted = fitHistory(history, 10000)
  assert(fitted.length === 3, 'fitHistory: SYSTEM preserved under generous budget')
}

summary()
