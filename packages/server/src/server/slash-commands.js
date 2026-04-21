import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { formatStatusR } from '@presence/core/core/format-status.js'

// --- Slash commands (테이블 디스패치) ---

const SLASH_COMMANDS = {
  mcp: (args, { toolRegistry }) => {
    const groups = toolRegistry.groups()
    if (groups.length === 0) return { type: 'system', content: 'No MCP servers configured.' }
    const sub = args[0] || 'list'
    if (sub === 'list') {
      const lines = groups.map(group => `${group.enabled ? '●' : '○'} ${group.group}  ${group.serverName}  (${group.toolCount} tools)`)
      return { type: 'system', content: `MCP servers:\n${lines.join('\n')}` }
    }
    if (sub === 'enable' || sub === 'disable') {
      const group = args[1]
      if (!group) return { type: 'system', content: `Usage: /mcp ${sub} <id>` }
      const ok = sub === 'enable' ? toolRegistry.enableGroup(group) : toolRegistry.disableGroup(group)
      return { type: 'system', content: ok ? `${group} ${sub}d.` : `Unknown MCP id: ${group}` }
    }
    return { type: 'system', content: 'Usage: /mcp [list | enable <id> | disable <id>]' }
  },

  clear: (_args, { state }) => {
    clearDebugState(state)
    return { type: 'system', content: 'Conversation cleared.' }
  },

  // 서버 경로: translate 없이 영문 기본값 사용
  status: (_args, { state }) => {
    const turnState = state.get(STATE_PATH.TURN_STATE)
    const lastTurn = state.get(STATE_PATH.LAST_TURN)
    const formatStatus = formatStatusR.run({ translate: null })
    return {
      type: 'system',
      content: formatStatus({
        status: turnState?.tag || 'idle',
        turn: state.get(STATE_PATH.TURN) || 0,
        memoryCount: 0,
        lastTurnTag: lastTurn?.tag,
      }),
    }
  },

  tool: (args, { tools }) => {
    const sub = args[0] || 'list'
    if (sub !== 'list') return { type: 'system', content: 'Usage: /tool list' }
    return { type: 'system', content: tools.map(tool => tool.name).join(', ') || '(none)' }
  },

  memory: async (args, { memory, userId }) => {
    if (args[0] !== 'list') return null // 미지원 서브커맨드 → 에이전트에 위임
    if (!memory) return { type: 'system', content: 'Memory disabled.' }
    const nodes = await memory.allNodes(userId)
    const summary = nodes.slice(0, 20).map(node => node.label).join('\n')
    return { type: 'system', content: `${nodes.length} nodes:\n${summary}` }
  },
}

export const handleSlashCommand = async (input, ctx) => {
  const [command, ...args] = input.slice(1).trim().split(/\s+/)
  const handler = SLASH_COMMANDS[command]
  if (!handler) return { handled: false }
  const result = await handler(args, ctx)
  if (!result) return { handled: false } // 핸들러가 null 반환 시 미처리
  return { handled: true, result }
}
