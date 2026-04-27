// Cedar evaluator 단위 테스트 (CE1~CE4) — Y' 인프라 phase
// 실 cedar-wasm 인스턴스 + 인라인 정책/스키마 사용. boot.js 미사용 (commit 2 책임).

import * as cedar from '@cedar-policy/cedar-wasm/nodejs'
import { createEvaluator, createEvaluatorR } from '@presence/infra/infra/authz/cedar/evaluator.js'
import { assert, summary } from '../../../test/lib/assert.js'

const SCHEMA = `entity LocalUser = { id: String, role: String };
entity User = { id: String };
action "create_agent" appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {}
};`

// governance-cedar v2.3 §X — context 확장. CE7~9 가 이 schema 로 quota 정책 동작 검증.
// v2.4 §X — admin 면제 흡수: schema 에 isAdmin/hardLimit 추가 + 두 forbid 정책.
const SCHEMA_WITH_QUOTA = `entity LocalUser = { id: String, role: String };
entity User = { id: String };
action "create_agent" appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: { currentCount: Long, maxAgents: Long, isAdmin: Bool, hardLimit: Long }
};`

const QUOTA_POLICIES =
  'permit (principal is LocalUser, action == Action::"create_agent", resource is User);\n' +
  'forbid (principal is LocalUser, action == Action::"create_agent", resource is User) when { !context.isAdmin && context.currentCount >= context.maxAgents };\n' +
  'forbid (principal is LocalUser, action == Action::"create_agent", resource is User) when { context.isAdmin && context.currentCount >= context.hardLimit };'

// governance-cedar v2.5 §X — access_agent + 20-archived.
const SCHEMA_WITH_ARCHIVED = `entity LocalUser = { id: String, role: String };
entity Agent = { id: String };
action "access_agent" appliesTo {
  principal: [LocalUser],
  resource: [Agent],
  context: { intent: String, archived: Bool }
};`

const ARCHIVED_POLICIES =
  'permit (principal is LocalUser, action == Action::"access_agent", resource is Agent);\n' +
  'forbid (principal is LocalUser, action == Action::"access_agent", resource is Agent) when { context.archived && context.intent != "continue-session" };'

const PERMIT_ALL = 'permit (principal is LocalUser, action == Action::"create_agent", resource is User);'

const PERMIT_PLUS_FORBID_BLOCKED =
  'permit (principal is LocalUser, action == Action::"create_agent", resource is User);\n' +
  'forbid (principal == LocalUser::"blocked", action == Action::"create_agent", resource is User);'

const createCaptureAuditor = () => {
  const entries = []
  return {
    entries,
    append: (entry) => entries.push(entry),
  }
}

