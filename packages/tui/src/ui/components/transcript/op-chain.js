import { t } from '@presence/infra/i18n'
import { formatDuration, classifyPhase, PHASE_LABELS, formatOpLabel, formatSummaryLabel } from './op-chain-format.js'

// =============================================================================
// Op chain tab builders: summary(핵심 흐름만) + detailed(phase별 전체 op).
// =============================================================================

const add = (lines, text, color) => { lines.push({ text, color: color || null }); return lines }
const blank = (lines) => add(lines, '')

// --- Summary view ---

const VISIBLE_PHASES = new Set(['context', 'llm', 'tool', 'respond', 'approve', 'delegate'])
const VISIBLE_SINGLES = new Set(['_retry'])

// VISIBLE_PHASES/VISIBLE_SINGLES에 속한 핵심 항목만. context는 중복 제거.
const pickVisibleItems = (opTrace) => {
  const items = []
  let lastContextShown = false
  for (const e of opTrace) {
    const phase = classifyPhase(e)
    if (phase === 'context') {
      if (!lastContextShown) { items.push(e); lastContextShown = true }
      continue
    }
    if (VISIBLE_PHASES.has(phase)) items.push(e)
    else if (VISIBLE_SINGLES.has(e.detail)) items.push(e)
  }
  return items
}

const sumFinishMs = (opTrace) => opTrace
  .filter(e => { const p = classifyPhase(e); return p === 'finish' || p === 'turn' })
  .reduce((s, e) => s + (e.duration || 0), 0)

// 단일 summary item을 라인으로 변환 + delegate completed preview 추가.
const appendSummaryItem = (lines, e, opts) => {
  const { isLast, dur, maxDur, opTraceLength } = opts
  const connector = isLast ? '└' : '├'
  const label = formatSummaryLabel(e)
  const isSlowest = e.duration === maxDur && maxDur > 10 && opTraceLength > 2

  if (e.error) add(lines, `${connector}─ ${label}  ✗ ${e.error}`, 'red')
  else if (isSlowest) add(lines, `${connector}─ ${label} (${dur})  ${t('transcript.slow')}`, 'yellow')
  else add(lines, `${connector}─ ${label} (${dur})`)

  if (e.result?.status === 'completed' && e.result.output) {
    const guide = isLast ? ' ' : '│'
    const out = typeof e.result.output === 'string' ? e.result.output : JSON.stringify(e.result.output)
    const preview = out.length > 70 ? out.slice(0, 67) + '...' : out
    add(lines, `${guide}    ↳ ${preview}`, 'gray')
  }
}

const buildOpChainLines = (opTrace = []) => {
  const lines = []
  if (opTrace.length === 0) { add(lines, t('transcript.no_data'), 'gray'); return lines }

  const totalMs = opTrace.reduce((s, e) => s + (e.duration || 0), 0)
  const maxDur = Math.max(...opTrace.map(e => e.duration || 0))
  const items = pickVisibleItems(opTrace)
  const finishMs = sumFinishMs(opTrace)

  add(lines, t('transcript.ops_total', { count: opTrace.length, duration: formatDuration(totalMs) }), 'cyan')
  add(lines, t('transcript.detail_view'), 'gray')
  blank(lines)

  for (let i = 0; i < items.length; i++) {
    const isLast = i === items.length - 1 && finishMs < 2
    appendSummaryItem(lines, items[i], {
      isLast, dur: formatDuration(items[i].duration), maxDur, opTraceLength: opTrace.length,
    })
  }
  if (finishMs >= 2) add(lines, `└─ Finish Turn (${formatDuration(finishMs)})`)
  return lines
}

// --- Detailed view ---

const groupOpsByPhase = (opTrace) => {
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
  return phases
}

const appendPhaseBlock = (lines, phase, isLastPhase, maxDur, opTraceLength) => {
  const phaseConnector = isLastPhase ? '└' : '├'
  const phaseGuide = isLastPhase ? ' ' : '│'
  const phaseMs = phase.ops.reduce((s, e) => s + (e.duration || 0), 0)
  const hasError = phase.ops.some(e => e.error)
  const phaseLabel = PHASE_LABELS[phase.name] || phase.name
  add(lines, `${phaseConnector}─ ${phaseLabel} (${formatDuration(phaseMs)})`, hasError ? 'red' : null)

  for (let oi = 0; oi < phase.ops.length; oi++) {
    const e = phase.ops[oi]
    const opConnector = oi === phase.ops.length - 1 ? '└' : '├'
    const label = formatOpLabel(e)
    const dur = formatDuration(e.duration)
    const isSlowest = e.duration === maxDur && maxDur > 10 && opTraceLength > 2
    if (e.error) add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ✗ ${e.error}`, 'red')
    else if (isSlowest) add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ${dur}  ${t('transcript.slow')}`, 'yellow')
    else add(lines, `${phaseGuide}  ${opConnector}─ ${label}  ${dur}`)
  }
}

const buildOpChainDetailedLines = (opTrace = []) => {
  const lines = []
  if (opTrace.length === 0) { add(lines, t('transcript.no_data'), 'gray'); return lines }

  const totalMs = opTrace.reduce((s, e) => s + (e.duration || 0), 0)
  const maxDur = Math.max(...opTrace.map(e => e.duration || 0))
  const phases = groupOpsByPhase(opTrace)

  add(lines, t('transcript.ops_total_detailed', { count: opTrace.length, duration: formatDuration(totalMs) }), 'cyan')
  add(lines, t('transcript.summary_view'), 'gray')
  blank(lines)

  for (let pi = 0; pi < phases.length; pi++) {
    appendPhaseBlock(lines, phases[pi], pi === phases.length - 1, maxDur, opTrace.length)
  }
  return lines
}

export { buildOpChainLines, buildOpChainDetailedLines }
