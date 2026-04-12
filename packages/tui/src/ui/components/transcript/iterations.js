import React from 'react'
import { Box, Text } from 'ink'
import { t } from '@presence/infra/i18n'

const h = React.createElement

// =============================================================================
// Iterations tab: 멀티턴 iteration history 렌더러.
// report.js 의 iteration 렌더링과 동일한 데이터 구조를 React 요소로 변환.
// =============================================================================

const RESPONSE_TRUNCATE_LIMIT = 500

const buildIterationHeader = (iter) =>
  h(Text, { key: `h-${iter.iteration}`, bold: true, color: 'cyan' },
    `── Iteration ${iter.iteration + 1} ──`)

const buildIterationMeta = (iter) => {
  const lines = []
  lines.push(`  parsedType: ${iter.parsedType || 'unknown'}`)
  lines.push(`  stepCount:  ${iter.stepCount ?? '?'}`)
  if (iter.assembly?.used != null) lines.push(`  assembly:   ${iter.assembly.used} tokens`)
  if (iter.promptMessages > 0) lines.push(`  prompt:     ${iter.promptMessages} messages, ${iter.promptChars} chars`)
  return h(Text, { key: `m-${iter.iteration}`, color: 'white' }, lines.join('\n'))
}

const buildIterationError = (iter) =>
  iter.error
    ? h(Text, { key: `e-${iter.iteration}`, color: 'red' }, `  error: ${iter.error}`)
    : null

const buildIterationResponse = (iter) => {
  if (!iter.response) return null
  const preview = iter.response.length > RESPONSE_TRUNCATE_LIMIT
    ? iter.response.slice(0, RESPONSE_TRUNCATE_LIMIT) + '\n... (truncated)'
    : iter.response
  return h(Box, { key: `r-${iter.iteration}`, flexDirection: 'column' },
    h(Text, { color: 'gray' }, `  response (${iter.response.length} chars):`),
    h(Text, { color: 'white' }, `  ${preview.split('\n').join('\n  ')}`),
  )
}

const buildIterationElements = (iterationHistory) => {
  if (!iterationHistory || iterationHistory.length === 0) {
    return [h(Text, { key: 'empty', color: 'gray' }, t('transcript.no_iterations'))]
  }

  const elements = [
    h(Text, { key: 'count', color: 'cyan' }, `${iterationHistory.length} iterations`),
    h(Text, { key: 'blank' }, ''),
  ]

  for (const iter of iterationHistory) {
    elements.push(buildIterationHeader(iter))
    elements.push(buildIterationMeta(iter))
    const errorEl = buildIterationError(iter)
    if (errorEl) elements.push(errorEl)
    const responseEl = buildIterationResponse(iter)
    if (responseEl) elements.push(responseEl)
    elements.push(h(Text, { key: `sep-${iter.iteration}` }, ''))
  }

  return elements
}

export { buildIterationElements }
