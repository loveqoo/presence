// --- Tool result helpers: 파싱, 그리드, 요약 ---

export const truncateLines = (text, max) => {
  const lines = (text || '').split('\n')
  if (lines.length <= max) return { lines, truncated: 0 }
  return { lines: lines.slice(0, max), truncated: lines.length - max }
}

export const parseFileEntries = (result) =>
  (result || '').split('\n').map(line => {
    // 새 형식: ├── name/ 또는 └── name
    const m2 = line.match(/^[├└]── (.+?)\/?\s*$/)
    if (m2) return { isDir: line.trimEnd().endsWith('/'), name: m2[1] }
    // 레거시 형식: [dir] name 또는 [file] name
    const m1 = line.match(/^\[(dir|file|\?)\] (.+)$/)
    if (m1) return { isDir: m1[1] === 'dir', name: m1[2] }
    return null
  }).filter(Boolean)

export const toGrid = (items, termWidth) => {
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

export const countLines = (text) => (text || '').split('\n').length

// --- 1-line summaries (collapsed view) ---

const summarizers = {
  file_list: (args, result) => {
    const entries = parseFileEntries(result)
    const dirs = entries.filter(entry => entry.isDir).length
    const files = entries.filter(entry => !entry.isDir).length
    return `file_list ${args.path || '.'} — ${dirs} dirs, ${files} files`
  },
  file_read: (args, result) =>
    `file_read ${args.path || ''} — ${countLines(result)} lines`,
  shell_exec: (args, result) =>
    `$ ${args.command || ''} — ${countLines(result)} lines`,
  web_fetch: (args, result) =>
    `web_fetch ${args.url || ''} — ${countLines(result)} lines`,
}

export const getSummary = (tool, args, result) => {
  const fn = summarizers[tool]
  if (fn) return fn(args, result)
  return `${tool} — ${countLines(result)} lines`
}
