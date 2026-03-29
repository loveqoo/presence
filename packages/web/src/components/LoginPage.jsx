import { useState } from 'react'

function LoginPage({ instances = [], selectedInstance, onSelectInstance, onChangeInstance, onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!username || !password) return
    setError(null)
    setLoading(true)
    try {
      await onLogin(username, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Phase 1: Instance selection (when instances available and none selected)
  if (instances.length > 1 && !selectedInstance) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>Presence</h1>
          <p className="login-subtitle">인스턴스를 선택하세요</p>
          <div className="instance-list">
            {instances.map(inst => (
              <button
                key={inst.id}
                className="instance-item"
                onClick={() => onSelectInstance(inst)}
              >
                <span className="instance-id">{inst.id}</span>
                <span className="instance-url">{inst.url}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // Phase 2: Credentials
  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Presence</h1>
        {selectedInstance && instances.length > 1 && (
          <div className="instance-selected">
            <span className="instance-id">{selectedInstance.id}</span>
            <button className="instance-change" onClick={onChangeInstance}>변경</button>
          </div>
        )}
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoComplete="username"
            />
          </div>
          <div className="form-field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading || !username || !password}>
            {loading ? 'Logging in...' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default LoginPage
