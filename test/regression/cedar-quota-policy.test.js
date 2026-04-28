/**
 * INV-CEDAR-QUOTA-POLICY + 관련 회귀 (governance-cedar v2.3~v2.11 §X / §X1~§X5).
 *
 * 정적 grep 으로 P1 ~ P4 의 핵심 invariant 가 침식되지 않았는지 검증한다.
 * 의미론 회귀는 packages/infra/test/agent-governance.test.js (GV-X1~X19) +
 * packages/infra/test/agent-access.test.js (AA-X1~X6) 가 행동 검증 — 이 파일은
 * "코드/정책 파일에 약속된 형태가 그대로 있는가" 의 정적 방어.
 *
 *  1) INV-CEDAR-QUOTA-POLICY: 10-quota.cedar 의 forbid 패턴
 *  2) INV-CEDAR-ADMIN-EXEMPT: 11-admin-limit.cedar 의 hardLimit forbid
 *  3) INV-CEDAR-ARCHIVED-POLICY: 20-archived.cedar 의 archived forbid
 *  4) INV-SUBMIT-USER-AGENT-CONTEXT / INV-CREATE-AGENT-CALLERS / INV-ACCESS-AGENT-CALLERS
 *  5) INV-EVALUATOR-INVARIANT: agent-access.js MISSING_EVALUATOR fail-closed
 *  6) INV-CEDAR-ARCHIVE-PROTECT / INV-SET-PERSONA-CALLERS / INV-CEDAR-PERSONA-PROTECT
 *  7) KG-27 P4 신규 invariant:
 *     - INV-CEDAR-POLICY-MAP: boot.js 가 { basename: rawText } 맵 반환 + evaluator 가 staticPolicies 에 맵 그대로
 *     - INV-INTERPRET-MATCHED-POLICIES: agent-governance.js classifyDeny + matchedPolicies 참조
 *     - INV-DENIED-VS-PENDING: classifyDeny 가 50-/30-/31-/11- 를 STATUS.DENIED, 10- 만 STATUS.PENDING 매핑
 *     - INV-CEDAR-CUSTOM-BLOCK 은 KG-27 에서 제거 (boot 가 50-* 차단하지 않음)
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

console.log('INV-CEDAR-QUOTA-POLICY static checks')

// 1. INV-CEDAR-QUOTA-POLICY — 10-quota.cedar 의 forbid 정책 존재 + admin 면제 조건
{
  const policyPath = 'packages/infra/src/infra/authz/cedar/policies/10-quota.cedar'
  assert(existsSync(join(REPO_ROOT, policyPath)), `INV-CEDAR-QUOTA-POLICY: ${policyPath} 존재`)
  const text = read(policyPath)
  assert(/forbid\s*\(/.test(text), 'INV-CEDAR-QUOTA-POLICY: forbid 정책 선언')
  assert(/principal is LocalUser/.test(text), 'INV-CEDAR-QUOTA-POLICY: principal is LocalUser')
  assert(/action == Action::"create_agent"/.test(text), 'INV-CEDAR-QUOTA-POLICY: action == create_agent')
  assert(/resource is User/.test(text), 'INV-CEDAR-QUOTA-POLICY: resource is User')
  assert(
    /!\s*context\.isAdmin\s*&&\s*context\.currentCount\s*>=\s*context\.maxAgents/.test(text),
    'INV-CEDAR-QUOTA-POLICY: when !context.isAdmin && context.currentCount >= context.maxAgents',
  )
}

// 2. INV-CEDAR-ADMIN-EXEMPT — 11-admin-limit.cedar 의 hardLimit forbid
{
  const policyPath = 'packages/infra/src/infra/authz/cedar/policies/11-admin-limit.cedar'
  assert(existsSync(join(REPO_ROOT, policyPath)), `INV-CEDAR-ADMIN-EXEMPT: ${policyPath} 존재`)
  const text = read(policyPath)
  assert(/forbid\s*\(/.test(text), 'INV-CEDAR-ADMIN-EXEMPT: forbid 정책 선언')
  assert(
    /context\.isAdmin\s*&&\s*context\.currentCount\s*>=\s*context\.hardLimit/.test(text),
    'INV-CEDAR-ADMIN-EXEMPT: when context.isAdmin && context.currentCount >= context.hardLimit',
  )
}

// 2b. INV-CEDAR-ARCHIVED-POLICY — 20-archived.cedar 의 archived forbid (P2)
{
  const policyPath = 'packages/infra/src/infra/authz/cedar/policies/20-archived.cedar'
  assert(existsSync(join(REPO_ROOT, policyPath)), `INV-CEDAR-ARCHIVED-POLICY: ${policyPath} 존재`)
  const text = read(policyPath)
  assert(/forbid\s*\(/.test(text), 'INV-CEDAR-ARCHIVED-POLICY: forbid 정책 선언')
  assert(/action == Action::"access_agent"/.test(text), 'INV-CEDAR-ARCHIVED-POLICY: action == access_agent')
  assert(/resource is Agent/.test(text), 'INV-CEDAR-ARCHIVED-POLICY: resource is Agent')
  assert(
    /context\.archived\s*&&\s*context\.intent\s*!=\s*"continue-session"/.test(text),
    'INV-CEDAR-ARCHIVED-POLICY: when context.archived && context.intent != "continue-session"',
  )
}

// 3. INV-SUBMIT-USER-AGENT-CONTEXT — submitUserAgent 의 CheckAccess 호출이 4 context 필드 첨부
{
  const text = read('packages/infra/src/infra/authz/agent-governance.js')
  const checkAccessBlock = text.match(/CheckAccess\(\{[\s\S]*?\}\)/)
  assert(checkAccessBlock, 'INV-SUBMIT-USER-AGENT-CONTEXT: CheckAccess 호출 존재')
  const block = checkAccessBlock[0]
  assert(/action:\s*'create_agent'/.test(block), 'INV-SUBMIT-USER-AGENT-CONTEXT: action: create_agent')
  for (const field of ['currentCount', 'maxAgents', 'isAdmin', 'hardLimit']) {
    assert(
      new RegExp(`context:\\s*\\{[\\s\\S]*?${field}[\\s\\S]*?\\}`).test(block),
      `INV-SUBMIT-USER-AGENT-CONTEXT: context 에 ${field}`,
    )
  }
}

// 4. INV-CREATE-AGENT-CALLERS — CheckAccess({...action:'create_agent'...}) 호출 모두
//    4 context 필드 첨부. 현재 1 곳 (submitUserAgent). 추후 호출자가 늘어나도 누락을 차단.
{
  const text = read('packages/infra/src/infra/authz/agent-governance.js')
  const callerRe = /CheckAccess\(\{[\s\S]*?\}\)/g
  const fields = ['currentCount', 'maxAgents', 'isAdmin', 'hardLimit']
  let count = 0
  let m
  while ((m = callerRe.exec(text)) !== null) {
    const block = m[0]
    if (!/action:\s*['"]create_agent['"]/.test(block)) continue
    count += 1
    for (const field of fields) {
      assert(
        new RegExp(`context:\\s*\\{[\\s\\S]*?${field}[\\s\\S]*?\\}`).test(block),
        `INV-CREATE-AGENT-CALLERS: 호출 #${count} 가 context.${field} 첨부`,
      )
    }
  }
  assert(count >= 1, `INV-CREATE-AGENT-CALLERS: 최소 1 개 create_agent 호출 발견 (got ${count})`)
}

// 4b. INV-ACCESS-AGENT-CALLERS — agent-access.js 의 CheckAccess 가 access_agent + context 첨부
{
  const text = read('packages/infra/src/infra/authz/agent-access.js')
  const callerRe = /CheckAccess\(\{[\s\S]*?\}\)/g
  const fields = ['intent', 'archived']
  let count = 0
  let m
  while ((m = callerRe.exec(text)) !== null) {
    const block = m[0]
    if (!/action:\s*['"]access_agent['"]/.test(block)) continue
    count += 1
    for (const field of fields) {
      assert(
        new RegExp(`context:\\s*\\{[\\s\\S]*?${field}[\\s\\S]*?\\}`).test(block),
        `INV-ACCESS-AGENT-CALLERS: 호출 #${count} 가 context.${field} 첨부`,
      )
    }
  }
  assert(count >= 1, `INV-ACCESS-AGENT-CALLERS: 최소 1 개 access_agent 호출 발견 (got ${count})`)
}

// 5. INV-CEDAR-POLICY-MAP — KG-27 P4. boot.js 가 { basename: text } 맵 반환 + evaluator 가 맵 사용.
{
  const bootText = read('packages/infra/src/infra/authz/cedar/boot.js')
  // readPoliciesDir 가 객체 (map) 반환 패턴 — `map[id]` 또는 `return map`
  assert(
    /map\[id\]\s*=\s*readFileSync/.test(bootText),
    'INV-CEDAR-POLICY-MAP: readPoliciesDir 가 map[id] 로 객체 반환',
  )
  // 50-* throw 가드 부재 (KG-27 unblock)
  assert(
    !/\/\^5\[0-9\]-\//.test(bootText),
    'INV-CEDAR-POLICY-MAP: 50-* throw 가드 제거됨 (KG-27 unblock)',
  )
  // bootCedarR 의 splitPoliciesByStatement 가 cedar.policySetTextToParts 호출
  assert(
    /policySetTextToParts/.test(bootText),
    'INV-CEDAR-POLICY-MAP: cedar.policySetTextToParts 로 다중 statement 분리',
  )

  const evalText = read('packages/infra/src/infra/authz/cedar/evaluator.js')
  // policiesMap 변수명 + staticPolicies 에 그대로 전달
  assert(
    /staticPolicies:\s*policiesMap/.test(evalText),
    'INV-CEDAR-POLICY-MAP: evaluator 가 staticPolicies 에 policiesMap 객체 전달',
  )
}

// 6. INV-EVALUATOR-INVARIANT — agent-access.js 가 registry+entry 있을 때 evaluator 필수.
//    legacy fallback (else if archived ...) 제거 + REASON.MISSING_EVALUATOR 추가 (governance-cedar v2.6 §X1).
{
  const text = read('packages/infra/src/infra/authz/agent-access.js')
  assert(
    /MISSING_EVALUATOR:\s*['"]missing-evaluator['"]/.test(text),
    'INV-EVALUATOR-INVARIANT: REASON.MISSING_EVALUATOR enum 정의',
  )
  assert(
    /typeof evaluator !==\s*['"]function['"]\s*\)\s*return deny\(REASON\.MISSING_EVALUATOR\)/.test(text),
    'INV-EVALUATOR-INVARIANT: registry+entry 있을 때 evaluator 미전달 → fail-closed',
  )
  // legacy fallback 패턴 (`else if (archived && intent !==`) 부재
  assert(
    !/else if \(archived &&/.test(text),
    'INV-EVALUATOR-INVARIANT: legacy fallback (else if archived) 제거됨',
  )
}

// 7. INV-CEDAR-ARCHIVE-PROTECT — 30-protect-admin.cedar 정책 + schema archive_agent action
//    (governance-cedar v2.7 §X2)
{
  const policyPath = 'packages/infra/src/infra/authz/cedar/policies/30-protect-admin.cedar'
  assert(existsSync(join(REPO_ROOT, policyPath)), `INV-CEDAR-ARCHIVE-PROTECT: ${policyPath} 존재`)
  const text = read(policyPath)
  assert(/forbid\s*\(/.test(text), 'INV-CEDAR-ARCHIVE-PROTECT: forbid 정책')
  assert(/action == Action::"archive_agent"/.test(text), 'INV-CEDAR-ARCHIVE-PROTECT: action == archive_agent')
  assert(/resource is Agent/.test(text), 'INV-CEDAR-ARCHIVE-PROTECT: resource is Agent')
  assert(/context\.reservedOwner/.test(text), 'INV-CEDAR-ARCHIVE-PROTECT: when context.reservedOwner')

  const schema = read('packages/infra/src/infra/authz/cedar/schema.cedarschema')
  assert(/action archive_agent/.test(schema), 'INV-CEDAR-ARCHIVE-PROTECT: schema 에 archive_agent action')
  assert(/reservedOwner:\s*Bool/.test(schema), 'INV-CEDAR-ARCHIVE-PROTECT: schema context.reservedOwner: Bool')

  const base = read('packages/infra/src/infra/authz/cedar/policies/00-base.cedar')
  assert(/Action::"archive_agent"/.test(base), 'INV-CEDAR-ARCHIVE-PROTECT: 00-base 가 archive_agent permit')
}

// 8. INV-SET-PERSONA-CALLERS — slash-commands.js 의 persona handler 가 set/reset 시
//    Op.CheckAccess(action='set_persona') 호출 (governance-cedar v2.8 §X3)
{
  const text = read('packages/server/src/server/slash-commands.js')
  // CheckAccess({...action:'set_persona'...}) 호출 존재
  const callerRe = /CheckAccess\(\{[\s\S]*?\}\)/g
  let count = 0
  let m
  while ((m = callerRe.exec(text)) !== null) {
    const block = m[0]
    if (!/action:\s*['"]set_persona['"]/.test(block)) continue
    count += 1
    for (const field of ['isAdmin', 'reservedOwner']) {
      assert(
        new RegExp(`context:\\s*\\{[\\s\\S]*?${field}[\\s\\S]*?\\}`).test(block),
        `INV-SET-PERSONA-CALLERS: 호출 #${count} 가 context.${field} 첨부`,
      )
    }
  }
  assert(count >= 1, `INV-SET-PERSONA-CALLERS: 최소 1 개 set_persona 호출 발견 (got ${count})`)

  const schema = read('packages/infra/src/infra/authz/cedar/schema.cedarschema')
  assert(/action set_persona/.test(schema), 'INV-SET-PERSONA-CALLERS: schema 에 set_persona action')

  const base = read('packages/infra/src/infra/authz/cedar/policies/00-base.cedar')
  assert(/Action::"set_persona"/.test(base), 'INV-SET-PERSONA-CALLERS: 00-base 가 set_persona permit')
}

// 9. INV-CEDAR-PERSONA-PROTECT — 31-protect-persona.cedar 정책 + slash-commands fail-closed
//    (governance-cedar v2.9 §X4)
{
  const policyPath = 'packages/infra/src/infra/authz/cedar/policies/31-protect-persona.cedar'
  assert(existsSync(join(REPO_ROOT, policyPath)), `INV-CEDAR-PERSONA-PROTECT: ${policyPath} 존재`)
  const text = read(policyPath)
  assert(/forbid\s*\(/.test(text), 'INV-CEDAR-PERSONA-PROTECT: forbid 정책')
  assert(/action == Action::"set_persona"/.test(text), 'INV-CEDAR-PERSONA-PROTECT: action == set_persona')
  assert(
    /context\.reservedOwner\s*&&\s*!\s*context\.isAdmin/.test(text),
    'INV-CEDAR-PERSONA-PROTECT: when context.reservedOwner && !context.isAdmin',
  )

  // slash-commands.js — evaluator/jwtSub/agentId 누락 시 deny (fail-closed)
  const slash = read('packages/server/src/server/slash-commands.js')
  assert(
    /typeof evaluator !==\s*['"]function['"]\s*\|\|\s*!jwtSub\s*\|\|\s*!agentId/.test(slash),
    'INV-CEDAR-PERSONA-PROTECT: slash-commands fail-closed 패턴 (evaluator/jwtSub/agentId 누락 시 deny)',
  )
}

// 10. INV-INTERPRET-MATCHED-POLICIES — agent-governance.js 의 interpretCedarDecision 이
//     matchedPolicies 를 참조 + classifyDeny 함수 존재 (KG-27 P4)
{
  const text = read('packages/infra/src/infra/authz/agent-governance.js')
  assert(
    /classifyDeny\s*=\s*\(matchedPolicies\)/.test(text),
    'INV-INTERPRET-MATCHED-POLICIES: classifyDeny(matchedPolicies) 함수 정의',
  )
  assert(
    /matchedPolicies\s*=\s*\[\]/.test(text),
    'INV-INTERPRET-MATCHED-POLICIES: interpretCedarDecision destructure 에 matchedPolicies = [] default',
  )
  assert(
    /classifyDeny\(matchedPolicies\)/.test(text),
    'INV-INTERPRET-MATCHED-POLICIES: interpretCedarDecision 이 classifyDeny 호출',
  )
}

// 11. INV-DENIED-VS-PENDING — classifyDeny 가 50-/30-/31-/11- 를 STATUS.DENIED 로,
//     10- 만 STATUS.PENDING 으로 분류 (KG-27 P4 codex H3)
{
  const text = read('packages/infra/src/infra/authz/agent-governance.js')
  // 50- → DENIED_OPERATOR
  assert(
    /has\(['"]50-['"]\)\s*\)\s*return\s*\{\s*status:\s*STATUS\.DENIED,\s*reason:\s*REASON\.DENIED_OPERATOR/.test(text),
    'INV-DENIED-VS-PENDING: 50- → STATUS.DENIED + DENIED_OPERATOR',
  )
  // 30-/31- → DENIED_PROTECT
  assert(
    /has\(['"]30-['"]\)\s*\|\|\s*has\(['"]31-['"]\)\s*\)\s*return\s*\{\s*status:\s*STATUS\.DENIED,\s*reason:\s*REASON\.DENIED_PROTECT/.test(text),
    'INV-DENIED-VS-PENDING: 30-/31- → STATUS.DENIED + DENIED_PROTECT',
  )
  // 11- → DENIED_ADMIN_LIMIT
  assert(
    /has\(['"]11-['"]\)\s*\)\s*return\s*\{\s*status:\s*STATUS\.DENIED,\s*reason:\s*REASON\.DENIED_ADMIN_LIMIT/.test(text),
    'INV-DENIED-VS-PENDING: 11- → STATUS.DENIED + DENIED_ADMIN_LIMIT',
  )
  // 10- → PENDING_QUOTA (admin queue 진입 가능 사유 유일)
  assert(
    /has\(['"]10-['"]\)\s*\)\s*return\s*\{\s*status:\s*STATUS\.PENDING,\s*reason:\s*REASON\.PENDING_QUOTA/.test(text),
    'INV-DENIED-VS-PENDING: 10- → STATUS.PENDING + PENDING_QUOTA (유일한 PENDING)',
  )
  // 매치 없음 fallback → DENIED(unspecified) fail-closed
  assert(
    /return\s*\{\s*status:\s*STATUS\.DENIED,\s*reason:\s*REASON\.DENIED_UNSPECIFIED/.test(text),
    'INV-DENIED-VS-PENDING: 매치 없음 → DENIED(unspecified) fail-closed',
  )
}

// KG-28 P5 — INV-CEDAR-RELOAD-WRAPPER: createEvaluatorRef wrapper export + replace/snapshot 메서드.
{
  const text = read('packages/infra/src/infra/authz/cedar/evaluator-ref.js')
  assert(
    /export\s*\{\s*createEvaluatorRef/.test(text),
    'INV-CEDAR-RELOAD-WRAPPER: createEvaluatorRef export',
  )
  assert(
    /evaluator\.replace\s*=/.test(text),
    'INV-CEDAR-RELOAD-WRAPPER: evaluator.replace 메서드 정의',
  )
  assert(
    /evaluator\.snapshot\s*=/.test(text),
    'INV-CEDAR-RELOAD-WRAPPER: evaluator.snapshot 메서드 정의',
  )
}

// KG-28 P5 — INV-CEDAR-RELOAD-FAIL-SAFE: rebootCedarSubsystem 가 throw 위임.
//   #doReload 가 wrapper.replace 를 boot 결과 throw 후 호출 안 함 (await 가 catch 없이 진행).
{
  const cedarIndex = read('packages/infra/src/infra/authz/cedar/index.js')
  assert(
    /export\s*\{[\s\S]*rebootCedarSubsystem/.test(cedarIndex),
    'INV-CEDAR-RELOAD-FAIL-SAFE: rebootCedarSubsystem export',
  )
  // try/catch 가 rebootCedarSubsystem 자체에 없음 — 호출자가 fail-safe rollback 책임
  const rebootSection = cedarIndex.match(/const rebootCedarSubsystem\s*=[\s\S]*?(?=\n(?:const|export|\/\/))/)?.[0] ?? ''
  assert(
    !/try\s*\{/.test(rebootSection),
    'INV-CEDAR-RELOAD-FAIL-SAFE: rebootCedarSubsystem 내부 try/catch 부재 (throw 위임)',
  )

  const ucm = read('packages/server/src/server/user-context-manager.js')
  // #doReload 가 await rebootCedarSubsystem 후 wrapper.replace — try/catch 없이 throw 전파
  assert(
    /await\s+rebootCedarSubsystem\(/.test(ucm),
    'INV-CEDAR-RELOAD-FAIL-SAFE: #doReload 가 rebootCedarSubsystem 호출',
  )
  // wrapper.replace 가 await 직후 호출 (throw 시 미도달)
  assert(
    /await\s+rebootCedarSubsystem[\s\S]*?\.replace\(/.test(ucm),
    'INV-CEDAR-RELOAD-FAIL-SAFE: await reboot → wrapper.replace 순서 (throw 시 replace 미도달)',
  )
}

// KG-28 P5 — INV-CEDAR-RELOAD-EDGE-TRIGGER: reloadEvaluator 가 #reloadPending 단일 promise 공유 패턴.
//   자동 follow-up (dirty-bit) 부재 검증.
{
  const ucm = read('packages/server/src/server/user-context-manager.js')
  assert(
    /#reloadPending\s*=\s*null/.test(ucm),
    'INV-CEDAR-RELOAD-EDGE-TRIGGER: #reloadPending 필드 정의',
  )
  assert(
    /if\s*\(this\.#reloadPending\)\s*return\s*this\.#reloadPending/.test(ucm),
    'INV-CEDAR-RELOAD-EDGE-TRIGGER: 진행 중 reload promise 공유 (single-flight)',
  )
  // dirty-bit 자동 follow-up 패턴 부재 검증
  assert(
    !/#reloadDirty/.test(ucm),
    'INV-CEDAR-RELOAD-EDGE-TRIGGER: dirty-bit 자동 follow-up 패턴 부재',
  )
}

// KG-28 P5 — INV-CEDAR-AUDIT-VERSION: createAuditWriter 가 getPolicyVersion 받아 자동 첨부.
//   admin router 의 audit append 코드에 policyVersion 수동 기입 부재 (단일 진실 소스).
{
  const audit = read('packages/infra/src/infra/authz/cedar/audit.js')
  assert(
    /getPolicyVersion/.test(audit),
    'INV-CEDAR-AUDIT-VERSION: createAuditWriter 의 getPolicyVersion 파라미터',
  )
  assert(
    /policyVersion:\s*getPolicyVersion\(\)/.test(audit),
    'INV-CEDAR-AUDIT-VERSION: append 시 자동 첨부',
  )

  const adminRouter = read('packages/server/src/server/admin-router.js')
  // admin router 의 audit append 본문에 policyVersion: 직접 기입 부재 (auditWriter 자동 첨부에 위임)
  // activePolicyVersion 은 fail audit 의 활성 정보로 별도 의미 — 검증 대상 아님.
  assert(
    !/auditWriter\.append\([\s\S]*?\bpolicyVersion\s*:/.test(adminRouter),
    'INV-CEDAR-AUDIT-VERSION: admin router audit append 본문에 policyVersion 수동 기입 부재 (단일 진실 소스)',
  )
}

summary()
