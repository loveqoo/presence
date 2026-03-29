// identity fallback: t를 주입받지 않으면 key를 그대로 반환
const _identityT = (key) => key

/**
 * Slash command registry. Each entry has a description and a handler(ctx).
 * @type {Object.<string, {description: string, handler: function}>}
 */
const COMMANDS = {
  '/help': {
    description: 'Show available commands',
    handler: ({ onOutput }) => {
      const lines = Object.entries(COMMANDS)
        .map(([cmd, { description }]) => `  ${cmd.padEnd(12)} ${description}`)
        .join('\n')
      onOutput(`Available commands:\n${lines}`)
    },
  },

  '/status': {
    description: 'Show agent status',
    handler: ({ state, onOutput, turnCount }) => {
      const ts = state.get('turnState')
      const lt = state.get('lastTurn')
      const lines = [
        `turnState: ${ts?.tag || 'unknown'}`,
        `turn: ${state.get('turn') || 0} (session: ${turnCount})`,
        `lastTurn: ${lt ? `${lt.tag}${lt.tag === 'failure' ? ` (${lt.error?.kind})` : ''}` : 'none'}`,
        `events queue: ${(state.get('events.queue') || []).length}`,
        `delegates pending: ${(state.get('delegates.pending') || []).length}`,
        `todos: ${(state.get('todos') || []).length}`,
      ]
      onOutput(lines.join('\n'))
    },
  },

  '/tools': {
    description: 'List registered tools',
    handler: ({ toolRegistry, onOutput, t = _identityT }) => {
      const tools = toolRegistry ? toolRegistry.list() : []
      if (tools.length === 0) { onOutput(t('repl.no_tools')); return }
      const lines = tools.map(tool => `  ${tool.name.padEnd(20)} ${tool.description || ''}`)
      onOutput(`Tools (${tools.length}):\n${lines.join('\n')}`)
    },
  },

  '/agents': {
    description: 'List registered agents',
    handler: ({ agentRegistry, onOutput, t = _identityT }) => {
      const agents = agentRegistry ? agentRegistry.list() : []
      if (agents.length === 0) { onOutput(t('repl.no_agents')); return }
      const lines = agents.map(a => `  ${a.name.padEnd(20)} [${a.type}] ${a.description || ''}`)
      onOutput(`Agents (${agents.length}):\n${lines.join('\n')}`)
    },
  },

  '/memory': {
    description: 'Show recent memories',
    handler: ({ memory, onOutput, t = _identityT }) => {
      if (!memory) { onOutput(t('repl.memory_unavailable')); return }
      const nodes = memory.allNodes().slice(-10)
      if (nodes.length === 0) { onOutput(t('repl.no_memories')); return }
      const lines = nodes.map(n =>
        `  [${n.tier}] ${n.label}${n.vector ? ' 🔢' : ''}`
      )
      onOutput(`Recent memories (${nodes.length}):\n${lines.join('\n')}`)
    },
  },

  '/todos': {
    description: 'Show TODO list',
    handler: ({ state, onOutput, t = _identityT }) => {
      const todos = state.get('todos') || []
      if (todos.length === 0) { onOutput(t('repl.no_todos')); return }
      const lines = todos.map(todo =>
        `  ${todo.done ? '✓' : '○'} [${todo.type}] ${todo.title}`
      )
      onOutput(`TODOs (${todos.length}):\n${lines.join('\n')}`)
    },
  },

  '/events': {
    description: 'Show event queue and dead letters',
    handler: ({ state, onOutput }) => {
      const queue = state.get('events.queue') || []
      const dl = state.get('events.deadLetter') || []
      const inFlight = state.get('events.inFlight')
      const lines = [
        `queue: ${queue.length} event(s)`,
        ...queue.slice(0, 5).map(e => `  [${e.type}] ${e.id?.slice(0, 8) || '?'}`),
        `in-flight: ${inFlight ? `[${inFlight.type}]` : 'none'}`,
        `dead letters: ${dl.length}`,
        ...dl.slice(-3).map(e => `  [${e.type}] ${e.error?.slice(0, 50) || '?'}`),
      ]
      onOutput(lines.join('\n'))
    },
  },

  '/mcp': {
    description: 'MCP server management: list / enable <id> / disable <id>',
    handler: ({ mcp, onOutput, input }) => {
      if (!mcp || mcp.list().length === 0) { onOutput('No MCP servers configured.'); return }
      const args = input.trim().split(/\s+/).slice(1)
      const sub = args[0] || 'list'
      if (sub === 'list') {
        const lines = mcp.list().map(s => `  ${s.enabled ? '●' : '○'} ${s.prefix}  ${s.serverName}  (${s.toolCount} tools)`)
        onOutput(`MCP servers:\n${lines.join('\n')}`)
      } else if (sub === 'enable' || sub === 'disable') {
        const prefix = args[1]
        if (!prefix) { onOutput(`Usage: /mcp ${sub} <id>  (e.g. mcp0)`); return }
        const ok = sub === 'enable' ? mcp.enable(prefix) : mcp.disable(prefix)
        onOutput(ok ? `${prefix} ${sub}d.` : `Unknown MCP id: ${prefix}`)
      } else {
        onOutput('Usage: /mcp [list | enable <id> | disable <id>]')
      }
    },
  },

  '/quit': {
    description: 'Exit the agent',
    handler: ({ stop }) => stop(),
  },

  '/exit': {
    description: 'Exit the agent',
    handler: ({ stop }) => stop(),
  },
}

/** @see COMMANDS for slash command definitions */
const createRepl = ({ agent, onOutput, onError, state, toolRegistry, agentRegistry, memory, mcp, t = _identityT }) => {
  let running = true
  let turnCount = 0

  const ctx = (input = '') => ({
    state, toolRegistry, agentRegistry, memory, mcp, input,
    onOutput, turnCount, t,
    stop: () => { running = false },
  })

  const handleInput = async (input) => {
    const cmd = COMMANDS[input.split(/\s/)[0]]
    if (cmd) {
      cmd.handler(ctx(input))
      return null
    }

    turnCount++
    try {
      const result = await agent.run(input)
      if (onOutput) onOutput(result)
      return result
    } catch (err) {
      if (onError) onError(err)
      return null
    }
  }

  return {
    handleInput,
    get running() { return running },
    get turnCount() { return turnCount },
    stop: () => { running = false },
  }
}

export { createRepl, COMMANDS }
