import { canAccessAgent, canStartA2aSession, INTENT, REASON, inspectAccessInvocations, resetAccessInvocations } from '@presence/infra/infra/authz/agent-access.js'
import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { assert, summary } from '../../../test/lib/assert.js'
import { createMockEvaluator } from '../../../test/lib/cedar-mock.js'

console.log('canAccessAgent tests')

// AA1. 본인 agent, new-session → allow
{
  const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent: INTENT.NEW_SESSION })
  assert(r.allow === true, 'AA1: own agent allowed')
}

// AA2. admin → admin/manager allow
{
  const r = canAccessAgent({ jwtSub: 'admin', agentId: 'admin/manager', intent: INTENT.NEW_SESSION })
  assert(r.allow === true, 'AA2: admin/manager by admin')
}

// AA3. non-admin → admin/manager deny 'admin-only'
{
  const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'admin/manager', intent: INTENT.DELEGATE })
  assert(r.allow === false, 'AA3: non-admin → admin/manager denied')
  assert(r.reason === REASON.ADMIN_ONLY, 'AA3: reason=admin-only')
}

// AA4. user A → user B agent deny 'not-owner'
{
  const r = canAccessAgent({ jwtSub: 'alice', agentId: 'bob/daily', intent: INTENT.NEW_SESSION })
  assert(r.allow === false, 'AA4: cross-user denied')
  assert(r.reason === REASON.NOT_OWNER, 'AA4: reason=not-owner')
}

// AA5~AA8 archived/non-archived semantics: governance-cedar v2.6 §X1 invariant 강제로
// AA-X1/AA-X2/AA-X3/AA-X5 가 evaluator 경로로 대체. legacy fallback 제거됨.

// AA9. agent 등록 없는 registry (unknown agent) — archived check 는 skip, ownership 만
{
  const reg = createAgentRegistry()
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/ghost', intent: INTENT.NEW_SESSION, registry: reg,
  })
  // archived 판정 불가 → allow (session 생성은 이후 단계에서 막힐 수 있음)
  assert(r.allow === true, 'AA9: 미등록 agent → ownership 통과 (archived skip)')
}

// AA10. registry 없이도 ownership 판정 가능
{
  const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent: INTENT.DELEGATE })
  assert(r.allow === true, 'AA10: registry 없이도 ownership allow')
}

// AA11. jwtSub 누락 → missing-principal
{
  const r = canAccessAgent({ agentId: 'anthony/default', intent: INTENT.DELEGATE })
  assert(r.allow === false, 'AA11: jwtSub 누락 → deny')
  assert(r.reason === REASON.MISSING_PRINCIPAL, 'AA11: reason=missing-principal')
}

// AA12. agentId 누락 → invalid-agent-id
{
  const r = canAccessAgent({ jwtSub: 'anthony', intent: INTENT.DELEGATE })
  assert(r.allow === false, 'AA12: agentId 누락 → deny')
  assert(r.reason === REASON.INVALID_AGENT_ID, 'AA12: reason=invalid-agent-id')
}

// AA13. agentId 에 slash 없음 → invalid-agent-id
{
  const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'default', intent: INTENT.DELEGATE })
  assert(r.allow === false, 'AA13: slash 없음 → deny')
  assert(r.reason === REASON.INVALID_AGENT_ID, 'AA13: reason=invalid-agent-id')
}

// AA14. 잘못된 intent → invalid-intent
{
  const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent: 'random-intent' })
  assert(r.allow === false, 'AA14: invalid intent → deny')
  assert(r.reason === REASON.INVALID_INTENT, 'AA14: reason=invalid-intent')
}

// AA15. admin 이 본인 user agent (admin/personal) → allow
{
  const r = canAccessAgent({ jwtSub: 'admin', agentId: 'admin/personal', intent: INTENT.NEW_SESSION })
  assert(r.allow === true, 'AA15: admin can access own admin/* agents')
}

