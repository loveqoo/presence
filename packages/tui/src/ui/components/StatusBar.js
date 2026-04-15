import React from 'react'
import { Box, Text } from 'ink'
import { basename } from 'path'
import { t } from '@presence/infra/i18n'

const h = React.createElement

const DEFAULT_ITEMS = ['status', 'session', 'budget', 'model', 'dir', 'branch']

// status는 항상 표시 (토글 불가), 나머지만 토글 가능
const TOGGLEABLE_ITEMS = ['session', 'turn', 'mem', 'tools', 'budget', 'dir', 'branch', 'model']
const ALL_ITEM_KEYS = ['status', ...TOGGLEABLE_ITEMS]

const budgetColor = (pct) => pct >= 95 ? 'red' : pct >= 80 ? 'yellow' : 'green'

// 단일 item을 segment value로 변환. null이면 표시 안 함.
const buildSegment = (item, ctx) => {
  switch (item) {
    case 'session': return ctx.sessionId ? `session: ${ctx.sessionId}` : null
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

// 우선순위: reconnecting > working > error > idle.
// FP-58 실험: spinner 완전 제거. 정적 인디케이터로 re-render 삭제.
const buildIndicator = (ctx) => {
  if (ctx.reconnecting) return h(Text, { color: 'yellow' }, `◌ ${t('status.reconnecting')}`)
  if (ctx.status === 'working') return h(Text, { color: 'yellow' }, `◌ ${ctx.activity || t('status.thinking')}`)
  if (ctx.status === 'error') return h(Text, { color: 'red' }, ctx.errorHint ? `✗ error: ${ctx.errorHint}` : '✗ error')
  return h(Text, { color: 'green' }, '● idle')
}

const StatusBar = (props) => {
  const {
    status = 'idle', turn = 0, memoryCount = 0, activity = null,
    toolCount = 0, cwd = '', gitBranch = '', model = '',
    budgetPct = null, visibleItems = null,
    sessionId = '', errorHint = null, reconnecting = false,
  } = props

  // FP-58: 애니메이션 spinner 제거 — 100ms 주기 setInterval 이 전체 App frame 을
  // 매번 erase+rewrite 하며 깜빡임을 유발했다. 정적 indicator 로 대체.
  // elapsed 도 제거 (turn 번호와 idle/working 상태로 진행 여부는 충분히 식별 가능).
  const items = visibleItems || DEFAULT_ITEMS
  const indicator = buildIndicator({ status, activity, errorHint, reconnecting })

  const segments = buildSegments(items, {
    turn, memoryCount, toolCount, budgetPct,
    dirName: cwd ? basename(cwd) : '',
    gitBranch, model, sessionId,
  })
  const segmentElements = renderSegments(segments)

  return h(Box, { paddingX: 1 }, indicator, ...segmentElements)
}

export { StatusBar, DEFAULT_ITEMS, ALL_ITEM_KEYS, TOGGLEABLE_ITEMS }
