import { isReservedUsername } from '@presence/core/core/agent-id.js'

// =============================================================================
// canAccessAgent — docs/design/agent-identity-model.md §9.4
//
// 모든 agent 실행 진입점 (5 곳, §9.4 표) 은 실행 이전에 이 함수를 호출해야 한다.
// 결과 `allow=false` 시 즉시 거부. 진입점 spy 테스트로 불변식 강제 예정 (authz phase).
//
// 시그니처: canAccessAgent(input) → { allow, reason? }
//
//   input: { jwtSub, agentId, intent, registry? }
//     jwtSub    — 호출자 username (JWT sub claim 또는 CLI context)
//     agentId   — qualified agent ID ('{user}/{name}')
//     intent    — 아래 INTENT enum 중 하나
//     registry  — AgentRegistry (archived 판정용, optional)
//
// 정책 (코드 순서 = 우선순위):
//   1. Reserved admin/* → jwtSub 가 'admin' 이 아니면 거부
//   2. 일반 agent → agentId 의 username prefix 가 jwtSub 와 일치해야 함
//   3. Archived agent + (new-session | delegate | scheduled-run) → 거부
//      (continue-session 은 허용 — §5.4 graceful retire)
//   4. Admin singleton (KG-15, §9.3.5): NEW_SESSION + reserved owner +
//      findAdminSession() === 'present' → 거부 (concurrent admin race 차단).
//      callback 미전달 시 검사 skip (하위 호환).
// =============================================================================

const INTENT = Object.freeze({
  NEW_SESSION: 'new-session',
  CONTINUE_SESSION: 'continue-session',
  DELEGATE: 'delegate',
  SCHEDULED_RUN: 'scheduled-run',
})

const REASON = Object.freeze({
  ADMIN_ONLY: 'admin-only',
  NOT_OWNER: 'not-owner',
  ARCHIVED: 'archived',
  MISSING_PRINCIPAL: 'missing-principal',
  INVALID_AGENT_ID: 'invalid-agent-id',
  INVALID_INTENT: 'invalid-intent',
  ADMIN_SINGLETON: 'admin-singleton',
})

const VALID_INTENTS = new Set(Object.values(INTENT))

const deny = (reason) => ({ allow: false, reason })
const allow = () => ({ allow: true })

// KG-18 — 5 진입점 enforcement 검증용 inspector. 호출 자취를 ring 버퍼에 기록.
// 통합 테스트가 reset → 진입점 트리거 → inspect 로 spy 검증. production 부수는
// 호출당 작은 객체 push + cap 초과 시 단발 slice (cap=200, 30 분 가량 보관).
const INVOCATION_LOG_CAP = 200
let invocations = []

const recordInvocation = (input) => {
  invocations.push({ intent: input?.intent, jwtSub: input?.jwtSub, agentId: input?.agentId })
  if (invocations.length > INVOCATION_LOG_CAP) invocations = invocations.slice(-INVOCATION_LOG_CAP)
}
const inspectAccessInvocations = () => invocations.slice()
const resetAccessInvocations = () => { invocations = [] }

function canAccessAgent(input) {
  recordInvocation(input)
  const params = input || {}
  const jwtSub = params.jwtSub
  const agentId = params.agentId
  const intent = params.intent
  const registry = params.registry
  const findAdminSession = params.findAdminSession

  if (!jwtSub || typeof jwtSub !== 'string') return deny(REASON.MISSING_PRINCIPAL)
  if (!agentId || typeof agentId !== 'string' || !agentId.includes('/')) return deny(REASON.INVALID_AGENT_ID)
  if (!VALID_INTENTS.has(intent)) return deny(REASON.INVALID_INTENT)

  const ownerPart = agentId.split('/')[0]
  const ownerIsReserved = isReservedUsername(ownerPart)

  // 1. Reserved admin/* — jwtSub 가 admin 이어야 함.
  if (ownerIsReserved) {
    if (jwtSub !== ownerPart) return deny(REASON.ADMIN_ONLY)
  } else if (ownerPart !== jwtSub) {
    // 2. 일반 agent — owner 일치
    return deny(REASON.NOT_OWNER)
  }

  // 3. Archived — continue-session 만 허용
  if (registry) {
    const maybeEntry = registry.get(agentId)
    const entry = maybeEntry && maybeEntry.isJust && maybeEntry.isJust() ? maybeEntry.value : null
    if (entry && entry.archived && intent !== INTENT.CONTINUE_SESSION) {
      return deny(REASON.ARCHIVED)
    }
  }

  // 4. Admin singleton — NEW_SESSION + reserved owner + 활성 admin session 존재 시 거부
  if (intent === INTENT.NEW_SESSION && ownerIsReserved && typeof findAdminSession === 'function') {
    const existing = findAdminSession()
    if (existing && existing.kind === 'present') return deny(REASON.ADMIN_SINGLETON)
  }

  return allow()
}

export { canAccessAgent, INTENT, REASON, inspectAccessInvocations, resetAccessInvocations }
