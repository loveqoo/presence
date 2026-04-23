import { useCallback } from 'react'
import { dispatchSlashCommand } from '../slash-commands.js'
import { t } from '@presence/infra/i18n'

// =============================================================================
// useSlashCommands: slash command dispatch + 일반 입력 처리를 캡슐화.
//
// props 그룹 (flat slashCtx 로 병합):
//   core    — state, agentState, addTransient, clearTransient, optimisticClearNow, exit
//   context — config, tools, memory, llm, toolRegistry, onInput, username
//   ui      — messages, currentModel, setCurrentModel, setShowPanel, statusItems, setStatusItems
//   session — sessionId, onListSessions, onCreateSession, onDeleteSession, onSwitchSession
//
// 일반 입력: pendingInput 은 서버 beginLifecycle 에서 set → WS push 로 TUI 에 반영되므로
// 로컬 addMessage 호출 없이 바로 onInput 만 호출.
// =============================================================================

const useSlashCommands = ({ core, context, ui, session }) => {
  const handleInput = useCallback(async (input) => {
    // 이전 정보 조회 결과(transient) 제거
    core.clearTransient()
    const { username, ...restContext } = context
    // agentId M1 하드코딩: `${username}/default`. 서버 session-api.js 의 기본 세션 규칙과 일치.
    // local Repl 모드 (ctx.memory 인스턴스 존재) 에서만 memory 호출에 쓰임. remote 모드는
    // memory=null → onInput 으로 서버 위임이므로 TUI 내부 agentId 사용 없음.
    const slashCtx = {
      ...core,
      ...restContext,
      ...ui,
      ...session,
      agentId: username ? `${username}/default` : null,
    }
    if (await dispatchSlashCommand(input, slashCtx)) return

    // 일반 입력 → 서버 executor.beginLifecycle 이 _pendingInput 을 set 하면 자동 렌더.
    // abort 피드백은 서버가 SYSTEM entry 로 기록하므로 로컬 transient 추가는 중복.
    // 실제 네트워크 오류 등만 transient 로 표시.
    if (context.onInput) {
      context.onInput(input).then(() => {}).catch(err => {
        const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted')
        if (isAbort) return
        core.addTransient({
          role: 'system',
          content: t('slash_cmd.error', { message: err.message }),
          tag: 'error',
        })
      })
    }
  }, [core, context, ui, session])

  return handleInput
}

export { useSlashCommands }
