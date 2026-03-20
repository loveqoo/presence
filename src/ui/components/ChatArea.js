import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

const ChatMessage = ({ role, content, tag }) => {
  const prefix = role === 'user' ? 'User' : role === 'agent' ? 'Agent' : role
  const color = role === 'user' ? 'white' : role === 'agent' ? 'green' : 'yellow'
  const tagText = tag ? `[${tag}] ` : ''

  return h(Box, null,
    h(Text, { color, bold: true }, `${prefix}: `),
    tag ? h(Text, { color: 'yellow' }, tagText) : null,
    h(Text, null, content),
  )
}

const ChatArea = ({ messages = [] }) => {
  return h(Box, { flexDirection: 'column', flexGrow: 1, paddingX: 1 },
    ...messages.map((msg, i) =>
      h(ChatMessage, { key: i, role: msg.role, content: msg.content, tag: msg.tag })
    )
  )
}

export { ChatArea, ChatMessage }
