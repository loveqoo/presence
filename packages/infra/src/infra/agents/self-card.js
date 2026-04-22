import { validateAgentId } from '@presence/core/core/agent-id.js'
import fp from '@presence/core/lib/fun-fp.js'
import { DelegationMode } from './delegation.js'

const { Either } = fp

// =============================================================================
// Self Agent Card — docs/design/agent-identity-model.md §11.1
//
// 서버의 로컬 agent 가 외부에 노출하는 메타데이터. A2A discovery 에 사용.
//
// Shape:
//   {
//     "name":        "{agentId}",          // canonical qualified id
//     "url":         "{publicUrl}/a2a/{agentId}",
//     "description": "...",
//     "capabilities": [...],
//     "x-presence": {
//       "agentId":    "{agentId}",
//       "roles":      ["owner"]
//       // publicKey 는 authz phase (§13 — authz 에 위임)
//     }
//   }
//
// 이 모듈은 **순수** — 네트워크/파일 접근 없음. card JSON 조립만.
// =============================================================================

const trimTrailingSlash = (url) => (url || '').replace(/\/+$/, '')

const buildSelfCard = (spec) => {
  if (!spec || typeof spec !== 'object') throw new Error('buildSelfCard: spec required')
  const { agentId, publicUrl, description, capabilities } = spec
  const validation = validateAgentId(agentId)
  if (Either.isLeft(validation)) {
    const reason = Either.fold(e => e, () => '', validation)
    throw new Error(`buildSelfCard: invalid agentId "${agentId}" — ${reason}`)
  }
  if (!publicUrl || typeof publicUrl !== 'string') {
    throw new Error('buildSelfCard: publicUrl required')
  }
  return {
    name: agentId,
    url: `${trimTrailingSlash(publicUrl)}/a2a/${agentId}`,
    description: description || '',
    capabilities: Array.isArray(capabilities) ? [...capabilities] : [],
    'x-presence': {
      agentId,
      roles: ['owner'],
    },
  }
}

// Registry entry → card. LOCAL 엔트리만 노출 대상 (REMOTE 는 외부 peer).
const isCardEligible = (entry) => {
  if (!entry) return false
  if (entry.archived) return false
  // remote agent 는 자신의 publicUrl 이 아닌 외부 서버의 agent → self card 대상 아님.
  // 명시적 필드가 없으면 local 간주.
  if (entry.type && entry.type !== DelegationMode.LOCAL) return false
  return true
}

const buildSelfCardsFromRegistry = (registry, publicUrl) => {
  if (!registry || typeof registry.list !== 'function') return []
  const entries = registry.list().filter(isCardEligible)
  return entries.map(entry => buildSelfCard({
    agentId: entry.agentId,
    publicUrl,
    description: entry.description,
    capabilities: entry.capabilities,
  }))
}

export { buildSelfCard, buildSelfCardsFromRegistry, isCardEligible }
