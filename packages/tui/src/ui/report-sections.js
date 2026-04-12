/**
 * Report Section Builders
 *
 * report.js에서 분리. 각 섹션의 마크다운 렌더링을 담당.
 * Timeline 섹션은 report-timeline.js에 별도 분리.
 */
import { STATE_PATH } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'

const formatTimestamp = (ts) => {
  if (!ts) return '?'
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

const truncate = (str, max = 200) => {
  if (!str) return '(none)'
  const s = String(str)
  return s.length > max ? s.slice(0, max) + `... (${s.length} chars total)` : s
}

const formatIteration = (add, iter) => {
  const retryTag = iter.retryAttempt > 0 ? ` (retry ${iter.retryAttempt})` : ''
  add(`### Iteration ${iter.iteration + 1}${retryTag}`)
  add(`- **Parsed type:** ${iter.parsedType || 'unknown'}`)
  add(`- **Step count:** ${iter.error ? t('transcript.error_label') : (iter.stepCount ?? '?')}`)
  if (iter.error) add(`- **Error:** ${iter.error}`)
  add(`- **Assembly used:** ${iter.error ? t('transcript.error_label') : `${iter.assembly?.used ?? '?'} tokens`}`)
  if (iter.promptMessages > 0) add(`- **Prompt:** ${iter.promptMessages} messages, ${iter.promptChars} chars`)
  if (iter.response) {
    add(`- **Response (${iter.response.length} chars):**`)
    add('```json')
    add(iter.response.length > 500 ? iter.response.slice(0, 500) + '\n... (truncated)' : iter.response)
    add('```')
  }
}

const buildTurnSection = (add, debug) => {
  add('## Turn')
  if (!debug) { add('(no turn data)'); return }
  add(`- **Input:** \`${truncate(debug.input, 100)}\``)
  add(`- **Result:** ${debug.parsedType || 'unknown'}`)
  add(`- **Iteration:** ${debug.iteration ?? '?'}`)
  add(`- **Error:** ${debug.error || 'none'}`)
  add(`- **Timestamp:** ${formatTimestamp(debug.timestamp)}`)
}

const buildIterationsSection = (add, iterationHistory) => {
  if (!iterationHistory || iterationHistory.length === 0) return
  add(`## Iterations (${iterationHistory.length})`)
  for (const iter of iterationHistory) { add(); formatIteration(add, iter) }
}

const buildAssemblySection = (add, assembly) => {
  if (!assembly) return
  const pct = assembly.budget && assembly.budget !== Infinity
    ? ` (${Math.round(assembly.used / assembly.budget * 100)}%)`
    : ''
  add('## Assembly')
  add(`- **Budget:** ${assembly.budget === Infinity ? 'unlimited' : assembly.budget + ' tokens'}`)
  add(`- **Used:** ${assembly.used} tokens${pct}`)
  add(`- **History:** ${assembly.historyUsed} used, ${assembly.historyDropped} dropped`)
  add(`- **Memories:** ${assembly.memoriesUsed} recalled`)
}

const buildPromptSection = (add, lastPrompt) => {
  if (!lastPrompt || lastPrompt.length === 0) return
  const totalChars = lastPrompt.reduce((sum, msg) => sum + (msg.content?.length || 0), 0)
  add(`## Prompt (${lastPrompt.length} messages, ${totalChars} chars)`)
  add('```')
  for (let i = 0; i < lastPrompt.length; i++) {
    const body = lastPrompt[i].content || ''
    const nl = body.indexOf('\n')
    const firstLine = nl === -1 ? body : body.slice(0, nl)
    add(`[${i}] ${lastPrompt[i].role} (${body.length} chars): ${truncate(firstLine, 120)}`)
  }
  add('```')
}

const buildResponseSection = (add, lastResponse) => {
  if (!lastResponse) return
  add(`## LLM Response (${lastResponse.length} chars)`)
  add('```json')
  add(lastResponse.length > 2000 ? lastResponse.slice(0, 2000) + '\n... (truncated)' : lastResponse)
  add('```')
}

const buildMemoriesSection = (add, memories) => {
  if (!memories || memories.length === 0) return
  add(`## Recalled Memories (${memories.length})`)
  for (let i = 0; i < memories.length; i++) add(`${i + 1}. ${truncate(String(memories[i]), 100)}`)
}

const buildStateSection = (add, state) => {
  if (!state) return
  add('## State')
  add(`- **Turn:** ${state.get(STATE_PATH.TURN) || 0}`)
  add(`- **Status:** ${state.get(STATE_PATH.TURN_STATE)?.tag || '?'}`)
  add(`- **Last Result:** ${state.get(STATE_PATH.LAST_TURN)?.tag || 'none'}`)
  add(`- **Memories:** ${(state.get(STATE_PATH.CONTEXT_MEMORIES) || []).length} recalled`)
  add(`- **History:** ${(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || []).length} entries`)
}

const buildConfigSection = (add, config) => {
  if (!config) return
  add('## Config')
  add(`- **Model:** ${config.llm?.model || '?'}`)
  add(`- **Base URL:** ${config.llm?.baseUrl || '?'}`)
  add(`- **Response Format:** ${config.llm?.responseFormat || '?'}`)
  add(`- **Max Retries:** ${config.llm?.maxRetries ?? '?'}`)
  add(`- **Max Iterations:** ${config.maxIterations ?? '?'}`)
  add(`- **Embedder:** ${config.embed?.baseUrl || config.embed?.apiKey ? 'active' : 'none'}`)
}

export {
  truncate,
  buildTurnSection, buildIterationsSection,
  buildAssemblySection, buildPromptSection, buildResponseSection,
  buildMemoriesSection, buildStateSection, buildConfigSection,
}
