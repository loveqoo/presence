import React from 'react'
import { Box, Text, Static } from 'ink'
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

// FP-58: 완료된 메시지는 Static 으로 스크롤백에 append-only 렌더.
// 이후 dynamic frame rewrite 대상에서 제외 → streaming chunk 가 와도 과거 메시지는 재기록 안 됨.
// 단 transient 메시지(시스템 안내 등)는 dynamic 으로 유지 — Esc 로 지워질 수 있어야 하므로.
const ChatArea = ({ messages = [], toolExpanded = false }) => {
  const staticMessages = messages.filter(m => !m.transient)
  const transientMessages = messages.filter(m => m.transient)

  return h(React.Fragment, null,
    h(Static, { items: staticMessages.map((msg, idx) => ({ msg, idx })) },
      ({ msg, idx }) => h(Box, { key: idx, paddingX: 1 }, renderMessage(msg, idx, toolExpanded))
    ),
    transientMessages.length > 0
      ? h(Box, { flexDirection: 'column', paddingX: 1 },
          ...transientMessages.map((msg, i) => renderMessage(msg, `t-${i}`, toolExpanded))
        )
      : null,
  )
}

export { ChatArea, ChatMessage }
