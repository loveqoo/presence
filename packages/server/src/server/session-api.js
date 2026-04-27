import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import express from 'express'
import { Config } from '@presence/infra/infra/config.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { canAccessAgent, INTENT } from '@presence/infra/infra/authz/agent-access.js'
import { resolvePrimaryAgent } from '@presence/core/core/agent-id.js'
import { handleSlashCommand } from './slash-commands.js'

// =============================================================================
// Session API: Router를 반환. PresenceServer.#mountRoutes()에서 마운트.
// =============================================================================

// --- 세션 검색/생성 공용 로직 ---

// 유저별 컨텍스트에서 세션 검색 + lazy 생성.
// REST(attachSessionMiddleware)와 WS(handleJoin) 양쪽에서 사용.
const findOrCreateSession = (sessionId, username, effectiveUserContext) => {
  let entry = effectiveUserContext.sessions.get(sessionId)

  // 세션 없으면 자동 생성 ({username}-default 패턴)
  if (!entry && username && sessionId === `${username}-default`) {
    const userDir = join(Config.resolveDir(), 'users', username)
    // 세션 경로에 agent 디렉토리 삽입 (docs/design/data-scope-alignment.md §3.2).
    // KG-16: config.primaryAgentId 경유 (identity §12). 부재 시 ${username}/default fallback.
    const { agentId, agentName } = resolvePrimaryAgent(effectiveUserContext.config, username)
    const persistenceCwd = join(userDir, 'agents', agentName, 'sessions', sessionId)
    entry = effectiveUserContext.sessions.create({ id: sessionId, type: SESSION_TYPE.USER, persistenceCwd, owner: username, userId: username, agentId })
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
    const entry = findOrCreateSession(sessionId, username, effectiveUserContext)
    if (!entry) return res.status(404).json({ error: `Session not found: ${sessionId}` })

    // 인증 활성화 시 소유자 검증
    if (authEnabled && username && entry.owner !== null && entry.owner !== username) {
      return res.status(403).json({ error: 'Access denied: session belongs to another user' })
    }

    // docs §9.4 진입점 #1 — continue-session intent 로 canAccessAgent 호출.
    // 인증 활성화 + username 있을 때만 강제. 레거시 anonymous 테스트는 skip.
    if (authEnabled && username) {
      const access = canAccessAgent({
        jwtSub: username,
        agentId: entry.session.agentId,
        intent: INTENT.CONTINUE_SESSION,
        registry: effectiveUserContext.agentRegistry,
        evaluator: deps.evaluator,
      })
      if (!access.allow) {
        return res.status(403).json({ error: `Access denied: ${access.reason}`, code: 'AGENT_ACCESS_DENIED', reason: access.reason })
      }
    }

    req.presenceSession = entry
    req.presenceUserContext = effectiveUserContext
    next()
  }
}

// --- Session endpoints ---

// Phase 5: HTTP 응답에 현재 stateVersion 을 일관되게 첨부. 클라이언트가
// lastStateVersion 과 비교해 refresh 필요 여부 판단.
const withVersion = (session, body) => ({
  ...body,
  stateVersion: session.turnGateRuntime?.stateVersion ?? null,
})

