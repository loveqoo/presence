import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { StatusBar, DEFAULT_ITEMS } from './components/StatusBar.js'
import { ChatArea } from './components/ChatArea.js'
import { InputBar } from './components/InputBar.js'
import { SidePanel } from './components/SidePanel.js'
import { ApprovePrompt } from './components/ApprovePrompt.js'
import { TranscriptOverlay } from './components/TranscriptOverlay.js'
import { useAgentState } from './hooks/useAgentState.js'
import { MarkdownText } from './components/MarkdownText.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'
import { dispatchSlashCommand } from './slash-commands.js'

const h = React.createElement

const App = (props) => {
  const {
    state, onInput, onApprove, onCancel,
    agentName = 'Presence', tools = [], agents = [],
    initialMessages = [], cwd = '', gitBranch = '',
    model: initialModel = '', config = null, memory = null,
    llm = null, mcpControl = null, sessionId = 'user-default',
    onListSessions = null, onCreateSession = null,
    onDeleteSession = null, onSwitchSession = null,
  } = props
  const { exit } = useApp()
  const agentState = useAgentState(state)
  const [messages, setMessages] = useState(initialMessages)
  const [currentModel, setCurrentModel] = useState(initialModel)
  const [showPanel, setShowPanel] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [statusItems, setStatusItems] = useState([...DEFAULT_ITEMS])
  const [toolExpanded, setToolExpanded] = useState(false)
  const inputHistoryRef = useRef([])
  const toolCountRef = useRef(0)

  // App-level key handlers (overlay가 열려있지 않을 때만)
  useInput((input, key) => {
    if (key.escape && agentState.status === 'working' && onCancel) onCancel()
    if (key.escape && agentState.status !== 'working') {
      setMessages(prev => prev.filter(m => m.tag !== 'help'))
    }
    if (key.ctrl && input === 't') setShowTranscript(true)
    if (key.ctrl && input === 'o') setToolExpanded(prev => !prev)
  }, { isActive: !showTranscript })

  const addMessage = useCallback((msg) => {
    setMessages(prev => [...prev, msg])
  }, [])

  // conversationHistory → messages 동기화
  useEffect(() => {
    const history = agentState.conversationHistory
    if (!Array.isArray(history)) return
    const historyMsgs = []
    for (const entry of history) {
      if (entry.input) historyMsgs.push({ role: 'user', content: entry.input })
      if (entry.output) historyMsgs.push({ role: entry.failed ? 'error' : 'agent', content: entry.output })
    }
    setMessages(prev => {
      const localOnly = prev.filter(m => m.role !== 'user' && m.role !== 'agent' && m.role !== 'error')
      return [...historyMsgs, ...localOnly]
    })
  }, [agentState.conversationHistory])

  // Budget warning → system message
  useEffect(() => {
    if (!agentState.budgetWarning) return
    const w = agentState.budgetWarning
    if (w.type === 'history_dropped') {
      addMessage({ role: 'system', content: t('budget.history_dropped', { dropped: w.dropped, pct: w.pct }), tag: 'warning' })
    } else if (w.type === 'high_usage') {
      addMessage({ role: 'system', content: t('budget.high_usage', { pct: w.pct }), tag: 'warning' })
    }
  }, [agentState.budgetWarning, addMessage])

  // Tool result → message conversion
  useEffect(() => {
    const results = agentState.toolResults
    if (results.length > toolCountRef.current) {
      const newResults = results.slice(toolCountRef.current)
      toolCountRef.current = results.length
      for (const tr of newResults) {
        addMessage({ role: 'tool', tool: tr.tool, args: tr.args, result: tr.result })
      }
    }
  }, [agentState.toolResults, addMessage])

  // 턴 시작 시 _toolResults 초기화
  useEffect(() => {
    if (agentState.status === 'working') {
      if (state) state.set(STATE_PATH.TOOL_RESULTS, [])
      toolCountRef.current = 0
    }
  }, [agentState.status, state])

  const handleInput = useCallback((input) => {
    const slashCtx = {
      addMessage, exit, state, agentState, config,
      tools, memory, llm, mcpControl,
      currentModel, setCurrentModel,
      setMessages, setShowPanel, statusItems, setStatusItems,
      sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession,
    }
    if (dispatchSlashCommand(input, slashCtx)) return

    // 일반 입력 → 에이전트 실행
    if (onInput) {
      onInput(input).then(() => {}).catch(err => {
        const isAbort = err.name === 'AbortError' || err.message?.includes('aborted')
        addMessage({
          role: 'system',
          content: isAbort ? t('cancel.cancelled') : `Error: ${err.message}`,
          tag: isAbort ? undefined : 'error',
        })
      })
    }
  }, [onInput, exit, agentState, tools, addMessage, statusItems, currentModel, llm, memory, config, state, mcpControl, sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession])

  const handleApprove = useCallback((approved) => {
    if (onApprove) onApprove(approved)
  }, [onApprove])

  const isWorking = agentState.status === 'working'

  // Transcript overlay
  if (showTranscript) {
    const lastPrompt = state ? state.get(STATE_PATH.DEBUG_LAST_PROMPT) : null
    const lastResponse = state ? state.get(STATE_PATH.DEBUG_LAST_RESPONSE) : null
    return h(TranscriptOverlay, {
      debug: agentState.debug, lastPrompt, lastResponse,
      opTrace: agentState.opTrace, recalledMemories: agentState.recalledMemories,
      onClose: () => {
        setShowTranscript(false)
        process.stdout.write('\x1b[2J\x1b[H')
      },
    })
  }

  const streamingView = agentState.streaming
    ? h(Box, { paddingX: 1, paddingLeft: 2, marginTop: 1, flexDirection: 'column' },
        agentState.streaming.content
          ? h(MarkdownText, { content: agentState.streaming.content + '▌' })
          : h(Text, { color: 'gray' }, `receiving ${agentState.streaming.length || 0} chars...`),
      )
    : null

  const budgetPct = agentState.debug?.assembly?.budget && agentState.debug.assembly.budget !== Infinity
    ? Math.round(agentState.debug.assembly.used / agentState.debug.assembly.budget * 100)
    : null

  return h(Box, { flexDirection: 'column', height: '100%' },
    h(Box, { flexGrow: 1 },
      h(Box, { flexDirection: 'column', flexGrow: 1 },
        h(ChatArea, { messages, toolExpanded }),
        streamingView,
        agentState.approve
          ? h(ApprovePrompt, { description: agentState.approve.description, onResolve: handleApprove })
          : null,
      ),
      showPanel
        ? h(SidePanel, {
            agents, tools,
            todos: agentState.todos,
            memoryCount: agentState.memoryCount,
            events: agentState.events,
          })
        : null,
    ),
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(InputBar, { onSubmit: handleInput, disabled: isWorking || !!agentState.approve, isActive: !showTranscript, historyRef: inputHistoryRef }),
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(StatusBar, {
      status: agentState.status, turn: agentState.turn,
      memoryCount: agentState.memoryCount, agentName,
      activity: agentState.activity, toolCount: tools.length,
      cwd, gitBranch, model: currentModel,
      budgetPct, visibleItems: statusItems,
    }),
  )
}

export { App }
