import fp from '../lib/fun-fp.js'

const { Either } = fp

// =============================================================================
// Agent ID validation — docs/design/agent-identity-model.md §3
//
// AgentId = `{username}/{agentName}` (qualified form)
// - 각 part: kebab-case. 첫 글자 소문자. 끝 글자 소문자/숫자.
// - 길이 1~63. 연속 하이픈 금지. 언더바/대문자/숫자 시작 금지.
// - slash 정확히 1 개
//
// RESERVED_USERNAMES: admin 은 server-singleton. Authz 에서 특별 취급.
// =============================================================================

const AGENT_NAME_REGEX = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/

const RESERVED_USERNAMES = Object.freeze(['admin'])

const validateAgentNamePart = (name) => {
  if (typeof name !== 'string') return Either.Left('name must be string')
  if (name.length < 1 || name.length > 63) return Either.Left('length 1~63')
  if (!AGENT_NAME_REGEX.test(name)) return Either.Left('kebab-case only, no trailing hyphen, no leading digit')
  if (name.includes('--')) return Either.Left('no consecutive hyphens')
  return Either.Right(name)
}

const validateAgentId = (id) => {
  if (typeof id !== 'string') return Either.Left('agentId must be string')
  const parts = id.split('/')
  if (parts.length !== 2) return Either.Left('must be {username}/{agentName}')
  const [rawUsername, rawAgentName] = parts
  return Either.chain(validUsername =>
         Either.chain(validAgentName =>
         Either.Right(`${validUsername}/${validAgentName}`), validateAgentNamePart(rawAgentName)), validateAgentNamePart(rawUsername))
}

const isReservedUsername = (username) => RESERVED_USERNAMES.includes(username)

// USER 세션 생성 시 agentId / agent dir 결정. config.primaryAgentId 가
// canonical form 이면 그대로 사용, 아니면 ${fallbackUserId}/default 로 fallback.
// (KG-16 — M3 hardcode 이관)
const resolvePrimaryAgent = (config, fallbackUserId) => {
  const primaryId = config?.primaryAgentId
  if (typeof primaryId === 'string') {
    const result = validateAgentId(primaryId)
    if (!Either.isLeft(result)) {
      const [, agentName] = primaryId.split('/')
      return { agentId: primaryId, agentName }
    }
  }
  return { agentId: `${fallbackUserId}/default`, agentName: 'default' }
}

// 호환 — session.js 내 동등 정규식 교체 용도.
// validateAgentId 는 Either 반환이지만, legacy 검증은 throw 패턴.
const assertValidAgentId = (id) => {
  const result = validateAgentId(id)
  if (Either.isLeft(result)) {
    throw new Error(`invalid agentId "${id}" — ${Either.fold(e => e, () => '', result)}`)
  }
}

export {
  AGENT_NAME_REGEX,
  RESERVED_USERNAMES,
  validateAgentNamePart,
  validateAgentId,
  isReservedUsername,
  assertValidAgentId,
  resolvePrimaryAgent,
}
