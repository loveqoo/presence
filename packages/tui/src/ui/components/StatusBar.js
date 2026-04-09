import React, { useState, useEffect, useRef } from 'react'
import { Box, Text } from 'ink'
import { basename } from 'path'

const h = React.createElement

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const DEFAULT_ITEMS = ['status', 'budget', 'model', 'dir', 'branch']

// status는 항상 표시 (토글 불가), 나머지만 토글 가능
const TOGGLEABLE_ITEMS = ['turn', 'mem', 'tools', 'budget', 'dir', 'branch', 'model']
const ALL_ITEM_KEYS = ['status', ...TOGGLEABLE_ITEMS]

const formatElapsed = (ms) => {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`
}

const budgetColor = (pct) => pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : 'green'

// 단일 item을 segment value로 변환. null이면 표시 안 함.
const buildSegment = (item, ctx) => {
  switch (item) {
    case 'turn':   return `turn: ${ctx.turn}`
    case 'mem':    return `mem: ${ctx.memoryCount}`
    case 'tools':  return `tools: ${ctx.toolCount}`
    case 'budget': return ctx.budgetPct != null ? { type: 'budget', pct: ctx.budgetPct } : null
    case 'dir':    return ctx.dirName || null
    case 'branch': return ctx.gitBranch ? `branch: ${ctx.gitBranch}` : null
    case 'model':  return ctx.model || null
    default:       return null  // 'status' 및 미지의 item
  }
}

const buildSegments = (items, ctx) => items.map(item => buildSegment(item, ctx)).filter(s => s != null)

// segment value를 React Text 요소로 렌더.
const renderSegment = (seg, key) => {
  if (seg && typeof seg === 'object' && seg.type === 'budget') {
    return h(Text, { key, color: budgetColor(seg.pct) }, `budget: ${seg.pct}%`)
  }
  return h(Text, { key, color: 'gray' }, String(seg))
}

// segments 배열을 구분자 포함 React 요소 배열로 변환.
const renderSegments = (segments) => {
  const elements = []
  for (let i = 0; i < segments.length; i++) {
    elements.push(h(Text, { key: `sep-${i}`, color: 'gray' }, ' │ '))
    elements.push(renderSegment(segments[i], `seg-${i}`))
  }
  return elements
}

const buildIndicator = (status, frame, activity, elapsedStr) => {
  if (status === 'working') return h(Text, { color: 'yellow' }, `${SPINNER_FRAMES[frame]} ${activity || 'thinking...'}${elapsedStr}`)
  if (status === 'error') return h(Text, { color: 'red' }, '✗ error')
  return h(Text, { color: 'green' }, '● idle')
}

const StatusBar = (props) => {
  const {
    status = 'idle', turn = 0, memoryCount = 0, activity = null,
    toolCount = 0, cwd = '', gitBranch = '', model = '',
    budgetPct = null, visibleItems = null,
  } = props
  const [frame, setFrame] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(null)

  useEffect(() => {
    if (status !== 'working') {
      startRef.current = null
      setElapsed(0)
      return
    }
    startRef.current = Date.now()
    setElapsed(0)
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length)
      if (startRef.current) setElapsed(Date.now() - startRef.current)
    }, 80)
    return () => clearInterval(timer)
  }, [status])

  const items = visibleItems || DEFAULT_ITEMS
  const elapsedStr = status === 'working' && elapsed > 0 ? ` ${formatElapsed(elapsed)}` : ''
  const indicator = buildIndicator(status, frame, activity, elapsedStr)

  const segments = buildSegments(items, {
    turn, memoryCount, toolCount, budgetPct,
    dirName: cwd ? basename(cwd) : '',
    gitBranch, model,
  })
  const segmentElements = renderSegments(segments)

  return h(Box, { paddingX: 1 }, indicator, ...segmentElements)
}

export { StatusBar, SPINNER_FRAMES, DEFAULT_ITEMS, ALL_ITEM_KEYS, TOGGLEABLE_ITEMS }
