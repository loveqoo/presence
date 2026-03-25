import { usePresence } from './hooks/usePresence'
import ChatArea from './components/ChatArea'
import InputBar from './components/InputBar'
import StatusBar from './components/StatusBar'
import ApproveDialog from './components/ApproveDialog'

function App() {
  const {
    connected, status, turn, messages, streaming, approve, tools,
    sendMessage, respondApprove, cancel,
  } = usePresence()

  const handleSubmit = (input) => {
    if (input === '/cancel') { cancel(); return }
    sendMessage(input)
  }

  return (
    <div className="app">
      <StatusBar connected={connected} status={status} turn={turn} tools={tools} />
      <ChatArea messages={messages} streaming={streaming} />
      <InputBar onSubmit={handleSubmit} disabled={status === 'working'} />
      <ApproveDialog approve={approve} onRespond={respondApprove} />
    </div>
  )
}

export default App