// AA16. 4 intent 모두 허용
{
  for (const intent of [INTENT.NEW_SESSION, INTENT.CONTINUE_SESSION, INTENT.DELEGATE, INTENT.SCHEDULED_RUN]) {
    const r = canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent })
    assert(r.allow === true, `AA16: intent=${intent} allowed`)
  }
}

// AA17 ~ AA19. KG-18 spy infra — 5 진입점 enforcement 검증용 invocation log
// AA17. canAccessAgent 호출 시 inspector 가 호출 자취 캡처 (intent / jwtSub / agentId)
{
  resetAccessInvocations()
  canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent: INTENT.DELEGATE })
  const calls = inspectAccessInvocations()
  assert(calls.length === 1, 'AA17: 1 호출 기록')
  assert(calls[0].intent === INTENT.DELEGATE, 'AA17: intent 캡처')
  assert(calls[0].jwtSub === 'anthony', 'AA17: jwtSub 캡처')
  assert(calls[0].agentId === 'anthony/default', 'AA17: agentId 캡처')
}

// AA18. resetAccessInvocations 가 자취를 비움
{
  canAccessAgent({ jwtSub: 'anthony', agentId: 'anthony/default', intent: INTENT.NEW_SESSION })
  resetAccessInvocations()
  assert(inspectAccessInvocations().length === 0, 'AA18: reset 후 빈 자취')
}

// AA19. deny path 도 자취 기록 (호출 자체 검증 — enforcement 의무 spy)
{
  resetAccessInvocations()
  const r = canAccessAgent({ jwtSub: 'alice', agentId: 'bob/daily', intent: INTENT.NEW_SESSION })
  assert(r.allow === false, 'AA19: deny 결과')
  assert(inspectAccessInvocations().length === 1, 'AA19: deny 도 호출 자취 기록')
}

// --- KG-15: Admin singleton session 강제 ---

// AS1. NEW_SESSION + admin/manager + 활성 admin session 존재 → deny ADMIN_SINGLETON
{
  const findAdminSession = () => ({ kind: 'present', entry: { id: 'admin-default' } })
  const r = canAccessAgent({
    jwtSub: 'admin', agentId: 'admin/manager', intent: INTENT.NEW_SESSION, findAdminSession,
  })
  assert(r.allow === false, 'AS1: 활성 admin 존재 → deny')
  assert(r.reason === REASON.ADMIN_SINGLETON, 'AS1: reason=admin-singleton')
}

// AS2. NEW_SESSION + admin/manager + admin session 부재 → allow
{
  const findAdminSession = () => ({ kind: 'absent', entry: null })
  const r = canAccessAgent({
    jwtSub: 'admin', agentId: 'admin/manager', intent: INTENT.NEW_SESSION, findAdminSession,
  })
  assert(r.allow === true, 'AS2: admin session 부재 → allow')
}

// AS3. CONTINUE_SESSION + admin/manager + 활성 admin session 존재 → allow
//      (singleton 은 NEW_SESSION 만 차단; 기존 세션 유지는 무관)
{
  const findAdminSession = () => ({ kind: 'present', entry: { id: 'admin-default' } })
  const r = canAccessAgent({
    jwtSub: 'admin', agentId: 'admin/manager', intent: INTENT.CONTINUE_SESSION, findAdminSession,
  })
  assert(r.allow === true, 'AS3: continue-session 은 singleton 무관')
}

// AS4. NEW_SESSION + 일반 user agent + 활성 admin session 존재 → allow
//      (singleton 은 reserved owner 만 적용)
{
  const findAdminSession = () => ({ kind: 'present', entry: { id: 'admin-default' } })
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/default', intent: INTENT.NEW_SESSION, findAdminSession,
  })
  assert(r.allow === true, 'AS4: 일반 user 는 singleton 영향 없음')
}

