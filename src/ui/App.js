import React, { useState, useCallback, useEffect, useRef } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import { StatusBar, DEFAULT_ITEMS, TOGGLEABLE_ITEMS } from './components/StatusBar.js'
import { ChatArea } from './components/ChatArea.js'
import { InputBar } from './components/InputBar.js'
import { SidePanel } from './components/SidePanel.js'
import { ApprovePrompt } from './components/ApprovePrompt.js'
import { TranscriptOverlay } from './components/TranscriptOverlay.js'
import { useAgentState } from './hooks/useAgentState.js'
import { MarkdownText } from './components/MarkdownText.js'
import { buildReport } from './report.js'
import { t } from '../i18n/index.js'

const h = React.createElement

// --- /memory 커맨드 핸들러 ---

const DURATION_RE = /^(\d+)(d|h|m)$/
const parseDuration = (str) => {
  const m = str.match(DURATION_RE)
  if (!m) return null
  const n = parseInt(m[1])
  if (m[2] === 'd') return n * 86400000
  if (m[2] === 'h') return n * 3600000
  if (m[2] === 'm') return n * 60000
  return null
}

const TIER_SET = new Set(['episodic', 'semantic', 'working'])

const formatAge = (ts) => {
  if (!ts) return '?'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

const handleMemoryCommand = (input, memory, addMessage) => {
  if (!memory) {
    addMessage({ role: 'system', content: t('memory_cmd.not_available') })
    return
  }

  const args = input.slice('/memory'.length).trim()

  // /memory (no args) — summary
  if (!args) {
    const nodes = memory.allNodes()
    const byTier = {}
    for (const n of nodes) {
      byTier[n.tier] = (byTier[n.tier] || 0) + 1
    }
    const parts = Object.entries(byTier).map(([k, v]) => `${k}: ${v}`).join(', ')
    addMessage({ role: 'system', content: t('memory_cmd.summary', { count: nodes.length, detail: parts || t('memory_cmd.empty') }) })
    return
  }

  // /memory help
  if (args === 'help') {
    addMessage({ role: 'system', content: t('memory_cmd.help') })
    return
  }

  // /memory list [tier]
  if (args === 'list' || args.startsWith('list ')) {
    const tierArg = args.slice(4).trim() || null
    let nodes = memory.allNodes()
    if (tierArg && TIER_SET.has(tierArg)) {
      nodes = nodes.filter(n => n.tier === tierArg)
    }
    if (nodes.length === 0) {
      addMessage({ role: 'system', content: t('memory_cmd.not_found') })
      return
    }
    // 최신순 정렬
    nodes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    const lines = nodes.slice(0, 30).map((n, i) => {
      const age = formatAge(n.createdAt)
      const label = String(n.label).length > 50 ? String(n.label).slice(0, 47) + '...' : n.label
      return `${String(i + 1).padStart(3)}. ${label}  [${n.tier} · ${n.type} · ${age}]`
    })
    if (nodes.length > 30) lines.push(`... +${nodes.length - 30} more`)
    addMessage({ role: 'system', content: lines.join('\n') })
    return
  }

  // /memory clear [tier] [age]
  if (args === 'clear' || args.startsWith('clear ')) {
    const clearArgs = args.slice(5).trim().split(/\s+/).filter(Boolean)
    let tier = null
    let maxAgeMs = null

    for (const a of clearArgs) {
      if (TIER_SET.has(a)) tier = a
      else {
        const ms = parseDuration(a)
        if (ms) maxAgeMs = ms
        else {
          addMessage({ role: 'system', content: t('memory_cmd.unknown_arg', { arg: a }) })
          return
        }
      }
    }

    let removed
    if (!tier && !maxAgeMs) {
      removed = memory.clearAll()
    } else if (maxAgeMs) {
      removed = memory.removeOlderThan(maxAgeMs, { tier })
    } else {
      memory.removeNodesByTier(tier)
      removed = '?'
    }

    memory.save().catch(() => {})
    const desc = [tier, maxAgeMs ? `older than ${clearArgs.find(a => DURATION_RE.test(a))}` : null].filter(Boolean).join(', ')
    addMessage({ role: 'system', content: t('memory_cmd.cleared', { count: removed, desc: desc ? ` (${desc})` : '' }) })
    return
  }

  addMessage({ role: 'system', content: t('memory_cmd.unknown_sub') })
}

const App = ({ state, onInput, onApprove, onCancel, agentName = 'Presence', tools = [], agents = [], initialMessages = [], cwd = '', gitBranch = '', model: initialModel = '', config = null, memory = null, llm = null }) => {
  const { exit } = useApp()
  const agentState = useAgentState(state)
  const [messages, setMessages] = useState(initialMessages)
  const [currentModel, setCurrentModel] = useState(initialModel)
  const [showPanel, setShowPanel] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [statusItems, setStatusItems] = useState([...DEFAULT_ITEMS])
  const [toolExpanded, setToolExpanded] = useState(false)

  // App-level key handlers (overlay가 열려있지 않을 때만)
  useInput((input, key) => {
    if (showTranscript) return
    if (key.escape && agentState.status === 'working' && onCancel) {
      onCancel()
    }
    // ESC 중 idle → help 메시지 제거
    if (key.escape && agentState.status !== 'working') {
      setMessages(prev => prev.filter(m => m.tag !== 'help'))
    }
    if (key.ctrl && input === 't') {
      setShowTranscript(true)
    }
    if (key.ctrl && input === 'o') {
      setToolExpanded(prev => !prev)
    }
  })

  const addMessage = useCallback((msg) => {
    setMessages(prev => [...prev, msg])
  }, [])

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
  const toolCountRef = useRef(0)
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

  // 턴 시작 시 _toolResults 초기화 — 이전 턴 결과가 state에 누적되지 않도록
  useEffect(() => {
    if (agentState.status === 'working') {
      if (state) state.set('_toolResults', [])
      toolCountRef.current = 0
    }
  }, [agentState.status, state])

  const handleInput = useCallback((input) => {
    // Slash commands
    if (input === '/quit' || input === '/exit') {
      exit()
      return
    }
    if (input === '/panel') {
      setShowPanel(p => !p)
      return
    }
    if (input === '/clear') {
      setMessages([])
      if (state) {
        state.set('context.conversationHistory', [])
        state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
      }
      return
    }
    if (input === '/help') {
      addMessage({ role: 'system', content: t('help.commands'), tag: 'help' })
      return
    }
    if (input === '/report') {
      const lastPrompt = state ? state.get('_debug.lastPrompt') : null
      const lastResponse = state ? state.get('_debug.lastResponse') : null
      const report = buildReport({
        debug: agentState.debug,
        opTrace: agentState.opTrace,
        lastPrompt,
        lastResponse,
        state,
        config,
      })
      // 파일 저장 + 클립보드 복사
      import('fs').then(({ mkdirSync, writeFileSync }) => {
        import('path').then(({ join }) => {
          import('child_process').then(({ execSync }) => {
            const home = process.env.HOME || process.env.USERPROFILE || '.'
            const dir = join(home, '.presence', 'reports')
            mkdirSync(dir, { recursive: true })
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const filePath = join(dir, `report-${ts}.md`)
            writeFileSync(filePath, report, 'utf-8')
            // macOS pbcopy
            try {
              execSync('pbcopy', { input: report, stdio: ['pipe', 'pipe', 'pipe'] })
              addMessage({ role: 'system', content: `report saved: ${filePath}\n(clipboard copied)` })
            } catch (_) {
              addMessage({ role: 'system', content: `report saved: ${filePath}` })
            }
          })
        })
      }).catch(() => {
        // fallback: 파일 저장 실패 시 콘솔 출력
        addMessage({ role: 'system', content: report })
      })
      return
    }
    if (input === '/status') {
      const lt = agentState.lastTurn
      addMessage({ role: 'system', content: `status: ${agentState.status} | turn: ${agentState.turn} | mem: ${agentState.memoryCount} | last: ${lt?.tag || 'none'}` })
      return
    }
    if (input === '/tools') {
      const list = tools.map(t => t.name).join(', ') || '(none)'
      addMessage({ role: 'system', content: `tools: ${list}` })
      return
    }
    if (input === '/memory' || input.startsWith('/memory ')) {
      handleMemoryCommand(input, memory, addMessage)
      return
    }
    if (input === '/models' || input.startsWith('/models ')) {
      const arg = input.slice('/models'.length).trim()
      if (!llm) { addMessage({ role: 'system', content: t('models_cmd.not_available') }); return }
      if (!arg) {
        // 모델 목록 조회
        addMessage({ role: 'system', content: t('models_cmd.loading') })
        llm.listModels().then(all => {
          const embedModel = config?.embed?.model
          const models = all.filter(m =>
            m !== embedModel && !m.toLowerCase().includes('embed')
          )
          if (models.length === 0) {
            addMessage({ role: 'system', content: t('models_cmd.not_found') })
            return
          }
          const lines = models.map(m => m === currentModel ? `  ● ${m} ${t('models_cmd.current')}` : `    ${m}`)
          addMessage({ role: 'system', content: `${t('models_cmd.available')}\n${lines.join('\n')}` })
        })
      } else {
        // 모델 변경
        llm.setModel(arg)
        setCurrentModel(arg)
        addMessage({ role: 'system', content: t('models_cmd.changed', { model: arg }) })
      }
      return
    }
    if (input === '/todos') {
      const list = agentState.todos.length > 0
        ? agentState.todos.map(t => `• ${t.title || t.type}`).join('\n')
        : '(none)'
      addMessage({ role: 'system', content: `todos:\n${list}` })
      return
    }

    // /statusline command
    if (input.startsWith('/statusline')) {
      const arg = input.slice('/statusline'.length).trim()

      // No argument: show current items
      if (!arg) {
        const visible = statusItems.join(', ')
        const available = TOGGLEABLE_ITEMS.filter(k => !statusItems.includes(k)).join(', ')
        addMessage({
          role: 'system',
          content: `statusline items: ${visible} (status: always on)\navailable: ${available || '(all shown)'}\nusage: /statusline +item  /statusline -item`,
        })
        return
      }

      // +item: add
      if (arg.startsWith('+')) {
        const item = arg.slice(1)
        if (!TOGGLEABLE_ITEMS.includes(item)) {
          addMessage({ role: 'system', content: `unknown item: ${item}. available: ${TOGGLEABLE_ITEMS.join(', ')}` })
          return
        }
        if (statusItems.includes(item)) {
          addMessage({ role: 'system', content: `${item} is already visible` })
          return
        }
        setStatusItems(prev => [...prev, item])
        addMessage({ role: 'system', content: `+${item}` })
        return
      }

      // -item: remove (status는 제거 불가)
      if (arg.startsWith('-')) {
        const item = arg.slice(1)
        if (item === 'status') {
          addMessage({ role: 'system', content: 'status is always visible' })
          return
        }
        if (!statusItems.includes(item)) {
          addMessage({ role: 'system', content: `${item} is not currently visible` })
          return
        }
        setStatusItems(prev => prev.filter(i => i !== item))
        addMessage({ role: 'system', content: `-${item}` })
        return
      }

      addMessage({ role: 'system', content: `usage: /statusline  /statusline +item  /statusline -item` })
      return
    }

    // 일반 입력 → 에이전트 실행
    addMessage({ role: 'user', content: input })

    if (onInput) {
      onInput(input).then(result => {
        if (result != null) {
          addMessage({ role: 'agent', content: String(result) })
        }
      }).catch(err => {
        const isAbort = err.name === 'AbortError' || err.message?.includes('aborted')
        addMessage({
          role: 'system',
          content: isAbort ? t('cancel.cancelled') : `Error: ${err.message}`,
          tag: isAbort ? undefined : 'error',
        })
      })
    }
  }, [onInput, exit, agentState, tools, addMessage, statusItems, currentModel, llm, memory, config, onCancel])

  const handleApprove = useCallback((approved) => {
    if (onApprove) onApprove(approved)
  }, [onApprove])

  const isWorking = agentState.status === 'working'

  // Transcript overlay
  if (showTranscript) {
    const lastPrompt = state ? state.get('_debug.lastPrompt') : null
    const lastResponse = state ? state.get('_debug.lastResponse') : null
    return h(TranscriptOverlay, {
      debug: agentState.debug,
      lastPrompt,
      lastResponse,
      opTrace: agentState.opTrace,
      recalledMemories: agentState.recalledMemories,
      onClose: () => {
        setShowTranscript(false)
        // ink가 이전 프레임 잔상을 남기는 문제 방지: 화면 클리어
        process.stdout.write('\x1b[2J\x1b[H')
      },
    })
  }

  // 스트리밍 표시 — ChatArea agent 메시지와 동일한 스타일 (marginTop + 들여쓰기)
  const streamingView = agentState.streaming
    ? h(Box, { paddingX: 1, paddingLeft: 2, marginTop: 1, flexDirection: 'column' },
        agentState.streaming.content
          ? h(MarkdownText, { content: agentState.streaming.content + '▌' })
          : h(Text, { color: 'gray' }, `receiving ${agentState.streaming.length || 0} chars...`),
      )
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
            agents,
            tools,
            todos: agentState.todos,
            memoryCount: agentState.memoryCount,
            events: agentState.events,
          })
        : null,
    ),
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(InputBar, { onSubmit: handleInput, disabled: isWorking || !!agentState.approve }),
    h(Box, { paddingX: 1 },
      h(Text, { color: 'gray' }, '─'.repeat(Math.max(10, (process.stdout.columns || 80) - 2))),
    ),
    h(StatusBar, {
      status: agentState.status,
      turn: agentState.turn,
      memoryCount: agentState.memoryCount,
      agentName,
      activity: agentState.activity,
      toolCount: tools.length,
      cwd,
      gitBranch,
      model: currentModel,
      budgetPct: agentState.debug?.assembly?.budget && agentState.debug.assembly.budget !== Infinity
        ? Math.round(agentState.debug.assembly.used / agentState.debug.assembly.budget * 100)
        : null,
      visibleItems: statusItems,
    }),
  )
}

export { App }
