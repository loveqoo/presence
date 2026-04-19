import { getByPath } from '../lib/path.js'
import { STATE_PATH } from './policies.js'

// TURN_STATE 는 MANAGED_PATHS 에 포함하지 않는다 — turnGateFSM 의 bridge 가
// 유일한 writer. executor 가 applyFinalState() 로 다른 path (lastTurn,
// conversationHistory 등) 를 먼저 커밋한 뒤 runtime.submit 을 호출하고,
// bridge 가 마지막에 state.set(TURN_STATE, ...) 을 해서 hook 순서 계약을 유지한다.
const MANAGED_PATHS = Object.freeze([
  STATE_PATH.STREAMING, STATE_PATH.LAST_TURN,
  STATE_PATH.CONTEXT_CONVERSATION_HISTORY,
  STATE_PATH.DEBUG_LAST_TURN, STATE_PATH.DEBUG_LAST_PROMPT, STATE_PATH.DEBUG_LAST_RESPONSE, STATE_PATH.DEBUG_ITERATION_HISTORY, '_retry',
  STATE_PATH.PENDING_INPUT,
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
