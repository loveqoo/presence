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
    orchestratorUrl,
    instances,
    selectedInstance,
    instanceUrl,
    loading: instanceLoading,
    selectInstance,
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

  // 로그인 핸들러:
  // - 오케스트레이터 모드: POST {orchestratorUrl}/api/auth/login with { instanceId, password }
  // - 프로덕션 모드: POST {instanceUrl}/api/auth/login directly
  const handleLogin = async (password) => {
    if (orchestratorUrl && selectedInstance) {
      // 오케스트레이터 경유: instanceId + password
      const res = await fetch(`${orchestratorUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: selectedInstance.id, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Login failed')
      }
      const data = await res.json()
      const newUser = { username: data.username, roles: data.roles || [] }
      instanceLogin(data.accessToken, data.refreshToken, newUser, data.mustChangePassword || false)
    } else {
      // 프로덕션: 인스턴스에 직접 로그인 (username은 selectedInstance.username)
      const username = selectedInstance?.username || ''
      await instanceLogin(username, password)
    }
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

  // 여러 인스턴스 + 미선택 → 인스턴스 선택 모드
  if (!selectedInstance && instances.length > 1) {
    return (
      <LoginPage
        instances={instances}
        selectedInstance={null}
        onSelectInstance={selectInstance}
        onLogin={handleLogin}
      />
    )
  }

  // 오케스트레이터 모드이지만 인스턴스 미결정 (단일 인스턴스 자동 선택 중 등)
  if (!instanceUrl && orchestratorUrl) {
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
        instances={instances}
        selectedInstance={selectedInstance}
        onSelectInstance={instances.length > 1 ? selectInstance : null}
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
