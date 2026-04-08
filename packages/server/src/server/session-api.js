import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import express from 'express'
import { Config } from '@presence/infra/infra/config.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { clearDebugState } from '@presence/core/core/state-commit.js'
import { STATE_PATH } from '@presence/core/core/policies.js'

// =============================================================================
// Session API: Router를 반환. PresenceServer.#mountRoutes()에서 마운트.
// =============================================================================

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

  status: (_args, { state }) => {
    const turnState = state.get(STATE_PATH.TURN_STATE)
    const lastTurn = state.get(STATE_PATH.LAST_TURN)
    return {
      type: 'system',
      content: `status: ${turnState?.tag || 'idle'} | turn: ${state.get(STATE_PATH.TURN) || 0} | last: ${lastTurn?.tag || 'none'}`,
    }
  },

  tools: (_args, { tools }) => {
    return { type: 'system', content: tools.map(tool => tool.name).join(', ') || '(none)' }
  },

  memory: (args, { memory }) => {
    if (args[0] !== 'list') return null // 미지원 서브커맨드 → 에이전트에 위임
    const nodes = memory.allNodes()
    const summary = nodes.slice(0, 20).map(node => `[${node.type}/${node.tier}] ${node.label}`).join('\n')
    return { type: 'system', content: `${nodes.length} nodes:\n${summary}` }
  },
}

const handleSlashCommand = (input, ctx) => {
  const [command, ...args] = input.slice(1).trim().split(/\s+/)
  const handler = SLASH_COMMANDS[command]
  if (!handler) return { handled: false }
  const result = handler(args, ctx)
  if (!result) return { handled: false } // 핸들러가 null 반환 시 미처리
  return { handled: true, result }
}

// --- Session middleware ---

// :sessionId 미들웨어 — 세션 확보 + 소유권 검증 + req.presenceSession 첨부.
const attachSessionMiddleware = (deps) => {
  const { userContext, getUserContextManager, authEnabled } = deps
  return async (req, res, next) => {
    const sessionId = req.params.sessionId
    const username = req.user?.username
    const userContextManager = getUserContextManager()

    let userCtx = null
    if (authEnabled && username && userContextManager) {
      userCtx = await userContextManager.getOrCreate(username)
      userContextManager.touch(username)
    }

    const effectiveUserContext = userCtx?.userContext || userContext
    const sessions = effectiveUserContext.sessions
    let entry = sessions.get(sessionId)

    // 세션 없으면 자동 생성 ({username}-default 패턴)
    if (!entry && username && sessionId === `${username}-default`) {
      const persistenceCwd = join(Config.presenceDir(), 'users', username)
      entry = sessions.create({ id: sessionId, type: SESSION_TYPE.USER, persistenceCwd, owner: username })
    }
    if (!entry) return res.status(404).json({ error: `Session not found: ${sessionId}` })

    // 인증 활성화 시 소유자 검증
    if (authEnabled && username && entry.owner !== null && entry.owner !== username) {
      return res.status(403).json({ error: 'Access denied: session belongs to another user' })
    }
    req.presenceSession = entry
    req.presenceUserContext = effectiveUserContext
    next()
  }
}

// --- Session endpoints ---

// 세션별 endpoint (chat, state, tools, agents, config, approve, cancel).
const mountSessionEndpoints = (router, deps) => {
  const { userContext } = deps

  router.post('/sessions/:sessionId/chat', async (req, res) => {
    const { session } = req.presenceSession
    const { input } = req.body
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input (string) required' })
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, {
        state: session.state, tools: session.tools,
        memory: userContext.memory, toolRegistry: userContext.toolRegistry,
      })
      if (cmd.handled) return res.json(cmd.result)
    }
    try {
      const result = await session.handleInput(input)
      res.json({ type: 'agent', content: result })
    } catch (err) {
      res.status(500).json({ type: 'error', content: err.message })
    }
  })
  router.get('/sessions/:sessionId/state', (req, res) => res.json(req.presenceSession.session.state.snapshot()))
  router.get('/sessions/:sessionId/tools', (req, res) => {
    const { session } = req.presenceSession
    res.json(session.tools.map(tool => ({ name: tool.name, description: tool.description, source: tool.source })))
  })
  router.get('/sessions/:sessionId/agents', (req, res) => res.json(req.presenceSession.session.agents))
  router.get('/sessions/:sessionId/config', (_req, res) => {
    const { llm, ...rest } = userContext.config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })
  router.post('/sessions/:sessionId/approve', (req, res) => {
    req.presenceSession.session.handleApproveResponse(!!req.body.approved)
    res.json({ ok: true })
  })
  router.post('/sessions/:sessionId/cancel', (req, res) => {
    req.presenceSession.session.handleCancel()
    res.json({ ok: true })
  })
}

// 세션 CRUD: GET/POST/DELETE /sessions[:sessionId]
const mountSessionsCrud = (router, userContext) => {
  router.get('/sessions', (_req, res) => {
    res.json(userContext.sessions.list().map(({ id, type }) => ({ id, type })))
  })
  router.post('/sessions', express.json(), (req, res) => {
    const { type = 'user', id } = req.body || {}
    const owner = req.user?.username ?? null
    const sessionId = id ?? (owner ? `${owner}-${randomUUID()}` : undefined)
    const entry = userContext.sessions.create({ id: sessionId, type, owner })
    res.status(201).json({ id: entry.id, type: entry.type })
  })
  router.delete('/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    if (!userContext.sessions.get(sessionId)) return res.status(404).json({ error: `Session not found: ${sessionId}` })
    await userContext.sessions.destroy(sessionId)
    res.json({ ok: true })
  })
}

const createSessionRouter = (deps) => {
  const router = express.Router()
  router.use('/sessions/:sessionId', express.json(), attachSessionMiddleware(deps))
  mountSessionEndpoints(router, deps)
  mountSessionsCrud(router, deps.userContext)
  return router
}

export { createSessionRouter }
