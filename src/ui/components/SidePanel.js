import React from 'react'
import { Box, Text } from 'ink'

const h = React.createElement

const Section = ({ title, children }) =>
  h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { bold: true, color: 'cyan' }, `── ${title} ──`),
    children,
  )

const SidePanel = ({ agents = [], tools = [], todos = [], memoryCount = 0, events = { queue: [] } }) => {
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderLeft: true,
    borderRight: false,
    borderTop: false,
    borderBottom: false,
    paddingX: 1,
    width: 26,
  },
    h(Section, { title: 'Agents' },
      agents.length === 0
        ? h(Text, { color: 'gray' }, '  (none)')
        : agents.map((a, i) =>
            h(Text, { key: i }, `  ● ${a.name || a.id}`)
          ),
    ),

    h(Section, { title: 'Tools' },
      tools.length === 0
        ? h(Text, { color: 'gray' }, '  (none)')
        : tools.slice(0, 8).map((t, i) =>
            h(Text, { key: i, color: 'gray' }, `  ${t.name}`)
          ),
      tools.length > 8
        ? h(Text, { color: 'gray' }, `  +${tools.length - 8} more`)
        : null,
    ),

    h(Section, { title: 'Memory' },
      h(Text, { color: 'gray' }, `  ${memoryCount} nodes`),
    ),

    h(Section, { title: 'TODOs' },
      todos.length === 0
        ? h(Text, { color: 'gray' }, '  (none)')
        : todos.slice(0, 5).map((t, i) =>
            h(Text, { key: i }, `  ${t.title || t.type || String(t).slice(0, 20)}`)
          ),
      todos.length > 5
        ? h(Text, { color: 'gray' }, `  +${todos.length - 5} more`)
        : null,
    ),

    h(Section, { title: 'Events' },
      (events.queue?.length || 0) === 0
        ? h(Text, { color: 'gray' }, '  (queue empty)')
        : h(Text, { color: 'gray' }, `  ${events.queue.length} queued`),
    ),
  )
}

export { SidePanel }
