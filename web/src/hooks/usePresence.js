import { useState, useEffect, useCallback, useRef } from 'react'

// WebSocket 기반 presence 서버 연결 hook
// sessionId: 구독할 세션 (기본 'user-default')
// - WS 메시지는 session_id가 일치하는 것만 반영 (타 세션 오염 방지)
// - onclose에서 3초 후 실제 재연결
// - tools는 세션별 엔드포인트로 로드, 턴 완료 시 갱신

const deriveStatus = (state) => {
  if (state.turnState?.tag === 'working') return 'working'
  if (state.lastTurn?.tag === 'failure') return 'error'
  return 'idle'
}

const usePresence = (sessionId = 'user-default') => {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('idle')
  const [turn, setTurn] = useState(0)
  const [messages, setMessages] = useState([])
  const [streaming, setStreaming] = useState(null)
  const [approve, setApprove] = useState(null)
  const [tools, setTools] = useState([])
  const [opTrace, setOpTrace] = useState([])
  const wsRef = useRef(null)
  const stateRef = useRef({})

  // tools 로드: 세션별 엔드포인트 사용
  const loadTools = useCallback(() => {
    const url = sessionId === 'user-default'
      ? '/api/tools'
      : `/api/sessions/${sessionId}/tools`
    fetch(url).then(r => r.json()).then(setTools).catch(() => {})
  }, [sessionId])

  // WebSocket 연결 (sessionId 변경 시 재구독)
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

      ws.onerror = () => {}  // onclose에서 재연결 처리

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          // 현재 구독 세션과 다른 session_id 무시
          if (data.session_id && data.session_id !== sessionId) return

          if (data.type === 'init') {
            stateRef.current = data.state
            setStatus(deriveStatus(data.state))
            setTurn(data.state.turn || 0)
            setStreaming(data.state._streaming || null)
            setApprove(data.state._approve || null)
            setOpTrace(data.state._debug?.opTrace || [])
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
            }
          }
        } catch (_) {}
      }
    }

    connect()
    loadTools()

    return () => {
      mounted = false
      clearTimeout(reconnectTimer)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [sessionId, loadTools])

  // API base: 세션별 라우트 사용
  const apiBase = sessionId === 'user-default' ? '/api' : `/api/sessions/${sessionId}`

  const sendMessage = useCallback(async (input) => {
    setMessages(prev => [...prev, { role: 'user', content: input }])
    try {
      const res = await fetch(`${apiBase}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: data.type === 'system' ? 'system' : 'agent', content: data.content }])
      // 슬래시 명령(/mcp enable|disable 등)은 agent turn 없이 즉시 반환되므로
      // lastTurn WS push를 기다리지 않고 여기서 tools를 갱신
      loadTools()
      return data
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', content: err.message }])
    }
  }, [apiBase, loadTools])

  const clearMessages = useCallback(() => setMessages([]), [])

  const respondApprove = useCallback(async (approved) => {
    await fetch(`${apiBase}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
  }, [apiBase])

  const cancel = useCallback(async () => {
    await fetch(`${apiBase}/cancel`, { method: 'POST' })
  }, [apiBase])

  return {
    connected, status, turn, messages, streaming, approve, tools, opTrace,
    sendMessage, clearMessages, respondApprove, cancel,
  }
}

export { usePresence }
