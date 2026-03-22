import React from 'react'
import { Box, Text } from 'ink'
import { CodeView } from './CodeView.js'

const h = React.createElement

/**
 * 터미널용 경량 Markdown 렌더러.
 * **bold**, `code`, ```code block```, # heading 처리.
 */

// --- Inline parsing: **bold**, `code` ---

const parseInline = (text) => {
  if (!text) return [{ text: '' }]
  const parts = []
  const regex = /(\*\*(.+?)\*\*|`(.+?)`)/g
  let lastIndex = 0
  let match

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index) })
    }
    if (match[2] != null) {
      parts.push({ text: match[2], bold: true })
    } else if (match[3] != null) {
      parts.push({ text: match[3], color: 'cyan' })
    }
    lastIndex = match.index + match[0].length
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex) })
  }
  return parts.length > 0 ? parts : [{ text: text || '' }]
}

const InlineParts = ({ parts }) =>
  h(Text, { wrap: 'wrap' },
    ...parts.map((p, i) =>
      h(Text, { key: i, bold: p.bold || false, color: p.color }, p.text)
    )
  )

// --- Block-level parsing ---

// 전체 내용이 코드인지 감지 (``` 없이 raw 코드가 온 경우)
const detectWholeCodeLang = (text) => {
  const t = text.trim()
  // JSON: { ... } 또는 [ ... ]
  if ((t[0] === '{' && t[t.length - 1] === '}') ||
      (t[0] === '[' && t[t.length - 1] === ']')) {
    try { JSON.parse(t); return 'json' } catch (_) { /* not valid JSON */ }
  }
  return null
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
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Code block (```)
    if (line.trimStart().startsWith('```')) {
      const langTag = line.trimStart().slice(3).trim() || 'text'
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // skip closing ```
      if (codeLines.length > 0) {
        const langMap = { javascript: 'js', typescript: 'js', bash: 'sh', shell: 'sh', python: 'py' }
        const lang = langMap[langTag] || langTag
        elements.push(
          h(Box, { key: elements.length, paddingLeft: 1 },
            h(CodeView, { code: codeLines.join('\n'), lang }),
          )
        )
      }
      continue
    }

    // Heading (# ## ###)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headingMatch) {
      elements.push(
        h(Text, { key: elements.length, bold: true, color: 'white' }, headingMatch[2])
      )
      i++
      continue
    }

    // Horizontal rule (---, ***)
    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      elements.push(
        h(Text, { key: elements.length, color: 'gray' }, '────────────────────')
      )
      i++
      continue
    }

    // Empty line → 단락 구분
    if (line.trim() === '') {
      elements.push(h(Text, { key: elements.length }, ' '))
      i++
      continue
    }

    // Regular line (with inline markdown)
    elements.push(
      h(InlineParts, { key: elements.length, parts: parseInline(line) })
    )
    i++
  }

  return h(Box, { flexDirection: 'column' }, ...elements)
}

export { MarkdownText, InlineParts, parseInline, detectWholeCodeLang }
