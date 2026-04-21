import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import fp from '@presence/core/lib/fun-fp.js'

const { Reader } = fp

// =============================================================================
// Admin bootstrap 상태기계 — docs/design/agent-identity-model.md §7.3
//
// 서버 부팅 시 실행. 각 단계 idempotent. 실패 시 throw → 서버 부팅 거부.
//
// State 0: admin 계정 존재? (userStore.findUser('admin'))
//   └─ NO → 랜덤 비밀번호 + userStore.addUser + admin-initial-password.txt (0600)
// State 1: admin config.json 에 'manager' agent 등록?
//   └─ NO → admin-persona.json 번들 로드 + config.json 작성
// State 2: agent-policies.json 존재?
//   └─ NO → 기본 정책 (maxAgentsPerUser: 5) 작성
// =============================================================================

const ADMIN_USERNAME = 'admin'
const ADMIN_AGENT_NAME = 'manager'
const ADMIN_AGENT_ID = `${ADMIN_USERNAME}/${ADMIN_AGENT_NAME}`
const INITIAL_PASSWORD_FILENAME = 'admin-initial-password.txt'

const DEFAULT_POLICIES = Object.freeze({
  maxAgentsPerUser: 5,
  autoApproveUnderQuota: true,
})

// Admin persona 번들 로더
const loadAdminPersona = () => {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const personaPath = join(__dirname, 'persona', 'defaults', 'admin-persona.json')
  return JSON.parse(readFileSync(personaPath, 'utf-8'))
}

// --- Atomic write — tmp 에 쓰고 rename. 중간 crash 시 orphan tmp 만 남음 ---

const atomicWriteJson = (filePath, data, { mode } = {}) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, filePath)
}

const atomicWriteText = (filePath, text, { mode } = {}) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, text, 'utf-8')
  if (mode !== undefined) chmodSync(tmp, mode)
  renameSync(tmp, filePath)
}

// --- State 0: admin 계정 ---

const ensureAdminAccountR = Reader.asks(({ userStore, presenceDir, logger }) => async () => {
  const existing = userStore.findUser(ADMIN_USERNAME)
  if (existing) {
    logger?.info('[admin-bootstrap] State 0 skipped — admin account exists')
    return { createdAccount: false, initialPassword: null }
  }
  const initialPassword = randomBytes(16).toString('base64url')
  await userStore.addUser(ADMIN_USERNAME, initialPassword)
  const passwordFile = join(presenceDir, INITIAL_PASSWORD_FILENAME)
  atomicWriteText(passwordFile, `${initialPassword}\n`, { mode: 0o600 })
  logger?.info(`[admin-bootstrap] admin account created. Initial password saved to ${passwordFile}`)
  logger?.info(`[admin-bootstrap] INITIAL PASSWORD: ${initialPassword}`)
  return { createdAccount: true, initialPassword }
})

// --- State 1: admin/manager agent config ---

const ensureAdminManagerAgentR = Reader.asks(({ presenceDir, logger }) => () => {
  const adminDir = join(presenceDir, 'users', ADMIN_USERNAME)
  const configPath = join(adminDir, 'config.json')
  let config = {}
  if (existsSync(configPath)) {
    try { config = JSON.parse(readFileSync(configPath, 'utf-8')) } catch (_) { config = {} }
  }
  if (!Array.isArray(config.agents)) config.agents = []
  const hasManager = config.agents.some(a => a.name === ADMIN_AGENT_NAME)
  if (hasManager) {
    logger?.info('[admin-bootstrap] State 1 skipped — admin/manager agent registered')
    return { registeredAgent: false }
  }
  const persona = loadAdminPersona()
  config.agents.push({
    name: ADMIN_AGENT_NAME,
    description: 'presence 관리자 에이전트 — 서버 전역 정책 및 user agent 심사',
    capabilities: [],
    persona,
    createdAt: new Date().toISOString(),
    createdBy: 'admin-bootstrap',
    archived: false,
  })
  atomicWriteJson(configPath, config)
  logger?.info(`[admin-bootstrap] admin/manager agent registered at ${configPath}`)
  return { registeredAgent: true }
})

// --- State 2: agent-policies.json ---

const ensureAgentPoliciesR = Reader.asks(({ presenceDir, logger }) => () => {
  const policiesPath = join(presenceDir, 'users', ADMIN_USERNAME, 'agent-policies.json')
  if (existsSync(policiesPath)) {
    logger?.info('[admin-bootstrap] State 2 skipped — agent-policies.json exists')
    return { createdPolicies: false }
  }
  atomicWriteJson(policiesPath, DEFAULT_POLICIES)
  logger?.info(`[admin-bootstrap] default agent-policies.json created at ${policiesPath}`)
  return { createdPolicies: true }
})

// --- 합성 Reader — 부팅 진입점 ---

const runAdminBootstrapR = Reader.asks((deps) => async () => {
  if (!deps.userStore || !deps.presenceDir) {
    throw new Error('runAdminBootstrap: userStore and presenceDir required')
  }
  mkdirSync(deps.presenceDir, { recursive: true })
  const r0 = await ensureAdminAccountR.run(deps)()
  const r1 = ensureAdminManagerAgentR.run(deps)()
  const r2 = ensureAgentPoliciesR.run(deps)()
  return { ...r0, ...r1, ...r2 }
})

// 레거시 브릿지
const runAdminBootstrap = (deps) => runAdminBootstrapR.run(deps)()

// --- Initial password 파일 삭제 (비밀번호 변경 성공 후 호출) ---

const deleteInitialPasswordFile = (presenceDir) => {
  const p = join(presenceDir, INITIAL_PASSWORD_FILENAME)
  if (existsSync(p)) {
    try { unlinkSync(p) } catch (_) { /* best effort */ }
  }
}

export {
  runAdminBootstrap,
  runAdminBootstrapR,
  deleteInitialPasswordFile,
  ADMIN_USERNAME,
  ADMIN_AGENT_NAME,
  ADMIN_AGENT_ID,
  INITIAL_PASSWORD_FILENAME,
  DEFAULT_POLICIES,
}
