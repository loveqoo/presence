import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { highlightJSON } from './CodeView.js'
import { t } from '../../i18n/index.js'

const h = React.createElement

const TAB_KEYS = ['tab_op_chain', 'tab_turn', 'tab_prompt', 'tab_response']

const TranscriptOverlay = ({ debug, lastPrompt, lastResponse, opTrace = [], recalledMemories = [], onClose }) => {
  const [activeTab, setActiveTab] = useState(0)
  const [scrollOffsets, setScrollOffsets] = useState([0, 0, 0, 0])
  const [opDetailed, setOpDetailed] = useState(false)

  // 각 탭: { mode: 'lines', data: [{text,color}] } 또는 { mode: 'elements', data: [ReactElement] }
  const tabContents = [
    { mode: 'lines', data: opDetailed ? buildOpChainDetailedLines(opTrace) : buildOpChainLines(opTrace) },
    { mode: 'lines', data: buildTurnLines(debug, recalledMemories) },
    { mode: 'lines', data: buildPromptLines(lastPrompt) },
    { mode: 'elements', data: buildResponseElements(lastResponse) },
  ]

  const tab = tabContents[activeTab]
  const itemCount = tab.data.length
  const scrollOffset = scrollOffsets[activeTab]

  const setScroll = (fn) =>
    setScrollOffsets(prev => {
      const next = [...prev]
      next[activeTab] = fn(prev[activeTab])
      return next
    })

  useInput((input, key) => {
    if ((key.ctrl && input === 't') || key.escape) { setOpDetailed(false); onClose(); return }
    if (key.ctrl && input === 'o') { setOpDetailed(d => !d); setScroll(() => 0); return }
    if (key.leftArrow) { setActiveTab(v => Math.max(0, v - 1)); return }
    if (key.rightArrow) { setActiveTab(v => Math.min(TAB_KEYS.length - 1, v + 1)); return }
    if (key.upArrow) { setScroll(o => Math.max(0, o - 1)); return }
    if (key.downArrow) { setScroll(o => Math.min(itemCount - 1, o + 1)); return }
    if (key.pageUp) { setScroll(o => Math.max(0, o - viewHeight)); return }
    if (key.pageDown) { setScroll(o => Math.min(Math.max(0, itemCount - viewHeight), o + viewHeight)); return }
    if (key.ctrl && input === 'a') { setScroll(() => 0); return }
    if (key.ctrl && input === 'e') { setScroll(() => Math.max(0, itemCount - 1)); return }
  })

  const viewHeight = Math.max(4, (process.stdout.rows || 24) - 4)
  const visible = tab.data.slice(scrollOffset, scrollOffset + viewHeight)
  const hasMore = itemCount > scrollOffset + viewHeight

  // 탭 바
  const tabBar = TAB_KEYS.map((key, i) => {
    const active = i === activeTab
    return h(Text, {
      key: i,
      bold: active,
      color: active ? 'cyan' : 'gray',
      backgroundColor: active ? 'blackBright' : undefined,
    }, ` ${t(`transcript.${key}`)} `)
  })

  // 탭 컨텐츠 렌더링
  const contentItems = tab.mode === 'lines'
    ? visible.map((line, i) => h(Text, { key: i, color: line.color || undefined }, line.text))
    : visible

  return h(Box, { flexDirection: 'column', height: '100%' },
    h(Box, { paddingX: 1 },
      h(Text, { bold: true, color: 'cyan' }, t('transcript.header')),
      h(Text, { color: 'gray' }, t('transcript.controls')),
    ),
    h(Box, { paddingX: 1, gap: 1 }, ...tabBar),
    h(Box, { flexDirection: 'column', paddingX: 2, flexGrow: 1 }, ...contentItems),
    hasMore
      ? h(Box, { paddingX: 2 }, h(Text, { color: 'gray' }, t('transcript.more_lines', { count: itemCount - scrollOffset - viewHeight })))
      : null,
  )
}

// ─── Tab builders ───

