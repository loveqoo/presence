import { getByPath } from '../lib/path.js'

// turnState는 반드시 마지막: idle 전이 시 hook이 발동되어 다음 턴이 시작될 수 있으므로,
// 그 시점에 conversationHistory, lastTurn 등이 이미 최신이어야 한다.
const MANAGED_PATHS = Object.freeze([
  '_streaming', 'lastTurn',
  'context.conversationHistory',
  '_debug.lastTurn', '_debug.lastPrompt', '_debug.lastResponse', '_debug.iterationHistory', '_retry',
  'turnState',
])

// epoch 기반 경합 방어: /clear 또는 compaction이 턴 실행 중 발생하면 conversationHistory 스킵
const applyFinalState = (reactiveState, finalState, { initialEpoch } = {}) => {
  if (!reactiveState) return
  const currentEpoch = reactiveState.get('_compactionEpoch') || 0
  const epochChanged = initialEpoch !== undefined && initialEpoch !== currentEpoch

  for (const path of MANAGED_PATHS) {
    if (epochChanged && path === 'context.conversationHistory') continue
    const value = getByPath(finalState, path)
    if (value !== undefined) reactiveState.set(path, value)
  }
}

const clearDebugState = (state) => {
  state.set('context.conversationHistory', [])
  state.set('context.memories', [])
  state.set('_compactionEpoch', (state.get('_compactionEpoch') || 0) + 1)
  state.set('_debug.lastTurn', null)
  state.set('_debug.lastPrompt', null)
  state.set('_debug.lastResponse', null)
  state.set('_debug.opTrace', [])
  state.set('_debug.recalledMemories', [])
  state.set('_debug.iterationHistory', [])
}

export { applyFinalState, clearDebugState, MANAGED_PATHS }
