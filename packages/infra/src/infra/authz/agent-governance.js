import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from '../config.js'
import { ADMIN_USERNAME, DEFAULT_POLICIES } from '../admin-bootstrap.js'
import { validateAgentNamePart } from '@presence/core/core/agent-id.js'

const { Either, Reader } = fp

// =============================================================================
// Agent governance — docs/design/agent-identity-model.md §8
//
// Admin agent 가 관리하는 user agent 생성 승인 플로우.
//
// 핵심 원칙:
//   - user config 의 `agents[]` 가 권위 (single source of truth)
//   - pending/{reqId}.json 은 요청 큐 (보조)
//   - 모든 파일 변경은 atomic (tmp + rename)
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
})

// --- file utils ---

function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null
  try { return JSON.parse(readFileSync(filePath, 'utf-8')) } catch (_) { return null }
}

function adminDir(presenceDir) {
  return join(presenceDir, 'users', ADMIN_USERNAME)
}

function queueDir(presenceDir, sub) {
  return join(adminDir(presenceDir), sub)
}

function requestPath(presenceDir, sub, reqId) {
  return join(queueDir(presenceDir, sub), `${reqId}.json`)
}

function generateRequestId() {
  return `req-${randomBytes(6).toString('hex')}`
}

// --- policies ---

function loadAgentPolicies(presenceDir) {
  const policiesPath = join(adminDir(presenceDir), 'agent-policies.json')
  const data = readJson(policiesPath)
  if (!data) return { ...DEFAULT_POLICIES }
  return {
    maxAgentsPerUser: typeof data.maxAgentsPerUser === 'number' ? data.maxAgentsPerUser : DEFAULT_POLICIES.maxAgentsPerUser,
    autoApproveUnderQuota: data.autoApproveUnderQuota !== undefined ? !!data.autoApproveUnderQuota : DEFAULT_POLICIES.autoApproveUnderQuota,
  }
}

// --- active count (재계산 — docs §8.1) ---

function loadUserConfigFile(username, basePath) {
  const path = join(Config.resolveDir(basePath), 'users', username, 'config.json')
  return { path, data: readJson(path) || {} }
}

function getActiveAgentCount(username, opts) {
  const { data } = loadUserConfigFile(username, (opts || {}).basePath)
  if (!Array.isArray(data.agents)) return 0
  return data.agents.filter(a => !a.archived).length
}

// --- user config mutation ---

function appendAgentToConfig(params) {
  const { path, data } = loadUserConfigFile(params.username, params.basePath)
  if (!Array.isArray(data.agents)) data.agents = []
  data.agents.push({
    name: params.agentName,
    description: `${params.username} 사용자 에이전트 (${params.agentName})`,
    capabilities: [],
    persona: { ...params.persona },
    createdAt: new Date().toISOString(),
    createdBy: 'agent-governance',
    archived: false,
  })
  atomicWriteJson(path, data)
}

// --- pending queue ops ---

function writePendingRequest(presenceDir, request) {
  atomicWriteJson(requestPath(presenceDir, SUB_DIRS.PENDING, request.id), request)
}

function listRequestsIn(presenceDir, sub) {
  const dir = queueDir(presenceDir, sub)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(join(dir, f)))
    .filter(Boolean)
}

function readPendingRequest(presenceDir, reqId) {
  return readJson(requestPath(presenceDir, SUB_DIRS.PENDING, reqId))
}

function moveRequest(presenceDir, reqId, fromSub, toSub, extras) {
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

// --- flows ---

// docs §8.3 — 승인 플로우
// returns { status, reqId?, detail? }
function submitUserAgent(params) {
  const requester = params.requester
  const agentName = params.agentName
  const persona = params.persona
  const basePath = params.basePath
  const presenceDir = params.presenceDir

  if (!requester || !agentName) throw new Error('submitUserAgent: requester + agentName required')
  const nameCheck = validateAgentNamePart(agentName)
  if (Either.isLeft(nameCheck)) {
    throw new Error(`submitUserAgent: invalid agentName — ${Either.fold(e => e, () => '', nameCheck)}`)
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
    reason: !underQuota ? 'quota-exceeded' : 'manual-review',
    currentCount: count,
    maxAgentsPerUser: policies.maxAgentsPerUser,
  })
  return { status: STATUS.PENDING, reqId }
}

// docs §8.3.5 — idempotent replay
function approveUserAgent(reqId, opts) {
  const presenceDir = opts.presenceDir
  const basePath = opts.basePath
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
}

function denyUserAgent(reqId, reason, opts) {
  const presenceDir = opts.presenceDir
  const req = readPendingRequest(presenceDir, reqId)
  if (!req) return { status: STATUS.NOT_FOUND }
  moveRequest(presenceDir, reqId, SUB_DIRS.PENDING, SUB_DIRS.REJECTED, { reason: reason || 'unspecified' })
  return { status: STATUS.REJECTED }
}

function listPending(presenceDir) {
  return listRequestsIn(presenceDir, SUB_DIRS.PENDING)
}

function listApproved(presenceDir) {
  return listRequestsIn(presenceDir, SUB_DIRS.APPROVED)
}

function listRejected(presenceDir) {
  return listRequestsIn(presenceDir, SUB_DIRS.REJECTED)
}

// --- Reader 변형 (DI 일관성) ---

const loadAgentPoliciesR = Reader.asks(({ presenceDir }) => () => loadAgentPolicies(presenceDir))
const getActiveAgentCountR = Reader.asks(({ username, basePath }) => () => getActiveAgentCount(username, { basePath }))

export {
  STATUS,
  loadAgentPolicies, loadAgentPoliciesR,
  getActiveAgentCount, getActiveAgentCountR,
  submitUserAgent,
  approveUserAgent,
  denyUserAgent,
  listPending, listApproved, listRejected,
  readPendingRequest,
}
