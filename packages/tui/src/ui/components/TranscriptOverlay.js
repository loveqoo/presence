import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { t } from '@presence/infra/i18n'
import { buildOpChainLines, buildOpChainDetailedLines } from './transcript/op-chain.js'
import { buildTurnLines } from './transcript/turn.js'
import { buildPromptLines } from './transcript/prompt.js'
import { buildResponseElements, buildResponseFallbackLines } from './transcript/response.js'
import { buildIterationLines } from './transcript/iterations.js'

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
    { mode: 'lines', data: buildIterationLines(iterationHistory) },
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

  // 레이아웃 고정: 깜빡임 방지 — 렌더마다 프레임 총 높이가 일정해야 한다.
  // - 루트에서 `height: '100%'` 제거: 자식 합계로 자연 사이징
  // - 컨텐츠 박스는 `flexGrow` 대신 고정 `height={viewHeight}`
  // - footer 는 항상 렌더, hasMore 아닐 때는 공백 한 줄로 자리 유지
  const footerText = hasMore
    ? t('transcript.more_lines', { count: itemCount - scrollOffset - viewHeight })
    : ' '

  return h(Box, { flexDirection: 'column' },
    h(Box, { paddingX: 1 },
      h(Text, { bold: true, color: 'cyan' }, t('transcript.header')),
      h(Text, { color: 'gray' }, t('transcript.controls')),
    ),
    h(Box, { paddingX: 1, gap: 1 }, ...tabBar),
    h(Box, { flexDirection: 'column', paddingX: 2, height: viewHeight }, ...contentItems),
    h(Box, { paddingX: 2 }, h(Text, { color: 'gray' }, footerText)),
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
