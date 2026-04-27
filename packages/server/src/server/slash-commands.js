import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'
import { formatStatusR } from '@presence/core/core/format-status.js'
import { CheckAccess } from '@presence/core/core/op.js'
import { runCheckAccess } from '@presence/infra/infra/authz/cedar/op-runner.js'
import { isReservedUsername } from '@presence/core/core/agent-id.js'
import { ADMIN_USERNAME } from '@presence/infra/infra/admin-bootstrap.js'

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

  // FP-71 — primary agent 의 persona 조회/변경.
  // show: 현재 name + systemPrompt (없으면 unset). set <text>: systemPrompt 갱신. reset: null 로.
  // governance-cedar v2.9 §X4 — set/reset 시 Cedar 게이트 fail-closed.
  // 31-protect-persona.cedar 가 reservedOwner && !isAdmin 차단. evaluator/jwtSub/agentId
  // 누락 시 (server 외 경로) 도 deny — handleSlashCommand 는 server 에서만 호출.
  persona: (args, ctx) => {
    const { userContext, evaluator, jwtSub, agentId } = ctx
    if (!userContext) return { type: 'system', content: 'Persona command unavailable in this context.' }
    const sub = args[0] || 'show'
    if (sub === 'show') {
      const persona = userContext.getPrimaryPersona()
      const prompt = persona.systemPrompt
      const body = prompt && prompt.length > 0 ? prompt : '(unset — using default role definition)'
      return { type: 'system', content: `Persona: ${persona.name}\n${body}` }
    }
    if (sub === 'set' || sub === 'reset') {
      // Cedar 게이트 — fail-closed. evaluator/jwtSub/agentId 중 하나라도 없으면 deny.
      if (typeof evaluator !== 'function' || !jwtSub || !agentId) {
        return { type: 'system', content: 'Persona change denied: missing-evaluator (server context required)' }
      }
      const ownerPart = agentId.split('/')[0]
      const op = CheckAccess({
        principal: { type: 'LocalUser', id: jwtSub },
        action:    'set_persona',
        resource:  { type: 'Agent', id: agentId },
        context:   { isAdmin: jwtSub === ADMIN_USERNAME, reservedOwner: isReservedUsername(ownerPart) },
      })
      const decision = runCheckAccess(evaluator, op)
      if (decision.decision !== 'allow') {
        return { type: 'system', content: `Persona change denied: ${decision.matchedPolicies?.join(',') || 'cedar-deny'}` }
      }
      if (sub === 'set') {
        const text = args.slice(1).join(' ').trim()
        if (!text) return { type: 'system', content: 'Usage: /persona set <text>' }
        userContext.updatePrimaryPersona({ systemPrompt: text })
        return { type: 'system', content: 'Persona updated. Takes effect next turn.' }
      }
      userContext.updatePrimaryPersona({ systemPrompt: null })
      return { type: 'system', content: 'Persona reset (default role definition).' }
    }
    return { type: 'system', content: 'Usage: /persona [show | set <text> | reset]' }
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
