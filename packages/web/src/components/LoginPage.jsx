import { useState } from 'react'

/**
 * LoginPage — two modes:
 * 1. Instance selection: multiple instances, none selected → list with instance name + username
 * 2. Login: instance selected → username as read-only label, password input only
 *
 * Props: { instances, selectedInstance, onSelectInstance, onLogin }
 */
function LoginPage({ instances = [], selectedInstance, onSelectInstance, onLogin }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  // Mode 1: multiple instances, none selected
  if (!selectedInstance && instances.length > 1) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>Presence</h1>
          <p className="login-subtitle">인스턴스를 선택하세요</p>
          <ul className="instance-list">
            {instances.map(inst => (
              <li key={inst.id} className="instance-item">
                <button
                  className="instance-select-btn"
                  onClick={() => onSelectInstance && onSelectInstance(inst)}
                >
                  <span className="instance-id">{inst.id}</span>
                  {inst.username && (
                    <span className="instance-username">{inst.username}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }

  // Mode 2: instance selected (or single/auto) → show username label + password
  const username = selectedInstance?.username || ''

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!password) return
    setError(null)
    setLoading(true)
    try {
      await onLogin(password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Presence</h1>
        {selectedInstance && (
          <p className="login-instance">{selectedInstance.id}</p>
        )}
        <form onSubmit={handleSubmit}>
          {username && (
            <div className="form-field">
              <label htmlFor="username">Username</label>
              <input
                id="username"
                type="text"
                value={username}
                readOnly
                autoComplete="username"
              />
            </div>
          )}
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading || !password}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
        {instances.length > 1 && onSelectInstance && (
          <button
            className="back-btn"
            onClick={() => onSelectInstance(null)}
          >
            ← 인스턴스 선택
          </button>
        )}
      </div>
    </div>
  )
}

export default LoginPage
