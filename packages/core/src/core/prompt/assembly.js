import { measureMessages } from '../../lib/tokenizer.js'
import { planSchema } from './schema.js'
import { PROMPT_SECTIONS, section } from './sections.js'
import { formatToolList, formatAgentList, formatMemories } from './formatters.js'
import { flattenHistory, fitHistory, fitMemories, buildIterationBlock } from './budget.js'

// =============================================================================
// Prompt assembly: tools/agents/memories/history/iteration을 LLM 메시지로 조립.
// public API: assemblePrompt, buildIterationPrompt, buildRetryPrompt.
// =============================================================================

const buildMemoryPrompt = (memories) => {
  if (!memories || memories.length === 0) return ''
  return `Relevant memories:\n${formatMemories(memories)}`
}

const buildResponseFormat = (mode) => {
  if (mode === 'json_schema') return { type: 'json_schema', json_schema: planSchema }
  if (mode === 'json_object') return { type: 'json_object' }
  return undefined
}

const assemblePrompt = (params) => {
  const {
    persona = {}, tools = [], agents = [], history = [],
    memories = [], input, iterationContext, budget,
    responseFormatMode = 'json_object',
  } = params
  const effectiveBudget = budget || { maxContextChars: Infinity, reservedOutputChars: 0 }
  const usable = effectiveBudget.maxContextChars - effectiveBudget.reservedOutputChars

  const userRulesContent = persona.rules && persona.rules.length > 0
    ? 'User rules:\n' + persona.rules.map(r => `- ${r}`).join('\n')
    : null
  const agentsContent = agents && agents.length > 0 ? formatAgentList(agents) : null

  const activeSections = [
    persona.systemPrompt ? section('custom_role', persona.systemPrompt) : PROMPT_SECTIONS.ROLE_DEFINITION,
    PROMPT_SECTIONS.OP_REFERENCE,
    section('tools', formatToolList(tools)),
    agentsContent ? section('agents', agentsContent) : null,
    userRulesContent ? section('user_rules', userRulesContent) : null,
    PROMPT_SECTIONS.APPROVE_RULES,
    PROMPT_SECTIONS.PLAN_RULES,
  ].filter(Boolean)
  const fixedSystemText = activeSections.map(s => s.content).join('\n\n')

  const inputText = input
  let iterBlock = buildIterationBlock(iterationContext)

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

  const fittedHistory = fitHistory(history, remaining)
  remaining -= measureMessages(flattenHistory(fittedHistory))

  const fittedMemories = fitMemories(memories, Math.max(0, remaining))

  const systemContent = [
    fixedSystemText,
    fittedMemories.length > 0 ? buildMemoryPrompt(fittedMemories) : '',
  ].filter(Boolean).join('\n\n')

  const messages = [
    { role: 'system', content: systemContent },
    ...flattenHistory(fittedHistory),
    { role: 'user', content: inputText },
    ...iterBlock,
  ]

  return {
    messages,
    response_format: buildResponseFormat(responseFormatMode),
    maxTokens: effectiveBudget.reservedOutputChars || undefined,
    _assembly: {
      budget: usable,
      used: measureMessages(messages),
      reservedOutput: effectiveBudget.reservedOutputChars,
      historyUsed: fittedHistory.length,
      historyDropped: history.length - fittedHistory.length,
      memoriesUsed: fittedMemories.length,
      sections: activeSections.map(s => s.id),
    },
  }
}

const buildIterationPrompt = (params) => {
  const { tools = [], agents = [], memories = [], input, persona = {}, responseFormatMode = 'json_object', previousPlan = null, previousResults = null } = params
  return assemblePrompt({
    persona, tools, agents, memories,
    history: [],
    input,
    iterationContext: previousPlan && previousResults != null
      ? { previousPlan, previousResults }
      : null,
    responseFormatMode,
  })
}

const buildRetryPrompt = (originalPrompt, errorMessage) => ({
  messages: [
    ...originalPrompt.messages,
    { role: 'assistant', content: '(invalid JSON)' },
    { role: 'user', content: `Your previous response was not valid JSON. Error: ${errorMessage}\nPlease respond with ONLY valid JSON. No explanation, no markdown, ONLY the JSON object.` },
  ],
  response_format: originalPrompt.response_format,
  maxTokens: originalPrompt.maxTokens,
})

export { assemblePrompt, buildIterationPrompt, buildRetryPrompt }
