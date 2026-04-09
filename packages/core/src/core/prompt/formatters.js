// =============================================================================
// Prompt formatters: tools/agents/memories를 텍스트로 직렬화.
// assemblePrompt가 system prompt 조립 시 사용.
// =============================================================================

const formatToolList = (tools) => {
  if (!tools || tools.length === 0) {
    return 'Available tools:\n\nNo tools available'
  }
  const lines = tools.map(t => {
    const params = t.parameters?.properties || {}
    const required = t.parameters?.required || []
    const paramLines = Object.entries(params).map(([k, v]) => {
      const req = required.includes(k) ? ', required' : ''
      return `  - ${k} (${v.type}${req}): ${v.description || ''}`
    }).join('\n')
    return `${t.name}: ${t.description || ''}\n${paramLines}`
  })
  return `Available tools:\n\n${lines.join('\n\n')}`
}

const formatAgentList = (agents) => {
  if (!agents || agents.length === 0) return ''
  const lines = agents.map(a => `${a.name || a.id}: ${a.description || ''}`)
  return `Available agents for delegation:\n\n${lines.join('\n')}`
}

const formatMemories = (memories) => {
  if (!memories || memories.length === 0) return ''
  return memories.map((m, i) => `[${i + 1}] ${typeof m === 'string' ? m : JSON.stringify(m)}`).join('\n')
}

export { formatToolList, formatAgentList, formatMemories }
