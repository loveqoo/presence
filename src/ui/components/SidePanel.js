import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

const SidePanel = ({ agents = [], stateSnapshot = {} }) => {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderLeft: true,
    borderRight: false,
    borderTop: false,
    borderBottom: false,
    paddingX: 1,
    width: 24,
  },
    h(Text, { bold: true, color: 'cyan' }, 'Sub-agents'),
    agents.length === 0
      ? h(Text, { color: 'gray' }, '  (none)')
      : agents.map((a, i) =>
          h(Box, { key: i },
            h(Text, null, `  ${a.name}: `),
            h(Text, { color: a.status === 'idle' ? 'green' : 'yellow' }, a.status),
          )
        ),
    h(Text, null, ''),
    h(Text, { bold: true, color: 'cyan' }, 'State'),
    ...Object.entries(stateSnapshot).filter(([k]) =>
      ['status', 'turn', 'currentInput'].includes(k)
    ).map(([k, v], i) =>
      h(Text, { key: `s-${i}` }, `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    ),
  )
}

export { SidePanel }
