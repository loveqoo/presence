import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import express from 'express'
import { Config } from '@presence/infra/infra/config.js'
import { SESSION_TYPE } from '@presence/core/core/policies.js'
import { handleSlashCommand } from './slash-commands.js'

// =============================================================================
// Session API: /api/sessions/:sessionId/* + /api/sessions CRUD 엔드포인트.
// 유저 인증 시 session ownership 검증 + on-demand 세션 생성.
// =============================================================================

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

// 세션별 endpoint 등록 (chat, state, tools, agents, config, approve, cancel).
const mountSessionEndpoints = (expressApp, deps) => {
  const { userContext } = deps

  expressApp.post('/api/sessions/:sessionId/chat', async (req, res) => {
    const { session } = req.presenceSession
    const { input } = req.body
    if (!input || typeof input !== 'string') return res.status(400).json({ error: 'input (string) required' })
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, {
        state: session.state, tools: session.tools,
        memory: userContext.memory, mcpControl: userContext.mcpControl,
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
  expressApp.get('/api/sessions/:sessionId/state', (req, res) => res.json(req.presenceSession.session.state.snapshot()))
  expressApp.get('/api/sessions/:sessionId/tools', (req, res) => {
    const { session } = req.presenceSession
    res.json(session.tools.map(t => ({ name: t.name, description: t.description, source: t.source })))
  })
  expressApp.get('/api/sessions/:sessionId/agents', (req, res) => res.json(req.presenceSession.session.agents))
  expressApp.get('/api/sessions/:sessionId/config', (_req, res) => {
    const { llm, ...rest } = userContext.config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })
  expressApp.post('/api/sessions/:sessionId/approve', (req, res) => {
    req.presenceSession.session.handleApproveResponse(!!req.body.approved)
    res.json({ ok: true })
  })
  expressApp.post('/api/sessions/:sessionId/cancel', (req, res) => {
    req.presenceSession.session.handleCancel()
    res.json({ ok: true })
  })
}

// 세션 CRUD: GET/POST/DELETE /api/sessions[:sessionId]
const mountSessionsCrud = (expressApp, userContext) => {
  expressApp.get('/api/sessions', (_req, res) => {
    res.json(userContext.sessions.list().map(({ id, type }) => ({ id, type })))
  })
  expressApp.post('/api/sessions', express.json(), (req, res) => {
    const { type = 'user', id } = req.body || {}
    const owner = req.user?.username ?? null
    const sessionId = id ?? (owner ? `${owner}-${randomUUID()}` : undefined)
    const entry = userContext.sessions.create({ id: sessionId, type, owner })
    res.status(201).json({ id: entry.id, type: entry.type })
  })
  expressApp.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params
    if (!userContext.sessions.get(sessionId)) return res.status(404).json({ error: `Session not found: ${sessionId}` })
    await userContext.sessions.destroy(sessionId)
    res.json({ ok: true })
  })
}

const mountSessionApi = (expressApp, deps) => {
  expressApp.use('/api/sessions/:sessionId', express.json(), attachSessionMiddleware(deps))
  mountSessionEndpoints(expressApp, deps)
  mountSessionsCrud(expressApp, deps.userContext)
}

export { mountSessionApi }
