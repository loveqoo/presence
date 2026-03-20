import React, { useState, useEffect, useCallback } from 'react'
import { Box, useApp } from 'ink'
import { StatusBar } from './components/StatusBar.js'
import { ChatArea } from './components/ChatArea.js'
import { InputBar } from './components/InputBar.js'

const h = React.createElement

const App = ({ state, onInput, agentName = 'Presence' }) => {
  const { exit } = useApp()
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('idle')
  const [turn, setTurn] = useState(0)
  const [memoryCount, setMemoryCount] = useState(0)

  useEffect(() => {
    if (!state) return

    const onStatus = (val) => setStatus(val)
    const onTurn = (val) => setTurn(val)
    const onMemory = (val) => {
      if (Array.isArray(val)) setMemoryCount(val.length)
    }

    state.hooks.on('status', onStatus)
    state.hooks.on('turn', onTurn)
    state.hooks.on('context.memories', onMemory)

    setStatus(state.get('status') || 'idle')
    setTurn(state.get('turn') || 0)

    return () => {
      state.hooks.off('status', onStatus)
      state.hooks.off('turn', onTurn)
      state.hooks.off('context.memories', onMemory)
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
    h(StatusBar, { status, turn, memoryCount, agentName }),
    h(ChatArea, { messages }),
    h(InputBar, { onSubmit: handleInput }),
  )
}

export { App }
