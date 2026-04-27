/**
 * INV-CEDAR-QUOTA-POLICY + 관련 회귀 (governance-cedar v2.3 §X / v2.4 §X).
 *
 * 정적 grep 으로 P1 + KG-26 의 핵심 invariant 가 침식되지 않았는지 검증한다. 의미론 회귀는
 * `packages/infra/test/agent-governance.test.js` GV-X1~X14 가 행동 검증 — 이 파일은
 * "코드/정책 파일에 약속된 형태가 그대로 있는가" 의 정적 방어.
 *
 * 1) INV-CEDAR-QUOTA-POLICY: 10-quota.cedar 가 존재 + forbid... when !isAdmin && currentCount >= maxAgents
 * 2) INV-CEDAR-ADMIN-EXEMPT: 11-admin-limit.cedar 가 존재 + isAdmin && currentCount >= hardLimit
 * 3) INV-SUBMIT-USER-AGENT-CONTEXT: agent-governance.js 의 CheckAccess 가 context { currentCount, maxAgents, isAdmin, hardLimit } 첨부
 * 4) INV-CREATE-AGENT-CALLERS: action: 'create_agent' 호출 모두 4 context 필드 첨부
 * 5) INV-CEDAR-CUSTOM-BLOCK: boot.js readPoliciesDir 가 5[0-9]- 패턴 throw
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

// 5. INV-CEDAR-CUSTOM-BLOCK — boot.js readPoliciesDir 가 5[0-9]- 패턴 throw
{
  const text = read('packages/infra/src/infra/authz/cedar/boot.js')
  assert(
    /\/\^5\[0-9\]-\//.test(text),
    'INV-CEDAR-CUSTOM-BLOCK: 5[0-9]- 정규식 패턴 존재',
  )
  assert(
    /custom policies.*P4/i.test(text),
    'INV-CEDAR-CUSTOM-BLOCK: 차단 메시지에 P4 ETA 명시',
  )
}

summary()
