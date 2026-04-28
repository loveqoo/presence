import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from '../config.js'
import { ADMIN_USERNAME, DEFAULT_POLICIES } from '../admin-bootstrap.js'
import { validateAgentNamePart } from '@presence/core/core/agent-id.js'
import { CheckAccess } from '@presence/core/core/op.js'
import { runCheckAccess } from './cedar/op-runner.js'
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

// agent-identity.md I8 — admin 면제 + hard limit. governance-cedar v2.4 §X 가 Cedar 정책으로 흡수.
// 환경변수 PRESENCE_ADMIN_AGENT_HARD_LIMIT 우선, 부재 시 50.
const ADMIN_AGENT_HARD_LIMIT_DEFAULT = 50
const resolveAdminHardLimit = () => {
  const raw = process.env.PRESENCE_ADMIN_AGENT_HARD_LIMIT
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : ADMIN_AGENT_HARD_LIMIT_DEFAULT
}

const STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ALREADY_EXISTS: 'already-exists',
  ALREADY_APPLIED: 'already-applied',
  NOT_FOUND: 'not-found',
  // Cedar evaluator deny. governance-cedar v2.3 §X 부터 P1 quota 정책이 흡수,
  // evaluator 자체 에러 (parse / runtime) 도 deny 로 전파 → reason='evaluator-error'.
  DENIED: 'denied',
})

// governance-cedar v2.11 §X5 (KG-27) — REASON 분류.
// DENIED terminal: operator/protect/admin-limit/evaluator-error/unspecified
// PENDING admin queue: quota-exceeded (admin 이 quota 상향 검토 가능) / manual-review (autoApprove=false)
const REASON = Object.freeze({
  DENIED_OPERATOR:    'operator-denied',
  DENIED_PROTECT:     'protect-violated',
  DENIED_ADMIN_LIMIT: 'admin-hardlimit',
  DENIED_EVALUATOR:   'evaluator-error',
  DENIED_UNSPECIFIED: 'unspecified',
  PENDING_QUOTA:      'quota-exceeded',
  PENDING_MANUAL:     'manual-review',
})

// 하위 호환 alias — 기존 코드 (e.g. queue 메타데이터) 가 PENDING_REASON.QUOTA_EXCEEDED 참조 가능.
// 의미론은 PENDING 사유만 노출 (DENIED 사유는 별도 export 필요 시 REASON 직접).
const PENDING_REASON = Object.freeze({
  QUOTA_EXCEEDED: REASON.PENDING_QUOTA,
  MANUAL_REVIEW:  REASON.PENDING_MANUAL,
})

// matchedPolicies 의 prefix 다중 매치를 priority 로 분류 (codex H2).
// 우선순위: operator > protect > admin-limit > quota → unspecified.
// matchedPolicies 빈 deny → DENIED(unspecified) fail-closed (codex H3).
const classifyDeny = (matchedPolicies) => {
  const ids = Array.isArray(matchedPolicies) ? matchedPolicies : []
  const has = (prefix) => ids.some(id => typeof id === 'string' && id.startsWith(prefix))
  if (has('50-')) return { status: STATUS.DENIED, reason: REASON.DENIED_OPERATOR, matched: ids }
  if (has('30-') || has('31-')) return { status: STATUS.DENIED, reason: REASON.DENIED_PROTECT, matched: ids }
  if (has('11-')) return { status: STATUS.DENIED, reason: REASON.DENIED_ADMIN_LIMIT, matched: ids }
  if (has('10-')) return { status: STATUS.PENDING, reason: REASON.PENDING_QUOTA, matched: ids }
  return { status: STATUS.DENIED, reason: REASON.DENIED_UNSPECIFIED, matched: ids }
}

