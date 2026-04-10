import { useCallback } from 'react'
import { dispatchSlashCommand } from '../slash-commands.js'
import { t } from '@presence/infra/i18n'

// =============================================================================
// useSlashCommands: slash command dispatch + 일반 입력 처리를 캡슐화.
//
// App에서 handleInput 하나만 받으면 됨.
// =============================================================================

const useSlashCommands = ({
  state, agentState, config, tools, memory, llm, toolRegistry,
  addMessage, setMessages, clearTransientMessages, exit,
  currentModel, setCurrentModel, setShowPanel, statusItems, setStatusItems,
  sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession,
  onInput,
}) => {

  const handleInput = useCallback(async (input) => {
    // 이전 정보 조회 결과(transient) 제거
    clearTransientMessages()
    const slashCtx = {
      addMessage, exit, state, agentState, config,
      tools, memory, llm, toolRegistry,
      currentModel, setCurrentModel,
      setMessages, setShowPanel, statusItems, setStatusItems,
      sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession,
      onInput,
    }
    if (await dispatchSlashCommand(input, slashCtx)) return

    // 일반 입력 → 유저 메시지 즉시 표시 후 에이전트 실행
    if (onInput) {
      addMessage({ role: 'user', content: input })
      onInput(input).then(() => {}).catch(err => {
        const isAbort = err.name === 'AbortError' || err.message?.includes('aborted')
        addMessage({
          role: 'system',
          content: isAbort ? t('cancel.cancelled') : `Error: ${err.message}`,
          tag: isAbort ? undefined : 'error',
        })
      })
    }
  }, [
    onInput, exit, agentState, tools, addMessage, clearTransientMessages, statusItems, currentModel,
    llm, memory, config, state, toolRegistry, sessionId,
    onListSessions, onCreateSession, onDeleteSession, onSwitchSession,
    setMessages, setCurrentModel, setShowPanel, setStatusItems,
  ])

  return handleInput
}

export { useSlashCommands }
