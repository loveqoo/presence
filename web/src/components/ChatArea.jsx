import { useEffect, useRef } from 'react'

const roleLabel = { user: 'You', agent: 'Agent', system: 'System', error: 'Error' }
const roleClass = { user: 'msg-user', agent: 'msg-agent', system: 'msg-system', error: 'msg-error' }

function ChatArea({ messages, streaming }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streaming])

  return (
    <div className="chat-area">
      {messages.map((msg, i) => (
        <div key={i} className={`msg ${roleClass[msg.role] || ''}`}>
          <span className="msg-role">{roleLabel[msg.role] || msg.role}</span>
          <div className="msg-content">{msg.content}</div>
        </div>
      ))}
      {streaming && (
        <div className="msg msg-agent streaming">
          <span className="msg-role">Agent</span>
          <div className="msg-content">{streaming.content || '...'}</div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

export default ChatArea
