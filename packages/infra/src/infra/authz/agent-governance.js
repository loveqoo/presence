import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from '../config.js'
import { ADMIN_USERNAME, DEFAULT_POLICIES } from '../admin-bootstrap.js'
import { validateAgentNamePart } from '@presence/core/core/agent-id.js'
import { atomicWriteJson } from '../fs-utils.js'

const { Either, Reader } = fp

// =============================================================================
// Agent governance — docs/design/agent-identity-model.md §8
//
// Admin agent 가 관리하는 user agent 생성 승인 플로우.
//
// 핵심 원칙:
//   - user config 의 `agents[]` 가 권위 (single source of truth)
//   - pending/{reqId}.json 은 요청 큐 (보조)
//   - 모든 파일 변경은 atomic (tmp + rename) — fs-utils.js
//   - idempotent replay: approve 재실행 시 config 선확인 → 파일만 정리
// =============================================================================

const SUB_DIRS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
})

const STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ALREADY_EXISTS: 'already-exists',
  ALREADY_APPLIED: 'already-applied',
  NOT_FOUND: 'not-found',
  // Cedar evaluator deny — Y' minimal seed 에선 발생하지 않으나, 사용자가 50-custom.cedar 로 deny 정책
  // 추가하면 enforcement point 가 작동. governance-cedar v2.1 §3.3 + §5.1 GV-Y4.
  DENIED: 'denied',
})

// docs §8.3 — pending 요청의 원인 레이블.
// QUOTA_EXCEEDED: policies.maxAgentsPerUser 초과. MANUAL_REVIEW: quota 여유 있으나 autoApprove=false.
const PENDING_REASON = Object.freeze({
  QUOTA_EXCEEDED: 'quota-exceeded',
  MANUAL_REVIEW: 'manual-review',
  DENIED_UNSPECIFIED: 'unspecified',
})

// --- file utils ---

const readJson = (filePath) => {
  if (!existsSync(filePath)) return null
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) } catch (_) { return null }
}

const adminDir = (presenceDir) => join(presenceDir, 'users', ADMIN_USERNAME)

const queueDir = (presenceDir, sub) => join(adminDir(presenceDir), sub)

const requestPath = (presenceDir, sub, reqId) => join(queueDir(presenceDir, sub), `${reqId}.json`)

const generateRequestId = () => `req-${randomBytes(6).toString('hex')}`

// --- policies ---

const loadAgentPolicies = (presenceDir) => {
  const policiesPath = join(adminDir(presenceDir), 'agent-policies.json')
  const data = readJson(policiesPath)
  if (!data) return { ...DEFAULT_POLICIES }
  return {
    maxAgentsPerUser: typeof data.maxAgentsPerUser === 'number' ? data.maxAgentsPerUser : DEFAULT_POLICIES.maxAgentsPerUser,
    autoApproveUnderQuota: data.autoApproveUnderQuota !== undefined ? !!data.autoApproveUnderQuota : DEFAULT_POLICIES.autoApproveUnderQuota,
  }
}

// --- active count (재계산 — docs §8.1) ---

const loadUserConfigFile = (username, basePath) => {
  const path = join(Config.resolveDir(basePath), 'users', username, 'config.json')
  return { path, data: readJson(path) || {} }
}

const getActiveAgentCount = (username, opts) => {
  const { data } = loadUserConfigFile(username, (opts || {}).basePath)
  if (!Array.isArray(data.agents)) return 0
  return data.agents.filter(a => !a.archived).length
}

// --- user config mutation ---

const buildAgentEntry = (username, agentName, persona) => ({
  name: agentName,
  description: `${username} 사용자 에이전트 (${agentName})`,
  capabilities: [],
  persona: { ...persona },
  createdAt: new Date().toISOString(),
  createdBy: 'agent-governance',
  archived: false,
})

// 불변 조립 — 기존 data 를 변이하지 않고 새 객체 반환.
const appendAgentToConfig = (params) => {
  const { path, data } = loadUserConfigFile(params.username, params.basePath)
  const existingAgents = Array.isArray(data.agents) ? data.agents : []
  const nextConfig = {
    ...data,
    agents: [...existingAgents, buildAgentEntry(params.username, params.agentName, params.persona)],
  }
  atomicWriteJson(path, nextConfig)
}

// --- pending queue ops ---

const writePendingRequest = (presenceDir, request) => {
  atomicWriteJson(requestPath(presenceDir, SUB_DIRS.PENDING, request.id), request)
}

const listRequestsIn = (presenceDir, sub) => {
  const dir = queueDir(presenceDir, sub)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(dir, f)))
    .filter(Boolean)
}

const readPendingRequest = (presenceDir, reqId) =>
  readJson(requestPath(presenceDir, SUB_DIRS.PENDING, reqId))

const moveRequest = (presenceDir, reqId, fromSub, toSub, extras) => {
  const src = requestPath(presenceDir, fromSub, reqId)
  if (!existsSync(src)) return false
  const request = readJson(src) || {}
  const updated = { ...request, ...(extras || {}), status: toSub, movedAt: new Date().toISOString() }
  const dst = requestPath(presenceDir, toSub, reqId)
  mkdirSync(dirname(dst), { recursive: true })
  atomicWriteJson(dst, updated)
  try { unlinkSync(src) } catch (_) { /* best-effort */ }
  return true
}

// --- flows (Reader.asks 기반 DI 통일) ---

