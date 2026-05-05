import { isReservedUsername } from '@presence/core/core/agent-id.js'
import { CheckAccess } from '@presence/core/core/op.js'
import { AUDIT_ACTION } from '@presence/core/core/policies.js'
import { ADMIN_USERNAME } from '../admin-bootstrap.js'
import { runCheckAccess } from './cedar/op-runner.js'

// =============================================================================
// canAccessAgent — docs/design/agent-identity-model.md §9.4
//
// 모든 agent 실행 진입점 (5 곳, §9.4 표) 은 실행 이전에 이 함수를 호출해야 한다.
// 결과 `allow=false` 시 즉시 거부. 진입점 spy 테스트로 불변식 강제 예정 (authz phase).
//
// 시그니처: canAccessAgent(input) → { allow, reason? }
//
//   input: { jwtSub, agentId, intent, registry?, evaluator?, findAdminSession? }
//     jwtSub     — 호출자 username (JWT sub claim 또는 CLI context)
//     agentId    — qualified agent ID ('{user}/{name}')
//     intent     — 아래 INTENT enum 중 하나
//     registry   — AgentRegistry (archived 판정용, optional)
//     evaluator  — Cedar evaluator. registry + 등록된 entry 있을 때 필수
//                  (governance-cedar v2.6 §X1 — invariant 강제). 미전달 시
//                  REASON.MISSING_EVALUATOR fail-closed.
//
// 정책 (코드 순서 = 우선순위):
//   1. Reserved admin/* → jwtSub 가 'admin' 이 아니면 거부
//   2. 일반 agent → agentId 의 username prefix 가 jwtSub 와 일치해야 함
//   3. Archived agent — registry + entry 있으면 evaluator 필수 (invariant).
//      `20-archived.cedar` 가 `archived && intent != "continue-session"` deny.
//      registry/entry 없으면 archived 판정 자체를 skip (ownership 만).
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
  MISSING_EVALUATOR: 'missing-evaluator',
  MISSING_REGISTRY: 'missing-registry',
  AGENT_NOT_REGISTERED: 'agent-not-registered',
  INVALID_AGENT_ID: 'invalid-agent-id',
  INVALID_INTENT: 'invalid-intent',
  ADMIN_SINGLETON: 'admin-singleton',
  INVALID_PEER_AGENT_ID: 'invalid-peer-agent-id',
  A2A_DENIED: 'a2a-denied',
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
  const evaluator = params.evaluator
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

  // 3. Archived — registry + entry 있으면 evaluator 필수 (governance-cedar v2.6 §X1).
  //    `20-archived.cedar` 가 archived && intent != "continue-session" deny.
  //    registry 또는 entry 부재면 archived 판정 자체를 skip.
  if (registry) {
    const maybeEntry = registry.get(agentId)
    const entry = maybeEntry && maybeEntry.isJust && maybeEntry.isJust() ? maybeEntry.value : null
    if (entry) {
      if (typeof evaluator !== 'function') return deny(REASON.MISSING_EVALUATOR)
      const archived = !!entry.archived
      const op = CheckAccess({
        principal: { type: 'LocalUser', id: jwtSub },
        action:    AUDIT_ACTION.ACCESS_AGENT,
        resource:  { type: 'Agent', id: agentId },
        context:   { intent, archived },
      })
      const decision = runCheckAccess(evaluator, op)
      if (decision.decision !== 'allow') return deny(REASON.ARCHIVED)
    }
  }

  // 4. Admin singleton — NEW_SESSION + reserved owner + 활성 admin session 존재 시 거부
  if (intent === INTENT.NEW_SESSION && ownerIsReserved && typeof findAdminSession === 'function') {
    const existing = findAdminSession()
    if (existing && existing.kind === 'present') return deny(REASON.ADMIN_SINGLETON)
  }

  return allow()
}

