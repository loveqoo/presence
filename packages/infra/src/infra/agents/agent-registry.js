import fp from '@presence/core/lib/fun-fp.js'
import { DelegationMode } from './delegation.js'

const { Maybe } = fp

// =============================================================================
// AgentRegistry — 유저 컨텍스트의 에이전트 카탈로그.
// 이름 → Entry 매핑. Entry.type이 LOCAL이면 run(task) 보유, REMOTE면 endpoint 보유.
// Delegate 인터프리터가 위임 실행 시점에 이 registry를 조회한다.
// =============================================================================

const createAgentRegistry = () => {
  const agents = new Map()
  return {
    register: (spec) => {
      const name = spec.name
      agents.set(name, {
        name,
        description: spec.description || '',
        capabilities: spec.capabilities || [],
        type: spec.type || DelegationMode.LOCAL,
        run: spec.run,
        endpoint: spec.endpoint,
        agentCard: spec.agentCard,
      })
    },
    get: (name) => Maybe.fromNullable(agents.get(name)),
    list: () => [...agents.values()],
    has: (name) => agents.has(name),
  }
}

/**
 * `createAgentRegistry()` — Creates an in-memory registry of local and remote agents.
 * Returns `{ register, get, list, has }`.
 */
export { createAgentRegistry }
