import { t } from '@presence/infra/i18n'

// /policy [version] — admin only.
// FP-79: TUI 안에서 활성 정책 버전 확인 단일 경로.
//
// onPolicyVersion 은 RemoteSession 이 주입한 GET /api/admin/policy/version
// 호출 closure. 응답 shape:
//   - 200: { version: number, reloadedAt: string|null }
//   - 403: { error: 'admin only' }
//   - 그 외 에러는 throw

const formatReloadedAt = (iso) => {
  if (!iso) return t('policy_cmd.never_reloaded')
  // ISO 를 운영자가 읽기 쉬운 'YYYY-MM-DD HH:MM:SS' 로. 실패 시 원문.
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toISOString().replace('T', ' ').replace(/\..+/, '')
}

const cmdVersion = (onPolicyVersion, addMessage) => {
  if (!onPolicyVersion) { addMessage({ role: 'system', content: t('policy_cmd.not_available') }); return }
  onPolicyVersion().then(res => {
    if (res?.error) {
      addMessage({ role: 'system', content: t('policy_cmd.admin_only'), tag: 'error' })
      return
    }
    if (typeof res?.version !== 'number') {
      addMessage({ role: 'system', content: t('policy_cmd.unexpected_response'), tag: 'error' })
      return
    }
    addMessage({
      role: 'system',
      content: t('policy_cmd.version', {
        version: res.version,
        reloadedAt: formatReloadedAt(res.reloadedAt),
      }),
      transient: true,
    })
  }).catch(err => addMessage({
    role: 'system',
    content: t('slash_cmd.error', { message: err.message }),
    tag: 'error',
  }))
}

const handlePolicy = (input, ctx) => {
  const args = input.slice('/policy'.length).trim().split(/\s+/).filter(Boolean)
  const sub = args[0] || ''
  const { onPolicyVersion, addMessage } = ctx
  if (sub === 'version') return cmdVersion(onPolicyVersion, addMessage)
  addMessage({ role: 'system', content: t('policy_cmd.usage') })
}

export { handlePolicy }
