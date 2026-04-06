import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'

// =============================================================================
// Server-side slash commands: /chat 엔드포인트에서 slash로 시작하는 입력 처리.
// 반환: { handled: boolean, result?: { type, content } }
// =============================================================================

const mcpCommand = (args, toolRegistry) => {
  const groups = toolRegistry.groups()
  if (groups.length === 0) {
    return { handled: true, result: { type: 'system', content: 'No MCP servers configured.' } }
  }
  const sub = args[0] || 'list'
  if (sub === 'list') {
    const lines = groups.map(s => `${s.enabled ? '●' : '○'} ${s.group}  ${s.serverName}  (${s.toolCount} tools)`)
    return { handled: true, result: { type: 'system', content: `MCP servers:\n${lines.join('\n')}` } }
  }
  if (sub === 'enable' || sub === 'disable') {
    const group = args[1]
    if (!group) return { handled: true, result: { type: 'system', content: `Usage: /mcp ${sub} <id>` } }
    const ok = sub === 'enable' ? toolRegistry.enableGroup(group) : toolRegistry.disableGroup(group)
    return { handled: true, result: { type: 'system', content: ok ? `${group} ${sub}d.` : `Unknown MCP id: ${group}` } }
  }
  return { handled: true, result: { type: 'system', content: 'Usage: /mcp [list | enable <id> | disable <id>]' } }
}

const statusCommand = (state) => {
  const ts = state.get(STATE_PATH.TURN_STATE)
  const lt = state.get(STATE_PATH.LAST_TURN)
  return {
    handled: true,
    result: {
      type: 'system',
      content: `status: ${ts?.tag || 'idle'} | turn: ${state.get(STATE_PATH.TURN) || 0} | last: ${lt?.tag || 'none'}`,
    },
  }
}

const memoryListCommand = (memory) => {
  const nodes = memory.allNodes()
  const summary = nodes.slice(0, 20).map(n => `[${n.type}/${n.tier}] ${n.label}`).join('\n')
  return { handled: true, result: { type: 'system', content: `${nodes.length} nodes:\n${summary}` } }
}

const handleSlashCommand = (input, ctx) => {
  const { state, tools, memory, toolRegistry } = ctx
  if (input.startsWith('/mcp')) return mcpCommand(input.trim().split(/\s+/).slice(1), toolRegistry)
  if (input === '/clear') {
    clearDebugState(state)
    return { handled: true, result: { type: 'system', content: 'Conversation cleared.' } }
  }
  if (input === '/status') return statusCommand(state)
  if (input === '/tools') {
    return { handled: true, result: { type: 'system', content: tools.map(t => t.name).join(', ') || '(none)' } }
  }
  if (input === '/memory list') return memoryListCommand(memory)
  return { handled: false }
}

export { handleSlashCommand }
