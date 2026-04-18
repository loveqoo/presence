import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { HISTORY_ENTRY_TYPE, HISTORY_TAG } from '@presence/core/core/policies.js'
import { isTurnEntry } from '@presence/core/core/history-writer.js'
import { t } from '@presence/infra/i18n'

// =============================================================================
// useAgentMessages: 서버 state → ChatArea 메시지를 useMemo 로 파생.
//
// 설계 (플랜 purring-beaming-horizon):
// - 서버 conversationHistory = SSoT. TUI 는 addMessage 대신 addTransient 만 제공.
// - useMemo 로 history + toolTranscript + pendingInput + budgetWarning + transient
//   를 매 렌더마다 재계산. 이중 출처로 인한 순서 역전 원천 차단.
// - /clear optimistic: optimisticClearTs 보다 작은 ts entry 는 렌더 제외.
//   history.length === 0 관측 시 reset (compactionEpoch wire 불필요).
// =============================================================================

const historyEntryToMessages = (entry) => {
  const entryTs = entry.ts || 0
  if ((entry.type || HISTORY_ENTRY_TYPE.TURN) === HISTORY_ENTRY_TYPE.SYSTEM) {
    return [{ role: 'system', content: entry.content, tag: entry.tag, ts: entryTs, persisted: true }]
  }
  // turn entry
  const out = []
  if (entry.input) out.push({ role: 'user', content: entry.input, ts: entryTs, persisted: true })
  if (entry.cancelled) return out                       // 취소된 turn 의 output 은 표시하지 않음
  if (entry.output) out.push({ role: entry.failed ? 'error' : 'agent', content: entry.output, ts: entryTs + 1, persisted: true })
  return out
}

const budgetMessage = (warning) => {
  if (!warning) return null
  const key = warning.type === 'history_dropped' ? 'budget.history_dropped' : 'budget.high_usage'
  return {
    role: 'system',
    content: t(key, { dropped: warning.dropped, pct: warning.pct }),
    tag: HISTORY_TAG.WARNING,
    ts: warning.ts || 0,
  }
}

const deriveMessages = (sources) => {
  const { history, toolTranscript, pendingInput, budgetWarning, transient, optimisticClearTs } = sources
  const msgs = []
  if (Array.isArray(history)) {
    for (const entry of history) {
      if ((entry.ts || 0) <= optimisticClearTs) continue
      for (const msg of historyEntryToMessages(entry)) msgs.push(msg)
    }
  }
  if (Array.isArray(toolTranscript)) {
    for (const tool of toolTranscript) {
      const toolTs = tool.ts || 0
      if (toolTs <= optimisticClearTs) continue
      msgs.push({ role: 'tool', tool: tool.tool, args: tool.args, result: tool.result, ts: toolTs })
    }
  }
  if (pendingInput) {
    // WS patch 는 path 별로 직렬 도착하므로 conversationHistory 가 먼저, _pendingInput null
    // 은 뒤늦게 반영되는 window 가 존재. 같은 input 이어도 lastTurn.ts 가 pending 시작
    // 시각(pendingInput.ts) 이후여야 "이번 pending 이 persisted" 로 간주한다.
    // (같은 질문을 연속 두 번 보내는 정상 시나리오와 구분)
    const lastTurn = Array.isArray(history)
      ? [...history].reverse().find(isTurnEntry)
      : null
    const alreadyPersisted = lastTurn
      && lastTurn.input === pendingInput.input
      && (lastTurn.ts || 0) >= (pendingInput.ts || 0)
    if (!alreadyPersisted) {
      msgs.push({ role: 'user', content: pendingInput.input, ts: Date.now(), pending: true })
    }
  }
  const bm = budgetMessage(budgetWarning)
  if (bm && bm.ts > optimisticClearTs) msgs.push(bm)
  if (Array.isArray(transient)) {
    for (const tr of transient) {
      if ((tr.ts || 0) <= optimisticClearTs) continue
      msgs.push(tr)
    }
  }
  return msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0))
}

const useAgentMessages = (_state, agentState, initialMessages = []) => {
  const [transient, setTransient] = useState(() => initialMessages.map(m => ({ ...m, transient: true, ts: m.ts || Date.now() })))
  const [optimisticClearTs, setOptimisticClearTs] = useState(0)

  const addTransient = useCallback((msg) => {
    setTransient(prev => [...prev, { ...msg, transient: true, ts: msg.ts || Date.now() }])
  }, [])

  const clearTransient = useCallback(() => {
    setTransient([])
  }, [])

  const optimisticClearNow = useCallback(() => {
    setOptimisticClearTs(Date.now())
    setTransient([])
  }, [])

  // /clear reset 신호: 서버 history 가 비워진 순간 optimisticClearTs 를 0 으로.
  const prevHistoryLenRef = useRef(Array.isArray(agentState.conversationHistory) ? agentState.conversationHistory.length : 0)
  useEffect(() => {
    const len = Array.isArray(agentState.conversationHistory) ? agentState.conversationHistory.length : 0
    if (len === 0 && prevHistoryLenRef.current > 0 && optimisticClearTs > 0) {
      setOptimisticClearTs(0)
    }
    prevHistoryLenRef.current = len
  }, [agentState.conversationHistory, optimisticClearTs])

  const messages = useMemo(() => deriveMessages({
    history: agentState.conversationHistory,
    toolTranscript: agentState.toolTranscript,
    pendingInput: agentState.pendingInput,
    budgetWarning: agentState.budgetWarning,
    transient,
    optimisticClearTs,
  }), [agentState.conversationHistory, agentState.toolTranscript, agentState.pendingInput, agentState.budgetWarning, transient, optimisticClearTs])

  return { messages, addTransient, clearTransient, optimisticClearNow }
}

export { useAgentMessages, deriveMessages }
