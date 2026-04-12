import { buildReport } from './report.js'
import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { formatStatusR } from '@presence/core/core/format-status.js'
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
  const { toolRegistry, addMessage, onInput } = ctx
  // remote 모드: toolRegistry가 null이면 서버로 전달
  if (!toolRegistry) {
    if (onInput) {
      onInput(input).then(content => { if (content) addMessage({ role: 'system', content, transient: true }) }).catch(() => {})
    } else {
      addMessage({ role: 'system', content: t('mcp_cmd.not_configured') })
    }
    return
  }
  const groups = toolRegistry.groups()
  if (groups.length === 0) { addMessage({ role: 'system', content: t('mcp_cmd.not_configured') }); return }
  const args = input.trim().split(/\s+/).slice(1)
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const lines = groups.map(s => `${s.enabled ? '●' : '○'} ${s.group}  ${s.serverName}  (${s.toolCount} tools)`)
    addMessage({ role: 'system', content: `${t('mcp_cmd.header')}\n${lines.join('\n')}` })
    return
  }
  if (sub === 'enable' || sub === 'disable') {
    const group = args[1]
    if (!group) { addMessage({ role: 'system', content: t('mcp_cmd.usage_sub', { sub }) }); return }
    const ok = sub === 'enable' ? toolRegistry.enableGroup(group) : toolRegistry.disableGroup(group)
    const key = ok ? (sub === 'enable' ? 'mcp_cmd.enabled' : 'mcp_cmd.disabled') : 'mcp_cmd.unknown_id'
    addMessage({ role: 'system', content: t(key, { group }) })
    return
  }
  addMessage({ role: 'system', content: t('mcp_cmd.usage') })
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
      addMessage({ role: 'system', content: t('report_cmd.saved_with_clipboard', { path: filePath }) })
    } catch (_) {
      addMessage({ role: 'system', content: t('report_cmd.saved', { path: filePath }) })
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
  ctx.addMessage({
    role: 'system',
    content: formatStatusR.run({ translate: t })({
      status: ctx.agentState.status,
      turn: ctx.agentState.turn,
      memoryCount: ctx.agentState.memoryCount,
      lastTurnTag: lt?.tag,
    }),
    transient: true,
  })
}

const handleToolsList = (_input, ctx) => {
  const list = ctx.tools.map(tool => tool.name).join(', ') || '(none)'
  ctx.addMessage({ role: 'system', content: `tools: ${list}`, transient: true })
}

const handleTodos = (_input, ctx) => {
  const list = ctx.agentState.todos.length > 0
    ? ctx.agentState.todos.map(x => `• ${x.title || x.type}`).join('\n')
    : '(none)'
  ctx.addMessage({ role: 'system', content: `todos:\n${list}`, transient: true })
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

const handleCopy = async (_input, ctx) => {
  const { messages, addMessage } = ctx
  // 마지막 agent 또는 error 응답을 찾아 클립보드에 복사
  const lastResponse = [...messages].reverse().find(msg => msg.role === 'agent' || msg.role === 'error')
  if (!lastResponse) {
    addMessage({ role: 'system', content: t('copy_cmd.empty'), transient: true })
    return
  }
  try {
    const { execSync } = await import('child_process')
    execSync('pbcopy', { input: lastResponse.content, stdio: ['pipe', 'pipe', 'pipe'] })
    addMessage({ role: 'system', content: t('copy_cmd.copied'), transient: true })
  } catch (_) {
    addMessage({ role: 'system', content: lastResponse.content, transient: true })
  }
}

// --- Dispatch table ---

const commandMap = new Map([
  ['/quit',       (_, ctx) => ctx.exit()],
  ['/exit',       (_, ctx) => ctx.exit()],
  ['/panel',      (_, ctx) => ctx.setShowPanel(p => !p)],
  ['/clear',      (_, ctx) => {
    ctx.setMessages([])
    // 서버 state(conversationHistory)도 초기화 → persistence 반영
    if (ctx.onInput) ctx.onInput('/clear').catch(() => {})
  }],
  ['/help',       (_, ctx) => ctx.addMessage({ role: 'system', content: t('help.commands'), transient: true })],
  ['/mcp',        handleMcp],
  ['/report',     handleReport],
  ['/status',     handleStatus],
  ['/tools',      handleToolsList],
  ['/memory',     handleMemory],
  ['/models',     handleModels],
  ['/todos',      handleTodos],
  ['/sessions',   handleSessions],
  ['/statusline', handleStatusline],
  ['/copy',       handleCopy],
])

// Returns Promise<boolean> — true if input was (or looked like) a slash command.
// `/` 로 시작하는 모든 입력은 이 디스패처가 흡수한다. 알 수 없는 커맨드는
// 에이전트로 넘기지 않고 시스템 메시지로 차단 (FP-42).
const dispatchSlashCommand = async (input, ctx) => {
  const name = input.trim().split(/\s+/)[0]
  const handler = commandMap.get(name)
  if (handler) {
    await handler(input, ctx)
    return true
  }
  if (name.startsWith('/')) {
    ctx.addMessage({
      role: 'system',
      content: t('slash_cmd.unknown', { name }),
      transient: true,
      tag: 'error',
    })
    return true
  }
  return false
}

export { dispatchSlashCommand }
