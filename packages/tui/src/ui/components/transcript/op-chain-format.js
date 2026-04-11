import { Delegation } from '@presence/infra/infra/agents/delegation.js'
import { t } from '@presence/infra/i18n'

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

// phase key → 사람 친화 label (i18n 경유).
const PHASE_LABELS = new Proxy({}, {
  get: (_, phase) => t(`op_phase.${phase}`),
})

const formatDelegateLabel = (label, result) => {
  if (!result) return label
  return Delegation.match(result, {
    completed: () => t('op_label.delegate_completed', { label }),
    failed: (r) => t('op_label.delegate_failed', { label, error: r.error || '?' }),
    submitted: () => t('op_label.delegate_submitted', { label }),
  })
}

const formatUpdateStateLabel = (detail) => {
  if (detail === 'turnState') return t('op_label.state_idle')
  if (detail === '_streaming') return t('op_label.state_streaming_clear')
  if (detail === 'lastTurn') return t('op_label.state_last_turn')
  if (detail === '_retry') return t('op_label.state_retry')
  if (detail?.includes('conversationHistory')) return t('op_label.state_history')
  if (detail?.startsWith('_debug.')) return t('op_label.state_debug', { detail: detail.replace('_debug.', '') })
  return t('op_label.state_generic', { detail: detail || 'state' })
}

// 상세 뷰: op의 전체 detail 표시.
const formatOpLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState' && detail === 'context.memories') return t('op_label.load_memories')
  if (tag === 'GetState' && detail?.includes('conversationHistory')) return t('op_label.load_history')
  if (tag === 'GetState') return t('op_label.load_generic', { detail: detail || 'state' })
  if (tag === 'AskLLM') return t('op_label.call_llm', { detail: detail || '?' })
  if (tag === 'ExecuteTool') return t('op_label.run_tool', { detail: detail || 'tool' })
  if (tag === 'Respond') return detail ? t('op_label.reply_with', { detail }) : t('op_label.reply')
  if (tag === 'Approve') return t('op_label.ask_approval', { detail: detail || '?' })
  if (tag === 'Delegate') return formatDelegateLabel(t('op_label.delegate_to', { detail: detail || '?' }), e.result)
  if (tag === 'UpdateState') return formatUpdateStateLabel(detail)
  return detail ? `${tag}(${detail})` : tag
}

const formatDelegateSummaryLabel = (label, result) => {
  if (!result) return label
  return Delegation.match(result, {
    completed: (r) => {
      const out = r.output || ''
      const preview = typeof out === 'string'
        ? (out.length > 40 ? out.slice(0, 37) + '...' : out)
        : JSON.stringify(out).slice(0, 40)
      return t('op_label.delegate_preview', { label, preview })
    },
    failed: (r) => t('op_label.delegate_failed', { label, error: r.error || '?' }),
    submitted: () => t('op_label.delegate_submitted', { label }),
  })
}

// 요약 뷰: phase 기준 단순 label.
const formatSummaryLabel = (e) => {
  const { tag, detail } = e
  if (tag === 'GetState') return t('op_phase.context')
  if (tag === 'AskLLM') return t('op_phase.llm')
  if (tag === 'ExecuteTool') return t('op_label.execute_tool', { detail: detail || '?' })
  if (tag === 'Respond') return t('op_phase.respond')
  if (tag === 'Approve') return t('op_label.await_approval', { detail: detail || '?' })
  if (tag === 'Delegate') return formatDelegateSummaryLabel(t('op_label.delegate_to', { detail: detail || '?' }), e.result)
  if (tag === 'UpdateState' && detail === '_retry') return t('op_label.state_retry')
  return formatOpLabel(e)
}

export { formatDuration, classifyPhase, PHASE_LABELS, formatOpLabel, formatSummaryLabel }
