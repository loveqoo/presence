import { HISTORY } from '../core/policies.js'
import { t } from '../i18n/index.js'

// --- Constants ---

const SUMMARY_MARKER = '[conversation summary]'

// --- Pure functions ---

// history → { extracted, remaining } 분리 (순수)
const extractForCompaction = (history, threshold, keep) => {
  if (!Array.isArray(history) || history.length <= threshold) return null
  if (keep <= 0 || keep >= history.length || keep >= threshold) return null
  return {
    extracted: history.slice(0, history.length - keep),
    remaining: history.slice(history.length - keep),
  }
}

// summary 항목 생성 (순수, ms 충돌 방지용 random suffix)
const createSummaryEntry = (content) => {
  const now = Date.now()
  return {
    id: `summary-${now}-${Math.random().toString(36).slice(2, 8)}`,
    input: SUMMARY_MARKER,
    output: content,
    ts: now,
  }
}

const buildCompactionPrompt = (toCompact) => {
  const hasPreviousSummary = toCompact[0]?.input === SUMMARY_MARKER
  const parts = toCompact.map(h => {
    if (h.input === SUMMARY_MARKER) return `[Previous Summary]\n${h.output}`
    return `User: ${h.input}\nAssistant: ${h.output}`
  })

  const systemPrompt = hasPreviousSummary
    ? '이전 요약과 새 대화 기록을 통합하여 하나의 맥락 요약으로 작성하세요. 이전 요약의 핵심 내용을 보존하면서 새 대화의 사실과 결정 사항을 추가하세요. 3~5문장.'
    : '다음 대화 기록을 간결한 맥락 요약으로 작성하세요. 핵심 사실, 결정 사항, 이전 대화의 맥락을 보존하세요. 3~5문장.'

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: parts.join('\n---\n') },
    ],
  }
}

// --- Wire function ---

const wireHistoryCompaction = ({ state, llm, logger }) => {
  let compacting = false

  state.hooks.on('turnState', (phase, s) => {
    if (phase.tag !== 'idle') return
    if (compacting) return

    const history = s.get('context.conversationHistory') || []
    const split = extractForCompaction(history, HISTORY.COMPACTION_THRESHOLD, HISTORY.COMPACTION_KEEP)
    if (!split) return

    compacting = true
    const epochBefore = s.get('_compactionEpoch') || 0
    const beforeLen = history.length

    // Phase 1: 동기 추출 + placeholder prepend
    const placeholderId = `placeholder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const placeholder = {
      id: placeholderId,
      input: SUMMARY_MARKER,
      output: t('compaction.in_progress', { count: split.extracted.length }),
      ts: Date.now(),
    }
    s.set('context.conversationHistory', [placeholder, ...split.remaining])
    s.set('_compactionEpoch', epochBefore + 1)

    // Phase 2: 비동기 요약
    const prompt = buildCompactionPrompt(split.extracted)
    llm.chat(prompt).then(result => {
      // Phase 3: placeholder → 실제 summary 교체 — epoch 확인 후
      const epochNow = s.get('_compactionEpoch') || 0
      if (epochNow !== epochBefore + 1) {
        // /clear 발생 → 폐기
        if (logger) logger.info(t('compaction.discarded'))
        return
      }
      const current = s.get('context.conversationHistory') || []
      const summary = createSummaryEntry(result.content)
      const hasPlaceholder = current.some(h => h.id === placeholderId)
      const merged = hasPlaceholder
        ? current.map(h => h.id === placeholderId ? summary : h)
        : [summary, ...current]
      const updated = merged.length > HISTORY.MAX_CONVERSATION
        ? [merged[0], ...merged.slice(-(HISTORY.MAX_CONVERSATION - 1))]
        : merged
      s.set('context.conversationHistory', updated)
      if (logger) logger.info(t('compaction.completed', { before: beforeLen, after: updated.length }), { before: beforeLen, after: updated.length })
    }).catch(e => {
      // placeholder 제거, remaining 유지
      const epochNow = s.get('_compactionEpoch') || 0
      if (epochNow === epochBefore + 1) {
        const current = s.get('context.conversationHistory') || []
        s.set('context.conversationHistory', current.filter(h => h.id !== placeholderId))
      }
      if (logger) logger.warn(t('compaction.failed', { count: split.extracted.length }), { count: split.extracted.length, error: e.message })
    }).finally(() => {
      compacting = false
    })
  })
}

export {
  wireHistoryCompaction,
  extractForCompaction,
  buildCompactionPrompt,
  createSummaryEntry,
  SUMMARY_MARKER,
}
