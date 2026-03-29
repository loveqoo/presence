import { useState, useEffect, useCallback } from 'react'

function SessionPanel({ currentSessionId, onSwitch, onClose, authFetch, instanceUrl }) {
  const fetchFn = authFetch || fetch
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState(null)

  const loadSessions = useCallback(() => {
    if (!instanceUrl) return
    setLoading(true)
    setError(null)
    fetchFn(`${instanceUrl}/api/sessions`)
      .then(r => r.json())
      .then(setSessions)
      .catch(() => setError('세션 목록을 불러올 수 없습니다.'))
      .finally(() => setLoading(false))
  }, [instanceUrl, fetchFn])

  useEffect(() => { loadSessions() }, [loadSessions])

  const createSession = async () => {
    if (!instanceUrl) return
    const id = newName.trim() || null
    setError(null)
    try {
      await fetchFn(`${instanceUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, type: 'user' }),
      })
      setNewName('')
      loadSessions()
    } catch {
      setError('세션 생성에 실패했습니다.')
    }
  }

  const deleteSession = async (id) => {
    if (!instanceUrl) return
    if (!window.confirm(`세션 '${id}'을 삭제하시겠습니까?`)) return
    setError(null)
    try {
      const res = await fetchFn(`${instanceUrl}/api/sessions/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      if (id === currentSessionId) onSwitch('user-default')
      loadSessions()
    } catch {
      setError('세션 삭제에 실패했습니다.')
    }
  }

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  const typeLabel = (type) => {
    if (type === 'agent') return 'agent'
    if (type === 'scheduled') return 'job'
    return 'user'
  }

  return (
    <div className="session-overlay" onClick={handleOverlayClick}>
      <div className="session-panel">
        <div className="session-panel-header">
          <span className="session-panel-title">세션 관리</span>
          <button className="session-panel-close" onClick={onClose}>✕</button>
        </div>

        {error && <div className="session-error">{error}</div>}

        <div className="session-list">
          {loading && <div className="session-loading">로딩 중...</div>}
          {!loading && sessions.map(s => (
            <div
              key={s.id}
              className={`session-item${s.id === currentSessionId ? ' active' : ''}${s.type !== 'user' ? ' readonly' : ''}`}
            >
              <div className="session-item-info">
                <span className="session-item-id">{s.id}</span>
                <span className={`session-item-type type-${s.type}`}>{typeLabel(s.type)}</span>
              </div>
              <div className="session-item-actions">
                {s.id === currentSessionId && (
                  <span className="session-item-current">현재</span>
                )}
                {s.id !== currentSessionId && s.type === 'user' && (
                  <button
                    className="btn-session-switch"
                    onClick={() => { onSwitch(s.id); onClose() }}
                  >
                    전환
                  </button>
                )}
                {s.id !== 'user-default' && s.type === 'user' && (
                  <button
                    className="btn-session-delete"
                    onClick={() => deleteSession(s.id)}
                  >
                    삭제
                  </button>
                )}
              </div>
            </div>
          ))}
          {!loading && sessions.length === 0 && (
            <div className="session-empty">세션이 없습니다.</div>
          )}
        </div>

        <div className="session-create">
          <input
            type="text"
            className="session-create-input"
            placeholder="새 세션 ID (비워두면 자동 생성)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && createSession()}
          />
          <button className="btn-session-create" onClick={createSession}>
            + 새 세션
          </button>
        </div>
      </div>
    </div>
  )
}

export default SessionPanel