// Op을 논리적 phase로 분류
const classifyPhase = (e) => {
  const { tag, detail } = e
  if (tag === 'UpdateState' && detail === 'turnState') return 'turn'
  if (tag === 'GetState') return 'context'
  if (tag === 'AskLLM') return 'llm'
  if (tag === 'ExecuteTool') return 'tool'
  if (tag === 'Respond') return 'respond'
  if (tag === 'Approve') return 'approve'
  if (tag === 'Delegate') return 'delegate'
  if (tag === 'UpdateState' && detail?.startsWith('_debug')) return 'debug'
  if (tag === 'UpdateState' && (detail === '_streaming' || detail === 'lastTurn' || detail?.startsWith('context.conversation'))) return 'finish'
  if (tag === 'UpdateState') return 'state'
  return 'other'
}

// phase → 사람이 읽기 쉬운 이름
const PHASE_LABELS = {
  turn: 'Turn Transition', context: 'Load Context', llm: 'Ask LLM',
  tool: 'Execute Tool', respond: 'Send Response', approve: 'Await Approval',
  delegate: 'Delegate', debug: 'Save Debug', finish: 'Finish Turn',
  state: 'Update State', other: 'Other',
}

// op → 사람이 읽기 쉬운 라벨
const formatOpLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState' && detail === 'context.memories') return 'Load Memories'
  if (tag === 'GetState' && detail?.includes('conversationHistory')) return 'Load History'
  if (tag === 'GetState') return `Load ${detail || 'state'}`
  if (tag === 'AskLLM') return `Call LLM (${detail || '?'})`
  if (tag === 'ExecuteTool') return `Run ${detail || 'tool'}`
  if (tag === 'Respond') return detail ? `Reply ("${detail}")` : 'Reply'
  if (tag === 'Approve') return `Ask Approval: ${detail || '?'}`
  if (tag === 'Delegate') {
    const label = `Delegate to ${detail || '?'}`
    if (!e.result) return label
    if (e.result.status === 'completed') return `${label} → completed`
    if (e.result.status === 'failed') return `${label} → failed: ${e.result.error || '?'}`
    if (e.result.status === 'submitted') return `${label} → submitted`
    return label
  }
  if (tag === 'UpdateState') {
    if (detail === 'turnState') return 'Set Idle'
    if (detail === '_streaming') return 'Clear Streaming'
    if (detail === 'lastTurn') return 'Record Result'
    if (detail === '_retry') return 'Retry'
    if (detail?.includes('conversationHistory')) return 'Save History'
    if (detail?.startsWith('_debug.')) return `Store ${detail.replace('_debug.', '')}`
    return `Set ${detail || 'state'}`
  }
  return detail ? `${tag}(${detail})` : tag
}

