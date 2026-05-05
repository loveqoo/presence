import express from 'express'
import { randomUUID } from 'node:crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { buildSelfCard, buildSelfCardsFromRegistry } from '@presence/infra/infra/agents/self-card.js'
import { canAccessAgent, canStartA2aSession, INTENT, REASON } from '@presence/infra/infra/authz/agent-access.js'
import { Method, TaskState, JsonRpcErrorCode } from '@presence/infra/infra/agents/a2a-protocol.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'

const { Reader, Either } = fp

// =============================================================================
// /a2a 라우터 — docs/design/agent-identity-model.md §11
//
// config.a2a.enabled 일 때만 마운트.
//   GET  /a2a/.well-known/agents       — 모든 로컬 agent 카드
//   GET  /a2a/:userId/:agentName/card  — 단일 카드
//   POST /a2a/:userId/:agentName        — JSON-RPC 2.0 (message/send, tasks/get)
//
// 인증 (KG-17 resolved):
//   POST 호출자는 `Authorization: Bearer <a2a-jwt>` 헤더로 자기 identity 를
//   증명. tokenService.verifyA2aToken 으로 서명/만료/audience/type 검증 후
//   payload.sub 를 caller 로 사용. self-A2A scope (같은 머신 = 같은 secret)
//   에서 작동. 멀티 머신 간 검증은 v2 (peer key registry / mTLS).
//   canAccessAgent (INTENT.DELEGATE) 게이트는 검증 통과 후 적용.
// =============================================================================

const parseBearerToken = (req) => {
  const raw = req.headers.authorization
  if (typeof raw !== 'string') return null
  const match = raw.match(/^Bearer\s+(.+)$/)
  return match ? match[1] : null
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

// canStartA2aSession deny reason → HTTP status / JSON-RPC error code 매핑.
// exhaustive switch — 새 REASON 추가 시 컴파일/리뷰 시점에 누락 감지.
//   AGENT_NOT_REGISTERED → 404 INVALID_PARAMS (agent 부재 운영 진단)
//   ARCHIVED / A2A_DENIED → 403 ACCESS_DENIED (정책 거부)
//   MISSING_* / INVALID_* → 403 ACCESS_DENIED (입력/조립 결함, fail-closed)
//   ADMIN_ONLY / NOT_OWNER / ADMIN_SINGLETON → 403 (권한 거부)
const SESSION_DENY_STATUS_BY_REASON = Object.freeze({
  [REASON.AGENT_NOT_REGISTERED]: { status: 404, code: JsonRpcErrorCode.INVALID_PARAMS },
  [REASON.ARCHIVED]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.A2A_DENIED]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.MISSING_PRINCIPAL]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.MISSING_EVALUATOR]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.MISSING_REGISTRY]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.INVALID_AGENT_ID]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.INVALID_PEER_AGENT_ID]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.ADMIN_ONLY]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
  [REASON.NOT_OWNER]: { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED },
})

// reason 미스 시 fail-closed 403 + 운영 가시성을 위해 logger 인자 받아 warn.
// codex round 2 #7 — 옛 구현은 silent fallback 이라 새 REASON 추가 누락이
// 운영에서 안 보였음.
const mapSessionDenyReason = (reason, { logger, agentId, caller } = {}) => {
  const mapped = SESSION_DENY_STATUS_BY_REASON[reason]
  if (mapped) return mapped
  logger?.warn?.(`[a2a-router] unknown sessionGate deny reason: ${reason}`, { agentId, caller })
  return { status: 403, code: JsonRpcErrorCode.ACCESS_DENIED }
}

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

