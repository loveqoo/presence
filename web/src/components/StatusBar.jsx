function StatusBar({ connected, status, turn, tools }) {
  const statusIcon = { idle: '\u25CF', working: '\u25C9', error: '\u25CB' }
  const statusColor = { idle: 'var(--status-idle)', working: 'var(--status-working)', error: 'var(--status-error)' }

  return (
    <div className="status-bar">
      <span className="status-indicator" style={{ color: statusColor[status] }}>
        {statusIcon[status] || '\u25CF'} {status}
      </span>
      <span className="status-item">turn: {turn}</span>
      <span className="status-item">tools: {tools.length}</span>
      <span className={`status-conn ${connected ? 'on' : 'off'}`}>
        {connected ? 'connected' : 'disconnected'}
      </span>
    </div>
  )
}

export default StatusBar
