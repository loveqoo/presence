import { useState, useEffect, useCallback, useRef, useMemo, useReducer } from 'react'
import { messageReducer, initialState } from './messageActor.js'

const deriveStatus = (state) => {
  if (state.turnState?.tag === 'working') return 'working'
  if (state.lastTurn?.tag === 'failure') return 'error'
  return 'idle'
}

/**
 * React hook that connects to the Presence server via WebSocket and mirrors session state.
 * IO only — message state is owned by MessageActor (useReducer).
 * @param {string} [sessionId='user-default']
 * @param {{authFetch?: Function, accessToken?: string|null, enabled?: boolean}} [options]
 */
const usePresence = (sessionId = 'user-default', { authFetch, accessToken, enabled = true } = {}) => {
  const fetchFn = authFetch || fetch

  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('idle')
  const [turn, setTurn] = useState(0)
  const [streaming, setStreaming] = useState(null)
  const [approve, setApprove] = useState(null)
  const [tools, setTools] = useState([])
  const [opTrace, setOpTrace] = useState([])
  const wsRef = useRef(null)
  const stateRef = useRef({})

  // MessageActor — 메시지 상태의 단일 직렬화 지점
  const [msgState, dispatch] = useReducer(messageReducer, initialState)

  const messages = useMemo(() =>
    [...msgState.historyMessages, ...msgState.pendingMessages, ...msgState.localMessages]
  , [msgState.historyMessages, msgState.pendingMessages, msgState.localMessages])

  // tools 로드
  const loadTools = useCallback(() => {
    const url = sessionId === 'user-default'
      ? '/api/tools'
      : `/api/sessions/${sessionId}/tools`
    fetchFn(url).then(r => r.json()).then(setTools).catch(() => {})
  }, [sessionId, fetchFn])

  // WebSocket 연결
  useEffect(() => {
    let mounted = true
    let reconnectTimer = null

    const connect = () => {
      if (!mounted) return
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${location.host}`)
      wsRef.current = ws

      ws.onopen = () => {
        if (!mounted) return
        setConnected(true)
        ws.send(JSON.stringify({ type: 'join', session_id: sessionId }))
      }

      ws.onclose = () => {
        if (!mounted) return
        setConnected(false)
        reconnectTimer = setTimeout(connect, 3000)
      }

      ws.onerror = () => {}

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.session_id && data.session_id !== sessionId) return

          if (data.type === 'init') {
            stateRef.current = data.state
            setStatus(deriveStatus(data.state))
            setTurn(data.state.turn || 0)
            setStreaming(data.state._streaming || null)
            setApprove(data.state._approve || null)
            setOpTrace(data.state._debug?.opTrace || [])
            dispatch({ type: 'hydrate', history: data.state.context?.conversationHistory })
            return
          }

          if (data.type === 'state') {
            const { path, value } = data
            stateRef.current = { ...stateRef.current, [path]: value }

            switch (path) {
              case 'turnState':
                setStatus(value?.tag === 'working' ? 'working' : deriveStatus(stateRef.current))
                break
              case 'lastTurn':
                setStatus(deriveStatus(stateRef.current))
                break
              case 'turn':
                setTurn(value || 0)
                break
              case '_streaming':
                setStreaming(value || null)
                break
              case '_approve':
                setApprove(value || null)
                break
              case '_debug.opTrace':
                setOpTrace(Array.isArray(value) ? value : [])
                break
              case 'context.conversationHistory':
                dispatch({ type: 'history_push', history: value })
                break
            }
          }
        } catch (_) {}
      }
    }

    // 세션 전환 시 초기화
    dispatch({ type: 'session_reset' })

    if (!enabled) return () => { mounted = false }

    connect()
    loadTools()

    return () => {
      mounted = false
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionId, loadTools, accessToken, enabled])

  const apiBase = sessionId === 'user-default' ? '/api' : `/api/sessions/${sessionId}`

  const sendMessage = useCallback(async (input) => {
    const isSlash = input.startsWith('/')
    const isClear = /^\/clear\b/.test(input)

    // slash 커맨드는 history에 안 들어가므로 pending 불필요
    if (!isSlash) {
      dispatch({ type: 'send_pending', input })
    }

    try {
      const res = await fetchFn(`${apiBase}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json()

      if (isClear) {
        dispatch({ type: 'clear' })
      }

      if (data.type === 'system') {
        dispatch({ type: 'system', content: data.content })
      }

      loadTools()
      return data
    } catch (err) {
      dispatch({ type: 'error', content: err.message })
    }
  }, [apiBase, loadTools, fetchFn])

  const clearMessages = useCallback(() => {
    dispatch({ type: 'clear' })
  }, [])

  const respondApprove = useCallback(async (approved) => {
    await fetchFn(`${apiBase}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
  }, [apiBase, fetchFn])

  const cancel = useCallback(async () => {
    await fetchFn(`${apiBase}/cancel`, { method: 'POST' })
  }, [apiBase, fetchFn])

  return {
    connected, status, turn, messages, streaming, approve, tools, opTrace,
    sendMessage, clearMessages, respondApprove, cancel,
  }
}

export { usePresence }
