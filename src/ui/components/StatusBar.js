import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

const StatusBar = ({ status = 'idle', turn = 0, memoryCount = 0, agentName = 'Presence' }) => {
  const statusColor = status === 'working' ? 'yellow' : status === 'error' ? 'red' : 'green'

  return h(Box, { borderStyle: 'single', borderBottom: true, borderTop: false, borderLeft: false, borderRight: false, paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, `[${agentName}]`),
    h(Text, null, ' status: '),
    h(Text, { color: statusColor }, status),
    h(Text, null, ` | turn: ${turn}`),
    h(Text, null, ` | mem: ${memoryCount}건`),
  )
}

export { StatusBar }
