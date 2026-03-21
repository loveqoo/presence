import React, { useState, useEffect, useCallback } from 'react'
import { Box, useApp } from 'ink'
import { StatusBar } from './components/StatusBar.js'
import { ChatArea } from './components/ChatArea.js'
import { InputBar } from './components/InputBar.js'

const h = React.createElement

const deriveStatus = (state) => {
  const ts = state.get('turnState')
  if (ts && ts.tag === 'working') return 'working'
  const lt = state.get('lastTurn')
  if (lt && lt.tag === 'failure') return 'error'
  return 'idle'
}

const deriveMemoryCount = (state) => {
  const mems = state.get('context.memories')
  return Array.isArray(mems) ? mems.length : 0
}

const App = ({ state, onInput, agentName = 'Presence' }) => {
  const { exit } = useApp()
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('idle')
  const [turn, setTurn] = useState(0)
  const [memoryCount, setMemoryCount] = useState(0)
  const [activity, setActivity] = useState(null)

  useEffect(() => {
    if (!state) return

    const onTurnState = (phase) => {
      setStatus(deriveStatus(state))
      setActivity(phase.tag === 'working' ? 'thinking...' : null)
    }
    const onLastTurn = () => setStatus(deriveStatus(state))
    const onTurn = (val) => setTurn(val)
    const onMemory = (val) => {
      if (Array.isArray(val)) setMemoryCount(val.length)
    }
    const onRetry = (info) => {
      setActivity(`retry ${info.attempt}/${info.maxRetries}...`)
    }

    state.hooks.on('turnState', onTurnState)
    state.hooks.on('lastTurn', onLastTurn)
    state.hooks.on('turn', onTurn)
    state.hooks.on('context.memories', onMemory)
    state.hooks.on('_retry', onRetry)

    setStatus(deriveStatus(state))
    setTurn(state.get('turn') || 0)
    setMemoryCount(deriveMemoryCount(state))

    return () => {
      state.hooks.off('turnState', onTurnState)
      state.hooks.off('lastTurn', onLastTurn)
      state.hooks.off('turn', onTurn)
      state.hooks.off('context.memories', onMemory)
      state.hooks.off('_retry', onRetry)
    }
  }, [state])

  const handleInput = useCallback((input) => {
    if (input === '/quit' || input === '/exit') {
      exit()
      return
    }

    setMessages(prev => [...prev, { role: 'user', content: input }])

    if (onInput) {
      onInput(input).then(result => {
        if (result) {
          setMessages(prev => [...prev, { role: 'agent', content: String(result) }])
        }
      }).catch(err => {
        setMessages(prev => [...prev, { role: 'system', content: `Error: ${err.message}`, tag: '에러' }])
      })
    }
  }, [onInput, exit])

  return h(Box, { flexDirection: 'column', height: '100%' },
    h(StatusBar, { status, turn, memoryCount, agentName, activity }),
    h(ChatArea, { messages }),
    h(InputBar, { onSubmit: handleInput }),
  )
}

export { App, deriveStatus, deriveMemoryCount }
