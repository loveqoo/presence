import { useState, useEffect, useCallback, useRef, useMemo } from 'react'

// WebSocket 기반 presence 서버 연결 hook
// sessionId: 구독할 세션 (기본 'user-default')

const deriveStatus = (state) => {
  if (state.turnState?.tag === 'working') return 'working'
  if (state.lastTurn?.tag === 'failure') return 'error'
  return 'idle'
}

// conversationHistory → messages 변환
const historyToMessages = (history) => {
  if (!Array.isArray(history)) return []
  const msgs = []
  for (const entry of history) {
    if (entry.input) msgs.push({ role: 'user', content: entry.input })
    if (entry.output) msgs.push({ role: entry.failed ? 'error' : 'agent', content: entry.output })
  }
  return msgs
}

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

  // 3-채널 메시지 모델
  const [historyMessages, setHistoryMessages] = useState([])     // 서버 truth (conversationHistory)
  const [pendingMessages, setPendingMessages] = useState([])     // 로컬 optimistic (user 입력, 에러 응답)
  const [localMessages, setLocalMessages] = useState([])         // system 메시지 (히스토리 밖)

  // 합성: history (서버 truth) + pending (optimistic) + local (system/error)
  const messages = useMemo(() =>
    [...historyMessages, ...pendingMessages, ...localMessages]
  , [historyMessages, pendingMessages, localMessages])

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
            setHistoryMessages(historyToMessages(data.state.context?.conversationHistory))
            setPendingMessages([])
            setLocalMessages([])
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
                setHistoryMessages(historyToMessages(value))
                // history push = 서버 truth 갱신. pending을 모두 비움.
                // finishFailure는 history push가 안 오므로 이 코드가 실행 안 됨 → pending 유지.
                setPendingMessages([])
                break
            }
          }
        } catch (_) {}
      }
    }

    // 세션 전환 시 초기화
    setHistoryMessages([])
    setPendingMessages([])
    setLocalMessages([])

    // enabled=false일 때는 WS 연결하지 않음 (인증 완료 전)
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
    // user 메시지를 pending에 추가 (서버 history 반영 전까지 보임)
    const clientId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    setPendingMessages(prev => [...prev, { role: 'user', content: input, _clientId: clientId }])

    try {
      const res = await fetchFn(`${apiBase}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json()

      // system만 local 채널. agent 성공/실패 모두 history push로 반영.
      if (data.type === 'system') {
        setLocalMessages(prev => [...prev, { role: 'system', content: data.content }])
      }

      loadTools()
      return data
    } catch (err) {
      setLocalMessages(prev => [...prev, { role: 'error', content: err.message }])
    }
  }, [apiBase, loadTools, fetchFn])

  const clearMessages = useCallback(() => {
    setHistoryMessages([])
    setPendingMessages([])
    setLocalMessages([])
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
