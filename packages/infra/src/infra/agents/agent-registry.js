import fp from '@presence/core/lib/fun-fp.js'
import { assertValidAgentId } from '@presence/core/core/agent-id.js'
import { DelegationMode } from './delegation.js'

const { Maybe } = fp

// =============================================================================
// AgentRegistry — 유저 컨텍스트의 에이전트 카탈로그.
// Key = qualified agentId (`{username}/{agentName}`). Entry 는 agentId + name (short) 동시 노출.
// LOCAL entry 는 run(task), REMOTE 는 endpoint.
// Delegate 인터프리터가 위임 실행 시점에 이 registry 를 조회한다.
// docs/design/agent-identity-model.md §10.2 참고.
// =============================================================================

const createAgentRegistry = () => {
  const agents = new Map()
  return {
    register: (spec) => {
      if (!spec.agentId) throw new Error('AgentRegistry.register: agentId required (qualified form)')
      assertValidAgentId(spec.agentId)
      const shortName = spec.agentId.split('/')[1]
      agents.set(spec.agentId, {
        agentId: spec.agentId,
        name: shortName,
        description: spec.description || '',
        capabilities: spec.capabilities || [],
        type: spec.type || DelegationMode.LOCAL,
        run: spec.run,
        endpoint: spec.endpoint,
        agentCard: spec.agentCard,
      })
    },
    get: (agentId) => Maybe.fromNullable(agents.get(agentId)),
    list: () => [...agents.values()],
    has: (agentId) => agents.has(agentId),
  }
}

// 내장 summarizer 에이전트 — user 마다 `{userId}/summarizer` 로 등록.
const registerSummarizer = (agentRegistry, llm, { userId } = {}) => {
  if (!userId) throw new Error('registerSummarizer: userId required')
  agentRegistry.register({
    agentId: `${userId}/summarizer`,
    description: '텍스트 요약 에이전트. 긴 내용을 간결하게 정리할 때 위임하세요.',
    capabilities: ['summarize'],
    type: DelegationMode.LOCAL,
    run: async (task) => {
      const result = await llm.chat({
        messages: [
          { role: 'system', content: '주어진 내용을 간결하게 요약하세요. 핵심만 남기세요.' },
          { role: 'user', content: task },
        ],
      })
      return result.content
    },
  })
}

export { createAgentRegistry, registerSummarizer }
