import React from 'react'
import { Box, Text } from 'ink'
import { PlanView } from './PlanView.js'
import { MarkdownText, parseInline } from './MarkdownText.js'
import { ToolResultView } from './ToolResultView.js'

const h = React.createElement

// CJK 등 전각 문자의 터미널 표시 너비 계산
const visualWidth = (str) => {
  let w = 0
  for (const ch of str) {
    w += ch.charCodeAt(0) > 0xFF ? 2 : 1
  }
  return w
}

// 텍스트에 공백을 덧붙여 터미널 전체 너비를 채움 (배경색이 행 전체에 적용되도록)
const padToFullWidth = (text) => {
  const cols = (process.stdout.columns || 80) - 2  // ChatArea paddingX: 1 보정
  const vw = visualWidth(text)
  const pad = Math.max(0, cols - vw)
  return text + ' '.repeat(pad)
}

/**
 * 역할 구분: 라벨 대신 배경색 + 들여쓰기.
 *   user   — 배경 강조 (전체 행)
 *   agent  — 기본 배경, 들여쓰기
 *   system — dim, 들여쓰기
 */

const ChatMessage = ({ role, content, tag }) => {
  // User messages: 전체 행 배경색
  if (role === 'user') {
    const lines = (content || '').split('\n')
    return h(Box, { marginTop: 1, flexDirection: 'column' },
      ...lines.map((line, i) =>
        h(Box, { key: i },
          h(Text, { backgroundColor: 'blackBright', color: 'white' },
            padToFullWidth('  ' + line),
          ),
        )
      ),
    )
  }

  // Agent messages: 들여쓰기 + 녹색 계열
  if (role === 'agent') {
    return h(Box, { flexDirection: 'column', paddingLeft: 1, marginTop: 1 },
      h(MarkdownText, { content: content || '' }),
    )
  }

  // System messages: dim 처리
  if (content && content.includes('\n')) {
    return h(Box, { flexDirection: 'column', paddingLeft: 1, marginTop: 1 },
      tag ? h(Text, { color: 'yellow', dimColor: true }, `[${tag}]`) : null,
      h(Box, { paddingLeft: tag ? 1 : 0 },
        h(Text, { color: 'yellow', dimColor: true, wrap: 'wrap' }, content),
      ),
    )
  }
  return h(Box, { paddingLeft: 1, marginTop: 1 },
    tag ? h(Text, { color: 'yellow', dimColor: true }, `[${tag}] `) : null,
    h(Text, { color: 'yellow', dimColor: true, wrap: 'wrap' }, content),
  )
}

const MAX_VISIBLE = 50

const ChatArea = ({ messages = [], toolExpanded = false }) => {
  const visible = messages.length > MAX_VISIBLE
    ? messages.slice(-MAX_VISIBLE)
    : messages

  return h(Box, { flexDirection: 'column', flexGrow: 1, paddingX: 1, overflowY: 'hidden' },
    ...visible.map((msg, i) => {
      if (msg.role === 'plan') {
        return h(PlanView, {
          key: i,
          iteration: msg.iteration,
          maxIterations: msg.maxIterations,
          steps: msg.steps,
          status: msg.status,
        })
      }
      if (msg.role === 'tool') {
        return h(ToolResultView, { key: i, tool: msg.tool, args: msg.args, result: msg.result, expanded: toolExpanded })
      }
      return h(ChatMessage, { key: i, role: msg.role, content: msg.content, tag: msg.tag })
    }),
  )
}

export { ChatArea, ChatMessage }
