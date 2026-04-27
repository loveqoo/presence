// Cedar boot 단위 테스트 (CB1~CB6) — Y' 인프라 phase
// fixture 경로 격리: 임시 디렉토리에 *.cedar / *.cedarschema 작성 후 boot.

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { bootCedar, bootCedarR } from '@presence/infra/infra/authz/cedar/boot.js'
import { createEvaluator } from '@presence/infra/infra/authz/cedar/evaluator.js'
import { assert, summary } from '../../../test/lib/assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REAL_CEDAR_ROOT = join(__dirname, '..', 'src', 'infra', 'authz', 'cedar')
const REAL_POLICIES_DIR = join(REAL_CEDAR_ROOT, 'policies')
const REAL_SCHEMA_PATH = join(REAL_CEDAR_ROOT, 'schema.cedarschema')

const SCHEMA_VALID = `entity LocalUser { id: String, role: String };
entity User { id: String };
action create_agent appliesTo {
  principal: [LocalUser],
  resource: [User],
  context: {}
};`

const POLICY_VALID = `permit (
  principal is LocalUser,
  action == Action::"create_agent",
  resource is User
);`

const POLICY_FORBID_BLOCKED = `forbid (
  principal == LocalUser::"blocked",
  action == Action::"create_agent",
  resource is User
);`

