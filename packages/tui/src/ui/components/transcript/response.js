import React from 'react'
import { Box, Text } from 'ink'
import { highlightJSON } from '../CodeView.js'
import { t } from '@presence/infra/i18n'

const h = React.createElement

// =============================================================================
// Response tab: 마지막 LLM 응답 (JSON이면 pretty-print + syntax highlighting).
// React 요소 모드 (buildResponseElements) + text-only 폴백 (buildResponseFallbackLines).
// =============================================================================

const add = (lines, text, color) => { lines.push({ text, color: color || null }); return lines }
const blank = (lines) => add(lines, '')

const tryPrettyJson = (text) => {
  try { return JSON.stringify(JSON.parse(text), null, 2) }
  catch (_) { return text }
}

const chunkLine = (line, maxWidth) =>
  line.length <= maxWidth
    ? [line]
    : Array.from({ length: Math.ceil(line.length / maxWidth) }, (_, i) => line.slice(i * maxWidth, (i + 1) * maxWidth))

const buildChunkElement = (chunk, lineNum, ci) => {
  const tokens = highlightJSON(chunk)
  const prefix = ci === 0 ? `${String(lineNum).padStart(3)} │ ` : `    │ `
  return h(Box, { key: `${lineNum}-${ci}` },
    h(Text, { color: 'gray' }, prefix),
    ...tokens.map((tok, j) => h(Text, { key: j, color: tok.color || undefined }, tok.text)),
  )
}

const buildResponseElements = (lastResponse) => {
  if (!lastResponse) return [h(Text, { key: 'empty', color: 'gray' }, t('transcript.no_response_data'))]

  const formatted = tryPrettyJson(lastResponse)
  const maxWidth = Math.max(40, (process.stdout.columns || 80) - 10)
  const srcLines = formatted.split('\n')
  const elements = [
    h(Text, { key: 'header', color: 'cyan' }, `${lastResponse.length} chars`),
    h(Text, { key: 'blank' }, ''),
  ]

  let lineNum = 0
  for (const srcLine of srcLines) {
    lineNum++
    const chunks = chunkLine(srcLine, maxWidth)
    for (let ci = 0; ci < chunks.length; ci++) elements.push(buildChunkElement(chunks[ci], lineNum, ci))
  }
  return elements
}

// 텍스트 lines 폴백 (buildLines 하위 호환용)
const buildResponseFallbackLines = (lastResponse) => {
  const lines = []
  if (!lastResponse) { add(lines, 'No response data yet.', 'gray'); return lines }
  const formatted = tryPrettyJson(lastResponse)
  add(lines, `${lastResponse.length} chars`, 'cyan')
  blank(lines)
  for (const line of formatted.split('\n')) add(lines, `  ${line}`)
  return lines
}

export { buildResponseElements, buildResponseFallbackLines }