// governance-cedar v2.11 §X5 (KG-27) — Cedar 결과를 governance 상태로 매핑.
// errors.length > 0 인 deny 는 evaluator parse/runtime 실패 → DENIED(evaluator-error).
// 그 외 deny 는 matchedPolicies prefix 로 분류 (classifyDeny).
const interpretCedarDecision = (cedarResult, { autoApprove }) => {
  const { decision, matchedPolicies = [], errors = [] } = cedarResult
  if (decision === 'deny' && errors.length > 0) {
    return { status: STATUS.DENIED, reason: REASON.DENIED_EVALUATOR, detail: errors.join('; ') }
  }
  if (decision === 'deny') return classifyDeny(matchedPolicies)
  if (!autoApprove) return { status: STATUS.PENDING, reason: REASON.PENDING_MANUAL }
  return { status: STATUS.APPROVED }
}

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
// governance-cedar v2.3 §X (Y' hybrid): Cedar 가 RBAC 게이트 + quota 의미론.
// autoApprove=false manual_review (third state) + admin 면제 (별도 KG) 는 코드 잔류.
//
// 호출 순서: validate → duplicate → count/policies → Cedar (with context) → mapping.
// duplicate 가 Cedar 호출 전 — ALREADY_EXISTS 는 quota 와 무관한 도메인 응답.
const submitUserAgentR = Reader.asks(({ requester, agentName, persona, basePath, presenceDir, evaluator }) => () => {
  if (!requester || !agentName) throw new Error('submitUserAgent: requester + agentName required')
  if (typeof evaluator !== 'function') {
    throw new Error('submitUserAgent: evaluator (function) required — Cedar invariant (governance-cedar v2.3 §X)')
  }
  const nameCheck = validateAgentNamePart(agentName)
  if (Either.isLeft(nameCheck)) {
    throw new Error(`submitUserAgent: invalid agentName — ${Either.fold(err => err, () => '', nameCheck)}`)
  }

  // (1) 중복 — config 에 이미 non-archived agent 있으면 skip (Cedar 호출 전)
  const { data } = loadUserConfigFile(requester, basePath)
  if (Array.isArray(data.agents) && data.agents.some(a => a.name === agentName && !a.archived)) {
    return { status: STATUS.ALREADY_EXISTS }
  }

  // (2) policy + count — Cedar context 의 입력
  const policies = loadAgentPolicies(presenceDir)
  const count = getActiveAgentCount(requester, { basePath })

  // (3) Cedar enforcement point — quota + admin hard-limit 정책 흡수
  //   - 10-quota.cedar: !isAdmin && currentCount >= maxAgents
  //   - 11-admin-limit.cedar: isAdmin && currentCount >= hardLimit
  // KG-23 — Op.CheckAccess 도메인 어휘 경유.
  const isAdmin = requester === ADMIN_USERNAME
  const hardLimit = resolveAdminHardLimit()
  const checkAccessOp = CheckAccess({
    principal: { type: 'LocalUser', id: requester },
    action:    'create_agent',
    resource:  { type: 'User', id: requester },
    context:   { currentCount: count, maxAgents: policies.maxAgentsPerUser, isAdmin, hardLimit },
  })
  const cedarResult = runCheckAccess(evaluator, checkAccessOp)
  const verdict = interpretCedarDecision(cedarResult, { autoApprove: policies.autoApproveUnderQuota })

  if (verdict.status === STATUS.DENIED) {
    return { status: STATUS.DENIED, reason: verdict.reason, detail: verdict.detail }
  }

  if (verdict.status === STATUS.APPROVED) {
    appendAgentToConfig({ username: requester, agentName, persona, basePath })
    return { status: STATUS.APPROVED, detail: `auto-approved (count ${count}/${policies.maxAgentsPerUser})` }
  }

  // (4) PENDING — quota-exceeded (Cedar deny) 또는 manual-review (Cedar allow + autoApprove=false)
  const reqId = generateRequestId()
  writePendingRequest(presenceDir, {
    id: reqId, requester, agentName, persona,
    submittedAt: new Date().toISOString(),
    status: STATUS.PENDING,
    reason: verdict.reason,
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
    reason: reason || REASON.DENIED_UNSPECIFIED,
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
  REASON,
  PENDING_REASON,
  classifyDeny,
  interpretCedarDecision,
  loadAgentPolicies, loadAgentPoliciesR,
  getActiveAgentCount, getActiveAgentCountR,
  submitUserAgent, submitUserAgentR,
  approveUserAgent, approveUserAgentR,
  denyUserAgent, denyUserAgentR,
  listPending, listApproved, listRejected,
  readPendingRequest,
}
