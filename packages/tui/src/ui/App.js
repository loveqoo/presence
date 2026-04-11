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
import { t } from '@presence/infra/i18n'

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
    disconnected = null,
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
    if (key.escape && agentState.status === 'working' && onCancel) {
      onCancel()
      addMessage({ role: 'system', content: t('key_hint.cancelled') })
      return
    }
    if (key.escape && agentState.status !== 'working') clearTransientMessages()
    if (key.ctrl && input === 't') setShowTranscript(true)
    if (key.ctrl && input === 'o') setToolExpanded(prev => !prev)
  }, { isActive: !showTranscript })

  const handleApprove = useCallback((approved) => {
    if (onApprove) onApprove(approved)
    const desc = agentState.approve?.description ?? ''
    const tag = approved ? t('approve.approved_log') : t('approve.rejected_log')
    addMessage({ role: 'system', content: `${tag} ${desc}` })
  }, [onApprove, agentState.approve, addMessage])

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
          : h(Text, { color: 'gray' }, 'thinking...'),
      )
    : null

  const budgetPct = agentState.debug?.assembly?.budget && agentState.debug.assembly.budget !== Infinity
    ? Math.round(agentState.debug.assembly.used / agentState.debug.assembly.budget * 100)
    : null

  const errorHint = agentState.lastTurn?.tag === 'failure'
    ? (agentState.lastTurn.error?.kind || null)
    : null

  const inputHint = disconnected
    ? t('input_hint.disconnected')
    : agentState.approve
      ? t('input_hint.approve')
      : isWorking
        ? t('input_hint.working')
        : null

  // 키바인딩 힌트 (FP-04/09/25/26): idle 상태에서만 노출. 작업 중/승인/끊김에는
  // InputBar 가 이미 상황별 힌트를 보여주므로 중복 표시를 피한다.
  const hasTransient = messages.some(msg => msg.transient)
  const keyHintLine = disconnected || isWorking || agentState.approve
    ? null
    : hasTransient
      ? `${t('key_hint.idle')} · ${t('key_hint.transient')}`
      : t('key_hint.idle')

  const disconnectedReason = disconnected
    ? disconnected.code === 4001 ? '세션이 만료되었습니다'
    : disconnected.code === 4002 ? '비밀번호 변경이 필요합니다'
    : disconnected.code === 4003 ? '접근이 거부되었습니다'
    : '서버 연결이 끊겼습니다'
    : null
  const disconnectedBanner = disconnected
    ? h(Box, { paddingX: 1, borderStyle: 'double', borderColor: 'red', flexDirection: 'column' },
        h(Text, { color: 'red', bold: true }, `⚠ ${disconnectedReason} (close ${disconnected.code}).`),
        h(Text, { color: 'red' }, 'TUI 를 재시작하세요 (Ctrl+C).'),
      )
    : null

  return h(Box, { flexDirection: 'column', height: '100%' },
    disconnectedBanner,
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
    h(InputBar, { onSubmit: handleInput, disabled: isWorking || !!agentState.approve || !!disconnected, isActive: !showTranscript && !disconnected, hint: inputHint, historyRef: inputHistoryRef }),
    keyHintLine
      ? h(Box, { paddingX: 1 }, h(Text, { color: 'gray' }, keyHintLine))
      : null,
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(StatusBar, {
      status: agentState.status, turn: agentState.turn,
      memoryCount: agentState.memoryCount, agentName,
      activity: agentState.activity, toolCount: tools.length,
      cwd, gitBranch, model: currentModel,
      budgetPct, visibleItems: statusItems,
      sessionId, errorHint,
    }),
  )
}

export { App }
