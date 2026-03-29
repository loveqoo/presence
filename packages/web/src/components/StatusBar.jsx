function StatusBar({ connected, status, turn, tools, sessionId = 'user-default', onSessionClick, user, onLogout, instanceId }) {
  const statusIcon = { idle: '\u25CF', working: '\u25C9', error: '\u25CB' }
  const statusColor = { idle: 'var(--status-idle)', working: 'var(--status-working)', error: 'var(--status-error)' }

  return (
    <div className="status-bar">
      <span className="status-indicator" style={{ color: statusColor[status] }}>
        {statusIcon[status] || '\u25CF'} {status}
      </span>
      <span className="status-item">turn: {turn}</span>
      <span className="status-item">tools: {tools.length}</span>
      {instanceId && <span className="status-item status-instance">{instanceId}</span>}
      <button className="session-btn" onClick={onSessionClick} title="세션 관리">
        ⊟ {sessionId}
      </button>
      <span className={`status-conn ${connected ? 'on' : 'off'}`}>
        {connected ? 'connected' : 'disconnected'}
      </span>
      {user && (
        <span className="status-user">
          {user.username}
          {onLogout && <button className="logout-btn" onClick={onLogout} title="Logout">logout</button>}
        </span>
      )}
    </div>
  )
}

export default StatusBar
