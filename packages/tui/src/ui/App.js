import React, { useState, useCallback, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { StatusBar, DEFAULT_ITEMS } from './components/StatusBar.js'
import { ChatArea } from './components/ChatArea.js'
import { InputBar } from './components/InputBar.js'
import { SidePanel } from './components/SidePanel.js'
import { ApprovePrompt } from './components/ApprovePrompt.js'
import { TranscriptOverlay } from './components/TranscriptOverlay.js'
import { useAgentState } from './hooks/useAgentState.js'
import { useAgentMessages } from './hooks/useAgentMessages.js'
import { useSlashCommands } from './hooks/useSlashCommands.js'
import { MarkdownText } from './components/MarkdownText.js'
import { STATE_PATH } from '@presence/core/core/policies.js'

const h = React.createElement

const App = (props) => {
  const {
    state, onInput, onApprove, onCancel,
    agentName = 'Presence', tools = [], agents = [],
    initialMessages = [], cwd = '', gitBranch = '',
    model: initialModel = '', config = null, memory = null,
    llm = null, toolRegistry = null, sessionId = 'user-default',
    onListSessions = null, onCreateSession = null,
    onDeleteSession = null, onSwitchSession = null,
  } = props
  const { exit } = useApp()
  const agentState = useAgentState(state)
  const { messages, setMessages, addMessage, clearTransientMessages } = useAgentMessages(state, agentState, initialMessages)
  const [currentModel, setCurrentModel] = useState(initialModel)
  const [showPanel, setShowPanel] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [statusItems, setStatusItems] = useState([...DEFAULT_ITEMS])
  const [toolExpanded, setToolExpanded] = useState(false)
  const inputHistoryRef = useRef([])

  // Slash commands + 일반 입력 처리
  const handleInput = useSlashCommands({
    state, agentState, config, tools, memory, llm, toolRegistry,
    addMessage, setMessages, clearTransientMessages, exit,
    currentModel, setCurrentModel, setShowPanel, statusItems, setStatusItems,
    sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession,
    onInput,
  })

  // App-level key handlers (overlay가 열려있지 않을 때만)
  useInput((input, key) => {
    if (key.escape && agentState.status === 'working' && onCancel) onCancel()
    if (key.escape && agentState.status !== 'working') clearTransientMessages()
    if (key.ctrl && input === 't') setShowTranscript(true)
    if (key.ctrl && input === 'o') setToolExpanded(prev => !prev)
  }, { isActive: !showTranscript })

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
          : h(Text, { color: 'gray' }, agentState.streaming.status === 'thinking'
            ? 'thinking...'
            : `receiving ${agentState.streaming.length || 0} chars...`),
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
      sessionId,
    }),
  )
}

export { App }