// AS5. NEW_SESSION + admin/manager + findAdminSession 미전달 → allow (하위 호환)
{
  const r = canAccessAgent({
    jwtSub: 'admin', agentId: 'admin/manager', intent: INTENT.NEW_SESSION,
  })
  assert(r.allow === true, 'AS5: callback 미전달 시 검사 skip')
}

// =============================================================================
// AA-X1~X6 — governance-cedar v2.5 §X (archived → Cedar 정책 흡수)
// =============================================================================

// AA-X1 — evaluator 전달 시 archived agent + new-session → Cedar deny → REASON.ARCHIVED
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/old', type: 'local', archived: true })
  const evaluator = createMockEvaluator()
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/old', intent: INTENT.NEW_SESSION, registry: reg, evaluator,
  })
  assert(r.allow === false, 'AA-X1: evaluator 경로 archived + new-session deny')
  assert(r.reason === REASON.ARCHIVED, `AA-X1: reason=archived (got ${r.reason})`)
}

// AA-X2 — evaluator 경로: archived + continue-session → Cedar allow
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/old', type: 'local', archived: true })
  const evaluator = createMockEvaluator()
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/old', intent: INTENT.CONTINUE_SESSION, registry: reg, evaluator,
  })
  assert(r.allow === true, 'AA-X2: evaluator 경로 archived + continue-session allow')
}

// AA-X3 — evaluator 가 호출되었음을 capture (Cedar context 셰이프 정확)
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/old', type: 'local', archived: true })
  let captured = null
  const evaluator = (input) => { captured = input; return { decision: 'deny', matchedPolicies: [], errors: [] } }
  canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/old', intent: INTENT.DELEGATE, registry: reg, evaluator,
  })
  assert(captured && captured.action === 'access_agent', 'AA-X3: action=access_agent')
  assert(captured.principal.type === 'LocalUser' && captured.principal.id === 'anthony', 'AA-X3: principal=LocalUser/anthony')
  assert(captured.resource.type === 'Agent' && captured.resource.id === 'anthony/old', 'AA-X3: resource=Agent/anthony/old')
  assert(captured.context.archived === true, 'AA-X3: context.archived=true')
  assert(captured.context.intent === 'delegate', `AA-X3: context.intent=delegate (got ${captured.context.intent})`)
}

// AA-X4 — governance-cedar v2.6 §X1: evaluator invariant 강제 — registry+entry 있는데
// evaluator 미전달 시 fail-closed (REASON.MISSING_EVALUATOR). legacy fallback 제거.
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/old', type: 'local', archived: true })
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/old', intent: INTENT.NEW_SESSION, registry: reg,
  })
  assert(r.allow === false, 'AA-X4: evaluator 미전달 → deny')
  assert(r.reason === REASON.MISSING_EVALUATOR, `AA-X4: reason=missing-evaluator (got ${r.reason})`)
}

// AA-X5 — evaluator 전달 + non-archived agent → 평가 호출되어도 allow
{
  const reg = createAgentRegistry()
  reg.register({ agentId: 'anthony/active', type: 'local', archived: false })
  let calls = 0
  const evaluator = (input) => { calls += 1; return createMockEvaluator()(input) }
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/active', intent: INTENT.NEW_SESSION, registry: reg, evaluator,
  })
  assert(r.allow === true, 'AA-X5: non-archived → allow')
  assert(calls === 1, `AA-X5: evaluator 1회 호출 (got ${calls})`)
}

// AA-X6 — registry 없으면 evaluator 호출 안됨 (archived 판정 불가 → skip)
{
  let called = false
  const evaluator = () => { called = true; return { decision: 'allow', matchedPolicies: [], errors: [] } }
  const r = canAccessAgent({
    jwtSub: 'anthony', agentId: 'anthony/foo', intent: INTENT.NEW_SESSION, evaluator,
  })
  assert(r.allow === true, 'AA-X6: registry 없으면 archived skip → allow')
  assert(called === false, 'AA-X6: evaluator 미호출 (registry 부재)')
}

