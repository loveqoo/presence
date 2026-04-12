import { t } from '@presence/infra/i18n'

// /memory [summary|help|list|clear] command handler.

const DURATION_RE = /^(\d+)(d|h|m)$/
const parseDuration = (str) => {
  const match = str.match(DURATION_RE)
  if (!match) return null
  const num = parseInt(match[1])
  if (match[2] === 'd') return num * 86400000
  if (match[2] === 'h') return num * 3600000
  if (match[2] === 'm') return num * 60000
  return null
}

const formatAge = (ts) => {
  if (!ts) return '?'
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

const cmdSummary = async (memory, userId, addMessage) => {
  const nodes = await memory.allNodes(userId)
  addMessage({ role: 'system', content: t('memory_cmd.summary', { count: nodes.length, detail: nodes.length > 0 ? `${nodes.length} nodes` : t('memory_cmd.empty') }), transient: true })
}

const cmdList = async (args, memory, userId, addMessage) => {
  let nodes = await memory.allNodes(userId)
  if (nodes.length === 0) { addMessage({ role: 'system', content: t('memory_cmd.not_found'), transient: true }); return }
  nodes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const lines = nodes.slice(0, 30).map((n, i) => {
    const age = formatAge(n.createdAt)
    const label = String(n.label).length > 50 ? String(n.label).slice(0, 47) + '...' : n.label
    return `${String(i + 1).padStart(3)}. ${label}  [${age}]`
  })
  if (nodes.length > 30) lines.push(`... +${nodes.length - 30} more`)
  addMessage({ role: 'system', content: lines.join('\n'), transient: true })
}

const cmdClear = async (args, memory, userId, addMessage) => {
  const clearArgs = args.slice(5).trim().split(/\s+/).filter(Boolean)
  let maxAgeMs = null
  for (const arg of clearArgs) {
    const ms = parseDuration(arg)
    if (ms) maxAgeMs = ms
    else { addMessage({ role: 'system', content: t('memory_cmd.unknown_arg', { arg }) }); return }
  }
  let removed
  if (!maxAgeMs) removed = await memory.clearAll(userId)
  else removed = await memory.removeOlderThan(userId, maxAgeMs)
  const key = maxAgeMs ? 'memory_cmd.cleared_with_age' : 'memory_cmd.cleared'
  const age = maxAgeMs ? clearArgs.find(a => DURATION_RE.test(a)) : null
  addMessage({ role: 'system', content: t(key, { count: removed, age }), transient: true })
}

const handleMemory = async (input, ctx) => {
  const { memory, userId, addMessage, onInput } = ctx
  // remote 모드: memory가 null이면 서버로 전달
  if (!memory) {
    if (onInput) {
      onInput(input).then(content => { if (content) addMessage({ role: 'system', content, transient: true }) }).catch(() => {})
    } else {
      addMessage({ role: 'system', content: t('memory_cmd.not_available') })
    }
    return
  }
  const args = input.slice('/memory'.length).trim()
  if (!args) return cmdSummary(memory, userId, addMessage)
  if (args === 'help') { addMessage({ role: 'system', content: t('memory_cmd.help') }); return }
  if (args === 'list' || args.startsWith('list ')) return cmdList(args, memory, userId, addMessage)
  if (args === 'clear' || args.startsWith('clear ')) return cmdClear(args, memory, userId, addMessage)
  addMessage({ role: 'system', content: t('memory_cmd.unknown_sub') })
}

export { handleMemory }
