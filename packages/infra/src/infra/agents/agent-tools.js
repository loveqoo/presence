// =============================================================================
// Agent Tools — agent discovery (S3)
//
// A2A Phase 1 S3: 같은 유저 내 등록된 agent 목록을 LLM 에게 노출. planner
// agent 가 delegate / SendTodo target 선택 전에 사용.
//
// 다자 협업 자체는 Op.Parallel([Delegate(a,...), Delegate(b,...)]) 로 이미
// 해결되므로 (Q7 재평가 2026-04-24), S3 는 discovery 만 추가한다.
// =============================================================================

const formatAgent = (agent) => {
  const caps = agent.capabilities?.length
    ? ` | capabilities: [${agent.capabilities.join(', ')}]`
    : ''
  return `[${agent.agentId}] ${agent.name} — ${agent.description || '설명 없음'}${caps}`
}

// agentRegistry 를 클로저로 잡는 게 아니라 handler 호출 시점에 registry 의
// 최신 list() 를 읽는다 — registerAgentSessions 가 config.agents 를 나중에
// 등록해도 자동 반영.
const createListAgentsTool = (agentRegistry) => ({
  name: 'list_agents',
  description: '같은 유저에 등록된 다른 agent 의 목록을 반환합니다. delegate 또는 SendTodo 발행 전 target 선택에 사용하세요. archived agent 는 제외됩니다.',
  parameters: { type: 'object', properties: {} },
  handler: () => {
    const agents = agentRegistry.list().filter(a => !a.archived)
    if (agents.length === 0) return '등록된 agent 가 없습니다.'
    return agents.map(formatAgent).join('\n')
  },
})

export { createListAgentsTool, formatAgent }
