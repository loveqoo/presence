import express from 'express'
import { randomUUID } from 'node:crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { buildSelfCard, buildSelfCardsFromRegistry } from '@presence/infra/infra/agents/self-card.js'
import { canAccessAgent, INTENT } from '@presence/infra/infra/authz/agent-access.js'
import { Method, TaskState, JsonRpcErrorCode } from '@presence/infra/infra/agents/a2a-protocol.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'

const { Reader } = fp

// =============================================================================
// /a2a 라우터 — docs/design/agent-identity-model.md §11
//
// config.a2a.enabled 일 때만 마운트.
//   GET  /a2a/.well-known/agents       — 모든 로컬 agent 카드
//   GET  /a2a/:userId/:agentName/card  — 단일 카드
//   POST /a2a/:userId/:agentName        — JSON-RPC 2.0 (message/send, tasks/get)
//
// 인증 모델:
//   A2A JWT 완성은 authz phase (§13 위임). 그 전까지 POST 호출자는
//   `X-Presence-Caller: {username}` 헤더로 stub 제공. 로컬 dev / CI 용.
//   canAccessAgent (INTENT.DELEGATE) 게이트는 이미 활성 — caller 가
//   자신의 prefix 바깥 agent 에 접근하면 403.
// =============================================================================

const A2A_CALLER_HEADER = 'x-presence-caller'

const parseCaller = (req) => {
  // TODO(authz): JWT 기반 identity 로 교체. 이후 이 함수는 res.locals.caller 로 대체.
  const raw = req.headers[A2A_CALLER_HEADER]
  if (typeof raw !== 'string' || raw.length === 0) return null
  return raw
}

const jsonRpcError = (id, code, message) => ({
  jsonrpc: '2.0', id: id ?? null, error: { code, message },
})

const jsonRpcResult = (id, result) => ({
  jsonrpc: '2.0', id: id ?? null, result,
})

const completedTaskResult = (taskId, text) => ({
  id: taskId,
  status: { state: TaskState.COMPLETED },
  artifacts: [{ parts: [{ kind: 'text', text: String(text ?? '') }] }],
})

const failedTaskResult = (taskId, reason) => ({
  id: taskId,
  status: {
    state: TaskState.FAILED,
    message: { parts: [{ kind: 'text', text: String(reason || 'unknown') }] },
  },
})

const extractTaskText = (params) => {
  const message = params?.message
  if (!message || !Array.isArray(message.parts)) return ''
  const textPart = message.parts.find(p => p?.kind === 'text')
  return textPart ? String(textPart.text || '') : ''
}

const agentIdFromParams = (req) => {
  // /a2a/:userId/:agentName → 'userId/agentName'
  const { userId, agentName } = req.params
  if (!userId || !agentName) return null
  return `${userId}/${agentName}`
}

const isLocalRunnable = (entry) =>
  entry.type === DelegationMode.LOCAL && typeof entry.run === 'function'

const mountDiscoveryRoutes = (router, userContext, publicUrl) => {
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
    if (entry.type && entry.type !== DelegationMode.LOCAL) {
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
}

const dispatchRpcMethod = async (entry, body, id, res) => {
  const { method, params } = body || {}
  if (method === Method.SEND) {
    const taskId = params?.id || randomUUID()
    const taskText = extractTaskText(params)
    try {
      const output = await entry.run(taskText)
      return res.json(jsonRpcResult(id, completedTaskResult(taskId, output)))
    } catch (err) {
      return res.json(jsonRpcResult(id, failedTaskResult(taskId, err.message || String(err))))
    }
  }

  if (method === Method.GET) {
    // 로컬 sync agent 는 run() 즉시 완료 — task state 를 저장하지 않음.
    // 미래에 async agent 도입 시 별도 task store 추가 예정.
    return res.status(501).json(jsonRpcError(id, JsonRpcErrorCode.METHOD_NOT_FOUND,
      `${Method.GET} not supported for local sync agents`))
  }

  return res.status(400).json(jsonRpcError(id, JsonRpcErrorCode.METHOD_NOT_FOUND,
    `method not found: ${method || '(missing)'}`))
}

const mountInvokeRoute = (router, userContext) => {
  // POST /a2a/:userId/:agentName — JSON-RPC 2.0 entry point
  // stub 인증 (X-Presence-Caller) → canAccessAgent (DELEGATE) → dispatch
  router.post('/:userId/:agentName', express.json(), async (req, res) => {
    const id = req.body?.id ?? null
    const agentId = agentIdFromParams(req)
    if (!agentId) return res.status(400).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS, 'invalid agent path'))

    const caller = parseCaller(req)
    if (!caller) {
      return res.status(401).json(jsonRpcError(id, JsonRpcErrorCode.AUTH_MISSING,
        `missing ${A2A_CALLER_HEADER} header (stub auth pending authz phase)`))
    }

    const access = canAccessAgent({
      jwtSub: caller, agentId, intent: INTENT.DELEGATE, registry: userContext.agentRegistry,
    })
    if (!access.allow) {
      return res.status(403).json(jsonRpcError(id, JsonRpcErrorCode.ACCESS_DENIED, `access denied: ${access.reason}`))
    }

    const maybeEntry = userContext.agentRegistry.get(agentId)
    if (!maybeEntry || !maybeEntry.isJust || !maybeEntry.isJust()) {
      return res.status(404).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS, `agent not found: ${agentId}`))
    }
    const entry = maybeEntry.value
    if (!isLocalRunnable(entry)) {
      return res.status(400).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS,
        `agent not invokable (type=${entry.type})`))
    }

    return dispatchRpcMethod(entry, req.body, id, res)
  })
}

const a2aRouterR = Reader.asks(({ userContext, config }) => {
  const router = express.Router()
  const publicUrl = config.a2a?.publicUrl

  if (!config.a2a?.enabled) {
    throw new Error('createA2aRouter: invoked while a2a.enabled=false')
  }
  if (!publicUrl) {
    throw new Error('createA2aRouter: publicUrl required')
  }

  mountDiscoveryRoutes(router, userContext, publicUrl)
  mountInvokeRoute(router, userContext)
  return router
})

// 레거시 브릿지 — 단일 라인 위임 (fp-monad.md 허용 패턴)
const createA2aRouter = (opts) => a2aRouterR.run(opts)

export { createA2aRouter, a2aRouterR }
