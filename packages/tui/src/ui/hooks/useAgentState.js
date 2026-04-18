import { useState, useEffect, useRef } from 'react'
import { STATE_PATH, ERROR_KIND } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'
import { createTrailingThrottle } from './trailing-throttle.js'

// FP-58: streaming chunk 가 60ms 주기로 쏟아져 App re-render → Ink frame rewrite.
// 200ms throttle 로 16 Hz → 5 Hz 감소. 최신 값은 항상 보존 (trailing flush).
const STREAMING_THROTTLE_MS = 200

/**
 * State + Hook 시스템을 React 상태에 바인딩.
 * 에이전트 State의 변경이 UI를 자동으로 갱신한다.
 */
// 순수 셀렉터 — 테스트에서도 사용
// INV-ABT-1 후속: 사용자가 의도적으로 ESC 로 취소한 턴은 error 가 아닌 idle 로 표시.
// lastTurn.error.kind === 'aborted' 면 SYSTEM cancel entry 가 이미 history 에 있어
// 사용자는 무슨 일이 있었는지 알 수 있다. StatusBar 의 빨간 ✗ error 는 진짜 failure 전용.
const deriveStatus = (state) => {
  const ts = state.get(STATE_PATH.TURN_STATE)
  if (ts?.tag === 'working') return 'working'
  const lt = state.get(STATE_PATH.LAST_TURN)
  if (lt?.tag === 'failure' && lt?.error?.kind !== ERROR_KIND.ABORTED) return 'error'
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
  const [toolTranscript, setToolTranscript] = useState([])
  const [conversationHistory, setConversationHistory] = useState([])
  const [pendingInput, setPendingInput] = useState(null)

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

    // setter factory — 동일 shape 의 단순 handler 를 재사용해 Fn 카운트 억제.
    const asArray = (setter) => (change) => setter(Array.isArray(change.nextValue) ? change.nextValue : [])
    const asNullable = (setter) => (change) => setter(change.nextValue || null)

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
      [STATE_PATH.CONTEXT_CONVERSATION_HISTORY]: asArray(setConversationHistory),
      [STATE_PATH.RETRY]: (change) => {
        const info = change.nextValue
        setRetryInfo(info)
        // FP-52: truncated 일 때 사유 표시
        const key = info.truncated ? 'status.retry_truncated' : 'status.retry'
        setActivity(t(key, { attempt: info.attempt, max: info.maxRetries }))
      },
      [STATE_PATH.APPROVE]: asNullable(setApprove),
      [STATE_PATH.STREAMING]: (change) => {
        const value = change.nextValue || null
        if (value === null) streamThrottle.flushNow(null)
        else streamThrottle.scheduleOrFlush(value)
      },
      [STATE_PATH.RECONNECTING]: (change) => setReconnecting(!!change.nextValue),
      [STATE_PATH.DEBUG_LAST_TURN]: asNullable(setDebug),
      [STATE_PATH.DEBUG_OP_TRACE]: asArray(setOpTrace),
      [STATE_PATH.DEBUG_RECALLED_MEMORIES]: asArray(setRecalledMemories),
      [STATE_PATH.DEBUG_ITERATION_HISTORY]: asArray(setIterationHistory),
      [STATE_PATH.BUDGET_WARNING]: asNullable(setBudgetWarning),
      [STATE_PATH.TOOL_TRANSCRIPT]: asArray(setToolTranscript),
      [STATE_PATH.PENDING_INPUT]: asNullable(setPendingInput),
      [STATE_PATH.TODOS]: asArray(setTodos),
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
    setToolTranscript(state.get(STATE_PATH.TOOL_TRANSCRIPT) || [])
    setPendingInput(state.get(STATE_PATH.PENDING_INPUT) || null)
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
    todos, events, delegates, retryInfo, approve, streaming, reconnecting, debug, opTrace, recalledMemories, iterationHistory, budgetWarning, toolTranscript, conversationHistory, pendingInput,
  }
}

export { useAgentState, deriveStatus, deriveMemoryCount }
