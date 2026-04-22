/**
 * INV-AGENT-ACCESS 정적 검사.
 *
 * docs/design/agent-identity-model.md §9.4 의 5 개 진입점은 agent 실행 이전에
 * canAccessAgent 를 호출해야 한다. 각 진입점 파일이 해당 import / 호출을 포함하는지
 * grep 으로 검증 — 배선 누락을 조기 차단.
 *
 * 5 진입점:
 *   #1 HTTP /api/sessions/*     → packages/server/src/server/session-api.js
 *   #2 HTTP /a2a/*              → packages/server/src/server/a2a-router.js
 *   #3 WebSocket session join   → packages/server/src/server/ws-handler.js
 *   #4 Scheduler dispatch       → packages/server/src/server/scheduler-factory.js
 *   #5 Op.Delegate              → packages/infra/src/interpreter/delegate.js
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