const formatDuration = (ms) => {
  if (ms == null) return '...'
  if (ms < 1) return '< 1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

const add = (lines, text, color) => { lines.push({ text, color: color || null }); return lines }
const blank = (lines) => add(lines, '')

// 기본 뷰: 사용자에게 의미 있는 핵심 흐름만
const VISIBLE_PHASES = new Set(['context', 'llm', 'tool', 'respond', 'approve', 'delegate'])
const VISIBLE_SINGLES = new Set(['_retry']) // phase 밖에서도 단독 표시

function buildOpChainLines(opTrace = []) {
  const lines = []
  if (opTrace.length === 0) { add(lines, t('transcript.no_data'), 'gray'); return lines }

  const totalMs = opTrace.reduce((s, e) => s + (e.duration || 0), 0)
  const maxDur = Math.max(...opTrace.map(e => e.duration || 0))

  // 핵심 항목만 추출 (같은 phase 연속은 첫 번째만)
  const items = []
  let lastContextShown = false
  for (const e of opTrace) {
    const phase = classifyPhase(e)
    if (phase === 'context') {
      if (!lastContextShown) { items.push(e); lastContextShown = true }
      continue
    }
    if (VISIBLE_PHASES.has(phase)) {
      items.push(e)
    } else if (VISIBLE_SINGLES.has(e.detail)) {
      items.push(e)
    }
  }

  // finish 시간 합산 (별도 표시)
  const finishMs = opTrace
    .filter(e => { const p = classifyPhase(e); return p === 'finish' || p === 'turn' })
    .reduce((s, e) => s + (e.duration || 0), 0)

  add(lines, t('transcript.ops_total', { count: opTrace.length, duration: formatDuration(totalMs) }), 'cyan')
  add(lines, t('transcript.detail_view'), 'gray')
  blank(lines)

  for (let i = 0; i < items.length; i++) {
    const e = items[i]
    const isLast = i === items.length - 1 && finishMs < 2
    const connector = isLast ? '└' : '├'
    const label = formatSummaryLabel(e)
    const dur = formatDuration(e.duration)
    const isSlowest = e.duration === maxDur && maxDur > 10 && opTrace.length > 2

    if (e.error) {
      add(lines, `${connector}─ ${label}  ✗ ${e.error}`, 'red')
    } else if (isSlowest) {
      add(lines, `${connector}─ ${label} (${dur})  ${t('transcript.slow')}`, 'yellow')
    } else {
      add(lines, `${connector}─ ${label} (${dur})`)
    }
    // Delegate completed: output 미리보기
    if (e.result?.status === 'completed' && e.result.output) {
      const guide = isLast ? ' ' : '│'
      const out = typeof e.result.output === 'string' ? e.result.output : JSON.stringify(e.result.output)
      const preview = out.length > 70 ? out.slice(0, 67) + '...' : out
      add(lines, `${guide}    ↳ ${preview}`, 'gray')
    }
  }

  // finish 합산
  if (finishMs >= 2) {
    add(lines, `└─ Finish Turn (${formatDuration(finishMs)})`)
  }

  return lines
}

// 요약 라벨: phase + op 정보를 한 줄로
const formatSummaryLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState') return 'Load Context'
  if (tag === 'AskLLM') return 'Ask LLM'
  if (tag === 'ExecuteTool') return `Execute Tool — ${detail || '?'}`
  if (tag === 'Respond') return 'Send Response'
  if (tag === 'Approve') return `Await Approval: ${detail || '?'}`
  if (tag === 'Delegate') {
    const label = `Delegate to ${detail || '?'}`
    if (!e.result) return label
    if (e.result.status === 'completed') {
      const out = e.result.output || ''
      const preview = typeof out === 'string'
        ? (out.length > 40 ? out.slice(0, 37) + '...' : out)
        : JSON.stringify(out).slice(0, 40)
      return `${label} → ${preview}`
    }
    if (e.result.status === 'failed') return `${label} ✗ ${e.result.error || 'failed'}`
    if (e.result.status === 'submitted') return `${label} → submitted`
    return label
  }
  if (tag === 'UpdateState' && detail === '_retry') return 'Retry'
  return formatOpLabel(e)
}

