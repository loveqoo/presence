import { useState, useEffect, useCallback, useRef } from 'react'

// WebSocket 기반 presence 서버 연결 hook
// state.hooks.on → WS push를 수신하여 React state에 반영

const deriveStatus = (state) => {
  if (state.turnState?.tag === 'working') return 'working'
  if (state.lastTurn?.tag === 'failure') return 'error'
  return 'idle'
}

const usePresence = () => {
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

  // WebSocket 연결
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => {
      setConnected(false)
      // 자동 재연결 (3초 후)
      setTimeout(() => {
        if (wsRef.current === ws) wsRef.current = null
      }, 3000)
    }

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data)

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
    }

    // 도구 목록 로드
    fetch('/api/tools').then(r => r.json()).then(setTools).catch(() => {})

    return () => { ws.close(); wsRef.current = null }
  }, [])

  // 메시지 전송
  const sendMessage = useCallback(async (input) => {
    setMessages(prev => [...prev, { role: 'user', content: input }])

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: data.type === 'system' ? 'system' : 'agent', content: data.content }])
      return data
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', content: err.message }])
    }
  }, [])

  const clearMessages = useCallback(() => setMessages([]), [])

  const respondApprove = useCallback(async (approved) => {
    await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    })
  }, [])

  const cancel = useCallback(async () => {
    await fetch('/api/cancel', { method: 'POST' })
  }, [])

  return {
    connected, status, turn, messages, streaming, approve, tools, opTrace,
    sendMessage, clearMessages, respondApprove, cancel,
  }
}

export { usePresence }
