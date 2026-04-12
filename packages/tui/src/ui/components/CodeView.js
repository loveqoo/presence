import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

// --- Language detection ---

const EXT_MAP = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
  ts: 'js', tsx: 'js',
  json: 'json',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  py: 'py',
}

const detectLang = (filename) => {
  if (!filename) return 'text'
  const ext = filename.split('.').pop()?.toLowerCase()
  return EXT_MAP[ext] || 'text'
}

// --- String scanning helper ---

const findStringEnd = (line, start, quote) => {
  let i = start + 1
  while (i < line.length) {
    if (line[i] === '\\') { i += 2; continue }
    if (line[i] === quote) return i + 1
    i++
  }
  return line.length
}

// --- JS highlighter ---

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'import', 'export', 'from',
  'default', 'class', 'extends', 'new', 'this', 'super', 'async', 'await',
  'throw', 'try', 'catch', 'finally', 'typeof', 'instanceof', 'in', 'of',
  'true', 'false', 'null', 'undefined', 'void', 'delete', 'yield',
])

const highlightJS = (line) => {
  const tokens = []
  let pos = 0

  while (pos < line.length) {
    // Line comment
    if (line[pos] === '/' && line[pos + 1] === '/') {
      tokens.push({ text: line.slice(pos), color: 'gray' })
      return tokens
    }

    // Strings
    if (line[pos] === "'" || line[pos] === '"' || line[pos] === '`') {
      const end = findStringEnd(line, pos, line[pos])
      tokens.push({ text: line.slice(pos, end), color: 'green' })
      pos = end
      continue
    }

    // Number
    if (/\d/.test(line[pos]) && (pos === 0 || !/[\w$]/.test(line[pos - 1]))) {
      const m = line.slice(pos).match(/^\d+\.?\d*([eE][+-]?\d+)?/)
      if (m) {
        tokens.push({ text: m[0], color: 'yellow' })
        pos += m[0].length
        continue
      }
    }

    // Word
    if (/[a-zA-Z_$]/.test(line[pos])) {
      const m = line.slice(pos).match(/^[a-zA-Z_$][\w$]*/)
      if (m) {
        const color = JS_KEYWORDS.has(m[0]) ? 'magenta' : undefined
        tokens.push({ text: m[0], color })
        pos += m[0].length
        continue
      }
    }

    // Arrow
    if (line[pos] === '=' && line[pos + 1] === '>') {
      tokens.push({ text: '=>', color: 'cyan' })
      pos += 2
      continue
    }

    tokens.push({ text: line[pos] })
    pos++
  }
  return tokens
}

// --- JSON highlighter ---

const highlightJSON = (line) => {
  const tokens = []
  let pos = 0

  while (pos < line.length) {
    // String
    if (line[pos] === '"') {
      const end = findStringEnd(line, pos, '"')
      const str = line.slice(pos, end)
      // Key if followed by ':'
      const rest = line.slice(end).trimStart()
      tokens.push({ text: str, color: rest[0] === ':' ? 'cyan' : 'green' })
      pos = end
      continue
    }

    // Number
    if (/[-\d]/.test(line[pos])) {
      const m = line.slice(pos).match(/^-?\d+\.?\d*([eE][+-]?\d+)?/)
      if (m) {
        tokens.push({ text: m[0], color: 'yellow' })
        pos += m[0].length
        continue
      }
    }

    // Boolean/null
    const bm = line.slice(pos).match(/^(true|false|null)\b/)
    if (bm) {
      tokens.push({ text: bm[0], color: 'magenta' })
      pos += bm[0].length
      continue
    }

    tokens.push({ text: line[pos] })
    pos++
  }
  return tokens
}

// --- Shell highlighter ---

const highlightSh = (line) => {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) {
    const indent = line.length - trimmed.length
    return [
      { text: line.slice(0, indent) },
      { text: trimmed, color: 'gray' },
    ]
  }
  // Simple: strings green, flags yellow
  const tokens = []
  let pos = 0
  while (pos < line.length) {
    if (line[pos] === "'" || line[pos] === '"') {
      const end = findStringEnd(line, pos, line[pos])
      tokens.push({ text: line.slice(pos, end), color: 'green' })
      pos = end
      continue
    }
    if (line[pos] === '-' && /[a-zA-Z]/.test(line[pos + 1] || '')) {
      const m = line.slice(pos).match(/^--?[\w-]+/)
      if (m) {
        tokens.push({ text: m[0], color: 'yellow' })
        pos += m[0].length
        continue
      }
    }
    tokens.push({ text: line[pos] })
    pos++
  }
  return tokens
}

// --- Dispatcher ---

const highlighters = { js: highlightJS, json: highlightJSON, sh: highlightSh }

const highlightLine = (line, lang) => {
  const fn = highlighters[lang]
  return fn ? fn(line) : [{ text: line }]
}

// --- CodeView component ---

const CodeView = ({ code, lang = 'text', maxLines = 80, path }) => {
  const allLines = (code || '').split('\n')
  const visible = allLines.length > maxLines ? allLines.slice(0, maxLines) : allLines
  const truncated = allLines.length - visible.length
  const gutterWidth = String(visible.length).length

  const truncationHint = path
    ? `${' '.repeat(gutterWidth)} ... +${truncated} lines (원본: ${path})`
    : `${' '.repeat(gutterWidth)} ... +${truncated} lines`

  return h(Box, { flexDirection: 'column' },
    ...visible.map((line, idx) => {
      const lineNum = String(idx + 1).padStart(gutterWidth)
      const tokens = highlightLine(line, lang)
      return h(Box, { key: idx },
        h(Text, { color: 'gray', dimColor: true }, `${lineNum} `),
        h(Text, null,
          ...tokens.map((token, tokenIdx) =>
            h(Text, { key: tokenIdx, color: token.color || undefined }, token.text)
          ),
        ),
      )
    }),
    truncated > 0
      ? h(Text, { color: 'gray', dimColor: true }, truncationHint)
      : null,
  )
}

export { CodeView, detectLang, highlightLine, highlightJS, highlightJSON }
