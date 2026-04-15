import { t } from '@presence/infra/i18n'

// =============================================================================
// Iterations tab: 멀티턴 iteration history 렌더러.
// 1 아이템 = 1 터미널 행을 보장하기 위해 { text, color } 평탄화 라인 배열로 반환.
// (FP-57: 이전 element 모드는 멀티라인 Text 가 섞여 스크롤 슬라이스가 행 수와 어긋났다.)
// =============================================================================

const RESPONSE_TRUNCATE_LIMIT = 500

const pushIterationMeta = (lines, iter) => {
  lines.push({ text: `  parsedType: ${iter.parsedType || 'unknown'}`, color: 'white' })
  const stepLabel = iter.error ? t('transcript.error_label') : (iter.stepCount ?? '?')
  lines.push({ text: `  stepCount:  ${stepLabel}`, color: 'white' })
  if (iter.error) lines.push({ text: `  assembly:   ${t('transcript.error_label')}`, color: 'white' })
  else if (iter.assembly?.used != null) lines.push({ text: `  assembly:   ${iter.assembly.used} tokens`, color: 'white' })
  if (iter.promptMessages > 0) lines.push({ text: `  prompt:     ${iter.promptMessages} messages, ${iter.promptChars} chars`, color: 'white' })
}

const pushIterationResponse = (lines, iter) => {
  if (!iter.response) return
  const preview = iter.response.length > RESPONSE_TRUNCATE_LIMIT
    ? iter.response.slice(0, RESPONSE_TRUNCATE_LIMIT) + '\n... (truncated)'
    : iter.response
  lines.push({ text: `  response (${iter.response.length} chars):`, color: 'gray' })
  for (const bodyLine of preview.split('\n')) lines.push({ text: `  ${bodyLine}`, color: 'white' })
}

const buildIterationLines = (iterationHistory) => {
  if (!iterationHistory || iterationHistory.length === 0) {
    return [{ text: t('transcript.no_iterations'), color: 'gray' }]
  }

  const lines = [
    { text: `${iterationHistory.length} iterations`, color: 'cyan' },
    { text: '', color: null },
  ]

  for (const iter of iterationHistory) {
    const retryTag = iter.retryAttempt > 0 ? ` (retry ${iter.retryAttempt})` : ''
    lines.push({ text: `── Iteration ${iter.iteration + 1}${retryTag} ──`, color: 'cyan' })
    pushIterationMeta(lines, iter)
    if (iter.error) lines.push({ text: `  error: ${iter.error}`, color: 'red' })
    pushIterationResponse(lines, iter)
    lines.push({ text: '', color: null })
  }

  return lines
}

export { buildIterationLines }
