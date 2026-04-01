import fp from '../lib/fun-fp.js'
const { identity } = fp

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

class Repl {
  constructor({ agent, onOutput, onError, state, toolRegistry, agentRegistry, memory, mcp, t = identity }) {
    this.agent = agent
    this.onOutput = onOutput
    this.onError = onError
    this.state = state
    this.toolRegistry = toolRegistry
    this.agentRegistry = agentRegistry
    this.memory = memory
    this.mcp = mcp
    this.t = t
    this._running = true
    this._turnCount = 0
  }

  get running() { return this._running }
  get turnCount() { return this._turnCount }
  stop() { this._running = false }

  _output(text) { if (this.onOutput) this.onOutput(text) }

  cmdHelp() {
    const lines = Object.entries(COMMANDS)
      .map(([cmd, desc]) => `  ${cmd.padEnd(12)} ${desc}`)
      .join('\n')
    this._output(`Available commands:\n${lines}`)
  }

  cmdStatus() {
    const ts = this.state.get('turnState')
    const lt = this.state.get('lastTurn')
    const lines = [
      `turnState: ${ts?.tag || 'unknown'}`,
      `turn: ${this.state.get('turn') || 0} (session: ${this._turnCount})`,
      `lastTurn: ${lt ? `${lt.tag}${lt.tag === 'failure' ? ` (${lt.error?.kind})` : ''}` : 'none'}`,
      `events queue: ${(this.state.get('events.queue') || []).length}`,
      `delegates pending: ${(this.state.get('delegates.pending') || []).length}`,
      `todos: ${(this.state.get('todos') || []).length}`,
    ]
    this._output(lines.join('\n'))
  }

  cmdTools() {
    const tools = this.toolRegistry ? this.toolRegistry.list() : []
    if (tools.length === 0) { this._output(this.t('repl.no_tools')); return }
    const lines = tools.map(tool => `  ${tool.name.padEnd(20)} ${tool.description || ''}`)
    this._output(`Tools (${tools.length}):\n${lines.join('\n')}`)
  }

  cmdAgents() {
    const agents = this.agentRegistry ? this.agentRegistry.list() : []
    if (agents.length === 0) { this._output(this.t('repl.no_agents')); return }
    const lines = agents.map(a => `  ${a.name.padEnd(20)} [${a.type}] ${a.description || ''}`)
    this._output(`Agents (${agents.length}):\n${lines.join('\n')}`)
  }

  cmdMemory() {
    if (!this.memory) { this._output(this.t('repl.memory_unavailable')); return }
    const nodes = this.memory.allNodes().slice(-10)
    if (nodes.length === 0) { this._output(this.t('repl.no_memories')); return }
    const lines = nodes.map(n => `  [${n.tier}] ${n.label}${n.vector ? ' 🔢' : ''}`)
    this._output(`Recent memories (${nodes.length}):\n${lines.join('\n')}`)
  }

  cmdTodos() {
    const todos = this.state.get('todos') || []
    if (todos.length === 0) { this._output(this.t('repl.no_todos')); return }
    const lines = todos.map(todo => `  ${todo.done ? '✓' : '○'} [${todo.type}] ${todo.title}`)
    this._output(`TODOs (${todos.length}):\n${lines.join('\n')}`)
  }

  cmdEvents() {
    const queue = this.state.get('events.queue') || []
    const dl = this.state.get('events.deadLetter') || []
    const inFlight = this.state.get('events.inFlight')
    const lines = [
      `queue: ${queue.length} event(s)`,
      ...queue.slice(0, 5).map(e => `  [${e.type}] ${e.id?.slice(0, 8) || '?'}`),
      `in-flight: ${inFlight ? `[${inFlight.type}]` : 'none'}`,
      `dead letters: ${dl.length}`,
      ...dl.slice(-3).map(e => `  [${e.type}] ${e.error?.slice(0, 50) || '?'}`),
    ]
    this._output(lines.join('\n'))
  }

  cmdMcp(input) {
    if (!this.mcp || this.mcp.list().length === 0) { this._output('No MCP servers configured.'); return }
    const args = input.trim().split(/\s+/).slice(1)
    const sub = args[0] || 'list'
    if (sub === 'list') {
      const lines = this.mcp.list().map(s => `  ${s.enabled ? '●' : '○'} ${s.prefix}  ${s.serverName}  (${s.toolCount} tools)`)
      this._output(`MCP servers:\n${lines.join('\n')}`)
    } else if (sub === 'enable' || sub === 'disable') {
      const prefix = args[1]
      if (!prefix) { this._output(`Usage: /mcp ${sub} <id>  (e.g. mcp0)`); return }
      const ok = sub === 'enable' ? this.mcp.enable(prefix) : this.mcp.disable(prefix)
      this._output(ok ? `${prefix} ${sub}d.` : `Unknown MCP id: ${prefix}`)
    } else {
      this._output('Usage: /mcp [list | enable <id> | disable <id>]')
    }
  }

  static _dispatch = {
    '/help': 'cmdHelp', '/status': 'cmdStatus', '/tools': 'cmdTools',
    '/agents': 'cmdAgents', '/memory': 'cmdMemory', '/todos': 'cmdTodos',
    '/events': 'cmdEvents', '/mcp': 'cmdMcp',
    '/quit': 'stop', '/exit': 'stop',
  }

  async handleInput(input) {
    const key = input.split(/\s/)[0]
    const method = Repl._dispatch[key]
    if (method) {
      this[method](input)
      return null
    }

    this._turnCount++
    try {
      const result = await this.agent.run(input)
      this._output(result)
      return result
    } catch (err) {
      if (this.onError) this.onError(err)
      return null
    }
  }
}

export { Repl, COMMANDS }