const createFixtureDir = (label) => {
  const dir = join(tmpdir(), `cedar-boot-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'policies'), { recursive: true })
  return dir
}

const captureAuditor = () => {
  const entries = []
  return { entries, append: (e) => entries.push(e) }
}

const run = async () => {
  console.log('Cedar boot tests')

  // CB1 — 정상 부팅 → 실 자산 (00-base + 10-quota) 로 evaluator 가용 (CI-Y3)
  // governance-cedar v2.3 §X 부터 schema 가 currentCount/maxAgents 강제 → context 필수.
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    assert(result.cedar && typeof result.cedar.isAuthorized === 'function', 'CB1: cedar 모듈 반환')
    assert(typeof result.schemaText === 'string' && result.schemaText.length > 0, 'CB1: schemaText 비어있지 않음')
    assert(typeof result.policiesText === 'string' && result.policiesText.length > 0, 'CB1: policiesText 비어있지 않음')

    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   { currentCount: 0, maxAgents: 5, isAdmin: true, hardLimit: 50 },
    })
    assert(r.decision === 'allow', `CB1: 실 자산으로 under-quota allow (got ${r.decision})`)
  }

  // CB2 — schema syntax 에러 → boot throw (CI-Y5 boot fail-closed)
  {
    const dir = createFixtureDir('cb2')
    writeFileSync(join(dir, 'schema.cedarschema'), 'entity ZZZ { broken oops')
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/schema parse/.test(e.message), `CB2: error message 에 schema parse 명시 (${e.message})`)
    }
    assert(threw, 'CB2: schema 깨졌을 때 boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB3 — policy syntax 에러 → boot throw (CI-Y5)
  {
    const dir = createFixtureDir('cb3')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), 'permit ( broken')
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/policies parse/.test(e.message), `CB3: error message 에 policies parse 명시 (${e.message})`)
    }
    assert(threw, 'CB3: policy 깨졌을 때 boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB4 — 다중 정책 (`00-base.cedar` permit + `40-test.cedar` forbid) → 사전순 통합 평가, deny 케이스 정확 (CI-Y6).
  // 50-* 는 P1 차단 (CB8/CB9) — 40-* 는 차단 대상이 아니어서 fixture 로 사용.
  {
    const dir = createFixtureDir('cb4')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '40-test.cedar'), POLICY_FORBID_BLOCKED)

    const result = await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    // 사전순으로 합쳐졌는지: 00-base 가 먼저, 40-test 가 뒤에
    const idxBase = result.policiesText.indexOf('permit')
    const idxForbid = result.policiesText.indexOf('forbid')
    assert(idxBase >= 0 && idxForbid > idxBase, 'CB4: 사전순 통합 (permit 먼저, forbid 뒤)')

    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })

    const blocked = evaluate({
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    })
    assert(blocked.decision === 'deny', 'CB4: blocked → deny (forbid hit)')
    assert(blocked.matchedPolicies.length === 1, `CB4: matchedPolicies 1건 (got ${blocked.matchedPolicies.length})`)

    const ok = evaluate({
      principal: { type: 'LocalUser', id: 'normal' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    })
    assert(ok.decision === 'allow', 'CB4: 일반 user → allow')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB5 — 빈 정책 디렉토리 → boot throw (default deny 보다 강한 보호: 정책 부재는 운영 실수 가능성 높음)
  {
    const dir = createFixtureDir('cb5')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    // policies 디렉토리는 만들었지만 비어있음
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/비어있음|empty/i.test(e.message), `CB5: empty 메시지 (${e.message})`)
    }
    assert(threw, 'CB5: 빈 policies 디렉토리 → boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB5b — 정책 디렉토리 자체 부재 → boot throw
  {
    const dir = createFixtureDir('cb5b')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    rmSync(join(dir, 'policies'), { recursive: true, force: true })
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/부재/.test(e.message), `CB5b: 부재 메시지 (${e.message})`)
    }
    assert(threw, 'CB5b: 디렉토리 자체 부재 → throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB5c — schema 파일 부재 → boot throw
  {
    const dir = createFixtureDir('cb5c')
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/schema/i.test(e.message), `CB5c: schema 부재 메시지 (${e.message})`)
    }
    assert(threw, 'CB5c: schema 파일 부재 → throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB6 — Reader 브릿지 동치
  {
    const a = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const b = await bootCedarR.run({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })()
    assert(a.schemaText === b.schemaText, 'CB6: schemaText 동치')
    assert(a.policiesText === b.policiesText, 'CB6: policiesText 동치')
    assert(a.cedar === b.cedar, 'CB6: cedar 모듈 동일 인스턴스 (dynamic import 캐시)')
  }

  // ==========================================================================
  // CB7~9 — governance-cedar v2.3 §X (P1 50-* 차단 + 10-quota 통합)
  // ==========================================================================

  // CB7 — schema + 00-base + 10-quota + 11-admin-limit 부팅 정상 (실 자산 통합)
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    assert(/currentCount/.test(result.policiesText), 'CB7: 10-quota 정책이 통합 텍스트에 포함')
    assert(/hardLimit/.test(result.policiesText), 'CB7: 11-admin-limit 정책이 통합 텍스트에 포함')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    // non-admin over quota → deny
    const denied = evaluate({
      principal: { type: 'LocalUser', id: 'over' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'over' },
      context:   { currentCount: 5, maxAgents: 5, isAdmin: false, hardLimit: 50 },
    })
    assert(denied.decision === 'deny', `CB7: non-admin 5/5 → deny (got ${denied.decision})`)
    // admin under hardLimit → allow (quota 면제)
    const adminUnder = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   { currentCount: 10, maxAgents: 5, isAdmin: true, hardLimit: 50 },
    })
    assert(adminUnder.decision === 'allow', `CB7: admin over maxAgents under hardLimit → allow (got ${adminUnder.decision})`)
    // admin over hardLimit → deny
    const adminOver = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   { currentCount: 50, maxAgents: 5, isAdmin: true, hardLimit: 50 },
    })
    assert(adminOver.decision === 'deny', `CB7: admin 50/50 hardLimit → deny (got ${adminOver.decision})`)
  }

  // CB8 — 50-test.cedar 추가 시 boot throw — P1 차단 메시지 검증
  {
    const dir = createFixtureDir('cb8')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '50-test.cedar'), POLICY_FORBID_BLOCKED)
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/50-test\.cedar/.test(e.message), `CB8: 차단된 파일명 노출 (${e.message})`)
      assert(/P4/.test(e.message), `CB8: P4 ETA 명시 (${e.message})`)
    }
    assert(threw, 'CB8: 50-test.cedar → boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB10 — 실 자산 부팅 후 20-archived 정책 동작 (governance-cedar v2.5 §X)
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    assert(/access_agent/.test(result.policiesText), 'CB10: 00-base 가 access_agent permit 포함')
    assert(/20-archived|context\.archived/.test(result.policiesText), 'CB10: 20-archived 정책 통합')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const principal = { type: 'LocalUser', id: 'alice' }
    const resource = { type: 'Agent', id: 'alice/helper' }
    // archived + new-session → deny
    const r1 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'new-session' } })
    assert(r1.decision === 'deny', `CB10: archived + new-session → deny (got ${r1.decision})`)
    // archived + continue-session → allow
    const r2 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'continue-session' } })
    assert(r2.decision === 'allow', `CB10: archived + continue-session → allow (got ${r2.decision})`)
  }

  // CB9 — 51-* 같은 5[0-9]- 패턴 모두 차단
  {
    const dir = createFixtureDir('cb9')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '51-test.cedar'), POLICY_FORBID_BLOCKED)
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/51-test\.cedar/.test(e.message), `CB9: 51-* 도 차단 (${e.message})`)
    }
    assert(threw, 'CB9: 51-test.cedar → boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(e => { console.error(e); process.exit(1) })
