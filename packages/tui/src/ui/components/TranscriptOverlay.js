import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '@presence/infra/i18n'
import { buildOpChainLines, buildOpChainDetailedLines } from './transcript/op-chain.js'
import { buildTurnLines } from './transcript/turn.js'
import { buildPromptLines } from './transcript/prompt.js'
import { buildResponseElements, buildResponseFallbackLines } from './transcript/response.js'
import { buildIterationElements } from './transcript/iterations.js'

const h = React.createElement

const TAB_KEYS = ['tab_op_chain', 'tab_turn', 'tab_prompt', 'tab_response', 'tab_iterations']

const TranscriptOverlay = (props) => {
  const { debug, lastPrompt, lastResponse, opTrace = [], recalledMemories = [], iterationHistory = [], onClose } = props
  const [activeTab, setActiveTab] = useState(0)
  const [scrollOffsets, setScrollOffsets] = useState([0, 0, 0, 0, 0])
  const [opDetailed, setOpDetailed] = useState(false)

  const viewHeight = Math.max(4, (process.stdout.rows || 24) - 4)

  // 각 탭: { mode: 'lines', data: [{text,color}] } 또는 { mode: 'elements', data: [ReactElement] }
  const tabContents = [
    { mode: 'lines', data: opDetailed ? buildOpChainDetailedLines(opTrace) : buildOpChainLines(opTrace) },
    { mode: 'lines', data: buildTurnLines(debug, recalledMemories) },
    { mode: 'lines', data: buildPromptLines(lastPrompt) },
    { mode: 'elements', data: buildResponseElements(lastResponse) },
    { mode: 'elements', data: buildIterationElements(iterationHistory) },
  ]
  const tab = tabContents[activeTab]
  const itemCount = tab.data.length
  const scrollOffset = scrollOffsets[activeTab]

  const setScroll = (fn) => setScrollOffsets(prev => {
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

  const visible = tab.data.slice(scrollOffset, scrollOffset + viewHeight)
  const hasMore = itemCount > scrollOffset + viewHeight

  const tabBar = TAB_KEYS.map((key, i) => {
    const active = i === activeTab
    return h(Text, {
      key: i, bold: active,
      color: active ? 'cyan' : 'gray',
      backgroundColor: active ? 'blackBright' : undefined,
    }, ` ${t(`transcript.${key}`)} `)
  })

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

// 하위 호환용 (테스트, report) — 4개 tab builder를 순차 호출해 { text, color } 배열 반환.
const buildLines = (debug, lastPrompt, lastResponse, opTrace = []) => [
  ...buildOpChainLines(opTrace),
  { text: '', color: null },
  ...buildTurnLines(debug),
  { text: '', color: null },
  ...buildPromptLines(lastPrompt),
  { text: '', color: null },
  ...buildResponseFallbackLines(lastResponse),
]

export { TranscriptOverlay, buildLines }
