import { STATE_PATH } from './policies.js'

// =============================================================================
// Repl 슬래시 커맨드 구현. Repl 인스턴스를 받아 실행.
// =============================================================================

const COMMANDS = Object.freeze({
  '/help':   'Show available commands',
  '/status': 'Show agent status',
  '/tools':  'List registered tools',
  '/agents': 'List registered agents',
  '/memory': 'Show recent memories',
  '/todos':  'Show TODO list',
  '/events': 'Show event queue and dead letters',
  '/mcp':    'MCP server management: list / enable <id> / disable <id>',
  '/quit':   'Exit the agent',
  '/exit':   'Exit the agent',
})

const cmdHelp = (repl) => {
  const lines = Object.entries(COMMANDS)
    .map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
    .join('\n')
  repl.emit(`Available commands:\n${lines}`)
}

const cmdStatus = (repl) => {
  const ts = repl.state.get(STATE_PATH.TURN_STATE)
  const lt = repl.state.get(STATE_PATH.LAST_TURN)
  const lines = [
    `turnState: ${ts?.tag || 'unknown'}`,
    `turn: ${repl.state.get(STATE_PATH.TURN) || 0} (session: ${repl.turnCount})`,
    `lastTurn: ${lt ? `${lt.tag}${lt.tag === 'failure' ? ` (${lt.error?.kind})` : ''}` : 'none'}`,
    `events queue: ${(repl.state.get(STATE_PATH.EVENTS_QUEUE) || []).length}`,
    `delegates pending: ${(repl.state.get(STATE_PATH.DELEGATES_PENDING) || []).length}`,
    `todos: ${(repl.state.get(STATE_PATH.TODOS) || []).length}`,
  ]
  repl.emit(lines.join('\n'))
}

const cmdTools = (repl) => {
  const tools = repl.toolRegistry ? repl.toolRegistry.list() : []
  if (tools.length === 0) { repl.emit(repl.t('repl.no_tools')); return }
  const lines = tools.map(tool => `  ${tool.name.padEnd(20)} ${tool.description || ''}`)
  repl.emit(`Tools (${tools.length}):\n${lines.join('\n')}`)
}

const cmdAgents = (repl) => {
  const agents = repl.agentRegistry ? repl.agentRegistry.list() : []
  if (agents.length === 0) { repl.emit(repl.t('repl.no_agents')); return }
  const lines = agents.map(a => `  ${a.name.padEnd(20)} [${a.type}] ${a.description || ''}`)
  repl.emit(`Agents (${agents.length}):\n${lines.join('\n')}`)
}

const cmdMemory = async (repl) => {
  if (!repl.memory) { repl.emit(repl.t('repl.memory_unavailable')); return }
  const nodes = (await repl.memory.allNodes(repl.userId)).slice(-10)
  if (nodes.length === 0) { repl.emit(repl.t('repl.no_memories')); return }
  const lines = nodes.map(node => `  ${node.label}`)
  repl.emit(`Recent memories (${nodes.length}):\n${lines.join('\n')}`)
}

const cmdTodos = (repl) => {
  const todos = repl.state.get(STATE_PATH.TODOS) || []
  if (todos.length === 0) { repl.emit(repl.t('repl.no_todos')); return }
  const lines = todos.map(todo => `  ${todo.done ? '✓' : '○'} [${todo.type}] ${todo.title}`)
  repl.emit(`TODOs (${todos.length}):\n${lines.join('\n')}`)
}

// 이벤트 큐 + dead letters 표시
const formatQueueItem = (event) => `  [${event.type}] ${event.id?.slice(0, 8) || '?'}`
const formatDeadLetter = (event) => `  [${event.type}] ${event.error?.slice(0, 50) || '?'}`

const cmdEvents = (repl) => {
  const queue = repl.state.get(STATE_PATH.EVENTS_QUEUE) || []
  const dl = repl.state.get(STATE_PATH.EVENTS_DEAD_LETTER) || []
  const inFlight = repl.state.get(STATE_PATH.EVENTS_IN_FLIGHT)
  const lines = [
    `queue: ${queue.length} event(s)`,
    ...queue.slice(0, 5).map(formatQueueItem),
    `in-flight: ${inFlight ? `[${inFlight.type}]` : 'none'}`,
    `dead letters: ${dl.length}`,
    ...dl.slice(-3).map(formatDeadLetter),
  ]
  repl.emit(lines.join('\n'))
}

// MCP 서버 관리: list / enable / disable
const formatMcpServer = (server) => `  ${server.enabled ? '●' : '○'} ${server.prefix}  ${server.serverName}  (${server.toolCount} tools)`

const cmdMcp = (repl, input) => {
  if (!repl.mcp || repl.mcp.list().length === 0) { repl.emit('No MCP servers configured.'); return }
  const args = input.trim().split(/\s+/).slice(1)
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const lines = repl.mcp.list().map(formatMcpServer)
    repl.emit(`MCP servers:\n${lines.join('\n')}`)
  } else if (sub === 'enable' || sub === 'disable') {
    const prefix = args[1]
    if (!prefix) { repl.emit(`Usage: /mcp ${sub} <id>  (e.g. mcp0)`); return }
    const ok = sub === 'enable' ? repl.mcp.enable(prefix) : repl.mcp.disable(prefix)
    repl.emit(ok ? `${prefix} ${sub}d.` : `Unknown MCP id: ${prefix}`)
  } else {
    repl.emit('Usage: /mcp [list | enable <id> | disable <id>]')
  }
}

// 커맨드 → 핸들러 디스패치 테이블
const DISPATCH = Object.freeze({
  '/help': cmdHelp, '/status': cmdStatus, '/tools': cmdTools,
  '/agents': cmdAgents, '/memory': cmdMemory, '/todos': cmdTodos,
  '/events': cmdEvents, '/mcp': cmdMcp,
})

export { COMMANDS, DISPATCH }
