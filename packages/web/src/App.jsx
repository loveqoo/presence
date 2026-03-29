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
    orchestratorUrl,
    selectedInstance,
    instanceUrl,
    loading: instanceLoading,
    login: orchestratorLogin,
    clearInstance,
  } = useInstance()

  const {
    accessToken, user, authRequired, isAuthenticated,
    checkAuthRequired, login: instanceLogin, logout, authFetch,
  } = useAuth(instanceUrl)

  // 인증 요구 여부 확인 (instanceUrl 결정 후)
  useEffect(() => {
    if (instanceUrl) checkAuthRequired()
  }, [instanceUrl, checkAuthRequired])

  const canConnect = authRequired === false || isAuthenticated

  const {
    connected, status, turn, messages, streaming, approve, tools,
    sendMessage, respondApprove, cancel,
  } = usePresence(currentSessionId, { instanceUrl, authFetch, accessToken, enabled: canConnect })

  // 로그인: 오케스트레이터 경유 → 인스턴스 자동 결정 → 인스턴스에 토큰 설정
  const handleLogin = async (username, password) => {
    if (orchestratorUrl) {
      // 오케스트레이터가 인스턴스를 찾고 토큰을 반환
      const data = await orchestratorLogin(username, password)
      if (data?.accessToken) {
        // useAuth에 토큰 직접 설정
        instanceLogin(data.accessToken, data.refreshToken, { username: data.username, roles: data.roles })
      }
    } else {
      // 프로덕션: 인스턴스에 직접 로그인
      await instanceLogin(username, password)
    }
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

  // 인스턴스 미결정 + 인증 필요 (오케스트레이터 모드)
  if (!instanceUrl && orchestratorUrl) {
    return <LoginPage onLogin={handleLogin} />
  }

  // 인증 확인 중
  if (authRequired === null) {
    return <div className="app loading">Loading...</div>
  }

  // 인증 필요 + 미인증
  if (authRequired && !isAuthenticated) {
    return <LoginPage onLogin={handleLogin} />
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
