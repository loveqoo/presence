import { canAccessAgent, INTENT, REASON, inspectAccessInvocations, resetAccessInvocations } from '@presence/infra/infra/authz/agent-access.js'
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

summary()