// =============================================================================
// A2A1~A2A14 — agent-session.md I-AS-AUTH (canStartA2aSession)
// =============================================================================

// 공용 — registry + non-archived agent
const buildRegistry = ({ agentId = 'anthony/default', archived = false } = {}) => {
  const reg = createAgentRegistry()
  reg.register({ agentId, type: 'local', archived })
  return reg
}

// A2A1. 본인 agent + valid peer + evaluator + registered agent → allow
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'remote.example/bot', evaluator, registry,
  })
  assert(r.allow === true, 'A2A1: 본인 agent + peer + evaluator + registry → allow')
}

// A2A2. ownership mismatch → not-owner
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry({ agentId: 'bob/daily' })
  const r = canStartA2aSession({
    jwtSub: 'alice', agentId: 'bob/daily', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A2: cross-user → deny')
  assert(r.reason === REASON.NOT_OWNER, `A2A2: reason=not-owner (got ${r.reason})`)
}

// A2A3. archived agent + Cedar deny → REASON.ARCHIVED
{
  const registry = buildRegistry({ agentId: 'anthony/old', archived: true })
  const evaluator = createMockEvaluator()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/old', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A3: archived agent → deny')
  assert(r.reason === REASON.ARCHIVED, `A2A3: reason=archived (got ${r.reason})`)
}

// A2A4. peerAgentId 누락 → INVALID_PEER_AGENT_ID
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', evaluator, registry,
  })
  assert(r.allow === false, 'A2A4: peerAgentId 누락 → deny')
  assert(r.reason === REASON.INVALID_PEER_AGENT_ID, `A2A4: reason=invalid-peer-agent-id (got ${r.reason})`)
}

// A2A4b. peerAgentId 공백 only → INVALID_PEER_AGENT_ID (codex round 1 보강)
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: '   ', evaluator, registry,
  })
  assert(r.allow === false, 'A2A4b: peerAgentId 공백 only → deny')
  assert(r.reason === REASON.INVALID_PEER_AGENT_ID, `A2A4b: reason=invalid-peer-agent-id (got ${r.reason})`)
}

// A2A5. evaluator 누락 → MISSING_EVALUATOR (A2A 는 Cedar 평가 필수 — fail-closed)
{
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'remote/bot', registry,
  })
  assert(r.allow === false, 'A2A5: evaluator 누락 → deny')
  assert(r.reason === REASON.MISSING_EVALUATOR, `A2A5: reason=missing-evaluator (got ${r.reason})`)
}

// A2A5b. registry 누락 → MISSING_REGISTRY (codex round 1 — archived 우회 차단)
{
  const evaluator = createMockEvaluator()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'remote/bot', evaluator,
  })
  assert(r.allow === false, 'A2A5b: registry 누락 → deny')
  assert(r.reason === REASON.MISSING_REGISTRY, `A2A5b: reason=missing-registry (got ${r.reason})`)
}

// A2A5c. registry 등록 부재 (entry 없음) → AGENT_NOT_REGISTERED
{
  const evaluator = createMockEvaluator()
  const registry = createAgentRegistry()  // 빈 registry — 등록 안 함
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A5c: registry entry 부재 → deny')
  assert(r.reason === REASON.AGENT_NOT_REGISTERED, `A2A5c: reason=agent-not-registered (got ${r.reason})`)
}

// A2A6. agentId 형식 오류 (slash 없음) → INVALID_AGENT_ID
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'default', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A6: agentId slash 없음 → deny')
  assert(r.reason === REASON.INVALID_AGENT_ID, `A2A6: reason=invalid-agent-id (got ${r.reason})`)
}

