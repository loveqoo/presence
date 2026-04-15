import { useState, useEffect, useRef } from 'react'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { createTrailingThrottle } from './trailing-throttle.js'

// FP-58: streaming chunk 가 60ms 주기로 쏟아져 App re-render → Ink frame rewrite.
// 200ms throttle 로 16 Hz → 5 Hz 감소. 최신 값은 항상 보존 (trailing flush).
const STREAMING_THROTTLE_MS = 200

/**
 * State + Hook 시스템을 React 상태에 바인딩.
 * 에이전트 State의 변경이 UI를 자동으로 갱신한다.
 */
// 순수 셀렉터 — 테스트에서도 사용
const deriveStatus = (state) => {
  const ts = state.get(STATE_PATH.TURN_STATE)
  if (ts?.tag === 'working') return 'working'
  const lt = state.get(STATE_PATH.LAST_TURN)
  if (lt?.tag === 'failure') return 'error'
  return 'idle'
}

const deriveMemoryCount = (state) => {
  const mems = state.get(STATE_PATH.CONTEXT_MEMORIES)
  return Array.isArray(mems) ? mems.length : 0
}

const useAgentState = (state) => {
  const [status, setStatus] = useState('idle')
  const [turn, setTurn] = useState(0)
  const [memoryCount, setMemoryCount] = useState(0)
  const [activity, setActivity] = useState(null)
  const [lastTurn, setLastTurn] = useState(null)
  const [todos, setTodos] = useState([])
  const [events, setEvents] = useState({ queue: [], deadLetter: [] })
  const [delegates, setDelegates] = useState({ pending: [] })
  const [retryInfo, setRetryInfo] = useState(null)
  const [approve, setApprove] = useState(null)
  const [streaming, setStreaming] = useState(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [debug, setDebug] = useState(null)
  const [opTrace, setOpTrace] = useState([])
  const [recalledMemories, setRecalledMemories] = useState([])
  const [iterationHistory, setIterationHistory] = useState([])
  const [budgetWarning, setBudgetWarning] = useState(null)
  const [toolResults, setToolResults] = useState([])
  const [conversationHistory, setConversationHistory] = useState([])

  const streamingTimerRef = useRef(null)
  const streamingLatestRef = useRef(null)

  useEffect(() => {
    if (!state) return

    // events/delegates는 하위 경로(events.queue 등)로 변경되므로 wildcard 구독 필요
    const refreshEvents = () => setEvents(state.get(STATE_PATH.EVENTS) || { queue: [], deadLetter: [] })
    const refreshDelegates = () => setDelegates(state.get(STATE_PATH.DELEGATES) || { pending: [] })

    // FP-58: streaming 은 60ms 주기 chunk → trailing throttle 로 5 Hz 제한.
    // null (시작/종료) 전환은 즉시 flush. 중간 chunk 는 200ms 간격으로 최신 값만 반영.
    const streamThrottle = createTrailingThrottle({
      delayMs: STREAMING_THROTTLE_MS,
      onFlush: setStreaming,
      timerRef: streamingTimerRef,
      latestRef: streamingLatestRef,
    })

    const handlers = {
      [STATE_PATH.TURN_STATE]: (change) => {
        const phase = change.nextValue
        setStatus(deriveStatus(state))
        // activity 는 retry 같은 override 전용. 기본 라벨(thinking/streaming)은
        // App 이 status + streaming 으로 파생해 StatusBar 에 전달 (FP-15).
        if (phase.tag !== 'working') setActivity(null)
      },
      [STATE_PATH.LAST_TURN]: (change) => {
        setStatus(deriveStatus(state))
        setLastTurn(change.nextValue)
      },
      [STATE_PATH.TURN]: (change) => setTurn(change.nextValue),
      [STATE_PATH.CONTEXT_MEMORIES]: (change) => {
        const val = change.nextValue
        setMemoryCount(Array.isArray(val) ? val.length : 0)
      },
      [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: (change) => {
        const val = change.nextValue
        setConversationHistory(Array.isArray(val) ? val : [])
      },
      [STATE_PATH.RETRY]: (change) => {
        const info = change.nextValue
        setRetryInfo(info)
        setActivity(`retry ${info.attempt}/${info.maxRetries}...`)
      },
      [STATE_PATH.APPROVE]: (change) => setApprove(change.nextValue || null),
      [STATE_PATH.STREAMING]: (change) => {
        const value = change.nextValue || null
        if (value === null) streamThrottle.flushNow(null)
        else streamThrottle.scheduleOrFlush(value)
      },
      [STATE_PATH.RECONNECTING]: (change) => setReconnecting(!!change.nextValue),
      [STATE_PATH.DEBUG_LAST_TURN]: (change) => setDebug(change.nextValue || null),
      [STATE_PATH.DEBUG_OP_TRACE]: (change) => { const v = change.nextValue; setOpTrace(Array.isArray(v) ? v : []) },
      [STATE_PATH.DEBUG_RECALLED_MEMORIES]: (change) => { const v = change.nextValue; setRecalledMemories(Array.isArray(v) ? v : []) },
      [STATE_PATH.DEBUG_ITERATION_HISTORY]: (change) => { const v = change.nextValue; setIterationHistory(Array.isArray(v) ? v : []) },
      [STATE_PATH.BUDGET_WARNING]: (change) => setBudgetWarning(change.nextValue || null),
      [STATE_PATH.TOOL_RESULTS]: (change) => setToolResults(change.nextValue || []),
      [STATE_PATH.TODOS]: (change) => { const v = change.nextValue; setTodos(Array.isArray(v) ? v : []) },
      // exact match (전체 객체 교체 시)
      [STATE_PATH.EVENTS]: (change) => setEvents(change.nextValue || { queue: [], deadLetter: [] }),
      [STATE_PATH.DELEGATES]: (change) => setDelegates(change.nextValue || { pending: [] }),
      // wildcard match (하위 경로 변경 시: events.queue, delegates.pending 등)
      'events.*': refreshEvents,
      'delegates.*': refreshDelegates,
    }

    for (const [path, handler] of Object.entries(handlers)) {
      state.hooks.on(path, handler)
    }

    // 초기 상태 동기화
    setStatus(deriveStatus(state))
    setTurn(state.get(STATE_PATH.TURN) || 0)
    setMemoryCount(Array.isArray(state.get(STATE_PATH.CONTEXT_MEMORIES)) ? state.get(STATE_PATH.CONTEXT_MEMORIES).length : 0)
    setConversationHistory(state.get(STATE_PATH.CONTEXT_CONVERSATION_HISTORY) || [])
    setLastTurn(state.get(STATE_PATH.LAST_TURN))
    setTodos(state.get(STATE_PATH.TODOS) || [])
    setApprove(state.get(STATE_PATH.APPROVE) || null)
    setStreaming(state.get(STATE_PATH.STREAMING) || null)
    setReconnecting(!!state.get(STATE_PATH.RECONNECTING))
    setDebug(state.get(STATE_PATH.DEBUG_LAST_TURN) || null)
    setOpTrace(state.get(STATE_PATH.DEBUG_OP_TRACE) || [])
    setRecalledMemories(state.get(STATE_PATH.DEBUG_RECALLED_MEMORIES) || [])
    setIterationHistory(state.get(STATE_PATH.DEBUG_ITERATION_HISTORY) || [])
    setToolResults(state.get(STATE_PATH.TOOL_RESULTS) || [])
    refreshEvents()
    refreshDelegates()

    return () => {
      for (const [path, handler] of Object.entries(handlers)) {
        state.hooks.off(path, handler)
      }
      streamThrottle.dispose()
    }
  }, [state])

  return {
    status, turn, memoryCount, activity, lastTurn,
    todos, events, delegates, retryInfo, approve, streaming, reconnecting, debug, opTrace, recalledMemories, iterationHistory, budgetWarning, toolResults, conversationHistory,
  }
}

export { useAgentState, deriveStatus, deriveMemoryCount }