// 세션별 endpoint (chat, state, tools, agents, config, approve, cancel).
const mountSessionEndpoints = (router, deps) => {
  const { userContext } = deps

  router.post('/sessions/:sessionId/chat', async (req, res) => {
    const { session } = req.presenceSession
    const effectiveCtx = req.presenceUserContext || userContext
    const { input } = req.body
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input (string) required' })
    if (input.startsWith('/')) {
      const cmd = await handleSlashCommand(input, {
        state: session.state, tools: session.tools,
        memory: effectiveCtx.memory, toolRegistry: effectiveCtx.toolRegistry,
        agentId: req.presenceSession.session.agentId,
        userContext: effectiveCtx,
        // governance-cedar v2.8 §X3 — /persona set|reset Cedar 게이트용
        evaluator: deps.evaluator,
        jwtSub: req.user?.username,
      })
      if (cmd.handled) {
        // state 변경 커맨드(/clear 등) 후 persistence flush
        session.flushPersistence().catch(() => {})
        return res.json(withVersion(session, cmd.result))
      }
    }
    try {
      const result = await session.handleInput(input)
      res.json(withVersion(session, { type: 'agent', content: result }))
    } catch (err) {
      // Phase 9: 에러 응답에 snapshot 동봉 — 클라이언트가 WS 왕복 없이 즉시 reconcile.
      res.status(500).json(withVersion(session, {
        type: 'error',
        content: err.message,
        snapshot: session.state.snapshot(),
      }))
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
    // FP-71 — TUI 첫 진입 시 페르소나 미설정 안내용. systemPrompt 가 비어있으면 false.
    const personaConfigured = (ctx.getPrimaryPersona().systemPrompt || '').trim().length > 0
    res.json({ ...rest, llm: safeLlm, personaConfigured })
  })
  router.post('/sessions/:sessionId/approve', (req, res) => {
    const { session } = req.presenceSession
    session.handleApproveResponse(!!req.body.approved)
    res.json(withVersion(session, { ok: true }))
  })
  router.post('/sessions/:sessionId/cancel', (req, res) => {
    const { session } = req.presenceSession
    session.handleCancel()
    res.json(withVersion(session, { ok: true }))
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

// --- Router factory ---

// --- 세션 CRUD (목록/생성/삭제) ---

const mountSessionsCrud = (router, deps) => {
  router.get('/sessions', async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const userSessions = ctx.sessions.list()
    res.json(userSessions.map(({ id, type }) => ({ id, type })))
  })
  router.post('/sessions', express.json(), async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const { type = SESSION_TYPE.USER, id } = req.body || {}
    const validTypes = Object.values(SESSION_TYPE)
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid session type: ${type}` })
    }
    const owner = req.user?.username ?? null
    const sessionId = id ?? (owner ? `${owner}-${randomUUID()}` : undefined)
    try {
      // KG-16: agentId / agent dir 모두 config.primaryAgentId 경유 (identity §12).
      const effectiveUserId = owner || 'default'
      const { agentId, agentName } = resolvePrimaryAgent(ctx.config, effectiveUserId)
      // 세션 경로에 agent 디렉토리 삽입 (docs/design/data-scope-alignment.md §3.2).
      const persistenceCwd = owner ? join(Config.resolveDir(), 'users', owner, 'agents', agentName, 'sessions', sessionId) : undefined

      // docs §9.4 진입점 #1 — new-session intent. 인증 활성화 시에만 강제.
      // KG-15 — admin singleton: findAdminSession callback 주입.
      if (deps.authEnabled && owner) {
        const access = canAccessAgent({
          jwtSub: owner, agentId, intent: INTENT.NEW_SESSION, registry: ctx.agentRegistry,
          evaluator: deps.evaluator,
          findAdminSession: () => ctx.sessions.findAdminSession(),
        })
        if (!access.allow) {
          return res.status(403).json({ error: `Access denied: ${access.reason}`, code: 'AGENT_ACCESS_DENIED', reason: access.reason })
        }
      }

      // workingDir 은 userId 에서 자동 결정 (Session 내부).
      const entry = ctx.sessions.create({ id: sessionId, type, owner, userId: effectiveUserId, agentId, persistenceCwd })
      res.status(201).json({ id: entry.id, type: entry.type, workingDir: entry.session.workingDir })
    } catch (err) {
      res.status(400).json({ error: err.message, code: 'SESSION_CREATE_FAILED' })
    }
  })
  router.delete('/sessions/:sessionId', async (req, res) => {
    const ctx = await resolveUserContext(req, deps)
    const { sessionId } = req.params
    const { authEnabled } = deps
    const username = req.user?.username
    const entry = ctx.sessions.get(sessionId)
    if (!entry) return res.status(404).json({ error: `Session not found: ${sessionId}` })
    if (authEnabled && username && entry.owner !== null && entry.owner !== username) {
      return res.status(403).json({ error: 'Access denied: session belongs to another user' })
    }
    await ctx.sessions.destroy(sessionId)
    res.json({ ok: true })
  })
}

export const createSessionRouter = (deps) => {
  const router = express.Router()
  router.use('/sessions/:sessionId', express.json(), attachSessionMiddleware(deps))
  mountSessionEndpoints(router, deps)
  mountSessionsCrud(router, deps)
  return router
}

export { findOrCreateSession }
