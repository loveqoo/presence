import React from 'react'
import { Box, Text } from 'ink'
import { t } from '@presence/infra/i18n'

const h = React.createElement

const Section = ({ title, children }) =>
  h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Text, { bold: true, color: 'cyan' }, `── ${title} ──`),
    children,
  )

// TODO status 값 → 아이콘. status 는 아직 도메인에서 확정되지 않았으므로
// 알려진 값만 매핑하고 그 외는 'unknown' 으로 낙하 (FP-07).
const todoStatusIcon = (status) => {
  const key = status && ['ready', 'done', 'blocked'].includes(status) ? status : 'unknown'
  return t(`side_panel.todo_status.${key}`)
}

const todoDisplay = (todo) => todo.title || todo.type || String(todo).slice(0, 20)

const SidePanel = ({ agents = [], tools = [], todos = [], memoryCount = 0, events = { queue: [], deadLetter: [] } }) => {
  const deadLetterCount = events.deadLetter?.length || 0
  const queueCount = events.queue?.length || 0
  const hasDead = deadLetterCount > 0

  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderLeft: true,
    borderRight: false,
    borderTop: false,
    borderBottom: false,
    paddingX: 1,
    width: 30,
  },
    h(Section, { title: t('side_panel.agents') },
      agents.length === 0
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.none')}`)
        : agents.map((a, i) =>
            h(Text, { key: i }, `  ● ${a.name || a.id}`)
          ),
    ),

    h(Section, { title: t('side_panel.tools') },
      tools.length === 0
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.none')}`)
        : tools.slice(0, 8).map((tool, i) =>
            h(Text, { key: i, color: 'gray' }, `  ${tool.name}`)
          ),
      tools.length > 8
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.tools_more', { count: tools.length - 8 })}`)
        : null,
    ),

    h(Section, { title: t('side_panel.memory') },
      h(Text, { color: 'gray' }, `  ${t('side_panel.nodes', { count: memoryCount })}`),
    ),

    h(Section, { title: t('side_panel.todos') },
      todos.length === 0
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.none')}`)
        : todos.slice(0, 5).map((todo, i) =>
            h(Text, { key: i }, `  ${todoStatusIcon(todo.status)} ${todoDisplay(todo)}`)
          ),
      todos.length > 5
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.more', { count: todos.length - 5 })}`)
        : null,
    ),

    h(Section, { title: t('side_panel.events') },
      queueCount === 0 && !hasDead
        ? h(Text, { color: 'gray' }, `  ${t('side_panel.queue_empty')}`)
        : h(Text, { color: hasDead ? 'red' : 'gray' },
            `  ${hasDead
              ? t('side_panel.queue_with_dead', { queue: queueCount, dead: deadLetterCount })
              : t('side_panel.queue_count', { queue: queueCount })}`,
          ),
    ),
  )
}

export { SidePanel, todoStatusIcon }
