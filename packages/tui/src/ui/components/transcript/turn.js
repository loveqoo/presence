import { t } from '@presence/infra/i18n'

// =============================================================================
// Turn tab: 입력·결과·프롬프트 예산·회수된 메모리 요약.
// =============================================================================

const add = (lines, text, color) => { lines.push({ text, color: color || null }); return lines }
const blank = (lines) => add(lines, '')

const formatAge = (ts) => {
  if (!ts) return ''
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

const appendInputBlock = (lines, debug) => {
  add(lines, t('transcript.input'), 'yellow')
  add(lines, `  "${debug.input || '(none)'}"`)
  blank(lines)
}

const appendResultBlock = (lines, debug) => {
  add(lines, t('transcript.result'), 'yellow')
  const resultLabel = debug.parsedType === 'direct_response' ? t('transcript.result_direct')
    : debug.parsedType === 'plan' ? t('transcript.result_plan')
    : debug.parsedType || 'unknown'
  const resultColor = debug.error ? 'red' : 'green'
  add(lines, `  ${resultLabel}`, resultColor)
  if (debug.iteration > 0) {
    add(lines, `  ${t('transcript.iterations', { count: debug.iteration + 1, retries: debug.iteration })}`)
  }
  if (debug.error) add(lines, `  Error: ${debug.error}`, 'red')
  blank(lines)
}

const appendAssemblyBlock = (lines, assembly) => {
  if (!assembly) return
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

const formatMemoryMeta = (m) => {
  if (m.createdAt) return `  [${formatAge(m.createdAt)}]`
  return ''
}

const appendMemoriesBlock = (lines, mems) => {
  add(lines, t('transcript.recalled_memories', { count: mems.length }), 'yellow')
  if (mems.length === 0) { add(lines, `  ${t('transcript.none')}`, 'gray'); return }
  for (let i = 0; i < mems.length; i++) {
    const m = mems[i]
    const label = String(m.label || m)
    const truncLabel = label.length > 60 ? label.slice(0, 57) + '...' : label
    const meta = formatMemoryMeta(m)
    add(lines, `  ${String(i + 1).padStart(2)}. ${truncLabel}`)
    if (meta) add(lines, `      ${meta}`, 'gray')
  }
}

const buildTurnLines = (debug, recalledMemories = []) => {
  const lines = []
  if (!debug) { add(lines, t('transcript.no_turn_data'), 'gray'); return lines }
  appendInputBlock(lines, debug)
  appendResultBlock(lines, debug)
  appendAssemblyBlock(lines, debug.assembly)
  const mems = recalledMemories.length > 0 ? recalledMemories : (debug.memories || []).map(m => ({ label: m }))
  appendMemoriesBlock(lines, mems)
  return lines
}

export { buildTurnLines }