// docs §8.3 — 승인 플로우. returns { status, reqId?, detail? }
// governance-cedar v2.1 §3.3: Cedar evaluator 가 RBAC enforcement point.
// Y' minimal seed 는 LocalUser create_agent 전부 allow → 의미론은 코드 분기 그대로.
// 사용자가 50-custom.cedar 로 deny 정책을 추가하면 코드 분기 도달 전 차단.
const submitUserAgentR = Reader.asks(({ requester, agentName, persona, basePath, presenceDir, evaluator }) => () => {
  if (!requester || !agentName) throw new Error('submitUserAgent: requester + agentName required')
  if (typeof evaluator !== 'function') {
    throw new Error('submitUserAgent: evaluator (function) required — Cedar invariant (governance-cedar v2.1 §3.3)')
  }
  const nameCheck = validateAgentNamePart(agentName)
  if (Either.isLeft(nameCheck)) {
    throw new Error(`submitUserAgent: invalid agentName — ${Either.fold(err => err, () => '', nameCheck)}`)
  }

  // (0) Cedar enforcement point — RBAC 게이트. deny 시 코드 분기 미도달 (GV-Y4).
  const decision = evaluator({
    principal: { type: 'LocalUser', id: requester },
    action:    'create_agent',
    resource:  { type: 'User', id: requester },
  })
  if (decision.decision !== 'allow') {
    return {
      status: STATUS.DENIED,
      detail: `cedar-deny: matched=${(decision.matchedPolicies ?? []).join(',')}`,
    }
  }

  // (1) 중복 — config 에 이미 non-archived agent 있으면 skip
  const { data } = loadUserConfigFile(requester, basePath)
  if (Array.isArray(data.agents) && data.agents.some(a => a.name === agentName && !a.archived)) {
    return { status: STATUS.ALREADY_EXISTS }
  }

  // (2) policy + count
  const policies = loadAgentPolicies(presenceDir)
  const count = getActiveAgentCount(requester, { basePath })
  const underQuota = count < policies.maxAgentsPerUser

  if (underQuota && policies.autoApproveUnderQuota) {
    appendAgentToConfig({ username: requester, agentName, persona, basePath })
    return { status: STATUS.APPROVED, detail: `auto-approved (count ${count}/${policies.maxAgentsPerUser})` }
  }

  // (3) pending queue
  const reqId = generateRequestId()
  writePendingRequest(presenceDir, {
    id: reqId, requester, agentName, persona,
    submittedAt: new Date().toISOString(),
    status: STATUS.PENDING,
    reason: underQuota ? PENDING_REASON.MANUAL_REVIEW : PENDING_REASON.QUOTA_EXCEEDED,
    currentCount: count,
    maxAgentsPerUser: policies.maxAgentsPerUser,
  })
  return { status: STATUS.PENDING, reqId }
})

// docs §8.3.5 — idempotent replay
const approveUserAgentR = Reader.asks(({ reqId, presenceDir, basePath }) => () => {
  const req = readPendingRequest(presenceDir, reqId)
  if (!req) return { status: STATUS.NOT_FOUND }

  const { data } = loadUserConfigFile(req.requester, basePath)
  const alreadyApplied = Array.isArray(data.agents) && data.agents.some(a => a.name === req.agentName && !a.archived)

  if (alreadyApplied) {
    moveRequest(presenceDir, reqId, SUB_DIRS.PENDING, SUB_DIRS.APPROVED)
    return { status: STATUS.ALREADY_APPLIED }
  }

  appendAgentToConfig({
    username: req.requester, agentName: req.agentName, persona: req.persona, basePath,
  })
  moveRequest(presenceDir, reqId, SUB_DIRS.PENDING, SUB_DIRS.APPROVED)
  return { status: STATUS.APPROVED }
})

const denyUserAgentR = Reader.asks(({ reqId, reason, presenceDir }) => () => {
  const req = readPendingRequest(presenceDir, reqId)
  if (!req) return { status: STATUS.NOT_FOUND }
  moveRequest(presenceDir, reqId, SUB_DIRS.PENDING, SUB_DIRS.REJECTED, {
    reason: reason || PENDING_REASON.DENIED_UNSPECIFIED,
  })
  return { status: STATUS.REJECTED }
})

// Reader 보조 (loadPolicy / count 는 다른 모듈이 DI 로 참조 가능)
const loadAgentPoliciesR = Reader.asks(({ presenceDir }) => () => loadAgentPolicies(presenceDir))
const getActiveAgentCountR = Reader.asks(({ username, basePath }) => () => getActiveAgentCount(username, { basePath }))

// 레거시 브릿지 — 단일 라인 위임 (fp-monad.md 허용 패턴)
const submitUserAgent = (params) => submitUserAgentR.run(params)()
const approveUserAgent = (reqId, opts) => approveUserAgentR.run({ reqId, ...opts })()
const denyUserAgent = (reqId, reason, opts) => denyUserAgentR.run({ reqId, reason, ...opts })()

const listPending = (presenceDir) => listRequestsIn(presenceDir, SUB_DIRS.PENDING)
const listApproved = (presenceDir) => listRequestsIn(presenceDir, SUB_DIRS.APPROVED)
const listRejected = (presenceDir) => listRequestsIn(presenceDir, SUB_DIRS.REJECTED)

export {
  STATUS,
  PENDING_REASON,
  loadAgentPolicies, loadAgentPoliciesR,
  getActiveAgentCount, getActiveAgentCountR,
  submitUserAgent, submitUserAgentR,
  approveUserAgent, approveUserAgentR,
  denyUserAgent, denyUserAgentR,
  listPending, listApproved, listRejected,
  readPendingRequest,
}
