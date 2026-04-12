import React from 'react'
import { Box, Text } from 'ink'
import { CodeView, detectLang } from './CodeView.js'
import { truncateLines, parseFileEntries, toGrid } from './tool-result-helpers.js'

const h = React.createElement

// --- Per-tool detail renderers (expanded view) ---
// Each returns { header: ReactElement, body: ReactElement | null }

const renderFileList = (_tool, args, result) => {
  const entries = parseFileEntries(result)
  const dirs = entries.filter(entry => entry.isDir).map(entry => ({ ...entry, display: entry.name + '/' }))
  const files = entries.filter(entry => !entry.isDir).map(entry => ({ ...entry, display: entry.name }))
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

const renderFileRead = (_tool, args, result) => ({
  header: h(Text, { color: 'gray' }, `file_read ${args.path || ''}`),
  body: h(CodeView, { code: result, lang: detectLang(args.path) }),
})

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
      ...lines.map((line, idx) => h(Text, { key: idx }, line)),
      truncated > 0 ? h(Text, { color: 'gray', dimColor: true }, `... +${truncated} lines`) : null,
    ),
  }
}

const renderWebFetch = (_tool, args, result) => {
  const { lines, truncated } = truncateLines(result, 10)
  return {
    header: h(Text, { color: 'gray' }, `web_fetch ${args.url || ''}`),
    body: h(Box, { flexDirection: 'column' },
      ...lines.map((line, idx) => h(Text, { key: idx }, line)),
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
      ...lines.map((line, idx) => h(Text, { key: idx }, line)),
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

export const renderTool = (tool, args, result) => {
  const render = renderers[tool] || renderDefault
  return render(tool, args || {}, result || '')
}
