import { t } from '@presence/infra/i18n'

// /memory [summary|help|list|clear] command handler.

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

const cmdSummary = (memory, addMessage) => {
  const nodes = memory.allNodes()
  const byTier = {}
  for (const n of nodes) byTier[n.tier] = (byTier[n.tier] || 0) + 1
  const parts = Object.entries(byTier).map(([k, v]) => `${k}: ${v}`).join(', ')
  addMessage({ role: 'system', content: t('memory_cmd.summary', { count: nodes.length, detail: parts || t('memory_cmd.empty') }) })
}

const cmdList = (args, memory, addMessage) => {
  const tierArg = args.slice(4).trim() || null
  let nodes = memory.allNodes()
  if (tierArg && TIER_SET.has(tierArg)) nodes = nodes.filter(n => n.tier === tierArg)
  if (nodes.length === 0) { addMessage({ role: 'system', content: t('memory_cmd.not_found') }); return }
  nodes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const lines = nodes.slice(0, 30).map((n, i) => {
    const age = formatAge(n.createdAt)
    const label = String(n.label).length > 50 ? String(n.label).slice(0, 47) + '...' : n.label
    return `${String(i + 1).padStart(3)}. ${label}  [${n.tier} · ${n.type} · ${age}]`
  })
  if (nodes.length > 30) lines.push(`... +${nodes.length - 30} more`)
  addMessage({ role: 'system', content: lines.join('\n') })
}

const cmdClear = (args, memory, addMessage) => {
  const clearArgs = args.slice(5).trim().split(/\s+/).filter(Boolean)
  let tier = null
  let maxAgeMs = null
  for (const a of clearArgs) {
    if (TIER_SET.has(a)) tier = a
    else {
      const ms = parseDuration(a)
      if (ms) maxAgeMs = ms
      else { addMessage({ role: 'system', content: t('memory_cmd.unknown_arg', { arg: a }) }); return }
    }
  }
  let removed
  if (!tier && !maxAgeMs) removed = memory.clearAll()
  else if (maxAgeMs) removed = memory.removeOlderThan(maxAgeMs)
  else { addMessage({ role: 'system', content: t('memory_cmd.tier_requires_age') }); return }
  const desc = [tier, maxAgeMs ? `older than ${clearArgs.find(a => DURATION_RE.test(a))}` : null].filter(Boolean).join(', ')
  addMessage({ role: 'system', content: t('memory_cmd.cleared', { count: removed, desc: desc ? ` (${desc})` : '' }) })
}

const handleMemory = (input, ctx) => {
  const { memory, addMessage } = ctx
  if (!memory) { addMessage({ role: 'system', content: t('memory_cmd.not_available') }); return }
  const args = input.slice('/memory'.length).trim()
  if (!args) return cmdSummary(memory, addMessage)
  if (args === 'help') { addMessage({ role: 'system', content: t('memory_cmd.help') }); return }
  if (args === 'list' || args.startsWith('list ')) return cmdList(args, memory, addMessage)
  if (args === 'clear' || args.startsWith('clear ')) return cmdClear(args, memory, addMessage)
  addMessage({ role: 'system', content: t('memory_cmd.unknown_sub') })
}

export { handleMemory }
