import { createAgentRegistry } from '@presence/infra/infra/agents/agent-registry.js'
import { createListAgentsTool } from '@presence/infra/infra/agents/agent-tools.js'
import { DelegationMode } from '@presence/infra/infra/agents/delegation.js'
import { assert, summary } from '../../../test/lib/assert.js'

const run = () => {
  console.log('Agent tools (list_agents) tests')

  // LA1. 빈 registry → 안내 메시지
  {
    const registry = createAgentRegistry()
    const tool = createListAgentsTool(registry)
    assert(tool.name === 'list_agents', 'LA1: name')
    assert(typeof tool.description === 'string' && tool.description.length > 0, 'LA1: description')
    const result = tool.handler({})
    assert(result.includes('없습니다'), 'LA1: 빈 registry 안내')
  }

  // LA2. agents 등록 후 → description + capabilities 포함 포맷
  {
    const registry = createAgentRegistry()
    registry.register({
      agentId: 'alice/worker',
      description: '조사 전문',
      capabilities: ['search', 'summarize'],
      type: DelegationMode.LOCAL,
      run: async () => 'ok',
    })
    registry.register({
      agentId: 'alice/writer',
      description: '작성 전문',
      capabilities: ['write'],
      type: DelegationMode.LOCAL,
      run: async () => 'ok',
    })
    const tool = createListAgentsTool(registry)
    const result = tool.handler({})
    assert(result.includes('alice/worker'), 'LA2: worker agentId 포함')
    assert(result.includes('조사 전문'), 'LA2: worker description')
    assert(result.includes('search'), 'LA2: worker capability')
    assert(result.includes('alice/writer'), 'LA2: writer agentId 포함')
    assert(result.includes('write'), 'LA2: writer capability')
  }

  // LA3. archived agent 는 결과에서 제외
  {
    const registry = createAgentRegistry()
    registry.register({
      agentId: 'alice/active',
      description: '활성',
      type: DelegationMode.LOCAL,
      run: async () => 'ok',
    })
    registry.register({
      agentId: 'alice/old',
      description: '제거된 agent',
      type: DelegationMode.LOCAL,
      archived: true,
      run: async () => 'ok',
    })
    const tool = createListAgentsTool(registry)
    const result = tool.handler({})
    assert(result.includes('alice/active'), 'LA3: active 포함')
    assert(!result.includes('alice/old'), 'LA3: archived 제외')
  }

  // LA4. handler 호출 시점에 최신 list() — 등록이 나중에 되어도 반영
  {
    const registry = createAgentRegistry()
    const tool = createListAgentsTool(registry)
    // 먼저 tool 생성 후 등록
    registry.register({
      agentId: 'alice/late',
      description: '나중 등록',
      type: DelegationMode.LOCAL,
      run: async () => 'ok',
    })
    const result = tool.handler({})
    assert(result.includes('alice/late'), 'LA4: 나중 등록된 agent 반영 (registry 최신 참조)')
  }

  // LA5. 설명 없는 agent → 폴백
  {
    const registry = createAgentRegistry()
    registry.register({ agentId: 'alice/silent', type: DelegationMode.LOCAL, run: async () => 'ok' })
    const tool = createListAgentsTool(registry)
    const result = tool.handler({})
    assert(result.includes('alice/silent'), 'LA5: agentId 표시')
    assert(result.includes('설명 없음'), 'LA5: 설명 없음 폴백')
  }

  // LA6. parameters schema 는 빈 object
  {
    const tool = createListAgentsTool(createAgentRegistry())
    assert(tool.parameters?.type === 'object', 'LA6: parameters.type=object')
    assert(typeof tool.parameters?.properties === 'object', 'LA6: properties 존재')
  }

  summary()
}

run()
