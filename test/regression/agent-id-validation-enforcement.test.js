/**
 * INV-AGENT-ID-VALIDATION 정적 검사 (KG-20).
 *
 * `docs/specs/agent-identity.md` I1: validateAgentId 가 유일 진실. 모든 진입점이
 * 이 함수를 공유. JS 환경 특성상 컴파일 타임 brand 강제는 불가하므로, 핵심
 * 파일에서 검증 import + 호출이 존재하는지 정적 grep 으로 회귀를 차단한다.
 *
 * 검증되는 파일:
 *   1) Session 생성자                — assertValidAgentId(opts.agentId)
 *   2) AgentRegistry.register        — assertValidAgentId(spec.agentId)
 *   3) resolveDelegateTarget         — validateAgentId 경유 (parser 우회 차단)
 *   4) Op.SendA2aMessage 인터프리터  — assertValidAgentId(to)
 *   5) A2A self card                 — validateAgentId(agentId)
 *
 * 동적 검증 (회귀 자취 spy 기반) 은 별도 KG 후속 — 현재는 정적 + 단위 테스트
 * (SD11~13 Session, RDT1~9 resolveDelegateTarget) 로 검증 강도를 보장.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, summary } from '../lib/assert.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

const VALIDATION_SITES = [
  { id: '#1 Session 생성자', path: 'packages/infra/src/infra/sessions/session.js', call: 'assertValidAgentId' },
  { id: '#2 AgentRegistry.register', path: 'packages/infra/src/infra/agents/agent-registry.js', call: 'assertValidAgentId' },
  { id: '#3 resolveDelegateTarget', path: 'packages/infra/src/infra/agents/resolve-delegate-target.js', call: 'validateAgentId' },
  { id: '#4 Op.SendA2aMessage', path: 'packages/infra/src/interpreter/send-a2a-message.js', call: 'assertValidAgentId' },
  { id: '#5 A2A self card', path: 'packages/infra/src/infra/agents/self-card.js', call: 'validateAgentId' },
]

console.log('INV-AGENT-ID-VALIDATION static check (KG-20)')

for (const site of VALIDATION_SITES) {
  const content = readFileSync(join(REPO_ROOT, site.path), 'utf8')
  const importRe = new RegExp(`from\\s+['"]@presence/core/core/agent-id\\.js['"]`)
  assert(importRe.test(content), `${site.id}: agent-id 모듈 import 존재 — ${site.path}`)
  const callRe = new RegExp(`\\b${site.call}\\s*\\(`)
  assert(callRe.test(content), `${site.id}: ${site.call} 호출 존재 — ${site.path}`)
}

summary()
