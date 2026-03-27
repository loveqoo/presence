import React from 'react'
import { Box, Text } from 'ink'
import { CodeView, detectLang } from './CodeView.js'

const h = React.createElement

// --- Helpers ---

const truncateLines = (text, max) => {
  const lines = (text || '').split('\n')
  if (lines.length <= max) return { lines, truncated: 0 }
  return { lines: lines.slice(0, max), truncated: lines.length - max }
}

const parseFileEntries = (result) =>
  (result || '').split('\n').map(line => {
    // 새 형식: ├── name/ 또는 └── name
    const m2 = line.match(/^[├└]── (.+?)\/?\s*$/)
    if (m2) return { isDir: line.trimEnd().endsWith('/'), name: m2[1] }
    // 레거시 형식: [dir] name 또는 [file] name
    const m1 = line.match(/^\[(dir|file|\?)\] (.+)$/)
    if (m1) return { isDir: m1[1] === 'dir', name: m1[2] }
    return null
  }).filter(Boolean)

const toGrid = (items, termWidth) => {
  if (items.length === 0) return []
  const maxLen = Math.max(...items.map(it => it.display.length))
  const colWidth = maxLen + 2
  const cols = Math.max(1, Math.floor(Math.max(40, termWidth - 8) / colWidth))
  const rows = []
  for (let i = 0; i < items.length; i += cols) {
    rows.push(items.slice(i, i + cols))
  }
  return { rows, colWidth }
}

const countLines = (text) => (text || '').split('\n').length

// --- 1-line summaries (collapsed view) ---

const summarizers = {
  file_list: (args, result) => {
    const entries = parseFileEntries(result)
    const dirs = entries.filter(e => e.isDir).length
    const files = entries.filter(e => !e.isDir).length
    return `file_list ${args.path || '.'} — ${dirs} dirs, ${files} files`
  },
  file_read: (args, result) =>
    `file_read ${args.path || ''} — ${countLines(result)} lines`,
  shell_exec: (args, result) =>
    `$ ${args.command || ''} — ${countLines(result)} lines`,
  web_fetch: (args, result) =>
    `web_fetch ${args.url || ''} — ${countLines(result)} lines`,
}

const getSummary = (tool, args, result) => {
  const fn = summarizers[tool]
  if (fn) return fn(args, result)
  return `${tool} — ${countLines(result)} lines`
}

// --- Per-tool detail renderers (expanded view) ---
// Each returns { header: ReactElement, body: ReactElement | null }

const renderFileList = (_tool, args, result) => {
  const entries = parseFileEntries(result)
  const dirs = entries.filter(e => e.isDir).map(e => ({ ...e, display: e.name + '/' }))
  const files = entries.filter(e => !e.isDir).map(e => ({ ...e, display: e.name }))
  const all = [...dirs, ...files]
  if (all.length === 0) return { header: h(Text, { color: 'gray' }, `file_list ${args.path || '.'} (empty)`), body: null }

  const termWidth = process.stdout.columns || 80
  const { rows, colWidth } = toGrid(all, termWidth)

  return {
    header: h(Text, { color: 'gray' }, `file_list ${args.path || '.'}`),
    body: h(Box, { flexDirection: 'column' },
      ...rows.map((row, ri) =>
        h(Box, { key: ri },
          ...row.map((it, ci) =>
            h(Text, { key: ci, color: it.isDir ? 'cyan' : undefined },
              it.display.padEnd(colWidth))
          )
        )
      ),
    ),
  }
}

const renderFileRead = (_tool, args, result) => {
  const lang = detectLang(args.path)
  return {
    header: h(Text, { color: 'gray' }, `file_read ${args.path || ''}`),
    body: h(CodeView, { code: result, lang }),
  }
}

const renderFileWrite = (_tool, args, result) => ({
  header: h(Box, null,
    h(Text, { color: 'gray' }, `file_write ${args.path || ''} `),
    h(Text, { color: 'green' }, result || 'done'),
  ),
  body: null,
})

const renderShellExec = (_tool, args, result) => {
  const { lines, truncated } = truncateLines(result, 15)
  return {
    header: h(Text, { color: 'gray' }, `$ ${args.command || ''}`),
    body: h(Box, { flexDirection: 'column' },
      ...lines.map((line, i) => h(Text, { key: i }, line)),
      truncated > 0 ? h(Text, { color: 'gray', dimColor: true }, `... +${truncated} lines`) : null,
    ),
  }
}

const renderWebFetch = (_tool, args, result) => {
  const { lines, truncated } = truncateLines(result, 10)
  return {
    header: h(Text, { color: 'gray' }, `web_fetch ${args.url || ''}`),
    body: h(Box, { flexDirection: 'column' },
      ...lines.map((line, i) => h(Text, { key: i }, line)),
      truncated > 0 ? h(Text, { color: 'gray', dimColor: true }, `... +${truncated} lines`) : null,
    ),
  }
}

const renderCalculate = (_tool, args, result) => ({
  header: h(Box, null,
    h(Text, { color: 'gray' }, `${args.expression || '?'} `),
    h(Text, { bold: true }, `= ${result}`),
  ),
  body: null,
})

const renderDefault = (tool, _args, result) => {
  const { lines, truncated } = truncateLines(String(result), 10)
  return {
    header: h(Text, { color: 'gray' }, tool),
    body: h(Box, { flexDirection: 'column' },
      ...lines.map((line, i) => h(Text, { key: i }, line)),
      truncated > 0 ? h(Text, { color: 'gray', dimColor: true }, `... +${truncated} lines`) : null,
    ),
  }
}

const renderers = {
  file_list: renderFileList,
  file_read: renderFileRead,
  file_write: renderFileWrite,
  shell_exec: renderShellExec,
  web_fetch: renderWebFetch,
  calculate: renderCalculate,
}

// --- Main component ---

const ToolResultView = ({ tool, args, result, expanded = false }) => {
  const render = renderers[tool] || renderDefault
  const { header, body } = render(tool, args || {}, result || '')

  // Single-line tools (calculate, file_write): always show as-is
  if (!body) {
    return h(Box, null,
      h(Text, { color: 'magenta', bold: true }, 'tool   > '),
      header,
    )
  }

  // Collapsed: 1-line summary
  if (!expanded) {
    const summary = getSummary(tool, args || {}, result || '')
    return h(Box, null,
      h(Text, { color: 'magenta', bold: true }, 'tool   > '),
      h(Text, { color: 'gray' }, summary),
    )
  }

  // Expanded: full detail
  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: 'magenta', bold: true }, 'tool   > '),
      header,
    ),
    h(Box, { paddingLeft: 2 },
      body,
    ),
  )
}

export { ToolResultView, parseFileEntries, toGrid, truncateLines, getSummary }
