import { buildReport } from './report.js'
import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { t } from '@presence/infra/i18n'
import { handleMemory } from './slash-commands/memory.js'
import { handleSessions } from './slash-commands/sessions.js'
import { handleStatusline } from './slash-commands/statusline.js'

// =============================================================================
// Slash command dispatch: 입력 문자열 → handler 매핑.
// 각 handler는 (input, ctx) 시그니처. ctx는 React state setters, deps 전달.
// 복잡한 handler는 slash-commands/ 하위 파일에서 import.
// =============================================================================

const handleMcp = (input, ctx) => {
  const { mcpControl, addMessage } = ctx
  if (!mcpControl || mcpControl.list().length === 0) { addMessage({ role: 'system', content: 'No MCP servers configured.' }); return }
  const args = input.trim().split(/\s+/).slice(1)
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const lines = mcpControl.list().map(s => `${s.enabled ? '●' : '○'} ${s.prefix}  ${s.serverName}  (${s.toolCount} tools)`)
    addMessage({ role: 'system', content: `MCP servers:\n${lines.join('\n')}` })
    return
  }
  if (sub === 'enable' || sub === 'disable') {
    const prefix = args[1]
    if (!prefix) { addMessage({ role: 'system', content: `Usage: /mcp ${sub} <id>  (e.g. mcp0)` }); return }
    const ok = sub === 'enable' ? mcpControl.enable(prefix) : mcpControl.disable(prefix)
    addMessage({ role: 'system', content: ok ? `${prefix} ${sub}d.` : `Unknown MCP id: ${prefix}` })
    return
  }
  addMessage({ role: 'system', content: 'Usage: /mcp [list | enable <id> | disable <id>]' })
}

const saveReportToDisk = async (report, addMessage) => {
  try {
    const { mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const home = process.env.HOME || process.env.USERPROFILE || '.'
    const dir = join(home, '.presence', 'reports')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filePath = join(dir, `report-${ts}.md`)
    writeFileSync(filePath, report, 'utf-8')
    try {
      const { execSync } = await import('child_process')
      execSync('pbcopy', { input: report, stdio: ['pipe', 'pipe', 'pipe'] })
      addMessage({ role: 'system', content: `report saved: ${filePath}\n(clipboard copied)` })
    } catch (_) {
      addMessage({ role: 'system', content: `report saved: ${filePath}` })
    }
  } catch (_) {
    addMessage({ role: 'system', content: report })
  }
}

const handleReport = (_input, ctx) => {
  const { state, agentState, config, addMessage } = ctx
  const lastPrompt = state ? state.get(STATE_PATH.DEBUG_LAST_PROMPT) : null
  const lastResponse = state ? state.get(STATE_PATH.DEBUG_LAST_RESPONSE) : null
  const report = buildReport({
    debug: agentState.debug, opTrace: agentState.opTrace,
    iterationHistory: agentState.iterationHistory, lastPrompt, lastResponse, state, config,
  })
  saveReportToDisk(report, addMessage)
}

const handleStatus = (_input, ctx) => {
  const lt = ctx.agentState.lastTurn
  ctx.addMessage({ role: 'system', content: `status: ${ctx.agentState.status} | turn: ${ctx.agentState.turn} | mem: ${ctx.agentState.memoryCount} | last: ${lt?.tag || 'none'}` })
}

const handleToolsList = (_input, ctx) => {
  const list = ctx.tools.map(tool => tool.name).join(', ') || '(none)'
  ctx.addMessage({ role: 'system', content: `tools: ${list}` })
}

const handleTodos = (_input, ctx) => {
  const list = ctx.agentState.todos.length > 0
    ? ctx.agentState.todos.map(x => `• ${x.title || x.type}`).join('\n')
    : '(none)'
  ctx.addMessage({ role: 'system', content: `todos:\n${list}` })
}

const handleModels = (input, ctx) => {
  const { llm, config, currentModel, setCurrentModel, addMessage } = ctx
  const arg = input.slice('/models'.length).trim()
  if (!llm) { addMessage({ role: 'system', content: t('models_cmd.not_available') }); return }
  if (arg) {
    llm.setModel(arg)
    setCurrentModel(arg)
    addMessage({ role: 'system', content: t('models_cmd.changed', { model: arg }) })
    return
  }
  addMessage({ role: 'system', content: t('models_cmd.loading') })
  llm.listModels().then(all => {
    const embedModel = config?.embed?.model
    const models = all.filter(m => m !== embedModel && !m.toLowerCase().includes('embed'))
    if (models.length === 0) { addMessage({ role: 'system', content: t('models_cmd.not_found') }); return }
    const lines = models.map(m => m === currentModel ? `  ● ${m} ${t('models_cmd.current')}` : `    ${m}`)
    addMessage({ role: 'system', content: `${t('models_cmd.available')}\n${lines.join('\n')}` })
  })
}

// --- Dispatch table ---

const commandMap = new Map([
  ['/quit',       (_, ctx) => ctx.exit()],
  ['/exit',       (_, ctx) => ctx.exit()],
  ['/panel',      (_, ctx) => ctx.setShowPanel(p => !p)],
  ['/clear',      (_, ctx) => { ctx.setMessages([]); if (ctx.state) clearDebugState(ctx.state) }],
  ['/help',       (_, ctx) => ctx.addMessage({ role: 'system', content: t('help.commands'), tag: 'help' })],
  ['/mcp',        handleMcp],
  ['/report',     handleReport],
  ['/status',     handleStatus],
  ['/tools',      handleToolsList],
  ['/memory',     handleMemory],
  ['/models',     handleModels],
  ['/todos',      handleTodos],
  ['/sessions',   handleSessions],
  ['/statusline', handleStatusline],
])

// Returns true if input was a slash command (handled).
const dispatchSlashCommand = (input, ctx) => {
  const name = input.trim().split(/\s+/)[0]
  const handler = commandMap.get(name)
  if (!handler) return false
  handler(input, ctx)
  return true
}

export { dispatchSlashCommand }
