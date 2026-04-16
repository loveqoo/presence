import React from 'react'
import { Box, Text } from 'ink'
import { PlanView } from './PlanView.js'
import { MarkdownText } from './MarkdownText.js'
import { ToolResultView } from './ToolResultView.js'
import { t } from '@presence/infra/i18n'
import { CHAT } from '@presence/core/core/policies.js'

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

const renderMessage = (msg, key, toolExpanded) => {
  if (msg.role === 'plan') {
    return h(PlanView, {
      key,
      iteration: msg.iteration,
      maxIterations: msg.maxIterations,
      steps: msg.steps,
      status: msg.status,
    })
  }
  if (msg.role === 'tool') {
    return h(ToolResultView, { key, tool: msg.tool, args: msg.args, result: msg.result, expanded: toolExpanded })
  }
  return h(ChatMessage, { key, role: msg.role, content: msg.content, tag: msg.tag })
}

// FP-34: MAX_VISIBLE 초과 시 오래된 메시지를 잘라내고 배너로 안내.
// FP-58 Static 패턴 대신 동적 렌더 + 메시지 수 제한으로 frame 크기를 억제.
// /clear 와 양립 가능하며, 깜빡임은 spinner 제거 + streaming throttle 로 충분히 완화.
const ChatArea = ({ messages = [], toolExpanded = false }) => {
  const truncatedCount = Math.max(0, messages.length - CHAT.MAX_VISIBLE)
  const visible = truncatedCount > 0 ? messages.slice(truncatedCount) : messages

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    truncatedCount > 0
      ? h(Text, { color: 'gray', dimColor: true }, t('chat.truncated', { count: truncatedCount }))
      : null,
    ...visible.map((msg, i) => renderMessage(msg, truncatedCount + i, toolExpanded)),
  )
}

export { ChatArea, ChatMessage }