const mountInvokeRoute = (router, userContext, tokenService, evaluator) => {
  // POST /a2a/:userId/:agentName — JSON-RPC 2.0 entry point
  // Bearer JWT 검증 → canAccessAgent (DELEGATE) → dispatch
  router.post('/:userId/:agentName', express.json(), async (req, res) => {
    const id = req.body?.id ?? null
    const agentId = agentIdFromParams(req)
    if (!agentId) return res.status(400).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS, 'invalid agent path'))

    const token = parseBearerToken(req)
    if (!token) {
      return res.status(401).json(jsonRpcError(id, JsonRpcErrorCode.AUTH_MISSING,
        'missing Authorization Bearer A2A token'))
    }

    const verified = tokenService.verifyA2aToken(token)
    if (Either.isLeft(verified)) {
      const reason = Either.fold(e => e, () => '', verified)
      return res.status(401).json(jsonRpcError(id, JsonRpcErrorCode.AUTH_INVALID,
        `A2A token invalid: ${reason}`))
    }
    const caller = Either.fold(() => null, p => p.sub, verified)
    if (!caller) {
      return res.status(401).json(jsonRpcError(id, JsonRpcErrorCode.AUTH_INVALID,
        'A2A token missing sub claim'))
    }

    const access = canAccessAgent({
      jwtSub: caller, agentId, intent: INTENT.DELEGATE, registry: userContext.agentRegistry,
      evaluator,
    })
    if (!access.allow) {
      return res.status(403).json(jsonRpcError(id, JsonRpcErrorCode.ACCESS_DENIED, `access denied: ${access.reason}`))
    }

    // A2A Phase 3 (KG-37) — 카드 교환 게이트. canStartA2aSession 통과 시에만
    // store.upsertOnFirstMeeting → recordMeeting. closed 관계는 throw.
    //
    // Phase 3 한계 (peerAgentId = JWT caller):
    //   self-A2A scope (같은 머신 = 같은 secret) 에서 caller 의 JWT sub 를
    //   peerAgentId 로 사용. 실제로 호출하는 측의 agent 는 caller user 의 agent
    //   중 어느 것이든 될 수 있으나, 현 phase 는 peer card 메타데이터 fetch 가
    //   미구현이므로 user-level 식별자 (JWT sub) 를 임시 peerAgentId 로 채택.
    //   Phase 4 에서 a2a-protocol.md 의 peer card exchange 가 도입되면
    //   peer 의 agentId (예: 'bob/echo') 로 교체. 본 한계는 agent-session.md
    //   §peer-identification 에 명시.
    const sessionGate = canStartA2aSession({
      jwtSub: caller, agentId, peerAgentId: caller,
      registry: userContext.agentRegistry, evaluator,
    })
    if (!sessionGate.allow) {
      // 명시적 매핑 — 알려진 reason 만 처리하고 알 수 없는 reason 은 fail-closed
      // 로 403/ACCESS_DENIED 에 흡수 + userContext.logger 로 warn (운영 가시성).
      const { status, code } = mapSessionDenyReason(sessionGate.reason, {
        logger: userContext.logger, agentId, caller,
      })
      return res.status(status).json(jsonRpcError(id, code,
        `a2a session denied: ${sessionGate.reason}`))
    }

    // dispatch 가능성 검증을 meeting 기록 앞으로 이동 — agent-session.md 의
    // "meeting = request/response pair" 의미론을 지키기 위해 실제 dispatch 단계
    // 까지 도달한 호출만 만남으로 카운트. registry 부재 / non-runnable / 잘못된
    // method 는 만남으로 기록하지 않음.
    const maybeEntry = userContext.agentRegistry.get(agentId)
    if (!maybeEntry || !maybeEntry.isJust || !maybeEntry.isJust()) {
      return res.status(404).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS, `agent not found: ${agentId}`))
    }
    const entry = maybeEntry.value
    if (!isLocalRunnable(entry)) {
      return res.status(400).json(jsonRpcError(id, JsonRpcErrorCode.INVALID_PARAMS,
        `agent not invokable (type=${entry.type})`))
    }

    // a2aRelationshipStore 는 UserContext.create 가 항상 부팅하므로 누락 = 조립
    // 실패. silently bypass 금지 — 하드 fail 로 노출 (refactor.md 구조 가시성).
    if (!userContext.a2aRelationshipStore) {
      throw new Error('a2a-router: userContext.a2aRelationshipStore missing (UserContext boot regression)')
    }
    userContext.a2aRelationshipStore.upsertOnFirstMeeting({
      localAgentId: agentId, peerAgentId: caller,
    })
    try {
      userContext.a2aRelationshipStore.recordMeeting({
        localAgentId: agentId, peerAgentId: caller,
      })
    } catch (err) {
      // closed 관계 — caller 가 먼저 close 후 다시 호출. 403 으로 surface.
      if (err.code === 'RELATIONSHIP_CLOSED') {
        return res.status(403).json(jsonRpcError(id, JsonRpcErrorCode.ACCESS_DENIED,
          `a2a session denied: ${REASON.A2A_DENIED} (relationship closed by user)`))
      }
      throw err
    }

    return dispatchRpcMethod(entry, req.body, id, res)
  })
}

const a2aRouterR = Reader.asks(({ userContext, config, tokenService, evaluator }) => {
  const router = express.Router()
  const publicUrl = config.a2a?.publicUrl

  if (!config.a2a?.enabled) {
    throw new Error('createA2aRouter: invoked while a2a.enabled=false')
  }
  if (!publicUrl) {
    throw new Error('createA2aRouter: publicUrl required')
  }
  if (!tokenService || typeof tokenService.verifyA2aToken !== 'function') {
    throw new Error('createA2aRouter: tokenService with verifyA2aToken required (KG-17)')
  }

  mountDiscoveryRoutes(router, userContext, publicUrl)
  mountInvokeRoute(router, userContext, tokenService, evaluator)
  return router
})

// 레거시 브릿지 — 단일 라인 위임 (fp-monad.md 허용 패턴)
const createA2aRouter = (opts) => a2aRouterR.run(opts)

export { createA2aRouter, a2aRouterR }
