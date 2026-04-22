import express from 'express'
import { buildSelfCard, buildSelfCardsFromRegistry } from '@presence/infra/infra/agents/self-card.js'

// =============================================================================
// /a2a 라우터 — docs/design/agent-identity-model.md §11
//
// config.a2a.enabled 일 때만 마운트. JSON-RPC 메시지 처리 (message/send, tasks/get) 는
// C3 커밋에서 추가. 이 파일은 현재 discovery (card) 엔드포인트만 제공.
//
// 인증 (A2A JWT) 은 authz phase — 이번 커밋은 경로만 열린다.
// =============================================================================

const agentIdFromParams = (req) => {
  // /a2a/:userId/:agentName → 'userId/agentName'
  const { userId, agentName } = req.params
  if (!userId || !agentName) return null
  return `${userId}/${agentName}`
}

const createA2aRouter = (opts) => {
  const { userContext, config } = opts
  const router = express.Router()
  const publicUrl = config.a2a?.publicUrl

  if (!config.a2a?.enabled) {
    throw new Error('createA2aRouter: invoked while a2a.enabled=false')
  }
  if (!publicUrl) {
    throw new Error('createA2aRouter: publicUrl required')
  }

  // GET /a2a/.well-known/agents — 로컬 agent 카드 목록
  router.get('/.well-known/agents', (_req, res) => {
    const cards = buildSelfCardsFromRegistry(userContext.agentRegistry, publicUrl)
    res.json({ agents: cards })
  })

  // GET /a2a/:userId/:agentName/card — 단일 agent 카드
  router.get('/:userId/:agentName/card', (req, res) => {
    const agentId = agentIdFromParams(req)
    if (!agentId) return res.status(400).json({ error: 'invalid agent path' })

    const maybeEntry = userContext.agentRegistry.get(agentId)
    if (!maybeEntry || !maybeEntry.isJust || !maybeEntry.isJust()) {
      return res.status(404).json({ error: `agent not found: ${agentId}` })
    }
    const entry = maybeEntry.value
    if (entry.archived) return res.status(410).json({ error: `agent archived: ${agentId}` })
    if (entry.type && entry.type !== 'local') {
      return res.status(404).json({ error: `agent not local: ${agentId}` })
    }

    try {
      const card = buildSelfCard({
        agentId: entry.agentId,
        publicUrl,
        description: entry.description,
        capabilities: entry.capabilities,
      })
      res.json(card)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  return router
}

export { createA2aRouter }
