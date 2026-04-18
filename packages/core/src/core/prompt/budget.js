import { measureMessages, estimateTokens } from '../../lib/tokenizer.js'
import { PROMPT as PROMPT_POLICY } from '../policies.js'
import { isTurnEntry, turnEntriesOnly } from '../history-writer.js'

// =============================================================================
// Prompt budget helpers: 토큰 예산 내에서 history/memories를 trim.
// assemblePrompt가 조립 시 사용.
//
// INV-SYS-1: SYSTEM entry (type === 'system') 는 prompt 조립에서 배제한다.
// =============================================================================

// history turn 배열을 {user, assistant} 메시지 시퀀스로 평탄화. SYSTEM 은 skip.
const flattenHistory = (turns) =>
  turnEntriesOnly(turns)
    .flatMap(t => [
      { role: 'user', content: t.input },
      { role: 'assistant', content: t.output },
    ])

// 뒤에서부터 담아 budget 초과 전까지 포함. 최신 turn 우선. SYSTEM entry 는 유지하되 비용 0.
const fitHistory = (turns, charBudget) => {
  const fitted = []
  let used = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    const entry = turns[i]
    const cost = isTurnEntry(entry) ? measureMessages(flattenHistory([entry])) : 0
    if (used + cost > charBudget) break
    fitted.unshift(entry)
    used += cost
  }
  return fitted
}

const MEMORY_PROMPT_OVERHEAD = estimateTokens('\n\nRelevant memories:\n')

// 메모리 헤더 오버헤드 + 각 항목 비용을 누적하여 budget 내에서 trim.
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

// iteration context를 2개 메시지(이전 plan + step results)로 변환.
// mode='summarized'이면 긴 결과를 잘라냄 (budget 초과 fallback).
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

export { flattenHistory, fitHistory, fitMemories, buildIterationBlock }
