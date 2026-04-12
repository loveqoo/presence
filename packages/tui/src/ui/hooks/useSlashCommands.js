import { useCallback } from 'react'
import { dispatchSlashCommand } from '../slash-commands.js'
import { t } from '@presence/infra/i18n'

// =============================================================================
// useSlashCommands: slash command dispatch + 일반 입력 처리를 캡슐화.
//
// props 그룹:
//   core    — state, agentState, addMessage, setMessages, clearTransientMessages, exit
//   context — config, tools, memory, llm, toolRegistry, onInput, username
//   ui      — messages, currentModel, setCurrentModel, setShowPanel, statusItems, setStatusItems
//   session — sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession
// =============================================================================

const useSlashCommands = ({ core, context, ui, session }) => {
  const handleInput = useCallback(async (input) => {
    // 이전 정보 조회 결과(transient) 제거
    core.clearTransientMessages()
    const { username, ...restContext } = context
    const slashCtx = {
      ...core,
      ...restContext,
      ...ui,
      ...session,
      userId: username,
    }
    if (await dispatchSlashCommand(input, slashCtx)) return

    // 일반 입력 → 유저 메시지 즉시 표시 후 에이전트 실행
    if (context.onInput) {
      core.addMessage({ role: 'user', content: input })
      context.onInput(input).then(() => {}).catch(err => {
        const isAbort = err.name === 'AbortError' || err.message?.includes('aborted')
        core.addMessage({
          role: 'system',
          content: isAbort ? t('cancel.cancelled') : t('slash_cmd.error', { message: err.message }),
          tag: isAbort ? undefined : 'error',
        })
      })
    }
  }, [core, context, ui, session])

  return handleInput
}

export { useSlashCommands }
