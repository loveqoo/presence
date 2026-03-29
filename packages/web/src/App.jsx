import { useState, useEffect } from 'react'
import { usePresence } from './hooks/usePresence'
import { useAuth } from './hooks/useAuth'
import ChatArea from './components/ChatArea'
import InputBar from './components/InputBar'
import StatusBar from './components/StatusBar'
import ApproveDialog from './components/ApproveDialog'
import SessionPanel from './components/SessionPanel'
import LoginPage from './components/LoginPage'

function App() {
  const [currentSessionId, setCurrentSessionId] = useState('user-default')
  const [showSessionPanel, setShowSessionPanel] = useState(false)

  const {
    accessToken, user, authRequired, isAuthenticated,
    checkAuthRequired, login, logout, authFetch,
  } = useAuth()

  // 서버 인증 요구 여부 확인 (최초 1회)
  useEffect(() => { checkAuthRequired() }, [checkAuthRequired])

  const {
    connected, status, turn, messages, streaming, approve, tools,
    sendMessage, respondApprove, cancel,
  } = usePresence(currentSessionId, { authFetch, accessToken })

  const handleSubmit = (input) => {
    if (input === '/cancel') { cancel(); return }
    sendMessage(input)
  }

  // 인증 확인 중
  if (authRequired === null) {
    return <div className="app loading">Loading...</div>
  }

  // 인증 필요 + 미인증
  if (authRequired && !isAuthenticated) {
    return <LoginPage onLogin={login} />
  }

  return (
    <div className="app">
      <StatusBar
        connected={connected}
        status={status}
        turn={turn}
        tools={tools}
        sessionId={currentSessionId}
        onSessionClick={() => setShowSessionPanel(true)}
        user={user}
        onLogout={authRequired ? logout : null}
      />
      <ChatArea messages={messages} streaming={streaming} />
      <InputBar onSubmit={handleSubmit} disabled={status === 'working'} />
      <ApproveDialog approve={approve} onRespond={respondApprove} />
      {showSessionPanel && (
        <SessionPanel
          currentSessionId={currentSessionId}
          onSwitch={(id) => setCurrentSessionId(id)}
          onClose={() => setShowSessionPanel(false)}
          authFetch={authFetch}
        />
      )}
    </div>
  )
}

export default App
