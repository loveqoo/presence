import { useState, useEffect, useCallback, useRef } from 'react'
import fp from '@presence/core/lib/fun-fp.js'
import { handle, INITIAL_STATE } from './messageActor.js'

const { Actor } = fp

const deriveStatus = (state) => {
  if (state.turnState?.tag === 'working') return 'working'
  if (state.lastTurn?.tag === 'failure') return 'error'
  return 'idle'
}

/**
 * React hook that connects to the Presence server via WebSocket and mirrors session state.
 * IO only — message state is owned by MessageActor (Actor pattern).
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
  const [messages, setMessages] = useState([])
  const wsRef = useRef(null)
  const stateRef = useRef({})

  // MessageActor — hook 인스턴스당 1회 생성
  const actorRef = useRef(null)
  if (!actorRef.current) actorRef.current = Actor({ init: INITIAL_STATE, handle })
  const actor = actorRef.current

  // subscribe — mount 시 1회 연결
  useEffect(() => actor.subscribe((_result, s) => {
    setMessages([...s.historyMessages, ...s.pendingMessages, ...s.localMessages])
  }), [actor])

  // 세션 전환은 Actor 재생성이 아니라 메시지로 처리
  useEffect(() => {
    actor.send({ type: 'sessionReset' }).fork(() => {}, () => {})
  }, [sessionId, actor])

  // actor.send 헬퍼 — Task를 fire-and-forget
  const send = useCallback((msg) => {
    actor.send(msg).fork(() => {}, () => {})
  }, [actor])

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
            send({ type: 'hydrate', history: data.state.context?.conversationHistory })
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
                send({ type: 'historyPush', history: value })
                break
            }
          }
        } catch (_) {}
      }
    }

    if (!enabled) return () => { mounted = false }

    connect()
    loadTools()

    return () => {
      mounted = false
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionId, loadTools, accessToken, enabled, send])

  const apiBase = sessionId === 'user-default' ? '/api' : `/api/sessions/${sessionId}`

  const sendMessage = useCallback(async (input) => {
    const isSlash = input.startsWith('/')
    const isClear = /^\/clear\b/.test(input)

    // slash 커맨드는 history에 안 들어가므로 pending 불필요
    if (!isSlash) {
      send({ type: 'sendPending', input })
    }

    try {
      const res = await fetchFn(`${apiBase}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json()

      if (isClear) {
        send({ type: 'clear' })
      }

      if (data.type === 'system') {
        send({ type: 'system', content: data.content })
      }

      loadTools()
      return data
    } catch (err) {
      send({ type: 'error', content: err.message })
    }
  }, [apiBase, loadTools, fetchFn, send])

  const clearMessages = useCallback(() => {
    send({ type: 'clear' })
  }, [send])

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
