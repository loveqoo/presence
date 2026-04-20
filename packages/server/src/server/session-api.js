import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import express from 'express'
import { Config } from '@presence/infra/infra/config.js'
import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
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
    const persistenceCwd = join(userDir, 'sessions', sessionId)
    // 레거시 경로(users/{username}/state.json) → 새 경로 마이그레이션
    const legacyState = join(userDir, 'state.json')
    if (existsSync(legacyState) && !existsSync(join(persistenceCwd, 'state.json'))) {
      mkdirSync(persistenceCwd, { recursive: true })
      renameSync(legacyState, join(persistenceCwd, 'state.json'))
    }
    entry = effectiveUserContext.sessions.create({ id: sessionId, type: SESSION_TYPE.USER, persistenceCwd, owner: username, userId: username })
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
        userId: req.presenceSession.session.userId,
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
    res.json({ ...rest, llm: safeLlm })
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
    const { type = SESSION_TYPE.USER, id, workingDir } = req.body || {}
    const validTypes = Object.values(SESSION_TYPE)
    if (!validTypes.includes(type)) {
      return res.status(400).json({ error: `Invalid session type: ${type}` })
    }
    const owner = req.user?.username ?? null
    const sessionId = id ?? (owner ? `${owner}-${randomUUID()}` : undefined)
    const persistenceCwd = owner ? join(Config.resolveDir(), 'users', owner, 'sessions', sessionId) : undefined
    try {
      const entry = ctx.sessions.create({ id: sessionId, type, owner, userId: owner || 'default', persistenceCwd, workingDir })
      // effective workingDir 을 응답에 포함 — POST 직후 클라이언트 확인용.
      res.status(201).json({ id: entry.id, type: entry.type, workingDir: entry.session.workingDir })
    } catch (err) {
      // Session 생성 시 workingDir 경계 위반 등
      res.status(400).json({ error: err.message })
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