const run = () => {
  console.log('Cedar evaluator tests')

  // CE1 — minimal seed + admin → allow + audit 기록
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter })
    const result = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
    })
    assert(result.decision === 'allow', `CE1: admin allow (got ${result.decision})`)
    assert(Array.isArray(result.matchedPolicies) && result.matchedPolicies.length === 1, 'CE1: matchedPolicies 1건')
    assert(result.errors.length === 0, 'CE1: errors 비어있음')
    assert(auditWriter.entries.length === 1, 'CE1: audit 1건 기록')
    const entry = auditWriter.entries[0]
    assert(entry.caller === 'admin' && entry.action === 'create_agent' && entry.resource === 'admin', 'CE1: audit fields 정확')
    assert(entry.decision === 'allow' && Array.isArray(entry.matchedPolicies), 'CE1: audit decision/matchedPolicies')
    assert(typeof entry.ts === 'string' && entry.ts.length > 0, 'CE1: audit ts 존재')
  }

  // CE2 — minimal seed + user → allow (RBAC 게이트만, role 무관) — CI-Y2
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter })
    const result = evaluate({
      principal: { type: 'LocalUser', id: 'alice' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'alice' },
    })
    assert(result.decision === 'allow', 'CE2: 일반 user 도 allow (role 무관)')
    assert(auditWriter.entries.length === 1, 'CE2: audit 1건')
    assert(auditWriter.entries[0].decision === 'allow', 'CE2: audit decision=allow')
  }

  // CE3 — deny 정책 인라인 + 해당 케이스 → deny + matchedPolicies 정확
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA, policiesText: PERMIT_PLUS_FORBID_BLOCKED, auditWriter })

    const blocked = evaluate({
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'blocked' },
    })
    assert(blocked.decision === 'deny', 'CE3: blocked → deny')
    assert(blocked.matchedPolicies.length === 1, `CE3: matchedPolicies 1건 (got ${blocked.matchedPolicies.length})`)

    const allowed = evaluate({
      principal: { type: 'LocalUser', id: 'normal' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'normal' },
    })
    assert(allowed.decision === 'allow', 'CE3: 일반 user → allow (forbid 미적용)')

    assert(auditWriter.entries.length === 2, 'CE3: audit 2건')
    assert(auditWriter.entries[0].decision === 'deny', 'CE3: audit#1 decision=deny')
    assert(auditWriter.entries[1].decision === 'allow', 'CE3: audit#2 decision=allow')
  }

  // CE4 — cedar.isAuthorized mock 이 throw → deny fallback + errors 기록 — CI-Y7
  {
    const auditWriter = createCaptureAuditor()
    const throwingCedar = {
      isAuthorized: () => { throw new Error('boom-runtime') },
    }
    const evaluate = createEvaluator({ cedar: throwingCedar, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter })
    const result = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
    })
    assert(result.decision === 'deny', 'CE4: throw → deny fallback')
    assert(result.matchedPolicies.length === 0, 'CE4: matchedPolicies 비어있음')
    assert(result.errors.length === 1 && result.errors[0].includes('boom-runtime'), 'CE4: errors 에 throw 메시지 캡처')
    assert(auditWriter.entries.length === 1, 'CE4: audit 1건')
    assert(auditWriter.entries[0].decision === 'deny', 'CE4: audit decision=deny')
    assert(auditWriter.entries[0].errors[0].includes('boom-runtime'), 'CE4: audit errors 기록')
  }

  // CE4b — answer.type === 'failure' → deny fallback (parse/eval 호출 자체 실패 시나리오)
  {
    const auditWriter = createCaptureAuditor()
    const failureCedar = {
      isAuthorized: () => ({ type: 'failure', errors: [{ message: 'invalid-call' }], warnings: [] }),
    }
    const evaluate = createEvaluator({ cedar: failureCedar, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter })
    const result = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
    })
    assert(result.decision === 'deny', 'CE4b: answer.type=failure → deny')
    assert(result.errors.length === 1 && result.errors[0] === 'invalid-call', 'CE4b: failure errors 흡수')
    assert(auditWriter.entries[0].decision === 'deny', 'CE4b: audit deny')
  }

  // CE5 — deps 누락 → throw (createEvaluator 자체 검증)
  {
    let threw = false
    try { createEvaluator({ cedar: null, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter: createCaptureAuditor() }) }
    catch (_) { threw = true }
    assert(threw, 'CE5: cedar 부재 시 throw')

    threw = false
    try { createEvaluator({ cedar, schemaText: SCHEMA, policiesText: PERMIT_ALL, auditWriter: null }) }
    catch (_) { threw = true }
    assert(threw, 'CE5: auditWriter 부재 시 throw')
  }

  // ==========================================================================
  // CE7~9 — governance-cedar v2.3 §X (P1 quota 정책 흡수, 실 cedar-wasm)
  // ==========================================================================

  const fullCtx = (override = {}) => ({ currentCount: 0, maxAgents: 5, isAdmin: false, hardLimit: 50, ...override })

  // CE7 — 새 schema (context: currentCount/maxAgents/isAdmin/hardLimit) parse + 기본 호출 정상
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_QUOTA, policiesText: QUOTA_POLICIES, auditWriter })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'alice' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'alice' },
      context:   fullCtx({ currentCount: 0, maxAgents: 5 }),
    })
    assert(r.decision === 'allow', `CE7: 새 schema 부팅 + allow (got ${r.decision})`)
    assert(r.errors.length === 0, 'CE7: errors 비어있음')
  }

  // CE8 — 10-quota forbid 가 !isAdmin && currentCount >= maxAgents 일 때 deny.
  //       matchedPolicies 정확성은 boot.js 가 50-* 를 차단하므로 deny=quota 보장에 의존하지 않음.
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_QUOTA, policiesText: QUOTA_POLICIES, auditWriter })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'bob' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'bob' },
      context:   fullCtx({ currentCount: 5, maxAgents: 5 }),
    })
    assert(r.decision === 'deny', `CE8: non-admin 5/5 → deny (got ${r.decision})`)
    assert(r.errors.length === 0, 'CE8: errors 없음 (정책 매치, evaluator 정상)')
    assert(auditWriter.entries[0].decision === 'deny', 'CE8: audit deny 기록')
  }

  // CE9 — currentCount < maxAgents → forbid 미적용, permit 매치 → allow
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_QUOTA, policiesText: QUOTA_POLICIES, auditWriter })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'carol' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'carol' },
      context:   fullCtx({ currentCount: 4, maxAgents: 5 }),
    })
    assert(r.decision === 'allow', `CE9: 4/5 → allow (got ${r.decision})`)
  }

  // CE10 — admin 은 maxAgents 면제, hardLimit 미만이면 allow
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_QUOTA, policiesText: QUOTA_POLICIES, auditWriter })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   fullCtx({ currentCount: 10, maxAgents: 5, isAdmin: true, hardLimit: 50 }),
    })
    assert(r.decision === 'allow', `CE10: admin over maxAgents under hardLimit → allow (got ${r.decision})`)
  }

  // CE11 — admin 도 hardLimit 초과 시 deny (11-admin-limit.cedar)
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_QUOTA, policiesText: QUOTA_POLICIES, auditWriter })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   fullCtx({ currentCount: 50, maxAgents: 5, isAdmin: true, hardLimit: 50 }),
    })
    assert(r.decision === 'deny', `CE11: admin 50/50 hardLimit → deny (got ${r.decision})`)
    assert(r.errors.length === 0, 'CE11: errors 없음')
  }

  // ==========================================================================
  // CE12 — governance-cedar v2.5 §X (access_agent + 20-archived 정책 동작)
  // ==========================================================================

  // CE12 — archived agent 의 4 intent × allow/deny 정책 매트릭스
  {
    const auditWriter = createCaptureAuditor()
    const evaluate = createEvaluator({ cedar, schemaText: SCHEMA_WITH_ARCHIVED, policiesText: ARCHIVED_POLICIES, auditWriter })
    const principal = { type: 'LocalUser', id: 'alice' }
    const resource = { type: 'Agent', id: 'alice/helper' }

    // archived=true × intent=continue-session → allow
    const r1 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'continue-session' } })
    assert(r1.decision === 'allow', `CE12.1: archived + continue-session → allow (got ${r1.decision})`)

    // archived=true × intent=new-session → deny
    const r2 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'new-session' } })
    assert(r2.decision === 'deny', `CE12.2: archived + new-session → deny (got ${r2.decision})`)

    // archived=true × intent=delegate → deny
    const r3 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'delegate' } })
    assert(r3.decision === 'deny', `CE12.3: archived + delegate → deny (got ${r3.decision})`)

    // archived=true × intent=scheduled-run → deny
    const r4 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'scheduled-run' } })
    assert(r4.decision === 'deny', `CE12.4: archived + scheduled-run → deny (got ${r4.decision})`)

    // archived=false × 任 intent → allow (forbid 미적용)
    const r5 = evaluate({ principal, action: 'access_agent', resource, context: { archived: false, intent: 'new-session' } })
    assert(r5.decision === 'allow', `CE12.5: !archived + new-session → allow (got ${r5.decision})`)
  }

  // CE6 — Reader 브릿지 동치: createEvaluator(deps) === createEvaluatorR.run(deps) 동일 입력 → 동일 결과
  {
    const auditA = createCaptureAuditor()
    const auditB = createCaptureAuditor()
    const evA = createEvaluator({ cedar, schemaText: SCHEMA, policiesText: PERMIT_PLUS_FORBID_BLOCKED, auditWriter: auditA })
    const evB = createEvaluatorR.run({ cedar, schemaText: SCHEMA, policiesText: PERMIT_PLUS_FORBID_BLOCKED, auditWriter: auditB })

    const input = {
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    }
    const ra = evA(input)
    const rb = evB(input)
    assert(ra.decision === rb.decision, `CE6: decision 동치 (${ra.decision} === ${rb.decision})`)
    assert(JSON.stringify(ra.matchedPolicies) === JSON.stringify(rb.matchedPolicies), 'CE6: matchedPolicies 동치')
    assert(JSON.stringify(ra.errors) === JSON.stringify(rb.errors), 'CE6: errors 동치')
    assert(auditA.entries.length === 1 && auditB.entries.length === 1, 'CE6: 양쪽 audit 1건씩')
    // ts 는 호출 시점마다 다름 → 비교 제외
    const stripTs = (e) => { const { ts: _, ...rest } = e; return rest }
    assert(JSON.stringify(stripTs(auditA.entries[0])) === JSON.stringify(stripTs(auditB.entries[0])), 'CE6: audit entry 본문 동치')
  }

  summary()
}

run()
