/**
 * INV-DELEGATE-ORDER 정적 검사 (KG-21).
 *
 * `docs/specs/agent-identity.md` I10 — Op.Delegate 흐름은 Parser → Resolver → Authz
 * 순서가 강제되어야 한다. JS 환경에선 컴파일 타임 brand 강제가 불가하므로,
 * `packages/infra/src/interpreter/delegate.js` 내부에서 호출 순서가 유지되는지
 * 정적 검사로 회귀를 차단한다.
 *
 * 검증:
 *   1) resolveDelegateTarget import + 호출 존재
 *   2) canAccessAgent  import + 호출 존재
 *   3) resolveDelegateTarget 첫 호출 라인 < canAccessAgent 첫 호출 라인
 *      (= Resolver 가 Authz 보다 먼저)
 *
 * 동적 검증은 KG-18 spy + delegate.test.js #1 통합 테스트가 담당.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const DELEGATE_PATH = 'packages/infra/src/interpreter/delegate.js'

console.log('INV-DELEGATE-ORDER static check (KG-21)')

const content = readFileSync(join(REPO_ROOT, DELEGATE_PATH), 'utf8')
const lines = content.split('\n')

const findFirstCallLine = (name) => {
  const re = new RegExp(`\\b${name}\\s*\\(`)
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].replace(/\/\/.*$/, '').trim()
    if (stripped && re.test(stripped)) return i + 1
  }
  return -1
}

assert(/from\s+['"]\.\.\/infra\/agents\/resolve-delegate-target\.js['"]/.test(content), 'resolve-delegate-target import 존재')
assert(/from\s+['"]\.\.\/infra\/authz\/agent-access\.js['"]/.test(content), 'agent-access import 존재')

const resolveLine = findFirstCallLine('resolveDelegateTarget')
const accessLine = findFirstCallLine('canAccessAgent')

assert(resolveLine > 0, `resolveDelegateTarget 호출 존재 (line ${resolveLine})`)
assert(accessLine > 0, `canAccessAgent 호출 존재 (line ${accessLine})`)
assert(resolveLine < accessLine, `Parser→Resolver→Authz 순서: resolve(${resolveLine}) < access(${accessLine})`)

summary()
