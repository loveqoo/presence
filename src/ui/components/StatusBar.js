import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const StatusBar = ({ status = 'idle', turn = 0, memoryCount = 0, agentName = 'Presence', activity = null }) => {
  const statusColor = status === 'working' ? 'yellow' : status === 'error' ? 'red' : 'green'

  const [frame, setFrame] = React.useState(0)
  React.useEffect(() => {
    if (status !== 'working') return
    const timer = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [status])

  return h(Box, { borderStyle: 'single', borderBottom: true, borderTop: false, borderLeft: false, borderRight: false, paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, `[${agentName}]`),
    h(Text, null, ' '),
    status === 'working'
      ? h(Text, { color: 'yellow' }, `${SPINNER_FRAMES[frame]} ${activity || 'thinking...'}`)
      : h(Text, { color: statusColor }, status),
    h(Text, null, ` | turn: ${turn}`),
    h(Text, null, ` | mem: ${memoryCount}`),
  )
}

export { StatusBar }
