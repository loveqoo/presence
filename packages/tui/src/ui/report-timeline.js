/**
 * Report Timeline Section
 *
 * Op trace 타임라인 렌더링. report-sections.js에서 분리.
 */
import { formatDuration } from './components/transcript/op-chain-format.js'

const formatOpLine = (entry, idx, maxDur, traceLen) => {
  const label = entry.detail ? `${entry.tag}(${entry.detail})` : (entry.tag || '?')
  const tag = label.length > 35 ? label.slice(0, 32) + '...' : label.padEnd(35)
  const dur = (formatDuration(entry.duration) || '?').padStart(10)
  const isSlowest = entry.duration === maxDur && maxDur > 10 && traceLen > 2
  const status = entry.error ? `ERROR: ${entry.error}` : isSlowest ? 'done (slowest)' : 'done'
  return `${String(idx + 1).padStart(3)} ${tag} ${dur} ${status}`
}

const buildTimelineSection = (add, opTrace) => {
  if (!opTrace || opTrace.length === 0) { add('## Timeline'); add('(no op trace)'); return }
  let totalMs = 0, maxDur = 0
  for (const entry of opTrace) { const dur = entry.duration || 0; totalMs += dur; if (dur > maxDur) maxDur = dur }
  add(`## Timeline (${opTrace.length} ops, ${formatDuration(totalMs)})`)
  add('```')
  add(`${'#'.padStart(3)} ${'Op'.padEnd(35)} ${'Duration'.padStart(10)} Status`)
  add(`${'─'.repeat(3)} ${'─'.repeat(35)} ${'─'.repeat(10)} ${'─'.repeat(20)}`)
  for (let i = 0; i < opTrace.length; i++) add(formatOpLine(opTrace[i], i, maxDur, opTrace.length))
  add('```')
}

export { buildTimelineSection }