// =============================================================================
// canStartA2aSession — agent-session.md I-AS-AUTH
//
// 외부 에이전트 B 가 presence 의 내부 에이전트 A 와 새 A2A 세션을 시작할 때
// 호출되는 인가 게이트. 카드 교환 단계 (agent-session.md §A2A 운영 흐름 1단계)
// 의 첫 결정 지점.
//
// 시그니처: canStartA2aSession(input) → { allow, reason? }
//
//   input: { jwtSub, agentId, peerAgentId, evaluator, registry }
//     jwtSub      — 내부 에이전트 A 의 owner username (= agentId 의 owner part).
//                   외부 에이전트 카드 교환은 server 측 라우터가 인증 후 호출.
//     agentId     — 내부 에이전트 A 의 qualified ID ('{user}/{name}')
//     peerAgentId — 외부 에이전트 B 의 카드 식별자. 공백 only 거부.
//     evaluator   — Cedar evaluator (필수 — A2A 는 Cedar 평가 없이 시작 금지)
//     registry    — AgentRegistry (필수 — archived 판정 정확성을 위해 fail-closed).
//                   드라이브 다운/stale 시 우회 위험 차단. 호출처가 user-context 의
//                   registry 를 주입한다.
//
// 정책 (코드 순서 = 우선순위):
//   1. peerAgentId 형식 검증 (raw string, trim 후 비어있지 않음)
//   2. evaluator/registry 부재 → fail-closed (각각 MISSING_EVALUATOR / MISSING_REGISTRY)
//   3. ownership: agentId owner === jwtSub (외부 에이전트가 내 에이전트로 도착)
//   4. registry 등록 부재 → AGENT_NOT_REGISTERED (registry 가 정상이어도 entry 없으면
//      archived 판정 불가 → fail-closed). agent-session.md I-AS-AUTH (Cedar 평가 통과
//      후만 세션 시작 허용) 의 결.
//   5. archived 분기: 21-archived-a2a.cedar 가 archived agent 새 A2A 세션 차단
//   6. Cedar 평가 (action=start_a2a_session) — 운영자 custom 50-*.cedar 가 peer 차단 가능
//
// canAccessAgent 와 분리 이유: 카드 교환은 별도 wire (외부→큐→heartbeat) 이고,
// principal/resource/context 결이 다름. INTENT enum 으로 통합하면 호출처 분기가
// 호출자 책임이 됨 — 별 helper 가 분기를 캡슐화.
// =============================================================================
function canStartA2aSession(input) {
  const params = input || {}
  const { jwtSub, agentId, peerAgentId, evaluator, registry } = params

  if (!jwtSub || typeof jwtSub !== 'string') return deny(REASON.MISSING_PRINCIPAL)
  if (!agentId || typeof agentId !== 'string' || !agentId.includes('/')) return deny(REASON.INVALID_AGENT_ID)
  if (typeof peerAgentId !== 'string') return deny(REASON.INVALID_PEER_AGENT_ID)
  // 공백 패딩 정규화 — Cedar context 에도 normalized 값을 넘겨야 50-* peer-exact-match
  // deny 가 ' banned/peer ' 같은 패딩으로 우회되지 않음 (codex round 2).
  const normalizedPeerAgentId = peerAgentId.trim()
  if (normalizedPeerAgentId === '') return deny(REASON.INVALID_PEER_AGENT_ID)
  if (typeof evaluator !== 'function') return deny(REASON.MISSING_EVALUATOR)
  if (!registry || typeof registry.get !== 'function') return deny(REASON.MISSING_REGISTRY)

  const ownerPart = agentId.split('/')[0]
  if (isReservedUsername(ownerPart)) {
    if (jwtSub !== ownerPart) return deny(REASON.ADMIN_ONLY)
  } else if (ownerPart !== jwtSub) {
    return deny(REASON.NOT_OWNER)
  }

  const maybeEntry = registry.get(agentId)
  const entry = maybeEntry && maybeEntry.isJust && maybeEntry.isJust() ? maybeEntry.value : null
  if (!entry) return deny(REASON.AGENT_NOT_REGISTERED)
  const archived = !!entry.archived

  const isAdmin = jwtSub === ADMIN_USERNAME
  const op = CheckAccess({
    principal: { type: 'LocalUser', id: jwtSub },
    action:    AUDIT_ACTION.START_A2A_SESSION,
    resource:  { type: 'Agent', id: agentId },
    context:   { peerAgentId: normalizedPeerAgentId, archived, isAdmin },
  })
  const decision = runCheckAccess(evaluator, op)
  if (decision.decision !== 'allow') {
    return deny(archived ? REASON.ARCHIVED : REASON.A2A_DENIED)
  }
  return allow()
}

export { canAccessAgent, canStartA2aSession, INTENT, REASON, inspectAccessInvocations, resetAccessInvocations }
