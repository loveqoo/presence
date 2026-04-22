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
import { STATE_PATH, ERROR_KIND, WS_CLOSE } from '@presence/core/core/policies.js'
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
    disconnected = null, username = null,
  } = props
  const { exit } = useApp()
  const agentState = useAgentState(state)
  const { messages, addTransient, clearTransient, optimisticClearNow } = useAgentMessages(state, agentState, initialMessages)
  const [currentModel, setCurrentModel] = useState(initialModel)
  const [showPanel, setShowPanel] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [statusItems, setStatusItems] = useState([...DEFAULT_ITEMS])
  const [toolExpanded, setToolExpanded] = useState(false)
  // streaming chunk 가 서버 cancel 확정보다 먼저 도착할 수 있음 → flash 억제용.
  const cancelledRef = useRef(false)
  const inputHistoryRef = useRef([])

  // Slash commands + 일반 입력 처리
  const handleInput = useSlashCommands({
    core: { state, agentState, addTransient, clearTransient, optimisticClearNow, exit },
    context: { config, tools, memory, llm, toolRegistry, onInput, username },
    ui: { messages, currentModel, setCurrentModel, setShowPanel, statusItems, setStatusItems },
    session: { sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession },
  })

  // App-level key handlers (overlay가 열려있지 않을 때만).
  // cancel/approve 피드백은 서버 SYSTEM entry 로 기록되므로 여기서는 addMessage 호출하지 않는다.
  useInput((input, key) => {
    if (key.escape && agentState.status === 'working' && onCancel) {
      onCancel()
      cancelledRef.current = true
      return
    }
    if (key.escape && agentState.status !== 'working') clearTransient()
    if (key.ctrl && input === 't') setShowTranscript(true)
    if (key.ctrl && input === 'o') setToolExpanded(prev => !prev)
  }, { isActive: !showTranscript })

  const handleApprove = useCallback((approved) => {
    if (onApprove) onApprove(approved)
    // approve SYSTEM entry 는 서버 turn-controller.handleApproveResponse 가 기록.
  }, [onApprove])

  const isWorking = agentState.status === 'working'

  // FP-15: 스트리밍 content 가 도착한 뒤에는 "thinking" 이 아니라 "응답 중" 으로 전환.
  // activity 는 retry 같은 override 가 있으면 우선이고, 없으면 streaming 유무로 결정.
  // 둘 다 없으면 null → StatusBar 가 기본 "thinking..." 으로 fallback.
  const streamingActive = isWorking && !!agentState.streaming?.content
  const statusActivity = agentState.activity
    || (streamingActive ? t('status.streaming') : null)

  // Transcript overlay
  if (showTranscript) {
    const lastPrompt = state ? state.get(STATE_PATH.DEBUG_LAST_PROMPT) : null
    const lastResponse = state ? state.get(STATE_PATH.DEBUG_LAST_RESPONSE) : null
    return h(TranscriptOverlay, {
      debug: agentState.debug, lastPrompt, lastResponse,
      opTrace: agentState.opTrace, recalledMemories: agentState.recalledMemories,
      iterationHistory: agentState.iterationHistory,
      onClose: () => setShowTranscript(false),
    })
  }

  // cancelled 상태를 다음 턴 시작 시 리셋
  if (isWorking && cancelledRef.current) cancelledRef.current = false

  // FP-58: streamingView 가 null ↔ Box 토글로 프레임 height 흔들림 → 항상 렌더, 비활성 시 공백.
  // cancelled 상태에서는 streaming content 를 표시하지 않음 — 유저 취소 의사 존중.
  const streamingChild = (!cancelledRef.current && agentState.streaming)
    ? agentState.streaming.content
      ? h(MarkdownText, { content: agentState.streaming.content + '▌' })
      : h(Text, { color: 'gray' }, t('streaming.thinking'))
    : h(Text, { color: 'gray' }, ' ')
  const streamingView = h(Box, { paddingX: 1, paddingLeft: 2, marginTop: 1, flexDirection: 'column' }, streamingChild)

  const budgetPct = agentState.debug?.assembly?.budget && agentState.debug.assembly.budget !== Infinity
    ? Math.round(agentState.debug.assembly.used / agentState.debug.assembly.budget * 100)
    : null

  // aborted 는 사용자 의도이므로 error hint 도 표시하지 않음 (status='idle' 로 복귀).
  const errorHint = agentState.lastTurn?.tag === 'failure'
    && agentState.lastTurn.error?.kind !== ERROR_KIND.ABORTED
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
  // FP-58: 조건부로 null 반환 시 프레임 높이가 변동해 Ink 이전 프레임이 잔존 (ghost).
  //        항상 렌더하되, 해당되지 않으면 공백 한 줄로 자리 유지.
  const hasTransient = messages.some(msg => msg.transient)
  const keyHintText = disconnected || isWorking || agentState.approve
    ? ' '
    : hasTransient
      ? `${t('key_hint.idle')} · ${t('key_hint.transient')}`
      : t('key_hint.idle')

  const disconnectedReason = disconnected
    ? disconnected.code === WS_CLOSE.AUTH_FAILED ? '세션이 만료되었습니다'
    : disconnected.code === WS_CLOSE.PASSWORD_CHANGE_REQUIRED ? '비밀번호 변경이 필요합니다'
    : disconnected.code === WS_CLOSE.ORIGIN_NOT_ALLOWED ? '접근이 거부되었습니다'
    : '서버 연결이 끊겼습니다'
    : null
  const disconnectedAction = 'TUI 를 재시작하세요 (Ctrl+C).'
  const disconnectedBanner = disconnected
    ? h(Box, { paddingX: 1, borderStyle: 'double', borderColor: 'red', flexDirection: 'column' },
        h(Text, { color: 'red', bold: true }, `⚠ ${disconnectedReason} (close ${disconnected.code}).`),
        h(Text, { color: 'red' }, disconnectedAction),
      )
    : null

  // FP-58: 루트 `height: '100%'` + 중간 `flexGrow: 1` 제거.
  // 인라인 모드에서는 이 조합이 frame 을 터미널 행 수만큼 강제로 늘려, 매 re-render 마다
  // 30+ 라인 전체를 stdout 으로 다시 쓰며 시각적 깜빡임이 발생한다.
  // 자연 사이징으로 두면 frame 이 실제 콘텐츠 높이만큼만 그려져 깜빡임이 사라진다.
  return h(Box, { flexDirection: 'column' },
    disconnectedBanner,
    h(Box, null,
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
    h(Box, { paddingX: 1 }, h(Text, { color: 'gray' }, keyHintText)),
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(StatusBar, {
      status: agentState.status, turn: agentState.turn,
      memoryCount: agentState.memoryCount, agentName,
      activity: statusActivity, toolCount: tools.length,
      cwd, gitBranch, model: currentModel,
      budgetPct, visibleItems: statusItems,
      sessionId, errorHint,
      reconnecting: agentState.reconnecting && !disconnected,
    }),
  )
}

export { App }
