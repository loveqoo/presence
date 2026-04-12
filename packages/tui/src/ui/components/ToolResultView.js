import React from 'react'
import { Box, Text } from 'ink'
import { renderTool } from './tool-result-renderers.js'
import { getSummary, parseFileEntries, toGrid, truncateLines } from './tool-result-helpers.js'

const h = React.createElement

// --- Main component ---

const TOOL_PREFIX_PLAIN     = 'tool   > '  // 확장 불가 (body 없는 도구)
const TOOL_PREFIX_COLLAPSED = 'tool ▶ '    // 접힌 상태
const TOOL_PREFIX_EXPANDED  = 'tool ▼ '    // 펼친 상태

const ToolResultView = ({ tool, args, result, expanded = false }) => {
  const { header, body } = renderTool(tool, args, result)

  // 확장 불가: body 없는 도구 (calculate, file_write, 빈 file_list)
  if (!body) {
    return h(Box, null,
      h(Text, { color: 'magenta', bold: true }, TOOL_PREFIX_PLAIN),
      header,
    )
  }

  // 접힌 상태: 요약 1줄 + ▶ 지시자
  if (!expanded) {
    const summary = getSummary(tool, args || {}, result || '')
    return h(Box, null,
      h(Text, { color: 'magenta', bold: true }, TOOL_PREFIX_COLLAPSED),
      h(Text, { color: 'gray' }, summary),
    )
  }

  // 펼친 상태: 전체 상세 + ▼ 지시자
  return h(Box, { flexDirection: 'column' },
    h(Box, null,
      h(Text, { color: 'magenta', bold: true }, TOOL_PREFIX_EXPANDED),
      header,
    ),
    h(Box, { paddingLeft: 2 },
      body,
    ),
  )
}

export { ToolResultView, parseFileEntries, toGrid, truncateLines, getSummary }
