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
import ChangePasswordPage from './components/ChangePasswordPage'

function App() {
  const [currentSessionId, setCurrentSessionId] = useState('user-default')
  const [showSessionPanel, setShowSessionPanel] = useState(false)

  const {
    instanceUrl,
    loading: instanceLoading,
    clearInstance,
  } = useInstance()

  const {
    accessToken, user, authRequired, isAuthenticated, mustChangePassword,
    checkAuthRequired, login: instanceLogin, logout, authFetch, changePassword,
  } = useAuth(instanceUrl)

  // 인증 요구 여부 확인 (instanceUrl 결정 후)
  useEffect(() => {
    if (instanceUrl) checkAuthRequired()
  }, [instanceUrl, checkAuthRequired])

  const canConnect = authRequired === false || (isAuthenticated && !mustChangePassword)

  const {
    connected, status, turn, messages, streaming, approve, tools,
    sendMessage, respondApprove, cancel,
  } = usePresence(currentSessionId, { instanceUrl, authFetch, accessToken, enabled: canConnect })

  const handleLogin = async (username, password) => {
    await instanceLogin(username, password)
  }

  const handleChangePassword = async (currentPassword, newPassword) => {
    await changePassword(currentPassword, newPassword)
  }

  const handleLogout = async () => {
    await logout()
    clearInstance()
  }

  const handleSubmit = (input) => {
    if (input === '/cancel') { cancel(); return }
    sendMessage(input)
  }

  if (instanceLoading) {
    return <div className="app loading">Loading...</div>
  }

  // 인증 확인 중
  if (authRequired === null) {
    return <div className="app loading">Loading...</div>
  }

  // 인증 필요 + 미인증 → 로그인 모드
  if (authRequired && !isAuthenticated) {
    return (
      <LoginPage
        instances={[]}
        selectedInstance={null}
        onSelectInstance={null}
        onLogin={handleLogin}
      />
    )
  }

  // 인증됨 + 비밀번호 변경 필요
  if (isAuthenticated && mustChangePassword) {
    return (
      <ChangePasswordPage
        username={user?.username || ''}
        onChangePassword={handleChangePassword}
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
        onLogout={authRequired ? handleLogout : null}
        instanceId={null}
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
