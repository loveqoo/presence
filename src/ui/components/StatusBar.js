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

const StatusBar = ({ status = 'idle', turn = 0, memoryCount = 0, agentName = 'Presence', activity = null, toolCount = 0, cwd = '', gitBranch = '', model = '', budgetPct = null, visibleItems = null }) => {
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

  const indicator = status === 'working'
    ? h(Text, { color: 'yellow' }, `${SPINNER_FRAMES[frame]} ${activity || 'thinking...'}${elapsedStr}`)
    : status === 'error'
      ? h(Text, { color: 'red' }, '✗ error')
      : h(Text, { color: 'green' }, '● idle')

  const dirName = cwd ? basename(cwd) : ''

  // Build dynamic info segments
  const segments = []
  for (const item of items) {
    switch (item) {
      case 'status': break // status is always the indicator, shown separately
      case 'turn': segments.push(`turn: ${turn}`); break
      case 'mem': segments.push(`mem: ${memoryCount}`); break
      case 'tools': segments.push(`tools: ${toolCount}`); break
      case 'budget': if (budgetPct != null) segments.push({ type: 'budget', pct: budgetPct }); break
      case 'dir': if (dirName) segments.push(dirName); break
      case 'branch': if (gitBranch) segments.push(`branch: ${gitBranch}`); break
      case 'model': if (model) segments.push(model); break
    }
  }

  // segments를 React 요소로 변환 (budget은 색상 분기)
  const segmentElements = []
  for (let i = 0; i < segments.length; i++) {
    if (i > 0 || true) segmentElements.push(h(Text, { key: `sep-${i}`, color: 'gray' }, ' │ '))
    const seg = segments[i]
    if (seg && typeof seg === 'object' && seg.type === 'budget') {
      const color = seg.pct >= 95 ? 'red' : seg.pct >= 80 ? 'yellow' : 'green'
      segmentElements.push(h(Text, { key: `seg-${i}`, color }, `budget: ${seg.pct}%`))
    } else {
      segmentElements.push(h(Text, { key: `seg-${i}`, color: 'gray' }, String(seg)))
    }
  }

  return h(Box, { paddingX: 1 },
    indicator,
    ...segmentElements,
  )
}

export { StatusBar, SPINNER_FRAMES, DEFAULT_ITEMS, ALL_ITEM_KEYS, TOGGLEABLE_ITEMS }