// 상세 뷰: 전체 phase + op 트리
function buildOpChainDetailedLines(opTrace = []) {
  const lines = []
  if (opTrace.length === 0) { add(lines, t('transcript.no_data'), 'gray'); return lines }

  const totalMs = opTrace.reduce((s, e) => s + (e.duration || 0), 0)
  const maxDur = Math.max(...opTrace.map(e => e.duration || 0))

  const phases = []
  let current = null
  for (const e of opTrace) {
    const phase = classifyPhase(e)
    if (!current || current.name !== phase) {
      current = { name: phase, ops: [] }
      phases.push(current)
    }
    current.ops.push(e)
  }

  add(lines, t('transcript.ops_total_detailed', { count: opTrace.length, duration: formatDuration(totalMs) }), 'cyan')
  add(lines, t('transcript.summary_view'), 'gray')
  blank(lines)

  for (let pi = 0; pi < phases.length; pi++) {
    const phase = phases[pi]
    const isLastPhase = pi === phases.length - 1
    const phaseConnector = isLastPhase ? '└' : '├'
    const phaseGuide = isLastPhase ? ' ' : '│'
    const phaseMs = phase.ops.reduce((s, e) => s + (e.duration || 0), 0)
    const hasError = phase.ops.some(e => e.error)
    const phaseLabel = PHASE_LABELS[phase.name] || phase.name
    add(lines, `${phaseConnector}─ ${phaseLabel} (${formatDuration(phaseMs)})`, hasError ? 'red' : null)

    for (let oi = 0; oi < phase.ops.length; oi++) {
      const e = phase.ops[oi]
      const isLastOp = oi === phase.ops.length - 1
      const opConnector = isLastOp ? '└' : '├'
      const label = formatOpLabel(e)
      const dur = formatDuration(e.duration)
      const isSlowest = e.duration === maxDur && maxDur > 10 && opTrace.length > 2

      if (e.error) {
        add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ✗ ${e.error}`, 'red')
      } else if (isSlowest) {
        add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ${dur}  ${t('transcript.slow')}`, 'yellow')
      } else {
        add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ${dur}`)
      }
    }
  }
  return lines
}

const TIER_LABELS = { working: 'W', episodic: 'E', semantic: 'S' }

const formatAge = (ts) => {
  if (!ts) return ''
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

function buildTurnLines(debug, recalledMemories = []) {
  const lines = []
  if (!debug) { add(lines, t('transcript.no_turn_data'), 'gray'); return lines }

  // 1. Input
  add(lines, t('transcript.input'), 'yellow')
  add(lines, `  "${debug.input || '(none)'}"`)
  blank(lines)

  // 2. Result
  add(lines, t('transcript.result'), 'yellow')
  const resultLabel = debug.parsedType === 'direct_response' ? t('transcript.result_direct')
    : debug.parsedType === 'plan' ? t('transcript.result_plan')
    : debug.parsedType || 'unknown'
  const resultColor = debug.error ? 'red' : 'green'
  add(lines, `  ${resultLabel}`, resultColor)
  if (debug.iteration > 0) {
    add(lines, `  ${t('transcript.iterations', { count: debug.iteration + 1, retries: debug.iteration })}`)
  }
  if (debug.error) {
    add(lines, `  Error: ${debug.error}`, 'red')
  }
  blank(lines)

  // 3. Assembly (prompt context budget)
  const assembly = debug.assembly
  if (assembly) {
    const budget = assembly.budget === Infinity ? '∞' : assembly.budget.toLocaleString()
    const used = assembly.used.toLocaleString()
    const pctNum = assembly.budget !== Infinity ? Math.round(assembly.used / assembly.budget * 100) : 0
    add(lines, t('transcript.prompt_budget'), 'yellow')
    add(lines, `  ${t('transcript.budget_used', { used, budget, pct: pctNum })}`)
    if (assembly.historyDropped > 0) {
      add(lines, `  ${t('transcript.history_dropped', { used: assembly.historyUsed, dropped: assembly.historyDropped })}`, 'yellow')
    } else {
      add(lines, `  ${t('transcript.history_included', { count: assembly.historyUsed })}`)
    }
    add(lines, `  ${t('transcript.memories_injected', { count: assembly.memoriesUsed })}`)
    blank(lines)
  }

  // 4. Recalled Memories (메타데이터 포함)
  const mems = recalledMemories.length > 0 ? recalledMemories : (debug.memories || []).map(m => ({ label: m }))
  add(lines, t('transcript.recalled_memories', { count: mems.length }), 'yellow')
  if (mems.length === 0) {
    add(lines, `  ${t('transcript.none')}`, 'gray')
  } else {
    for (let i = 0; i < mems.length; i++) {
      const m = mems[i]
      const label = String(m.label || m)
      const truncLabel = label.length > 60 ? label.slice(0, 57) + '...' : label
      // 메타데이터 태그
      const tags = []
      if (m.tier) tags.push(TIER_LABELS[m.tier] || m.tier)
      if (m.type) tags.push(m.type)
      if (m.createdAt) tags.push(formatAge(m.createdAt))
      const meta = tags.length > 0 ? `  [${tags.join(' · ')}]` : ''
      add(lines, `  ${String(i + 1).padStart(2)}. ${truncLabel}`)
      if (meta) add(lines, `      ${meta}`, 'gray')
    }
  }

  return lines
}

function buildPromptLines(lastPrompt) {
  const lines = []
  if (!lastPrompt || lastPrompt.length === 0) { add(lines, t('transcript.no_prompt_data'), 'gray'); return lines }

  const totalChars = lastPrompt.reduce((s, m) => s + (m.content?.length || 0), 0)
  add(lines, `${lastPrompt.length} messages, ${totalChars} chars`, 'cyan')
  blank(lines)

  for (let i = 0; i < lastPrompt.length; i++) {
    const m = lastPrompt[i]
    const body = m.content || ''
    const roleColor = m.role === 'system' ? 'yellow' : m.role === 'user' ? 'white' : 'green'
    add(lines, `[${i}] ${m.role} (${body.length} chars)`, roleColor)
    // 전체 내용 표시 (줄 단위)
    for (const line of body.split('\n')) {
      add(lines, `  ${line}`)
    }
    blank(lines)
  }
  return lines
}

// Response 탭: React 요소 배열 (토큰별 syntax highlighting)
function buildResponseElements(lastResponse) {
  if (!lastResponse) {
    return [h(Text, { key: 'empty', color: 'gray' }, t('transcript.no_response_data'))]
  }

  // JSON이면 pretty-print
  let formatted = lastResponse
  try {
    const parsed = JSON.parse(lastResponse)
    formatted = JSON.stringify(parsed, null, 2)
  } catch (_) {}

  const maxWidth = Math.max(40, (process.stdout.columns || 80) - 10)
  const srcLines = formatted.split('\n')
  const elements = [
    h(Text, { key: 'header', color: 'cyan' }, `${lastResponse.length} chars`),
    h(Text, { key: 'blank' }, ''),
  ]

  let lineNum = 0
  for (const srcLine of srcLines) {
    lineNum++

    // 긴 줄 분할
    const chunks = srcLine.length <= maxWidth
      ? [srcLine]
      : Array.from({ length: Math.ceil(srcLine.length / maxWidth) }, (_, i) =>
          srcLine.slice(i * maxWidth, (i + 1) * maxWidth))

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci]
      const tokens = highlightJSON(chunk)
      const prefix = ci === 0
        ? `${String(lineNum).padStart(3)} │ `
        : `    │ `

      elements.push(
        h(Box, { key: `${lineNum}-${ci}` },
          h(Text, { color: 'gray' }, prefix),
          ...tokens.map((t, j) =>
            h(Text, { key: j, color: t.color || undefined }, t.text)
          ),
        )
      )
    }
  }

  return elements
}

// Response를 텍스트 lines로 변환 (buildLines 하위 호환용)
function buildResponseFallbackLines(lastResponse) {
  const lines = []
  if (!lastResponse) { add(lines, 'No response data yet.', 'gray'); return lines }
  let formatted = lastResponse
  try { formatted = JSON.stringify(JSON.parse(lastResponse), null, 2) } catch (_) {}
  add(lines, `${lastResponse.length} chars`, 'cyan')
  blank(lines)
  for (const line of formatted.split('\n')) { add(lines, `  ${line}`) }
  return lines
}

// buildLines: 하위 호환용 (테스트, report) — 모두 { text, color } 형태
function buildLines(debug, lastPrompt, lastResponse, opTrace = []) {
  return [
    ...buildOpChainLines(opTrace),
    { text: '', color: null },
    ...buildTurnLines(debug),
    { text: '', color: null },
    ...buildPromptLines(lastPrompt),
    { text: '', color: null },
    ...buildResponseFallbackLines(lastResponse),
  ]
}

export { TranscriptOverlay, buildLines, buildOpChainLines, buildOpChainDetailedLines, buildTurnLines, buildPromptLines, buildResponseElements }
