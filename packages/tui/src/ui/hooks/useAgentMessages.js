import { useState, useCallback, useEffect, useRef } from 'react'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'

// =============================================================================
// useAgentMessages: agent state → messages 동기화를 한 곳에서 관리.
//
// 책임:
// 1. conversationHistory → messages 변환
// 2. budgetWarning → system message 추가
// 3. toolResults → tool message 추가
// 4. 턴 시작 시 toolResults 초기화
// =============================================================================

const useAgentMessages = (state, agentState, initialMessages = []) => {
  const [messages, setMessages] = useState(initialMessages)
  const toolCountRef = useRef(0)

  const addMessage = useCallback((msg) => {
    setMessages(prev => [...prev, msg])
  }, [])

  const clearTransientMessages = useCallback(() => {
    setMessages(prev => prev.filter(msg => !msg.transient))
  }, [])

  // conversationHistory → messages 동기화
  useEffect(() => {
    const history = agentState.conversationHistory
    if (!Array.isArray(history)) return
    const historyMsgs = []
    for (const entry of history) {
      if (entry.input) historyMsgs.push({ role: 'user', content: entry.input })
      if (entry.output) historyMsgs.push({ role: entry.failed ? 'error' : 'agent', content: entry.output })
    }
    setMessages(prev => {
      const localOnly = prev.filter(msg => msg.role !== 'user' && msg.role !== 'agent' && msg.role !== 'error')
      return [...historyMsgs, ...localOnly]
    })
  }, [agentState.conversationHistory])

  // Budget warning → system message
  useEffect(() => {
    if (!agentState.budgetWarning) return
    const warning = agentState.budgetWarning
    if (warning.type === 'history_dropped') {
      addMessage({ role: 'system', content: t('budget.history_dropped', { dropped: warning.dropped, pct: warning.pct }), tag: 'warning' })
    } else if (warning.type === 'high_usage') {
      addMessage({ role: 'system', content: t('budget.high_usage', { pct: warning.pct }), tag: 'warning' })
    }
  }, [agentState.budgetWarning, addMessage])

  // Tool result → message
  useEffect(() => {
    const results = agentState.toolResults
    if (results.length > toolCountRef.current) {
      const newResults = results.slice(toolCountRef.current)
      toolCountRef.current = results.length
      for (const toolResult of newResults) {
        addMessage({ role: 'tool', tool: toolResult.tool, args: toolResult.args, result: toolResult.result })
      }
    }
  }, [agentState.toolResults, addMessage])

  // 턴 시작 시 toolResults 초기화
  useEffect(() => {
    if (agentState.status === 'working') {
      if (state) state.set(STATE_PATH.TOOL_RESULTS, [])
      toolCountRef.current = 0
    }
  }, [agentState.status, state])

  return { messages, setMessages, addMessage, clearTransientMessages }
}

export { useAgentMessages }
