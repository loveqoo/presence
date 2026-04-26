import { t } from '@presence/infra/i18n'

// /session [list|new|switch|delete] command handler.

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

// FP-64: 서버 400 응답의 code 필드 기반으로 i18n 메시지 선택. code 없으면 원문 표시.
// FP-68: AGENT_ACCESS_DENIED 의 reason 별 분기. raw 코드 (`admin-singleton`) 가
// 사용자에게 노출되던 결함 해소.
const formatCreateError = (resp) => {
  const msg = resp?.error || ''
  const code = resp?.code
  const reason = resp?.reason
  if (code === 'WORKING_DIR_OUT_OF_BOUNDS') return t('sessions_cmd.error.working_dir_out_of_bounds')
  if (code === 'WORKING_DIR_NOT_RESOLVABLE') return t('sessions_cmd.error.working_dir_not_resolvable')
  if (code === 'AGENT_ACCESS_DENIED' && reason === 'admin-singleton') {
    return t('sessions_cmd.error.admin_singleton')
  }
  return t('slash_cmd.error', { message: msg })
}

const cmdNew = (name, onCreateSession, addMessage) => {
  if (!onCreateSession) { addMessage({ role: 'system', content: t('sessions_cmd.not_available') }); return }
  onCreateSession(name || null).then(s => {
    if (s?.error) {
      addMessage({ role: 'system', content: formatCreateError(s), tag: 'error' })
      return
    }
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
  const args = input.slice('/session'.length).trim().split(/\s+/).filter(Boolean)
  const sub = args[0] || 'list'
  const { sessionId, onListSessions, onCreateSession, onSwitchSession, onDeleteSession, addMessage } = ctx
  if (sub === 'list') return cmdList(sessionId, onListSessions, addMessage)
  if (sub === 'new') return cmdNew(args[1], onCreateSession, addMessage)
  if (sub === 'switch') return cmdSwitch(args[1], onSwitchSession, addMessage)
  if (sub === 'delete') return cmdDelete(args[1], sessionId, onDeleteSession, addMessage)
  addMessage({ role: 'system', content: t('sessions_cmd.usage') })
}

export { handleSessions }
