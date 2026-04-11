import { t } from '@presence/infra/i18n'

// /sessions [list|new|switch|delete] command handler.

const cmdList = (sessionId, onListSessions, addMessage) => {
  if (!onListSessions) { addMessage({ role: 'system', content: t('sessions_cmd.not_available') }); return }
  onListSessions().then(sessions => {
    const lines = sessions.map(s => {
      const marker = s.id === sessionId ? '●' : ' '
      const current = s.id === sessionId ? ` ${t('sessions_cmd.current_marker')}` : ''
      // name 이 id 와 다르면 함께 표시, 같으면 중복 억제
      const nameSuffix = s.name && s.name !== s.id ? `  "${s.name}"` : ''
      return `${marker} ${s.id}${nameSuffix}  [${s.type}]${current}`
    })
    addMessage({ role: 'system', content: `${t('sessions_cmd.list_header')}\n${lines.join('\n')}`, transient: true })
  }).catch(e => addMessage({ role: 'system', content: t('slash_cmd.error', { message: e.message }), tag: 'error' }))
}

const cmdNew = (name, onCreateSession, addMessage) => {
  if (!onCreateSession) { addMessage({ role: 'system', content: t('sessions_cmd.not_available') }); return }
  onCreateSession(name || null).then(s => {
    addMessage({ role: 'system', content: t('sessions_cmd.created', { id: s.id }) })
  }).catch(e => addMessage({ role: 'system', content: t('slash_cmd.error', { message: e.message }), tag: 'error' }))
}

const cmdSwitch = (id, onSwitchSession, addMessage) => {
  if (!id) { addMessage({ role: 'system', content: t('sessions_cmd.usage_switch') }); return }
  if (!onSwitchSession) { addMessage({ role: 'system', content: t('sessions_cmd.not_available') }); return }
  addMessage({ role: 'system', content: t('sessions_cmd.switching', { id }) })
  onSwitchSession(id).catch(e => addMessage({ role: 'system', content: t('slash_cmd.error', { message: e.message }), tag: 'error' }))
}

const cmdDelete = (id, currentId, onDeleteSession, addMessage) => {
  if (!id) { addMessage({ role: 'system', content: t('sessions_cmd.usage_delete') }); return }
  if (id === currentId) { addMessage({ role: 'system', content: t('sessions_cmd.cannot_delete_current') }); return }
  if (!onDeleteSession) { addMessage({ role: 'system', content: t('sessions_cmd.not_available') }); return }
  onDeleteSession(id).then(() => {
    addMessage({ role: 'system', content: t('sessions_cmd.deleted', { id }) })
  }).catch(e => addMessage({ role: 'system', content: t('slash_cmd.error', { message: e.message }), tag: 'error' }))
}

const handleSessions = (input, ctx) => {
  const args = input.slice('/sessions'.length).trim().split(/\s+/).filter(Boolean)
  const sub = args[0] || 'list'
  const { sessionId, onListSessions, onCreateSession, onSwitchSession, onDeleteSession, addMessage } = ctx
  if (sub === 'list') return cmdList(sessionId, onListSessions, addMessage)
  if (sub === 'new') return cmdNew(args[1], onCreateSession, addMessage)
  if (sub === 'switch') return cmdSwitch(args[1], onSwitchSession, addMessage)
  if (sub === 'delete') return cmdDelete(args[1], sessionId, onDeleteSession, addMessage)
  addMessage({ role: 'system', content: t('sessions_cmd.usage') })
}

export { handleSessions }
