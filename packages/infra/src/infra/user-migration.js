import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from './config.js'
import { loadUserMerged } from './config-loader.js'
import { ADMIN_USERNAME } from './admin-bootstrap.js'
import { atomicWriteJson } from './fs-utils.js'

const { Reader } = fp

// =============================================================================
// M3 + M4 user migration — docs/design/agent-identity-model.md §12
//
// 비-admin user 의 config.json 에:
//   - primaryAgentId 없으면 `{username}/default` 로 보충
//   - agents[] 에 'default' 없으면 DEFAULT_PERSONA seed 로 신규 entry 추가
// Idempotent. 이미 둘 다 있으면 no-op.
//
// 호출: UserContext.create 안에서 ensureAllowedDirs 직후.
// Admin 은 admin-bootstrap 이 이미 처리 — 여기서는 skip.
// =============================================================================

const DEFAULT_AGENT_NAME = 'default'

// persona.js 의 DEFAULT_PERSONA 와 동일한 seed.
// 중복 정의가 아니라 "agent 필드로 이관된 persona 의 seed" — 의도적 분리.
const DEFAULT_AGENT_PERSONA = Object.freeze({
  name: 'Presence',
  systemPrompt: null,
  rules: [],
  tools: [],
})

const readExistingConfig = (configPath) => {
  if (!existsSync(configPath)) return {}
  try { return JSON.parse(readFileSync(configPath, 'utf-8')) } catch (_) { return {} }
}

const buildDefaultAgent = (username) => ({
  name: DEFAULT_AGENT_NAME,
  description: `${username} 기본 에이전트`,
  capabilities: [],
  persona: { ...DEFAULT_AGENT_PERSONA },
  createdAt: new Date().toISOString(),
  createdBy: 'user-migration',
  archived: false,
})

// --- state machine ---

const ensureUserDefaultAgentR = Reader.asks(({ config, username, basePath, logger }) => () => {
  if (!username) throw new Error('ensureUserDefaultAgent: username required')
  if (username === ADMIN_USERNAME) {
    logger?.info('[user-migration] skipped — admin handled by admin-bootstrap')
    return { config, migrated: false, reason: 'admin' }
  }

  const primaryId = `${username}/${DEFAULT_AGENT_NAME}`
  const configPath = join(Config.resolveDir(basePath), 'users', username, 'config.json')
  const existing = readExistingConfig(configPath)
  const existingAgents = Array.isArray(existing.agents) ? existing.agents : []
  const hasDefault = existingAgents.some(a => a.name === DEFAULT_AGENT_NAME)
  const hasPrimary = existing.primaryAgentId === primaryId

  if (hasDefault && hasPrimary) {
    return { config, migrated: false, reason: 'already' }
  }

  // 불변 조립 — 기존 config 변이하지 않고 새 객체 구성.
  const nextAgents = hasDefault ? existingAgents : [...existingAgents, buildDefaultAgent(username)]
  const nextConfig = { ...existing, agents: nextAgents, primaryAgentId: primaryId }
  atomicWriteJson(configPath, nextConfig)
  logger?.info(`[user-migration] ${username}: primaryAgentId=${primaryId}${!hasDefault ? ' + default agent seeded' : ''}`)

  // 변경된 파일을 다시 merge 하여 반환 (ensureAllowedDirs 패턴과 일치)
  return { config: loadUserMerged(username, { basePath }), migrated: true, primaryAgentId: primaryId }
})

// 레거시 브릿지 — 단일 라인 위임
const ensureUserDefaultAgent = (config, deps) => ensureUserDefaultAgentR.run({ config, ...deps })()

export {
  ensureUserDefaultAgentR,
  ensureUserDefaultAgent,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_PERSONA,
}
