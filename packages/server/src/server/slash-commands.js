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
      // Phase 22 Step C — 공용/개인 그룹화 (ux-guardian 권장)
      const fmt = (g) => `  ${g.enabled ? '●' : '○'} ${g.group}  ${g.serverName}  (${g.toolCount} tools)`
      const server = groups.filter(g => g.origin === 'server')
      const user = groups.filter(g => g.origin === 'user')
      const other = groups.filter(g => g.origin !== 'server' && g.origin !== 'user')
      let body
      if (server.length === 0 || user.length === 0) {
        body = groups.map(g => fmt(g).trimStart()).join('\n')
      } else {
        const parts = ['[공용]', ...server.map(fmt), '[개인]', ...user.map(fmt), ...other.map(g => fmt(g).trimStart())]
        body = parts.join('\n')
      }
      return { type: 'system', content: `MCP servers:\n${body}` }
    }
    if (sub === 'enable' || sub === 'disable') {
      const group = args[1]
      if (!group) return { type: 'system', content: `Usage: /mcp ${sub} <id>` }
      // Phase 22 Step D — 공용(server origin) MCP 는 user 관리 action 차단
      const target = groups.find(g => g.group === group)
      if (target && target.origin === 'server') {
        return { type: 'system', content: `${group} is a public MCP (managed by admin — cannot be changed by users)` }
      }
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

  memory: async (args, { memory, agentId }) => {
    if (args[0] !== 'list') return null // 미지원 서브커맨드 → 에이전트에 위임
    if (!memory) return { type: 'system', content: 'Memory disabled.' }
    const nodes = await memory.allNodes(agentId)
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
