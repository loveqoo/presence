import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import fp from '@presence/core/lib/fun-fp.js'
import { Config } from './config.js'
import { loadUserMerged } from './config-loader.js'
import { ADMIN_USERNAME } from './admin-bootstrap.js'

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

// --- Atomic write ---

const atomicWriteJson = (filePath, data) => {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
  renameSync(tmp, filePath)
}

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
  const fileConfig = readExistingConfig(configPath)
  if (!Array.isArray(fileConfig.agents)) fileConfig.agents = []
  const hasDefault = fileConfig.agents.some(a => a.name === DEFAULT_AGENT_NAME)
  const hasPrimary = fileConfig.primaryAgentId === primaryId

  if (hasDefault && hasPrimary) {
    return { config, migrated: false, reason: 'already' }
  }

  if (!hasDefault) fileConfig.agents.push(buildDefaultAgent(username))
  fileConfig.primaryAgentId = primaryId

  atomicWriteJson(configPath, fileConfig)
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
