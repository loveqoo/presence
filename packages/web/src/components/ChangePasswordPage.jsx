import { useState } from 'react'

/**
 * ChangePasswordPage — shown after login when mustChangePassword is true.
 * Props: { username, onChangePassword }
 */
function ChangePasswordPage({ username, onChangePassword }) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!currentPassword || !newPassword || !confirmPassword) return
    if (newPassword !== confirmPassword) {
      setError('새 비밀번호가 일치하지 않습니다.')
      return
    }
    setError(null)
    setLoading(true)
    try {
      await onChangePassword(currentPassword, newPassword)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const isValid = currentPassword && newPassword && confirmPassword && newPassword === confirmPassword

  return (
    <div className="login-page">
      <div className="login-container">
        <h1>Presence</h1>
        <p className="login-subtitle">비밀번호를 변경해야 합니다</p>
        {username && <p className="login-instance">{username}</p>}
        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="current-password">현재 비밀번호</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </div>
          <div className="form-field">
            <label htmlFor="new-password">새 비밀번호</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <div className="form-field">
            <label htmlFor="confirm-password">새 비밀번호 확인</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={loading || !isValid}>
            {loading ? '변경 중...' : '비밀번호 변경'}
          </button>
        </form>
      </div>
    </div>
  )
}

export default ChangePasswordPage
