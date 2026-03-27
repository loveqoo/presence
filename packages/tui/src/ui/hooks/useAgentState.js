import { useState, useEffect } from 'react'

/**
 * State + Hook 시스템을 React 상태에 바인딩.
 * 에이전트 State의 변경이 UI를 자동으로 갱신한다.
 */
// 순수 셀렉터 — 테스트에서도 사용
const deriveStatus = (state) => {
  const ts = state.get('turnState')
  if (ts?.tag === 'working') return 'working'
  const lt = state.get('lastTurn')
  if (lt?.tag === 'failure') return 'error'
  return 'idle'
}

const deriveMemoryCount = (state) => {
  const mems = state.get('context.memories')
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
  const [debug, setDebug] = useState(null)
  const [opTrace, setOpTrace] = useState([])
  const [recalledMemories, setRecalledMemories] = useState([])
  const [iterationHistory, setIterationHistory] = useState([])
  const [budgetWarning, setBudgetWarning] = useState(null)
  const [toolResults, setToolResults] = useState([])

  useEffect(() => {
    if (!state) return

    // events/delegates는 하위 경로(events.queue 등)로 변경되므로 wildcard 구독 필요
    const refreshEvents = () => setEvents(state.get('events') || { queue: [], deadLetter: [] })
    const refreshDelegates = () => setDelegates(state.get('delegates') || { pending: [] })

    const handlers = {
      turnState: (phase) => {
        setStatus(deriveStatus(state))
        setActivity(phase.tag === 'working' ? 'thinking...' : null)
      },
      lastTurn: (lt) => {
        setStatus(deriveStatus(state))
        setLastTurn(lt)
      },
      turn: (val) => setTurn(val),
      'context.memories': (val) => {
        setMemoryCount(Array.isArray(val) ? val.length : 0)
      },
      _retry: (info) => {
        setRetryInfo(info)
        setActivity(`retry ${info.attempt}/${info.maxRetries}...`)
      },
      _approve: (val) => setApprove(val || null),
      _streaming: (val) => setStreaming(val || null),
      '_debug.lastTurn': (val) => setDebug(val || null),
      '_debug.opTrace': (val) => setOpTrace(Array.isArray(val) ? val : []),
      '_debug.recalledMemories': (val) => setRecalledMemories(Array.isArray(val) ? val : []),
      '_debug.iterationHistory': (val) => setIterationHistory(Array.isArray(val) ? val : []),
      '_budgetWarning': (val) => setBudgetWarning(val || null),
      '_toolResults': (val) => setToolResults(val || []),
      todos: (val) => setTodos(Array.isArray(val) ? val : []),
      // exact match (전체 객체 교체 시)
      events: (val) => setEvents(val || { queue: [], deadLetter: [] }),
      delegates: (val) => setDelegates(val || { pending: [] }),
      // wildcard match (하위 경로 변경 시: events.queue, delegates.pending 등)
      'events.*': refreshEvents,
      'delegates.*': refreshDelegates,
    }

    for (const [path, handler] of Object.entries(handlers)) {
      state.hooks.on(path, handler)
    }

    // 초기 상태 동기화
    setStatus(deriveStatus(state))
    setTurn(state.get('turn') || 0)
    setMemoryCount(Array.isArray(state.get('context.memories')) ? state.get('context.memories').length : 0)
    setLastTurn(state.get('lastTurn'))
    setTodos(state.get('todos') || [])
    setApprove(state.get('_approve') || null)
    setStreaming(state.get('_streaming') || null)
    setDebug(state.get('_debug.lastTurn') || null)
    setOpTrace(state.get('_debug.opTrace') || [])
    setRecalledMemories(state.get('_debug.recalledMemories') || [])
    setIterationHistory(state.get('_debug.iterationHistory') || [])
    setToolResults(state.get('_toolResults') || [])
    refreshEvents()
    refreshDelegates()

    return () => {
      for (const [path, handler] of Object.entries(handlers)) {
        state.hooks.off(path, handler)
      }
    }
  }, [state])

  return {
    status, turn, memoryCount, activity, lastTurn,
    todos, events, delegates, retryInfo, approve, streaming, debug, opTrace, recalledMemories, iterationHistory, budgetWarning, toolResults,
  }
}

export { useAgentState, deriveStatus, deriveMemoryCount }
