/**
 * INV-AGENT-ACCESS 정적 + 동적 검사 (KG-18 강화).
 *
 * docs/design/agent-identity-model.md §9.4 의 5 개 진입점은 agent 실행 이전에
 * canAccessAgent 를 호출해야 한다. 정적 grep + 동적 spy 이중 방어:
 *
 * 1) 정적 grep (이 파일): 진입점 파일에 canAccessAgent import/호출 + INTENT 사용 확인.
 *    배선 누락을 조기 차단. 다만 반환값 무시 같은 잠재 회귀는 잡지 못함.
 *
 * 2) 동적 spy (각 진입점 통합 테스트): canAccessAgent 의 invocation log
 *    (`inspectAccessInvocations`) 로 happy path 가 실제로 호출했는지 검증. 호출 자체와
 *    사용된 INTENT/agentId/jwtSub 까지 자취 확인.
 *
 * 진입점 → 동적 spy 검증 위치:
 *   #1 session-api      → packages/server/test/server.test.js S1
 *   #2 a2a-router       → packages/server/test/a2a-invoke.test.js AI1
 *   #3 ws-handler       → packages/server/test/server.test.js S10
 *   #4 scheduler-factory → packages/server/test/scheduler-e2e.test.js SE1
 *   #5 delegate         → packages/core/test/interpreter/delegate.test.js #1
 *
 * spy infra: packages/infra/src/infra/authz/agent-access.js — `recordInvocation` 이
 * `canAccessAgent` 첫 줄에서 ring 버퍼에 push. unit test AA17~AA19 (agent-access.test.js).
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const ENTRY_POINTS = [
  { id: '#1 session-api', path: 'packages/server/src/server/session-api.js', intent: 'CONTINUE_SESSION|NEW_SESSION' },
  { id: '#2 a2a-router', path: 'packages/server/src/server/a2a-router.js', intent: 'DELEGATE' },
  { id: '#3 ws-handler', path: 'packages/server/src/server/ws-handler.js', intent: 'CONTINUE_SESSION' },
  { id: '#4 scheduler-factory', path: 'packages/server/src/server/scheduler-factory.js', intent: 'SCHEDULED_RUN' },
  { id: '#5 delegate', path: 'packages/infra/src/interpreter/delegate.js', intent: 'DELEGATE' },
]

console.log('INV-AGENT-ACCESS 5-point enforcement static check')

for (const ep of ENTRY_POINTS) {
  const content = readFileSync(join(REPO_ROOT, ep.path), 'utf8')
  assert(
    /canAccessAgent/.test(content),
    `${ep.id}: canAccessAgent import/call 존재 — ${ep.path}`,
  )
  const intentRe = new RegExp(`INTENT\\.(${ep.intent})`)
  assert(
    intentRe.test(content),
    `${ep.id}: INTENT.${ep.intent} 사용 — ${ep.path}`,
  )
}

summary()
