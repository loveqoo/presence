import { SESSION_TYPE } from '@presence/infra/infra/constants.js'
import { assert, summary } from '../../../test/lib/assert.js'

// =============================================================================
// SessionManager.findAgentSession 단위 테스트 (A2A Phase 1 S1)
//
// findAgentSession 은 SessionManager 내부 구현이므로 factory 를 직접 호출하지
// 않고, Map/Array 기반 mock 으로 라우팅 규칙만 검증. (실 session 생성은
// session.test.js 에서 커버)
// =============================================================================

// findAgentSession 로직을 추출해 mock entries 로 테스트. session-manager.js 와
// 동일한 필터 규칙이어야 한다.
const makeFindAgentSession = (entries) => (agentId) => {
  const matches = entries.filter(
    entry => entry.type === SESSION_TYPE.AGENT && entry.session.agentId === agentId,
  )
  if (matches.length === 0) return { kind: 'not-registered', entry: null }
  if (matches.length > 1) return { kind: 'ambiguous', entry: null }
  return { kind: 'ok', entry: matches[0] }
}

// S2: findSenderSession — USER + AGENT 양쪽, AGENT 우선
const makeFindSenderSession = (entries) => (agentId) => {
  const agents = entries.filter(e => e.type === SESSION_TYPE.AGENT && e.session.agentId === agentId)
  if (agents.length > 1) return { kind: 'ambiguous', entry: null }
  if (agents.length === 1) return { kind: 'ok', entry: agents[0] }
  const users = entries.filter(e => e.type === SESSION_TYPE.USER && e.session.agentId === agentId)
  if (users.length > 1) return { kind: 'ambiguous', entry: null }
  if (users.length === 1) return { kind: 'ok', entry: users[0] }
  return { kind: 'not-registered', entry: null }
}

const run = () => {
  console.log('SessionManager.findAgentSession routing tests')

  // SM1. AGENT session 1 개 존재 → kind='ok' + entry 반환
  {
    const entries = [
      { id: 'agent-worker', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/worker' } },
    ]
    const find = makeFindAgentSession(entries)
    const result = find('alice/worker')
    assert(result.kind === 'ok', 'SM1: ok kind')
    assert(result.entry.session.agentId === 'alice/worker', 'SM1: correct entry')
  }

  // SM2. AGENT session 없음 → kind='not-registered'
  {
    const entries = [
      { id: 'agent-worker', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/worker' } },
    ]
    const find = makeFindAgentSession(entries)
    const result = find('alice/ghost')
    assert(result.kind === 'not-registered', 'SM2: not-registered')
    assert(result.entry === null, 'SM2: entry null')
  }

  // SM3. USER session 과 AGENT session 이 같은 agentId 로 dual-homed
  //       → AGENT session 만 선택 (USER 는 필터아웃)
  {
    const entries = [
      { id: 'alice-default', type: SESSION_TYPE.USER, session: { agentId: 'alice/default' } },
      { id: 'agent-default', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/default' } },
    ]
    const find = makeFindAgentSession(entries)
    const result = find('alice/default')
    assert(result.kind === 'ok', 'SM3: dual-homed → ok (AGENT 선택)')
    assert(result.entry.type === SESSION_TYPE.AGENT, 'SM3: AGENT type 만 반환')
    assert(result.entry.id === 'agent-default', 'SM3: AGENT session id')
  }

  // SM4. AGENT session 2 개가 같은 agentId (이론상 발생 안 함, 방어)
  //       → kind='ambiguous'
  {
    const entries = [
      { id: 'agent-worker-a', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/worker' } },
      { id: 'agent-worker-b', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/worker' } },
    ]
    const find = makeFindAgentSession(entries)
    const result = find('alice/worker')
    assert(result.kind === 'ambiguous', 'SM4: ambiguous')
    assert(result.entry === null, 'SM4: entry null')
  }

  // --- S2: findSenderSession ---

  // SM5. AGENT 없고 USER 만 — USER fallback
  {
    const entries = [
      { id: 'alice-default', type: SESSION_TYPE.USER, session: { agentId: 'alice/default' } },
    ]
    const find = makeFindSenderSession(entries)
    const result = find('alice/default')
    assert(result.kind === 'ok', 'SM5: USER only → ok')
    assert(result.entry.type === SESSION_TYPE.USER, 'SM5: USER entry 반환')
  }

  // SM6. AGENT + USER 공존 — AGENT 우선
  {
    const entries = [
      { id: 'alice-default', type: SESSION_TYPE.USER, session: { agentId: 'alice/default' } },
      { id: 'agent-default', type: SESSION_TYPE.AGENT, session: { agentId: 'alice/default' } },
    ]
    const find = makeFindSenderSession(entries)
    const result = find('alice/default')
    assert(result.kind === 'ok', 'SM6: dual-homed → ok')
    assert(result.entry.type === SESSION_TYPE.AGENT, 'SM6: AGENT 우선 선택')
  }

  // SM7. USER 도 AGENT 도 없음 → not-registered
  {
    const entries = []
    const find = makeFindSenderSession(entries)
    const result = find('alice/default')
    assert(result.kind === 'not-registered', 'SM7: 둘 다 없음 → not-registered')
    assert(result.entry === null, 'SM7: entry null')
  }

  summary()
}

run()
