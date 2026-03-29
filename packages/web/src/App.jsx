import { useState, useEffect } from 'react'
import { useInstance } from './hooks/useInstance'
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
    instances,
    selectedInstance,
    instanceUrl,
    loading: instanceLoading,
    selectInstance,
    clearInstance,
  } = useInstance()

  const {
    accessToken, user, authRequired, isAuthenticated,
    checkAuthRequired, login, logout, authFetch,
  } = useAuth(instanceUrl)

  // 서버 인증 요구 여부 확인 (instanceUrl이 결정된 후 최초 1회)
  useEffect(() => {
    if (instanceUrl) checkAuthRequired()
  }, [instanceUrl, checkAuthRequired])

  // 인증 필요 서버: 인증 완료 전에는 WS 연결 안 함 (unauthenticated WS 거부 방지)
  const canConnect = authRequired === false || isAuthenticated

  const {
    connected, status, turn, messages, streaming, approve, tools,
    sendMessage, respondApprove, cancel,
  } = usePresence(currentSessionId, { instanceUrl, authFetch, accessToken, enabled: canConnect })

  const handleSubmit = (input) => {
    if (input === '/cancel') { cancel(); return }
    sendMessage(input)
  }

  // 인스턴스 로딩 중
  if (instanceLoading) {
    return <div className="app loading">Loading...</div>
  }

  // 멀티 인스턴스 + 미선택
  if (instances.length > 1 && !selectedInstance) {
    return (
      <LoginPage
        instances={instances}
        selectedInstance={null}
        onSelectInstance={selectInstance}
        onLogin={login}
      />
    )
  }

  // 인증 확인 중
  if (authRequired === null) {
    return <div className="app loading">Loading...</div>
  }

  // 인증 필요 + 미인증
  if (authRequired && !isAuthenticated) {
    return (
      <LoginPage
        instances={instances}
        selectedInstance={selectedInstance}
        onSelectInstance={selectInstance}
        onChangeInstance={clearInstance}
        onLogin={login}
      />
    )
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
        instanceId={selectedInstance?.id || null}
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
          instanceUrl={instanceUrl}
        />
      )}
    </div>
  )
}

export default App
