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

export {
  extractForCompaction,
  buildCompactionPrompt,
  createSummaryEntry,
  SUMMARY_MARKER,
}
