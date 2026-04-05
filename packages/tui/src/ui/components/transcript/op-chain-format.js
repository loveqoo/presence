// =============================================================================
// Op chain formatters: op event → 사람 친화적 label/phase 매핑.
// =============================================================================

const formatDuration = (ms) => {
  if (ms == null) return '...'
  if (ms < 1) return '< 1ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Op을 논리적 phase로 분류.
const classifyPhase = (e) => {
  const { tag, detail } = e
  if (tag === 'UpdateState' && detail === 'turnState') return 'turn'
  if (tag === 'GetState') return 'context'
  if (tag === 'AskLLM') return 'llm'
  if (tag === 'ExecuteTool') return 'tool'
  if (tag === 'Respond') return 'respond'
  if (tag === 'Approve') return 'approve'
  if (tag === 'Delegate') return 'delegate'
  if (tag === 'UpdateState' && detail?.startsWith('_debug')) return 'debug'
  if (tag === 'UpdateState' && (detail === '_streaming' || detail === 'lastTurn' || detail?.startsWith('context.conversation'))) return 'finish'
  if (tag === 'UpdateState') return 'state'
  return 'other'
}

const PHASE_LABELS = {
  turn: 'Turn Transition', context: 'Load Context', llm: 'Ask LLM',
  tool: 'Execute Tool', respond: 'Send Response', approve: 'Await Approval',
  delegate: 'Delegate', debug: 'Save Debug', finish: 'Finish Turn',
  state: 'Update State', other: 'Other',
}

const formatDelegateLabel = (label, result) => {
  if (!result) return label
  if (result.status === 'completed') return `${label} → completed`
  if (result.status === 'failed') return `${label} → failed: ${result.error || '?'}`
  if (result.status === 'submitted') return `${label} → submitted`
  return label
}

const formatUpdateStateLabel = (detail) => {
  if (detail === 'turnState') return 'Set Idle'
  if (detail === '_streaming') return 'Clear Streaming'
  if (detail === 'lastTurn') return 'Record Result'
  if (detail === '_retry') return 'Retry'
  if (detail?.includes('conversationHistory')) return 'Save History'
  if (detail?.startsWith('_debug.')) return `Store ${detail.replace('_debug.', '')}`
  return `Set ${detail || 'state'}`
}

// 상세 뷰: op의 전체 detail 표시.
const formatOpLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState' && detail === 'context.memories') return 'Load Memories'
  if (tag === 'GetState' && detail?.includes('conversationHistory')) return 'Load History'
  if (tag === 'GetState') return `Load ${detail || 'state'}`
  if (tag === 'AskLLM') return `Call LLM (${detail || '?'})`
  if (tag === 'ExecuteTool') return `Run ${detail || 'tool'}`
  if (tag === 'Respond') return detail ? `Reply ("${detail}")` : 'Reply'
  if (tag === 'Approve') return `Ask Approval: ${detail || '?'}`
  if (tag === 'Delegate') return formatDelegateLabel(`Delegate to ${detail || '?'}`, e.result)
  if (tag === 'UpdateState') return formatUpdateStateLabel(detail)
  return detail ? `${tag}(${detail})` : tag
}

const formatDelegateSummaryLabel = (label, result) => {
  if (!result) return label
  if (result.status === 'completed') {
    const out = result.output || ''
    const preview = typeof out === 'string'
      ? (out.length > 40 ? out.slice(0, 37) + '...' : out)
      : JSON.stringify(out).slice(0, 40)
    return `${label} → ${preview}`
  }
  if (result.status === 'failed') return `${label} ✗ ${result.error || 'failed'}`
  if (result.status === 'submitted') return `${label} → submitted`
  return label
}

// 요약 뷰: phase 기준 단순 label.
const formatSummaryLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState') return 'Load Context'
  if (tag === 'AskLLM') return 'Ask LLM'
  if (tag === 'ExecuteTool') return `Execute Tool — ${detail || '?'}`
  if (tag === 'Respond') return 'Send Response'
  if (tag === 'Approve') return `Await Approval: ${detail || '?'}`
  if (tag === 'Delegate') return formatDelegateSummaryLabel(`Delegate to ${detail || '?'}`, e.result)
  if (tag === 'UpdateState' && detail === '_retry') return 'Retry'
  return formatOpLabel(e)
}

export { formatDuration, classifyPhase, PHASE_LABELS, formatOpLabel, formatSummaryLabel }
