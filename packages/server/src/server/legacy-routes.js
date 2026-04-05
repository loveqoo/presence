import express from 'express'
import fp from '@presence/core/lib/fun-fp.js'
import { handleSlashCommand } from './slash-commands.js'

const { Reader } = fp

// =============================================================================
// Legacy per-session Express Router: /api/* → user-default 세션.
// 서버 초기 버전 호환용. 새 API는 /api/sessions/:sessionId/* 사용.
// =============================================================================

/**
 * @type {Reader<{session: object, userContext: object}, import('express').Router>}
 */
const sessionRoutesR = Reader.asks(env => {
  const { session, userContext } = env
  const { mcpControl, memory, config } = userContext
  const router = express.Router()
  router.use(express.json())

  router.post('/chat', async (req, res) => {
    const { input } = req.body
    if (!input || typeof input !== 'string') {
      return res.status(400).json({ error: 'input (string) required' })
    }
    if (input.startsWith('/')) {
      const cmd = handleSlashCommand(input, { state: session.state, tools: session.tools, memory, mcpControl })
      if (cmd.handled) return res.json(cmd.result)
    }
    try {
      const result = await session.handleInput(input)
      res.json({ type: 'agent', content: result })
    } catch (err) {
      res.status(500).json({ type: 'error', content: err.message })
    }
  })

  router.get('/state', (_req, res) => res.json(session.state.snapshot()))
  router.post('/approve', (req, res) => { session.handleApproveResponse(!!req.body.approved); res.json({ ok: true }) })
  router.post('/cancel', (_req, res) => { session.handleCancel(); res.json({ ok: true }) })
  router.get('/tools', (_req, res) => res.json(session.tools.map(t => ({ name: t.name, description: t.description, source: t.source }))))
  router.get('/agents', (_req, res) => res.json(session.agents))
  router.get('/config', (_req, res) => {
    const { llm, ...rest } = config
    const { apiKey, ...safeLlm } = llm
    res.json({ ...rest, llm: safeLlm })
  })

  return router
})

export { sessionRoutesR }
