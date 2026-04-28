// Cedar boot 단위 테스트 — Y' 인프라 phase + KG-27 P4 unblock.
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

  // CB1 — 정상 부팅 → 실 자산 (00-base + 10-quota + ...) 으로 evaluator 가용 (CI-Y3)
  // KG-27 P4 — policiesText (string) → policiesMap (object) 으로 변경.
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    assert(result.cedar && typeof result.cedar.isAuthorized === 'function', 'CB1: cedar 모듈 반환')
    assert(typeof result.schemaText === 'string' && result.schemaText.length > 0, 'CB1: schemaText 비어있지 않음')
    assert(result.policiesMap && typeof result.policiesMap === 'object', 'CB1: policiesMap 객체 반환')
    const keys = Object.keys(result.policiesMap)
    assert(keys.length > 0, 'CB1: policiesMap 비어있지 않음')
    assert(keys.some(k => k.startsWith('00-')), 'CB1: 00-* 정책 포함')
    assert(keys.some(k => k.startsWith('10-')), 'CB1: 10-quota 포함')

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

  // CB3 — policy syntax 에러 → boot throw (CI-Y5).
  // KG-27 P4 — split 단계가 먼저 트리거됨 (per-file `policySetTextToParts`).
  {
    const dir = createFixtureDir('cb3')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), 'permit ( broken')
    let threw = false
    try {
      await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    } catch (e) {
      threw = true
      assert(/policy (split|parse)/.test(e.message), `CB3: split 또는 parse 단계 에러 (${e.message})`)
    }
    assert(threw, 'CB3: policy 깨졌을 때 boot throw')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB4 — 다중 정책 (`00-base.cedar` permit + `40-test.cedar` forbid) 통합 평가 (CI-Y6).
  // KG-27 P4 — policiesMap 키가 basename 그대로 (단일 statement) 반영.
  {
    const dir = createFixtureDir('cb4')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '40-test.cedar'), POLICY_FORBID_BLOCKED)

    const result = await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('00-base'), 'CB4: 00-base key 존재')
    assert(keys.includes('40-test'), 'CB4: 40-test key 존재')

    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })

    const blocked = evaluate({
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    })
    assert(blocked.decision === 'deny', 'CB4: blocked → deny (forbid hit)')
    assert(blocked.matchedPolicies.length === 1, `CB4: matchedPolicies 1건 (got ${blocked.matchedPolicies.length})`)
    assert(blocked.matchedPolicies[0] === '40-test', `CB4: matchedPolicies = '40-test' (got ${blocked.matchedPolicies[0]})`)

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

  // CB6 — Reader 브릿지 동치 (KG-27 — policiesMap 비교)
  {
    const a = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const b = await bootCedarR.run({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })()
    assert(a.schemaText === b.schemaText, 'CB6: schemaText 동치')
    assert(JSON.stringify(a.policiesMap) === JSON.stringify(b.policiesMap), 'CB6: policiesMap 동치')
    assert(a.cedar === b.cedar, 'CB6: cedar 모듈 동일 인스턴스 (dynamic import 캐시)')
  }

  // ==========================================================================
  // CB7~12 — 실 자산 통합 (governance-cedar v2.3~v2.9)
  // ==========================================================================

  // CB7 — schema + 00-base + 10-quota + 11-admin-limit 부팅 정상 (실 자산 통합)
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('10-quota'), 'CB7: 10-quota 키 포함')
    assert(keys.includes('11-admin-limit'), 'CB7: 11-admin-limit 키 포함')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    // non-admin over quota → deny (matchedPolicies = ['10-quota'])
    const denied = evaluate({
      principal: { type: 'LocalUser', id: 'over' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'over' },
      context:   { currentCount: 5, maxAgents: 5, isAdmin: false, hardLimit: 50 },
    })
    assert(denied.decision === 'deny', `CB7: non-admin 5/5 → deny (got ${denied.decision})`)
    assert(denied.matchedPolicies.includes('10-quota'),
      `CB7: matchedPolicies 에 '10-quota' 포함 (got ${JSON.stringify(denied.matchedPolicies)})`)
    // admin under hardLimit → allow (quota 면제)
    const adminUnder = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   { currentCount: 10, maxAgents: 5, isAdmin: true, hardLimit: 50 },
    })
    assert(adminUnder.decision === 'allow', `CB7: admin over maxAgents under hardLimit → allow (got ${adminUnder.decision})`)
    // admin over hardLimit → deny (matchedPolicies = ['11-admin-limit'])
    const adminOver = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'admin' },
      context:   { currentCount: 50, maxAgents: 5, isAdmin: true, hardLimit: 50 },
    })
    assert(adminOver.decision === 'deny', `CB7: admin 50/50 hardLimit → deny (got ${adminOver.decision})`)
    assert(adminOver.matchedPolicies.includes('11-admin-limit'),
      `CB7: matchedPolicies 에 '11-admin-limit' 포함 (got ${JSON.stringify(adminOver.matchedPolicies)})`)
  }

  // CB10 — 실 자산 부팅 후 20-archived 정책 동작
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('20-archived'), 'CB10: 20-archived 키 포함')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const principal = { type: 'LocalUser', id: 'alice' }
    const resource = { type: 'Agent', id: 'alice/helper' }
    // archived + new-session → deny
    const r1 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'new-session' } })
    assert(r1.decision === 'deny', `CB10: archived + new-session → deny (got ${r1.decision})`)
    assert(r1.matchedPolicies.includes('20-archived'),
      `CB10: matchedPolicies 에 '20-archived' 포함 (got ${JSON.stringify(r1.matchedPolicies)})`)
    // archived + continue-session → allow
    const r2 = evaluate({ principal, action: 'access_agent', resource, context: { archived: true, intent: 'continue-session' } })
    assert(r2.decision === 'allow', `CB10: archived + continue-session → allow (got ${r2.decision})`)
  }

  // CB11 — 실 자산 부팅 후 archive_agent + 30-protect-admin 정책 동작
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('30-protect-admin'), 'CB11: 30-protect-admin 키 포함')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const principal = { type: 'LocalUser', id: 'admin' }
    const reservedRes = { type: 'Agent', id: 'admin/manager' }
    const userRes = { type: 'Agent', id: 'alice/old' }
    const r1 = evaluate({ principal, action: 'archive_agent', resource: reservedRes, context: { isAdmin: true, reservedOwner: true } })
    assert(r1.decision === 'deny', `CB11: reservedOwner=true → deny (got ${r1.decision})`)
    assert(r1.matchedPolicies.includes('30-protect-admin'),
      `CB11: matchedPolicies 에 '30-protect-admin' 포함 (got ${JSON.stringify(r1.matchedPolicies)})`)
    const r2 = evaluate({ principal, action: 'archive_agent', resource: userRes, context: { isAdmin: false, reservedOwner: false } })
    assert(r2.decision === 'allow', `CB11: reservedOwner=false → allow (got ${r2.decision})`)
  }

  // CB12 — 실 자산 부팅 후 set_persona + 31-protect-persona 동작
  {
    const result = await bootCedar({ policiesDir: REAL_POLICIES_DIR, schemaPath: REAL_SCHEMA_PATH })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('31-protect-persona'), 'CB12: 31-protect-persona 키 포함')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const r1 = evaluate({
      principal: { type: 'LocalUser', id: 'alice' },
      action:    'set_persona',
      resource:  { type: 'Agent', id: 'alice/default' },
      context:   { isAdmin: false, reservedOwner: false },
    })
    assert(r1.decision === 'allow', `CB12: !reservedOwner → allow (got ${r1.decision})`)
    const r2 = evaluate({
      principal: { type: 'LocalUser', id: 'alice' },
      action:    'set_persona',
      resource:  { type: 'Agent', id: 'admin/manager' },
      context:   { isAdmin: false, reservedOwner: true },
    })
    assert(r2.decision === 'deny', `CB12: reservedOwner+!isAdmin → deny (got ${r2.decision})`)
    assert(r2.matchedPolicies.includes('31-protect-persona'),
      `CB12: matchedPolicies 에 '31-protect-persona' 포함 (got ${JSON.stringify(r2.matchedPolicies)})`)
    const r3 = evaluate({
      principal: { type: 'LocalUser', id: 'admin' },
      action:    'set_persona',
      resource:  { type: 'Agent', id: 'admin/manager' },
      context:   { isAdmin: true, reservedOwner: true },
    })
    assert(r3.decision === 'allow', `CB12: reservedOwner+isAdmin → allow (got ${r3.decision})`)
  }

  // ==========================================================================
  // CB-X1~X3 — KG-27 P4 unblock (50-* 슬롯 + forbid-overrides-permit)
  // ==========================================================================

  // CB-X1 — 50-foo.cedar (forbid) 추가 시 정상 부팅 + matchedPolicies = ['50-foo'] (이전 throw)
  {
    const dir = createFixtureDir('cbX1')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '50-foo.cedar'), POLICY_FORBID_BLOCKED)
    const result = await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('50-foo'), 'CB-X1: 50-foo 키 포함 (이전 throw)')
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    })
    assert(r.decision === 'deny', `CB-X1: blocked → deny (got ${r.decision})`)
    assert(r.matchedPolicies.includes('50-foo'),
      `CB-X1: matchedPolicies 에 '50-foo' (got ${JSON.stringify(r.matchedPolicies)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  // CB-X2 — 51-* 도 정상 부팅 (이전 throw)
  {
    const dir = createFixtureDir('cbX2')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '51-bar.cedar'), POLICY_FORBID_BLOCKED)
    const result = await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    const keys = Object.keys(result.policiesMap)
    assert(keys.includes('51-bar'), 'CB-X2: 51-bar 정상 부팅 (5[0-9]-* throw 가드 제거 확인)')
    rmSync(dir, { recursive: true, force: true })
  }

  // CB-X3 — operator permit (50-foo) vs system forbid (40-system) — Cedar 의 forbid-overrides-permit 의미론.
  // 50-foo 가 광범위 permit 이어도 40-system 의 forbid 가 우선 적용됨 검증.
  {
    const dir = createFixtureDir('cbX3')
    writeFileSync(join(dir, 'schema.cedarschema'), SCHEMA_VALID)
    writeFileSync(join(dir, 'policies', '00-base.cedar'), POLICY_VALID)
    writeFileSync(join(dir, 'policies', '40-system.cedar'), POLICY_FORBID_BLOCKED)
    writeFileSync(join(dir, 'policies', '50-foo.cedar'), POLICY_VALID)   // 50-foo permit (넓은 허용)
    const result = await bootCedar({ policiesDir: join(dir, 'policies'), schemaPath: join(dir, 'schema.cedarschema') })
    const auditor = captureAuditor()
    const evaluate = createEvaluator({ ...result, auditWriter: auditor })
    const r = evaluate({
      principal: { type: 'LocalUser', id: 'blocked' },
      action:    'create_agent',
      resource:  { type: 'User', id: 'x' },
    })
    assert(r.decision === 'deny',
      `CB-X3: 50-foo permit 이어도 40-system forbid 가 우선 → deny (got ${r.decision})`)
    assert(r.matchedPolicies.includes('40-system'),
      `CB-X3: matchedPolicies 에 '40-system' (forbid 가 매치) (got ${JSON.stringify(r.matchedPolicies)})`)
    rmSync(dir, { recursive: true, force: true })
  }

  summary()
}

run().catch(e => { console.error(e); process.exit(1) })