// A2A7. jwtSub 누락 → MISSING_PRINCIPAL
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry()
  const r = canStartA2aSession({
    agentId: 'anthony/default', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A7: jwtSub 누락 → deny')
  assert(r.reason === REASON.MISSING_PRINCIPAL, `A2A7: reason=missing-principal (got ${r.reason})`)
}

// A2A8. admin → admin/manager (reserved owner) → allow
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry({ agentId: 'admin/manager' })
  const r = canStartA2aSession({
    jwtSub: 'admin', agentId: 'admin/manager', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === true, 'A2A8: admin → admin/manager allow')
}

// A2A9. non-admin → admin/manager (reserved owner) → ADMIN_ONLY
{
  const evaluator = createMockEvaluator()
  const registry = buildRegistry({ agentId: 'admin/manager' })
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'admin/manager', peerAgentId: 'remote/bot', evaluator, registry,
  })
  assert(r.allow === false, 'A2A9: non-admin → admin/manager deny')
  assert(r.reason === REASON.ADMIN_ONLY, `A2A9: reason=admin-only (got ${r.reason})`)
}

// A2A10. evaluator context shape 검증 — action=start_a2a_session, context={peerAgentId,archived,isAdmin}
{
  const registry = buildRegistry()
  let captured = null
  const evaluator = (input) => { captured = input; return { decision: 'allow', matchedPolicies: ['00-base'], errors: [] } }
  canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'remote.example/bot', evaluator, registry,
  })
  assert(captured && captured.action === 'start_a2a_session', `A2A10: action=start_a2a_session (got ${captured?.action})`)
  assert(captured.principal.type === 'LocalUser' && captured.principal.id === 'anthony', 'A2A10: principal=LocalUser/anthony')
  assert(captured.resource.type === 'Agent' && captured.resource.id === 'anthony/default', 'A2A10: resource=Agent/anthony/default')
  assert(captured.context.peerAgentId === 'remote.example/bot', `A2A10: context.peerAgentId=remote.example/bot (got ${captured.context.peerAgentId})`)
  assert(captured.context.archived === false, 'A2A10: context.archived=false')
  assert(captured.context.isAdmin === false, 'A2A10: context.isAdmin=false')
}

// A2A11. 운영자 custom Cedar deny (peer-specific 50-*) → A2A_DENIED
{
  const evaluator = () => ({ decision: 'deny', matchedPolicies: ['50-block-peer'], errors: [] })
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: 'banned/peer', evaluator, registry,
  })
  assert(r.allow === false, 'A2A11: peer-specific deny → deny')
  assert(r.reason === REASON.A2A_DENIED, `A2A11: reason=a2a-denied (got ${r.reason})`)
}

// A2A12. peerAgentId 공백 패딩 → Cedar context 에 normalized 값 전달 (codex round 2)
//        ' banned/peer ' 가 'banned/peer' 와 동일한 정책 결정을 받아야 함.
{
  const blockBanned = (input) => {
    const peer = input?.context?.peerAgentId
    if (peer === 'banned/peer') return { decision: 'deny', matchedPolicies: ['50-block-peer'], errors: [] }
    return { decision: 'allow', matchedPolicies: ['00-base'], errors: [] }
  }
  const registry = buildRegistry()
  const r = canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: '  banned/peer  ', evaluator: blockBanned, registry,
  })
  assert(r.allow === false, 'A2A12: 공백 패딩 peer 도 정책 deny 도달')
  assert(r.reason === REASON.A2A_DENIED, `A2A12: reason=a2a-denied (got ${r.reason})`)
}

// A2A12b. peerAgentId 공백 패딩 capture — Cedar context 에 trim 된 값
{
  const registry = buildRegistry()
  let captured = null
  const evaluator = (input) => { captured = input; return { decision: 'allow', matchedPolicies: ['00-base'], errors: [] } }
  canStartA2aSession({
    jwtSub: 'anthony', agentId: 'anthony/default', peerAgentId: '\t remote/bot \n', evaluator, registry,
  })
  assert(captured?.context?.peerAgentId === 'remote/bot',
    `A2A12b: context.peerAgentId trim (got ${JSON.stringify(captured?.context?.peerAgentId)})`)
}

summary()
