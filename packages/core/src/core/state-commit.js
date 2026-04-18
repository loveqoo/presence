import { getByPath } from '../lib/path.js'
import { STATE_PATH } from './policies.js'

// turnState는 반드시 마지막: idle 전이 시 hook이 발동되어 다음 턴이 시작될 수 있으므로,
// 그 시점에 conversationHistory, lastTurn 등이 이미 최신이어야 한다.
const MANAGED_PATHS = Object.freeze([
  STATE_PATH.STREAMING, STATE_PATH.LAST_TURN,
  STATE_PATH.CONTEXT_CONVERSATION_HISTORY,
  STATE_PATH.DEBUG_LAST_TURN, STATE_PATH.DEBUG_LAST_PROMPT, STATE_PATH.DEBUG_LAST_RESPONSE, STATE_PATH.DEBUG_ITERATION_HISTORY, '_retry',
  STATE_PATH.PENDING_INPUT,
  STATE_PATH.TURN_STATE,
])

// epoch 기반 경합 방어: /clear 또는 compaction이 턴 실행 중 발생하면 conversationHistory 스킵
const applyFinalState = (reactiveState, finalState, { initialEpoch } = {}) => {
  if (!reactiveState) return
  const currentEpoch = reactiveState.get(STATE_PATH.COMPACTION_EPOCH) || 0
  const epochChanged = initialEpoch !== undefined && initialEpoch !== currentEpoch

  for (const path of MANAGED_PATHS) {
    if (epochChanged && path === STATE_PATH.CONTEXT_CONVERSATION_HISTORY) continue
    const value = getByPath(finalState, path)
    if (value !== undefined) reactiveState.set(path, value)
  }
}

// INV-CLR-1: /clear 는 conversationHistory, pendingInput, toolTranscript,
// budgetWarning 을 모두 초기화해야 TUI 가 optimistic clear 이후에도 깔끔하게 수렴한다.
const clearDebugState = (state) => {
  state.set(STATE_PATH.CONTEXT_CONVERSATION_HISTORY, [])
  state.set(STATE_PATH.CONTEXT_MEMORIES, [])
  state.set(STATE_PATH.COMPACTION_EPOCH, (state.get(STATE_PATH.COMPACTION_EPOCH) || 0) + 1)
  state.set(STATE_PATH.PENDING_INPUT, null)
  state.set(STATE_PATH.TOOL_TRANSCRIPT, [])
  state.set(STATE_PATH.BUDGET_WARNING, null)
  state.set(STATE_PATH.DEBUG_LAST_TURN, null)
  state.set(STATE_PATH.DEBUG_LAST_PROMPT, null)
  state.set(STATE_PATH.DEBUG_LAST_RESPONSE, null)
  state.set(STATE_PATH.DEBUG_OP_TRACE, [])
  state.set(STATE_PATH.DEBUG_RECALLED_MEMORIES, [])
  state.set(STATE_PATH.DEBUG_ITERATION_HISTORY, [])
}

export { applyFinalState, clearDebugState, MANAGED_PATHS }
