import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
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

// --- 세션 검색/생성 공용 로직 ---

// 유저별 컨텍스트에서 세션 검색 + 글로벌 agent fallback + lazy 생성.
// REST(attachSessionMiddleware)와 WS(handleJoin) 양쪽에서 사용.
const findOrCreateSession = (sessionId, username, effectiveUserContext, globalUserContext) => {
  let entry = effectiveUserContext.sessions.get(sessionId)

  // 유저 컨텍스트에 없으면 글로벌 agent 세션에서 검색
  if (!entry) {
    const globalEntry = globalUserContext.sessions.get(sessionId)
    if (globalEntry && globalEntry.type === SESSION_TYPE.AGENT) entry = globalEntry
  }

  // 세션 없으면 자동 생성 ({username}-default 패턴)
  if (!entry && username && sessionId === `${username}-default`) {
    const userDir = join(Config.resolveDir(), 'users', username)
    const persistenceCwd = join(userDir, 'sessions', sessionId)
    // 레거시 경로(users/{username}/state.json) → 새 경로 마이그레이션
    const legacyState = join(userDir, 'state.json')
    if (existsSync(legacyState) && !existsSync(join(persistenceCwd, 'state.json'))) {
      mkdirSync(persistenceCwd, { recursive: true })
      renameSync(legacyState, join(persistenceCwd, 'state.json'))
    }
    entry = effectiveUserContext.sessions.create({ id: sessionId, type: SESSION_TYPE.USER, persistenceCwd, owner: username })
  }

  return entry
}

// --- Session middleware ---

// :sessionId 미들웨어 — 세션 확보 + 소유권 검증 + req.presenceSession 첨부.
const attachSessionMiddleware = (deps) => {
  return async (req, res, next) => {
    const sessionId = req.params.sessionId
    const username = req.user?.username
    const { authEnabled } = deps

    const effectiveUserContext = await resolveUserContext(req, deps)
    const entry = findOrCreateSession(sessionId, username, effectiveUserContext, deps.userContext)
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
    const effectiveCtx = req.presenceUserContext || userContext
    const { input } = req.body
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input (string) required' })
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, {
        state: session.state, tools: session.tools,
        memory: effectiveCtx.memory, toolRegistry: effectiveCtx.toolRegistry,
      })
      if (cmd.handled) {
        // state 변경 커맨드(/clear 등) 후 persistence flush
        session.flushPersistence().catch(() => {})
        return res.json(cmd.result)
      }
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
  router.get('/sessions/:sessionId/config', (req, res) => {
    const ctx = req.presenceUserContext || userContext
    const { llm, ...rest } = ctx.config
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

// 유저별 effectiveUserContext 해석 — attachSessionMiddleware와 동일 로직
const resolveUserContext = async (req, deps) => {
  const { userContext, getUserContextManager, authEnabled } = deps
  const username = req.user?.username
  const userContextManager = getUserContextManager()
  if (authEnabled && username && userContextManager) {
    const userCtx = await userContextManager.getOrCreate(username)
    userContextManager.touch(username)
    return userCtx?.userContext || userContext
  }
  return userContext
}

// 세션 CRUD: GET/POST/DELETE /sessions[:sessionId]
const mountSessionsCrud = (router, deps) => {
  router.get('/sessions', async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const userSessions = ctx.sessions.list()
    // 글로벌 agent 세션도 포함 (유저별 컨텍스트와 글로벌이 다른 경우)
    const globalSessions = deps.userContext.sessions.list()
    const agentSessions = globalSessions.filter(s => s.type === SESSION_TYPE.AGENT)
    const userIds = new Set(userSessions.map(s => s.id))
    const merged = [...userSessions, ...agentSessions.filter(s => !userIds.has(s.id))]
    res.json(merged.map(({ id, type }) => ({ id, type })))
  })
  router.post('/sessions', express.json(), async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const { type = 'user', id } = req.body || {}
    const owner = req.user?.username ?? null
    const sessionId = id ?? (owner ? `${owner}-${randomUUID()}` : undefined)
    const persistenceCwd = owner ? join(Config.resolveDir(), 'users', owner, 'sessions', sessionId) : undefined
    const entry = ctx.sessions.create({ id: sessionId, type, owner, persistenceCwd })
    res.status(201).json({ id: entry.id, type: entry.type })
  })
  router.delete('/sessions/:sessionId', async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const { sessionId } = req.params
    if (!ctx.sessions.get(sessionId)) return res.status(404).json({ error: `Session not found: ${sessionId}` })
    await ctx.sessions.destroy(sessionId)
    res.json({ ok: true })
  })
}

const createSessionRouter = (deps) => {
  const router = express.Router()
  router.use('/sessions/:sessionId', express.json(), attachSessionMiddleware(deps))
  mountSessionEndpoints(router, deps)
  mountSessionsCrud(router, deps)
  return router
}

export { createSessionRouter, findOrCreateSession }
