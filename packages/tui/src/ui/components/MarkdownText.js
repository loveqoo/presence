import React from 'react'
import { Box, Text } from 'ink'
import { CodeView } from './CodeView.js'
import { parseInline } from './markdown-inline.js'

const h = React.createElement

/**
 * 터미널용 경량 Markdown 렌더러.
 * **bold**, *italic*, _italic_, `code`, [link](url),
 * ```code block```, # heading, 목록(-, *, 1.) 처리.
 * 중첩 emphasis는 미지원 (flat 토큰만).
 */

const InlineParts = ({ parts }) =>
  h(Text, { wrap: 'wrap' },
    ...parts.map((part, idx) =>
      h(Text, { key: idx, bold: part.bold || false, dimColor: part.dimColor || false, color: part.color }, part.text)
    )
  )

// --- Block-level parsing ---

// 전체 내용이 코드인지 감지 (``` 없이 raw 코드가 온 경우)
const detectWholeCodeLang = (text) => {
  const trimmed = text.trim()
  if ((trimmed[0] === '{' && trimmed[trimmed.length - 1] === '}') ||
      (trimmed[0] === '[' && trimmed[trimmed.length - 1] === ']')) {
    try { JSON.parse(trimmed); return 'json' } catch (_) { /* not valid JSON */ }
  }
  return null
}

const LANG_MAP = Object.freeze({ javascript: 'js', typescript: 'js', bash: 'sh', shell: 'sh', python: 'py' })

// 코드 블록(```)을 파싱하고 다음 라인 인덱스를 반환
const parseCodeBlock = (lines, startIdx) => {
  const langTag = lines[startIdx].trimStart().slice(3).trim() || 'text'
  const codeLines = []
  let lineIdx = startIdx + 1
  while (lineIdx < lines.length && !lines[lineIdx].trimStart().startsWith('```')) {
    codeLines.push(lines[lineIdx])
    lineIdx++
  }
  if (lineIdx < lines.length) lineIdx++ // closing ``` 건너뜀
  const lang = LANG_MAP[langTag] || langTag
  return { codeLines, lang, nextIdx: lineIdx }
}

const MarkdownText = ({ content }) => {
  if (!content) return null

  // 전체 내용이 코드면 CodeView로 바로 렌더링
  const codeLang = detectWholeCodeLang(content)
  if (codeLang) {
    return h(CodeView, { code: content, lang: codeLang })
  }

  const lines = content.split('\n')
  const elements = []
  let lineIdx = 0

  while (lineIdx < lines.length) {
    const line = lines[lineIdx]

    // 코드 블록 (```)
    if (line.trimStart().startsWith('```')) {
      const { codeLines, lang, nextIdx } = parseCodeBlock(lines, lineIdx)
      lineIdx = nextIdx
      if (codeLines.length > 0) {
        elements.push(
          h(Box, { key: elements.length, paddingLeft: 1 },
            h(CodeView, { code: codeLines.join('\n'), lang }),
          )
        )
      }
      continue
    }

    // 제목 (# ## ###)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      elements.push(
        h(Text, { key: elements.length, bold: true, color: 'white' }, headingMatch[2])
      )
      lineIdx++
      continue
    }

    // 수평선 (---, ***)
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      elements.push(
        h(Text, { key: elements.length, color: 'gray' }, '────────────────────')
      )
      lineIdx++
      continue
    }

    // 목록 항목 (-, *, 1.) — 수평선 체크 뒤에 배치
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)/)
    if (listMatch) {
      const indent = listMatch[1].length
      const bullet = /^\d/.test(listMatch[2]) ? listMatch[2] : '•'
      elements.push(
        h(Box, { key: elements.length, paddingLeft: indent + 1 },
          h(InlineParts, { parts: parseInline(`${bullet} ${listMatch[3]}`) }),
        )
      )
      lineIdx++
      continue
    }

    // 빈 줄 → 단락 구분
    if (line.trim() === '') {
      elements.push(h(Text, { key: elements.length }, ' '))
      lineIdx++
      continue
    }

    // 일반 줄 (인라인 마크다운 적용)
    elements.push(
      h(InlineParts, { key: elements.length, parts: parseInline(line) })
    )
    lineIdx++
  }

  return h(Box, { flexDirection: 'column' }, ...elements)
}

export { MarkdownText, InlineParts, parseInline, detectWholeCodeLang }
